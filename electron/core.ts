// Baton — core logic (no Electron imports, so it can be tested with plain node).
//
// Safety rules baked in here:
//  * ~/.claude (the default account) is NEVER written to, moved or deleted.
//  * Extra accounts live in ~/.claude-<slug>. Sharing is per project (electron/sharing.ts): only the chosen
//    project folders are linked back to ~/.claude/projects. Credentials, settings and statsig are never shared.
//  * Creating, sharing and removing accounts are planned operations (electron/safety.ts): snapshot, journal,
//    verify, automatic rollback.
//  * Process env is parsed for exactly two keys; nothing else (tokens!) is kept.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveAppDir } from './roots';
import { writeJsonAtomic } from './safety';
import type { FairUseFields } from './fairuse';

const run = promisify(execFile);

export const HOME = os.homedir();
export const DEFAULT_DIR = path.join(HOME, '.claude');
export const SHARED_PROJECTS = path.join(DEFAULT_DIR, 'projects');
export const SHARED_LINKS = ['projects', 'todos', 'plans'] as const;
export const APP_DIR = resolveAppDir(HOME); // ~/.baton, or ~/.baton when it already exists
export const STATE_FILE = path.join(APP_DIR, 'state.json');
export const LOCK_FILE = path.join(APP_DIR, 'active.json');
export const LAUNCH_LOG = path.join(APP_DIR, 'launch.log');
export const DEFAULT_PROJECT = HOME; // only a fallback; the UI asks for a project folder

export const COLORS = ['#0d7f72', '#6a9bcc', '#788c5d', '#b48ead', '#e0b252', '#5fb3b3', '#c96f8f'];

export interface Account extends FairUseFields {
  id: string; // 'default' or slug
  name: string;
  slug: string | null; // null for default
  configDir: string;
  color: string;
  limitNote?: string;
  limitResetAt?: string | null; // ISO
}

export interface State {
  accounts: Account[];
  recentProjects: string[];
  selectedAccount: string;
  project: string;
  dryRun: boolean;
  appearance?: 'system' | 'light' | 'dark';
  /** project → accounts Baton opened claude for there (used to keep a suspended account's projects out of other accounts). */
  projectUse?: Record<string, string[]>;
}

export interface AccountView extends Account {
  email: string | null;
  signedIn: boolean;
  isDefault: boolean;
  links: { name: string; ok: boolean; target: string | null }[];
}

// ---------- state ----------

function defaultState(): State {
  return {
    accounts: [
      { id: 'default', name: 'Account 1', slug: null, configDir: DEFAULT_DIR, color: COLORS[0], limitNote: '', limitResetAt: null },
    ],
    recentProjects: [DEFAULT_PROJECT],
    selectedAccount: 'default',
    project: DEFAULT_PROJECT,
    dryRun: false,
  };
}

export function loadState(): State {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<State>;
    const s = { ...defaultState(), ...raw } as State;
    if (!s.accounts.some((a) => a.id === 'default')) s.accounts.unshift(defaultState().accounts[0]);
    // the default account's dir is fixed — never trust the file for it
    s.accounts = s.accounts.map((a) => (a.id === 'default' ? { ...a, slug: null, configDir: DEFAULT_DIR } : a));
    return s;
  } catch {
    return defaultState();
  }
}

export function saveState(s: State) {
  // through the safety engine's atomic writer (honours read-only mode)
  const { usageWarnPct: _w, usageNotified: _n, ...rest } = s as State & { usageWarnPct?: unknown; usageNotified?: unknown };
  writeJsonAtomic(STATE_FILE, rest);
}

// ---------- accounts ----------

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

export function accountDirFor(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`Invalid account slug "${slug}"`);
  return path.join(HOME, `.claude-${slug}`);
}

/** Reads ONLY the email from the account's .claude.json (never tokens). */
export function readEmail(acc: Account): string | null {
  const candidates =
    acc.id === 'default'
      ? [path.join(HOME, '.claude.json'), path.join(DEFAULT_DIR, '.claude.json')]
      : [path.join(acc.configDir, '.claude.json')];
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const e = j?.oauthAccount?.emailAddress;
      if (typeof e === 'string' && e) return e;
    } catch {
      /* not there / unreadable */
    }
  }
  return null;
}

function linkStatus(dir: string) {
  return SHARED_LINKS.map((name) => {
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isSymbolicLink()) return { name, ok: false, target: null };
      const target = fs.readlinkSync(p);
      return { name, ok: path.resolve(dir, target) === path.join(DEFAULT_DIR, name), target };
    } catch {
      return { name, ok: false, target: null };
    }
  }).filter((l) => l.name === 'projects' || l.target !== null || fs.existsSync(path.join(DEFAULT_DIR, l.name)));
}

export function viewAccount(acc: Account): AccountView {
  const isDefault = acc.id === 'default';
  const email = readEmail(acc);
  return {
    ...acc,
    email,
    signedIn: !!email,
    isDefault,
    links: isDefault ? [] : linkStatus(acc.configDir),
  };
}

// ---------- projects & sessions ----------

/** Claude Code's folder naming: every non-alphanumeric char becomes '-'. */
export function encodeProject(p: string): string {
  return path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
}

export interface SessionInfo {
  id: string;
  title: string;
  mtime: number;
  size: number;
  messages: number | null;
  gitBranch: string | null;
  parentId?: string | null; // desktop sub-session: the session it was spawned from
}

// ---------- titles (match the Claude desktop sidebar) ----------
//
// Order: custom-title.json (rename) → the desktop app's own title for that session →
// newest custom-title / ai-title / summary entry in the transcript tail → first user message.
// Cached by file mtime+size; large transcripts are read head (4 MB max) and tail (2 MB) only.

interface DesktopMeta { cli: string; local: string; title: string | null; cwd: string | null; parentLocal: string | null }
const desktopCache = new Map<string, { mtime: number; meta: DesktopMeta | null }>();

/** Reads ONLY id/title/cwd/spawnedFrom from the desktop app's per-session JSON files. */
export function desktopSessions(): { byCli: Map<string, DesktopMeta>; byLocal: Map<string, DesktopMeta> } {
  const byCli = new Map<string, DesktopMeta>();
  const byLocal = new Map<string, DesktopMeta>();
  const support = path.join(HOME, 'Library', 'Application Support');
  let roots: string[] = [];
  try {
    roots = fs.readdirSync(support).filter((d) => d === 'Claude' || d.startsWith('Claude-')).map((d) => path.join(support, d, 'claude-code-sessions'));
  } catch {
    /* none */
  }
  for (const root of roots) {
    let a: string[] = [];
    try { a = fs.readdirSync(root); } catch { continue; }
    for (const x of a) {
      let b: string[] = [];
      try { b = fs.readdirSync(path.join(root, x)); } catch { continue; }
      for (const y of b) {
        let files: string[] = [];
        try { files = fs.readdirSync(path.join(root, x, y)).filter((f) => f.endsWith('.json')); } catch { continue; }
        for (const f of files) {
          const full = path.join(root, x, y, f);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
          let c = desktopCache.get(full);
          if (!c || c.mtime !== mtime) {
            let meta: DesktopMeta | null = null;
            try {
              const j = JSON.parse(fs.readFileSync(full, 'utf8'));
              if (typeof j.cliSessionId === 'string')
                meta = {
                  cli: j.cliSessionId,
                  local: String(j.sessionId ?? ''),
                  title: typeof j.title === 'string' && j.title.trim() ? j.title.trim() : null,
                  cwd: typeof j.cwd === 'string' ? j.cwd : null,
                  parentLocal: typeof j.spawnedFrom?.sessionId === 'string' ? j.spawnedFrom.sessionId : null,
                };
            } catch { /* partial write */ }
            c = { mtime, meta };
            desktopCache.set(full, c);
          }
          if (c.meta) {
            byCli.set(c.meta.cli, c.meta);
            if (c.meta.local) byLocal.set(c.meta.local, c.meta);
          }
        }
      }
    }
  }
  return { byCli, byLocal };
}

async function readTail(file: string, bytes: number, size: number): Promise<string> {
  const fh = await fsp.open(file, 'r');
  try {
    const n = Math.min(bytes, size);
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, size - n);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Newest custom title and newest generated title in the transcript's last 2 MB. */
async function tailTitles(file: string, size: number): Promise<{ custom: string | null; generated: string | null }> {
  const tail = await readTail(file, 2 * 1024 * 1024, size);
  let custom: string | null = null;
  let generated: string | null = null;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0 && !(custom && generated); i--) {
    const l = lines[i];
    if (!l.includes('"custom-title"') && !l.includes('"ai-title"') && !l.includes('"summary"')) continue;
    let o: any;
    try { o = JSON.parse(l); } catch { continue; }
    if (!custom && o.type === 'custom-title' && typeof o.customTitle === 'string') custom = o.customTitle;
    if (!generated && o.type === 'ai-title' && typeof o.aiTitle === 'string') generated = o.aiTitle;
    if (!generated && o.type === 'summary' && typeof o.summary === 'string') generated = o.summary;
  }
  return { custom, generated };
}

const titleCache = new Map<string, { key: string; title: string; gitBranch: string | null }>();

async function sessionTitle(file: string, st: fs.Stats, desktop: DesktopMeta | undefined) {
  const key = `${st.mtimeMs}:${st.size}:${desktop?.title ?? ''}`;
  const hit = titleCache.get(file);
  if (hit && hit.key === key) return hit;
  const head = await sessionMeta(file).catch(() => ({ title: '(unreadable)', cwd: null, gitBranch: null }));
  let renamed: string | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(file.replace(/\.jsonl$/, ''), 'custom-title.json'), 'utf8'));
    if (typeof j.customTitle === 'string' && j.customTitle.trim()) renamed = j.customTitle.trim();
  } catch { /* none */ }
  const t = renamed || desktop?.title ? null : await tailTitles(file, st.size).catch(() => ({ custom: null, generated: null }));
  const raw = renamed || desktop?.title || t?.custom || t?.generated || head.title;
  const clean = raw.replace(/\s+/g, ' ').trim();
  const r = { key, title: clean.length > 160 ? clean.slice(0, 157) + '…' : clean, gitBranch: head.gitBranch };
  titleCache.set(file, r);
  return r;
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const c of content) if (c && typeof c === 'object' && (c as any).type === 'text' && typeof (c as any).text === 'string') return (c as any).text;
  }
  return null;
}

function isNoise(t: string) {
  const s = t.trimStart();
  return (
    !s ||
    s.startsWith('<command-') ||
    s.startsWith('<local-command') ||
    s.startsWith('<system-reminder') ||
    s.startsWith('Caveat:') ||
    s.startsWith('[Request interrupted')
  );
}

async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export async function sessionMeta(file: string): Promise<{ title: string; cwd: string | null; gitBranch: string | null }> {
  let title: string | null = null;
  let customTitle: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  for (const size of [256 * 1024, 4 * 1024 * 1024]) {
    const head = await readHead(file, size);
    const lines = head.split('\n');
    if (head.length >= size) lines.pop(); // possibly truncated
    for (const line of lines) {
      if (!line) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
      if (!gitBranch && typeof o.gitBranch === 'string' && o.gitBranch) gitBranch = o.gitBranch;
      if (o.type === 'custom-title' && typeof o.customTitle === 'string') customTitle = o.customTitle;
      if (!title && o.type === 'user' && !o.isMeta && !o.isSidechain && o.message?.role === 'user') {
        const t = textOf(o.message.content);
        if (t && !isNoise(t)) title = t;
      }
      if (title && cwd) break;
    }
    if (title || head.length < size) break;
  }
  const clean = (customTitle ?? title ?? '(no prompt yet)').replace(/\s+/g, ' ').trim();
  return { title: clean.length > 160 ? clean.slice(0, 157) + '…' : clean, cwd, gitBranch };
}

export async function listSessions(project: string): Promise<{ dir: string; sessions: SessionInfo[] }> {
  const dir = path.join(SHARED_PROJECTS, encodeProject(project));
  let names: string[] = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return { dir, sessions: [] };
  }
  const { byCli, byLocal } = desktopSessions();
  const info = async (file: string, id: string): Promise<SessionInfo | null> => {
    let st: fs.Stats;
    try { st = await fsp.stat(file); } catch { return null; }
    const d = byCli.get(id);
    const t = await sessionTitle(file, st, d);
    const parent = d?.parentLocal ? byLocal.get(d.parentLocal)?.cli ?? null : null;
    return { id, title: t.title, mtime: st.mtimeMs, size: st.size, messages: null, gitBranch: t.gitBranch, parentId: parent };
  };
  const top = (await Promise.all(names.map((n) => info(path.join(dir, n), n.slice(0, -6))))).filter(Boolean) as SessionInfo[];
  top.sort((a, b) => b.mtime - a.mtime);
  // desktop sub-sessions spawned from these sessions (often in a worktree, so another project folder)
  const ids = new Set(top.map((x) => x.id));
  const extra: SessionInfo[] = [];
  for (const d of byCli.values()) {
    if (ids.has(d.cli) || !d.parentLocal || !d.cwd) continue;
    const parent = byLocal.get(d.parentLocal)?.cli;
    if (!parent || !ids.has(parent)) continue;
    const s = await info(path.join(SHARED_PROJECTS, encodeProject(d.cwd), `${d.cli}.jsonl`), d.cli);
    if (s) extra.push(s);
  }
  // order: each parent followed by its children (newest first); orphans stay top-level
  const kids = new Map<string, SessionInfo[]>();
  for (const s of [...top, ...extra]) if (s.parentId && ids.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
  const out: SessionInfo[] = [];
  for (const s of top) {
    if (s.parentId && ids.has(s.parentId)) continue;
    out.push(s);
    for (const k of (kids.get(s.id) ?? []).sort((a, b) => b.mtime - a.mtime)) out.push(k);
  }
  return { dir, sessions: out };
}

/** Projects known from transcripts (real cwd read from a transcript, not decoded). */
export async function knownProjects(): Promise<{ path: string; mtime: number; count: number }[]> {
  let dirs: string[] = [];
  try {
    dirs = await fsp.readdir(SHARED_PROJECTS);
  } catch {
    return [];
  }
  const out = await Promise.all(
    dirs.map(async (d) => {
      const full = path.join(SHARED_PROJECTS, d);
      try {
        const files = (await fsp.readdir(full)).filter((n) => n.endsWith('.jsonl'));
        if (!files.length) return null;
        const stats = await Promise.all(files.map(async (f) => ({ f, st: await fsp.stat(path.join(full, f)) })));
        stats.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
        const meta = await sessionMeta(path.join(full, stats[0].f));
        if (!meta.cwd || encodeProject(meta.cwd) !== d) return null;
        return { path: meta.cwd, mtime: stats[0].st.mtimeMs, count: files.length };
      } catch {
        return null;
      }
    }),
  );
  return out.filter(Boolean).sort((a, b) => b!.mtime - a!.mtime) as any;
}

// ---------- running processes ----------

export interface ClaudeProc {
  pid: number;
  tty: string | null;
  cwd: string | null;
  configDir: string | null; // CLAUDE_CONFIG_DIR, null = default
  email: string | null; // CLAUDE_CODE_USER_EMAIL (desktop-app hosted sessions)
  source: 'terminal' | 'desktop' | 'background';
  accountId: string | null;
  profile: string | null; // Claude desktop profile, e.g. "Claude (default)" / "Claude Side"
  appPath: string | null; // that profile's .app bundle, for `open -a`
}

/** ~/Library/Application Support/<Folder>/claude-code/… → profile label. */
export function desktopProfile(exe: string): string | null {
  const m = exe.match(/\/Library\/Application Support\/([^/]+)\/claude-code\//);
  if (!m) return null;
  return m[1] === 'Claude' ? 'Claude (default)' : m[1].replace(/^Claude-/, '');
}

/** Walks up the parent chain to the desktop app bundle that hosts this claude. */
async function hostAppPath(pid: number, folder: string | null): Promise<string | null> {
  let cur = pid;
  for (let i = 0; i < 8 && cur > 1; i++) {
    let out = '';
    try {
      out = (await run('ps', ['-ww', '-o', 'ppid=,comm=', '-p', String(cur)])).stdout.trim();
    } catch {
      break;
    }
    const m = out.match(/^(\d+)\s+(.+)$/);
    if (!m) break;
    const app = m[2].match(/^(.*?\.app)\/Contents\//)?.[1];
    if (i > 0 && app && !/\/claude-code\//.test(app)) return app;
    cur = Number(m[1]);
  }
  // fallback: Claude.app for the default profile, "Claude <Name>.app" for the others
  const name = !folder || folder === 'Claude' ? 'Claude.app' : `Claude ${folder.replace(/^Claude-/, '')}.app`;
  for (const d of ['/Applications', path.join(HOME, 'Applications')]) if (fs.existsSync(path.join(d, name))) return path.join(d, name);
  return null;
}

function isClaudeBinary(comm: string) {
  return /\/\.local\/share\/claude\/versions\/[^/]+$/.test(comm) || /\/claude\.app\/Contents\/MacOS\/claude$/.test(comm) || path.basename(comm) === 'claude';
}

/** Pulls exactly the named keys out of `ps -E` output; everything else is discarded. */
function pickEnv(cmdWithEnv: string, key: string): string | null {
  const m = cmdWithEnv.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`));
  return m ? m[1] : null;
}

export async function listClaudeProcesses(accounts: Account[], emails: Record<string, string | null>): Promise<ClaudeProc[]> {
  const { stdout } = await run('ps', ['-axww', '-o', 'pid=,tty=,comm='], { maxBuffer: 8 * 1024 * 1024 });
  const procs: { pid: number; tty: string; comm: string }[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const comm = m[3].trim();
    if (!isClaudeBinary(comm)) continue;
    if (Number(m[1]) === process.pid) continue;
    procs.push({ pid: Number(m[1]), tty: m[2], comm });
  }
  const out: ClaudeProc[] = [];
  for (const p of procs) {
    let envLine = '';
    try {
      envLine = (await run('ps', ['-E', '-ww', '-o', 'command=', '-p', String(p.pid)], { maxBuffer: 4 * 1024 * 1024 })).stdout;
    } catch {
      continue; // exited
    }
    const configDir = pickEnv(envLine, 'CLAUDE_CONFIG_DIR');
    const email = pickEnv(envLine, 'CLAUDE_CODE_USER_EMAIL');
    const entry = pickEnv(envLine, 'CLAUDE_CODE_ENTRYPOINT');
    envLine = ''; // drop the rest (it can contain tokens) immediately
    // skip claude's own helper daemons (e.g. the chrome bridge) — no project cwd
    let cwd: string | null = null;
    try {
      const l = (await run('lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'])).stdout.split('\n').find((x) => x.startsWith('n'));
      cwd = l ? l.slice(1) : null;
    } catch {
      /* ignore */
    }
    if (cwd && (cwd === '/' || cwd.startsWith(DEFAULT_DIR + '/'))) continue;
    const tty = p.tty && p.tty !== '??' ? `/dev/${p.tty}` : null;
    const profile = desktopProfile(p.comm);
    const source: ClaudeProc['source'] = tty ? 'terminal' : (entry && entry.includes('desktop')) || profile ? 'desktop' : 'background';
    const appPath = source === 'desktop' ? await hostAppPath(p.pid, p.comm.match(/Application Support\/([^/]+)\/claude-code\//)?.[1] ?? null) : null;
    let accountId: string | null = null;
    const resolvedDir = configDir ? path.resolve(configDir.replace(/^~/, HOME)) : DEFAULT_DIR;
    const byDir = accounts.find((a) => path.resolve(a.configDir) === resolvedDir);
    if (configDir && byDir) accountId = byDir.id;
    else if (email) accountId = accounts.find((a) => emails[a.id] && emails[a.id]!.toLowerCase() === email.toLowerCase())?.id ?? null;
    else if (!configDir) accountId = 'default';
    out.push({ pid: p.pid, tty, cwd, configDir, email, source, accountId, profile: source === 'desktop' ? profile ?? 'Claude (default)' : null, appPath });
  }
  return out;
}

export function sameProject(a: string | null, b: string) {
  if (!a) return false;
  const A = path.resolve(a), B = path.resolve(b);
  return A === B || A.startsWith(B + '/');
}

// ---------- lock ----------

export interface Lock {
  account: string;
  project: string;
  pid: number | null;
  since: string;
  sessionId?: string | null;
}

export function pidAlive(pid: number | null | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export function readLock(): Lock | null {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function writeLock(l: Lock | null) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  if (!l) {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* already gone */
    }
    return;
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify(l, null, 2));
}

// ---------- clean environment ----------
//
// When Baton is started from inside a Claude session (desktop app, a terminal running
// claude, the Agent SDK…) it inherits that session's CLAUDE_CODE_* / ANTHROPIC_* variables,
// including an OAuth token and account id. Any `claude` child would then sign in as THAT
// account whatever CLAUDE_CONFIG_DIR says. Every spawn and every Terminal command is scrubbed.

export const SCRUB_RE = /^(CLAUDE|ANTHROPIC|CLAUDECODE|__CF)/;
const KEEP_RE = /^(CLAUDE_SWITCH_|BATON_)/; // our own switches (dry run)
/** Call once at startup: removes inherited Claude/Anthropic variables from this process. */
export function scrubOwnEnv(): string[] {
  const removed: string[] = [];
  for (const k of Object.keys(process.env)) {
    if (SCRUB_RE.test(k) && !KEEP_RE.test(k)) {
      delete process.env[k];
      removed.push(k);
    }
  }
  return removed;
}

/** process.env minus every Claude/Anthropic key, plus CLAUDE_CONFIG_DIR for extra accounts only. */
export function cleanEnv(acc: Account): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SCRUB_RE.test(k) && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  if (acc.id !== 'default') env.CLAUDE_CONFIG_DIR = acc.configDir;
  return env;
}

// ---------- launching ----------

export function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const LAUNCH_DIR = path.join(APP_DIR, 'launch');
export type LaunchOpts = { resume?: string | null; login?: boolean; continueLast?: boolean; usage?: boolean };

function claudeArgs(opts: LaunchOpts): { action: string; args: string[] } {
  if (opts.login) return { action: 'login', args: ['auth', 'login'] };
  if (opts.usage) return { action: 'usage', args: ['/usage'] };
  if (opts.resume) {
    if (!/^[0-9a-f-]{8,64}$/i.test(opts.resume)) throw new Error('Bad session id');
    return { action: 'resume', args: ['--resume', opts.resume] };
  }
  if (opts.continueLast) return { action: 'continue', args: ['--continue'] };
  return { action: 'open', args: [] };
}

/** Readable one-liner for previews and the launch log (what the script does). */
export function buildShellCommand(acc: Account, project: string, opts: LaunchOpts) {
  const { args } = claudeArgs(opts);
  const env = acc.id === 'default' ? '' : `CLAUDE_CONFIG_DIR=${shq(acc.configDir)} `;
  return `cd ${shq(project)} && ${env}claude${args.length ? ' ' + args.join(' ') : ''}`;
}

/**
 * Writes ~/.baton/launch/<account>-<action>.sh and returns the short command Terminal
 * runs. Terminal's `do script` truncates long lines, so everything lives in the script: it
 * unsets every inherited CLAUDE / ANTHROPIC variable, sets CLAUDE_CONFIG_DIR for extra
 * accounts only, cds, sets the tab title and execs claude.
 */
export function writeLaunchScript(acc: Account, project: string, opts: LaunchOpts): { script: string; command: string } {
  const { action, args } = claudeArgs(opts);
  const name = acc.name.replace(/[^\w .-]/g, '');
  const body = [
    '#!/bin/bash',
    `# Baton — ${name}: ${action}`,
    "for v in $(env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|CLAUDECODE)'); do unset \"$v\"; done",
    ...(acc.id === 'default' ? [] : [`export CLAUDE_CONFIG_DIR=${shq(acc.configDir)}`]),
    `cd ${shq(project)} || exit 1`,
    `printf '\\e]0;Claude · ${name}\\a'`,
    `exec claude${args.length ? ' ' + args.map(shq).join(' ') : ''}`,
    '',
  ].join('\n');
  fs.mkdirSync(LAUNCH_DIR, { recursive: true, mode: 0o700 });
  const script = path.join(LAUNCH_DIR, `${acc.id.replace(/[^a-z0-9-]/gi, '')}-${action}.sh`);
  fs.writeFileSync(script, body, { mode: 0o700 });
  fs.chmodSync(script, 0o700);
  return { script, command: `bash ${shq(script)}` };
}

export function appleScriptFor(shell: string) {
  const esc = shell.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `tell application "Terminal"\n  activate\n  do script "${esc}"\nend tell`;
}

export function logLaunch(line: string) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.appendFileSync(LAUNCH_LOG, `${new Date().toISOString()} ${line}\n`);
}

export async function runAppleScript(script: string) {
  return run('osascript', ['-e', script]);
}

export async function revealTerminalTab(tty: string) {
  const script = `tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty.replace(/[^\w/]/g, '')}" then
        set selected of t to true
        set index of w to 1
        return "found"
      end if
    end repeat
  end repeat
  return "missing"
end tell`;
  const { stdout } = await runAppleScript(script);
  return stdout.trim() === 'found';
}
