// Baton — real usage limits (5-hour + weekly), from OFFICIAL Claude Code outputs only.
//
// Two sources, both produced by the `claude` CLI itself (no tokens, no direct API calls):
//  1. Active probe: `claude -p "/usage" --output-format json` — the built-in /usage command
//     runs in print mode, makes NO model call (cost 0, duration_api_ms 0) and prints the plan
//     limits as text ("Current session: 7% used · resets Oct 24 at 11:40pm (America/New_York)").
//  2. Passive capture (opt-in, per account): a status-line command. Claude Code pipes JSON to it
//     on stdin, which carries `rate_limits.five_hour|seven_day.{used_percentage,resets_at}` for
//     Pro/Max subscribers after the first API response. The hook writes those to
//     ~/.baton/usage/<id>.json — free updates while you work.
//
// Never reads credentials. The passive hook's settings.json change (the `statusLine` key only) is a
// safety-engine operation with a preview, snapshot, journal and undo — see usage-hook.ts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanEnv, type Account } from './core';
import { resolveAppDir } from './roots';
import { detectSuspension, ProbeGate, type UsageTrigger } from './fairuse';
import { hookStatus, hookScript, passiveFile, usageId, type HookStatus } from './usage-hook';

export { hookStatus, hookScript, usageId, type HookStatus };

const run = promisify(execFile);
const HOME = os.homedir();
export const USAGE_DIR = path.join(resolveAppDir(HOME), 'usage');

export interface UsageWindow {
  pct: number; // 0..100
  resetsAt: number | null; // epoch ms
  resetText?: string; // as printed by /usage, when it could not be parsed
}

export interface UsageSnapshot {
  source: 'usage-command' | 'statusline';
  capturedAt: number; // epoch ms
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  extra: { label: string; pct: number; resetsAt: number | null }[]; // e.g. per-model weekly
  error?: string;
  suspended?: string | null; // clear "account suspended/disabled" wording seen in the output (fairuse.detectSuspension)
}

const probeFile = (acc: Account) => path.join(USAGE_DIR, `${usageId(acc)}.probe.json`);

// ---------- /usage text parsing ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Wall-clock time in an IANA zone → epoch ms. */
function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  if (!tz) return new Date(y, mo, d, h, mi).getTime();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(new Date(guess));
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asIfUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'));
    return guess - (asIfUtc - guess);
  } catch {
    return new Date(y, mo, d, h, mi).getTime();
  }
}

/** "Oct 24 at 11:40pm (America/New_York)", "11:40pm (America/New_York)", "Oct 29, 2026 at 7am". */
export function parseResetText(s: string, now = Date.now()): number | null {
  const m = s.match(/(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i);
  if (!m) return null;
  const tz = m[7]?.trim();
  let h = Number(m[4]);
  const mi = Number(m[5] ?? 0);
  if (m[6]) {
    const pm = m[6].toLowerCase() === 'pm';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  } else if (!m[5]) return null; // a bare number is not a time
  // today's date in that zone
  const today = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(now));
  const tg = (t: string) => Number(today.find((p) => p.type === t)?.value);
  let y = m[3] ? Number(m[3]) : tg('year');
  let mo = tg('month') - 1;
  let d = tg('day');
  if (m[1]) {
    const idx = MONTHS.indexOf(m[1].toLowerCase());
    if (idx < 0) return null;
    mo = idx;
    d = Number(m[2]);
  }
  let t = zonedToEpoch(y, mo, d, h, mi, tz);
  if (!m[3] && t < now - 36e5) {
    // no year given and it is in the past → it means the next occurrence
    t = m[1] ? zonedToEpoch(y + 1, mo, d, h, mi, tz) : t + 864e5;
  }
  return Number.isFinite(t) ? t : null;
}

export function parseUsageText(text: string, now = Date.now()): Omit<UsageSnapshot, 'source' | 'capturedAt'> {
  let fiveHour: UsageWindow | null = null;
  let sevenDay: UsageWindow | null = null;
  const extra: UsageSnapshot['extra'] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^(Current [^:]+):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets?\s+(.+))?$/i);
    if (!m) continue;
    const label = m[1];
    const pct = Number(m[2]);
    const resetsAt = m[3] ? parseResetText(m[3], now) : null;
    const w: UsageWindow = { pct, resetsAt, ...(m[3] && resetsAt == null ? { resetText: m[3] } : {}) };
    if (/session/i.test(label)) fiveHour = w;
    else if (/week/i.test(label) && (/all models/i.test(label) || !/\(/.test(label))) sevenDay = w;
    else extra.push({ label: label.replace(/^Current\s+/i, ''), pct, resetsAt });
  }
  return { fiveHour, sevenDay, extra };
}

// ---------- active probe ----------

let claudeBinCache: string | null = null;
export async function findClaude(): Promise<string> {
  if (claudeBinCache && fs.existsSync(claudeBinCache)) return claudeBinCache;
  for (const p of [path.join(HOME, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (fs.existsSync(p)) return (claudeBinCache = p);
  }
  const { stdout } = await run('/bin/zsh', ['-lc', 'command -v claude']);
  const p = stdout.trim();
  if (!p) throw new Error('claude not found on PATH');
  return (claudeBinCache = p);
}

const inflight = new Map<string, Promise<UsageSnapshot>>();
/** THE gate in front of every /usage spawn: app open or explicit Refresh only, at most once per 15 min per account. */
export const usageGate = new ProbeGate();

export type ProbeResult = UsageSnapshot & { throttled?: { nextAt: number; reason: string } };

/**
 * ONE `claude -p "/usage"` call for this account. /usage is a local built-in command: it makes
 * no model request (the JSON result reports total_cost_usd 0 and duration_api_ms 0).
 * Never polled: callers pass why they check, and the gate refuses anything within 15 minutes of the last check.
 */
export function probeUsage(acc: Account, trigger: UsageTrigger): Promise<ProbeResult> {
  const id = usageId(acc);
  const existing = inflight.get(id);
  if (existing) return existing;
  const persisted = (readJson(probeFile(acc)) as UsageSnapshot | null)?.capturedAt ?? null;
  const g = usageGate.check(id, trigger, Date.now(), persisted);
  if (!g.ok) {
    const cached = readJson(probeFile(acc)) as UsageSnapshot | null;
    return Promise.resolve({ ...(cached ?? { source: 'usage-command' as const, capturedAt: persisted ?? 0, fiveHour: null, sevenDay: null, extra: [] }), throttled: { nextAt: g.nextAt, reason: g.reason } });
  }
  usageGate.mark(id);
  const p = (async () => {
    const bin = await findClaude();
    const env = cleanEnv(acc);
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    const capturedAt = Date.now();
    let snap: UsageSnapshot;
    try {
      const { stdout } = await run(bin, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'], {
        cwd: USAGE_DIR,
        env,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const j = JSON.parse(stdout);
      const text: string = typeof j.result === 'string' ? j.result : '';
      const parsed = parseUsageText(text, capturedAt);
      const error =
        j.is_error || (!parsed.fiveHour && !parsed.sevenDay)
          ? /api usage|api key|subscription/i.test(text) && !/subscription to power/i.test(text)
            ? 'No plan limits for this sign-in (API key / not a Pro or Max plan)'
            : text.split('\n').find((l) => l.trim())?.slice(0, 160) || 'Could not read limits from /usage'
          : undefined;
      const suspended = error ? detectSuspension(text) : null;
      snap = { source: 'usage-command', capturedAt, ...parsed, ...(error ? { error } : {}), ...(suspended ? { suspended } : {}) };
    } catch (e: any) {
      const suspended = detectSuspension([e?.stdout, e?.stderr, e?.message].filter((x) => typeof x === 'string').join('\n'));
      snap = { source: 'usage-command', capturedAt, fiveHour: null, sevenDay: null, extra: [], error: suspended ?? String(e?.message ?? e).split('\n')[0].slice(0, 200), ...(suspended ? { suspended } : {}) };
    }
    writeJson(probeFile(acc), snap);
    return snap;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

export const probing = (acc: Account) => inflight.has(usageId(acc));

// ---------- cached reads ----------

function writeJson(file: string, v: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function fromStatusLine(j: any): UsageSnapshot | null {
  const rl = j?.rate_limits;
  if (!rl || typeof j.capturedAt !== 'number') return null;
  const w = (o: any): UsageWindow | null =>
    o && typeof o.used_percentage === 'number' ? { pct: o.used_percentage, resetsAt: typeof o.resets_at === 'number' ? o.resets_at * 1000 : null } : null;
  return { source: 'statusline', capturedAt: j.capturedAt * 1000, fiveHour: w(rl.five_hour), sevenDay: w(rl.seven_day), extra: [] };
}

/** A window whose reset time has passed is back to 0%. */
function settle(w: UsageWindow | null, now: number): UsageWindow | null {
  if (!w) return null;
  if (w.resetsAt && w.resetsAt <= now) return { pct: 0, resetsAt: null };
  return w;
}

/** Freshest of the probe cache and the passive status-line capture. Zero cost. */
export function readUsage(acc: Account, now = Date.now()): (UsageSnapshot & { probeAt: number | null; passiveAt: number | null }) | null {
  const probe = readJson(probeFile(acc)) as UsageSnapshot | null;
  const passive = fromStatusLine(readJson(passiveFile(acc)));
  const good = [probe, passive].filter((s): s is UsageSnapshot => !!s && !s.error && !!(s.fiveHour || s.sevenDay));
  good.sort((a, b) => b.capturedAt - a.capturedAt);
  const best = good[0] ?? probe ?? passive;
  if (!best) return null;
  // the probe also knows per-model weekly limits; keep them when the passive copy is newer
  const extra = best.extra?.length ? best.extra : probe?.extra ?? [];
  return {
    ...best,
    fiveHour: settle(best.fiveHour, now),
    sevenDay: settle(best.sevenDay, now),
    extra,
    probeAt: probe?.capturedAt ?? null,
    passiveAt: passive?.capturedAt ?? null,
  };
}

// ---------- passive status-line hook ----------
// Turning it on/off is a safety-engine operation (usage-hook-on / usage-hook-off): see usage-hook.ts.

// ---------- auth check ----------

export interface AuthCheck {
  checkedAt: number;
  loggedIn: boolean;
  email: string | null;
  orgName: string | null;
  subscription: string | null;
  error?: string;
  suspended?: string | null;
  // from Claude Code's own usage cache in .claude.json (account id + when the server was asked)
  usageAccountTail: string | null;
  usageFetchedAt: number | null;
}

const authCache = new Map<string, AuthCheck>();
const authInflight = new Map<string, Promise<AuthCheck>>();

function claudeJsonFor(acc: Account): string[] {
  return acc.id === 'default' ? [path.join(HOME, '.claude.json'), path.join(HOME, '.claude', '.claude.json')] : [path.join(acc.configDir, '.claude.json')];
}

/** Reads ONLY cachedUsageUtilization.{accountUuid,fetchedAtMs} — nothing else is kept. */
function usageCacheMeta(acc: Account): { tail: string | null; fetchedAt: number | null } {
  for (const f of claudeJsonFor(acc)) {
    const j = readJson(f);
    const c = j?.cachedUsageUtilization;
    if (c && typeof c === 'object') {
      const id = typeof c.accountUuid === 'string' ? c.accountUuid : null;
      return { tail: id ? id.slice(-4) : null, fetchedAt: typeof c.fetchedAtMs === 'number' ? c.fetchedAtMs : null };
    }
    if (j) break;
  }
  return { tail: null, fetchedAt: null };
}

/** `claude auth status` with a clean env: who does this config dir ACTUALLY sign in as. */
export function checkAuth(acc: Account): Promise<AuthCheck> {
  const id = usageId(acc);
  const existing = authInflight.get(id);
  if (existing) return existing;
  const p = (async () => {
    const bin = await findClaude();
    let r: AuthCheck;
    try {
      // exits 1 when signed out, but still prints the JSON status on stdout
      const stdout: string = await run(bin, ['auth', 'status'], { cwd: HOME, env: cleanEnv(acc), timeout: 30_000, maxBuffer: 1024 * 1024 })
        .then((r) => r.stdout)
        .catch((e: any) => {
          if (typeof e?.stdout === 'string' && e.stdout.includes('"loggedIn"')) return e.stdout;
          const sus = detectSuspension([e?.stdout, e?.stderr].filter((x) => typeof x === 'string').join('\n'));
          if (sus) throw Object.assign(new Error(sus), { suspended: sus });
          throw e;
        });
      const j = JSON.parse(stdout.slice(stdout.indexOf('{')));
      const m = usageCacheMeta(acc);
      r = {
        checkedAt: Date.now(),
        loggedIn: !!j.loggedIn,
        email: typeof j.email === 'string' ? j.email : null,
        orgName: typeof j.orgName === 'string' ? j.orgName : null,
        subscription: typeof j.subscriptionType === 'string' ? j.subscriptionType : null,
        usageAccountTail: m.tail,
        usageFetchedAt: m.fetchedAt,
      };
    } catch (e: any) {
      const m = usageCacheMeta(acc);
      r = { checkedAt: Date.now(), loggedIn: false, email: null, orgName: null, subscription: null, error: String(e?.message ?? e).split('\n')[0].slice(0, 160), ...(e?.suspended ? { suspended: e.suspended } : {}), usageAccountTail: m.tail, usageFetchedAt: m.fetchedAt };
    }
    authCache.set(id, r);
    return r;
  })().finally(() => authInflight.delete(id));
  authInflight.set(id, p);
  return p;
}

export function cachedAuth(acc: Account): AuthCheck | null {
  const a = authCache.get(usageId(acc));
  if (!a) return null;
  const m = usageCacheMeta(acc); // cheap re-read so a newer /usage fetch shows up
  return { ...a, usageAccountTail: m.tail ?? a.usageAccountTail, usageFetchedAt: m.fetchedAt ?? a.usageFetchedAt };
}
