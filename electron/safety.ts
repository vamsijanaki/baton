// Baton — safety engine. Every write Baton makes to the user's Claude folders goes through here.
//
//   plan (Operation = list of primitive Steps)  →  preview (exact file operations)  →  confirm (UI)
//   →  running check  →  snapshot (tar.gz + manifest with sha256) → VERIFY snapshot (abort if bad)
//   →  journal  →  apply step by step (journal updated after each)  →  verify postconditions
//   →  on any failure: automatic rollback from the journal (inverse steps, newest first).
//   A crash mid-way leaves the journal in "applying"; recoverInterrupted() rolls it back on next start.
//
// Never delete user data: removed things are unlinked (symlinks only), moved to a quarantine folder inside the
// operation's snapshot, or moved to the macOS Trash. The guard list refuses anything else (see guardStep).
// Transcripts in ~/.claude/projects are never modified, so snapshots never contain them (only links, index
// files and small config) — that is what keeps snapshots small.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { COLOR_FILE, defaultDir, hiddenDir, journalDir, readOnly, roots, settingsFile, sharedProjects, snapshotsDir } from './roots';

const run = promisify(execFile);
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: '1' };
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

// ---------- settings ----------

export interface Settings {
  retention: number; // keep N snapshots per category (newest 5 always kept)
  syncEnabled: boolean;
  onboarded: boolean;
  /** Every desktop app signed in as the same account shows the same Code sidebar (index files synced between them). */
  sameAccountSync: boolean;
  /** Check GitHub Releases for a new Baton version on launch and once a day. Default ON; off = nothing is contacted unless you press Check now. */
  autoUpdateCheck: boolean;
}
/**
 * Defaults. sameAccountSync is ON for a new setup (no settings file yet); an existing setup that predates the
 * option reads it as OFF until the user applies the previewed "same account = same chat list" operation.
 */
export function readSettings(): Settings {
  try {
    return { retention: 20, syncEnabled: true, onboarded: false, sameAccountSync: false, autoUpdateCheck: true, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { retention: 20, syncEnabled: true, onboarded: false, sameAccountSync: true, autoUpdateCheck: true };
  }
}
export function writeSettings(patch: Partial<Settings>) {
  const s = { ...readSettings(), ...patch };
  if (patch.retention !== undefined) s.retention = Math.max(5, Math.min(500, Math.round(patch.retention)));
  writeJsonAtomic(settingsFile(), s);
  return s;
}

// ---------- small fs helpers ----------

export function writeJsonAtomic(file: string, data: unknown) {
  if (readOnly()) throw new Error(`read-only mode: refusing to write ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
export function sha256File(f: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}
export const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
export function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}
const inside = (p: string, dir: string) => {
  const a = path.resolve(p).toLowerCase();
  const b = path.resolve(dir).toLowerCase();
  return a === b || a.startsWith(b + path.sep);
}; // APFS is case-insensitive
/** The path with every EXISTING ancestor resolved through symlinks (catches writes that go through a linked folder). */
function realAncestor(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.join(cur, ...rest);
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

// ---------- guard list ----------

export type Step =
  | { t: 'mkdir'; path: string }
  | { t: 'symlink'; path: string; target: string }
  | { t: 'unlink'; path: string } // symlinks only
  | { t: 'write'; path: string; from?: string; data?: string; mtimeMs?: number; mode?: number } // atomic tmp + rename
  | { t: 'quarantine'; path: string } // move into the operation's quarantine folder
  | { t: 'moveAside'; path: string; to: string } // rename, e.g. a private folder kept next to its link
  | { t: 'hide'; path: string; to: string } // move a Code-tab index file into ~/.baton/hidden (kept, restorable)
  | { t: 'rmAppCopy'; path: string } // a rebuildable Claude.app copy (not user data)
  | { t: 'clone'; path: string; name: string; color: string } // build a Claude.app copy (handler registered by desktop.ts)
  | { t: 'trash'; path: string }; // macOS Trash (handler registered by main) — not auto-invertible

/** Where a path lives, for the guard and the running check. */
export function classify(p: string): { area: 'claude-app' | 'transcripts' | 'default-account' | 'desktop-data' | 'app-copies' | 'other'; profileDir?: string } {
  const R = roots();
  if (inside(p, R.claudeApp) || inside(p, '/Applications/Claude.app')) return { area: 'claude-app' };
  if (inside(p, sharedProjects())) return { area: 'transcripts' };
  if (inside(p, defaultDir())) return { area: 'default-account' };
  if (inside(p, R.appsDir) || inside(p, path.join(R.support, 'claude-switch', 'apps')) || inside(p, path.join(R.support, 'Baton', 'apps'))) return { area: 'app-copies' };
  if (inside(p, R.support)) {
    const first = path.relative(R.support, path.resolve(p)).split(path.sep)[0];
    const f = first.toLowerCase();
    if (f === 'claude' || (f.startsWith('claude-') && f !== 'claude-switch')) return { area: 'desktop-data', profileDir: path.join(R.support, first) };
  }
  return { area: 'other' };
}

/**
 * The ONE exception inside ~/.claude: account 1's settings.json, and only for the passive usage capture operations
 * (which change its `statusLine` key) and the Undo of one of them. Only `write` and `quarantine` of exactly that
 * file are allowed; every other ~/.claude path stays refused.
 */
export const CLAUDE_SETTINGS_OPS: readonly string[] = ['usage-hook-on', 'usage-hook-off'];
export const claudeSettingsFile = () => path.join(defaultDir(), 'settings.json');
export interface GuardContext {
  /** Set only for CLAUDE_SETTINGS_OPS (or an undo of one): allows writing/quarantining ~/.claude/settings.json. */
  claudeSettings?: boolean;
}
/** The guard context an operation gets. An undo qualifies only when the journal entry it undoes is one of those kinds. */
export function guardContext(op: Pick<Operation, 'kind' | 'undoOfKind'>): GuardContext {
  return { claudeSettings: CLAUDE_SETTINGS_OPS.includes(op.kind) || (op.kind === 'undo' && !!op.undoOfKind && CLAUDE_SETTINGS_OPS.includes(op.undoOfKind)) };
}
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const INDEX_FILE = /claude-code-sessions\/[^/]+\/[^/]+\/local_[^/]+\.json$/;
const inIndexArea = (p: string) => /\/claude-code-sessions(\/|$)/.test(p);

/**
 * Hard guard. Returns a refusal reason, or null when the step is allowed. Checked when planning AND again
 * right before each step runs.
 *  - /Applications/Claude.app: never touched.
 *  - ~/.claude/projects (transcripts): nothing is ever deleted or overwritten; only NEW files/folders may be created.
 *  - ~/.claude (account 1): never written.
 *  - ~/Library/Application Support/Claude*: only the Code-tab index area (claude-code-sessions) may change —
 *    index files written, links unlinked, op-created items quarantined; a brand-new profile folder may be created;
 *    a whole profile folder may only go to the Trash.
 *  - The one exception: ~/.claude/settings.json may be written or quarantined when ctx.claudeSettings is set
 *    (passive usage capture, see guardContext) — never through a symlink, never anything else in ~/.claude.
 */
export function guardStep(s: Step, live = false, ctx: GuardContext = {}): string | null {
  if (s.t === 'hide') {
    // only a local_*.json sidebar entry, only into the hidden area, never over something
    if (!path.isAbsolute(s.path) || !path.isAbsolute(s.to)) return `not an absolute path: ${s.path}`;
    const k = classify(s.path);
    if (k.area !== 'desktop-data' || !INDEX_FILE.test(s.path)) return `${s.path}: only local_*.json Code-tab index files may be hidden`;
    if (live) {
      const real = classify(path.join(realAncestor(path.dirname(s.path)), path.basename(s.path)));
      if (real.area !== 'desktop-data') return `${s.path}: resolves outside desktop app data`;
      const st = lstat(s.path);
      if (st && !st.isFile()) return `${s.path}: not a plain file`;
    }
    if (!inside(s.to, hiddenDir()) || path.resolve(s.to) === path.resolve(hiddenDir())) return `${s.to}: hidden entries go only into ${hiddenDir()}`;
    if (live && lstat(s.to)) return `${s.to} already exists`;
    return null;
  }
  const targets = [s.path, ...(s.t === 'moveAside' ? [s.to] : [])];
  for (const p of targets) {
    if (!path.isAbsolute(p)) return `not an absolute path: ${p}`;
    const st = lstat(p);
    // at apply time also judge where the path REALLY lands (a write through a symlinked folder)
    const kinds = [classify(p)];
    if (live) kinds.push(classify(path.join(realAncestor(path.dirname(p)), path.basename(p))));
    for (const k of kinds) {
      if (k.area === 'claude-app') return `${p}: /Applications/Claude.app is never modified`;
      if (k.area === 'transcripts' && !((s.t === 'write' || s.t === 'mkdir') && !st)) return `${p}: transcripts in ~/.claude/projects are never deleted or overwritten (only new files may be added)`;
      if (k.area === 'default-account') {
        const exception = ctx.claudeSettings && (s.t === 'write' || s.t === 'quarantine') && samePath(p, claudeSettingsFile()) && (!live || !st || st.isFile());
        if (exception) continue;
        return `${p}: ~/.claude (account 1) is never written`;
      }
      if (k.area === 'desktop-data') {
        const rel = path.relative(k.profileDir!, path.resolve(p));
        if (s.t === 'trash' && rel === '' && path.basename(k.profileDir!).startsWith('Claude-')) continue;
        const brandNew = !fs.existsSync(k.profileDir!) || rel === '' || rel === COLOR_FILE;
        if (brandNew && (s.t === 'mkdir' || (s.t === 'write' && rel === COLOR_FILE))) continue;
        if (!inIndexArea(p)) return `${p}: desktop app data is never modified outside the Code-tab index`;
        if (s.t === 'write' && !INDEX_FILE.test(p)) return `${p}: only local_*.json index files may be written`;
        if (s.t === 'trash' || s.t === 'rmAppCopy' || s.t === 'clone' || s.t === 'moveAside') return `${p}: not allowed in desktop app data`;
      }
      if ((s.t === 'rmAppCopy' || s.t === 'clone') && (k.area !== 'app-copies' || !p.endsWith('.app'))) return `${p}: only Claude.app copies under Baton's apps folder may be built or removed this way`;
      if (s.t === 'trash' && k.area !== 'desktop-data' && k.area !== 'other') return `${p}: cannot be trashed`;
    }
    if (live && s.t === 'unlink' && st && !st.isSymbolicLink()) return `${p}: unlink is for symlinks only`;
  }
  return null;
}

// ---------- snapshots ----------

export interface SnapEntry {
  path: string;
  type: 'absent' | 'file' | 'dir' | 'symlink';
  size?: number;
  sha256?: string;
  target?: string;
  mode?: number;
  mtimeMs?: number;
  omitted?: boolean; // big real folder that the operation only moves aside (content not copied; it is preserved by the move)
}
export interface SnapManifest {
  id: string;
  op: string;
  title: string;
  createdAt: string;
  category: 'op' | 'sync';
  pinned: boolean;
  roots: string[];
  entries: SnapEntry[];
  tar: { sha256: string; size: number } | null;
  verified: boolean;
}

function walk(root: string, omit: Set<string>, out: SnapEntry[]) {
  const st = lstat(root);
  if (!st) return out.push({ path: root, type: 'absent' });
  if (st.isSymbolicLink()) return out.push({ path: root, type: 'symlink', target: fs.readlinkSync(root), mtimeMs: st.mtimeMs });
  if (st.isFile()) return out.push({ path: root, type: 'file', size: st.size, sha256: sha256File(root), mode: st.mode & 0o7777, mtimeMs: st.mtimeMs });
  if (st.isDirectory()) {
    if (omit.has(root)) return out.push({ path: root, type: 'dir', omitted: true, mode: st.mode & 0o7777 });
    out.push({ path: root, type: 'dir', mode: st.mode & 0o7777, mtimeMs: st.mtimeMs });
    for (const n of fs.readdirSync(root).sort()) walk(path.join(root, n), omit, out);
  }
}

const rel = (p: string) => path.resolve(p).slice(1); // tar paths relative to /

/** Snapshot of exactly these paths (recursive, never following symlinks), verified by extracting and re-hashing. */
export async function takeSnapshot(o: { op: string; title: string; paths: string[]; omit?: string[]; category?: 'op' | 'sync'; pinned?: boolean }): Promise<SnapManifest> {
  if (readOnly()) throw new Error('read-only mode');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `${stamp}-${o.op.replace(/[^a-z0-9-]/gi, '-').slice(0, 40)}-${crypto.randomBytes(2).toString('hex')}`;
  const dir = path.join(snapshotsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const roots_ = [...new Set(o.paths.map((p) => path.resolve(p)))].filter((p, _i, all) => !all.some((q) => q !== p && inside(p, q)));
  const entries: SnapEntry[] = [];
  for (const r of roots_) walk(r, new Set((o.omit ?? []).map((p) => path.resolve(p))), entries);
  const bytes = entries.reduce((n, e) => n + (e.size ?? 0), 0);
  if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(`Snapshot would be ${Math.round(bytes / 1e6)} MB — refusing (transcripts are never snapshotted; something is wrong with the plan).`);
  const listed = entries.filter((e) => e.type !== 'absent' && !(e.type === 'dir' && e.omitted));
  let tar: SnapManifest['tar'] = null;
  if (listed.length) {
    const list = path.join(dir, 'files.txt');
    fs.writeFileSync(list, listed.map((e) => rel(e.path)).join('\n') + '\n');
    await run('/usr/bin/tar', ['-czf', path.join(dir, 'data.tar.gz'), '-n', '--no-mac-metadata', '-C', '/', '-T', list], { env: TAR_ENV, maxBuffer: 64 * 1024 * 1024 });
    fs.rmSync(list);
    const t = path.join(dir, 'data.tar.gz');
    tar = { sha256: sha256File(t), size: fs.statSync(t).size };
  }
  const m: SnapManifest = { id, op: o.op, title: o.title, createdAt: new Date().toISOString(), category: o.category ?? 'op', pinned: !!o.pinned, roots: roots_, entries, tar, verified: false };
  writeJsonAtomic(path.join(dir, 'manifest.json'), m);
  const v = await verifySnapshot(id);
  if (!v.ok) throw new Error(`Snapshot verification failed — nothing was changed. ${v.problems.slice(0, 3).join('; ')}`);
  m.verified = true;
  writeJsonAtomic(path.join(dir, 'manifest.json'), m);
  return m;
}

export function readSnapshot(id: string): SnapManifest {
  const m = readJson<SnapManifest | null>(path.join(snapshotsDir(), id, 'manifest.json'), null);
  if (!m) throw new Error(`Snapshot ${id} not found`);
  return m;
}

/** Extracts a snapshot's archive into a fresh work folder; returns its root. */
export async function extractSnapshot(id: string): Promise<string> {
  const m = readSnapshot(id);
  const work = path.join(roots().appDir, 'work', `${id}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true });
  if (m.tar) {
    const t = path.join(snapshotsDir(), id, 'data.tar.gz');
    if (sha256File(t) !== m.tar.sha256) throw new Error(`Snapshot ${id}: archive checksum mismatch`);
    await run('/usr/bin/tar', ['-xzf', t, '-C', work], { env: TAR_ENV, maxBuffer: 64 * 1024 * 1024 });
  }
  return work;
}

export async function verifySnapshot(id: string): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  let work = '';
  try {
    const m = readSnapshot(id);
    work = await extractSnapshot(id);
    for (const e of m.entries) {
      if (e.type === 'absent' || e.omitted) continue;
      const x = path.join(work, rel(e.path));
      const st = lstat(x);
      if (!st) problems.push(`missing in archive: ${e.path}`);
      else if (e.type === 'symlink' && (!st.isSymbolicLink() || fs.readlinkSync(x) !== e.target)) problems.push(`link differs: ${e.path}`);
      else if (e.type === 'file' && (!st.isFile() || sha256File(x) !== e.sha256)) problems.push(`checksum differs: ${e.path}`);
      else if (e.type === 'dir' && !st.isDirectory()) problems.push(`not a folder: ${e.path}`);
    }
  } catch (err: any) {
    problems.push(String(err?.message ?? err));
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, problems };
}

export function listSnapshots(): (SnapManifest & { bytes: number; quarantined: number })[] {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(snapshotsDir());
  } catch {
    return [];
  }
  const out: (SnapManifest & { bytes: number; quarantined: number })[] = [];
  for (const id of ids) {
    const m = readJson<SnapManifest | null>(path.join(snapshotsDir(), id, 'manifest.json'), null);
    if (!m) continue;
    const q = path.join(snapshotsDir(), id, 'quarantine');
    out.push({ ...m, bytes: m.tar?.size ?? 0, quarantined: fs.existsSync(q) ? countFiles(q) : 0 });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function countFiles(d: string): number {
  let n = 0;
  for (const x of fs.readdirSync(d)) {
    const st = fs.lstatSync(path.join(d, x));
    n += st.isDirectory() ? countFiles(path.join(d, x)) : 1;
  }
  return n;
}

/**
 * Retention: per category keep the newest max(N, 5); never delete pinned snapshots (conflict losers), snapshots
 * holding quarantined items, or ones an unfinished operation still needs. Deleting old snapshots only removes
 * Baton's own copies — never user data.
 */
export function pruneSnapshots(): string[] {
  if (readOnly()) return [];
  const N = Math.max(5, readSettings().retention);
  const busy = new Set(listJournal().filter((j) => j.status === 'applying').map((j) => j.snapshotId));
  const removed: string[] = [];
  for (const cat of ['op', 'sync'] as const) {
    const all = listSnapshots().filter((s) => s.category === cat);
    for (const s of all.slice(N)) {
      if (s.pinned || s.quarantined > 0 || busy.has(s.id)) continue;
      fs.rmSync(path.join(snapshotsDir(), s.id), { recursive: true, force: true });
      removed.push(s.id);
    }
  }
  return removed;
}

// ---------- operations ----------

export interface Operation {
  kind: string; // e.g. share, unshare, migrate, sync, restore, undo, profile-create …
  title: string;
  steps: Step[];
  touches: string[]; // roots to snapshot
  omit?: string[]; // big folders that steps only move aside
  category?: 'op' | 'sync';
  pinned?: boolean;
  notes?: string[]; // shown in the preview (what is NOT changed, etc.)
  /** Extra paths for the running check only (not snapshotted): e.g. a whole desktop data folder that must be quit. */
  busyPaths?: string[];
  /** Undo only: the kind of the operation being undone (decides the guard context; checked against the journal). */
  undoOfKind?: string;
}
export interface JournalEntry {
  id: string;
  kind: string;
  title: string;
  createdAt: string;
  finishedAt?: string;
  status: 'applying' | 'done' | 'rolled-back' | 'failed-rollback';
  snapshotId: string;
  steps: Step[];
  pre: (PreState | null)[];
  done: number; // steps fully applied
  error?: string;
  rollbackLog?: string[];
  notes?: string[];
  undoneBy?: string;
  undoOf?: string;
}
interface PreState {
  existed: boolean;
  linkTarget?: string;
  prevCopy?: string; // copy of the previous file (for write rollback)
  quarantinedTo?: string;
}

export interface EngineHooks {
  /** Names of running Claude processes that use any of these paths (empty = free). */
  busy?: (touches: string[]) => Promise<string[]>;
  trash?: (p: string) => Promise<void>;
  clone?: (path: string, name: string, color: string) => Promise<void>;
}
let hooks: EngineHooks = {};
export function setEngineHooks(h: EngineHooks) {
  hooks = { ...hooks, ...h };
}

/** Human, exact list of what an operation will do (the dry run). */
export function describeStep(s: Step): string {
  switch (s.t) {
    case 'mkdir':
      return `create folder ${s.path}`;
    case 'symlink':
      return `create link ${s.path} → ${s.target}`;
    case 'unlink':
      return `remove link ${s.path} (the link only; its target is untouched)`;
    case 'write':
      return `${fs.existsSync(s.path) ? 'overwrite' : 'create'} file ${s.path}${s.from ? ` (from ${s.from})` : ''}`;
    case 'quarantine':
      return `move ${s.path} into the snapshot's quarantine folder (kept, restorable)`;
    case 'moveAside':
      return `rename ${s.path} → ${s.to}`;
    case 'hide':
      return `hide sidebar entry ${s.path} → ${s.to} (moved, kept, restorable)`;
    case 'rmAppCopy':
      return `remove app copy ${s.path} (rebuildable from /Applications/Claude.app)`;
    case 'clone':
      return `build app copy ${s.path} from /Applications/Claude.app (APFS clone)`;
    case 'trash':
      return `move ${s.path} to the macOS Trash`;
  }
}

export interface Preview {
  title: string;
  kind: string;
  lines: string[];
  refused: string[];
  busy: string[];
  touches: string[];
  notes: string[];
}
export async function previewOperation(op: Operation): Promise<Preview> {
  const ctx = guardContext(op);
  const refused = op.steps.map((s) => guardStep(s, false, ctx)).filter((x): x is string => !!x);
  const busy = hooks.busy ? await hooks.busy([...op.touches, ...(op.busyPaths ?? [])]) : [];
  return { title: op.title, kind: op.kind, lines: op.steps.map(describeStep), refused, busy, touches: op.touches, notes: op.notes ?? [] };
}

export function listJournal(): JournalEntry[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(journalDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((n) => readJson<JournalEntry | null>(path.join(journalDir(), n), null))
    .filter((j): j is JournalEntry => !!j)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
const journalFile = (id: string) => path.join(journalDir(), `${id}.json`);
const saveJournal = (j: JournalEntry) => writeJsonAtomic(journalFile(j.id), j);

function quarantinePath(snapshotId: string, p: string) {
  return path.join(snapshotsDir(), snapshotId, 'quarantine', rel(p));
}

function moveInto(src: string, dst: string) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (e: any) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    fs.rmSync(src, { recursive: true });
  }
}

async function applyStep(j: JournalEntry, i: number, ctx: GuardContext) {
  const s = j.steps[i];
  const why = guardStep(s, true, ctx);
  if (why) throw new Error(`Refused by the guard list: ${why}`);
  const st = lstat(s.path);
  const pre: PreState = { existed: !!st, linkTarget: st?.isSymbolicLink() ? fs.readlinkSync(s.path) : undefined };
  switch (s.t) {
    case 'mkdir':
      if (st && !st.isDirectory()) throw new Error(`${s.path} exists and is not a folder`);
      j.pre[i] = pre;
      saveJournal(j);
      fs.mkdirSync(s.path, { recursive: true });
      break;
    case 'symlink':
      if (st) throw new Error(`${s.path} already exists`);
      j.pre[i] = pre;
      saveJournal(j);
      fs.mkdirSync(path.dirname(s.path), { recursive: true });
      fs.symlinkSync(s.target, s.path);
      break;
    case 'unlink':
      j.pre[i] = pre;
      saveJournal(j);
      if (st?.isSymbolicLink()) fs.unlinkSync(s.path);
      break;
    case 'write': {
      if (st && !st.isFile()) throw new Error(`${s.path} exists and is not a file`);
      if (st) {
        pre.prevCopy = path.join(snapshotsDir(), j.snapshotId, 'prev', `${i}-${path.basename(s.path)}`);
        fs.mkdirSync(path.dirname(pre.prevCopy), { recursive: true });
        fs.copyFileSync(s.path, pre.prevCopy);
        fs.utimesSync(pre.prevCopy, st.atime, st.mtime);
      }
      j.pre[i] = pre;
      saveJournal(j);
      const buf = s.from !== undefined ? fs.readFileSync(s.from) : Buffer.from(s.data ?? '', 'utf8');
      fs.mkdirSync(path.dirname(s.path), { recursive: true });
      const tmp = path.join(path.dirname(s.path), `.cs-${process.pid}-${crypto.randomBytes(3).toString('hex')}.tmp`);
      fs.writeFileSync(tmp, buf, { mode: s.mode ?? (st ? st.mode & 0o7777 : 0o600) });
      if (s.mode !== undefined) fs.chmodSync(tmp, s.mode); // not narrowed by the umask
      const mt = s.mtimeMs ?? (s.from ? fs.statSync(s.from).mtimeMs : undefined);
      if (mt) fs.utimesSync(tmp, new Date(), new Date(mt));
      fs.renameSync(tmp, s.path);
      break;
    }
    case 'quarantine':
      pre.quarantinedTo = quarantinePath(j.snapshotId, s.path);
      j.pre[i] = pre;
      saveJournal(j);
      if (st) moveInto(s.path, pre.quarantinedTo);
      break;
    case 'moveAside':
      if (lstat(s.to)) throw new Error(`${s.to} already exists`);
      j.pre[i] = pre;
      saveJournal(j);
      if (st) fs.renameSync(s.path, s.to);
      break;
    case 'hide':
      if (lstat(s.to)) throw new Error(`${s.to} already exists`);
      j.pre[i] = pre;
      saveJournal(j);
      if (st) moveInto(s.path, s.to);
      break;
    case 'rmAppCopy':
      j.pre[i] = pre;
      saveJournal(j);
      fs.rmSync(s.path, { recursive: true, force: true });
      break;
    case 'clone':
      if (!hooks.clone) throw new Error('no clone handler');
      j.pre[i] = pre;
      saveJournal(j);
      await hooks.clone(s.path, s.name, s.color);
      break;
    case 'trash':
      if (!hooks.trash) throw new Error('no trash handler');
      j.pre[i] = pre;
      saveJournal(j);
      if (st) await hooks.trash(s.path);
      break;
  }
}

/** Postcondition of a finished step. */
function checkStep(s: Step): string | null {
  const st = lstat(s.path);
  switch (s.t) {
    case 'mkdir':
      return st?.isDirectory() ? null : `${s.path} is not a folder`;
    case 'symlink':
      return st?.isSymbolicLink() && fs.readlinkSync(s.path) === s.target ? null : `${s.path} is not a link to ${s.target}`;
    case 'unlink':
    case 'quarantine':
    case 'rmAppCopy':
    case 'trash':
      return st ? `${s.path} still exists` : null;
    case 'moveAside':
    case 'hide':
      return !st && lstat(s.to) ? null : `${s.path} was not moved to ${s.to}`;
    case 'write': {
      if (!st?.isFile()) return `${s.path} missing`;
      const want = s.from !== undefined ? sha256File(s.from) : sha256(s.data ?? '');
      return sha256File(s.path) === want ? null : `${s.path} content differs`;
    }
    case 'clone':
      return st?.isDirectory() ? null : `${s.path} not built`;
  }
}

/** Undo one (possibly half-applied) step. Idempotent: it checks the current state first. */
function invertStep(j: JournalEntry, i: number, log: string[]) {
  const s = j.steps[i];
  const pre = j.pre[i];
  if (!pre) return; // never started
  const st = lstat(s.path);
  switch (s.t) {
    case 'mkdir':
      if (!pre.existed && st?.isDirectory()) {
        if (fs.readdirSync(s.path).length === 0) fs.rmdirSync(s.path), log.push(`removed empty folder ${s.path}`);
        else moveInto(s.path, quarantinePath(j.snapshotId, s.path)), log.push(`quarantined ${s.path}`);
      }
      break;
    case 'symlink':
      if (st?.isSymbolicLink() && fs.readlinkSync(s.path) === s.target) fs.unlinkSync(s.path), log.push(`removed link ${s.path}`);
      break;
    case 'unlink':
      if (!st && pre.linkTarget !== undefined) fs.symlinkSync(pre.linkTarget, s.path), log.push(`restored link ${s.path} → ${pre.linkTarget}`);
      break;
    case 'write':
      if (pre.prevCopy && fs.existsSync(pre.prevCopy)) {
        const tmp = `${s.path}.cs-restore.tmp`;
        fs.copyFileSync(pre.prevCopy, tmp);
        const ps = fs.statSync(pre.prevCopy);
        fs.utimesSync(tmp, ps.atime, ps.mtime);
        fs.renameSync(tmp, s.path);
        log.push(`restored previous ${s.path}`);
      } else if (!pre.existed && st) {
        if (classify(s.path).area === 'transcripts') log.push(`kept new file ${s.path} (transcripts are never deleted)`);
        else moveInto(s.path, quarantinePath(j.snapshotId, s.path)), log.push(`quarantined new file ${s.path}`);
      }
      break;
    case 'quarantine':
      if (!st && pre.quarantinedTo && lstat(pre.quarantinedTo)) moveInto(pre.quarantinedTo, s.path), log.push(`moved back ${s.path}`);
      break;
    case 'moveAside':
      if (!st && lstat(s.to)) fs.renameSync(s.to, s.path), log.push(`moved back ${s.path}`);
      break;
    case 'hide':
      if (!st && lstat(s.to)) moveInto(s.to, s.path), log.push(`unhid ${s.path}`);
      break;
    case 'clone':
      if (!pre.existed && st) fs.rmSync(s.path, { recursive: true, force: true }), log.push(`removed app copy ${s.path}`);
      break;
    case 'rmAppCopy':
      log.push(`app copy ${s.path} not rebuilt automatically — open that desktop app to rebuild it`);
      break;
    case 'trash':
      if (!st) log.push(`${s.path} is in the Trash — use Finder › Put Back to restore it`);
      break;
  }
}

function rollback(j: JournalEntry, upTo: number): string[] {
  const log: string[] = [];
  for (let i = Math.min(upTo, j.steps.length - 1); i >= 0; i--) {
    try {
      invertStep(j, i, log);
    } catch (e: any) {
      log.push(`! could not undo step ${i + 1} (${describeStep(j.steps[i])}): ${e?.message ?? e}`);
    }
  }
  return log;
}

export interface RunOptions {
  /** Tests only: SIGKILL the process right after this step index is applied. */
  crashAfterStep?: number;
  /** Tests only: throw (normal failure) before this step index. */
  failAtStep?: number;
  /** Set when the caller has shown the preview (UI). Background sync passes set it too. */
  confirmed: boolean;
  undoOf?: string;
}

export async function runOperation(op: Operation, opts: RunOptions): Promise<JournalEntry> {
  if (readOnly()) throw new Error('read-only mode');
  if (!opts.confirmed) throw new Error('Operation not confirmed');
  if (!op.steps.length) throw new Error('Nothing to do');
  if (op.undoOfKind !== undefined) {
    // the exception an undo gets must match what the journal says it undoes
    const orig = opts.undoOf ? readJson<JournalEntry | null>(journalFile(opts.undoOf), null) : null;
    if (op.kind !== 'undo' || !orig || orig.kind !== op.undoOfKind) throw new Error('Refused by the guard list: undo does not match its journal entry');
  }
  const ctx = guardContext(op);
  const refused = op.steps.map((s) => guardStep(s, false, ctx)).filter(Boolean);
  if (refused.length) throw new Error(`Refused by the guard list:\n${refused.join('\n')}`);
  const busy = hooks.busy ? await hooks.busy([...op.touches, ...(op.busyPaths ?? [])]) : [];
  if (busy.length) throw Object.assign(new Error(`Quit these first — they use files this changes:\n${busy.join('\n')}`), { busy });
  const snap = await takeSnapshot({ op: op.kind, title: op.title, paths: op.touches, omit: op.omit, category: op.category, pinned: op.pinned });
  const j: JournalEntry = {
    id: snap.id,
    kind: op.kind,
    title: op.title,
    createdAt: new Date().toISOString(),
    status: 'applying',
    snapshotId: snap.id,
    steps: op.steps,
    pre: op.steps.map(() => null),
    done: 0,
    notes: op.notes,
    undoOf: opts.undoOf,
  };
  saveJournal(j);
  let i = 0;
  try {
    for (; i < op.steps.length; i++) {
      if (opts.failAtStep === i) throw new Error(`injected failure at step ${i + 1}`);
      await applyStep(j, i, ctx);
      j.done = i + 1;
      saveJournal(j);
      if (opts.crashAfterStep === i) process.kill(process.pid, 'SIGKILL');
    }
    const bad = op.steps.map((s, k) => (op.steps.slice(k + 1).some((l) => l.path === s.path || ((l.t === 'moveAside' || l.t === 'hide') && l.to === s.path)) ? null : checkStep(s))).filter((x): x is string => !!x); // a later step on the same path decides
    if (bad.length) throw new Error(`Verification failed: ${bad.join('; ')}`);
    j.status = 'done';
    j.finishedAt = new Date().toISOString();
    saveJournal(j);
    if (opts.undoOf) {
      const orig = readJson<JournalEntry | null>(journalFile(opts.undoOf), null);
      if (orig) saveJournal({ ...orig, undoneBy: j.id });
    }
    pruneSnapshots();
    return j;
  } catch (e: any) {
    j.error = String(e?.message ?? e);
    j.rollbackLog = rollback(j, i);
    j.status = j.rollbackLog.some((l) => l.startsWith('!')) ? 'failed-rollback' : 'rolled-back';
    j.finishedAt = new Date().toISOString();
    saveJournal(j);
    throw Object.assign(new Error(`${j.error}\nRolled back automatically${j.status === 'failed-rollback' ? ' (with problems — see History)' : ''}.`), { journal: j });
  }
}

/** On start: roll back anything a crash interrupted. */
export function recoverInterrupted(): JournalEntry[] {
  if (readOnly()) return [];
  const out: JournalEntry[] = [];
  for (const j of listJournal()) {
    if (j.status !== 'applying') continue;
    j.rollbackLog = rollback(j, j.done); // includes the step that may have been in flight
    j.status = j.rollbackLog.some((l) => l.startsWith('!')) ? 'failed-rollback' : 'rolled-back';
    j.error = 'Interrupted (app quit or crashed mid-operation) — rolled back on next start';
    j.finishedAt = new Date().toISOString();
    saveJournal(j);
    out.push(j);
  }
  return out;
}

// ---------- restore / undo ----------

export interface RestoreItem {
  path: string;
  snapType: SnapEntry['type'];
  current: 'same' | 'different' | 'missing' | 'extra';
}

/** What restoring would change, per root path of the snapshot. */
export function diffSnapshot(id: string): RestoreItem[] {
  const m = readSnapshot(id);
  const items: RestoreItem[] = [];
  for (const e of m.entries) {
    const st = lstat(e.path);
    let current: RestoreItem['current'] = 'same';
    if (e.type === 'absent') current = st ? 'extra' : 'same';
    else if (!st) current = 'missing';
    else if (e.type === 'symlink') current = st.isSymbolicLink() && fs.readlinkSync(e.path) === e.target ? 'same' : 'different';
    else if (e.type === 'file') current = st.isFile() && st.size === e.size && sha256File(e.path) === e.sha256 ? 'same' : 'different';
    else if (e.type === 'dir') current = st.isDirectory() ? 'same' : 'different';
    items.push({ path: e.path, snapType: e.type, current });
  }
  // items created since inside a snapshotted folder
  for (const e of m.entries) {
    if (e.type !== 'dir' || e.omitted || !lstat(e.path)?.isDirectory()) continue;
    for (const n of fs.readdirSync(e.path)) {
      const p = path.join(e.path, n);
      if (!m.entries.some((x) => x.path === p)) items.push({ path: p, snapType: 'absent', current: 'extra' });
    }
  }
  return items;
}

/** Builds the operation that makes the selected paths (default: all) look exactly like the snapshot. */
export async function planRestore(id: string, selected?: string[], ctx: GuardContext = {}): Promise<{ op: Operation; work: string; skipped: string[] }> {
  const m = readSnapshot(id);
  const work = await extractSnapshot(id);
  const pick = (p: string) => !selected || selected.some((s) => inside(p, s));
  const steps: Step[] = [];
  const skipped: string[] = [];
  const add = (s: Step) => {
    const why = guardStep(s, false, ctx);
    if (why) skipped.push(why);
    else steps.push(s);
  };
  const clear = (p: string, st: fs.Stats) => (st.isSymbolicLink() ? add({ t: 'unlink', path: p }) : add({ t: 'quarantine', path: p }));
  const items = diffSnapshot(id);
  for (const it of items) {
    if (!pick(it.path) || it.current === 'same') continue;
    const e = m.entries.find((x) => x.path === it.path) ?? { path: it.path, type: 'absent' as const };
    const st = lstat(it.path);
    if (e.type === 'absent') {
      if (st) clear(it.path, st);
      continue;
    }
    if (e.type === 'dir') {
      if (st && !st.isDirectory()) clear(it.path, st);
      if (e.omitted) skipped.push(`${it.path}: folder content was preserved by a move, not copied — restore it from where the operation moved it`);
      else add({ t: 'mkdir', path: it.path });
      continue;
    }
    if (st && (e.type === 'symlink' || !st.isFile())) clear(it.path, st);
    if (e.type === 'symlink') add({ t: 'symlink', path: it.path, target: e.target! });
    else add({ t: 'write', path: it.path, from: path.join(work, rel(it.path)), mtimeMs: e.mtimeMs, ...(e.mode !== undefined && !st ? { mode: e.mode } : {}) });
  }
  // order: removals first (deepest first), then creations parents-first
  const rank = (s: Step) => (s.t === 'unlink' || s.t === 'quarantine' ? 0 : s.t === 'mkdir' ? 1 : 2);
  steps.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? b.path.length - a.path.length : a.path.length - b.path.length));
  const touches = [...new Set(steps.map((s) => s.path))];
  return { op: { kind: 'restore', title: `Restore from ${m.title} (${m.createdAt.slice(0, 16).replace('T', ' ')})`, steps, touches, notes: skipped }, work, skipped };
}

export async function planUndo(journalId: string) {
  const j = readJson<JournalEntry | null>(journalFile(journalId), null);
  if (!j) throw new Error('Unknown operation');
  if (j.status !== 'done') throw new Error('Only completed operations can be undone (failed ones were already rolled back).');
  const ctx = guardContext({ kind: 'undo', undoOfKind: j.kind });
  if (ctx.claudeSettings) {
    // ~/.claude/settings.json: undo puts back the whole file, so refuse if anything changed it since (nothing is lost)
    for (const s of j.steps) {
      if (s.t !== 'write' || !samePath(s.path, claudeSettingsFile())) continue;
      const cur = lstat(s.path)?.isFile() ? sha256File(s.path) : null;
      if (cur !== sha256(s.data ?? '')) throw new Error(`${s.path} changed after this operation. Undo would put back the whole file and lose those changes — use the Passive capture switch instead, which changes only statusLine.`);
    }
  }
  const r = await planRestore(j.snapshotId, undefined, ctx);
  // things the operation moved aside / quarantined come back from where they went
  for (let i = j.steps.length - 1; i >= 0; i--) {
    const s = j.steps[i];
    const pre = j.pre[i];
    if (s.t === 'moveAside' && lstat(s.to)) {
      const cur = lstat(s.path);
      if (cur?.isSymbolicLink() && !r.op.steps.some((x) => x.t === 'unlink' && x.path === s.path)) r.op.steps.push({ t: 'unlink', path: s.path });
      if (!cur || cur.isSymbolicLink()) {
        r.op.steps = r.op.steps.filter((x) => x.path !== s.to); // it comes back by the move, not from the snapshot
        r.op.steps.push({ t: 'moveAside', path: s.to, to: s.path });
        (r.op.omit ??= []).push(s.to);
      }
    }
    if (s.t === 'trash') r.op.notes = [...(r.op.notes ?? []), `${s.path} was moved to the Trash — use Finder › Put Back`];
    if (s.t === 'quarantine' && pre?.quarantinedTo && lstat(pre.quarantinedTo) && !lstat(s.path)) r.op.notes = [...(r.op.notes ?? []), `quarantined item is restored from the snapshot copy`];
  }
  r.op.kind = 'undo';
  r.op.undoOfKind = j.kind;
  r.op.title = `Undo: ${j.title}`;
  r.op.touches = [...new Set([...r.op.touches, ...r.op.steps.flatMap((s) => (s.t === 'moveAside' ? [s.path, s.to] : [s.path]))])];
  return r;
}

export function cleanupWork(work: string) {
  if (work && inside(work, path.join(roots().appDir, 'work'))) fs.rmSync(work, { recursive: true, force: true });
}
