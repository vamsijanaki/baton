// Baton test suite — every test runs against a SANDBOX fake HOME. Never real data:
// the harness refuses to run any test whose roots resolve to the real home folder.
//   npm test               all tests
//   npm test -- sync       tests whose name contains "sync"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as roots from '../electron/roots';
import * as safety from '../electron/safety';
import * as sharing from '../electron/sharing';
import * as desktop from '../electron/desktop';
import * as apps from '../electron/apps';
import * as fairuse from '../electron/fairuse';
import * as trayLogic from '../electron/tray-logic';
import * as usageHook from '../electron/usage-hook';
import type { Account } from '../electron/core';

const REAL_HOME = os.homedir();
const P = '/Users/test/Projects/work/Acme/acme-app'; // shared project (path only — never touched as a folder)
const Q = '/Users/test/Projects/other';
const enc = roots.encodeProject;

// ---------- harness ----------

type T = { name: string; fn: (s: Sandbox) => Promise<void> | void };
const tests: T[] = [];
const test = (name: string, fn: T['fn']) => tests.push({ name, fn });
let asserts = 0;
function ok(c: unknown, m: string): asserts c {
  asserts++;
  if (!c) throw new Error(`assertion failed: ${m}`);
}
async function throws(f: () => Promise<unknown> | unknown, re: RegExp, m: string) {
  try {
    await f();
  } catch (e: any) {
    ok(re.test(String(e?.message ?? e)), `${m} (got: ${String(e?.message ?? e).split('\n')[0]})`);
    return e;
  }
  ok(false, `${m}: expected an error`);
}

interface Sandbox {
  root: string;
  home: string;
  sup: string;
  store: string;
  client: Account;
  work2: Account;
  accounts: Account[];
  trash: string;
  folder: (profile: string, a?: string, o?: string) => string;
}

function writeIndex(dir: string, id: string, cwd: string, extra: Record<string, unknown> = {}, mtime?: number) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `local_${id}.json`);
  fs.writeFileSync(f, JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, cwd, title: `t-${id}`, isArchived: false, ...extra }));
  if (mtime) fs.utimesSync(f, new Date(mtime), new Date(mtime));
  return f;
}

function makeSandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cs-test-')));
  const home = path.join(root, 'home');
  const sup = path.join(home, 'Library', 'Application Support');
  fs.mkdirSync(sup, { recursive: true });
  desktop.setRootsForTest(root, path.join(root, 'Applications', 'Claude.app'), home);
  if (path.resolve(roots.roots().home) === path.resolve(REAL_HOME) || !roots.roots().home.startsWith(root)) throw new Error('SANDBOX GUARD: roots point at the real home — aborting');
  const store = roots.sharedProjects();
  // account 1: transcripts for two projects
  for (const [proj, ids] of [
    [P, ['s1', 's2']],
    [Q, ['s3']],
  ] as const) {
    const d = path.join(store, enc(proj));
    fs.mkdirSync(path.join(d, 's1', 'subagents'), { recursive: true });
    for (const id of ids) fs.writeFileSync(path.join(d, `${id}.jsonl`), `{"type":"user","message":"hello ${id}"}\n`);
    fs.writeFileSync(path.join(d, 's1', 'subagents', 'a.jsonl'), 'sub\n');
  }
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  // CLIENT: legacy whole-history link
  const clientDir = path.join(home, '.claude-client');
  fs.mkdirSync(clientDir);
  fs.symlinkSync(store, path.join(clientDir, 'projects'));
  fs.writeFileSync(path.join(clientDir, 'settings.json'), '{"x":1}');
  // Work2: new-style account (real projects folder, nothing shared)
  const w2 = path.join(home, '.claude-work2');
  fs.mkdirSync(path.join(w2, 'projects'), { recursive: true });
  const client: Account = { id: 'client', name: 'CLIENT', slug: 'client', configDir: clientDir, color: '#000' };
  const work2: Account = { id: 'work2', name: 'Work2', slug: 'work2', configDir: w2, color: '#000' };
  const def: Account = { id: 'default', name: 'Me', slug: null, configDir: path.join(home, '.claude'), color: '#000' };
  const folder = (profile: string, a = 'acct-1', o = 'org-1') => path.join(sup, profile, 'claude-code-sessions', a, o);
  for (const prof of ['Claude', 'Claude-Side', 'Claude-Cs Test']) {
    fs.mkdirSync(path.join(sup, prof), { recursive: true });
    fs.writeFileSync(path.join(sup, prof, 'Preferences'), '{}');
  }
  const fake = roots.roots().claudeApp; // a tiny stand-in for /Applications/Claude.app
  fs.mkdirSync(path.join(fake, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key>\n<string>1.0</string></dict></plist>');
  fs.writeFileSync(path.join(fake, 'Contents', 'MacOS', 'Claude'), 'bin');
  const trash = path.join(root, 'Trash');
  fs.mkdirSync(trash);
  safety.setEngineHooks({
    busy: async () => [],
    trash: async (p) => fs.renameSync(p, path.join(trash, path.basename(p) + '-' + Date.now())),
    clone: async (p, _n, color) => desktop.buildClone(p, color),
  });
  return { root, home, sup, store, client, work2, accounts: [def, client, work2], trash, folder };
}

/** type + content of every entry under p (symlinks not followed). */
function tree(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (x: string, rel: string) => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(x);
    } catch {
      out[rel] = 'absent';
      return;
    }
    if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(x)}`;
    else if (st.isFile()) out[rel] = `file:${crypto.createHash('sha256').update(fs.readFileSync(x)).digest('hex')}`;
    else if (st.isDirectory()) {
      out[rel] = 'dir';
      for (const n of fs.readdirSync(x).sort()) walk(path.join(x, n), path.join(rel, n));
    }
  };
  walk(p, '.');
  return out;
}
const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) === JSON.stringify(b);
const diff = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} → ${b[k]}`);

async function apply(op: safety.Operation, extra: Partial<safety.RunOptions> = {}) {
  return safety.runOperation(op, { confirmed: true, ...extra });
}
const none = new Set<string>();

// ---------- tests ----------

test('guard list refuses dangerous paths', async (s) => {
  const t = path.join(s.store, enc(P), 's1.jsonl');
  const refuse = (st: safety.Step, live = true) => ok(!!safety.guardStep(st, live), `guard refuses ${st.t} ${st.path.replace(s.home, '~')}`);
  refuse({ t: 'write', path: t, data: 'x' }); // overwrite transcript
  refuse({ t: 'quarantine', path: t });
  refuse({ t: 'quarantine', path: path.join(s.store, enc(P)) });
  refuse({ t: 'moveAside', path: path.join(s.store, enc(P)), to: path.join(s.store, 'x') });
  refuse({ t: 'write', path: path.join(s.home, '.claude', 'settings.json'), data: '{}' });
  refuse({ t: 'quarantine', path: path.join(s.home, '.claude') });
  refuse({ t: 'trash', path: path.join(s.home, '.claude') });
  refuse({ t: 'write', path: path.join(roots.roots().claudeApp, 'Contents', 'Info.plist'), data: '' });
  refuse({ t: 'write', path: '/Applications/Claude.app/Contents/Info.plist', data: '' });
  refuse({ t: 'rmAppCopy', path: '/Applications/Claude.app' });
  refuse({ t: 'write', path: path.join(s.sup, 'Claude-Side', 'Preferences'), data: '{}' });
  refuse({ t: 'quarantine', path: path.join(s.sup, 'Claude-Side', 'Preferences') });
  refuse({ t: 'trash', path: path.join(s.sup, 'Claude') }); // default profile never trashed
  refuse({ t: 'write', path: path.join(s.folder('Claude-Side'), 'scheduled-tasks.json'), data: '{}' });
  refuse({ t: 'rmAppCopy', path: path.join(s.home, 'Documents', 'x.app') });
  // writing THROUGH a symlinked folder into the transcript store (live check follows the link)
  refuse({ t: 'write', path: path.join(s.client.configDir, 'projects', enc(P), 's1.jsonl'), data: 'x' });
  refuse({ t: 'unlink', path: path.join(s.store, enc(P)) }); // a real folder is never "unlinked"
  // allowed
  ok(!safety.guardStep({ t: 'unlink', path: path.join(s.client.configDir, 'projects') }, true), 'unlinking a link that points into the store is allowed');
  ok(!safety.guardStep({ t: 'write', path: path.join(s.store, enc(P), 'new.jsonl'), data: 'x' }, true), 'adding a NEW file to the store is allowed');
  ok(!safety.guardStep({ t: 'write', path: path.join(s.folder('Claude-Side'), 'local_x.json'), data: '{}' }, true), 'index files may be written');
  // runOperation refuses before snapshotting or changing anything
  const before = tree(s.home);
  await throws(() => apply({ kind: 'bad', title: 'bad', steps: [{ t: 'write', path: t, data: 'pwned' }], touches: [t] }), /guard/, 'runOperation refuses');
  ok(same(before, tree(s.home)), 'nothing changed');
  ok(safety.listJournal().length === 0, 'no journal entry for a refused operation');
});

test('snapshot → change → restore is byte-for-byte; corrupt snapshots fail verification', async (s) => {
  const w = s.work2.configDir;
  fs.writeFileSync(path.join(w, 'a.txt'), 'one');
  fs.mkdirSync(path.join(w, 'sub'));
  fs.writeFileSync(path.join(w, 'sub', 'b.bin'), crypto.randomBytes(5000));
  fs.symlinkSync(path.join(s.store, enc(P)), path.join(w, 'projects', enc(P)));
  const before = tree(w);
  const snap = await safety.takeSnapshot({ op: 'test', title: 'test', paths: [w] });
  ok(snap.verified && snap.entries.length >= 6, 'snapshot verified with all entries');
  ok(snap.entries.every((e) => e.type !== 'file' || /^[0-9a-f]{64}$/.test(e.sha256!)), 'manifest has sha256 for files');
  // mutate: edit, delete link, add file, replace dir with file
  fs.writeFileSync(path.join(w, 'a.txt'), 'two');
  fs.unlinkSync(path.join(w, 'projects', enc(P)));
  fs.writeFileSync(path.join(w, 'new.txt'), 'new');
  fs.rmSync(path.join(w, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(w, 'sub'), 'now a file');
  const d = safety.diffSnapshot(snap.id);
  ok(d.some((x) => x.current === 'different') && d.some((x) => x.current === 'missing') && d.some((x) => x.current === 'extra'), 'diff shows different/missing/extra');
  const { op, work } = await safety.planRestore(snap.id);
  await apply(op);
  safety.cleanupWork(work);
  ok(same(before, tree(w)), `restored byte-for-byte (${diff(before, tree(w)).join('; ')})`);
  // the replaced items went to quarantine, not deleted
  const j = safety.listJournal()[0];
  ok(fs.existsSync(path.join(roots.snapshotsDir(), j.snapshotId, 'quarantine')), 'changed items quarantined');
  // selective restore: only one path
  fs.writeFileSync(path.join(w, 'a.txt'), 'three');
  fs.writeFileSync(path.join(w, 'sub', 'b.bin'), 'changed');
  const sel = await safety.planRestore(snap.id, [path.join(w, 'a.txt')]);
  await apply(sel.op);
  ok(fs.readFileSync(path.join(w, 'a.txt'), 'utf8') === 'one' && fs.readFileSync(path.join(w, 'sub', 'b.bin'), 'utf8') === 'changed', 'selective restore touched only the chosen path');
  // corruption
  const tgz = path.join(roots.snapshotsDir(), snap.id, 'data.tar.gz');
  fs.appendFileSync(tgz, 'garbage');
  ok(!(await safety.verifySnapshot(snap.id)).ok, 'corrupted archive fails verification');
  await throws(() => safety.planRestore(snap.id), /checksum/, 'restore refuses a corrupted snapshot');
});

test('share and unshare a project with a terminal account (only links change)', async (s) => {
  const storeBefore = tree(s.store);
  const r = sharing.planShare({ project: P, accounts: ['work2'], desktop: [] }, s.accounts, none);
  const pv = await safety.previewOperation(r.op);
  ok(pv.lines.some((l) => l.includes(`create link`) && l.includes(enc(P))) && !pv.refused.length, 'preview lists the link');
  await apply(r.op);
  sharing.cleanupStaging(r.staging);
  const link = path.join(s.work2.configDir, 'projects', enc(P));
  ok(fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === path.join(s.store, enc(P)), 'per-project link created');
  ok(!fs.existsSync(path.join(s.work2.configDir, 'projects', enc(Q))), 'other projects stay private');
  ok(sharing.terminalState(s.work2, P) === 'shared' && sharing.terminalState(s.work2, Q) === 'private', 'state reported');
  ok(sharing.readSharing().projects[0].accounts.join() === 'work2', 'config saved');
  const u = sharing.planShare({ project: P, accounts: [], desktop: [] }, s.accounts, none);
  ok(u.op.kind === 'unshare', 'unshare kind');
  await apply(u.op);
  ok(!fs.existsSync(link) && sharing.readSharing().projects.length === 0, 'unshared: link removed, config empty');
  ok(same(storeBefore, tree(s.store)), 'transcript store byte-for-byte unchanged');
});

test('share merges an account’s private history (adds only) and undo brings it back', async (s) => {
  const priv = path.join(s.work2.configDir, 'projects', enc(P));
  fs.mkdirSync(priv);
  fs.writeFileSync(path.join(priv, 'mine.jsonl'), 'private\n');
  fs.writeFileSync(path.join(priv, 's1.jsonl'), 'DIFFERENT\n'); // same name, different content in store
  const s1Before = fs.readFileSync(path.join(s.store, enc(P), 's1.jsonl'), 'utf8');
  const r = sharing.planShare({ project: P, accounts: ['work2'], desktop: [] }, s.accounts, none);
  ok(r.op.notes!.some((n) => /1 file\(s\) are added/.test(n) && /1 differing/.test(n)), 'preview explains the merge');
  const j = await apply(r.op);
  ok(fs.readFileSync(path.join(s.store, enc(P), 'mine.jsonl'), 'utf8') === 'private\n', 'private transcript added to the store');
  ok(fs.readFileSync(path.join(s.store, enc(P), 's1.jsonl'), 'utf8') === s1Before, 'existing transcript NOT overwritten');
  ok(fs.lstatSync(priv).isSymbolicLink(), 'link in place');
  const aside = fs.readdirSync(path.dirname(priv)).find((n) => n.includes('.private-'))!;
  ok(fs.readFileSync(path.join(path.dirname(priv), aside, 's1.jsonl'), 'utf8') === 'DIFFERENT\n', 'private folder kept aside intact');
  const u = await safety.planUndo(j.id);
  await apply(u.op, { undoOf: j.id });
  ok(fs.lstatSync(priv).isDirectory() && !fs.lstatSync(priv).isSymbolicLink() && fs.readFileSync(path.join(priv, 'mine.jsonl'), 'utf8') === 'private\n', 'undo: private folder back in place');
  ok(fs.existsSync(path.join(s.store, enc(P), 'mine.jsonl')), 'undo never deletes from the transcript store');
  ok(safety.listJournal().find((x) => x.id === j.id)!.undoneBy, 'original marked undone');
});

function legacyDesktop(s: Sandbox) {
  // old Link feature: Cs Test org-1 is a LIVE folder link to the legacy store; org-2 record is stale (real folder)
  const legacy = roots.legacyStore();
  fs.mkdirSync(legacy, { recursive: true });
  const t0 = Date.now() - 100_000;
  writeIndex(s.folder('Claude'), 'd1', P, {}, t0);
  writeIndex(s.folder('Claude'), 'd2', Q, {}, t0);
  writeIndex(s.folder('Claude-Side'), 'w1', P + '/apps/api', {}, t0);
  writeIndex(s.folder('Claude-Side'), 'w2', '/elsewhere', {}, t0);
  for (const f of ['local_d1.json', 'local_d2.json', 'local_w1.json']) fs.copyFileSync(path.join(f.includes('w') ? s.folder('Claude-Side') : s.folder('Claude'), f), path.join(legacy, f));
  const backup = path.join(roots.roots().appDir, 'backups', 'old', 'Claude-Cs Test', 'acct-1', 'org-1');
  fs.mkdirSync(backup + '.original', { recursive: true });
  writeIndex(backup + '.original', 'c1', P, {}, t0);
  fs.mkdirSync(path.dirname(s.folder('Claude-Cs Test')), { recursive: true });
  fs.symlinkSync(legacy, s.folder('Claude-Cs Test'));
  fs.mkdirSync(s.folder('Claude-Cs Test', 'acct-1', 'org-2'), { recursive: true });
  fs.writeFileSync(path.join(s.folder('Claude-Cs Test', 'acct-1', 'org-2'), 'scheduled-tasks.json'), '[]');
  safety.writeJsonAtomic(roots.legacyLinksFile(), [
    { profile: 'Claude-Cs Test', folder: s.folder('Claude-Cs Test'), backup, linkedAt: 'x' },
    { profile: 'Claude-Cs Test', folder: s.folder('Claude-Cs Test', 'acct-1', 'org-2'), backup: backup.replace('org-1', 'org-2'), linkedAt: 'x' },
  ]);
}
const watched = (s: Sandbox) => [s.client.configDir, path.join(s.sup, 'Claude-Cs Test'), path.join(s.sup, 'Claude-Side'), path.join(s.sup, 'Claude'), roots.roots().appDir + '/desktop-links.json', roots.sharingFile()];
const snapAll = (s: Sandbox) => Object.fromEntries(watched(s).map((p) => [p, tree(p)]));

test('migration: whole-history link + old desktop links → per-project sharing; undo restores', async (s) => {
  legacyDesktop(s);
  const before = snapAll(s);
  const storeBefore = tree(s.store);
  const m = sharing.planMigration(s.accounts, [P], none);
  ok(m.summary.accounts.length === 1 && m.summary.accounts[0].name === 'CLIENT' && m.summary.accounts[0].hiddenProjects === 1, 'CLIENT converted; 1 other project becomes private');
  ok(m.summary.desktop.liveLinks === 1 && m.summary.desktop.staleRecords === 1, 'one live link, one stale record');
  ok(m.summary.desktop.participants.length === 4, `participants: ${m.summary.desktop.participants.join(', ')}`);
  const pv = await safety.previewOperation(m.op);
  ok(!pv.refused.length && pv.lines.length === m.op.steps.length, 'dry run lists every step, none refused');
  const j = await apply(m.op);
  sharing.cleanupStaging(m.staging);
  const pd = path.join(s.client.configDir, 'projects');
  ok(fs.lstatSync(pd).isDirectory() && !fs.lstatSync(pd).isSymbolicLink(), 'CLIENT projects is a real folder');
  ok(fs.readdirSync(pd).join() === enc(P) && fs.readlinkSync(path.join(pd, enc(P))) === path.join(s.store, enc(P)), 'only the shared project is linked');
  ok(fs.lstatSync(s.folder('Claude-Cs Test')).isDirectory() && fs.existsSync(path.join(s.folder('Claude-Cs Test'), 'local_c1.json')), 'old link replaced by a real folder with its own backup restored');
  ok(fs.readFileSync(roots.legacyLinksFile(), 'utf8') === '[]', 'old link records cleared');
  // first sync: d1 (P) reached Side; w1 (P/apps/api) reached Claude; Q and /elsewhere did not move
  ok(fs.existsSync(path.join(s.folder('Claude-Side'), 'local_d1.json')) && fs.existsSync(path.join(s.folder('Claude'), 'local_w1.json')), 'shared-project index files synced');
  ok(!fs.existsSync(path.join(s.folder('Claude-Side'), 'local_d2.json')) && !fs.existsSync(path.join(s.folder('Claude'), 'local_w2.json')), 'other projects not synced');
  ok(same(storeBefore, tree(s.store)), 'transcripts untouched');
  ok(fs.existsSync(roots.legacyStore()), 'legacy store left in place');
  // doctor no longer flags legacy sharing
  const doc = await sharing.runDoctor({ accounts: s.accounts, profiles: [], claudeVersion: '1', runningProfiles: none, freeBytes: 50e9 });
  ok(doc.find((c) => c.id === 'legacy')!.level === 'ok', 'doctor: legacy fixed');
  // undo
  const u = await safety.planUndo(j.id);
  const upv = await safety.previewOperation(u.op);
  ok(upv.lines.length > 0 && !upv.refused.length, 'undo has a preview');
  await apply(u.op, { undoOf: j.id });
  safety.cleanupWork(u.work);
  const after = snapAll(s);
  for (const p of watched(s)) ok(same(before[p], after[p]), `undo restored ${p.replace(s.home, '~')} byte-for-byte (${diff(before[p], after[p]).slice(0, 3).join('; ')})`);
});

test('crash mid-operation (process killed between steps) → rolled back on next start', async (s) => {
  legacyDesktop(s);
  const before = snapAll(s);
  const child = spawnSync(process.execPath, [__filename, '--child-crash', s.root], { encoding: 'utf8' });
  ok(child.signal === 'SIGKILL', `child was killed mid-operation (signal ${child.signal}, ${child.stderr.slice(0, 200)})`);
  const j = safety.listJournal()[0];
  ok(j.status === 'applying' && j.done === 3, `journal left in "applying" after step 3 (done=${j.done})`);
  ok(!same(before[s.client.configDir], tree(s.client.configDir)), 'the half-applied state really is different');
  const doc = await sharing.runDoctor({ accounts: s.accounts, profiles: [], claudeVersion: '1', runningProfiles: none, freeBytes: 50e9 });
  ok(doc.find((c) => c.id === 'journal')!.level === 'error', 'doctor flags the interrupted operation');
  const rec = safety.recoverInterrupted();
  ok(rec.length === 1 && rec[0].status === 'rolled-back', 'recovered by rollback');
  const after = snapAll(s);
  for (const p of watched(s)) ok(same(before[p], after[p]), `rollback restored ${p.replace(s.home, '~')} (${diff(before[p], after[p]).slice(0, 3).join('; ')})`);
});

test('a failing step rolls back automatically', async (s) => {
  legacyDesktop(s);
  const before = snapAll(s);
  const m = sharing.planMigration(s.accounts, [P], none);
  const e = await throws(() => apply(m.op, { failAtStep: 5 }), /Rolled back automatically/, 'failure reported with rollback');
  ok(e.journal.status === 'rolled-back', 'journal says rolled back');
  const after = snapAll(s);
  for (const p of watched(s)) ok(same(before[p], after[p]), `state restored: ${p.replace(s.home, '~')}`);
});

function twoFolders(s: Sandbox) {
  const A = s.folder('Claude');
  const B = s.folder('Claude-Side');
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  safety.writeJsonAtomic(roots.sharingFile(), { version: 1, projects: [{ path: P, accounts: [], desktop: ['Claude/acct-1/org-1', 'Claude-Side/acct-1/org-1'] }] });
  return { A, B };
}
async function syncOnce(running = none) {
  const p = sharing.planSync(sharing.readSharing(), sharing.readSyncState(), running);
  if (p.steps.length) await apply(sharing.syncOperation(p));
  else safety.writeJsonAtomic(roots.syncStateFile(), p.newState);
  sharing.cleanupStaging(p.staging);
  return p;
}

test('desktop sync: two-way, conflict = newest wins and the loser is kept', async (s) => {
  const { A, B } = twoFolders(s);
  const t0 = Date.now() - 60_000;
  writeIndex(A, 'x', P, { title: 'first' }, t0);
  let p = await syncOnce();
  ok(p.copies === 1 && fs.existsSync(path.join(B, 'local_x.json')), 'A → B');
  writeIndex(B, 'y', P + '/sub', {}, t0);
  p = await syncOnce();
  ok(p.copies === 1 && fs.existsSync(path.join(A, 'local_y.json')), 'B → A (two-way)');
  // both change x: B newer
  writeIndex(A, 'x', P, { title: 'from A' }, t0 + 10_000);
  writeIndex(B, 'x', P, { title: 'from B' }, t0 + 20_000);
  p = await syncOnce();
  ok(p.conflicts.length === 1 && p.conflicts[0].winner === 'Claude-Side/acct-1/org-1', 'conflict detected, newest (B) wins');
  ok(JSON.parse(fs.readFileSync(path.join(A, 'local_x.json'), 'utf8')).title === 'from B', 'A now has the winner');
  const snap = safety.listSnapshots().find((x) => x.category === 'sync' && x.pinned)!;
  ok(!!snap, 'conflict snapshot is pinned (never pruned)');
  const work = await safety.extractSnapshot(snap.id);
  const loser = path.join(work, path.join(A, 'local_x.json').slice(1));
  ok(JSON.parse(fs.readFileSync(loser, 'utf8')).title === 'from A', 'losing version kept in the snapshot store');
  safety.cleanupWork(work);
  // archive is a flag change → propagates; nothing deleted
  writeIndex(A, 'y', P + '/sub', { isArchived: true }, t0 + 30_000);
  await syncOnce();
  ok(JSON.parse(fs.readFileSync(path.join(B, 'local_y.json'), 'utf8')).isArchived === true, 'archive flag propagated');
  // removal in one folder is NOT propagated and NOT re-added
  fs.rmSync(path.join(A, 'local_y.json'));
  p = await syncOnce();
  ok(p.copies === 0 && fs.existsSync(path.join(B, 'local_y.json')) && !fs.existsSync(path.join(A, 'local_y.json')), 'never deletes, never resurrects');
  // other projects never sync
  writeIndex(A, 'z', Q);
  p = await syncOnce();
  ok(!fs.existsSync(path.join(B, 'local_z.json')), 'non-shared project stays put');
});

test('desktop sync is safe with atomic-rename writes', async (s) => {
  const { A, B } = twoFolders(s);
  writeIndex(A, 'x', P, { title: 'v1' }, Date.now() - 60_000);
  await syncOnce();
  // the app is mid-write: a partial file appears under the final name → skipped, nothing copied
  const f = path.join(A, 'local_x.json');
  fs.writeFileSync(f, '{"cwd":"' + P + '","tit');
  let p = await syncOnce();
  ok(p.copies === 0 && JSON.parse(fs.readFileSync(path.join(B, 'local_x.json'), 'utf8')).title === 'v1', 'half-written file is ignored');
  // the app finishes with tmp + rename
  const tmp = path.join(A, '.tmp-local_x');
  fs.writeFileSync(tmp, JSON.stringify({ cwd: P, title: 'v2' }));
  fs.renameSync(tmp, f);
  // our own write is atomic too: a reader holding the old file still sees complete old content
  const fd = fs.openSync(path.join(B, 'local_x.json'), 'r');
  p = await syncOnce();
  ok(p.copies === 1 && JSON.parse(fs.readFileSync(path.join(B, 'local_x.json'), 'utf8')).title === 'v2', 'completed write synced');
  const old = Buffer.alloc(4096);
  const n = fs.readSync(fd, old, 0, 4096, 0);
  fs.closeSync(fd);
  ok(JSON.parse(old.subarray(0, n).toString()).title === 'v1', 'replaced by rename (old inode intact), never truncated in place');
  ok(!fs.readdirSync(B).some((x) => x.endsWith('.tmp')), 'no temp files left behind');
  p = await syncOnce();
  ok(p.copies === 0, 'stable afterwards (hash + mtime match)');
});

test('running-process refusal: operations wait; sync defers writes to a running profile', async (s) => {
  safety.setEngineHooks({ busy: async (touches) => (touches.some((t) => t.startsWith(s.client.configDir)) ? ['CLIENT — claude in Terminal (pid 4242)'] : []) });
  const before = tree(s.client.configDir);
  const m = sharing.planMigration(s.accounts, [P], none);
  const pv = await safety.previewOperation(m.op);
  ok(pv.busy.length === 1 && /4242/.test(pv.busy[0]), 'preview names the running process');
  const e = await throws(() => apply(m.op), /Quit these first/, 'refused while running');
  ok(e.busy?.length === 1, 'error carries the busy list (for "wait and retry")');
  ok(same(before, tree(s.client.configDir)) && safety.listJournal().length === 0 && safety.listSnapshots().length === 0, 'nothing written, no snapshot, no journal');
  safety.setEngineHooks({ busy: async () => [] });
  const { A, B } = twoFolders(s);
  writeIndex(A, 'x', P);
  let p = await syncOnce(new Set(['Claude-Side']));
  ok(p.copies === 0 && p.deferred.length === 1 && !fs.existsSync(path.join(B, 'local_x.json')), 'write to running profile deferred');
  p = await syncOnce();
  ok(p.copies === 1 && fs.existsSync(path.join(B, 'local_x.json')), 'copied once it quit');
});

test('snapshot retention keeps N, never the newest 5, pinned or quarantined ones', async (s) => {
  safety.writeSettings({ retention: 6 });
  const f = path.join(s.work2.configDir, 'n.txt');
  for (let i = 0; i < 9; i++) await apply({ kind: 'n', title: `n${i}`, steps: [{ t: 'write', path: f, data: String(i) }], touches: [f], pinned: i === 0 });
  const left = safety.listSnapshots().filter((x) => x.category === 'op');
  ok(left.length === 7 && left.some((x) => x.title === 'n0'), `kept 6 + the pinned one (${left.length})`);
  safety.writeSettings({ retention: 1 });
  ok(safety.readSettings().retention === 5, 'retention can not go below 5');
});

test('desktop profiles: create, color, update, remove (launcher / everything) through the engine', async (s) => {
  const fake = roots.roots().claudeApp;
  const c = desktop.planCreateProfile('cs demo', 'purple');
  ok(c.name === 'Cs Demo', 'display name');
  await apply(c.op);
  const data = path.join(s.sup, 'Claude-Cs Demo');
  ok(fs.readFileSync(path.join(data, '.baton-color'), 'utf8').trim() === 'purple', 'data folder + color');
  ok(fs.existsSync(path.join(desktop.CLONES, 'Claude Cs Demo.app', 'Contents', 'MacOS', 'Claude')), 'app copy built');
  let ps = await desktop.listDesktopProfiles({});
  let p = ps.find((x) => x.id === 'Claude-Cs Demo')!;
  ok(p.origin === 'claude-switch' && !p.signedIn && !p.needsUpdate, 'listed');
  await apply(desktop.planColor(p, 'teal'));
  ok(fs.readFileSync(path.join(data, '.baton-color'), 'utf8').trim() === 'teal', 'color changed');
  fs.writeFileSync(path.join(fake, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key>\n<string>2.0</string></dict></plist>');
  ps = await desktop.listDesktopProfiles({});
  const u = desktop.planUpdateProfiles(ps);
  ok(u.op.steps.length === 1, 'one app copy to update');
  await apply(u.op);
  ps = await desktop.listDesktopProfiles({});
  ok(!ps.find((x) => x.id === 'Claude-Cs Demo')!.needsUpdate, 'updated to 2.0');
  p = ps.find((x) => x.id === 'Claude-Cs Demo')!;
  await apply(desktop.planRemoveProfile(p, 'launcher'));
  ok(!fs.existsSync(path.join(desktop.CLONES, 'Claude Cs Demo.app')) && fs.existsSync(data), 'launcher only: data kept');
  p = (await desktop.listDesktopProfiles({})).find((x) => x.id === 'Claude-Cs Demo')!;
  await apply(desktop.planRemoveProfile(p, 'everything'));
  ok(!fs.existsSync(data) && fs.readdirSync(s.trash).some((n) => n.startsWith('Claude-Cs Demo')), 'everything: data folder in the Trash');
});

test('accounts: add creates a private account; remove unlinks first and trashes', async (s) => {
  const dir = path.join(s.home, '.claude-new');
  await apply(sharing.planAccountAdd(dir, 'New'));
  ok(fs.lstatSync(path.join(dir, 'projects')).isDirectory() && fs.readdirSync(path.join(dir, 'projects')).length === 0, 'new account shares nothing');
  const acc: Account = { id: 'new', name: 'New', slug: 'new', configDir: dir, color: '' };
  const r = sharing.planShare({ project: P, accounts: ['new'], desktop: [] }, [...s.accounts, acc], none);
  await apply(r.op);
  const storeBefore = tree(s.store);
  await apply(sharing.planAccountRemove(acc));
  ok(!fs.existsSync(dir) && same(storeBefore, tree(s.store)), 'account trashed; store untouched');
  await throws(() => sharing.planAccountRemove(s.accounts[0]), /never be removed/, 'account 1 is never removable');
});

test('found data folder: listed, default color, adopted with Baton’s own app copy (data untouched)', async (s) => {
  // a Claude-<Name> folder Baton did not make (only Chromium's Preferences / Local State in it)
  const found = path.join(s.sup, 'Claude-Found');
  fs.mkdirSync(found, { recursive: true });
  fs.writeFileSync(path.join(found, 'Local State'), '{}');
  fs.writeFileSync(path.join(found, '.other-tool-color'), 'blue\n'); // another tool's color file is ignored
  fs.mkdirSync(path.join(s.sup, 'Claude-Empty')); // no desktop-app markers → not listed
  const before = tree(found);
  let p = (await desktop.listDesktopProfiles({})).find((x) => x.id === 'Claude-Found');
  ok(!!p && p.origin === 'other' && p.cloneSource === null && p.appPath === null, 'listed as a found folder without an app copy');
  ok(p!.color === 'orange', `no .baton-color → default color (${p!.color})`);
  ok(!(await desktop.listDesktopProfiles({})).some((x) => x.id === 'Claude-Empty'), 'a folder without desktop-app markers is not listed');
  const ov = apps.buildOverview([], await desktop.listDesktopProfiles({}), {});
  ok(ov.unpaired.some((a) => a.id === 'Claude-Found' && a.origin === 'other' && !a.cloneSource), 'offered for adopting (unpaired, no app copy)');
  const op = desktop.planAdopt(p!);
  ok(op.steps.length === 1 && op.steps[0].t === 'clone' && !(await safety.previewOperation(op)).refused.length, 'adopt = build one app copy');
  await apply(op);
  ok(fs.existsSync(path.join(desktop.CLONES, 'Claude Found.app', 'Contents', 'MacOS', 'Claude')), 'Baton app copy built');
  ok(same(before, tree(found)), 'data folder untouched');
  p = (await desktop.listDesktopProfiles({})).find((x) => x.id === 'Claude-Found')!;
  ok(p.cloneSource === 'claude-switch' && p.appPath === path.join(desktop.CLONES, 'Claude Found.app'), 'now launches from Baton’s copy');
  await throws(() => desktop.planAdopt(p!), /already has/, 'adopting twice is refused');
  // a stored Baton color is honoured
  fs.writeFileSync(path.join(found, '.baton-color'), 'teal\n');
  ok((await desktop.listDesktopProfiles({})).find((x) => x.id === 'Claude-Found')!.color === 'teal', '.baton-color is read');
});

test('registry: unknown / older origin values load as "other"; the file is not rewritten', async (s) => {
  const at = '2026-10-01T00:00:00.000Z';
  const reg = { 'Claude-Side': { origin: 'an-older-tool', autoLink: false, addedAt: at }, 'Claude-Cs Test': { origin: 'claude-switch', autoLink: true, addedAt: at }, 'Claude-Gone': { origin: 42, autoLink: false, addedAt: at } };
  fs.mkdirSync(path.dirname(roots.desktopRegistry()), { recursive: true });
  const raw = JSON.stringify(reg, null, 2);
  fs.writeFileSync(roots.desktopRegistry(), raw);
  const r = desktop.readRegistry();
  ok(r['Claude-Side'].origin === 'other' && r['Claude-Gone'].origin === 'other' && r['Claude-Cs Test'].origin === 'claude-switch', 'unknown origins read as other');
  const ps = await desktop.listDesktopProfiles({});
  ok(ps.find((x) => x.id === 'Claude-Side')!.origin === 'other' && ps.find((x) => x.id === 'Claude-Cs Test')!.origin === 'claude-switch', 'profiles load with mapped origins');
  ok(fs.readFileSync(roots.desktopRegistry(), 'utf8') === raw, 'registry file left exactly as it was');
});

test('tidy-up removes app copies only inside Baton’s own apps folders, never other tools’ folders', async (s) => {
  fourApps(s);
  const other = path.join(s.sup, 'Some Other Tool', 'apps', 'Claude Side.app');
  const userApp = path.join(s.home, 'Applications', 'Claude Side.app');
  const legacy = path.join(s.sup, roots.LEGACY_APPS_PARENT, 'apps', 'Claude Side.app');
  for (const d of [other, userApp]) {
    fs.mkdirSync(path.join(d, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(d, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.example.side</string></dict></plist>');
  }
  await desktop.buildClone(path.join(desktop.CLONES, 'Claude Side.app'), 'green');
  ok(desktop.CLONES === path.join(s.sup, roots.APPS_PARENT, 'apps'), 'sandbox uses Baton/apps');
  await desktop.buildClone(legacy, 'green'); // the older apps folder still counts as Baton's
  const otherBefore = tree(other);
  const userBefore = tree(userApp);
  const ps = await desktop.listDesktopProfiles(emails);
  const m = apps.planMergeApps(ps.find((p) => p.id === 'Claude-Claude Client')!, [ps.find((p) => p.id === 'Claude-Side')!], false);
  const targets = m.op.steps.filter((x) => x.t === 'rmAppCopy' || x.t === 'quarantine' || x.t === 'trash').map((x) => x.path);
  const own = [path.join(s.sup, roots.APPS_PARENT, 'apps'), path.join(s.sup, roots.LEGACY_APPS_PARENT, 'apps')];
  ok(targets.length >= 1 && targets.every((t) => own.some((d) => t.startsWith(d + path.sep))), `only Baton apps folders targeted (${targets.map((t) => t.replace(s.sup, '…')).join(', ')})`);
  await apply(m.op);
  sharing.cleanupStaging(m.staging);
  ok(!fs.existsSync(path.join(desktop.CLONES, 'Claude Side.app')) && !fs.existsSync(legacy), 'Baton app copies removed (current and older folder)');
  ok(same(otherBefore, tree(other)) && same(userBefore, tree(userApp)), 'other tools’ app copies and ~/Applications untouched');
  ok(!!safety.guardStep({ t: 'rmAppCopy', path: other }, true), 'the guard refuses removing an app copy outside Baton’s apps folders');
});

test('read-only mode (used for real-machine checks) never writes', async (s) => {
  legacyDesktop(s);
  const before = tree(s.home);
  roots.setReadOnly(true);
  try {
    const m = sharing.planMigration(s.accounts, [P], none);
    ok(m.op.steps.length > 0, 'migration can be planned');
    await safety.previewOperation(m.op);
    await sharing.runDoctor({ accounts: s.accounts, profiles: [], claudeVersion: '1', runningProfiles: none, freeBytes: 50e9 });
    await desktop.listDesktopProfiles({});
    await throws(() => apply(m.op), /read-only/, 'apply refused');
    await throws(() => safety.takeSnapshot({ op: 'x', title: 'x', paths: [s.home] }), /read-only/, 'snapshot refused');
  } finally {
    roots.setReadOnly(false);
  }
  ok(same(before, tree(s.home)), `nothing on disk changed (${diff(before, tree(s.home)).slice(0, 3).join('; ')})`);
});

// ---------- one concept: accounts = emails (pairing, merge & tidy up, same-account sync, derived sharing) ----------

const ME = 'uuid-me';
const FT = 'uuid-client';
const OLD = 'uuid-old';
const emails = { [ME]: 'me@example.com', [FT]: 'client@example.org' };
function signInApp(s: Sandbox, profile: string, uuid: string) {
  fs.mkdirSync(path.join(s.sup, profile), { recursive: true });
  fs.writeFileSync(path.join(s.sup, profile, 'Preferences'), '{}');
  fs.writeFileSync(path.join(s.sup, profile, 'config.json'), JSON.stringify({ lastKnownAccountUuid: uuid, locale: 'en' }));
}
const terms = (s: Sandbox): apps.TerminalIdentity[] => [
  { id: 'default', name: 'Me', color: '#000', configDir: path.join(s.home, '.claude'), email: emails[ME], accountUuid: ME, signedIn: true, isDefault: true },
  { id: 'client', name: 'CLIENT', color: '#000', configDir: s.client.configDir, email: emails[FT], accountUuid: FT, signedIn: true, isDefault: false },
];
/** Me in the default app (+ an old CLIENT sign-in leftover), CLIENT in three apps: Claude Client (kept), Claude Side, Cs Test. */
function fourApps(s: Sandbox) {
  signInApp(s, 'Claude', ME);
  for (const p of ['Claude-Claude Client', 'Claude-Side', 'Claude-Cs Test']) signInApp(s, p, FT);
  const t0 = Date.now() - 100_000;
  writeIndex(s.folder('Claude', ME, 'org-me'), 'm1', P, {}, t0);
  writeIndex(s.folder('Claude', FT, 'org-ft'), 'stale', '/old', {}, t0); // old sign-in leftover
  writeIndex(s.folder('Claude-Claude Client', FT, 'org-ft'), 'f1', P, { title: 'kept version' }, t0);
  writeIndex(s.folder('Claude-Claude Client', FT, 'org-ft'), 'f2', Q, {}, t0);
  writeIndex(s.folder('Claude-Side', FT, 'org-ft'), 'f1', P, { title: 'side version' }, t0 + 5000); // same chat, differs
  writeIndex(s.folder('Claude-Side', FT, 'org-ft'), 'w9', P, {}, t0);
  writeIndex(s.folder('Claude-Side', FT, 'org-2'), 'w8', Q, {}, t0); // an org the kept app has no folder for yet
  fs.mkdirSync(s.folder('Claude-Cs Test', FT, 'org-ft'), { recursive: true });
  return t0;
}
async function overview(s: Sandbox) {
  return apps.buildOverview(terms(s), await desktop.listDesktopProfiles(emails), emails);
}

test('accounts: desktop apps pair with Terminal accounts by email; extras, leftovers, waiting apps', async (s) => {
  fourApps(s);
  const c = desktop.planCreateProfile(desktop.freeAppName('CLIENT'), 'green', { id: 'client', name: 'CLIENT' });
  ok(c.name === 'Client', `app named after the account (${c.name})`);
  await apply(c.op);
  const ov = await overview(s);
  const me = ov.accounts.find((a) => a.key === 'default')!;
  const ft = ov.accounts.find((a) => a.key === 'client')!;
  ok(me.apps.map((a) => a.id).join() === 'Claude' && me.extras.length === 0, 'Me ↔ default Claude app');
  ok(ft.apps.length === 3 && ft.kept === 'Claude-Claude Client', `CLIENT keeps the app named after it (${ft.kept})`);
  ok(ft.extras.sort().join() === 'Claude-Cs Test,Claude-Side', 'two extra CLIENT apps');
  ok(ft.waiting.map((a) => a.id).join() === 'Claude-Client', 'the new app waits for its first sign-in under CLIENT');
  ok(ov.leftovers.length === 1 && ov.leftovers[0].profile === 'Claude' && ov.leftovers[0].email === emails[FT], 'old CLIENT list in the default app is a leftover, not a second account');
  ok(me.apps[0].sessions === 1, 'leftover chats are not counted as the app’s own');
  ok(ov.accounts.length === 2 && ov.unpaired.length === 0, 'no desktop-only or unpaired apps');
  ok(desktop.freeAppName('CLIENT') === 'Client 2', 'the next free name skips an existing folder');
});

test('merge & tidy up: copy-only into the kept app, launcher removed, data kept unless ticked; undo', async (s) => {
  fourApps(s);
  const ps = await desktop.listDesktopProfiles(emails);
  const get = (id: string) => ps.find((p) => p.id === id)!;
  const keepDir = path.join(s.sup, 'Claude-Claude Client', 'claude-code-sessions');
  const keptF1 = fs.readFileSync(path.join(keepDir, FT, 'org-ft', 'local_f1.json'), 'utf8');
  // the Side app has a launcher clone; Cs Test has none
  await desktop.buildClone(path.join(desktop.CLONES, 'Claude Side.app'), 'green');
  const storeBefore = tree(s.store);
  const sideBefore = tree(path.join(s.sup, 'Claude-Side'));
  // refused while the kept app runs
  safety.setEngineHooks({ busy: async (t) => (t.some((x) => x.toLowerCase() === path.join(s.sup, 'Claude-Claude Client').toLowerCase()) ? ['Claude Client — Claude desktop app (pid 7)'] : []) });
  const m = apps.planMergeApps(get('Claude-Claude Client'), [get('Claude-Side'), get('Claude-Cs Test')], false);
  ok(m.summary.copies === 2 && m.summary.alreadyThere === 1, `copies only what is missing (${m.summary.copies} new, ${m.summary.alreadyThere} already there)`);
  const pv = await safety.previewOperation(m.op);
  ok(!pv.refused.length && pv.busy.length === 1, 'preview: allowed, but waits for the running kept app');
  await throws(() => apply(m.op), /Quit these first/, 'nothing happens while an app runs');
  ok(same(sideBefore, tree(path.join(s.sup, 'Claude-Side'))) && safety.listJournal().length === 0, 'untouched while running');
  safety.setEngineHooks({ busy: async () => [] });
  const j = await apply(m.op);
  sharing.cleanupStaging(m.staging);
  ok(fs.readFileSync(path.join(keepDir, FT, 'org-ft', 'local_f1.json'), 'utf8') === keptF1, 'existing entry in the kept app NOT overwritten');
  ok(fs.existsSync(path.join(keepDir, FT, 'org-ft', 'local_w9.json')) && fs.existsSync(path.join(keepDir, FT, 'org-2', 'local_w8.json')), 'missing entries copied (same account folders, new org folder created)');
  ok(!fs.existsSync(path.join(desktop.CLONES, 'Claude Side.app')), 'extra app copy removed');
  ok(same(sideBefore, tree(path.join(s.sup, 'Claude-Side'))), 'its data folder is kept byte-for-byte (default)');
  ok(same(storeBefore, tree(s.store)), 'transcripts untouched');
  const ov = await overview(s);
  const ft = ov.accounts.find((a) => a.key === 'client')!;
  ok(ft.apps.length === 1 && ft.extras.length === 0 && ov.retired.length === 2, 'CLIENT now has one app; the others are listed as retired');
  // undo puts the registry back and takes the copies out again (quarantined, never deleted)
  const u = await safety.planUndo(j.id);
  await apply(u.op, { undoOf: j.id });
  safety.cleanupWork(u.work);
  ok(!fs.existsSync(path.join(keepDir, FT, 'org-ft', 'local_w9.json')), 'undo: copied entry gone from the kept app');
  ok((await overview(s)).accounts.find((a) => a.key === 'client')!.apps.length === 3, 'undo: the extra apps are back in the list');
  // explicit tick: data folder → Trash
  const ps2 = await desktop.listDesktopProfiles(emails);
  const t = apps.planMergeApps(ps2.find((p) => p.id === 'Claude-Claude Client')!, [ps2.find((p) => p.id === 'Claude-Cs Test')!], true);
  await apply(t.op);
  sharing.cleanupStaging(t.staging);
  ok(!fs.existsSync(path.join(s.sup, 'Claude-Cs Test')) && fs.readdirSync(s.trash).some((n) => n.startsWith('Claude-Cs Test')), 'ticked: data folder in the Trash');
  await throws(() => apps.planMergeApps(ps2.find((p) => p.id === 'Claude-Claude Client')!, [ps2.find((p) => p.id === 'Claude')!], false), /different account|never removed/, 'refuses another account / the default app');
});

test('same account = same chat list: apps of one account sync, leftovers and other accounts do not', async (s) => {
  fourApps(s);
  ok(safety.readSettings().sameAccountSync === true, 'new setup (no settings file): ON by default');
  safety.writeJsonAtomic(roots.settingsFile(), { retention: 20, syncEnabled: true, onboarded: true });
  ok(safety.readSettings().sameAccountSync === false, 'existing setup from before the option: OFF until applied');
  const ps = await desktop.listDesktopProfiles(emails);
  const ctx = apps.syncContext(ps, terms(s), false);
  const r = apps.planSameAccountOn(ctx, none);
  const pv = await safety.previewOperation(r.op);
  ok(!pv.refused.length && r.copies > 0, `previewed first sync (${r.copies} copies)`);
  await apply(r.op);
  sharing.cleanupStaging(r.staging);
  ok(safety.readSettings().sameAccountSync === true, 'setting turned on by the operation');
  const side = s.folder('Claude-Side', FT, 'org-ft');
  const cs = s.folder('Claude-Cs Test', FT, 'org-ft');
  ok(['f2', 'w9', 'f1'].every((x) => fs.existsSync(path.join(cs, `local_${x}.json`))), 'Cs Test now lists every CLIENT chat');
  ok(JSON.parse(fs.readFileSync(path.join(s.folder('Claude-Claude Client', FT, 'org-ft'), 'local_f1.json'), 'utf8')).title === 'side version', 'newest edit wins');
  ok(fs.existsSync(path.join(side, 'local_f2.json')), 'two-way');
  ok(!fs.existsSync(path.join(s.folder('Claude', FT, 'org-ft'), 'local_f2.json')) && !fs.existsSync(path.join(cs, 'local_stale.json')), 'old sign-in leftover list neither fed nor read');
  ok(!fs.existsSync(path.join(side, 'local_m1.json')), 'another account’s chats are not mixed in');
  // background passes keep it in step; a running app is updated after it quits
  writeIndex(side, 'new', '/x');
  const ctx2 = apps.syncContext(await desktop.listDesktopProfiles(emails), terms(s));
  let p = sharing.planSync(sharing.readSharing(), sharing.readSyncState(), new Set(['Claude-Cs Test']), undefined, ctx2);
  ok(p.deferred.some((d) => d.folder.startsWith('Claude-Cs Test')) && p.copies === 1, 'running app deferred, the other copied');
  await apply(sharing.syncOperation(p));
  sharing.cleanupStaging(p.staging);
  p = sharing.planSync(sharing.readSharing(), sharing.readSyncState(), none, undefined, ctx2);
  ok(p.copies === 1, 'copied once it quit');
});

test('simple sharing: turning an account on syncs the project across all its desktop apps; reason read from the journal', async (s) => {
  fourApps(s);
  // CLIENT must be per-project first (legacy whole-history link) → migration, which keeps P shared
  const m = sharing.planMigration(s.accounts, [P], none);
  await apply(m.op);
  sharing.cleanupStaging(m.staging);
  const since = sharing.sharedSince(P);
  ok(since?.kind === 'migrate', 'shared since the migration (kept from the old all-projects setup)');
  const ps = await desktop.listDesktopProfiles(emails);
  const ctx = apps.syncContext(ps, terms(s), false);
  const r = sharing.planShare({ project: P, accounts: ['client'], desktop: [], auto: true }, s.accounts, none, ctx);
  ok(r.op.notes!.some((n) => /Claude \(default\)/.test(n) && /Claude Client/.test(n) && /Side/.test(n)), 'preview names every desktop app that will show the chats');
  await apply(r.op);
  sharing.cleanupStaging(r.staging);
  const cfg = sharing.readSharing().projects.find((x) => x.path === P)!;
  ok(cfg.auto === true && cfg.accounts.join() === 'client', 'stored as derived (auto)');
  ok(fs.existsSync(path.join(s.folder('Claude-Cs Test', FT, 'org-ft'), 'local_m1.json')) && fs.existsSync(path.join(s.folder('Claude', ME, 'org-me'), 'local_w9.json')), 'P sessions flow between Me’s and CLIENT’s apps');
  ok(!fs.existsSync(path.join(s.folder('Claude', ME, 'org-me'), 'local_f2.json')), 'other projects stay private');
  ok(!fs.existsSync(path.join(s.folder('Claude', FT, 'org-ft'), 'local_m1.json')), 'leftover list is not part of it');
  ok(sharing.sharedSince(P)?.kind === 'migrate', 'reason unchanged by a later edit');
  const off = sharing.planShare({ project: P, accounts: [], desktop: [], auto: true }, s.accounts, none, ctx);
  await apply(off.op);
  ok(sharing.sharedSince(P) === null && !sharing.readSharing().projects.length, 'turned off: private again, no reason');
});

/** CLIENT shares P (auto) across Me's and CLIENT's apps — the starting point for hide/restore tests. */
async function sharedWithClient(s: Sandbox) {
  fourApps(s);
  const m = sharing.planMigration(s.accounts, [P], none);
  await apply(m.op);
  sharing.cleanupStaging(m.staging);
  const ctx = apps.syncContext(await desktop.listDesktopProfiles(emails), terms(s), false);
  const on = sharing.planShare({ project: P, accounts: ['client'], desktop: [], auto: true }, s.accounts, none, ctx);
  await apply(on.op);
  sharing.cleanupStaging(on.staging);
  // non-index files in the account's list folder are never hidden
  fs.writeFileSync(path.join(s.folder('Claude-Claude Client', FT, 'org-ft'), 'scheduled-tasks.json'), JSON.stringify({ cwd: P }));
  writeIndex(s.folder('Claude-Claude Client', FT, 'org-ft'), 'deep', P + '/.claude/worktrees/x', { title: 'worktree chat' }, Date.now() - 50_000);
  return ctx;
}
const ftApps = ['Claude-Claude Client', 'Claude-Side', 'Claude-Cs Test'];
const pFiles = (dir: string) => fs.readdirSync(dir).filter((n) => /^local_.*\.json$/.test(n) && sharing.insideProject(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).cwd, P));

test('unshare hides the project’s chats from the account’s desktop apps (never account 1’s); idempotent; undo', async (s) => {
  const ctx = await sharedWithClient(s);
  const meDir = s.folder('Claude', ME, 'org-me');
  const meBefore = tree(meDir);
  const leftoverBefore = tree(s.folder('Claude', FT, 'org-ft'));
  const storeBefore = tree(s.store);
  ok(pFiles(s.folder('Claude-Side', FT, 'org-ft')).length >= 3, 'CLIENT apps list P chats before');
  const off = sharing.planShare({ project: P, accounts: [], desktop: [], auto: true }, s.accounts, none, ctx);
  ok(off.hidden.length === 1 && off.hidden[0].apps.join() === ftApps.slice().sort().join(), `hides from every CLIENT app (${off.hidden[0]?.apps})`);
  const pv = await safety.previewOperation(off.op);
  ok(!pv.refused.length, `guard allows the hide (${pv.refused[0] ?? ''})`);
  ok(pv.notes.some((n) => /Hidden from Claude Client \(CLIENT\)/.test(n) && /"worktree chat"/.test(n) && /"kept version"|"side version"/.test(n)), 'preview lists the exact chats by title, per app');
  ok(pv.lines.some((l) => /^hide sidebar entry/.test(l)), 'dry run shows each move');
  const j = await apply(off.op);
  sharing.cleanupStaging(off.staging);
  for (const a of ftApps) ok(pFiles(s.folder(a, FT, 'org-ft')).length === 0, `${a}: no P chats left in the sidebar`);
  ok(fs.existsSync(path.join(s.folder('Claude-Claude Client', FT, 'org-ft'), 'local_f2.json')), 'other projects stay listed');
  ok(fs.existsSync(path.join(s.folder('Claude-Claude Client', FT, 'org-ft'), 'scheduled-tasks.json')), 'non-local_ files never hidden');
  ok(same(meBefore, tree(meDir)) && same(leftoverBefore, tree(s.folder('Claude', FT, 'org-ft'))), 'account 1’s app (and its leftover list) untouched');
  ok(same(storeBefore, tree(s.store)), 'transcripts untouched');
  const bundle = off.hidden[0].bundle;
  ok(path.dirname(bundle) === roots.hiddenDir() && /^\d{8}-\d{6}-client-acme-app$/.test(path.basename(bundle)), `bundle named <stamp>-client-acme-app (${path.basename(bundle)})`);
  const man = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8')) as sharing.HiddenManifest;
  ok(man.files.length === off.hidden[0].files.length && man.files.every((f) => safety.sha256File(path.join(bundle, f.stored)) === f.sha256 && f.source.includes('claude-code-sessions')), 'manifest: every stored file matches its sha256 and source');
  ok(fs.existsSync(path.join(bundle, FT, 'org-ft', 'local_deep.json')), 'layout <acct>/<org>/local_*.json');
  // idempotent: off again hides nothing
  const again = sharing.planShare({ project: P, accounts: [], desktop: [], auto: true }, s.accounts, none, ctx);
  ok(again.hidden.length === 0 && !again.op.steps.some((x) => x.t === 'hide'), 'second unshare: nothing to hide');
  // undo brings the entries back
  const u = await safety.planUndo(j.id);
  await apply(u.op, { undoOf: j.id });
  safety.cleanupWork(u.work);
  ok(pFiles(s.folder('Claude-Side', FT, 'org-ft')).length >= 3 && !fs.existsSync(bundle), 'undo: entries back, bundle gone (quarantined)');
});

test('re-share restores hidden entries (newer file kept), then idempotent', async (s) => {
  const ctx = await sharedWithClient(s);
  const off = sharing.planShare({ project: P, accounts: [], desktop: [], auto: true }, s.accounts, none, ctx);
  await apply(off.op);
  sharing.cleanupStaging(off.staging);
  const kept = s.folder('Claude-Claude Client', FT, 'org-ft');
  writeIndex(kept, 'deep', P + '/.claude/worktrees/x', { title: 'newer in the app' }, Date.now()); // the app re-created it, newer
  const on = sharing.planShare({ project: P, accounts: ['client'], desktop: [], auto: true }, s.accounts, none, ctx);
  ok(on.restored.length === 1 && on.restored[0].kept >= 1, 'restore plans every entry, keeps the newer one');
  const pv = await safety.previewOperation(on.op);
  ok(!pv.refused.length && pv.notes.some((n) => /Back in Claude Client/.test(n)), 'preview names where the chats come back');
  await apply(on.op);
  sharing.cleanupStaging(on.staging);
  ok(JSON.parse(fs.readFileSync(path.join(kept, 'local_deep.json'), 'utf8')).title === 'newer in the app', 'newer existing file not overwritten');
  for (const a of ftApps) ok(pFiles(s.folder(a, FT, 'org-ft')).length >= 3, `${a}: P chats back`);
  ok(!fs.existsSync(off.hidden[0].bundle) && fs.existsSync(path.join(roots.hiddenDir(), 'restored', path.basename(off.hidden[0].bundle), 'manifest.json')), 'bundle kept under hidden/restored');
  ok(fs.existsSync(path.join(roots.hiddenDir(), 'restored', path.basename(off.hidden[0].bundle), FT, 'org-ft', 'local_deep.json')), 'the losing hidden version stays in the backup');
  const again = sharing.planShare({ project: P, accounts: ['client'], desktop: [], auto: true }, s.accounts, none, ctx);
  ok(again.restored.length === 0, 'second share: nothing to restore');
});

test('hide refuses while the account’s desktop app runs; primary account’s apps never hidden', async (s) => {
  const ctx = await sharedWithClient(s);
  const ftDir = path.join(s.sup, 'Claude-Claude Client');
  safety.setEngineHooks({ busy: async (t) => (t.some((x) => safety.classify(x).profileDir?.toLowerCase() === ftDir.toLowerCase()) ? ['Claude Client — Claude desktop app (pid 9)'] : []) });
  const before = tree(path.join(s.sup));
  const off = sharing.planShare({ project: P, accounts: [], desktop: [], auto: true }, s.accounts, none, ctx);
  const pv = await safety.previewOperation(off.op);
  ok(pv.busy.length === 1, 'preview says the app must quit');
  const nJ = safety.listJournal().length;
  await throws(() => apply(off.op), /Quit these first/, 'refused while running');
  ok(same(before, tree(s.sup)) && safety.listJournal().length === nJ && !fs.existsSync(roots.hiddenDir()), 'nothing moved, no journal, no bundle');
  safety.setEngineHooks({ busy: async () => [] });
  sharing.cleanupStaging(off.staging);
  // an account signed in as account 1 (same email) is never hidden from
  const sameAsMe = { ...ctx, accountUuids: { ...ctx.accountUuids, client: ME } };
  const h = sharing.planHide(s.client, P, sameAsMe);
  ok(h.primary && h.files.length === 0 && h.steps.length === 0, 'same account as account 1: nothing hidden');
  ok(sharing.hideTargets({ id: 'default' }, ctx).folders.length === 0, 'account 1 itself has no hide targets');
  ok(safety.guardStep({ t: 'hide', path: path.join(s.sup, 'Claude-Side', 'Preferences'), to: path.join(roots.hiddenDir(), 'x', 'p') }) !== null, 'guard: only local_*.json can be hidden');
  ok(safety.guardStep({ t: 'hide', path: path.join(s.folder('Claude-Side', FT, 'org-ft'), 'local_w9.json'), to: path.join(s.home, 'elsewhere.json') }) !== null, 'guard: only into the hidden folder');
});

test('restore handles a hand-made hidden folder without a manifest', async (s) => {
  fourApps(s);
  const m = sharing.planMigration(s.accounts, [P], none);
  await apply(m.op);
  sharing.cleanupStaging(m.staging);
  const ctx = apps.syncContext(await desktop.listDesktopProfiles(emails), terms(s), false);
  const off = sharing.planShare({ project: P, accounts: [], desktop: [], auto: true }, s.accounts, none, ctx);
  await apply(off.op);
  sharing.cleanupStaging(off.staging);
  for (const n of fs.readdirSync(roots.hiddenDir())) fs.renameSync(path.join(roots.hiddenDir(), n), path.join(s.root, `moved-${n}`)); // start from the hand-made one only
  const legacy = path.join(roots.hiddenDir(), '20261025-152543-client-acme-app', FT, 'org-ft');
  for (const id of ['h1', 'h2', 'h3']) writeIndex(legacy, id, P, { title: `hand ${id}` }, Date.now() - 30_000);
  fs.writeFileSync(path.join(legacy, 'scheduled-tasks.json'), '{}');
  const found = sharing.findHidden('client', P, ctx);
  ok(found.length === 1 && found[0].legacy && found[0].manifest.files.filter((f) => f.profile === 'Claude-Claude Client').length === 3, 'no manifest: every local_*.json is restorable to the account’s apps (Claude Client among them)');
  const on = sharing.planShare({ project: P, accounts: ['client'], desktop: [], auto: true }, s.accounts, none, ctx);
  ok(!on.op.steps.some((x) => x.path.endsWith('manifest.json')), 'no manifest written for it');
  await apply(on.op);
  sharing.cleanupStaging(on.staging);
  const kept = s.folder('Claude-Claude Client', FT, 'org-ft');
  ok(['h1', 'h2', 'h3'].every((id) => fs.existsSync(path.join(kept, `local_${id}.json`))), 'restored into Claude Client');
  ok(!fs.existsSync(path.join(kept, 'scheduled-tasks.json')), 'non-local_ file not restored');
  ok(fs.existsSync(path.join(roots.hiddenDir(), 'restored', '20261025-152543-client-acme-app', FT, 'org-ft', 'scheduled-tasks.json')), 'hand-made folder kept (moved to hidden/restored)');
});

test('manual limits note is gone from the UI; automatic usage or "Usage unavailable — Refresh"', () => {
  const repo = path.resolve(__dirname, '..');
  const app = fs.readFileSync(path.join(repo, 'src', 'App.tsx'), 'utf8');
  const card = fs.readFileSync(path.join(repo, 'src', 'UsageCard.tsx'), 'utf8');
  const main = fs.readFileSync(path.join(repo, 'electron', 'main.ts'), 'utf8');
  ok(!/Limits note|No reset time noted|limitResetAt|limitNote/.test(app), 'no limits note, reset picker or "No reset time noted" in the account UI');
  ok(/Usage unavailable —/.test(card) && /usageRefresh/.test(card), 'fallback text with a Refresh action');
  ok(/allowed: \(keyof typeof patch\)\[\] = \['name', 'color'\]/.test(main), 'stored limitNote/limitResetAt are ignored (no longer writable)');
});

// ---------- fair use ----------

const fa = (id: string, extra: Partial<fairuse.FairUseAccount> = {}): fairuse.FairUseAccount => ({ id, name: id.toUpperCase(), configDir: `/nonexistent/${id}`, ...extra });
const SECRET = 'sk-ant-oat01-SECRET-TOKEN-DO-NOT-READ';

test('fair use 1: account kind auto-detected from non-secret fields only; unknown falls back to asking', (s) => {
  const write = (dir: string, oauth: Record<string, unknown>) => fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com', accessToken: SECRET, refreshToken: SECRET, ...oauth }, primaryApiKey: SECRET }));
  write(s.home, { organizationType: 'claude_max', billingType: 'stripe_subscription' });
  write(s.client.configDir, { organizationType: 'claude_enterprise' });
  write(s.work2.configDir, { organizationRole: 'admin', billingType: 'stripe_subscription' });
  const def = s.accounts[0];
  const h = fairuse.readKindHints(def);
  ok(JSON.stringify(h).indexOf(SECRET) < 0 && !('accessToken' in h) && !('emailAddress' in h), 'only allow-listed keys are copied out — never tokens');
  ok(Object.keys(h).every((k) => (fairuse.KIND_HINT_KEYS as readonly string[]).includes(k)), 'hint keys ⊆ KIND_HINT_KEYS');
  ok(!(fairuse.KIND_HINT_KEYS as readonly string[]).some((k) => /token|key|secret|credential|password/i.test(k)), 'allow-list holds no credential-like key');
  ok(fairuse.detectKind(def)?.kind === 'personal', 'claude_max → Personal');
  ok(fairuse.detectKind(s.client)?.kind === 'work', 'claude_enterprise → Work');
  ok(fairuse.detectKind(s.work2) === null, 'role "admin" + stripe billing alone → unknown (ask)');
  ok(fairuse.detectKind(s.work2, 'team')?.kind === 'work' && fairuse.detectKind(s.work2, 'pro')?.kind === 'personal', 'subscriptionType from `claude auth status` decides');
  ok(fairuse.kindFromHints({ organizationType: 'promotional' }) === null, '"pro" must be a whole word');
  const acc = fa('x', { kind: 'work', kindSource: 'user' });
  ok(fairuse.reconcileKind(acc, { kind: 'personal', hint: 'subscription: max' }) && acc.kind === 'personal' && acc.kindSource === 'detected', 'detection overrides a user choice');
  ok(!fairuse.reconcileKind(acc, null) && acc.kind === 'personal', 'no detection leaves it alone');
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'fairuse.ts'), 'utf8');
  ok(!/keychain|find-generic-password|\.credentials|accessToken|refreshToken/i.test(src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'fairuse.ts code never touches the Keychain or token fields');
});

test('fair use 2: ownership attestation is required and timestamped', () => {
  const accounts = [fa('default', { kind: 'work', attestedAt: '2026-01-01T00:00:00.000Z' })];
  const n = fa('new');
  void throws(() => fairuse.validateAttest(accounts, n, { kind: 'work' }), /This account is mine, and only I use it/, 'no tick → refused');
  void throws(() => fairuse.validateAttest(accounts, n, { kind: 'work', attested: 'yes' as any }), /mine/, 'only literal true counts');
  void throws(() => fairuse.validateAttest(accounts, n, { attested: true }), /Personal or a Work/, 'kind is required');
  accounts.push(n);
  ok(fairuse.fairUseProblem(accounts, n)?.code === 'attest', 'an unconfirmed account cannot be launched');
  const t = new Date('2026-10-25T12:00:00Z');
  fairuse.applyAttest(accounts, n, { kind: 'work', attested: true }, t);
  ok(n.attestedAt === t.toISOString() && n.kind === 'work' && n.kindSource === 'user', 'timestamp + kind stored');
  ok(fairuse.fairUseProblem(accounts, n) === null, 'confirmed → launchable');
  const k = fa('k', { attestedAt: t.toISOString() });
  ok(fairuse.fairUseProblem([...accounts, k], k)?.code === 'kind', 'unknown kind → asked before launch');
});

test('fair use 3: a second Personal plan needs the explicit "not to get around usage limits" tick', async () => {
  const at = '2026-01-01T00:00:00.000Z';
  const accounts = [fa('default', { kind: 'personal', attestedAt: at }), fa('work', { kind: 'work', attestedAt: at })];
  const p2 = fa('p2');
  await throws(() => fairuse.validateAttest(accounts, p2, { kind: 'personal', attested: true }), /second Personal plan.*get around usage limits/, 'second Personal without the tick → refused');
  ok(fairuse.validateAttest(accounts, p2, { kind: 'personal', attested: true, notLimitDodging: true }) === 'personal', 'with the tick → allowed');
  ok(fairuse.validateAttest(accounts, fa('w2'), { kind: 'work', attested: true }) === 'work', 'a Work account never needs it');
  ok(fairuse.validateAttest([fa('w', { kind: 'work' })], fa('first'), { kind: 'personal', attested: true }) === 'personal', 'the FIRST Personal account never needs it');
  accounts.push(p2);
  fairuse.applyAttest(accounts, p2, { kind: 'personal', attested: true, notLimitDodging: true });
  ok(!!p2.limitsAckAt && fairuse.fairUseProblem(accounts, p2) === null, 'tick timestamped; launchable');
  ok(!fairuse.needsLimitsAck(accounts, accounts[0]), 'the first Personal account (Account 1) is not affected by later ones');
  // added as Work, detected Personal after sign-in → launch blocked until the tick
  const p3 = fa('p3', { kind: 'work', kindSource: 'user', attestedAt: at });
  accounts.push(p3);
  fairuse.reconcileKind(p3, { kind: 'personal', hint: 'subscription: pro' });
  ok(fairuse.fairUseProblem(accounts, p3)?.code === 'limits', 'detected 2nd Personal → must confirm limits before launch');
  await throws(() => fairuse.validateAttest(accounts, p3, { kind: 'work', attested: true }), /second Personal plan/, 'a detected kind cannot be overridden to dodge the tick');
});

test('fair use 4: no limit-dodging UX — no limit notifications, badges, warn threshold or "use another account" paths', () => {
  const repo = path.resolve(__dirname, '..');
  const read = (...p: string[]) => fs.readFileSync(path.join(repo, ...p), 'utf8');
  const main = read('electron', 'main.ts');
  const src = ['App.tsx', 'UsageCard.tsx', 'Accounts.tsx', 'Sharing.tsx', 'Onboarding.tsx', 'FairUse.tsx', 'tray/TrayApp.tsx'].map((f) => read('src', f)).join('\n') + main + read('electron', 'ops-ipc.ts');
  ok(!/new Notification\(/.test(main), 'main sends no OS notifications (none about limits)');
  ok(!/setBadge\(\s*(?!'')/.test(main.replace(/setBadge\(''\)/g, '')), 'no dock badge counting accounts near their limit');
  ok(!/usageWarnPct|usageNotified|checkWarnings|Warn at|Over \{warnPct\}/.test(src + read('electron', 'preload.ts')), 'warning threshold, notified list and "Over N%" are gone');
  ok(!/⚠/.test(main), 'tray title shows no ⚠ next to the usage percentage');
  const nudge = /(switch|move|continue|hand ?off)[^\n]{0,40}(another|other|next) account[^\n]{0,40}(limit|usage)|(limit|usage)[^\n]{0,60}(switch|try|use|continue (in|with))[^\n]{0,20}(another|other|next) account/i;
  // lines that say what NOT to do (the fair-use Don't list, "never …") are the opposite of a nudge
  const offenders = src.split('\n').filter((l) => nudge.test(l) && !/\b(don'?t|never|won'?t|not|ban|banned|suspended)\b/i.test(l));
  ok(!offenders.length, `no copy that points to another account when one is limited (${offenders[0]?.trim().slice(0, 80) ?? ''})`);
  ok(!/autoRotate|rotateAccount|nextAccount|fallbackAccount/i.test(src), 'no automatic rotation');
  const notesForLimit = /Notification\([^)]*(limit|usage)/i;
  ok(!notesForLimit.test(read('electron', 'ops-ipc.ts')), 'ops-ipc sends no limit notifications');
});

test('fair use 5: sharing into / out of a Work account shows the organization notices', async (s) => {
  const accs = [fa('default', { kind: 'personal' }), fa('work', { kind: 'work' }), fa('p2', { kind: 'personal' }), fa('w2', { kind: 'work' })];
  const into = fairuse.shareNotices(accs, [], ['work']);
  ok(into.length === 1 && /Your organization's admin may be able to see these chats/.test(into[0]), 'Personal → Work: admin notice');
  const out = fairuse.shareNotices(accs, ['work'], ['work', 'p2']);
  ok(out.some((n) => /may move your employer's code\/data into a personal account/.test(n) && /check your company's policy/.test(n)), 'Work → Personal: employer data notice');
  ok(fairuse.shareNotices(accs, ['work'], ['work']).length === 0, 'unchanged sharing → no notice');
  ok(fairuse.shareNotices(accs, [], ['p2']).length === 0, 'Personal → Personal → no notice');
  const workDefault = [fa('default', { kind: 'work' }), fa('p2', { kind: 'personal' })];
  ok(fairuse.shareNotices(workDefault, [], ['p2']).some((n) => /employer's code/.test(n)), 'Account 1 is a Work account → sharing into Personal warns');
  // and the notice reaches the preview the user sees (planShare op.notes are what the preview shows)
  const r = sharing.planShare({ project: P, accounts: ['work2'], desktop: [], auto: false }, s.accounts, none);
  r.op.notes = [...fairuse.shareNotices([fa('default', { kind: 'personal' }), fa('work2', { kind: 'work' })], [], ['work2']), ...(r.op.notes ?? [])];
  const pv = await safety.previewOperation(r.op);
  ok(pv.notes.some((n) => /admin may be able to see these chats/.test(n)), 'preview shows the admin notice');
  sharing.cleanupStaging(r.staging);
});

test('fair use 6: suspension detection is conservative; a suspended account’s projects are not continued elsewhere', () => {
  const yes = [
    'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Your account has been suspended. Contact support."}}',
    'Error: This account has been disabled.',
    'Your organization has been disabled.',
    'account_suspended',
    'Your account was banned for violating the Usage Policy.',
  ];
  const no = [
    'OAuth token has expired. Please run /login',
    'Invalid API key · Please run /login',
    'Claude AI usage limit reached|1761400000',
    'Accounts may be suspended if they violate the Usage Policy.',
    'Your account will be suspended if payment fails.',
    'Your account has not been suspended.',
    'Your account has been reinstated.',
    'Network error: ECONNRESET',
    'Rate limited — try again later',
    'Disabled MCP server: github',
    '',
  ];
  for (const t of yes) ok(!!fairuse.detectSuspension(t), `suspended: ${t.slice(0, 50)}`);
  for (const t of no) ok(fairuse.detectSuspension(t) === null, `not suspended: ${t.slice(0, 50) || '(empty)'}`);
  const at = '2026-01-01T00:00:00.000Z';
  const accs = [fa('default', { kind: 'personal', attestedAt: at }), fa('work', { kind: 'work', attestedAt: at }), fa('p2', { kind: 'personal', attestedAt: at, limitsAckAt: at })];
  ok(fairuse.applySuspension(accs[2], { suspended: fairuse.detectSuspension(yes[0]) }) && !!accs[2].suspended, 'marked Suspended');
  const use = fairuse.recordProjectUse({}, P, 'p2');
  const b = fairuse.continueBlock(P, 'default', accs, use, []);
  ok(!!b && /violates Anthropic's Usage Policy/.test(b.message) && b.support === 'https://support.anthropic.com', 'continuing its project in another account is refused, with support link');
  ok(fairuse.continueBlock(Q, 'default', accs, use, []) === null, 'other projects are unaffected');
  ok(fairuse.continueBlock(P, 'p2', accs, use, []) === null, 'not refused for the suspended account itself (Claude Code decides)');
  ok(!!fairuse.continueBlock(Q, 'work', accs, {}, [{ path: Q, accounts: ['p2'] }]), 'a project shared with the suspended account counts too');
  const d = fa('default', { suspended: { at, reason: 'x' } });
  ok(!!fairuse.continueBlock(P, 'work', [d, accs[1]], {}, [{ path: P, accounts: ['work'] }]), 'Account 1 suspended → its shared projects stay put');
  ok(fairuse.applySuspension(accs[2], { ok: true }) && !accs[2].suspended, 'a later normal limits read clears it');
  ok(!fairuse.applySuspension(accs[2], { suspended: null, ok: false }), 'an ordinary error changes nothing');
  // wired into the probe + ops paths
  const usage = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'usage.ts'), 'utf8');
  const ops = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'ops-ipc.ts'), 'utf8');
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.ts'), 'utf8');
  ok(/detectSuspension\(/.test(usage) && /continueBlock\(/.test(ops) && /launchGate\(/.test(main), 'usage probe detects it; launch and share both refuse');
});

test('fair use 7: usage checks only on app open / Refresh, at most once per 15 min per account, never polled', () => {
  const g = new fairuse.ProbeGate();
  const t0 = 1_800_000_000_000;
  ok(g.check('a', 'app-open', t0).ok, 'first check on open is allowed');
  g.mark('a', t0);
  const r = g.check('a', 'refresh', t0 + 14 * 60_000);
  ok(!r.ok && (r as any).nextAt === t0 + 15 * 60_000, 'Refresh within 15 min is refused, with the next allowed time');
  ok(g.check('b', 'refresh', t0 + 60_000).ok, 'per account: another account is independent');
  ok(g.check('a', 'refresh', t0 + 15 * 60_000).ok, 'allowed again after 15 min');
  ok(!g.check('c', 'refresh', t0, t0 - 5 * 60_000).ok, 'a probe persisted on disk 5 min ago (before a restart) still counts');
  ok(!g.check('d', 'timer' as any, t0).ok, 'any other trigger (e.g. a timer) is refused');
  const repo = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(repo, 'electron', 'main.ts'), 'utf8');
  const usage = fs.readFileSync(path.join(repo, 'electron', 'usage.ts'), 'utf8');
  const intervals = [...main.matchAll(/setInterval\(([\s\S]*?)\},\s*\d[\d_]*\)/g)].map((m) => m[1]);
  ok(intervals.length > 0 && intervals.every((b) => !/refreshUsage|probeUsage|checkUsageOnOpen|autoRefresh/.test(b)), 'no setInterval in main runs a usage check');
  const focus = main.match(/win\.on\('focus'[\s\S]*?\}\);/)?.[0] ?? '';
  ok(!!focus && !/refreshUsage|probeUsage|autoRefresh/.test(focus), 'window focus does not check usage');
  ok([...main.matchAll(/refreshUsage\([^)]*\)/g)].every((m) => /'app-open'|'refresh'|trigger\)/.test(m[0]) || /refreshUsage\(id: string/.test(m[0])), 'every refreshUsage call names app-open or refresh');
  ok(/usageGate\.check\(/.test(usage) && /probeUsage\(acc: Account, trigger: UsageTrigger\)/.test(usage), 'the gate sits in front of the only /usage spawn');
});

test('fair use 8: single person — no export/sync of sessions to other people or machines; docs say so', () => {
  const repo = path.resolve(__dirname, '..');
  const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  const fu = fs.readFileSync(path.join(repo, 'FAIR-USE.md'), 'utf8');
  ok(/no export or sync of sessions to other people or machines/i.test(readme) && /## Fair use/.test(readme), 'README states it');
  for (const l of [fairuse.LINKS.aup, fairuse.LINKS.consumerTerms, fairuse.LINKS.claudeCodeLegal]) ok(fu.includes(l) && readme.includes(l), `links ${l}`);
  ok(/Not legal advice/i.test(fu) && /not affiliated/i.test(fu), 'disclaimers present');
  const ui = fs.readFileSync(path.join(repo, 'src', 'FairUse.tsx'), 'utf8');
  ok(/Not legal advice/.test(ui) && /not affiliated/.test(ui) && /This account is mine, and only I use it\./.test(ui), 'in-app Fair use screen has the attestation text and disclaimers');
});

// ---------- compatibility with the old name (Claude Switch) ----------

test('new install: state in ~/.baton, app copies in Baton/apps, userData "Baton"', (s) => {
  ok(roots.roots().appDir === path.join(s.home, '.baton'), `state folder is ~/.baton (${roots.roots().appDir})`);
  ok(roots.roots().appsDir === path.join(s.sup, 'Baton', 'apps') && desktop.CLONES === roots.roots().appsDir, 'app copies go to Baton/apps');
  ok(roots.resolveUserData(s.sup) === path.join(s.sup, 'Baton'), 'userData is "Baton"');
  ok(roots.journalDir().startsWith(path.join(s.home, '.baton')) && roots.sharingFile().startsWith(path.join(s.home, '.baton')), 'journal and sharing live in ~/.baton');
  ok(!fs.existsSync(path.join(s.home, '.claude-switch')) && !fs.existsSync(path.join(s.sup, 'claude-switch')), 'no old-name folders created');
});

test('existing install: ~/.claude-switch, claude-switch/apps and "Claude Switch" keep being used; nothing moved', async (s) => {
  const old = path.join(s.home, '.claude-switch');
  for (const [f, d] of [['state.json', '{"accounts":[]}'], ['sharing.json', '{"version":1,"projects":[]}'], ['journal/op-1.json', '{}'], ['snapshots/snap-1/manifest.json', '{}'], ['hidden/20260101-000000-a-p/x/y/local_1.json', '{}'], ['launch/default-launch.sh', '#!/bin/sh\n']] as const) {
    fs.mkdirSync(path.dirname(path.join(old, f)), { recursive: true });
    fs.writeFileSync(path.join(old, f), d);
  }
  const oldApps = path.join(s.sup, 'claude-switch', 'apps');
  fs.mkdirSync(path.join(oldApps, 'Claude Old.app', 'Contents'), { recursive: true });
  fs.mkdirSync(path.join(s.sup, 'Claude Switch'), { recursive: true });
  fs.writeFileSync(path.join(s.sup, 'Claude Switch', 'Preferences'), '{}');
  const before = { state: tree(old), apps: tree(path.join(s.sup, 'claude-switch')), ud: tree(path.join(s.sup, 'Claude Switch')) };
  desktop.setRootsForTest(s.root, roots.roots().claudeApp, s.home); // what a restart of the renamed app sees
  ok(roots.roots().appDir === old, `keeps ~/.claude-switch (${roots.roots().appDir})`);
  ok(roots.sharingFile() === path.join(old, 'sharing.json') && roots.hiddenDir() === path.join(old, 'hidden'), 'sharing + hidden read from the old folder');
  ok(roots.roots().appsDir === oldApps && desktop.CLONES === oldApps, 'keeps claude-switch/apps for app copies');
  ok(roots.resolveUserData(s.sup) === path.join(s.sup, 'Claude Switch'), 'keeps the "Claude Switch" userData');
  ok(safety.classify(path.join(oldApps, 'Claude Old.app')).area === 'app-copies', 'old app copies still recognised as rebuildable copies');
  // a real operation runs against the old folder: snapshot + journal land there
  const r = sharing.planMigration(s.accounts, [P], none);
  await apply(r.op);
  sharing.cleanupStaging(r.staging);
  ok(fs.readdirSync(path.join(old, 'journal')).length > 1, 'journal written into ~/.claude-switch');
  ok(!fs.existsSync(path.join(s.home, '.baton')) && !fs.existsSync(path.join(s.sup, 'Baton')), 'no ~/.baton or Baton/ created alongside');
  const after = { apps: tree(path.join(s.sup, 'claude-switch')), ud: tree(path.join(s.sup, 'Claude Switch')) };
  ok(JSON.stringify(after) === JSON.stringify({ apps: before.apps, ud: before.ud }), 'old app copies and userData untouched');
  for (const f of ['state.json', 'snapshots/snap-1/manifest.json', 'hidden/20260101-000000-a-p/x/y/local_1.json', 'launch/default-launch.sh']) ok(before.state[f] !== undefined && tree(old)[f] === before.state[f], `${f} kept in place`);
});

// ---------- tray popover ----------

test('tray popover: anchored under the menu-bar icon, centred, clamped to the display (multi-display, edges)', () => {
  const size = { width: 360, height: 480 };
  const W = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });
  // main display 1512×982, menu bar 24 px (work area starts at y=24)
  const b1 = W(0, 0, 1512, 982), wa1 = W(0, 24, 1512, 958);
  const mid = trayLogic.popoverPosition(W(1000, 0, 24, 24), wa1, b1, size);
  ok(mid.edge === 'top' && mid.y === 24 + trayLogic.POPOVER_GAP, `just under the menu bar (y=${mid.y})`);
  ok(mid.x === Math.round(1012 - 180), `centred on the icon (x=${mid.x})`);
  const right = trayLogic.popoverPosition(W(1490, 0, 22, 24), wa1, b1, size);
  ok(right.x === 1512 - 360 - trayLogic.POPOVER_MARGIN, `clamped at the right edge (x=${right.x})`);
  const left = trayLogic.popoverPosition(W(4, 0, 22, 24), wa1, b1, size);
  ok(left.x === trayLogic.POPOVER_MARGIN, `clamped at the left edge (x=${left.x})`);
  // second display to the left and higher up (negative coordinates), its own menu bar
  const b2 = W(-1920, -300, 1920, 1080), wa2 = W(-1920, -275, 1920, 1055);
  const second = trayLogic.popoverPosition(W(-400, -300, 24, 25), wa2, b2, size);
  ok(second.edge === 'top' && second.y === -275 + trayLogic.POPOVER_GAP && second.x === Math.round(-388 - 180), `follows the icon onto the other display (${second.x},${second.y})`);
  ok(second.x >= wa2.x && second.x + second.width <= wa2.x + wa2.width, 'stays inside that display');
  // a bottom bar (icon in the lower half): opens above the icon
  const bottom = trayLogic.popoverPosition(W(800, 1040, 24, 40), W(0, 0, 1920, 1040), W(0, 0, 1920, 1080), size);
  ok(bottom.edge === 'bottom' && bottom.y + bottom.height <= 1040 - trayLogic.POPOVER_GAP + 0.5, `above a bottom bar (y=${bottom.y})`);
  // tall content: capped at 560 and at the work area
  const tall = trayLogic.popoverPosition(W(1000, 0, 24, 24), wa1, b1, { width: 360, height: 2000 });
  ok(tall.height === trayLogic.POPOVER_MAX_HEIGHT, `capped at ${trayLogic.POPOVER_MAX_HEIGHT} (${tall.height})`);
  const small = trayLogic.popoverPosition(W(600, 0, 24, 24), W(0, 24, 800, 400), W(0, 0, 800, 424), { width: 360, height: 2000 });
  ok(small.height === 400 - 2 * trayLogic.POPOVER_MARGIN && small.y + small.height <= 424, `fits a short screen (${small.height})`);
  // icon not laid out yet: main passes the cursor as a 0×0 rect
  const cursor = trayLogic.popoverPosition(W(700, 10, 0, 0), wa1, b1, size);
  ok(cursor.x === 520 && cursor.y === 24 + trayLogic.POPOVER_GAP, 'falls back to the cursor position');
});

test('native menus: a literal "&" is escaped (no eaten mnemonic in "History & restore")', () => {
  ok(trayLogic.menuLabel('History & restore…') === 'History && restore…', 'doubled');
  ok(trayLogic.menuLabel('R&D & ops') === 'R&&D && ops', 'every one');
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.ts'), 'utf8');
  const raw = main.split('\n').filter((l) => /label: '[^']*&[^&]/.test(l) && !/menuLabel\(/.test(l));
  ok(!raw.length, `no raw "&" in a native menu label (${raw[0]?.trim() ?? ''})`);
  ok(!/tray\.setContextMenu\(/.test(main), 'left click is the popover (no setContextMenu); right click pops the native menu');
  ok(/tray\.on\('right-click'[\s\S]{0,120}popUpContextMenu\(trayMenu\)/.test(main), 'right click = native menu fallback');
});

test('tray popover: same fair-use gates as the main window; usage stays informational and gated', () => {
  // the gate itself
  const accs = [fa('default', { kind: 'personal', attestedAt: 't' }), fa('p2', { kind: 'personal', attestedAt: 't' }), fa('w', { kind: 'work' }), fa('x', { kind: 'work', attestedAt: 't', suspended: { at: 't', reason: 'Your account has been suspended' } })];
  const g1 = fairuse.launchGate(accs, accs[2], P);
  ok(g1?.status === 'fairuse' && g1.problem.code === 'attest', 'unconfirmed account → the confirmation dialog');
  const g2 = fairuse.launchGate(accs, accs[1], P);
  ok(g2?.status === 'fairuse' && g2.problem.code === 'limits', 'second Personal plan without the tick → refused');
  const g3 = fairuse.launchGate(accs, accs[0], P, { [P]: ['x'] });
  ok(g3?.status === 'suspended' && /suspended/.test(g3.message), 'project used by a suspended account → refused');
  ok(fairuse.launchGate(accs, accs[0], Q, { [P]: ['x'] }) === null, 'everything confirmed → allowed');
  // refusals are routed to the main window's dialogs, never launched
  const r1 = trayLogic.routeLaunchResult('w', g1 as any);
  ok(r1.kind === 'window' && r1.event === 'launchBlocked', 'fair-use refusal → main window dialog');
  const r2 = trayLogic.routeLaunchResult('default', g3 as any);
  ok(r2.kind === 'window' && r2.event === 'launchBlocked', 'suspended refusal → main window explanation');
  ok(trayLogic.routeLaunchResult('w', { status: 'conflict', conflicts: [1] }).kind === 'window', 'conflict → main window');
  ok(trayLogic.routeLaunchResult('w', { status: 'launched', command: 'c', dryRun: true }).kind === 'done', 'launched → done');

  // wiring: popover → trayContinue → continueFromTray → launch() → launchGate; native menu uses the same function
  const repo = path.resolve(__dirname, '..');
  const read = (...p: string[]) => fs.readFileSync(path.join(repo, ...p), 'utf8');
  const main = read('electron', 'main.ts');
  const fnBody = (name: string) => main.slice(main.indexOf(`function ${name}(`), main.indexOf('\n}\n', main.indexOf(`function ${name}(`)));
  ok(/launchGate\(state\.accounts, acc, opts\.project/.test(fnBody('launch')), 'launch() runs launchGate');
  ok(/await launch\(\{ accountId, project: state\.project, continueLast: true \}\)/.test(fnBody('continueFromTray')), 'continueFromTray goes through launch()');
  ok(/ipcMain\.handle\('trayContinue'[\s\S]{0,140}continueFromTray\(id\)/.test(main), 'the popover\'s Continue calls continueFromTray');
  ok(/click: \(\) => void continueFromTray\(a\.id\)/.test(main), 'the native menu calls the same function');
  ok((main.match(/runAppleScript\(appleScriptFor\(writeLaunchScript\(acc, opts\.project/g) ?? []).length === 1, 'only launch() opens Terminal for a project');
  // the popover's preload is a narrow surface: no direct launch, no confirming accounts, no operations
  const pre = read('electron', 'tray-preload.ts');
  for (const ch of ["'launch'", "'fairUseConfirm'", "'fairUseAttestAll'", "'opApply'", "'opPlan'", "'usageHook'", "'desktopOpen'"]) ok(!pre.includes(ch), `tray preload does not expose ${ch}`);
  ok(/usageRefresh: invoke\('usageRefresh'\)/.test(pre), 'usage refresh uses the same gated IPC (usageGate in usage.ts)');
  ok(/contextIsolation: true,\s*sandbox: true,\s*nodeIntegration: false/.test(fnBody('createPopover')), 'popover: contextIsolation on, sandbox on, nodeIntegration off');
  // usage is informational: no sorting by quota, no alarm colour, gate shown as "next check in N min"
  const ui = read('src', 'tray', 'TrayApp.tsx'), css = read('src', 'tray', 'tray.css');
  ok(!/\.sort\(|toSorted\(/.test(ui), 'accounts are never sorted (order added)');
  ok(!/danger|#c2453d|#ef7b72|\bred\b/i.test(ui + css), 'no red / danger state anywhere in the popover');
  ok(!/(running low|almost out|limit reached|switch (to|account)|recommended|best account|most left)/i.test(ui), 'no "switch because limited" copy or recommendation');
  ok(!/pct\s*[<>]=?\s*\d|\d\s*[<>]=?\s*pct/.test(ui), 'meters do not change with the level (no thresholds)');
  ok(/next check in \$\{next\.minutes\} min/.test(ui), 'shows "next check in N min"');
  ok(trayLogic.USAGE_CHECK_INTERVAL_MS === fairuse.USAGE_MIN_INTERVAL_MS, 'popover countdown uses the same 15-minute interval as the gate');
  const n = trayLogic.nextUsageCheck(1_000_000, 1_000_000 + 4 * 60_000);
  ok(!n.ready && n.minutes === 11, `4 min after a check → next in 11 min (${n.minutes})`);
  ok(trayLogic.nextUsageCheck(1_000_000, 1_000_000 + 15 * 60_000).ready && trayLogic.nextUsageCheck(null).ready, 'ready after 15 min / never checked');
  ok(!trayLogic.isTrayRoute('opApply') && trayLogic.isTrayRoute('doctor'), 'the popover can only open known main-window pages');
});

// ---------- passive usage capture (status-line hook) through the engine ----------

const SETTINGS_ORIG = '{\n    "model": "opus",\n  "permissions": {"allow": ["Bash(ls)"], "deny": []},\n  "env": { "A": "1" }\n}\n';
const readF = (f: string) => fs.readFileSync(f, 'utf8');
async function runPlan(r: { op: safety.Operation }) {
  const pv = await safety.previewOperation(r.op);
  ok(!pv.refused.length, `preview not refused (${pv.refused.join('; ')})`);
  return apply(r.op);
}

test('usage hook: on/off through the engine restores ~/.claude/settings.json byte-for-byte; other keys untouched', async (s) => {
  const def = s.accounts[0];
  const f = path.join(s.home, '.claude', 'settings.json');
  fs.writeFileSync(f, SETTINGS_ORIG);
  const outside = tree(path.join(s.home, '.claude', 'projects'));
  const on = usageHook.planHookOn(def);
  const pv = await safety.previewOperation(on.op);
  ok(on.op.kind === 'usage-hook-on' && !pv.refused.length, 'preview allowed for usage-hook-on');
  ok(pv.lines.some((l) => l.includes(f)) && pv.notes.some((n) => /only the "statusLine" key changes/.test(n)), 'preview names the file and says only statusLine changes');
  ok(pv.notes.some((n) => n.startsWith('statusLine before: (none)')) && pv.notes.some((n) => n.includes(usageHook.hookScript(def))), 'preview shows the exact before/after');
  ok(readF(f) === SETTINGS_ORIG, 'planning/preview changes nothing');
  const j = await apply(on.op);
  const after = readF(f);
  const parsed = JSON.parse(after);
  ok(parsed.statusLine?.command === usageHook.hookScript(def), 'statusLine points at Baton\'s script');
  const { statusLine: _sl, ...rest } = parsed;
  ok(JSON.stringify(rest) === JSON.stringify(JSON.parse(SETTINGS_ORIG)), 'every other key keeps its JSON value');
  ok(after.startsWith(SETTINGS_ORIG.slice(0, SETTINGS_ORIG.lastIndexOf('}', SETTINGS_ORIG.length - 3) + 1)), 'every other byte before the new key is unchanged');
  ok(usageHook.editSettingsKey(after, 'statusLine', undefined, f) === SETTINGS_ORIG, 'removing the key again gives the original text');
  ok((fs.statSync(usageHook.hookScript(def)).mode & 0o777) === 0o755, 'hook script is executable');
  ok(usageHook.hookStatus(def).installed, 'hook status: on');
  ok(safety.readSnapshot(j.snapshotId).verified && safety.readSnapshot(j.snapshotId).entries.some((e) => e.path === f && e.type === 'file'), 'verified snapshot holds the original settings.json');
  ok(same(outside, tree(path.join(s.home, '.claude', 'projects'))), 'nothing else in ~/.claude touched');
  ok(fs.readdirSync(path.join(s.home, '.claude')).sort().join(',') === 'projects,settings.json', 'no temp or extra files left in ~/.claude');
  // off: byte-for-byte original, script moved into the snapshot (not deleted)
  const off = usageHook.planHookOff(def);
  const j2 = await runPlan(off);
  ok(readF(f) === SETTINGS_ORIG, 'off restores the original file exactly');
  ok(!fs.existsSync(usageHook.hookScript(def)) && !usageHook.hookStatus(def).installed, 'script gone, hook off');
  ok(fs.existsSync(path.join(roots.snapshotsDir(), j2.snapshotId, 'quarantine')), 'script kept in the snapshot quarantine');
  ok(usageHook.planHookOff(def).op.steps.length === 0, 'off again: nothing to do');
  // edited in between: off changes only statusLine and keeps the user's later edit
  await runPlan(usageHook.planHookOn(def));
  const edited = readF(f).replace('"model": "opus"', '"model": "sonnet"');
  fs.writeFileSync(f, edited);
  await runPlan(usageHook.planHookOff(def));
  const p2 = JSON.parse(readF(f));
  ok(p2.model === 'sonnet' && !('statusLine' in p2) && JSON.stringify(p2.permissions) === JSON.stringify(JSON.parse(SETTINGS_ORIG).permissions), 'later edits kept; statusLine removed');
  ok(readF(f) === SETTINGS_ORIG.replace('"opus"', '"sonnet"'), 'only the statusLine member was taken out (formatting kept)');
  // an extra account with NO settings.json: on creates it, off puts it back to "no file" (kept in the snapshot)
  const w = s.work2;
  const wf = path.join(w.configDir, 'settings.json');
  await runPlan(usageHook.planHookOn(w));
  ok(JSON.parse(readF(wf)).statusLine.command === usageHook.hookScript(w), 'work2: settings.json created with only statusLine');
  await runPlan(usageHook.planHookOff(w));
  ok(!fs.existsSync(wf), 'work2: back to no settings.json');
});

test('usage hook: a foreign statusLine is replaced only when chosen, and restored exactly', async (s) => {
  const def = s.accounts[0];
  const f = path.join(s.home, '.claude', 'settings.json');
  const orig = '{\n  "statusLine": {\n    "type": "command",\n    "command": "~/bin/my line.sh",\n    "padding": 1\n  },\n  "theme": "dark"\n}\n';
  fs.writeFileSync(f, orig);
  ok(usageHook.hookStatus(def).foreign && !usageHook.hookStatus(def).installed, 'status: foreign status line detected');
  await throws(() => usageHook.planHookOn(def), /already has a status line/, 'refuses to replace without an explicit choice');
  ok(readF(f) === orig && safety.listJournal().length === 0, 'nothing changed, no journal entry');
  const on = usageHook.planHookOn(def, { replace: true });
  ok(on.summary.replacesForeign && on.op.notes!.some((n) => /Replaces your existing status line/.test(n)), 'preview says it replaces the existing one');
  await runPlan(on);
  const p = JSON.parse(readF(f));
  ok(p.statusLine.command === usageHook.hookScript(def) && p.statusLine.padding === 1 && p.theme === 'dark', 'replaced; padding and other keys kept');
  ok(readF(usageHook.hookScript(def)).includes(`/bin/sh -c '~/bin/my line.sh'`), 'Baton\'s script keeps running the previous command');
  ok(usageHook.planHookOn(def, { replace: true }).op.steps.length === 0, 'already on: nothing to do');
  await runPlan(usageHook.planHookOff(def));
  ok(readF(f) === orig, 'off restores the original file (and the user\'s statusLine) exactly');
  // edited in between: the previous statusLine value comes back exactly, other edits kept
  await runPlan(usageHook.planHookOn(def, { replace: true }));
  fs.writeFileSync(f, readF(f).replace('"dark"', '"light"'));
  await runPlan(usageHook.planHookOff(def));
  const p2 = JSON.parse(readF(f));
  ok(JSON.stringify(p2.statusLine) === JSON.stringify(JSON.parse(orig).statusLine) && p2.theme === 'light', 'previous statusLine value restored exactly; later edit kept');
  // someone replaced Baton's statusLine with their own since: off leaves it alone
  await runPlan(usageHook.planHookOn(def, { replace: true }));
  const theirs = readF(f).replace(usageHook.hookScript(def), '/usr/local/bin/other');
  fs.writeFileSync(f, theirs);
  ok(usageHook.planHookOff(def).op.steps.length === 0 && readF(f) === theirs, 'off never touches a statusLine that is no longer Baton\'s');
});

test('usage hook: invalid or non-object settings.json is refused; nothing changes', async (s) => {
  const def = s.accounts[0];
  const f = path.join(s.home, '.claude', 'settings.json');
  for (const bad of ['{ "a": 1, }', '{"a": ', '[1, 2]', '"text"', '{"statusLine": {}, "statusLine": {}}']) {
    fs.writeFileSync(f, bad);
    await throws(() => usageHook.planHookOn(def, { replace: true }), /not valid JSON|not a JSON object|more than once/, `refuses ${JSON.stringify(bad)}`);
    ok(readF(f) === bad, 'file unchanged');
  }
  fs.writeFileSync(f, '{oops');
  await throws(() => usageHook.planHookOff(def), /not valid JSON/, 'off refuses an invalid file too');
  ok(safety.listJournal().length === 0 && !fs.existsSync(usageHook.hookScript(def)), 'no journal entry, no script');
  // settings.json that is a symlink is not followed
  const elsewhere = path.join(s.root, 'elsewhere.json');
  fs.writeFileSync(elsewhere, '{}');
  fs.rmSync(f);
  fs.symlinkSync(elsewhere, f);
  await throws(() => usageHook.planHookOn(def), /not a regular file/, 'refuses a symlinked settings.json');
  ok(!!safety.guardStep({ t: 'write', path: f, data: '{}' }, true, { claudeSettings: true }), 'live guard refuses writing through a symlinked settings.json');
});

test('usage hook: the ~/.claude exception is only settings.json and only for these operations', async (s) => {
  const c = path.join(s.home, '.claude');
  const f = path.join(c, 'settings.json');
  const ctx = safety.guardContext({ kind: 'usage-hook-on' });
  ok(!!ctx.claudeSettings && !!safety.guardContext({ kind: 'usage-hook-off' }).claudeSettings, 'both hook kinds get the exception');
  ok(!safety.guardContext({ kind: 'share' }).claudeSettings && !safety.guardContext({ kind: 'restore' }).claudeSettings && !safety.guardContext({ kind: 'undo' }).claudeSettings, 'other kinds (and a plain undo) do not');
  ok(!!safety.guardContext({ kind: 'undo', undoOfKind: 'usage-hook-on' }).claudeSettings && !safety.guardContext({ kind: 'undo', undoOfKind: 'share' }).claudeSettings, 'undo only of a hook operation');
  ok(!!safety.guardStep({ t: 'write', path: f, data: '{}' }, true), 'without the context: refused');
  ok(!safety.guardStep({ t: 'write', path: f, data: '{}' }, true, ctx) && !safety.guardStep({ t: 'quarantine', path: f }, true, ctx), 'with it: write/quarantine of settings.json allowed');
  for (const st of [
    { t: 'write', path: path.join(c, 'settings.local.json'), data: '{}' },
    { t: 'write', path: path.join(c, 'CLAUDE.md'), data: 'x' },
    { t: 'write', path: path.join(c, '.credentials.json'), data: 'x' },
    { t: 'write', path: path.join(c, 'sub', 'settings.json'), data: '{}' },
    { t: 'quarantine', path: c },
    { t: 'trash', path: f },
    { t: 'unlink', path: f },
    { t: 'moveAside', path: f, to: path.join(c, 'x.json') },
    { t: 'write', path: path.join(s.store, enc(P), 's1.jsonl'), data: 'x' },
    { t: 'mkdir', path: path.join(c, 'newdir') },
  ] as safety.Step[]) ok(!!safety.guardStep(st, true, ctx), `with the context still refused: ${st.t} ${st.path.replace(s.home, '~')}`);
  const before = tree(s.home);
  await throws(() => apply({ kind: 'share', title: 'x', steps: [{ t: 'write', path: f, data: '{"pwned":1}' }], touches: [f] }), /guard/, 'another kind writing settings.json is refused');
  await throws(() => apply({ kind: 'usage-hook-on', title: 'x', steps: [{ t: 'write', path: path.join(c, 'CLAUDE.md'), data: 'x' }], touches: [path.join(c, 'CLAUDE.md')] }), /guard/, 'a hook op writing another ~/.claude file is refused');
  await throws(() => apply({ kind: 'undo', undoOfKind: 'usage-hook-on', title: 'x', steps: [{ t: 'write', path: f, data: '{"pwned":1}' }], touches: [f] }, { undoOf: 'nope' }), /guard/, 'an undo claiming a hook kind without a matching journal entry is refused');
  ok(same(before, tree(s.home)) && safety.listJournal().length === 0, 'nothing changed, nothing journaled');
});

test('usage hook: History › Undo works for on and off; refused when settings.json changed since', async (s) => {
  const def = s.accounts[0];
  const f = path.join(s.home, '.claude', 'settings.json');
  fs.writeFileSync(f, SETTINGS_ORIG);
  const j = await runPlan(usageHook.planHookOn(def));
  const u = await safety.planUndo(j.id);
  ok(u.op.kind === 'undo' && u.op.undoOfKind === 'usage-hook-on' && !u.op.notes!.some((n) => /settings\.json/.test(n) && /never written/.test(n)), 'undo planned with settings.json included');
  ok(u.op.steps.some((x) => x.path === f), 'undo restores settings.json');
  await throws(() => apply(u.op), /does not match its journal entry/, 'an undo run without its journal id is refused');
  safety.cleanupWork(u.work);
  ok(readF(f) !== SETTINGS_ORIG, 'refused undo changed nothing');
  // real path: with undoOf (as ops-ipc does)
  const u1 = await safety.planUndo(j.id);
  await apply(u1.op, { undoOf: j.id });
  safety.cleanupWork(u1.work);
  ok(readF(f) === SETTINGS_ORIG && !fs.existsSync(usageHook.hookScript(def)) && !usageHook.hookStatus(def).installed, 'undo of on: original file back, script gone');
  ok(safety.listJournal().find((x) => x.id === j.id)!.undoneBy, 'original marked undone');
  // undo of off brings capture back (script executable again)
  await runPlan(usageHook.planHookOn(def));
  const jOff = await runPlan(usageHook.planHookOff(def));
  const u2 = await safety.planUndo(jOff.id);
  await apply(u2.op, { undoOf: jOff.id });
  safety.cleanupWork(u2.work);
  ok(usageHook.hookStatus(def).installed && (fs.statSync(usageHook.hookScript(def)).mode & 0o777) === 0o755, 'undo of off: capture back on, script executable');
  // settings.json changed after the operation → undo refused (it would put back the whole file)
  const j3 = await runPlan(usageHook.planHookOff(def));
  fs.writeFileSync(f, readF(f).replace('"opus"', '"haiku"'));
  const keep = readF(f);
  await throws(() => safety.planUndo(j3.id), /changed after this operation/, 'undo refused when settings.json changed since');
  ok(readF(f) === keep, 'nothing changed');
});

test('usage hook: no settings.json write outside the engine (main.ts / usage.ts)', () => {
  const repo = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(repo, 'electron', 'main.ts'), 'utf8');
  const usage = fs.readFileSync(path.join(repo, 'electron', 'usage.ts'), 'utf8');
  const hook = fs.readFileSync(path.join(repo, 'electron', 'usage-hook.ts'), 'utf8');
  ok(!/installHook|uninstallHook|ipcMain\.handle\('usageHook'/.test(main + usage), 'old direct install/uninstall paths are gone');
  ok(!/writeFileSync|renameSync|unlinkSync|rmSync/.test(hook), 'usage-hook.ts only plans (the engine writes)');
  ok(!/settings\.json[\s\S]{0,200}writeFileSync/.test(usage), 'usage.ts writes no settings.json');
});

// ---------- runner ----------

async function child(root: string) {
  desktop.setRootsForTest(root, path.join(root, 'Applications', 'Claude.app'), path.join(root, 'home'));
  if (!roots.roots().home.startsWith(root)) process.exit(3);
  safety.setEngineHooks({ busy: async () => [] });
  const s = { client: { id: 'client', name: 'CLIENT', slug: 'client', configDir: path.join(root, 'home', '.claude-client'), color: '' } };
  const def = { id: 'default', name: 'Me', slug: null, configDir: path.join(root, 'home', '.claude'), color: '' };
  const m = sharing.planMigration([def, s.client], [P], new Set());
  await safety.runOperation(m.op, { confirmed: true, crashAfterStep: 2 }); // killed after the 3rd step
  process.exit(0);
}

(async () => {
  if (process.argv[2] === '--child-crash') return child(process.argv[3]);
  const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0];
  const chosen = tests.filter((t) => !filter || t.name.includes(filter));
  let failed = 0;
  const t0 = Date.now();
  for (const t of chosen) {
    const s = makeSandbox();
    const a0 = asserts;
    try {
      await t.fn(s);
      console.log(`  ✓ ${t.name} (${asserts - a0} checks)`);
    } catch (e: any) {
      failed++;
      console.log(`  ✗ ${t.name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 4).join('\n      ')}`);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  }
  console.log(`\n${chosen.length - failed}/${chosen.length} tests passed, ${asserts} checks, ${((Date.now() - t0) / 1000).toFixed(1)}s — sandbox only (real HOME ${REAL_HOME} never touched)`);
  process.exit(failed ? 1 : 0);
})();
