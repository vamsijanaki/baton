// Baton — fair-use guardrails (no Electron imports, so the test suite can run it in a fake HOME).
//
// Baton is for ONE person using their OWN Claude accounts. Grounded in Anthropic's official pages
// (Usage Policy, Consumer Terms, Claude Code legal & compliance). This module holds the rules; the
// UI explains them and main/ops-ipc enforce them:
//   * account kind: Personal (Free/Pro/Max) or Work/Team/Enterprise (organization-provided)
//     — auto-detected from NON-SECRET fields only, else asked;
//   * an ownership attestation for every account ("This account is mine, and only I use it.");
//   * a second (or later) Personal account needs an explicit "not to get around usage limits" tick;
//   * a Suspended account's projects are never offered for continuing in another account;
//   * usage checks are rate-limited (at most once per 15 minutes per account, never polled);
//   * sharing notices when chats move into or out of a Work account.
// Never reads tokens, credentials or the Keychain: .claude.json is parsed and only the allow-listed
// oauthAccount keys below are copied out — everything else is dropped immediately.

import fs from 'node:fs';
import path from 'node:path';
import { roots } from './roots';

export type AccountKind = 'personal' | 'work';
export type KindSource = 'detected' | 'user';

/** The fair-use fields Baton keeps per account (in state.json, next to name/color). */
export interface FairUseFields {
  kind?: AccountKind;
  kindSource?: KindSource;
  kindHint?: string; // what detection saw, e.g. "subscription: max"
  attestedAt?: string; // ISO — "This account is mine, and only I use it."
  limitsAckAt?: string; // ISO — "I'm not using this to get around usage limits." (2nd+ Personal account)
  suspended?: { at: string; reason: string } | null;
}
export interface FairUseAccount extends FairUseFields {
  id: string;
  name: string;
  configDir: string;
}

export const LINKS = {
  aup: 'https://www.anthropic.com/legal/aup',
  consumerTerms: 'https://www.anthropic.com/legal/consumer-terms',
  claudeCodeLegal: 'https://code.claude.com/docs/en/legal-and-compliance',
  support: 'https://support.anthropic.com',
} as const;

// ---------- 1. account kind (detected from non-secret config) ----------

/** The ONLY oauthAccount keys Baton ever looks at for kind detection. No token/credential field is in here. */
export const KIND_HINT_KEYS = ['organizationType', 'billingType', 'organizationRole', 'workspaceRole'] as const;
export type KindHints = Partial<Record<(typeof KIND_HINT_KEYS)[number] | 'subscriptionType', string>>;

function claudeJsonFiles(acc: Pick<FairUseAccount, 'id' | 'configDir'>): string[] {
  const home = roots().home;
  return acc.id === 'default' ? [path.join(home, '.claude.json'), path.join(home, '.claude', '.claude.json')] : [path.join(acc.configDir, '.claude.json')];
}

/** Reads allow-listed, non-secret oauthAccount fields from the account's .claude.json. */
export function readKindHints(acc: Pick<FairUseAccount, 'id' | 'configDir'>): KindHints {
  for (const f of claudeJsonFiles(acc)) {
    let o: any;
    try {
      o = JSON.parse(fs.readFileSync(f, 'utf8'))?.oauthAccount;
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const out: KindHints = {};
    for (const k of KIND_HINT_KEYS) if (typeof o[k] === 'string' && o[k]) out[k] = o[k].slice(0, 60);
    return out;
  }
  return {};
}

const word = (s: string, w: string) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(s);

/**
 * Personal vs Work from plan/organization type strings ("claude_max", "team", "enterprise", …).
 * Returns null when nothing clearly says which — Baton then asks. Roles (admin/member) are never enough
 * on their own: a personal plan is also an "organization" whose owner is "admin".
 */
export function kindFromHints(h: KindHints): { kind: AccountKind; hint: string } | null {
  const fields = (['subscriptionType', 'organizationType', 'billingType'] as const).filter((k) => h[k]);
  for (const k of fields) {
    const v = h[k]!.toLowerCase();
    const label = `${k === 'subscriptionType' ? 'subscription' : k === 'organizationType' ? 'organization type' : 'billing'}: ${h[k]}`;
    if (word(v, 'enterprise') || word(v, 'team') || word(v, 'teams')) return { kind: 'work', hint: label };
    if (word(v, 'pro') || word(v, 'max') || word(v, 'free') || word(v, 'personal') || word(v, 'individual')) return { kind: 'personal', hint: label };
  }
  return null;
}

/** subscriptionType comes from `claude auth status` (the official CLI's own non-secret JSON). */
export function detectKind(acc: Pick<FairUseAccount, 'id' | 'configDir'>, subscriptionType?: string | null) {
  const h = readKindHints(acc);
  if (subscriptionType) h.subscriptionType = subscriptionType;
  return kindFromHints(h);
}

/** Applies a confident detection. Returns true when the account changed. */
export function reconcileKind(acc: FairUseAccount, detected: { kind: AccountKind; hint: string } | null): boolean {
  if (!detected) return false;
  if (acc.kind === detected.kind && acc.kindSource === 'detected' && acc.kindHint === detected.hint) return false;
  acc.kind = detected.kind;
  acc.kindSource = 'detected';
  acc.kindHint = detected.hint;
  return true;
}

// ---------- 2 + 3. attestation and the second Personal plan ----------

/** A Personal account added after another Personal account needs the limits tick. Account order = order added. */
export function needsLimitsAck(accounts: FairUseAccount[], acc: FairUseAccount, kind: AccountKind | undefined = acc.kind): boolean {
  if (kind !== 'personal') return false;
  const idx = accounts.findIndex((a) => a.id === acc.id);
  const before = idx < 0 ? accounts : accounts.slice(0, idx);
  return before.some((a) => a.kind === 'personal');
}

export type FairUseProblem = { code: 'attest' | 'kind' | 'limits'; message: string };

/** What still has to be confirmed before Baton opens claude for this account (null = nothing). */
export function fairUseProblem(accounts: FairUseAccount[], acc: FairUseAccount): FairUseProblem | null {
  if (!acc.attestedAt) return { code: 'attest', message: `Confirm that ${acc.name} is your own account and that only you use it.` };
  if (!acc.kind) return { code: 'kind', message: `Tell Baton whether ${acc.name} is a Personal or a Work/Team/Enterprise account.` };
  if (needsLimitsAck(accounts, acc) && !acc.limitsAckAt)
    return { code: 'limits', message: `${acc.name} is a second Personal plan. Confirm you're not using it to get around usage limits.` };
  return null;
}

export interface AttestInput {
  kind?: AccountKind | null;
  attested?: boolean;
  notLimitDodging?: boolean;
}

/** Validates an add/confirm request. Throws with a plain-language reason. */
export function validateAttest(accounts: FairUseAccount[], acc: FairUseAccount, input: AttestInput) {
  if (input.attested !== true) throw new Error('Tick "This account is mine, and only I use it." to continue — Baton is for one person using their own accounts.');
  const kind = acc.kindSource === 'detected' && acc.kind ? acc.kind : input.kind ?? acc.kind;
  if (kind !== 'personal' && kind !== 'work') throw new Error('Choose whether this is a Personal or a Work/Team/Enterprise account.');
  if (needsLimitsAck(accounts, acc, kind) && input.notLimitDodging !== true && !acc.limitsAckAt)
    throw new Error('This is a second Personal plan. Tick "I\'m not using this to get around usage limits" to continue — rotating personal plans past their limits may be treated as circumventing restrictions.');
  return kind;
}

/** Validates and records the attestation (timestamps) on the account. */
export function applyAttest(accounts: FairUseAccount[], acc: FairUseAccount, input: AttestInput, now = new Date()) {
  const kind = validateAttest(accounts, acc, input);
  if (acc.kindSource !== 'detected') {
    acc.kind = kind;
    acc.kindSource = 'user';
  }
  acc.attestedAt = now.toISOString();
  if (needsLimitsAck(accounts, acc) && input.notLimitDodging === true) acc.limitsAckAt = now.toISOString();
  return acc;
}

// ---------- 6. suspended accounts ----------

/**
 * Conservative: only clear wording that THIS account (or its organization) was suspended, disabled or banned.
 * Expired sign-ins, invalid keys, rate limits, network errors and "will be suspended if…" never match.
 */
const SUSPENDED = [
  /\b(your |this )?account (has been|was|is|is currently|got) (permanently |temporarily )?(suspended|banned|disabled|deactivated|terminated)\b/i,
  /\b(your |this )?organization (has been|was|is) (suspended|banned|disabled|deactivated)\b/i,
  /\baccount[_ ](suspended|banned|disabled)\b/i,
  /\bsuspended (your|this) account\b/i,
];
const NOT_SUSPENDED = /\b(will|may|could|might) be (suspended|banned|disabled)|\bif\b[^.]{0,60}\b(suspended|banned|disabled)|\bnot (been )?(suspended|banned|disabled)|\b(re-?enabled|reinstated|unsuspended)\b/i;

export function detectSuspension(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.trim();
    if (!l || NOT_SUSPENDED.test(l)) continue;
    if (SUSPENDED.some((re) => re.test(l))) return l.slice(0, 200);
  }
  return null;
}

/** Marks/clears Suspended from one usage/auth result. Returns true when the account changed. */
export function applySuspension(acc: FairUseAccount, r: { suspended?: string | null; ok?: boolean }, now = new Date()): boolean {
  if (r.suspended) {
    if (acc.suspended?.reason === r.suspended) return false;
    acc.suspended = { at: now.toISOString(), reason: r.suspended };
    return true;
  }
  if (r.ok && acc.suspended) {
    acc.suspended = null; // a later check read real plan limits: the account works again
    return true;
  }
  return false;
}

export const SUSPENDED_EXPLANATION =
  "Using a different account to keep working after an account is suspended or banned violates Anthropic's Usage Policy, so Baton won't offer it. If you think this is a mistake, contact Anthropic support to appeal.";

/**
 * Suspended accounts (other than `targetId`) that have worked on `project` — recorded launches, or a sharing
 * entry for it. Account 1 holds the shared store, so when it is suspended every shared project counts as its.
 */
export function suspendedOwners(
  project: string,
  targetId: string,
  accounts: FairUseAccount[],
  projectUse: Record<string, string[]> = {},
  shared: { path: string; accounts: string[] }[] = [],
): FairUseAccount[] {
  const used = new Set(projectUse[project] ?? []);
  const sp = shared.find((s) => s.path === project);
  for (const id of sp?.accounts ?? []) used.add(id);
  if (sp) used.add('default');
  return accounts.filter((a) => a.id !== targetId && a.suspended && used.has(a.id));
}

export function continueBlock(project: string, targetId: string, accounts: FairUseAccount[], projectUse?: Record<string, string[]>, shared?: { path: string; accounts: string[] }[]) {
  const owners = suspendedOwners(project, targetId, accounts, projectUse, shared);
  if (!owners.length) return null;
  const names = owners.map((o) => o.name).join(', ');
  return { owners: owners.map((o) => o.id), message: `${names} is suspended. ${SUSPENDED_EXPLANATION}`, support: LINKS.support };
}

export function recordProjectUse(projectUse: Record<string, string[]>, project: string, accountId: string) {
  const cur = projectUse[project] ?? [];
  if (!cur.includes(accountId)) projectUse[project] = [...cur, accountId];
  return projectUse;
}

// ---------- 5. sharing notices ----------

/**
 * Notices for a sharing change on one project. `before`/`after` are the terminal accounts with access; Account 1
 * (the store) always has access. Only accounts being ADDED get notices.
 */
export function shareNotices(accounts: FairUseAccount[], before: string[], after: string[]): string[] {
  const by = (id: string) => accounts.find((a) => a.id === id);
  const added = after.filter((id) => !before.includes(id)).map(by).filter((a): a is FairUseAccount => !!a);
  const sources = ['default', ...before].map(by).filter((a): a is FairUseAccount => !!a);
  const out: string[] = [];
  const work = added.filter((a) => a.kind === 'work');
  if (work.length) out.push(`Your organization's admin may be able to see these chats (${work.map((a) => a.name).join(', ')} is a Work account).`);
  const personal = added.filter((a) => a.kind === 'personal');
  const workSources = sources.filter((a) => a.kind === 'work');
  if (personal.length && workSources.length)
    out.push(
      `This may move your employer's code/data into a personal account (${workSources.map((a) => a.name).join(', ')} → ${personal.map((a) => a.name).join(', ')}) — check your company's policy.`,
    );
  return out;
}

// ---------- 7. usage checks: never polled, at most once per 15 minutes per account ----------

export const USAGE_MIN_INTERVAL_MS = 15 * 60_000;
export type UsageTrigger = 'app-open' | 'refresh';

/** Remembers the last probe per account; `persisted` is the last probe time read from disk (survives restarts). */
export class ProbeGate {
  private last = new Map<string, number>();
  constructor(private minMs = USAGE_MIN_INTERVAL_MS) {}
  check(id: string, trigger: UsageTrigger, now = Date.now(), persisted: number | null = null): { ok: true } | { ok: false; nextAt: number; reason: string } {
    if (trigger !== 'app-open' && trigger !== 'refresh') return { ok: false, nextAt: Infinity, reason: 'usage is only checked when Baton opens or when you press Refresh' };
    const last = Math.max(this.last.get(id) ?? 0, persisted ?? 0);
    if (last && now - last < this.minMs) return { ok: false, nextAt: last + this.minMs, reason: 'checked less than 15 minutes ago' };
    return { ok: true };
  }
  mark(id: string, now = Date.now()) {
    this.last.set(id, now);
  }
}

// ---------- the launch gate (main window, native tray menu and tray popover all go through it) ----------

/**
 * Everything that must hold before Baton opens claude for `acc` on `project`: the account is confirmed
 * (ownership, kind, the second-Personal-plan tick) and no suspended account has worked on the project.
 * Returns null when the launch may go ahead.
 */
export function launchGate(
  accounts: FairUseAccount[],
  acc: FairUseAccount,
  project: string,
  projectUse?: Record<string, string[]>,
  shared?: { path: string; accounts: string[] }[],
) {
  const problem = fairUseProblem(accounts, acc);
  if (problem) return { status: 'fairuse' as const, accountId: acc.id, problem };
  const blocked = continueBlock(project, acc.id, accounts, projectUse, shared);
  if (blocked) return { status: 'suspended' as const, accountId: acc.id, ...blocked };
  return null;
}
