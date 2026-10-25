// Baton — ONE concept: an account is an email.
//
// Each account card pairs the account's Terminal side (its config folder) with the desktop app(s) signed in as the
// same account. A desktop app's account comes from its own data (config.json lastKnownAccountUuid, else its only
// Code-tab index account); the uuid → email map comes from the Terminal accounts' .claude.json.
//
// Also here:
//  * duplicates: two or more desktop apps signed in as the same email → "Merge & tidy up": copy any Code-tab
//    sidebar entries the kept app is missing (copy-only, never overwrite; same account, so the
//    <accountUuid>/<orgUuid> folders are identical — no conversion), then remove only the extra app's launcher.
//    Its data folder goes to the Trash only when the user ticks that explicitly.
//  * "same account = same chat list": the sync engine keeps every app of one account showing the same sidebar.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appCopySteps, readRegistry, type DesktopProfile } from './desktop';
import { desktopRegistry, readOnly, roots, settingsFile, syncStateFile } from './roots';
import { readStable, planSync, readSyncState, syncOperation, type SyncContext, type SharingConfig } from './sharing';
import { readSettings, type Operation, type Step } from './safety';

export interface TerminalIdentity {
  id: string;
  name: string;
  color: string;
  configDir: string;
  email: string | null;
  accountUuid: string | null;
  signedIn: boolean;
  isDefault: boolean;
}
export interface AppInfo {
  id: string;
  name: string;
  dataDir: string;
  isDefault: boolean;
  running: boolean;
  signedIn: boolean;
  sessions: number; // chats in this app's own account lists (leftovers not counted)
  color: string;
  needsUpdate: boolean;
  cloneVersion: string | null;
  cloneSource: DesktopProfile['cloneSource'];
  origin: DesktopProfile['origin'];
  accountUuid: string | null;
}
export interface AccountCard {
  key: string; // terminal account id, or "desktop:<accountUuid>" for a desktop-only account
  name: string;
  email: string | null;
  accountUuid: string | null;
  color: string;
  terminal: { id: string; configDir: string; signedIn: boolean; isDefault: boolean } | null;
  apps: AppInfo[]; // the kept (main) app first
  kept: string | null;
  extras: string[]; // more apps signed in as the same account
  waiting: AppInfo[]; // made for this account, first sign-in still to do
}
export interface Leftover {
  key: string; // "<profile>/<acct>/<org>"
  profile: string;
  profileName: string;
  accountUuid: string;
  email: string | null;
  sessions: number;
}
export interface Overview {
  accounts: AccountCard[];
  unpaired: AppInfo[]; // desktop apps not signed in yet (and not made for a known account)
  leftovers: Leftover[];
  retired: (AppInfo & { into: string; at: string })[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const ownSessions = (p: DesktopProfile) => p.folders.filter((f) => f.accountUuid === p.accountUuid).reduce((n, f) => n + f.sessions, 0);

export function appInfo(p: DesktopProfile): AppInfo {
  return {
    id: p.id,
    name: p.name,
    dataDir: p.dataDir,
    isDefault: p.id === 'Claude',
    running: p.running,
    signedIn: p.signedIn,
    sessions: ownSessions(p),
    color: p.color,
    needsUpdate: p.needsUpdate,
    cloneVersion: p.cloneVersion,
    cloneSource: p.cloneSource,
    origin: p.origin,
    accountUuid: p.accountUuid,
  };
}

/**
 * Which of an account's apps to keep when tidying up: the default Claude app, else the one named after the
 * account ("Claude Client" for CLIENT), else the one with the most chats, else the oldest name.
 */
export function pickKept(apps: DesktopProfile[], accountName: string): DesktopProfile | null {
  if (!apps.length) return null;
  const n = norm(accountName);
  const score = (p: DesktopProfile) => [p.id === 'Claude' ? 1 : 0, n && norm(p.name).includes(n) ? 1 : 0, ownSessions(p), p.origin === 'claude-switch' ? 1 : 0];
  return [...apps].sort((a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return a.id.localeCompare(b.id);
  })[0];
}

/** Pairs Terminal accounts and desktop apps by account (uuid, else email). */
export function buildOverview(terms: TerminalIdentity[], profiles: DesktopProfile[], emailByUuid: Record<string, string> = {}): Overview {
  const live = profiles.filter((p) => !p.retired);
  const used = new Set<string>();
  const cards: AccountCard[] = [];
  const sameAcct = (t: { accountUuid: string | null; email: string | null }, p: DesktopProfile) =>
    (!!t.accountUuid && p.accountUuid === t.accountUuid) || (!!t.email && !!p.email && p.email.toLowerCase() === t.email.toLowerCase());
  const card = (key: string, name: string, email: string | null, uuid: string | null, color: string, terminal: AccountCard['terminal'], apps: DesktopProfile[], waiting: DesktopProfile[]): AccountCard => {
    const kept = pickKept(apps, name);
    const ordered = kept ? [kept, ...apps.filter((a) => a !== kept)] : apps;
    for (const a of [...apps, ...waiting]) used.add(a.id);
    return { key, name, email, accountUuid: uuid, color, terminal, apps: ordered.map(appInfo), kept: kept?.id ?? null, extras: ordered.slice(1).map((a) => a.id), waiting: waiting.map(appInfo) };
  };
  for (const t of terms) {
    const apps = live.filter((p) => p.signedIn && sameAcct(t, p));
    const waiting = live.filter((p) => !p.accountUuid && !p.running && p.forAccount === t.id && !apps.includes(p));
    cards.push(card(t.id, t.name, t.email, t.accountUuid, t.color, { id: t.id, configDir: t.configDir, signedIn: t.signedIn, isDefault: t.isDefault }, apps, waiting));
  }
  // desktop-only accounts (signed in to an app, no Terminal account for that email yet)
  const byUuid = new Map<string, DesktopProfile[]>();
  for (const p of live) if (!used.has(p.id) && p.accountUuid) byUuid.set(p.accountUuid, [...(byUuid.get(p.accountUuid) ?? []), p]);
  for (const [uuid, apps] of byUuid) {
    const email = emailByUuid[uuid] ?? null;
    cards.push(card(`desktop:${uuid}`, email ?? apps[0].name, email, uuid, '#8a8a8a', null, apps, []));
  }
  const leftovers: Leftover[] = [];
  for (const p of live)
    for (const f of p.folders)
      if (f.accountUuid !== p.accountUuid && p.accountUuid)
        leftovers.push({ key: `${p.id}/${f.rel}`, profile: p.id, profileName: p.name, accountUuid: f.accountUuid, email: f.email ?? emailByUuid[f.accountUuid] ?? null, sessions: f.sessions });
  return {
    accounts: cards,
    unpaired: live.filter((p) => !used.has(p.id)).map(appInfo),
    leftovers,
    retired: profiles.filter((p) => p.retired).map((p) => ({ ...appInfo(p), into: p.retired!.into, at: p.retired!.at })),
  };
}

/** Owners for the sync engine: which account each desktop app is signed in as now. */
export function syncContext(profiles: DesktopProfile[], terms: TerminalIdentity[], sameAccount = readSettings().sameAccountSync): SyncContext {
  return {
    owners: profiles.map((p) => ({ profile: p.id, accountUuid: p.accountUuid, retired: !!p.retired })),
    accountUuids: Object.fromEntries(terms.map((t) => [t.id, t.accountUuid])),
    sameAccount,
  };
}

// ---------- merge & tidy up ----------

export interface MergeSummary {
  email: string | null;
  keep: { id: string; name: string; sessions: number };
  remove: { id: string; name: string; sessions: number; copies: number; alreadyThere: number; dataDir: string }[];
  copies: number;
  alreadyThere: number;
  trashData: boolean;
}

/**
 * Keeps `keep`, folds `remove` into it: copies sidebar entries `keep` does not have yet (new files only), then removes
 * each extra app's launcher (its app copy in Baton's own apps folders). Data folders are kept unless `trashData` (→ macOS Trash).
 * Every app involved must be quit (checked by the engine via busyPaths, nothing written while one runs).
 */
export function planMergeApps(keep: DesktopProfile, remove: DesktopProfile[], trashData: boolean, email: string | null = keep.email): { op: Operation; summary: MergeSummary; staging: string } {
  if (!keep.accountUuid) throw new Error(`${keep.name} is not signed in — nothing to merge into.`);
  if (!remove.length) throw new Error('No extra desktop apps to merge.');
  for (const r of remove) {
    if (r.id === keep.id) throw new Error('The kept app cannot also be removed.');
    if (r.id === 'Claude') throw new Error('The default Claude app is never removed.');
    if (r.accountUuid !== keep.accountUuid) throw new Error(`${r.name} is signed in as a different account — only apps of the same account can be merged.`);
    if (r.retired) throw new Error(`${r.name} was already tidied up.`);
  }
  const staging = path.join(roots().appDir, 'work', `merge-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`);
  const steps: Step[] = [];
  const touches: string[] = [];
  const notes: string[] = [];
  const planned = new Set<string>();
  const summary: MergeSummary = { email, keep: { id: keep.id, name: keep.name, sessions: ownSessions(keep) }, remove: [], copies: 0, alreadyThere: 0, trashData };
  const keepRoot = path.join(keep.dataDir, 'claude-code-sessions');
  for (const r of remove) {
    const row = { id: r.id, name: r.name, sessions: ownSessions(r), copies: 0, alreadyThere: 0, dataDir: r.dataDir };
    for (const f of r.folders.filter((x) => x.accountUuid === keep.accountUuid)) {
      if (f.linked) {
        notes.push(`${r.name}: ${f.rel} is still an old whole-folder link — skipped (Doctor › migration converts it).`);
        continue;
      }
      const src = path.join(r.dataDir, 'claude-code-sessions', f.rel);
      const dstDir = path.join(keepRoot, f.rel); // same account → same <accountUuid>/<orgUuid> folder, no conversion
      let names: string[] = [];
      try {
        names = fs.readdirSync(src).filter((n) => /^local_.*\.json$/.test(n));
      } catch {
        continue;
      }
      for (const n of names) {
        const dst = path.join(dstDir, n);
        if (fs.existsSync(dst) || planned.has(dst)) {
          row.alreadyThere++;
          continue; // never overwrite
        }
        const st = readStable(path.join(src, n));
        if (!st) {
          notes.push(`${r.name}: ${n} could not be read cleanly — skipped (it stays in that app's data folder).`);
          continue;
        }
        if (!fs.existsSync(dstDir) && !steps.some((s) => s.t === 'mkdir' && s.path === dstDir)) steps.push({ t: 'mkdir', path: dstDir }), touches.push(dstDir);
        let from = path.join(src, n);
        if (!readOnly()) {
          // staged: the source may go to the Trash later in this same operation
          from = path.join(staging, `${crypto.randomBytes(4).toString('hex')}-${n}`);
          fs.mkdirSync(staging, { recursive: true });
          fs.writeFileSync(from, st.buf);
        }
        steps.push({ t: 'write', path: dst, from, mtimeMs: st.mtimeMs });
        touches.push(dst);
        planned.add(dst);
        row.copies++;
      }
    }
    summary.copies += row.copies;
    summary.alreadyThere += row.alreadyThere;
    summary.remove.push(row);
  }
  const reg = readRegistry();
  const at = new Date().toISOString();
  for (const r of remove) {
    const c = appCopySteps(r);
    steps.push(...c.steps);
    touches.push(...c.touches);
    if (trashData) {
      steps.push({ t: 'trash', path: r.dataDir });
      delete reg[r.id];
    } else reg[r.id] = { ...(reg[r.id] ?? { origin: 'other', autoLink: false, addedAt: at }), retired: { into: keep.id, at } };
  }
  steps.push({ t: 'write', path: desktopRegistry(), data: JSON.stringify(reg, null, 2) });
  touches.push(desktopRegistry());
  const names = remove.map((r) => r.name).join(', ');
  notes.unshift(
    summary.copies
      ? `${summary.copies} chat(s) from ${names} are added to ${keep.name}'s sidebar (new entries only — nothing in ${keep.name} is overwritten).`
      : `${keep.name} already lists every chat ${names} has — nothing to copy.`,
    trashData
      ? `${names}: app copy removed and data folder moved to the macOS Trash (Finder › Put Back restores it).`
      : `${names}: only the app copy is removed. The data folder stays where it is (listed under Accounts › Advanced).`,
    'Chats themselves live in ~/.claude/projects and are not touched. Sign-ins are never copied.',
  );
  return {
    op: {
      kind: 'merge-apps',
      title: `Merge ${names} into ${keep.name}`,
      steps,
      touches,
      notes,
      busyPaths: [keep.dataDir, ...remove.map((r) => r.dataDir)],
    },
    summary,
    staging,
  };
}

// ---------- same account = same chat list ----------

/** The previewed operation that turns the option on for an existing setup: first sync between each account's apps + the setting. */
export function planSameAccountOn(ctx: SyncContext, runningProfiles: Set<string>): { op: Operation; staging: string; copies: number; deferred: number } {
  const empty: SharingConfig = { version: 1, projects: [] };
  const p = planSync(empty, readSyncState(), runningProfiles, undefined, { ...ctx, sameAccount: true });
  const base = syncOperation(p, 'Same account, same chat list');
  const settings = { ...readSettings(), sameAccountSync: true };
  return {
    op: {
      ...base,
      kind: 'same-account-sync',
      title: `Same account = same chat list${p.copies ? ` (${p.copies} sidebar entr${p.copies === 1 ? 'y' : 'ies'} to copy)` : ''}`,
      category: 'op',
      steps: [...base.steps, { t: 'write', path: settingsFile(), data: JSON.stringify(settings, null, 2) }],
      touches: [...base.touches, settingsFile(), syncStateFile()],
      notes: [
        'Every desktop app signed in as the same account will show the same Code sidebar, from now on automatically.',
        'Newest edit wins; the other version is kept in the snapshot. Nothing is deleted. Apps that are open get updated after they quit.',
        ...(base.notes ?? []),
      ],
    },
    staging: p.staging,
    copies: p.copies,
    deferred: p.deferred.length,
  };
}
