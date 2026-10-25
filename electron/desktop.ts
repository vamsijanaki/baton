// Baton — Claude DESKTOP profiles sharing one Code-tab session list.
//
// Facts (Claude desktop 3.x, checked 25 Oct 2026):
//  * Every profile (`--user-data-dir=~/Library/Application Support/Claude-<Name>`) runs its embedded
//    claude-code WITHOUT CLAUDE_CONFIG_DIR, so all transcripts already live in the shared ~/.claude/projects.
//  * The Code-tab sidebar comes from a desktop-side index, one JSON per session:
//    <profile>/claude-code-sessions/<accountUuid>/<orgUuid>/local_<id>.json
//    (cliSessionId, title, cwd, spawnedFrom …) — per profile AND per account.
//  * The app saves those files by atomic rename, so per-FILE symlinks would be replaced on the
//    first write. A symlink on the <accountUuid>/<orgUuid> FOLDER survives (renames happen inside it).
//
// Linking = back up the folder (moved, never deleted) → merge copies into the shared store →
// replace the folder with a symlink to the shared store. Unlinking restores the backup exactly.
// Both refuse while that profile's app is running.
//
// Profile management (create / launch / update / remove):
//  * a profile IS a folder ~/Library/Application Support/Claude-<Name>; its color lives in
//    <folder>/.baton-color (absent → the default color). Any existing Claude-<Name> folder that looks like a
//    desktop data folder (Preferences / Local State) is listed too and can be adopted: Baton builds its own app copy;
//  * it launches from its own APFS copy-on-write clone of /Applications/Claude.app
//    (`cp -Rc`, byte-identical: same bundle id, same name inside, Anthropic's signature untouched),
//    started with `open <clone> --args --user-data-dir=<folder>`;
//  * the color is a hue-rotated FINDER custom icon on the clone (metadata outside the code seal, so
//    `codesign --verify` still passes and Keychain keeps trusting the app);
//  * when Claude.app's CFBundleShortVersionString changes, the clone is rebuilt from scratch.
// Clones live outside Spotlight's index so nothing launches one without its --user-data-dir.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APPS_PARENT, COLOR_FILE, LEGACY_APPS_PARENT, desktopRegistry, legacyStore, readOnly, resolveAppsDir, setRoots } from './roots';
import type { Operation, Step } from './safety';

/** Parents (in Application Support) of Baton's own app-copy folders: the current one and the older name. */
const OWN_APPS_PARENTS = [APPS_PARENT, LEGACY_APPS_PARENT];

const run = promisify(execFile);
let HOME = os.homedir();
export let SUPPORT = path.join(HOME, 'Library', 'Application Support');
export let CLONES = resolveAppsDir(SUPPORT);
export let CLAUDE_APP = '/Applications/Claude.app';
let HELPER = '';
/** Path of the bundled AppKit helper (tint / seticon / focus / quit). */
export function setHelperPath(p: string) {
  HELPER = p;
}
/** Tests only: point everything at a sandbox. */
export function setRootsForTest(root: string, claudeApp?: string, home?: string) {
  if (home) HOME = home;
  setRoots(home ?? root, claudeApp);
  SUPPORT = home ? path.join(home, 'Library', 'Application Support') : path.join(root, 'support');
  CLONES = resolveAppsDir(SUPPORT);
  if (claudeApp) CLAUDE_APP = claudeApp;
}
export interface IndexFolder {
  rel: string; // "<accountUuid>/<orgUuid>"
  accountUuid: string;
  email: string | null;
  linked: boolean; // symlink → shared store
  sessions: number;
}
export interface DesktopProfile {
  id: string; // folder name: "Claude" or "Claude-<Name>"
  name: string; // "Claude (default)" / "<Name>"
  dataDir: string;
  appPath: string | null; // the Claude.app (clone) this profile launches from
  cloneSource: 'claude-switch' | 'system' | null;
  cloneVersion: string | null;
  needsUpdate: boolean; // clone version differs from /Applications/Claude.app
  color: string; // color name (orange, red, … pink)
  origin: 'default' | 'claude-switch' | 'other';
  autoLink: boolean; // link the Code list automatically after first sign-in + Code tab
  running: boolean;
  pid: number | null;
  signedIn: boolean; // the app holds a sign-in (config.json lastKnownAccountUuid / oauth token cache)
  codeReady: boolean; // has at least one Code-tab session index folder
  folders: IndexFolder[];
  linked: 'all' | 'some' | 'none';
  /** The account this app is signed in as now (config.json lastKnownAccountUuid; else its only index account). */
  accountUuid: string | null;
  email: string | null;
  /** Made by "Create desktop app for <account>" — pairs with that account before its first sign-in. */
  forAccount: string | null;
  /** Its app copy was removed by "Merge & tidy up"; the data folder was kept (listed under Advanced only). */
  retired: { into: string; at: string } | null;
}

const isProfileDir = (n: string) => n === 'Claude' || (n.startsWith('Claude-') && n !== 'Claude-Switch');

// ---------- colors, names, registry ----------

/** Icon palette: hue rotation (degrees) applied to Claude's icon. The white spark has no hue and stays white. */
export const HUES: Record<string, number> = { orange: 0, red: -20, yellow: 45, green: 100, teal: 150, blue: 195, purple: 245, pink: 300 };

/** "cs demo" → "Cs Demo": letters and digits only, words capitalised (the app and folder name). */
export function displayName(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function colorOf(dataDir: string): string {
  try {
    const c = fs.readFileSync(path.join(dataDir, COLOR_FILE), 'utf8').split('\n')[0].trim();
    return c in HUES ? c : 'orange';
  } catch {
    return 'orange';
  }
}

interface RegEntry {
  origin: 'claude-switch' | 'other';
  autoLink: boolean;
  addedAt: string;
  autoLinkedAt?: string;
  forAccount?: string;
  retired?: { into: string; at: string };
}
/** The desktop-app registry. Origins Baton does not know (e.g. from older versions) read as 'other'; the file is not rewritten for that. */
export function readRegistry(): Record<string, RegEntry> {
  let raw: Record<string, RegEntry>;
  try {
    raw = JSON.parse(fs.readFileSync(desktopRegistry(), 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  for (const e of Object.values(raw)) if (e && typeof e === 'object' && e.origin !== 'claude-switch') e.origin = 'other';
  return raw;
}
export type { RegEntry };
function writeRegistry(r: Record<string, RegEntry>) {
  fs.mkdirSync(path.dirname(desktopRegistry()), { recursive: true });
  fs.writeFileSync(desktopRegistry() + '.tmp', JSON.stringify(r, null, 2));
  fs.renameSync(desktopRegistry() + '.tmp', desktopRegistry());
}

export function appVersion(app: string): string | null {
  try {
    const m = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
export const claudeVersion = () => appVersion(CLAUDE_APP);

const cloneFor = (name: string) => path.join(CLONES, `Claude ${name}.app`);

/**
 * Does this profile's app hold a sign-in, and as which account? config.json keeps the last account id plus an
 * encrypted token cache; only the PRESENCE of the cache is checked and only lastKnownAccountUuid is kept —
 * token values are never read into anything.
 */
function signInOf(dataDir: string): { signedIn: boolean; accountUuid: string | null } {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const uuid = typeof c.lastKnownAccountUuid === 'string' && c.lastKnownAccountUuid ? c.lastKnownAccountUuid : null;
    return { signedIn: !!(uuid || c['oauth:tokenCacheV2'] || c['oauth:tokenCache']), accountUuid: uuid };
  } catch {
    return { signedIn: false, accountUuid: null };
  }
}

// ---------- running instances ----------

export interface RunningDesktop {
  pid: number;
  dataDir: string; // resolved user-data dir (default = Application Support/Claude)
  appPath: string;
}

/** Main Claude desktop processes (any bundle — original or clone) with their user-data dir. */
export async function runningDesktops(): Promise<RunningDesktop[]> {
  const out: RunningDesktop[] = [];
  try {
    const { stdout } = await run('ps', ['-axww', '-o', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const m0 = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m0) continue;
      const cmd = m0[2];
      const bin = cmd.match(/^(.*?\.app)\/Contents\/MacOS\/Claude( |$)/);
      if (!bin || /Helper|crashpad/.test(cmd)) continue;
      const m = cmd.match(/--user-data-dir=(.+?)(?= --|$)/);
      out.push({ pid: Number(m0[1]), dataDir: m ? path.resolve(m[1].trim()) : path.join(SUPPORT, 'Claude'), appPath: bin[1] });
    }
  } catch {
    /* ignore */
  }
  return out;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase(); // APFS is case-insensitive

export async function listDesktopProfiles(emailByAccountUuid: Record<string, string>): Promise<DesktopProfile[]> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(SUPPORT).filter(isProfileDir);
  } catch {
    return [];
  }
  const running = await runningDesktops();
  const reg = readRegistry();
  let regChanged = false;
  const current = claudeVersion();
  const profiles: DesktopProfile[] = [];
  for (const id of names.sort((a, b) => (a === 'Claude' ? -1 : b === 'Claude' ? 1 : a.localeCompare(b)))) {
    const dataDir = path.join(SUPPORT, id);
    try {
      if (!fs.statSync(dataDir).isDirectory()) continue;
    } catch {
      continue;
    }
    // a desktop profile has Preferences / Local State (Chromium data), or was made by Baton
    const ours = id !== 'Claude' && !!reg[id];
    if (!ours && !['Preferences', 'Local State', COLOR_FILE].some((f) => fs.existsSync(path.join(dataDir, f)))) continue;
    const isDefault = id === 'Claude';
    const display = isDefault ? 'Claude (default)' : id.replace(/^Claude-/, '');
    const sign = signInOf(dataDir);
    const signedIn = sign.signedIn;
    if (!isDefault && !reg[id]) {
      // an existing data folder found on this Mac: listed as-is (sign-in + chats stay in it); Adopt / Open builds
      // Baton's own app copy for it. Already-signed-in ones are not auto-linked (their first sign-in came first).
      reg[id] = { origin: 'other', autoLink: false, addedAt: new Date().toISOString() };
      regChanged = true;
    }
    let appPath: string | null = null;
    let cloneSource: DesktopProfile['cloneSource'] = null;
    if (isDefault) {
      if (fs.existsSync(CLAUDE_APP)) (appPath = CLAUDE_APP), (cloneSource = 'system');
    } else if (fs.existsSync(cloneFor(display))) (appPath = cloneFor(display)), (cloneSource = 'claude-switch');
    const cloneVersion = appPath ? appVersion(appPath) : null;
    const folders: IndexFolder[] = [];
    const root = path.join(dataDir, 'claude-code-sessions');
    for (const acct of safeList(root)) {
      for (const org of safeList(path.join(root, acct))) {
        const full = path.join(root, acct, org);
        let linked = false;
        try {
          linked = fs.lstatSync(full).isSymbolicLink() && path.resolve(path.dirname(full), fs.readlinkSync(full)) === legacyStore();
        } catch {
          continue;
        }
        const sessions = safeList(full).filter((f) => f.startsWith('local_') && f.endsWith('.json')).length;
        folders.push({ rel: `${acct}/${org}`, accountUuid: acct, email: emailByAccountUuid[acct] ?? null, linked, sessions });
      }
    }
    const n = folders.filter((f) => f.linked).length;
    const proc = running.find((r) => same(r.dataDir, dataDir));
    const folderAccts = [...new Set(folders.map((f) => f.accountUuid))];
    const accountUuid = sign.accountUuid ?? (folderAccts.length === 1 ? folderAccts[0] : null);
    profiles.push({
      id,
      name: display,
      dataDir,
      appPath: proc && !isDefault ? proc.appPath : appPath,
      cloneSource,
      cloneVersion,
      needsUpdate: !isDefault && !!appPath && !!current && cloneVersion !== current,
      color: isDefault ? 'orange' : colorOf(dataDir),
      origin: isDefault ? 'default' : reg[id].origin,
      autoLink: !isDefault && reg[id].autoLink,
      running: !!proc,
      pid: proc?.pid ?? null,
      signedIn: signedIn || folders.length > 0,
      codeReady: folders.length > 0,
      folders,
      linked: folders.length && n === folders.length ? 'all' : n ? 'some' : 'none',
      accountUuid,
      email: accountUuid ? emailByAccountUuid[accountUuid] ?? null : null,
      forAccount: isDefault ? null : reg[id]?.forAccount ?? null,
      retired: isDefault ? null : reg[id]?.retired ?? null,
    });
  }
  if (regChanged && !readOnly()) writeRegistry(reg);
  return profiles;
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

// ---------- clones ----------

async function helper(...args: string[]) {
  if (!HELPER || !fs.existsSync(HELPER)) throw new Error('desktop helper missing');
  return run(HELPER, args);
}

/** Sets the clone's Finder icon to the profile color (hue-rotated Claude icon). Best effort. */
export async function applyCloneIcon(clone: string, color: string) {
  const icns = safeList(path.join(CLAUDE_APP, 'Contents', 'Resources')).find((f) => f.endsWith('.icns'));
  if (!icns) return false;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-icon-'));
  try {
    const out = path.join(tmp, 'icon.icns');
    const hue = HUES[color] ?? 0;
    if (hue) await helper('tint', path.join(CLAUDE_APP, 'Contents', 'Resources', icns), out, String(hue));
    else fs.copyFileSync(path.join(CLAUDE_APP, 'Contents', 'Resources', icns), out);
    await helper('seticon', out, clone);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Builds a clone at `clone` from Claude.app: built next to it and swapped in. Never touches data. */
export async function buildClone(clone: string, color: string) {
  if (!fs.existsSync(CLAUDE_APP)) throw new Error(`${CLAUDE_APP} not found.`);
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  const tmp = `${clone}.building-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    await run('/bin/cp', ['-Rc', CLAUDE_APP, tmp]); // APFS copy-on-write
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    await run('/bin/cp', ['-R', CLAUDE_APP, tmp]);
  }
  fs.rmSync(clone, { recursive: true, force: true });
  fs.renameSync(tmp, clone);
  await applyCloneIcon(clone, color);
}

/** Launch-time refresh: rebuild the app copy when missing or older than Claude.app. App copies are not user data. */
export async function ensureClone(name: string, color: string): Promise<string> {
  const clone = cloneFor(name);
  if (!fs.existsSync(clone) || appVersion(clone) !== claudeVersion()) await buildClone(clone, color);
  return clone;
}

// ---------- planned operations (run through the safety engine) ----------

/** A free app name for an account: "CLIENT" → "Client", then "Client 2", "Client 3" … when that data folder exists. */
export function freeAppName(raw: string): string {
  const base = displayName(raw) || 'Account';
  for (let i = 1; ; i++) {
    const n = i === 1 ? base : `${base} ${i}`;
    if (!fs.existsSync(path.join(SUPPORT, `Claude-${n}`)) && !fs.existsSync(cloneFor(n))) return n;
  }
}

export function planCreateProfile(raw: string, color: string, forAccount?: { id: string; name: string }): { op: Operation; id: string; name: string } {
  const name = displayName(raw);
  if (!name) throw new Error('The name needs at least one letter or digit.');
  if (!(color in HUES)) throw new Error(`Unknown color ${color}`);
  const id = `Claude-${name}`;
  const dataDir = path.join(SUPPORT, id);
  if (fs.existsSync(dataDir)) throw new Error(`${dataDir} already exists — that desktop app is listed already.`);
  const reg = readRegistry();
  reg[id] = { origin: 'claude-switch', autoLink: false, addedAt: new Date().toISOString(), ...(forAccount ? { forAccount: forAccount.id } : {}) };
  return {
    id,
    name,
    op: {
      kind: 'profile-create',
      title: forAccount ? `Desktop app for ${forAccount.name}` : `New desktop app ${name}`,
      steps: [
        { t: 'mkdir', path: dataDir },
        { t: 'write', path: path.join(dataDir, COLOR_FILE), data: color + '\n' },
        { t: 'clone', path: cloneFor(name), name, color },
        { t: 'write', path: desktopRegistry(), data: JSON.stringify(reg, null, 2) },
      ],
      touches: [dataDir, desktopRegistry()],
      notes: [
        forAccount
          ? `A copy of the Claude desktop app just for ${forAccount.name}. Open it once and sign in as ${forAccount.name} — it stays signed in after that. Baton never copies sign-ins.`
          : 'Shares nothing yet. Open it once to sign in; it stays signed in after that.',
      ],
    },
  };
}

export function planColor(p: DesktopProfile, color: string): Operation {
  if (p.id === 'Claude') throw new Error('The default Claude app keeps its own icon.');
  if (!(color in HUES)) throw new Error(`Unknown color ${color}`);
  const f = path.join(p.dataDir, COLOR_FILE);
  return { kind: 'profile-color', title: `Color of ${p.name} → ${color}`, steps: [{ t: 'write', path: f, data: color + '\n' }], touches: [f] };
}

export function planUpdateProfiles(profiles: DesktopProfile[]): { op: Operation; skipped: string[] } {
  const steps: Step[] = [];
  const skipped: string[] = [];
  for (const p of profiles) {
    if (!p.needsUpdate) continue;
    if (p.running) skipped.push(p.name);
    else steps.push({ t: 'clone', path: cloneFor(p.name), name: p.name, color: p.color });
  }
  return {
    skipped,
    op: {
      kind: 'profile-update',
      title: `Update desktop apps to Claude ${claudeVersion()}`,
      steps,
      touches: [],
      notes: ['Each app copy is rebuilt from /Applications/Claude.app. Data folders (sign-in, chats) are not touched.', ...(skipped.length ? [`Skipped while running: ${skipped.join(', ')}`] : [])],
    },
  };
}

/**
 * Adopt a desktop data folder found on this Mac (one Baton did not create): build Baton's own app copy for it.
 * The data folder (sign-in, chats) is not touched; its stored color is used when it has one.
 */
export function planAdopt(p: DesktopProfile): Operation {
  if (p.id === 'Claude') throw new Error('The default Claude app needs no adopting.');
  if (path.dirname(p.dataDir) !== SUPPORT || !p.id.startsWith('Claude-')) throw new Error(`Unexpected data folder ${p.dataDir}`);
  if (p.cloneSource) throw new Error(`${p.name} already has its app copy.`);
  return {
    kind: 'profile-adopt',
    title: `Adopt ${p.name}`,
    steps: [{ t: 'clone', path: cloneFor(p.name), name: p.name, color: p.color }],
    touches: [],
    notes: [`Builds Baton's own copy of Claude.app for ${p.name}. ${p.dataDir} (sign-in, settings, chats) is not touched.`],
  };
}

/** Steps that remove only an app's launcher side: its Claude.app copies in Baton's own apps folders (rebuildable). */
export function appCopySteps(p: DesktopProfile): { steps: Step[]; touches: string[] } {
  if (p.id === 'Claude') throw new Error('The default Claude app is not removable here.');
  if (path.dirname(p.dataDir) !== SUPPORT || !p.id.startsWith('Claude-')) throw new Error(`Unexpected data folder ${p.dataDir}`);
  const steps: Step[] = [];
  const touches: string[] = [];
  const dirs = [...new Set([CLONES, ...OWN_APPS_PARENTS.map((d) => path.join(SUPPORT, d, 'apps'))])];
  for (const c of dirs.map((d) => path.join(d, `Claude ${p.name}.app`))) if (fs.existsSync(c)) steps.push({ t: 'rmAppCopy', path: c });
  return { steps, touches };
}

/** "launcher": app copies only (data kept). "everything": also the data folder → Trash. */
export function planRemoveProfile(p: DesktopProfile, mode: 'launcher' | 'everything'): Operation {
  const { steps, touches } = appCopySteps(p);
  if (mode === 'everything') {
    steps.push({ t: 'trash', path: p.dataDir });
    const reg = readRegistry();
    delete reg[p.id];
    steps.push({ t: 'write', path: desktopRegistry(), data: JSON.stringify(reg, null, 2) });
    touches.push(desktopRegistry());
  }
  return {
    kind: mode === 'everything' ? 'profile-delete' : 'profile-remove-launcher',
    title: mode === 'everything' ? `Delete desktop app ${p.name}` : `Remove ${p.name}'s app (keep data)`,
    steps,
    touches,
    notes:
      mode === 'everything'
        ? [`${p.dataDir} goes to the macOS Trash (Finder › Put Back restores it). Transcripts in ~/.claude/projects are not touched.`]
        : [`${p.dataDir} is kept — sign-in, settings, sessions. Open recreates the app.`],
  };
}

// ---------- launch ----------

/** Opens the profile, or brings it forward if it is already running (no second window). */
export async function openProfile(p: DesktopProfile) {
  if (p.id === 'Claude') return run('open', ['-a', p.appPath ?? 'Claude']);
  const live = (await runningDesktops()).find((r) => same(r.dataDir, p.dataDir));
  if (live) {
    try {
      await helper('focus', String(live.pid));
    } catch {
      await run('open', ['-a', live.appPath]);
    }
    return;
  }
  const clone = await ensureClone(p.name, p.color);
  await run('open', [clone, '--args', `--user-data-dir=${p.dataDir}`]);
}

/** Asks each running Claude app to quit (like ⌘Q) and waits for them to be gone. */
export async function quitDesktops(pids: number[], timeoutMs = 20_000): Promise<number[]> {
  for (const pid of pids) await helper('quit', String(pid)).catch(() => undefined);
  const until = Date.now() + timeoutMs;
  for (;;) {
    const alive = (await runningDesktops()).filter((r) => pids.includes(r.pid)).map((r) => r.pid);
    if (!alive.length || Date.now() > until) return alive;
    await new Promise((r) => setTimeout(r, 500));
  }
}
