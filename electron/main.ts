import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, systemPreferences, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  Account,
  appleScriptFor,
  buildShellCommand,
  writeLaunchScript,
  ClaudeProc,
  COLORS,
  DEFAULT_PROJECT,
  knownProjects,
  LAUNCH_LOG,
  listClaudeProcesses,
  listSessions,
  loadState,
  Lock,
  logLaunch,
  pidAlive,
  readLock,
  revealTerminalTab,
  runAppleScript,
  sameProject,
  saveState,
  slugify,
  State,
  viewAccount,
  writeLock,
  SHARED_PROJECTS,
  scrubOwnEnv,
} from './core';
import { CLONES, claudeVersion, HUES, setHelperPath, listDesktopProfiles, openProfile, quitDesktops, runningDesktops, type DesktopProfile } from './desktop';
import { registerOps } from './ops-ipc';
import type { TerminalIdentity } from './apps';
import { readSharing, terminalState } from './sharing';
import { readSettings } from './safety';
import { resolveUserData } from './roots';
import { cachedAuth, checkAuth, describeInstall, hookStatus, installHook, probeUsage, probing, readUsage, uninstallHook, USAGE_DIR, type ProbeResult } from './usage';
import { applyAttest, applySuspension, detectKind, fairUseProblem, launchGate, LINKS, needsLimitsAck, reconcileKind, recordProjectUse, type AttestInput, type UsageTrigger } from './fairuse';
import { isTrayRoute, menuLabel, popoverPosition, POPOVER_MAX_HEIGHT, POPOVER_MIN_HEIGHT, POPOVER_WIDTH, routeLaunchResult, type LaunchResult } from './tray-logic';

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const ENV_DRY_RUN = process.env.BATON_DRY_RUN === '1' || process.env.CLAUDE_SWITCH_DRY_RUN === '1';
// Don't depend on how we were started: drop any inherited Claude/Anthropic session variables.
const SCRUBBED_AT_START = scrubOwnEnv();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let state: State = loadState();
let running: ClaudeProc[] = [];
let quitting = false;

const res = (...p: string[]) => (app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, '..', 'build', ...p));
const dryRun = () => ENV_DRY_RUN || state.dryRun;
setHelperPath(res('baton-desktop-helper'));

function persist() {
  saveState(state);
  broadcast();
}

function emails() {
  return Object.fromEntries(state.accounts.map((a) => [a.id, viewAccount(a).email]));
}

async function refreshRunning() {
  try {
    running = await listClaudeProcesses(state.accounts, emails());
  } catch {
    running = [];
  }
  return running;
}

function currentLock(): Lock | null {
  const l = readLock();
  if (!l) return null;
  if (l.pid && !pidAlive(l.pid)) {
    writeLock(null);
    return null;
  }
  if (!l.pid && Date.now() - Date.parse(l.since) > 2 * 60_000) {
    // launched (or dry-run) but no process ever showed up
    if (!dryRun()) writeLock(null);
    return dryRun() ? l : null;
  }
  return l;
}

// ---------- usage limits ----------
//
// Informational only ("know where you stand"). Baton never suggests another account when one is near or at
// its limit, never rotates accounts, never notifies about limits. Checks run ONLY when Baton opens and when
// you press Refresh, at most once per 15 minutes per account (usageGate in usage.ts) — no polling loop.

const activeAccountId = () => currentLock()?.account ?? state.selectedAccount;

function usageView() {
  const now = Date.now();
  return Object.fromEntries(
    state.accounts.map((a) => {
      // a signed-out account has no limits of its own; never show data cached under another identity
      const u = viewAccount(a).signedIn ? readUsage(a, now) : null;
      return [a.id, { ...(u ?? {}), has: !!u, probing: probing(a), hook: hookStatus(a).installed, auth: cachedAuth(a) }];
    }),
  );
}

/** Kind detection (non-secret fields only) for every account; Suspended from auth checks. Saves when anything changed. */
function syncFairUse() {
  let changed = false;
  for (const a of state.accounts) {
    const auth = cachedAuth(a);
    if (reconcileKind(a, detectKind(a, auth?.subscription))) changed = true;
    if (auth?.suspended && applySuspension(a, { suspended: auth.suspended })) changed = true;
  }
  if (changed) saveState(state);
  return changed;
}

function fairUseView() {
  return Object.fromEntries(
    state.accounts.map((a) => [
      a.id,
      {
        kind: a.kind ?? null,
        kindSource: a.kindSource ?? null,
        kindHint: a.kindHint ?? null,
        attestedAt: a.attestedAt ?? null,
        limitsAckAt: a.limitsAckAt ?? null,
        needsLimitsAck: needsLimitsAck(state.accounts, a),
        personalBefore: needsLimitsAck(state.accounts, a, 'personal'),
        problem: fairUseProblem(state.accounts, a),
        suspended: a.suspended ?? null,
      },
    ]),
  );
}

async function refreshUsage(id: string, trigger: UsageTrigger): Promise<ProbeResult> {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) throw new Error('Unknown account');
  if (!viewAccount(acc).signedIn) throw new Error(`${acc.name} is not signed in yet`);
  const joined = probing(acc); // a check already running for this account: share it, don't log twice
  const p = probeUsage(acc, trigger);
  broadcast(); // show the spinner
  const r = await p;
  if (r.throttled) return r; // nothing spawned
  if (!joined) {
    logLaunch(`usage ${acc.name} (${trigger}): claude -p /usage → ${r.error ? 'error: ' + r.error : `5h ${r.fiveHour?.pct ?? '–'}% · week ${r.sevenDay?.pct ?? '–'}%`}`);
    await checkAuth(acc).then((a) => logLaunch(`auth check ${acc.name}: claude auth status (clean env) → ${a.email ?? a.error ?? 'not signed in'}`));
  }
  const auth = cachedAuth(acc);
  if (applySuspension(acc, { suspended: r.suspended ?? auth?.suspended ?? null, ok: !!(r.fiveHour || r.sevenDay) })) {
    logLaunch(`${acc.name}: ${acc.suspended ? `marked Suspended — ${acc.suspended.reason}` : 'Suspended cleared (limits read normally)'}`);
    saveState(state);
  }
  syncFairUse();
  broadcast();
  return r;
}

/** On app open: one gated check per signed-in account. Never repeated by a timer. */
async function checkUsageOnOpen() {
  if (dryRun()) return;
  for (const a of state.accounts) if (viewAccount(a).signedIn) await refreshUsage(a.id, 'app-open').catch(() => undefined);
}

function snapshot() {
  return {
    state,
    accounts: state.accounts.map(viewAccount),
    lock: currentLock(),
    running,
    dryRun: dryRun(),
    envDryRun: ENV_DRY_RUN,
    paths: { shared: SHARED_PROJECTS, launchLog: LAUNCH_LOG },
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    usage: usageView(),
    fairUse: fairUseView(),
    links: LINKS,
    activeAccountId: activeAccountId(),
    // how the CURRENT project's history is shared with each terminal account
    projectSharing: Object.fromEntries(state.accounts.filter((a) => a.id !== 'default').map((a) => [a.id, terminalState(a, state.project || DEFAULT_PROJECT)])),
    sharedProjects: readSharing().projects.map((p) => p.path),
    onboarded: readSettings().onboarded,
    home: process.env.HOME || '',
  };
}

function broadcast() {
  const snap = snapshot();
  win?.webContents.send('changed', snap);
  if (popover?.isVisible()) popover.webContents.send('changed', snap);
  rebuildTray();
}

// ---------- launching ----------

function conflictsFor(accountId: string, project: string) {
  return running.filter((p) => sameProject(p.cwd, project) && p.accountId !== accountId);
}

async function launch(opts: { accountId: string; project: string; resume?: string | null; continueLast?: boolean; force?: boolean }) {
  const acc = state.accounts.find((a) => a.id === opts.accountId);
  if (!acc) throw new Error('Unknown account');
  if (!fs.existsSync(opts.project)) throw new Error(`Folder not found: ${opts.project}`);
  syncFairUse();
  const gate = launchGate(state.accounts, acc, opts.project, state.projectUse, readSharing().projects);
  if (gate?.status === 'suspended') logLaunch(`refused: ${acc.name} on ${opts.project} — ${gate.message}`);
  if (gate) return gate;
  await refreshRunning();
  const conflicts = conflictsFor(acc.id, opts.project);
  if (conflicts.length && !opts.force) return { status: 'conflict' as const, conflicts };
  const lo = { resume: opts.resume, continueLast: opts.continueLast };
  const cmd = buildShellCommand(acc, opts.project, lo);
  logLaunch(`${dryRun() ? '[dry-run] ' : ''}${acc.name}: ${cmd}`);
  rememberProject(opts.project);
  state.projectUse = recordProjectUse(state.projectUse ?? {}, opts.project, acc.id);
  saveState(state);
  const lock: Lock = { account: acc.id, project: opts.project, pid: null, since: new Date().toISOString(), sessionId: opts.resume ?? null };
  if (!dryRun()) {
    await runAppleScript(appleScriptFor(writeLaunchScript(acc, opts.project, lo).command));
    writeLock(lock);
    watchForPid(lock);
  }
  broadcast();
  return { status: 'launched' as const, command: cmd, dryRun: dryRun() };
}

function watchForPid(lock: Lock) {
  let tries = 0;
  const t = setInterval(async () => {
    tries++;
    await refreshRunning();
    const p = running.find((r) => r.accountId === lock.account && r.source === 'terminal' && sameProject(r.cwd, lock.project));
    if (p) {
      writeLock({ ...lock, pid: p.pid });
      clearInterval(t);
      broadcast();
    } else if (tries > 30) clearInterval(t);
  }, 1000);
}

async function openLogin(acc: Account) {
  const home = process.env.HOME || '/';
  const cmd = buildShellCommand(acc, home, { login: true });
  logLaunch(`${dryRun() ? '[dry-run] ' : ''}${acc.name} login: ${cmd}`);
  if (!dryRun()) await runAppleScript(appleScriptFor(writeLaunchScript(acc, home, { login: true }).command));
  return cmd;
}

function rememberProject(p: string) {
  state.project = p;
  state.recentProjects = [p, ...state.recentProjects.filter((x) => x !== p)].slice(0, 8);
  saveState(state);
}

// ---------- IPC ----------

ipcMain.handle('snapshot', async () => {
  await refreshRunning();
  return snapshot();
});

ipcMain.handle('sessions', (_e, project: string) => listSessions(project));
ipcMain.handle('knownProjects', () => knownProjects());

ipcMain.handle('signIn', async (_e, id: string) => {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) throw new Error('Unknown account');
  return openLogin(acc);
});

ipcMain.handle('updateAccount', (_e, id: string, patch: Partial<Pick<Account, 'name' | 'color'>>) => {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) throw new Error('Unknown account');
  const allowed: (keyof typeof patch)[] = ['name', 'color']; // limitNote/limitResetAt: obsolete manual notes — stored values are ignored
  for (const k of allowed) if (k in patch) (acc as any)[k] = (patch as any)[k];
  persist();
});

ipcMain.handle('select', (_e, patch: { account?: string; project?: string }) => {
  if (patch.account) state.selectedAccount = patch.account;
  if (patch.project) rememberProject(patch.project);
  persist();
});

ipcMain.handle('forgetProject', (_e, p: string) => {
  state.recentProjects = state.recentProjects.filter((x) => x !== p);
  persist();
});

ipcMain.handle('chooseProject', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], defaultPath: state.project || DEFAULT_PROJECT });
  if (r.canceled || !r.filePaths[0]) return null;
  rememberProject(r.filePaths[0]);
  broadcast();
  return r.filePaths[0];
});

ipcMain.handle('preview', (_e, o: { accountId: string; project: string; resume?: string | null; continueLast?: boolean }) => {
  const acc = state.accounts.find((a) => a.id === o.accountId);
  if (!acc) return '';
  try {
    return buildShellCommand(acc, o.project, o);
  } catch {
    return '';
  }
});

ipcMain.handle('launch', (_e, o) => launch(o));

ipcMain.handle('showProcess', async (_e, pid: number) => {
  const p = running.find((r) => r.pid === pid);
  if (!p) return false;
  if (p.tty) return revealTerminalTab(p.tty);
  // hosted by a Claude desktop profile: bring THAT profile's app forward
  if (p.appPath) await promisify(execFile)('open', ['-a', p.appPath]).catch(() => undefined);
  else await runAppleScript('tell application "Claude" to activate').catch(() => undefined);
  return true;
});

ipcMain.handle('terminateProcess', async (_e, pid: number) => {
  await refreshRunning();
  const p = running.find((r) => r.pid === pid);
  if (!p) return false;
  const acc = state.accounts.find((a) => a.id === p.accountId);
  const r = await dialog.showMessageBox(win!, {
    type: 'warning',
    buttons: ['Quit it', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Quit claude (pid ${pid})${acc ? ` on ${acc.name}` : ''}?`,
    detail: `Sends a polite stop signal (SIGINT, like Ctrl-C). The conversation is already saved and can be resumed from any account.`,
  });
  if (r.response !== 0) return false;
  try {
    process.kill(pid, 'SIGINT');
    setTimeout(() => pidAlive(pid) && process.kill(pid, 'SIGINT'), 400); // claude asks for a second Ctrl-C
  } catch {
    /* already gone */
  }
  setTimeout(async () => {
    await refreshRunning();
    broadcast();
  }, 1500);
  return true;
});

ipcMain.handle('usageRefresh', (_e, id: string) => refreshUsage(id, 'refresh'));

// ---------- fair use ----------

/** Confirm one account: kind (unless detected), "mine, only I use it", and the limits tick for a 2nd+ Personal plan. */
ipcMain.handle('fairUseConfirm', (_e, id: string, input: AttestInput) => {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) throw new Error('Unknown account');
  syncFairUse();
  applyAttest(state.accounts, acc, input ?? {});
  logLaunch(`fair use: ${acc.name} confirmed (${acc.kind}${acc.limitsAckAt ? ', not used to get around usage limits' : ''})`);
  persist();
  return fairUseView()[acc.id];
});

/** Onboarding: "These accounts are mine, and only I use them." for the accounts that exist now (kind still asked separately). */
ipcMain.handle('fairUseAttestAll', (_e, attested: boolean) => {
  if (attested !== true) throw new Error('Tick the box to confirm these accounts are yours and only you use them.');
  const at = new Date().toISOString();
  for (const a of state.accounts) if (!a.attestedAt) a.attestedAt = at;
  logLaunch('fair use: ownership confirmed for all accounts (onboarding)');
  persist();
});

ipcMain.handle('usageHook', async (_e, id: string, on: boolean) => {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) throw new Error('Unknown account');
  const d = describeInstall(acc);
  if (on && d.installed) return true;
  if (!on && !d.installed) return false;
  const fmt = (v: unknown) => (v ? JSON.stringify(v) : '(none)');
  // Account 1 (~/.claude) is never changed without an explicit confirm that says exactly what changes.
  if (acc.id === 'default' || on) {
    const r = await dialog.showMessageBox(win!, {
      type: acc.id === 'default' ? 'warning' : 'question',
      buttons: [on ? 'Turn on' : 'Turn off', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: on ? `Capture usage passively for “${acc.name}”?` : `Turn off passive capture for “${acc.name}”?`,
      detail: on
        ? `Changes ONE key in ${d.settingsFile}:\n\nstatusLine\n  before: ${fmt(d.current)}\n  after:  ${fmt(d.next)}\n\n` +
          `The script ${d.script} saves only the 5-hour and weekly limits from Claude Code's status-line data to ${USAGE_DIR}/. ` +
          (d.current ? 'It runs your previous status line unchanged. ' : 'It prints a short "5h x% · week y%" status line. ') +
          `The previous value and the whole original file are backed up.\n\nUndo: turn this toggle off — it restores statusLine to ${fmt(d.current)}.`
        : `Restores statusLine in ${d.settingsFile} to ${fmt(d.previous)} and deletes ${d.script}.`,
    });
    if (r.response !== 0) return d.installed;
  }
  const st = on ? installHook(acc) : uninstallHook(acc);
  logLaunch(`usage hook ${on ? 'ON' : 'OFF'} for ${acc.name}: ${d.settingsFile} statusLine = ${fmt(st.current)}`);
  broadcast();
  return st.installed;
});

// ---------- Claude desktop profiles ----------

/** Each Terminal account's sign-in identity, from its .claude.json (oauthAccount.accountUuid + emailAddress only). */
function identities(): TerminalIdentity[] {
  return state.accounts.map((a) => {
    const v = viewAccount(a);
    let accountUuid: string | null = null;
    const files = a.id === 'default' ? [path.join(process.env.HOME || '', '.claude.json'), path.join(a.configDir, '.claude.json')] : [path.join(a.configDir, '.claude.json')];
    for (const f of files) {
      try {
        const o = JSON.parse(fs.readFileSync(f, 'utf8'))?.oauthAccount;
        if (o?.accountUuid) {
          accountUuid = o.accountUuid;
          break;
        }
      } catch {
        /* none */
      }
    }
    return { id: a.id, name: a.name, color: a.color, configDir: a.configDir, email: v.email, accountUuid, signedIn: v.signedIn, isDefault: v.isDefault };
  });
}
/** accountUuid → email. */
function emailByAccountUuid(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of identities()) if (t.accountUuid && t.email) out[t.accountUuid] = t.email;
  return out;
}

async function findProfile(id: string): Promise<DesktopProfile> {
  const p = (await listDesktopProfiles(emailByAccountUuid())).find((x) => x.id === id);
  if (!p) throw new Error('Unknown desktop app');
  return p;
}


ipcMain.handle('desktopProfiles', async () => desktopData());

async function desktopData() {
  const profiles = await listDesktopProfiles(emailByAccountUuid());
  return { profiles, clones: CLONES, claudeVersion: claudeVersion(), colors: Object.keys(HUES) };
}

/**
 * Open in desktop. A profile with no sign-in yet gets "first sign-in mode": Claude's login hands the
 * token back over a claude:// link, and macOS gives that link to whichever Claude app is running —
 * so the other Claude apps are quit first (after a confirm), and only this one is launched.
 */
ipcMain.handle('desktopOpen', async (_e, id: string) => {
  const p = await findProfile(id);
  if (p.id !== 'Claude' && !p.signedIn && !p.running) {
    const others = (await runningDesktops()).filter((r) => r.dataDir.toLowerCase() !== p.dataDir.toLowerCase());
    if (others.length) {
      const all = await listDesktopProfiles({});
      const label = (d: string) => all.find((x) => x.dataDir.toLowerCase() === d.toLowerCase())?.name ?? path.basename(d);
      const r = await dialog.showMessageBox(win!, {
        type: 'warning',
        buttons: [`Quit them and open ${p.name}`, 'Open without quitting', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: `First sign-in for ${p.name}`,
        detail: `${p.name} has no sign-in yet. Claude's login returns through a claude:// link, and macOS hands that link to whichever Claude app is already running — so the sign-in would land in the wrong app.\n\nThese Claude apps will be asked to quit (like ⌘Q; unsaved drafts may be lost):\n${others.map((o) => `  • ${label(o.dataDir)} (pid ${o.pid})`).join('\n')}\n\nAfter you sign in to ${p.name}, reopen the others — from then on all desktop apps run side by side and stay signed in.`,
      });
      if (r.response === 2) return { opened: false };
      if (r.response === 0) {
        const left = await quitDesktops(others.map((o) => o.pid));
        logLaunch(`desktop first sign-in ${p.name}: asked ${others.map((o) => o.pid).join(', ')} to quit${left.length ? ` (still running: ${left.join(', ')})` : ''}`);
        if (left.length) throw new Error(`Some Claude apps did not quit (pid ${left.join(', ')}). Quit them with ⌘Q, then press Open again.`);
      }
    }
  }
  await openProfile(p);
  logLaunch(`desktop open ${p.name} (${p.dataDir})`);
  return { opened: true };
});

ipcMain.handle('openUsage', async (_e, id: string) => {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) throw new Error('Unknown account');
  // run from the current project (already trusted) so no folder-trust prompt sits in front of /usage
  const dir = state.project && fs.existsSync(state.project) ? state.project : process.env.HOME || '/';
  const cmd = buildShellCommand(acc, dir, { usage: true });
  logLaunch(`${dryRun() ? '[dry-run] ' : ''}${acc.name} /usage: ${cmd}`);
  if (!dryRun()) await runAppleScript(appleScriptFor(writeLaunchScript(acc, dir, { usage: true }).command));
  return cmd;
});

ipcMain.handle('setDryRun', (_e, v: boolean) => {
  state.dryRun = v;
  persist();
});

ipcMain.handle('reveal', (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle('openLog', () => shell.openPath(LAUNCH_LOG));
ipcMain.handle('clearLock', () => {
  writeLock(null);
  broadcast();
});

const ops = registerOps({
  state: () => state,
  persist,
  running: () => running,
  refreshRunning,
  win: () => win,
  broadcast,
  log: logLaunch,
  openLogin,
  emailByAccountUuid,
  identities,
  colors: COLORS,
});

// ---------- window / tray ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 600,
    title: 'Baton',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('focus', async () => {
    await refreshRunning();
    broadcast(); // no usage check here: only on app open and on Refresh
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow(route?: string) {
  if (!win) createWindow();
  win!.show();
  win!.focus();
  if (route) win!.webContents.send('route', route);
}

let trayProfiles: DesktopProfile[] = [];
async function refreshTrayProfiles() {
  trayProfiles = await listDesktopProfiles(emailByAccountUuid()).catch(() => trayProfiles);
}

function rebuildTray() {
  if (!tray) return;
  const lock = currentLock();
  const projectName = path.basename(state.project || DEFAULT_PROJECT);
  const active = lock ? state.accounts.find((a) => a.id === lock.account) : null;
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: menuLabel(`Project: ${projectName}`), enabled: false },
    { label: menuLabel(active ? `Active: ${active.name}${lock?.pid ? '' : ' (starting…)'}` : 'No account active'), enabled: false },
    { type: 'separator' },
    { label: 'Continue latest session as…', enabled: false },
  ];
  state.accounts.forEach((a) => {
    const email = viewAccount(a).email;
    const busy = running.some((p) => p.accountId === a.id && sameProject(p.cwd, state.project));
    items.push({
      label: menuLabel(`${busy ? '● ' : '   '}${a.name}${email ? ` — ${email}` : ''}`),
      click: () => void continueFromTray(a.id),
    });
  });
  items.push(
    { type: 'separator' },
    {
      label: 'Recent projects',
      submenu: state.recentProjects.map((p) => ({
        label: menuLabel(p.replace(process.env.HOME || '', '~')),
        type: 'radio' as const,
        checked: p === state.project,
        click: () => {
          rememberProject(p);
          broadcast();
        },
      })),
    },
    {
      label: 'Open in desktop app',
      submenu: trayProfiles.filter((p) => !p.retired).length
        ? trayProfiles
            .filter((p) => !p.retired)
            .map((p) => {
              const acc = identities().find((t) => (t.accountUuid && t.accountUuid === p.accountUuid) || (t.email && t.email === p.email));
              return { label: menuLabel(`${p.running ? '● ' : '   '}${acc ? acc.name : p.email ?? 'Not signed in yet'} — ${p.name}`), click: () => void openProfile(p).catch((e) => dialog.showErrorBox('Baton', String(e?.message || e))) };
            })
        : [{ label: 'None yet', enabled: false }],
    },
    { type: 'separator' },
    { label: 'Open Baton', click: () => showWindow() },
    { label: 'Accounts…', click: () => showWindow('accounts') },
    { label: 'Shared projects…', click: () => showWindow('sharing') },
    { label: 'Doctor…', click: () => showWindow('doctor') },
    { label: menuLabel('History & restore…'), click: () => showWindow('history') },
    { label: 'Add account…', click: () => showWindow('add') },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  );
  const trayAcc = state.accounts.find((a) => a.id === activeAccountId());
  const tu = trayAcc && viewAccount(trayAcc).signedIn ? readUsage(trayAcc) : null;
  const wk = tu?.sevenDay ? Math.round(tu.sevenDay.pct) : null;
  tray.setTitle(wk != null ? ` ${wk}%` : '', { fontType: 'monospacedDigit' });
  items.splice(2, 0, {
    label: menuLabel(
      tu && (tu.fiveHour || tu.sevenDay)
        ? `${trayAcc!.name} usage: 5h ${tu.fiveHour ? Math.round(tu.fiveHour.pct) + '%' : '–'} · week ${wk != null ? wk + '%' : '–'}`
        : `${trayAcc?.name ?? 'Account'} usage: not checked yet`,
    ),
    enabled: false,
  });
  // not setContextMenu: on macOS that would take over the left click. Left click = popover, right click = this menu.
  trayMenu = Menu.buildFromTemplate(items);
  tray.setToolTip(active ? `Baton — ${active.name} on ${projectName}` : 'Baton');
}

function createTray() {
  const icon = nativeImage.createFromPath(res('trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', () => togglePopover());
  tray.on('right-click', () => {
    hidePopover();
    if (trayMenu) tray?.popUpContextMenu(trayMenu);
  });
  rebuildTray();
  createPopover();
}

// ---------- tray popover ----------
//
// A frameless, vibrant panel under the menu-bar icon. Same data as the main window (snapshot IPC), its own
// small preload (tray-preload.ts), and every launch goes through continueFromTray → launch() → launchGate.

let popover: BrowserWindow | null = null;
let trayMenu: Menu | null = null;
let popoverHiddenAt = 0;
let popoverHeight = 480;
let fadeTimer: ReturnType<typeof setInterval> | null = null;

function createPopover() {
  popover = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: popoverHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    title: 'Baton',
    webPreferences: {
      preload: path.join(__dirname, 'tray-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  popover.setAlwaysOnTop(true, 'pop-up-menu');
  popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (isDev) popover.loadURL(new URL('tray.html', process.env.VITE_DEV_SERVER_URL!).toString());
  else popover.loadFile(path.join(__dirname, '..', 'dist', 'tray.html'));
  popover.on('blur', () => hidePopover());
  popover.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popover.webContents.on('will-navigate', (e) => e.preventDefault());
  popover.on('closed', () => (popover = null));
}

function placePopover() {
  if (!popover || !tray) return;
  let tb = tray.getBounds();
  if (!tb.width || !tb.height) {
    const c = screen.getCursorScreenPoint();
    tb = { x: c.x, y: c.y, width: 0, height: 0 };
  }
  const d = screen.getDisplayMatching(tb);
  const pos = popoverPosition(tb, d.workArea, d.bounds, { width: POPOVER_WIDTH, height: popoverHeight });
  popover.setBounds({ x: pos.x, y: pos.y, width: pos.width, height: pos.height });
}

function showPopover() {
  if (!popover) createPopover();
  const p = popover!;
  placePopover();
  if (fadeTimer) clearInterval(fadeTimer);
  const reduce = systemPreferences.getAnimationSettings?.().prefersReducedMotion ?? false;
  p.setOpacity(reduce ? 1 : 0);
  p.show();
  p.focus();
  p.webContents.send('trayShown', { reduceMotion: reduce });
  if (!reduce) {
    let o = 0;
    fadeTimer = setInterval(() => {
      o = Math.min(1, o + 0.2);
      p.setOpacity(o);
      if (o >= 1 && fadeTimer) (clearInterval(fadeTimer), (fadeTimer = null));
    }, 16);
  }
  void refreshRunning().then(() => p.isVisible() && p.webContents.send('changed', snapshot()));
}

function hidePopover() {
  if (!popover?.isVisible()) return;
  if (fadeTimer) (clearInterval(fadeTimer), (fadeTimer = null));
  popover.hide();
  popoverHiddenAt = Date.now();
}

function togglePopover() {
  if (popover?.isVisible()) return hidePopover();
  // a click on the icon while the popover is open first blurs (hides) it — don't reopen on that same click
  if (Date.now() - popoverHiddenAt < 250) return;
  showPopover();
}

/** "Continue latest session as …" from the tray (native menu or popover). Same gates as the main window. */
async function continueFromTray(accountId: string) {
  let r: LaunchResult | null = null;
  try {
    r = (await launch({ accountId, project: state.project, continueLast: true })) as LaunchResult;
  } catch (e: any) {
    dialog.showErrorBox('Baton', String(e?.message || e));
    return { kind: 'error' as const, message: String(e?.message || e) };
  }
  const next = routeLaunchResult(accountId, r);
  if (next.kind === 'window') {
    hidePopover();
    state.selectedAccount = accountId;
    saveState(state);
    showWindow(next.route);
    win?.webContents.send(next.event, next.payload);
  }
  return next.kind === 'window' ? { kind: next.kind, status: r.status } : next;
}

const fromPopover = (e: Electron.IpcMainInvokeEvent) => !!popover && e.sender === popover.webContents;

ipcMain.handle('trayContinue', (e, id: string) => {
  if (!fromPopover(e) || typeof id !== 'string') return null;
  return continueFromTray(id);
});

/** Opens the account's Claude desktop app. A first sign-in needs the main window's confirm flow, so it goes there. */
ipcMain.handle('trayDesktop', async (e, profileId: string | null) => {
  if (!fromPopover(e)) return null;
  hidePopover();
  const p = profileId ? (await listDesktopProfiles(emailByAccountUuid())).find((x) => x.id === profileId) : null;
  if (p && (p.id === 'Claude' || p.signedIn || p.running)) {
    await openProfile(p).catch((err) => dialog.showErrorBox('Baton', String(err?.message || err)));
    logLaunch(`desktop open ${p.name} (${p.dataDir}) — from the menu bar`);
    return { opened: true };
  }
  showWindow('accounts');
  return { opened: false };
});

ipcMain.handle('trayOpen', (e, route: string) => {
  if (!fromPopover(e) || !isTrayRoute(route)) return;
  hidePopover();
  showWindow(route === 'home' ? undefined : route);
});
ipcMain.handle('trayHide', (e) => fromPopover(e) && hidePopover());
ipcMain.handle('trayQuit', (e) => fromPopover(e) && app.quit());
ipcMain.handle('trayResize', (e, h: number) => {
  if (!fromPopover(e) || !Number.isFinite(h)) return;
  const next = Math.round(Math.min(POPOVER_MAX_HEIGHT, Math.max(POPOVER_MIN_HEIGHT, h)));
  if (Math.abs(next - popoverHeight) < 2) return;
  popoverHeight = next;
  if (popover?.isVisible()) placePopover();
  else popover?.setSize(POPOVER_WIDTH, next);
});

function buildAppMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Baton',
      submenu: [
        { label: 'About Baton', click: () => showWindow('about') },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => showWindow('settings') },
        { type: 'separator' },
        { label: 'Add Account…', accelerator: 'CommandOrControl+N', click: () => showWindow('add') },
        { label: 'Help', accelerator: 'CommandOrControl+/', click: () => showWindow('help') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Refresh', accelerator: 'CommandOrControl+R', click: () => win?.webContents.send('route', 'refresh') },
        { type: 'separator' },
        { label: 'Shared Projects', accelerator: 'CommandOrControl+Shift+S', click: () => showWindow('sharing') },
        { label: 'Accounts', accelerator: 'CommandOrControl+Shift+D', click: () => showWindow('accounts') },
        { label: 'Doctor', accelerator: 'CommandOrControl+Shift+K', click: () => showWindow('doctor') },
        { label: menuLabel('History & Restore'), accelerator: 'CommandOrControl+Shift+H', click: () => showWindow('history') },
        { type: 'separator' },
        ...(isDev ? ([{ role: 'toggleDevTools' }] as Electron.MenuItemConstructorOptions[]) : []),
        {
          label: 'Appearance',
          submenu: (['system', 'light', 'dark'] as const).map((m) => ({
            label: m === 'system' ? 'Match System' : m === 'light' ? 'Light' : 'Dark',
            type: 'radio' as const,
            checked: (state.appearance ?? 'system') === m,
            click: () => {
              state.appearance = m;
              nativeTheme.themeSource = m;
              persist();
            },
          })),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName('Baton');
// Installs made under the old name keep their Electron data folder ("Claude Switch"); new installs use "Baton".
app.setPath('userData', resolveUserData(app.getPath('appData')));
app.whenReady().then(async () => {
  nativeTheme.themeSource = state.appearance ?? 'system';
  buildAppMenu();
  await refreshRunning();
  createWindow();
  createTray();
  nativeTheme.on('updated', broadcast);
  await refreshTrayProfiles();
  setInterval(async () => {
    await refreshTrayProfiles();
    if (win?.isVisible()) {
      await refreshRunning();
      broadcast();
    }
  }, 6000);
  if (SCRUBBED_AT_START.length) logLaunch(`started with inherited session env — removed: ${SCRUBBED_AT_START.join(', ')}`);
  // auth check for every signed-in account at startup (clean env, no model call): kind detection + Suspended
  syncFairUse();
  for (const a of state.accounts) checkAuth(a).then(() => (syncFairUse(), broadcast()), () => undefined);
  // passive status-line captures are files: re-reading them for the tray is free and spawns nothing
  setInterval(() => {
    if (!win?.isVisible()) rebuildTray();
  }, 60_000);
  // usage: checked once on open (gated: at most once per 15 min per account); afterwards only on Refresh
  void checkUsageOnOpen();
});

app.on('activate', () => showWindow());
app.on('before-quit', () => {
  quitting = true;
});
