// IPC for everything that writes: plan → preview (dry run) → confirm → apply through the safety engine.
// Plus: history/undo, restore center, doctor, shared projects, background desktop-list sync, diagnostics.
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Account, ClaudeProc, State } from './core';
import { accountDirFor, knownProjects, loadState, slugify, viewAccount } from './core';
import * as safety from './safety';
import * as sharing from './sharing';
import * as desktop from './desktop';
import * as apps from './apps';
import * as fairuse from './fairuse';
import * as usageHook from './usage-hook';
import { activityLog, encodeProject, roots, sharedProjects, snapshotsDir } from './roots';

const run = promisify(execFile);

export interface OpsContext {
  state: () => State;
  persist: () => void;
  running: () => ClaudeProc[];
  refreshRunning: () => Promise<ClaudeProc[]>;
  win: () => BrowserWindow | null;
  broadcast: () => void;
  log: (line: string) => void;
  openLogin: (acc: Account) => Promise<string>;
  emailByAccountUuid: () => Record<string, string>;
  identities: () => apps.TerminalIdentity[];
  colors: string[];
}

interface Pending {
  op: safety.Operation;
  created: number;
  after?: (j: safety.JournalEntry) => Promise<unknown> | unknown;
  cleanup?: () => void;
  summary?: unknown;
}
const pending = new Map<string, Pending>();
let busyLock: Promise<unknown> = Promise.resolve(); // one write operation at a time (sync passes included)
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const p = busyLock.then(f, f);
  busyLock = p.catch(() => undefined);
  return p;
};
const clean = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, '');

export function registerOps(ctx: OpsContext) {
  const accounts = () => ctx.state().accounts;
  // only apps whose data folder really is in ~/Library/Application Support (a same-named folder elsewhere is not ours)
  const runningProfiles = async () =>
    new Set((await desktop.runningDesktops()).filter((r) => path.dirname(r.dataDir).toLowerCase() === desktop.SUPPORT.toLowerCase()).map((r) => path.basename(r.dataDir)));
  /** Desktop apps + who they are signed in as, for derived sharing and same-account sync. */
  const model = async () => {
    const emails = ctx.emailByAccountUuid();
    const profiles = await desktop.listDesktopProfiles(emails);
    const terms = ctx.identities();
    return { profiles, terms, emails, sync: apps.syncContext(profiles, terms) };
  };

  // ---- running check used by every operation ----
  safety.setEngineHooks({
    trash: (p) => shell.trashItem(p),
    clone: (p, _name, color) => desktop.buildClone(p, color),
    busy: async (touches) => {
      const out: string[] = [];
      const procs = await ctx.refreshRunning();
      for (const a of accounts().filter((x) => x.id !== 'default')) {
        if (!touches.some((t) => t === a.configDir || t.startsWith(a.configDir + path.sep))) continue;
        for (const p of procs.filter((x) => x.accountId === a.id)) out.push(`${a.name} — claude ${p.source === 'terminal' ? `in Terminal ${p.tty?.replace('/dev/', '') ?? ''}` : p.source} (pid ${p.pid})`);
      }
      const desks = await desktop.runningDesktops();
      for (const d of desks) {
        if (touches.some((t) => safety.classify(t).profileDir?.toLowerCase() === d.dataDir.toLowerCase())) out.push(`${path.basename(d.dataDir).replace(/^Claude-/, '')} — Claude desktop app (pid ${d.pid})`);
      }
      return [...new Set(out)];
    },
  });

  // ---- planners by kind ----
  async function plan(kind: string, a: any): Promise<Pending> {
    switch (kind) {
      case 'share': {
        const m = await model();
        const before = sharing.readSharing().projects.find((p) => p.path === a.project)?.accounts ?? [];
        const after: string[] = a.accounts ?? [];
        // a suspended account's project is never handed to another account
        for (const id of after.filter((x) => !before.includes(x))) {
          const b = fairuse.continueBlock(a.project, id, accounts(), ctx.state().projectUse, sharing.readSharing().projects);
          if (b) throw new Error(`${b.message} (${b.support})`);
        }
        const r = sharing.planShare({ project: a.project, accounts: after, desktop: a.desktop ?? [], auto: !!a.auto }, accounts(), await runningProfiles(), m.sync);
        const notices = fairuse.shareNotices(accounts(), before, after);
        if (notices.length) r.op.notes = [...notices, ...(r.op.notes ?? [])];
        return { op: r.op, created: Date.now(), cleanup: () => sharing.cleanupStaging(r.staging) };
      }
      case 'migrate': {
        const r = sharing.planMigration(accounts(), a?.projects ?? defaultShareProjects(), await runningProfiles(), (await model()).sync);
        return { op: r.op, created: Date.now(), summary: r.summary, cleanup: () => sharing.cleanupStaging(r.staging) };
      }
      case 'sync-now': {
        const p = sharing.planSync(sharing.readSharing(), sharing.readSyncState(), await runningProfiles(), undefined, (await model()).sync);
        return { op: sharing.syncOperation(p, 'Sync now'), created: Date.now(), cleanup: () => sharing.cleanupStaging(p.staging) };
      }
      case 'restore': {
        const r = await safety.planRestore(a.snapshotId, a.paths?.length ? a.paths : undefined);
        return { op: r.op, created: Date.now(), cleanup: () => safety.cleanupWork(r.work) };
      }
      case 'undo': {
        const r = await safety.planUndo(a.journalId);
        return { op: r.op, created: Date.now(), cleanup: () => safety.cleanupWork(r.work), after: () => undefined, summary: { undoOf: a.journalId } };
      }
      case 'repair-links': {
        const paths: string[] = (a?.paths ?? []).filter((p: string) => safety.lstat(p)?.isSymbolicLink() && !fs.existsSync(p));
        return { op: { kind: 'repair-links', title: `Remove ${paths.length} broken link(s)`, steps: paths.map((p) => ({ t: 'unlink' as const, path: p })), touches: paths }, created: Date.now() };
      }
      case 'account-add': {
        const name = String(a.name ?? '').trim();
        const slug = slugify(name);
        if (!slug) throw new Error('Pick a name with letters or numbers');
        if (accounts().some((x) => x.slug === slug)) throw new Error(`An account "${slug}" already exists`);
        const dir = accountDirFor(slug);
        // fair use: "mine, only I use it" + kind are required; a 2nd+ Personal plan also needs the limits tick
        const attest: fairuse.AttestInput = { kind: a.kind, attested: a.attested, notLimitDodging: a.notLimitDodging };
        fairuse.validateAttest(accounts(), { id: slug, name, configDir: dir }, attest);
        return {
          op: sharing.planAccountAdd(dir, name),
          created: Date.now(),
          after: async () => {
            const acc: Account = { id: slug, slug, name, configDir: dir, color: a.color || ctx.colors[accounts().length % ctx.colors.length], limitNote: '', limitResetAt: null };
            ctx.state().accounts.push(acc);
            fairuse.applyAttest(ctx.state().accounts, acc, attest);
            ctx.log(`fair use: ${name} added as ${acc.kind}, ownership confirmed${acc.limitsAckAt ? ', not used to get around usage limits' : ''}`);
            ctx.state().selectedAccount = acc.id;
            ctx.persist();
            if (a.signIn) await ctx.openLogin(acc);
          },
        };
      }
      case 'account-remove': {
        const acc = accounts().find((x) => x.id === a.id);
        if (!acc) throw new Error('Unknown account');
        const cfg = sharing.readSharing();
        const op = sharing.planAccountRemove(acc);
        const next = { version: 1 as const, projects: cfg.projects.map((p) => ({ ...p, accounts: p.accounts.filter((x) => x !== acc.id) })) };
        op.steps.unshift({ t: 'write', path: path.join(roots().appDir, 'sharing.json'), data: JSON.stringify(next, null, 2) });
        op.touches.push(path.join(roots().appDir, 'sharing.json'));
        return {
          op,
          created: Date.now(),
          after: () => {
            const st = ctx.state();
            st.accounts = st.accounts.filter((x) => x.id !== acc.id);
            if (st.selectedAccount === acc.id) st.selectedAccount = 'default';
            ctx.persist();
          },
        };
      }
      case 'profile-create': {
        const r = desktop.planCreateProfile(a.name, a.color);
        return { op: r.op, created: Date.now(), summary: { id: r.id, name: r.name } };
      }
      case 'app-create': {
        // "Create desktop app for <account>": the profile-create path, named after the account and paired with it
        const acc = accounts().find((x) => x.id === a.accountId);
        if (!acc) throw new Error('Unknown account');
        const used = (await desktop.listDesktopProfiles({})).map((p) => p.color);
        const color = a.color && a.color in desktop.HUES ? a.color : Object.keys(desktop.HUES).find((c) => c !== 'orange' && !used.includes(c)) ?? 'blue';
        const r = desktop.planCreateProfile(desktop.freeAppName(acc.name), color, { id: acc.id, name: acc.name });
        return { op: r.op, created: Date.now(), summary: { id: r.id, name: r.name, account: acc.name } };
      }
      case 'merge-apps': {
        const m = await model();
        const keep = m.profiles.find((p) => p.id === a.keep);
        const remove = (a.remove as string[]).map((id) => m.profiles.find((p) => p.id === id));
        if (!keep || remove.some((r) => !r)) throw new Error('Unknown desktop app');
        const r = apps.planMergeApps(keep, remove as desktop.DesktopProfile[], !!a.trashData, keep.accountUuid ? m.emails[keep.accountUuid] ?? null : null);
        return { op: r.op, created: Date.now(), summary: r.summary, cleanup: () => sharing.cleanupStaging(r.staging) };
      }
      case 'same-account-sync': {
        const m = await model();
        const r = apps.planSameAccountOn(m.sync, await runningProfiles());
        return { op: r.op, created: Date.now(), summary: { copies: r.copies, deferred: r.deferred }, cleanup: () => sharing.cleanupStaging(r.staging) };
      }
      case 'profile-color': {
        const p = await findProfile(a.id);
        return { op: desktop.planColor(p, a.color), created: Date.now(), after: () => desktop.applyCloneIcon(path.join(desktop.CLONES, `Claude ${p.name}.app`), a.color) };
      }
      case 'profile-update':
        return { op: desktop.planUpdateProfiles(await desktop.listDesktopProfiles({})).op, created: Date.now() };
      case 'profile-remove': {
        const p = await findProfile(a.id);
        if (a.mode === 'everything' && a.typed !== p.name) throw new Error(`Type the app name exactly (${p.name}) to delete everything.`);
        return { op: desktop.planRemoveProfile(p, a.mode), created: Date.now() };
      }
      case 'usage-hook-on':
      case 'usage-hook-off': {
        const acc = accounts().find((x) => x.id === a?.id);
        if (!acc) throw new Error('Unknown account');
        const r = kind === 'usage-hook-on' ? usageHook.planHookOn(acc, { replace: a.replace === true }) : usageHook.planHookOff(acc);
        return { op: r.op, created: Date.now(), summary: r.summary };
      }
      case 'profile-adopt': {
        const p = await findProfile(a.id);
        return { op: desktop.planAdopt(p), created: Date.now() };
      }
    }
    throw new Error(`Unknown operation ${kind}`);
  }

  ipcMain.handle('opPlan', async (_e, kind: string, args: unknown) => {
    const p = await plan(kind, args);
    const token = crypto.randomUUID();
    pending.set(token, p);
    for (const [k, v] of pending) if (Date.now() - v.created > 30 * 60_000) (v.cleanup?.(), pending.delete(k));
    const preview = await safety.previewOperation(p.op);
    return { token, preview, summary: p.summary ?? null, steps: p.op.steps.length, quittable: preview.busy.length ? await quittable(p.op) : [] };
  });

  /**
   * Desktop apps an operation needs quit, when ONLY desktop apps block it and each one can be told to quit by its own
   * app path (an app path shared with an unaffected running app is not offered — the wrong window could quit).
   */
  async function quittable(op: safety.Operation): Promise<{ pid: number; name: string; appPath: string; dataDir: string }[]> {
    const paths = [...op.touches, ...(op.busyPaths ?? [])];
    const dirs = new Set(paths.map((t) => safety.classify(t).profileDir?.toLowerCase()).filter(Boolean));
    const desks = await desktop.runningDesktops();
    const hit = desks.filter((d) => dirs.has(d.dataDir.toLowerCase()));
    const procs = await ctx.refreshRunning();
    const termBusy = accounts().some((a) => a.id !== 'default' && paths.some((t) => t === a.configDir || t.startsWith(a.configDir + path.sep)) && procs.some((x) => x.accountId === a.id));
    if (termBusy || !hit.length) return [];
    if (hit.some((h) => desks.some((d) => d.pid !== h.pid && !hit.includes(d) && d.appPath === h.appPath))) return [];
    return hit.map((d) => ({ pid: d.pid, appPath: d.appPath, dataDir: d.dataDir, name: path.basename(d.dataDir).replace(/^Claude-/, '') }));
  }

  /** "Quit <app> and continue": graceful quit (osascript, like ⌘Q), wait up to 20 s, apply, then reopen the apps. */
  ipcMain.handle('opQuitApply', async (_e, token: string) => {
    const p = pending.get(token);
    if (!p) throw new Error('This preview expired — review it again.');
    const apps_ = await quittable(p.op);
    if (!apps_.length) return { status: 'busy', busy: (await safety.previewOperation(p.op)).busy };
    for (const a of apps_) {
      ctx.log(`quitting ${a.name} (pid ${a.pid}) for ${p.op.kind}`);
      await run('osascript', ['-e', `tell application "${a.appPath.replace(/["\\]/g, '')}" to quit`], { timeout: 25_000 }).catch((e) => ctx.log(`quit ${a.name}: ${clean(e)}`));
    }
    const until = Date.now() + 20_000;
    let alive = apps_;
    for (;;) {
      const live = new Set((await desktop.runningDesktops()).map((d) => d.pid));
      alive = apps_.filter((a) => live.has(a.pid));
      if (!alive.length || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const reopen = async () => {
      for (const a of apps_.filter((x) => !alive.includes(x))) {
        const isDefault = a.dataDir.toLowerCase() === path.join(desktop.SUPPORT, 'Claude').toLowerCase();
        await run('open', isDefault ? ['-a', a.appPath] : [a.appPath, '--args', `--user-data-dir=${a.dataDir}`]).catch((e) => ctx.log(`reopen ${a.name}: ${clean(e)}`));
      }
    };
    if (alive.length) {
      await reopen();
      return { status: 'busy', busy: alive.map((a) => `${a.name} — did not quit within 20 s (pid ${a.pid}); nothing was changed`) };
    }
    try {
      return await applyToken(token);
    } finally {
      await reopen();
    }
  });

  ipcMain.handle('opCancel', (_e, token: string) => {
    pending.get(token)?.cleanup?.();
    pending.delete(token);
  });

  ipcMain.handle('opApply', (_e, token: string) => applyToken(token));
  async function applyToken(token: string) {
    const p = pending.get(token);
    if (!p) throw new Error('This preview expired — review it again.');
    if (!p.op.steps.length) return { status: 'nothing' };
    return serial(async () => {
      try {
        const undoOf = (p.summary as any)?.undoOf as string | undefined;
        const j = await safety.runOperation(p.op, { confirmed: true, undoOf });
        ctx.log(`op ${j.kind} done: ${j.title} (${j.steps.length} steps, snapshot ${j.snapshotId})`);
        pending.delete(token);
        p.cleanup?.();
        await p.after?.(j);
        ctx.broadcast();
        void restartWatchers();
        return { status: 'done', journalId: j.id, snapshotId: j.snapshotId, summary: p.summary ?? null };
      } catch (e: any) {
        if (e?.busy) return { status: 'busy', busy: e.busy as string[] };
        ctx.log(`op ${p.op.kind} FAILED: ${clean(e)}`);
        pending.delete(token);
        p.cleanup?.();
        throw e;
      }
    });
  }

  // ---- history, restore center ----
  ipcMain.handle('history', () =>
    safety.listJournal().map((j) => ({ id: j.id, kind: j.kind, title: j.title, createdAt: j.createdAt, finishedAt: j.finishedAt, status: j.status, steps: j.steps.map(safety.describeStep), error: j.error, rollbackLog: j.rollbackLog, notes: j.notes, undoneBy: j.undoneBy, undoOf: j.undoOf, snapshotId: j.snapshotId })),
  );
  ipcMain.handle('snapshots', () => safety.listSnapshots().map(({ entries, ...m }) => ({ ...m, entryCount: entries.length })));
  ipcMain.handle('snapshotDiff', (_e, id: string) => safety.diffSnapshot(id));
  ipcMain.handle('snapshotVerify', (_e, id: string) => safety.verifySnapshot(id));
  ipcMain.handle('revealSnapshot', (_e, id: string) => shell.openPath(path.join(snapshotsDir(), id)));

  // ---- shared projects ----
  ipcMain.handle('sharingInfo', async () => {
    const cfg = sharing.readSharing();
    const profiles = await desktop.listDesktopProfiles(ctx.emailByAccountUuid());
    const emails = ctx.emailByAccountUuid();
    const folders = sharing.desktopFolders().map((f) => ({
      ...f,
      profileName: profiles.find((p) => p.id === f.profile)?.name ?? f.profile,
      email: emails[f.accountUuid] ?? null,
      running: profiles.find((p) => p.id === f.profile)?.running ?? false,
    }));
    const m = await model();
    const known = await knownProjects();
    const st = ctx.state();
    const candidates = [...new Set([...cfg.projects.map((p) => p.path), ...st.recentProjects, ...known.slice(0, 30).map((k) => k.path)])];
    const counts = Object.fromEntries(known.map((k) => [k.path, k.count]));
    const terminal = accounts()
      .filter((a) => a.id !== 'default')
      .map((a) => ({ id: a.id, name: a.name, color: a.color, configDir: a.configDir, legacyAll: safety.lstat(path.join(a.configDir, 'projects'))?.isSymbolicLink() ?? false }));
    const states: Record<string, Record<string, sharing.TermState>> = {};
    for (const p of candidates) states[p] = Object.fromEntries(accounts().filter((a) => a.id !== 'default').map((a) => [a.id, sharing.terminalState(a, p)]));
    const desktopCounts: Record<string, Record<string, number>> = {};
    for (const p of candidates) {
      desktopCounts[p] = {};
      for (const f of folders) desktopCounts[p][f.key] = countIndex(f.dir, p);
    }
    const ov = apps.buildOverview(m.terms, m.profiles, m.emails);
    const people = m.terms.map((t) => {
      const c = ov.accounts.find((x) => x.key === t.id);
      return { id: t.id, name: t.name, color: t.color, email: t.email, isDefault: t.isDefault, apps: (c?.apps ?? []).map((x) => x.name), legacyAll: !t.isDefault && (safety.lstat(path.join(t.configDir, 'projects'))?.isSymbolicLink() ?? false) };
    });
    const leftovers = ov.leftovers.map((l) => l.key);
    const owned = new Set(sharing.ownedFolders(m.sync).map((f) => f.key));
    const derived: Record<string, string[]> = {};
    const since: Record<string, { since: string; kind: string; title: string } | null> = {};
    for (const p of candidates) {
      const sp = cfg.projects.find((x) => x.path === p);
      derived[p] = sp ? sharing.projectDesktop(sp, m.sync) : [];
      since[p] = sp ? sharing.sharedSince(p) : null;
    }
    // what turning an account off would hide (its desktop apps only — never account 1's), and what is hidden now
    const hideImpact: Record<string, Record<string, { count: number; apps: string[] }>> = {};
    const hiddenNow: Record<string, Record<string, { count: number; apps: string[] }>> = {};
    const appName = (id: string) => m.profiles.find((x) => x.id === id)?.name ?? sharing.profileLabel(id);
    for (const p of candidates) {
      hideImpact[p] = {};
      hiddenNow[p] = {};
      for (const a of accounts().filter((x) => x.id !== 'default')) {
        if (cfg.projects.some((x) => x.path === p)) {
          const c = sharing.hideCandidates(a, p, m.sync);
          if (c.files.length) hideImpact[p][a.id] = { count: new Set(c.files.map((f) => path.basename(f.source))).size, apps: [...new Set(c.files.map((f) => appName(f.profile)))] };
        }
        const hb = sharing.findHidden(a.id, p, m.sync);
        const files = hb.flatMap((b) => b.manifest.files);
        if (files.length) hiddenNow[p][a.id] = { count: new Set(files.map((f) => path.basename(f.source))).size, apps: [...new Set(files.map((f) => appName(f.profile)))] };
      }
    }
    return {
      config: cfg,
      candidates,
      counts,
      terminal,
      states,
      folders: folders.filter((f) => !m.profiles.find((p) => p.id === f.profile)?.retired).map((f) => ({ ...f, leftover: leftovers.includes(f.key), owned: owned.has(f.key) })),
      desktopCounts,
      account1: accounts().find((a) => a.id === 'default')?.name ?? 'Account 1',
      store: sharedProjects(),
      people,
      derived,
      since,
      hideImpact,
      hiddenNow,
    };
  });
  ipcMain.handle('accountsOverview', async () => {
    const m = await model();
    const ov = apps.buildOverview(m.terms, m.profiles, m.emails);
    const settings = safety.readSettings();
    const multi = ov.accounts.filter((c) => c.apps.length >= 2);
    let offer: { copies: number; deferred: number } | null = null;
    if (!settings.sameAccountSync && multi.length) {
      const r = apps.planSameAccountOn(m.sync, await runningProfiles());
      sharing.cleanupStaging(r.staging);
      offer = { copies: r.copies, deferred: r.deferred };
    }
    return { ...ov, sameAccountSync: settings.sameAccountSync, offer, claudeVersion: desktop.claudeVersion(), clones: desktop.CLONES, colors: Object.keys(desktop.HUES) };
  });
  ipcMain.handle('migrationPreview', async () => {
    const r = sharing.planMigration(accounts(), defaultShareProjects(), await runningProfiles(), (await model()).sync);
    sharing.cleanupStaging(r.staging);
    return { summary: r.summary, preview: await safety.previewOperation(r.op) };
  });

  // ---- doctor ----
  ipcMain.handle('doctor', async (_e, deep?: boolean) => doctor(!!deep));
  ipcMain.handle('recover', () => {
    const r = safety.recoverInterrupted();
    ctx.log(`recovered ${r.length} interrupted operation(s)`);
    return r.length;
  });

  // ---- settings / about / activity / diagnostics ----
  ipcMain.handle('settingsGet', () => safety.readSettings());
  ipcMain.handle('settingsSet', (_e, patch: Partial<safety.Settings>) => {
    const s = safety.writeSettings(patch);
    if ('retention' in patch) safety.pruneSnapshots();
    void restartWatchers();
    return s;
  });
  ipcMain.handle('about', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    macos: os.release(),
    claude: desktop.claudeVersion(),
    appDir: roots().appDir,
  }));
  ipcMain.handle('activity', (_e, n = 300) => {
    try {
      return redact(fs.readFileSync(activityLog(), 'utf8')).split('\n').filter(Boolean).slice(-n).reverse();
    } catch {
      return [];
    }
  });
  ipcMain.handle('exportDiagnostics', async () => {
    const r = await dialog.showSaveDialog(ctx.win()!, { defaultPath: path.join(os.homedir(), 'Desktop', `baton-diagnostics-${new Date().toISOString().slice(0, 10)}.json`) });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(await diagnostics(), null, 2));
    ctx.log(`exported diagnostics to ${r.filePath}`);
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });

  async function doctor(deep: boolean) {
    const profiles = await desktop.listDesktopProfiles({});
    let free: number | null = null;
    try {
      const { stdout } = await run('df', ['-k', roots().home]);
      free = Number(stdout.trim().split('\n').pop()!.split(/\s+/)[3]) * 1024;
    } catch {
      /* unknown */
    }
    const syncCtx = apps.syncContext(await desktop.listDesktopProfiles(ctx.emailByAccountUuid()), ctx.identities());
    return sharing.runDoctor({ accounts: accounts(), profiles, claudeVersion: desktop.claudeVersion(), runningProfiles: await runningProfiles(), freeBytes: free, deepSnapshots: deep, ctx: syncCtx });
  }

  async function diagnostics() {
    const profiles = await desktop.listDesktopProfiles({});
    const cfg = sharing.readSharing();
    return {
      generatedAt: new Date().toISOString(),
      note: 'Redacted: no tokens, no chat content, emails masked, home folder shown as ~.',
      app: { version: app.getVersion(), electron: process.versions.electron, macos: os.release(), claude: desktop.claudeVersion() },
      accounts: accounts().map((a) => {
        const v = viewAccount(a);
        return { id: a.id, name: a.name, dir: tilde(a.configDir), signedIn: v.signedIn, email: maskEmail(v.email), projects: a.id === 'default' ? 'store' : safety.lstat(path.join(a.configDir, 'projects'))?.isSymbolicLink() ? 'whole-history link (old)' : 'per-project' };
      }),
      profiles: profiles.map((p) => ({ id: p.id, version: p.cloneVersion, needsUpdate: p.needsUpdate, signedIn: p.signedIn, running: p.running, lists: p.folders.length, sessions: p.folders.reduce((n, f) => n + f.sessions, 0), origin: p.origin })),
      sharing: cfg.projects.map((p) => ({ project: tilde(p.path), accounts: p.accounts, desktopLists: p.desktop.length })),
      doctor: await doctor(false),
      operations: safety.listJournal().slice(0, 50).map((j) => ({ kind: j.kind, status: j.status, at: j.createdAt, steps: j.steps.length, error: j.error ? redact(j.error) : undefined })),
      snapshots: safety.listSnapshots().map((s) => ({ op: s.op, at: s.createdAt, category: s.category, pinned: s.pinned, verified: s.verified, bytes: s.bytes })),
      settings: safety.readSettings(),
      activityTail: (() => {
        try {
          return redact(fs.readFileSync(activityLog(), 'utf8')).split('\n').slice(-150);
        } catch {
          return [];
        }
      })(),
    };
  }

  // ---- background sync of shared desktop lists ----
  let watchers: fs.FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncPass(), 1500); // debounce: the app writes by tmp + rename, often in bursts
  };
  let lastCtx: sharing.SyncContext = sharing.emptyCtx;
  async function restartWatchers() {
    for (const w of watchers) w.close();
    watchers = [];
    if (!safety.readSettings().syncEnabled) return;
    try {
      lastCtx = (await model()).sync;
    } catch {
      /* keep the last one */
    }
    const keys = new Set(sharing.syncGroups(sharing.readSharing(), lastCtx).filter((g) => g.folders.length >= 2).flatMap((g) => g.folders));
    for (const f of sharing.desktopFolders()) {
      if (!keys.has(f.key) || f.isLink) continue;
      try {
        watchers.push(fs.watch(f.dir, (_ev, name) => name && /^local_.*\.json$/.test(String(name)) && schedule()));
      } catch {
        /* folder vanished */
      }
    }
  }
  async function syncPass() {
    if (!safety.readSettings().syncEnabled) return;
    await serial(async () => {
      const syncCtx = await model().then((m) => m.sync, () => lastCtx);
      const p = sharing.planSync(sharing.readSharing(), sharing.readSyncState(), await runningProfiles(), undefined, syncCtx);
      try {
        if (p.steps.length) {
          const j = await safety.runOperation(sharing.syncOperation(p), { confirmed: true });
          ctx.log(`sync: ${j.title}`);
          if (p.conflicts.length) new Notification({ title: 'Baton — sync conflict', body: `${p.conflicts.length} session(s) changed in two places. Kept the newest; the other version is saved (History › Restore).` }).show();
        } else if (JSON.stringify(p.newState) !== JSON.stringify(sharing.readSyncState())) safety.writeJsonAtomic(path.join(roots().appDir, 'sync-state.json'), p.newState);
      } catch (e) {
        ctx.log(`sync pass skipped: ${clean(e)}`);
      } finally {
        sharing.cleanupStaging(p.staging);
      }
    });
  }

  // start: roll back anything a crash interrupted, then watch
  const rec = safety.recoverInterrupted();
  if (rec.length) {
    ctx.log(`start: rolled back ${rec.length} interrupted operation(s): ${rec.map((j) => j.title).join(', ')}`);
    app.whenReady().then(() => new Notification({ title: 'Baton', body: `Rolled back ${rec.length} operation(s) that were interrupted. See History.` }).show());
  }
  void restartWatchers();
  setInterval(() => void syncPass(), 30_000);
  setInterval(() => void restartWatchers(), 120_000); // new folders appear after sign-ins

  return { doctor, syncPass, restartWatchers };
}

async function findProfile(id: string) {
  const p = (await desktop.listDesktopProfiles({})).find((x) => x.id === id);
  if (!p) throw new Error('Unknown desktop app');
  return p;
}

/** The project currently open in Baton, when it has Claude Code history — the one an old whole-history link is narrowed to. */
function defaultShareProjects(): string[] {
  const p = loadState().project;
  return p && fs.existsSync(path.join(sharedProjects(), encodeProject(p))) ? [p] : [];
}

function countIndex(dir: string, project: string): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^local_.*\.json$/.test(f)) continue;
      try {
        if (sharing.insideProject(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).cwd, project)) n++;
      } catch {
        /* unreadable */
      }
    }
  } catch {
    /* none */
  }
  return n;
}

const tilde = (p: string) => p.replace(roots().home, '~');
function maskEmail(e: string | null) {
  if (!e) return null;
  const [u, d] = e.split('@');
  return `${u.slice(0, 1)}***@${d ?? ''}`;
}
function redact(s: string) {
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[token]')
    .replace(/("?(access|refresh)_?[tT]oken"?\s*[:=]\s*)"[^"]*"/g, '$1"[token]"')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m)!)
    .split(roots().home)
    .join('~');
}
