// Baton — in-app updates: the decisions, with no Electron and no network in this file, so the test suite can drive
// them with a fake clock. electron/updater.ts wires this to electron-updater (GitHub Releases, Squirrel.Mac).
//
// Rules (also in ARCHITECTURE.md › Network):
//   * The ONLY network traffic Baton makes on its own. It goes to GitHub Releases for vamsijanaki/baton and nowhere
//     else; no telemetry, no identifiers beyond a normal HTTPS request.
//   * "Check for updates automatically" ON (default): a check when Baton starts, then at most once a day.
//     OFF: nothing is contacted unless the user presses Check now.
//   * Never in unsigned/dev builds, dry-run mode or a fake HOME (tests, screenshots).
//   * Install = restart. Never while a safety operation runs: the restart waits until Baton is idle, flushes state,
//     and only then hands over to Squirrel.Mac (which checks the new app's code signature against this one's).

export const DAY_MS = 24 * 60 * 60_000;
/** How often the daily timer wakes up to see whether a day has passed (the check itself is still once a day). */
export const TIMER_MS = 60 * 60_000;
/** While a restart waits for an operation to finish: how often it looks again. */
export const IDLE_POLL_MS = 2_000;
/** The Developer ID team every Baton release is signed by. */
export const TEAM_ID = 'D9S4VXPF9P';
export const BUNDLE_ID = 'com.vamsijanaki.baton';
export const UPDATE_FEED = { provider: 'github' as const, owner: 'vamsijanaki', repo: 'baton', releaseType: 'release' as const };

export type CheckTrigger = 'launch' | 'timer' | 'manual';

export interface Support {
  enabled: boolean;
  /** Why updates are off, in words for the Settings screen. */
  reason: string | null;
}

/** Whether this copy of Baton may check for and install updates at all. */
export function updateSupport(o: { packaged: boolean; signature: 'pending' | 'developer-id' | 'other'; envDryRun: boolean; fakeHome: boolean; appPath?: string }): Support {
  if (o.envDryRun) return { enabled: false, reason: 'Updates are off in dry-run mode.' };
  if (o.fakeHome) return { enabled: false, reason: 'Updates are off when Baton runs against a test home folder.' };
  if (!o.packaged || o.signature === 'other') return { enabled: false, reason: 'Updates are only available in signed releases.' };
  if (o.signature === 'pending') return { enabled: false, reason: 'Checking this copy’s signature…' };
  // Squirrel.Mac replaces the app in place: not possible on the disk image or from macOS's quarantine copy
  if (o.appPath && (/^\/Volumes\//.test(o.appPath) || o.appPath.includes('/AppTranslocation/')))
    return { enabled: false, reason: 'Move Baton to your Applications folder to get updates.' };
  return { enabled: true, reason: null };
}

/** What `codesign -dv --verbose=2 Baton.app` (stderr) says about the running app. */
export function signatureKind(codesignOutput: string, team = TEAM_ID): 'developer-id' | 'other' {
  const devId = /^Authority=Developer ID Application: .*\((\w+)\)$/m.exec(codesignOutput);
  const teamLine = /^TeamIdentifier=(\w+)$/m.exec(codesignOutput)?.[1];
  const ident = /^Identifier=(.+)$/m.exec(codesignOutput)?.[1];
  return devId && devId[1] === team && teamLine === team && ident === BUNDLE_ID ? 'developer-id' : 'other';
}

/** A fake HOME (tests, `npm run shots`): $HOME is not the account's real home folder from the user database. */
export function isFakeHome(envHome: string | undefined, realHome: string, fakeHomeEnv?: string) {
  if (fakeHomeEnv) return true;
  const norm = (p: string) => p.replace(/\/+$/, '');
  return !!envHome && norm(envHome) !== norm(realHome);
}

/** Whether a check should run now. Only Check now (manual) runs with automatic checks off. */
export function shouldCheck(trigger: CheckTrigger, o: { supported: boolean; autoCheck: boolean; lastCheckAt: number | null; now: number; busy: boolean }): boolean {
  if (!o.supported || o.busy) return false;
  if (trigger === 'manual') return true;
  if (!o.autoCheck) return false;
  if (trigger === 'launch') return true;
  // timer: once a day. A clock moved backwards counts as "a day has passed" rather than never checking again.
  return o.lastCheckAt == null || o.now - o.lastCheckAt >= DAY_MS || o.now < o.lastCheckAt;
}

/** Why an install has to wait, or null when Baton is idle. */
export function installBlocker(o: { opsInFlight: number; journalApplying: number }): string | null {
  if (o.opsInFlight > 0 || o.journalApplying > 0) return 'Waiting for a Baton operation to finish…';
  return null;
}

/** GitHub release notes arrive as HTML (from the releases feed). Turn them into plain text — never rendered as HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(p|li|h[1-6]|ul|ol|div|pre)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface NotesEntry {
  version: string | null;
  text: string;
}
/** electron-updater gives a string (one release) or, with fullChangelog, every release since the running one. */
export function releaseNotes(notes: string | { version: string; note: string | null }[] | null | undefined, version: string): NotesEntry[] {
  if (!notes) return [];
  if (typeof notes === 'string') return [{ version, text: htmlToText(notes) }].filter((n) => n.text);
  return notes.map((n) => ({ version: n.version, text: htmlToText(n.note ?? '') })).filter((n) => n.text);
}

export type Phase = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'waiting' | 'installing' | 'error';

export interface UpdateStatus {
  currentVersion: string;
  supported: boolean;
  reason: string | null;
  autoCheck: boolean;
  lastCheckAt: number | null;
  phase: Phase;
  available: { version: string; date: string | null; notes: NotesEntry[] } | null;
  progress: number | null;
  error: string | null;
  /** Set while "Restart to update" waits for an operation. */
  waitingFor: string | null;
}

export interface Found {
  version: string;
  date: string | null;
  notes: NotesEntry[];
}

export interface UpdateDeps {
  currentVersion: string;
  support: () => Support;
  autoCheck: () => boolean;
  setAutoCheck: (v: boolean) => void;
  lastCheckAt: () => number | null;
  setLastCheckAt: (t: number) => void;
  /** Ask the feed. null = no newer version. */
  check: () => Promise<Found | null>;
  /** Download (and verify) the update; progress 0–100. */
  download: (progress: (pct: number) => void) => Promise<void>;
  /** Why installing must wait (an operation is running), or null. */
  blocker: () => string | null;
  /** Stop new operations from starting and write state to disk. Called right before install. */
  prepareInstall: () => void;
  /** Quit and let Squirrel.Mac swap in the new app. */
  install: () => void;
  emit: (s: UpdateStatus) => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  log?: (line: string) => void;
}

const message = (e: unknown) => String((e as any)?.message ?? e).split('\n')[0].slice(0, 300);

/** The update state machine. One instance per app; all timers and I/O come in through deps. */
export class UpdateController {
  private phase: Phase = 'idle';
  private available: Found | null = null;
  private progress: number | null = null;
  private error: string | null = null;
  private waitingFor: string | null = null;
  private timer: unknown = null;
  private waitTimer: unknown = null;
  private inflight: Promise<unknown> | null = null;

  constructor(private d: UpdateDeps) {}

  status(): UpdateStatus {
    const s = this.d.support();
    return {
      currentVersion: this.d.currentVersion,
      supported: s.enabled,
      reason: s.reason,
      autoCheck: this.d.autoCheck(),
      lastCheckAt: this.d.lastCheckAt(),
      phase: this.phase,
      available: this.available,
      progress: this.progress,
      error: this.error,
      waitingFor: this.waitingFor,
    };
  }

  private emit() {
    this.d.emit(this.status());
  }

  /** On launch (once the signature is known): one check if automatic checks are on, then the daily timer. */
  start() {
    void this.maybeCheck('launch');
    this.schedule();
  }

  stop() {
    if (this.timer) this.d.clearTimer(this.timer);
    if (this.waitTimer) this.d.clearTimer(this.waitTimer);
    this.timer = this.waitTimer = null;
  }

  private schedule() {
    if (this.timer) this.d.clearTimer(this.timer);
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      void this.maybeCheck('timer');
      this.schedule();
    }, TIMER_MS);
  }

  setAutoCheck(v: boolean) {
    this.d.setAutoCheck(!!v);
    this.emit();
  }

  /** Busy = checking, downloading, or past the point of no return. A downloaded update is not re-checked. */
  private busy() {
    return !!this.inflight || ['downloading', 'downloaded', 'waiting', 'installing'].includes(this.phase);
  }

  async maybeCheck(trigger: CheckTrigger): Promise<boolean> {
    const ok = shouldCheck(trigger, { supported: this.d.support().enabled, autoCheck: this.d.autoCheck(), lastCheckAt: this.d.lastCheckAt(), now: this.d.now(), busy: this.busy() });
    if (!ok) return false;
    await this.runCheck(trigger);
    return true;
  }

  /** Check now (Settings button). Returns the status after the check. */
  async checkNow(): Promise<UpdateStatus> {
    await this.maybeCheck('manual');
    return this.status();
  }

  private async runCheck(trigger: CheckTrigger) {
    this.phase = 'checking';
    this.error = null;
    this.emit();
    const p = this.d.check();
    this.inflight = p;
    try {
      const found = await p;
      this.available = found;
      this.phase = found ? 'available' : 'up-to-date';
      this.d.log?.(`update check (${trigger}): ${found ? `${found.version} available` : 'up to date'}`);
    } catch (e) {
      this.phase = 'error';
      this.error = message(e);
      this.d.log?.(`update check (${trigger}) failed: ${this.error}`);
    } finally {
      this.inflight = null;
      // a failed check also counts: no retry storm against GitHub; the next try is tomorrow or Check now
      this.d.setLastCheckAt(this.d.now());
      this.emit();
    }
  }

  async download(): Promise<UpdateStatus> {
    if (!this.d.support().enabled || !this.available || this.phase !== 'available') return this.status();
    this.phase = 'downloading';
    this.progress = 0;
    this.error = null;
    this.emit();
    try {
      await this.d.download((pct) => {
        this.progress = Math.max(0, Math.min(100, Math.round(pct)));
        this.emit();
      });
      this.phase = 'downloaded';
      this.progress = 100;
      this.d.log?.(`update ${this.available.version} downloaded and verified`);
    } catch (e) {
      this.phase = 'available';
      this.progress = null;
      this.error = message(e);
      this.d.log?.(`update download failed: ${this.error}`);
    }
    this.emit();
    return this.status();
  }

  /** "Restart to update". Waits while an operation runs; then flushes state and installs. */
  restart(): UpdateStatus {
    if (this.phase !== 'downloaded' && this.phase !== 'waiting') return this.status();
    if (this.waitTimer) return this.status(); // already waiting
    this.tryInstall();
    return this.status();
  }

  private tryInstall() {
    const why = this.d.blocker();
    if (why) {
      if (this.phase !== 'waiting') this.d.log?.(`update restart deferred: ${why}`);
      this.phase = 'waiting';
      this.waitingFor = why;
      this.emit();
      this.waitTimer = this.d.setTimer(() => {
        this.waitTimer = null;
        this.tryInstall();
      }, IDLE_POLL_MS);
      return;
    }
    // same tick as the idle check: nothing can start in between
    this.waitingFor = null;
    this.phase = 'installing';
    this.d.prepareInstall();
    this.emit();
    this.d.log?.(`update: restarting to install ${this.available?.version ?? ''}`);
    try {
      this.d.install();
    } catch (e) {
      this.phase = 'error';
      this.error = message(e);
      this.emit();
    }
  }

  /** Squirrel refused the update at install time (e.g. a signature that does not match). Baton keeps running. */
  installFailed(e: unknown) {
    this.phase = 'error';
    this.error = message(e);
    this.emit();
  }

  /** The tiny view for the sidebar footer and the tray: no nagging, just whether there is something to get. */
  badge(): { version: string; ready: boolean } | null {
    if (!this.available || !['available', 'downloading', 'downloaded', 'waiting'].includes(this.phase)) return null;
    return { version: this.available.version, ready: this.phase === 'downloaded' || this.phase === 'waiting' };
  }
}
