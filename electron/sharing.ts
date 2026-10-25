// Baton — explicit, per-project sharing.
//
// Facts this is built on (checked 25 Oct 2026 on Claude desktop 3.6556 / claude-code 2.1.308):
//  * Terminal: `claude` with CLAUDE_CONFIG_DIR=<dir> keeps transcripts in <dir>/projects/<encoded cwd>/.
//    Account 1 (~/.claude) is the canonical store. Sharing project P with account X = ONE symlink
//    X/projects/<enc P> → ~/.claude/projects/<enc P>. X/projects is a real folder; everything else stays private.
//  * Desktop: every profile's Code tab runs claude WITHOUT CLAUDE_CONFIG_DIR, so all desktop transcripts land in
//    ~/.claude/projects (SSH sessions under ~/.claude/projects/ssh-<id>/). Verified for Claude, Claude-Claude Side
//    and Claude-Cs Test: every indexed local session's transcript is there (one stale entry has no transcript anywhere).
//  * The Code-tab sidebar is per profile/account/org: <profile>/claude-code-sessions/<acct>/<org>/local_<id>.json,
//    rewritten by atomic rename. Linking whole folders shared every project at once, so sharing now mirrors only the
//    index files of the chosen projects (sync engine below).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Account } from './core';
import { encodeProject, hiddenDir, legacyLinksFile, legacyStore, readOnly, roots, sharedProjects, sharingFile, syncStateFile, desktopRegistry } from './roots';
import { lstat, readJson, readSettings, sha256, sha256File, writeJsonAtomic, listJournal, listSnapshots, verifySnapshot, type Operation, type Step } from './safety';

// ---------- config ----------

export interface SharedProject {
  path: string; // absolute project folder
  accounts: string[]; // terminal account ids (account 1 always has everything: it IS the store)
  desktop: string[]; // desktop index folder keys "<profile>/<acct>/<org>" (used when auto is not set)
  /**
   * Desktop lists follow the accounts: every desktop app signed in as account 1 or one of `accounts` takes part
   * (its own account's lists only, never old sign-in leftovers). Set by the simple share dialog.
   */
  auto?: boolean;
}
export interface SharingConfig {
  version: 1;
  projects: SharedProject[];
}
export const readSharing = (): SharingConfig => readJson<SharingConfig>(sharingFile(), { version: 1, projects: [] });
const configStep = (c: SharingConfig): Step => ({ t: 'write', path: sharingFile(), data: JSON.stringify(c, null, 2) });
const stateStep = (st: SyncState): Step => ({ t: 'write', path: syncStateFile(), data: JSON.stringify(st, null, 2) });
/** After a planned share/migration ran (or was abandoned): drop its staging copies. */
export function cleanupStaging(dir: string) {
  if (readOnly()) return;
  if (dir && dir.startsWith(path.join(roots().appDir, 'work') + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- desktop index folders ----------

export interface DesktopFolder {
  key: string; // "<profile>/<acct>/<org>"
  profile: string; // "Claude" | "Claude-<Name>"
  accountUuid: string;
  orgUuid: string;
  dir: string;
  isLink: boolean;
  sessions: number;
}

export function desktopFolders(): DesktopFolder[] {
  const out: DesktopFolder[] = [];
  const sup = roots().support;
  let names: string[] = [];
  try {
    names = fs.readdirSync(sup).filter((n) => n === 'Claude' || (n.startsWith('Claude-') && n !== 'Claude-Switch'));
  } catch {
    return out;
  }
  for (const profile of names.sort()) {
    const base = path.join(sup, profile, 'claude-code-sessions');
    for (const a of list(base)) {
      for (const o of list(path.join(base, a))) {
        const dir = path.join(base, a, o);
        const st = lstat(dir);
        if (!st) continue;
        const isLink = st.isSymbolicLink();
        if (!isLink && !st.isDirectory()) continue;
        out.push({ key: `${profile}/${a}/${o}`, profile, accountUuid: a, orgUuid: o, dir, isLink, sessions: list(dir).filter((f) => /^local_.*\.json$/.test(f)).length });
      }
    }
  }
  return out;
}
function list(d: string): string[] {
  try {
    return fs.readdirSync(d).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}
export const insideProject = (cwd: string | null | undefined, project: string) => !!cwd && (cwd === project || cwd.startsWith(project.replace(/\/+$/, '') + '/'));

// ---------- who owns which desktop list (for derived sharing + same-account sync) ----------

export interface SyncContext {
  /** Each desktop app (profile folder name) and the account it is signed in as now. */
  owners: { profile: string; accountUuid: string | null; retired: boolean }[];
  /** Terminal account id → its accountUuid (from its .claude.json). */
  accountUuids: Record<string, string | null>;
  /** Settings › same account = same chat list. */
  sameAccount: boolean;
}
export const emptyCtx: SyncContext = { owners: [], accountUuids: {}, sameAccount: false };
export const profileLabel = (profile: string) => (profile === 'Claude' ? 'Claude (default)' : profile.replace(/^Claude-/, ''));

/** A desktop list belongs to its app when the app is signed in as that list's account (else: old sign-in leftover). */
export function ownedFolders(ctx: SyncContext, accountUuids?: string[]): DesktopFolder[] {
  return desktopFolders().filter(
    (f) => (!accountUuids || accountUuids.includes(f.accountUuid)) && ctx.owners.some((o) => o.profile === f.profile && o.accountUuid === f.accountUuid && !o.retired),
  );
}
/** The desktop lists a shared project syncs: derived from its accounts (auto) or the explicit Advanced choice. */
export function projectDesktop(sp: SharedProject, ctx: SyncContext): string[] {
  const retired = new Set(ctx.owners.filter((o) => o.retired).map((o) => o.profile));
  if (!sp.auto) return sp.desktop.filter((k) => !retired.has(k.split('/')[0]));
  const uuids = ['default', ...sp.accounts].map((id) => ctx.accountUuids[id]).filter((u): u is string => !!u);
  return ownedFolders(ctx, uuids).map((f) => f.key);
}

export interface SyncGroup {
  key: string; // project path, or "account:<acct>/<org>"
  folders: string[];
  match: (cwd: string | null) => boolean;
}
/** Everything the sync engine keeps in step: each shared project's lists, plus (option) each account's own apps. */
export function syncGroups(cfg: SharingConfig, ctx: SyncContext): SyncGroup[] {
  const groups: SyncGroup[] = cfg.projects.map((sp) => ({ key: sp.path, folders: projectDesktop(sp, ctx), match: (cwd) => insideProject(cwd, sp.path) }));
  if (ctx.sameAccount) {
    const byKey = new Map<string, string[]>();
    for (const f of ownedFolders(ctx)) {
      const k = `account:${f.accountUuid}/${f.orgUuid}`;
      byKey.set(k, [...(byKey.get(k) ?? []), f.key]);
    }
    for (const [key, folders] of byKey) if (folders.length >= 2) groups.push({ key, folders, match: () => true });
  }
  return groups;
}

// ---------- terminal sharing ----------

export type TermState = 'shared' | 'private' | 'legacy-all' | 'wrong-link' | 'private-history' | 'no-folder';
export function terminalState(acc: Account, project: string): TermState {
  const pd = path.join(acc.configDir, 'projects');
  const st = lstat(pd);
  if (!st) return 'no-folder';
  if (st.isSymbolicLink()) return 'legacy-all';
  const link = path.join(pd, encodeProject(project));
  const l = lstat(link);
  if (!l) return 'private';
  if (l.isSymbolicLink()) return path.resolve(pd, fs.readlinkSync(link)) === path.join(sharedProjects(), encodeProject(project)) ? 'shared' : 'wrong-link';
  return 'private-history';
}

function shareTerminalSteps(acc: Account, project: string, steps: Step[], touches: string[], omit: string[], notes: string[]) {
  const pd = path.join(acc.configDir, 'projects');
  const enc = encodeProject(project);
  const link = path.join(pd, enc);
  const target = path.join(sharedProjects(), enc);
  const state = terminalState(acc, project);
  if (state === 'legacy-all') throw new Error(`${acc.name} still shares its whole history (projects is one link). Apply the migration first (Doctor › Migration).`);
  if (state === 'shared') return;
  touches.push(link);
  if (state === 'no-folder') steps.push({ t: 'mkdir', path: pd });
  if (!fs.existsSync(target)) steps.push({ t: 'mkdir', path: target }), touches.push(target);
  if (state === 'wrong-link') steps.push({ t: 'unlink', path: link });
  if (state === 'private-history') {
    // merge: copy the account's private transcripts into the shared store (new files only — never overwrite),
    // then keep the private folder renamed next to the link.
    const aside = `${link}.private-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    let copied = 0;
    let kept = 0;
    const dirs: Step[] = [];
    const writes: Step[] = [];
    const walk = (rel: string) => {
      for (const n of fs.readdirSync(path.join(link, rel))) {
        const r = path.join(rel, n);
        const src = path.join(link, r);
        const dst = path.join(target, r);
        const s = fs.lstatSync(src);
        if (s.isDirectory()) {
          if (!fs.existsSync(dst)) dirs.push({ t: 'mkdir', path: dst }), touches.push(dst);
          walk(r);
        } else if (s.isFile()) {
          if (!fs.existsSync(dst)) writes.push({ t: 'write', path: dst, from: path.join(aside, r), mtimeMs: s.mtimeMs }), touches.push(dst), copied++;
          else if (sha256File(dst) !== sha256File(src)) kept++;
        }
      }
    };
    walk('');
    // move aside first (the link name must be free), then copy from the aside location
    steps.push({ t: 'moveAside', path: link, to: aside }, ...dirs, ...writes);
    touches.push(aside);
    omit.push(link);
    notes.push(`${acc.name} had its own history for this project: ${copied} file(s) are added to the shared store (nothing there is overwritten${kept ? `; ${kept} differing file(s) stay only in the private copy` : ''}); its folder is kept as ${path.basename(aside)}.`);
  }
  steps.push({ t: 'symlink', path: link, target });
}

// ---------- the sync engine (desktop index files) ----------

interface FileVer {
  folder: DesktopFolder;
  file: string;
  hash: string;
  mtimeMs: number;
  cwd: string | null;
  buf: Buffer;
}
export interface SyncState {
  [project: string]: { [file: string]: { hash: string; mtimeMs: number; folders: Record<string, string> } };
}
export const readSyncState = (): SyncState => readJson<SyncState>(syncStateFile(), {});

/** Reads an index file only when it is stable (size+mtime unchanged across the read) and parses as JSON. */
export function readStable(p: string): { buf: Buffer; mtimeMs: number; cwd: string | null } | null {
  try {
    const a = fs.statSync(p);
    const buf = fs.readFileSync(p);
    const b = fs.statSync(p);
    if (a.size !== b.size || a.mtimeMs !== b.mtimeMs || buf.length !== b.size) return null;
    const j = JSON.parse(buf.toString('utf8'));
    return { buf, mtimeMs: b.mtimeMs, cwd: typeof j?.cwd === 'string' ? j.cwd : null };
  } catch {
    return null;
  }
}

export interface SyncPlan {
  steps: Step[];
  touches: string[];
  conflicts: { project: string; file: string; winner: string; losers: string[] }[];
  deferred: { file: string; folder: string; reason: string }[];
  skippedLinks: string[];
  newState: SyncState;
  staging: string;
  copies: number;
}

/**
 * Two-way mirror of the local_*.json files whose cwd is inside a shared project, between that project's desktop
 * folders. Newest wins on conflict; every overwritten (losing) version is kept by the operation's snapshot.
 * Never deletes: a file removed in one folder is not removed elsewhere and is not re-added there.
 * Folders of a running profile are only read; writes to them wait until that profile quits.
 */
export function planSync(cfg: SharingConfig, state: SyncState, runningProfiles: Set<string>, only?: string, ctx: SyncContext = emptyCtx): SyncPlan {
  const staging = path.join(roots().appDir, 'work', `sync-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`);
  const plan: SyncPlan = { steps: [], touches: [], conflicts: [], deferred: [], skippedLinks: [], newState: JSON.parse(JSON.stringify(state)), staging, copies: 0 };
  const all = desktopFolders();
  const planned = new Set<string>(); // a file may be in two groups (a shared project AND an account's apps): write it once
  for (const sp of syncGroups(cfg, ctx)) {
    if (only && sp.key !== only) continue;
    const parts = all.filter((f) => sp.folders.includes(f.key));
    for (const f of parts) if (f.isLink) plan.skippedLinks.push(f.key);
    const real = parts.filter((f) => !f.isLink);
    if (real.length < 2) continue;
    const vers = new Map<string, FileVer[]>();
    const unstable = new Set<string>();
    for (const f of real) {
      for (const file of list(f.dir).filter((n) => /^local_.*\.json$/.test(n))) {
        const r = readStable(path.join(f.dir, file));
        if (!r) {
          unstable.add(file);
          continue;
        }
        if (!sp.match(r.cwd)) continue;
        const arr = vers.get(file) ?? [];
        arr.push({ folder: f, file, hash: sha256(r.buf), mtimeMs: r.mtimeMs, cwd: r.cwd, buf: r.buf });
        vers.set(file, arr);
      }
    }
    const ps = (plan.newState[sp.key] ??= {});
    for (const [file, vs] of vers) {
      if (unstable.has(file)) continue; // mid-write somewhere — next pass
      const last = ps[file];
      const changed = vs.filter((v) => !last || v.hash !== last.hash);
      const cands = changed.length ? changed : vs;
      const sorted = [...cands].sort((a, b) => b.mtimeMs - a.mtimeMs || a.hash.localeCompare(b.hash));
      const winner = sorted[0];
      const losers = sorted.filter((v) => v.hash !== winner.hash);
      if (losers.length) plan.conflicts.push({ project: sp.key, file, winner: winner.folder.key, losers: losers.map((l) => l.folder.key) });
      const rec = { hash: winner.hash, mtimeMs: winner.mtimeMs, folders: { ...(last?.folders ?? {}) } };
      let staged = '';
      for (const f of real) {
        const v = vs.find((x) => x.folder.key === f.key);
        if (v && v.hash === winner.hash) {
          rec.folders[f.key] = v.hash;
          continue;
        }
        if (!v && last?.folders[f.key]) continue; // removed there by the app: never re-add, never delete elsewhere
        if (runningProfiles.has(f.profile)) {
          plan.deferred.push({ file, folder: f.key, reason: `${f.profile} is running` });
          continue;
        }
        if (!staged && readOnly()) staged = path.join(winner.folder.dir, file); // preview only: nothing is staged
        else if (!staged) {
          staged = path.join(staging, `${winner.hash.slice(0, 12)}-${file}`);
          fs.mkdirSync(staging, { recursive: true });
          fs.writeFileSync(staged, winner.buf);
        }
        const dst = path.join(f.dir, file);
        if (planned.has(dst)) {
          rec.folders[f.key] = winner.hash;
          continue;
        }
        planned.add(dst);
        plan.steps.push({ t: 'write', path: dst, from: staged, mtimeMs: winner.mtimeMs });
        plan.touches.push(dst);
        plan.copies++;
        rec.folders[f.key] = winner.hash;
      }
      ps[file] = rec;
    }
  }
  return plan;
}
export function syncOperation(p: SyncPlan, title = 'Sync shared Code-tab lists'): Operation {
  return {
    kind: 'sync',
    title: `${title}: ${p.copies} index file(s)${p.conflicts.length ? `, ${p.conflicts.length} conflict(s) — newest kept, others saved` : ''}`,
    steps: [...p.steps, stateStep(p.newState)],
    touches: [...p.touches, syncStateFile()],
    category: 'sync',
    pinned: p.conflicts.length > 0,
    notes: [
      ...p.conflicts.map((c) => `conflict ${c.file}: kept the newest (${c.winner}); older versions from ${c.losers.join(', ')} are in this snapshot`),
      ...(p.deferred.length ? [`${p.deferred.length} copy(ies) wait until an open desktop app quits`] : []),
    ],
  };
}

// ---------- share / unshare (one operation for a project's whole participant set) ----------

export interface ShareRequest {
  project: string;
  accounts: string[];
  desktop: string[];
  /** Desktop lists follow the chosen accounts (simple dialog). Without it, `desktop` is an explicit Advanced choice. */
  auto?: boolean;
}
export function planShare(req: ShareRequest, accounts: Account[], runningProfiles: Set<string>, ctx: SyncContext = emptyCtx): { op: Operation; newConfig: SharingConfig; newSyncState: SyncState; staging: string; hidden: HidePlan[]; restored: RestorePlan[] } {
  const project = path.resolve(req.project);
  const cfg = readSharing();
  const cur = cfg.projects.find((p) => p.path === project) ?? { path: project, accounts: [], desktop: [] };
  const steps: Step[] = [];
  const touches: string[] = [sharingFile()];
  const omit: string[] = [];
  const notes: string[] = [];
  const hides: HidePlan[] = [];
  const restoreFor: Account[] = [];
  for (const a of accounts.filter((x) => x.id !== 'default')) {
    const want = req.accounts.includes(a.id);
    const st = terminalState(a, project);
    const wasOn = cur.accounts.includes(a.id) || st === 'shared' || st === 'wrong-link';
    if (want) shareTerminalSteps(a, project, steps, touches, omit, notes);
    else if (st === 'shared' || st === 'wrong-link') {
      const link = path.join(a.configDir, 'projects', encodeProject(project));
      steps.push({ t: 'unlink', path: link });
      touches.push(link);
      notes.push(`${a.name} stops seeing ${path.basename(project)}'s history. Sessions it made there stay in ~/.claude/projects (never deleted).`);
    }
    if (!want && wasOn) {
      const h = planHide(a, project, ctx, hides.map((x) => x.bundle));
      if (h.primary) notes.push(`${a.name} is signed in as the same account as account 1 — its desktop apps keep ${path.basename(project)}'s chats.`);
      if (h.files.length) hides.push(h);
    }
    if (want) restoreFor.push(a);
  }
  const accIds = req.accounts.filter((id) => id !== 'default');
  const next: SharedProject = req.auto ? { path: project, accounts: accIds, desktop: [], auto: true } : { path: project, accounts: accIds, desktop: [...new Set(req.desktop)] };
  const keep = next.accounts.length > 0 || (!next.auto && next.desktop.length > 0);
  const before = cfg.projects.some((p) => p.path === project) ? projectDesktop(cur, ctx) : [];
  const after = keep ? projectDesktop(next, ctx) : [];
  const removed = before.filter((k) => !after.includes(k));
  if (removed.length) notes.push(`Stop syncing ${removed.length} desktop list(s).`);
  if (after.length >= 2) notes.push(`Desktop apps that will show ${path.basename(project)}'s chats: ${[...new Set(after.map((k) => profileLabel(k.split('/')[0])))].join(', ')}.`);
  const newConfig: SharingConfig = { version: 1, projects: [...cfg.projects.filter((p) => p.path !== project), ...(keep ? [next] : [])] };
  const sync = planSync(newConfig, readSyncState(), runningProfiles, project, ctx);
  // hiding: the account's desktop apps stop listing the project's chats (index files moved into ~/.baton/hidden)
  for (const h of hides) {
    steps.push(...h.steps);
    touches.push(...h.touches);
    notes.push(...h.notes);
  }
  // restoring: an account turned (back) on gets its hidden entries back — never over a newer file
  const restored: RestorePlan[] = [];
  for (const a of restoreFor) {
    const r = planRestoreHidden(a, project, ctx, path.join(sync.staging, 'restore'));
    if (!r.steps.length) continue;
    restored.push(r);
  }
  // a restored file the sync would also write: the newer version wins, the other step is dropped (loser kept by the snapshot / the hidden backup)
  const syncSteps = sync.steps.filter((ss) => {
    if (ss.t !== 'write') return true;
    for (const r of restored) {
      const k = r.steps.findIndex((x) => x.t === 'write' && x.path === ss.path);
      if (k < 0) continue;
      const rw = r.steps[k] as Extract<Step, { t: 'write' }>;
      if ((ss.mtimeMs ?? 0) > (rw.mtimeMs ?? 0)) r.steps.splice(k, 1);
      else return false;
    }
    return true;
  });
  for (const r of restored) {
    steps.push(...r.steps);
    touches.push(...r.touches);
    omit.push(...r.omit);
    notes.push(...r.notes);
  }
  steps.push(...syncSteps);
  touches.push(...sync.touches);
  notes.push(...syncOperation(sync).notes!);
  if (sync.copies) notes.push(`${sync.copies} Code-tab index file(s) copied so the chosen desktop lists show ${path.basename(project)}'s sessions.`);
  steps.push(configStep(newConfig), stateStep(sync.newState));
  touches.push(syncStateFile());
  if (!keep) notes.push(`${path.basename(project)} becomes private to account 1 again.`);
  return {
    op: { kind: keep ? 'share' : 'unshare', title: `Sharing for ${path.basename(project)}`, steps, touches: [...new Set(touches)], omit, notes, pinned: restored.some((r) => r.conflicts > 0) },
    newConfig,
    newSyncState: sync.newState,
    staging: sync.staging,
    hidden: hides,
    restored,
  };
}

// ---------- hiding a project's chats from an account's desktop apps (and bringing them back) ----------
//
// The desktop apps all read transcripts from ~/.claude/projects, so the Code-sidebar index is the only thing that
// decides whether an app shows a chat. Turning an account off for a project moves that project's local_*.json
// entries out of every desktop app signed in as that account into
//   ~/.baton/hidden/<YYYYMMDD-HHMMSS>-<account>-<project basename>/<acct>/<org>/local_*.json
// (+ manifest.json with source paths and sha256). Never deleted. Apps signed in as account 1 are never touched.
// The same entry held by several apps of the account: the newest at <acct>/<org>/, the others under apps/<profile>/.

export interface HiddenFile {
  stored: string; // path inside the bundle
  source: string; // absolute path it came from (and goes back to)
  profile: string;
  sha256: string;
  mtimeMs: number;
  title: string | null;
}
export interface HiddenManifest {
  version: 1;
  account: string;
  accountUuid: string | null;
  project: string;
  createdAt: string;
  files: HiddenFile[];
}
export interface HidePlan {
  account: string;
  accountName: string;
  bundle: string;
  files: HiddenFile[];
  apps: string[]; // profile folder names
  steps: Step[];
  touches: string[];
  notes: string[];
  primary: boolean;
}

const stamp = (d = new Date()) => {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
};
const quoteTitle = (f: { title: string | null; source: string }) => (f.title ? `"${f.title}"` : path.basename(f.source));

/** The desktop lists a hide would empty for this account: apps signed in as it now, never account 1's apps. */
export function hideTargets(acc: Pick<Account, 'id'>, ctx: SyncContext): { folders: DesktopFolder[]; primary: boolean } {
  const uuid = ctx.accountUuids[acc.id];
  const def = ctx.accountUuids.default;
  if (!uuid) return { folders: [], primary: false };
  if (def && uuid === def) return { folders: [], primary: true };
  const primaryApps = new Set(ctx.owners.filter((o) => def && o.accountUuid === def).map((o) => o.profile));
  return { folders: ownedFolders(ctx, [uuid]).filter((f) => !f.isLink && !primaryApps.has(f.profile)), primary: false };
}

/** Index files in the account's apps whose cwd is the project or inside it (local_*.json only). */
export function hideCandidates(acc: Pick<Account, 'id'>, project: string, ctx: SyncContext): { files: (HiddenFile & { rel: string })[]; primary: boolean; unstable: string[] } {
  const t = hideTargets(acc, ctx);
  const files: (HiddenFile & { rel: string })[] = [];
  const unstable: string[] = [];
  for (const f of t.folders) {
    for (const n of list(f.dir).filter((x) => /^local_.*\.json$/.test(x))) {
      const src = path.join(f.dir, n);
      const r = readStable(src);
      if (!r) {
        unstable.push(src);
        continue;
      }
      if (!insideProject(r.cwd, project)) continue;
      let title: string | null = null;
      try {
        const j = JSON.parse(r.buf.toString('utf8'));
        title = typeof j?.title === 'string' && j.title.trim() ? j.title.trim() : null;
      } catch {
        /* parsed in readStable */
      }
      files.push({ rel: path.join(f.accountUuid, f.orgUuid, n), stored: '', source: src, profile: f.profile, sha256: sha256(r.buf), mtimeMs: r.mtimeMs, title });
    }
  }
  return { files, primary: t.primary, unstable };
}

export function planHide(acc: Pick<Account, 'id' | 'name'>, project: string, ctx: SyncContext, taken: string[] = []): HidePlan {
  const c = hideCandidates(acc, project, ctx);
  let bundle = path.join(hiddenDir(), `${stamp()}-${acc.id}-${path.basename(project)}`);
  for (let n = 2; fs.existsSync(bundle) || taken.includes(bundle); n++) bundle = path.join(hiddenDir(), `${stamp()}-${acc.id}-${path.basename(project)}-${n}`);
  const h: HidePlan = { account: acc.id, accountName: acc.name, bundle, files: [], apps: [], steps: [], touches: [], notes: [], primary: c.primary };
  if (!c.files.length) return h;
  const byRel = new Map<string, typeof c.files>();
  for (const f of c.files) byRel.set(f.rel, [...(byRel.get(f.rel) ?? []), f]);
  for (const [rel, vs] of byRel) {
    vs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.profile.localeCompare(b.profile));
    vs.forEach((v, i) => h.files.push({ stored: i === 0 ? rel : path.join('apps', v.profile, rel), source: v.source, profile: v.profile, sha256: v.sha256, mtimeMs: v.mtimeMs, title: v.title }));
  }
  h.apps = [...new Set(h.files.map((f) => f.profile))].sort();
  const manifest: HiddenManifest = { version: 1, account: acc.id, accountUuid: ctx.accountUuids[acc.id] ?? null, project, createdAt: new Date().toISOString(), files: h.files };
  h.steps.push({ t: 'mkdir', path: bundle });
  for (const f of h.files) h.steps.push({ t: 'hide', path: f.source, to: path.join(bundle, f.stored) });
  h.steps.push({ t: 'write', path: path.join(bundle, 'manifest.json'), data: JSON.stringify(manifest, null, 2) });
  h.touches.push(bundle, ...h.files.map((f) => f.source));
  for (const app of h.apps) {
    const fs_ = h.files.filter((f) => f.profile === app);
    h.notes.push(`Hidden from ${profileLabel(app)} (${acc.name}): ${fs_.length} ${path.basename(project)} chat(s) — ${fs_.map(quoteTitle).join(', ')}.`);
  }
  h.notes.push(`Those sidebar entries move to ${bundle} with a manifest (nothing is deleted; transcripts stay in ~/.claude/projects). Turning ${acc.name} back on restores them. Account 1's apps keep every chat.`);
  if (c.unstable.length) h.notes.push(`${c.unstable.length} index file(s) were being written and could not be read — left in place.`);
  return h;
}

/** Hidden bundles of this account + project that are not restored yet (with or without a manifest). */
export interface HiddenBundle {
  dir: string;
  manifest: HiddenManifest;
  legacy: boolean;
}
export function findHidden(accountId: string, project: string, ctx: SyncContext = emptyCtx): HiddenBundle[] {
  const out: HiddenBundle[] = [];
  const base = path.basename(project);
  for (const name of list(hiddenDir()).sort()) {
    const dir = path.join(hiddenDir(), name);
    if (name === 'restored' || !lstat(dir)?.isDirectory()) continue;
    const m = readJson<HiddenManifest | null>(path.join(dir, 'manifest.json'), null);
    if (m) {
      if (m.account === accountId && m.project === project && Array.isArray(m.files)) out.push({ dir, manifest: m, legacy: false });
      continue;
    }
    if (fs.existsSync(path.join(dir, 'manifest.json'))) continue; // unreadable manifest: leave it alone
    if (!new RegExp(`^\\d{8}-\\d{6}-${accountId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(name)) continue;
    // no manifest: every <acct>/<org>/local_*.json goes back to the app named for it (or the account's apps now)
    const files: HiddenFile[] = [];
    for (const acct of list(dir)) {
      if (!lstat(path.join(dir, acct))?.isDirectory()) continue;
      const profiles = ctx.owners.filter((o) => o.accountUuid === acct && !o.retired).map((o) => o.profile);
      for (const org of list(path.join(dir, acct))) {
        const od = path.join(dir, acct, org);
        if (!lstat(od)?.isDirectory()) continue;
        for (const n of list(od).filter((x) => /^local_.*\.json$/.test(x))) {
          const fp = path.join(od, n);
          const st = lstat(fp);
          if (!st?.isFile()) continue;
          let title: string | null = null;
          try {
            title = JSON.parse(fs.readFileSync(fp, 'utf8'))?.title ?? null;
          } catch {
            /* still restorable */
          }
          for (const prof of profiles) files.push({ stored: path.join(acct, org, n), source: path.join(roots().support, prof, 'claude-code-sessions', acct, org, n), profile: prof, sha256: sha256File(fp), mtimeMs: st.mtimeMs, title });
        }
      }
    }
    out.push({ dir, legacy: true, manifest: { version: 1, account: accountId, accountUuid: null, project, createdAt: '', files } });
  }
  return out;
}

export interface RestorePlan {
  account: string;
  bundles: string[];
  steps: Step[];
  touches: string[];
  omit: string[];
  notes: string[];
  restoring: number;
  kept: number;
  conflicts: number;
}
/**
 * Puts hidden entries back where they came from. A file already there: same content → nothing; newer or as new →
 * kept (the hidden version stays in the backup); older → replaced (the old one is kept by the snapshot). Then the
 * bundle moves to hidden/restored/ so it is never restored twice.
 */
export function planRestoreHidden(acc: Pick<Account, 'id' | 'name'>, project: string, ctx: SyncContext, staging: string): RestorePlan {
  const r: RestorePlan = { account: acc.id, bundles: [], steps: [], touches: [], omit: [], notes: [], restoring: 0, kept: 0, conflicts: 0 };
  const restoredDir = path.join(hiddenDir(), 'restored');
  const titles = new Map<string, string[]>();
  for (const b of findHidden(acc.id, project, ctx)) {
    r.bundles.push(b.dir);
    for (const f of b.manifest.files) {
      const stored = path.join(b.dir, f.stored);
      if (!lstat(stored)?.isFile()) {
        r.notes.push(`${stored} is missing from the backup — skipped.`);
        continue;
      }
      const profDir = path.join(roots().support, f.profile);
      if (!fs.existsSync(profDir) || !f.source.startsWith(path.join(profDir, 'claude-code-sessions') + path.sep)) {
        r.notes.push(`${profileLabel(f.profile)} no longer exists — ${path.basename(f.source)} stays in the backup.`);
        continue;
      }
      const cur = lstat(f.source) ? readStable(f.source) : null;
      const hash = sha256File(stored);
      if (cur && sha256(cur.buf) === hash) continue;
      if (cur && cur.mtimeMs >= f.mtimeMs) {
        r.kept++;
        continue;
      }
      if (lstat(f.source) && !cur) {
        r.notes.push(`${f.source} is being written — not replaced.`);
        continue;
      }
      if (cur) r.conflicts++;
      let from = stored;
      if (!readOnly()) {
        from = path.join(staging, `${hash.slice(0, 12)}-${path.basename(f.source)}`);
        fs.mkdirSync(staging, { recursive: true });
        fs.copyFileSync(stored, from);
      }
      r.steps.push({ t: 'write', path: f.source, from, mtimeMs: f.mtimeMs });
      r.touches.push(f.source);
      r.restoring++;
      titles.set(f.profile, [...(titles.get(f.profile) ?? []), quoteTitle(f)]);
    }
  }
  if (!r.bundles.length) return r;
  if (!lstat(restoredDir)) r.steps.push({ t: 'mkdir', path: restoredDir });
  for (const b of r.bundles) {
    let to = path.join(restoredDir, path.basename(b));
    for (let n = 2; lstat(to); n++) to = path.join(restoredDir, `${path.basename(b)}-${n}`);
    r.steps.push({ t: 'moveAside', path: b, to });
    r.touches.push(b, to);
    r.omit.push(b);
  }
  r.touches.push(restoredDir);
  for (const [app, ts] of titles) r.notes.unshift(`Back in ${profileLabel(app)} (${acc.name}): ${ts.length} ${path.basename(project)} chat(s) — ${ts.join(', ')}.`);
  if (r.kept) r.notes.push(`${r.kept} entry(ies) already there are as new or newer — kept; the hidden version stays in the backup.`);
  if (r.conflicts) r.notes.push(`${r.conflicts} older entry(ies) replaced by the hidden (newer) version — the old one is kept in this operation's snapshot.`);
  r.notes.push(`The backup folder(s) move to ${restoredDir} (kept).`);
  return r;
}

// ---------- migration from the old all-or-nothing sharing ----------

interface LegacyLink {
  profile: string;
  folder: string;
  backup: string;
}
export interface MigrationSummary {
  shareProjects: string[];
  accounts: { name: string; from: string; to: string; hiddenProjects: number }[];
  desktop: { legacyRecords: number; liveLinks: number; staleRecords: number; participants: string[]; copies: number; deferred: number; legacyStoreFiles: number };
  unchanged: string[];
  needed: boolean;
}

export function planMigration(accounts: Account[], shareProjects: string[], runningProfiles: Set<string>, ctx: SyncContext = emptyCtx): { op: Operation; summary: MigrationSummary; newConfig: SharingConfig; newSyncState: SyncState; staging: string } {
  const steps: Step[] = [];
  const touches: string[] = [];
  const notes: string[] = [];
  const store = sharedProjects();
  const projects = shareProjects.map((p) => path.resolve(p));
  const summary: MigrationSummary = {
    shareProjects: projects,
    accounts: [],
    desktop: { legacyRecords: 0, liveLinks: 0, staleRecords: 0, participants: [], copies: 0, deferred: 0, legacyStoreFiles: 0 },
    unchanged: [],
    needed: false,
  };
  const termShared: string[] = [];
  const storeDirs = list(store).length;
  for (const a of accounts.filter((x) => x.id !== 'default')) {
    const pd = path.join(a.configDir, 'projects');
    const st = lstat(pd);
    if (!st?.isSymbolicLink()) continue;
    if (path.resolve(a.configDir, fs.readlinkSync(pd)) !== store) {
      notes.push(`${a.name}: projects links somewhere unexpected (${fs.readlinkSync(pd)}) — left alone.`);
      continue;
    }
    touches.push(pd);
    steps.push({ t: 'unlink', path: pd }, { t: 'mkdir', path: pd });
    for (const p of projects) {
      const target = path.join(store, encodeProject(p));
      if (!fs.existsSync(target)) steps.push({ t: 'mkdir', path: target }), touches.push(target);
      steps.push({ t: 'symlink', path: path.join(pd, encodeProject(p)), target });
    }
    termShared.push(a.id);
    summary.accounts.push({ name: a.name, from: `${pd} → whole ~/.claude/projects`, to: `real folder with ${projects.length} project link(s): ${projects.map((p) => path.basename(p)).join(', ')}`, hiddenProjects: Math.max(0, storeDirs - projects.length) });
    for (const n of ['plans', 'todos']) if (lstat(path.join(a.configDir, n))?.isSymbolicLink()) summary.unchanged.push(`${a.name}: ${n} link (plan/todo files, not chat history) kept`);
  }
  // legacy whole-folder desktop links
  const legacy = readJson<LegacyLink[]>(legacyLinksFile(), []);
  summary.desktop.legacyRecords = legacy.length;
  for (const l of legacy) {
    const st = lstat(l.folder);
    if (st?.isSymbolicLink()) {
      summary.desktop.liveLinks++;
      touches.push(l.folder);
      steps.push({ t: 'unlink', path: l.folder }, { t: 'mkdir', path: l.folder });
      const orig = fs.existsSync(`${l.backup}.original`) ? `${l.backup}.original` : l.backup;
      for (const f of list(orig).filter((n) => /^local_.*\.json$/.test(n))) steps.push({ t: 'write', path: path.join(l.folder, f), from: path.join(orig, f) });
    } else summary.desktop.staleRecords++;
  }
  if (legacy.length) {
    touches.push(legacyLinksFile());
    steps.push({ t: 'write', path: legacyLinksFile(), data: '[]' });
  }
  // who took part in the old shared list: linked folders + folders whose sessions were merged into the store
  const storeFiles = new Set(list(legacyStore()).filter((n) => /^local_.*\.json$/.test(n)));
  summary.desktop.legacyStoreFiles = storeFiles.size;
  const folders = desktopFolders();
  const participants = folders
    .filter((f) => legacy.some((l) => path.resolve(l.folder) === path.resolve(f.dir)) || list(f.dir).some((n) => storeFiles.has(n)))
    .map((f) => f.key);
  summary.desktop.participants = participants;
  const cfg = readSharing();
  const newConfig: SharingConfig = {
    version: 1,
    projects: [
      ...cfg.projects.filter((p) => !projects.includes(p.path)),
      ...projects.map((p) => {
        const old = cfg.projects.find((x) => x.path === p);
        return { path: p, accounts: [...new Set([...(old?.accounts ?? []), ...termShared])], desktop: [...new Set([...(old?.desktop ?? []), ...participants])] };
      }),
    ],
  };
  // after the links are gone the folders are real, so the first sync can be planned against the new config
  const sync = planSync(newConfig, readSyncState(), runningProfiles, undefined, ctx);
  summary.desktop.copies = sync.copies;
  summary.desktop.deferred = sync.deferred.length;
  steps.push(...sync.steps);
  touches.push(...sync.touches);
  const reg = readJson<Record<string, { autoLink?: boolean }>>(desktopRegistry(), {});
  if (Object.values(reg).some((r) => r.autoLink)) {
    for (const k of Object.keys(reg)) reg[k].autoLink = false;
    touches.push(desktopRegistry());
    steps.push({ t: 'write', path: desktopRegistry(), data: JSON.stringify(reg, null, 2) });
  }
  touches.push(sharingFile(), syncStateFile());
  steps.push(configStep(newConfig), stateStep(sync.newState));
  summary.needed = summary.accounts.length > 0 || legacy.length > 0 || !cfg.projects.length;
  summary.unchanged.push(
    'Account 1 (~/.claude) and every transcript in ~/.claude/projects: untouched',
    `Old shared list store ${legacyStore().replace(roots().home, '~')} (${storeFiles.size} files, all still present in their desktop apps): left in place, no longer used`,
    'Desktop app sign-ins, settings and chats: untouched',
  );
  notes.push(...syncOperation(sync).notes!);
  return { op: { kind: 'migrate', title: `Migrate to per-project sharing (${projects.map((p) => path.basename(p)).join(', ')})`, steps, touches, notes }, summary, newConfig, newSyncState: sync.newState, staging: sync.staging };
}

// ---------- accounts (terminal) ----------

export function planAccountAdd(dir: string, name: string): Operation {
  if (path.basename(dir) === '.claude' || !path.basename(dir).startsWith('.claude-')) throw new Error('Refusing that folder');
  const steps: Step[] = [];
  const st = lstat(dir);
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`${dir} exists and is not a plain folder`);
  if (!st) steps.push({ t: 'mkdir', path: dir });
  if (!lstat(path.join(dir, 'projects'))) steps.push({ t: 'mkdir', path: path.join(dir, 'projects') });
  return { kind: 'account-add', title: `Add account ${name}`, steps, touches: [dir], omit: st ? [dir] : [], notes: ['Shares nothing yet — pick projects to share in Shared projects.'] };
}

export function planAccountRemove(acc: Account): Operation {
  const dir = acc.configDir;
  if (acc.id === 'default' || !path.basename(dir).startsWith('.claude-')) throw new Error('Account 1 (~/.claude) can never be removed');
  const steps: Step[] = [];
  const links: string[] = [];
  for (const n of list(dir)) {
    const p = path.join(dir, n);
    if (lstat(p)?.isSymbolicLink()) links.push(p);
  }
  const pd = path.join(dir, 'projects');
  if (lstat(pd)?.isDirectory() && !lstat(pd)?.isSymbolicLink()) for (const n of list(pd)) if (lstat(path.join(pd, n))?.isSymbolicLink()) links.push(path.join(pd, n));
  for (const l of links) steps.push({ t: 'unlink', path: l });
  steps.push({ t: 'trash', path: dir });
  return { kind: 'account-remove', title: `Remove account ${acc.name}`, steps, touches: links, notes: [`${dir} goes to the Trash (Finder › Put Back restores it). Links are removed first, so nothing they point at is touched. The Keychain sign-in item is not removed.`] };
}

// ---------- doctor ----------

export interface DoctorCheck {
  id: string;
  level: 'ok' | 'info' | 'warn' | 'error';
  title: string;
  detail: string;
  fix?: { kind: string; label: string; args?: unknown };
}

export async function runDoctor(o: {
  accounts: Account[];
  profiles: { name: string; needsUpdate: boolean; cloneVersion: string | null; running: boolean }[];
  claudeVersion: string | null;
  runningProfiles: Set<string>;
  freeBytes: number | null;
  deepSnapshots?: boolean;
  ctx?: SyncContext;
}): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const home = roots().home;
  const t = (p: string) => p.replace(home, '~');
  // interrupted operations
  const stuck = listJournal().filter((j) => j.status === 'applying');
  out.push(stuck.length ? { id: 'journal', level: 'error', title: `${stuck.length} interrupted operation(s)`, detail: stuck.map((j) => j.title).join(', '), fix: { kind: 'recover', label: 'Roll back now' } } : { id: 'journal', level: 'ok', title: 'No interrupted operations', detail: 'Every operation finished or was rolled back.' });
  const failed = listJournal().filter((j) => j.status === 'failed-rollback');
  if (failed.length) out.push({ id: 'failed', level: 'error', title: `${failed.length} rollback(s) had problems`, detail: `${failed.map((j) => j.title).join(', ')} — open History for the step-by-step log; Restore center can restore the snapshot.` });
  // legacy blind sharing
  const legacyAcc = o.accounts.filter((a) => a.id !== 'default' && lstat(path.join(a.configDir, 'projects'))?.isSymbolicLink());
  const legacyLinks = readJson<LegacyLink[]>(legacyLinksFile(), []);
  if (legacyAcc.length || legacyLinks.length)
    out.push({
      id: 'legacy',
      level: 'warn',
      title: 'Old all-or-nothing sharing is still in place',
      detail: [legacyAcc.length ? `${legacyAcc.map((a) => a.name).join(', ')}: projects is ONE link to all of ~/.claude/projects` : '', legacyLinks.length ? `${legacyLinks.length} desktop list folder record(s) from the old Link feature` : ''].filter(Boolean).join(' · '),
      fix: { kind: 'migrate', label: 'Review migration' },
    });
  else out.push({ id: 'legacy', level: 'ok', title: 'Per-project sharing in use', detail: 'No whole-history links.' });
  // broken links in account folders
  const broken: string[] = [];
  for (const a of o.accounts.filter((x) => x.id !== 'default')) {
    for (const n of list(a.configDir)) {
      const p = path.join(a.configDir, n);
      if (lstat(p)?.isSymbolicLink() && !fs.existsSync(p)) broken.push(p);
    }
    const pd = path.join(a.configDir, 'projects');
    if (lstat(pd)?.isDirectory() && !lstat(pd)?.isSymbolicLink()) for (const n of list(pd)) if (lstat(path.join(pd, n))?.isSymbolicLink() && !fs.existsSync(path.join(pd, n))) broken.push(path.join(pd, n));
  }
  for (const f of desktopFolders()) if (f.isLink && !fs.existsSync(f.dir)) broken.push(f.dir);
  out.push(broken.length ? { id: 'links', level: 'warn', title: `${broken.length} broken link(s)`, detail: broken.map(t).join(', '), fix: { kind: 'repair-links', label: 'Remove broken links', args: broken } } : { id: 'links', level: 'ok', title: 'No broken links', detail: 'Every link points at something.' });
  // missing shared-project targets
  const cfg = readSharing();
  const missing = cfg.projects.filter((p) => !fs.existsSync(path.join(sharedProjects(), encodeProject(p.path))));
  if (missing.length) out.push({ id: 'targets', level: 'info', title: `${missing.length} shared project(s) have no history yet`, detail: missing.map((p) => t(p.path)).join(', ') });
  // profiles out of date
  const stale = o.profiles.filter((p) => p.needsUpdate);
  out.push(stale.length ? { id: 'profiles', level: 'warn', title: `${stale.length} desktop app copy(ies) older than Claude ${o.claudeVersion}`, detail: stale.map((p) => `${p.name} (${p.cloneVersion})`).join(', '), fix: { kind: 'profile-update', label: 'Update desktop apps' } } : { id: 'profiles', level: 'ok', title: 'Desktop app copies are current', detail: o.claudeVersion ? `Claude ${o.claudeVersion}` : 'Claude.app not found' });
  // unsynced index files
  const ctx = o.ctx ?? emptyCtx;
  const sp = planSync(cfg, readSyncState(), o.runningProfiles, undefined, ctx);
  fs.rmSync(sp.staging, { recursive: true, force: true });
  const groups = syncGroups(cfg, ctx).filter((g) => g.folders.length >= 2);
  if (!groups.length) out.push({ id: 'sync', level: 'info', title: 'No desktop chat lists are synced', detail: 'Share a project with another account (or keep one account in two desktop apps) to keep their Code-tab sidebars in step.' });
  else
    out.push(
      sp.copies || sp.deferred.length || sp.skippedLinks.length
        ? { id: 'sync', level: sp.skippedLinks.length ? 'warn' : 'info', title: `${sp.copies + sp.deferred.length} index file(s) not yet synced`, detail: [sp.copies ? `${sp.copies} ready` : '', sp.deferred.length ? `${sp.deferred.length} waiting for a running profile to quit` : '', sp.skippedLinks.length ? `${sp.skippedLinks.length} list folder(s) are still old links (migration fixes this)` : ''].filter(Boolean).join(' · '), fix: sp.copies ? { kind: 'sync-now', label: 'Sync now' } : undefined }
        : { id: 'sync', level: 'ok', title: 'Desktop chat lists are in sync', detail: `${groups.filter((g) => !g.key.startsWith('account:')).length} shared project(s)${groups.some((g) => g.key.startsWith('account:')) ? ' · same-account apps' : ''}` },
    );
  // disk space
  if (o.freeBytes != null) {
    const gb = o.freeBytes / 1e9;
    out.push({ id: 'disk', level: gb < 1 ? 'error' : gb < 5 ? 'warn' : 'ok', title: `${gb.toFixed(1)} GB free`, detail: gb < 5 ? 'Snapshots and Claude need room — free some space.' : 'Plenty of room for snapshots.' });
  }
  // snapshot integrity
  const snaps = listSnapshots();
  const bad: string[] = [];
  for (const s of snaps) {
    if (!s.verified) bad.push(s.id);
    else if (s.tar && o.deepSnapshots) {
      const v = await verifySnapshot(s.id);
      if (!v.ok) bad.push(s.id);
    } else if (s.tar) {
      const f = path.join(roots().appDir, 'snapshots', s.id, 'data.tar.gz');
      if (!fs.existsSync(f) || sha256File(f) !== s.tar.sha256) bad.push(s.id);
    }
  }
  out.push(bad.length ? { id: 'snapshots', level: 'error', title: `${bad.length} snapshot(s) failed integrity`, detail: bad.slice(0, 4).join(', ') } : { id: 'snapshots', level: 'ok', title: `${snaps.length} snapshot(s), all intact`, detail: `Keeping ${readSettings().retention} per kind (newest 5 always kept; conflict and quarantine snapshots never pruned).` });
  return out;
}

// ---------- why a project is shared (read from the journal) ----------

/**
 * When the project's current sharing (with at least one other account) began, and which operation started it.
 * Walks finished, not-undone operations oldest first and looks at the sharing.json each one wrote.
 */
export function sharedSince(project: string): { since: string; kind: string; title: string } | null {
  const js = listJournal()
    .filter((j) => j.status === 'done' && !j.undoneBy && j.kind !== 'undo' && j.kind !== 'restore')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let cur: { since: string; kind: string; title: string } | null = null;
  for (const j of js) {
    const w = j.steps.find((s) => s.t === 'write' && s.path === sharingFile() && typeof s.data === 'string');
    if (!w || w.t !== 'write') continue;
    let cfg: SharingConfig;
    try {
      cfg = JSON.parse(w.data!);
    } catch {
      continue;
    }
    const has = cfg.projects?.some((p) => p.path === project && p.accounts?.length > 0);
    if (has && !cur) cur = { since: j.createdAt, kind: j.kind, title: j.title };
    else if (!has) cur = null;
  }
  return cur;
}
