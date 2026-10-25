// READ-ONLY checks against the real Mac: Doctor + the migration preview. Writes nothing (read-only mode makes every
// write path in the engine throw; a before/after listing of the state folder proves it).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setReadOnly, roots } from '../electron/roots';
import { previewOperation } from '../electron/safety';
import { planMigration, runDoctor, desktopFolders, readSharing, sharedSince, desktopAttribution, terminalState } from '../electron/sharing';
import { buildOverview, planMergeApps, syncContext, type TerminalIdentity } from '../electron/apps';
import { listDesktopProfiles, runningDesktops, claudeVersion } from '../electron/desktop';

setReadOnly(true);
const home = os.homedir();
const t = (s: string) => s.split(home).join('~');
function listing(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      out.push(`${p}:${st.size}:${st.mtimeMs}`);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}
(async () => {
  const before = listing(roots().appDir);
  const state = JSON.parse(fs.readFileSync(path.join(roots().appDir, 'state.json'), 'utf8'));
  const accounts = state.accounts.map((a: any) => (a.id === 'default' ? { ...a, configDir: path.join(home, '.claude') } : a));
  const running = new Set((await runningDesktops()).map((r) => path.basename(r.dataDir)));
  const profiles = await listDesktopProfiles({});
  const doc = await runDoctor({ accounts, profiles, claudeVersion: claudeVersion(), runningProfiles: running, freeBytes: null });
  console.log('== DOCTOR (real Mac, read-only)');
  for (const c of doc) console.log(`  [${c.level.toUpperCase().padEnd(5)}] ${c.title} — ${t(c.detail)}${c.fix ? `  → fix: ${c.fix.label}` : ''}`);
  console.log(`\n== desktop lists: ${desktopFolders().map((f) => `${f.key.replace(/([0-9a-f]{8})[0-9a-f-]{28}/g, '$1')}${f.isLink ? ' (LINK)' : ''} ${f.sessions}`).join(' · ')}`);
  console.log(`== running desktop profiles: ${[...running].join(', ') || 'none'} · sharing config: ${readSharing().projects.length} project(s)`);
  const m = planMigration(accounts, state.project ? [state.project] : [], running);
  const pv = await previewOperation(m.op);
  console.log('\n== MIGRATION PREVIEW (not applied)');
  console.log(JSON.stringify(m.summary, null, 2).split(home).join('~'));
  console.log(`  ${pv.lines.length} step(s); refused: ${pv.refused.length}; busy: ${pv.busy.length ? pv.busy.join(', ') : 'none'}`);
  pv.lines.forEach((l, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t(l)}`));
  pv.notes.forEach((n) => console.log(`  note: ${t(n)}`));
  // one concept: accounts = emails (pairing + duplicate detection + merge preview, nothing applied)
  const ids: TerminalIdentity[] = accounts.map((a: any) => {
    let o: any = null;
    for (const f of a.id === 'default' ? [path.join(home, '.claude.json')] : [path.join(a.configDir, '.claude.json')]) {
      try {
        o = JSON.parse(fs.readFileSync(f, 'utf8'))?.oauthAccount ?? null; // only accountUuid + emailAddress are used
      } catch {
        /* none */
      }
    }
    return { id: a.id, name: a.name, color: a.color, configDir: a.configDir, email: o?.emailAddress ?? null, accountUuid: o?.accountUuid ?? null, signedIn: !!o?.emailAddress, isDefault: a.id === 'default' };
  });
  const emails = Object.fromEntries(ids.filter((i) => i.accountUuid && i.email).map((i) => [i.accountUuid!, i.email!]));
  const profiles2 = await listDesktopProfiles(emails);
  const ov = buildOverview(ids, profiles2, emails);
  console.log('\n== ACCOUNTS (one card per email)');
  for (const c of ov.accounts) console.log(`  ${c.name} <${c.email}> terminal=${c.terminal ? t(c.terminal.configDir) : '-'} apps=${c.apps.map((a) => `${a.name}(${a.sessions})`).join(', ') || '-'} kept=${c.kept} extras=${c.extras.join(', ') || '-'}`);
  console.log(`  leftovers: ${ov.leftovers.map((l) => `${l.profileName}: ${l.email} (${l.sessions})`).join('; ') || 'none'} · unpaired: ${ov.unpaired.map((a) => a.name).join(', ') || 'none'}`);
  for (const c of ov.accounts.filter((x) => x.extras.length)) {
    const keep = profiles2.find((p) => p.id === c.kept)!;
    const mp = planMergeApps(keep, c.extras.map((id) => profiles2.find((p) => p.id === id)!), false);
    const mpv = await previewOperation(mp.op);
    console.log(`\n== MERGE PREVIEW for ${c.email} (not applied): copies=${mp.summary.copies} alreadyThere=${mp.summary.alreadyThere} refused=${mpv.refused.length} busy=${mpv.busy.join(', ') || 'none'}`);
    mpv.lines.forEach((l, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t(l)}`));
  }
  for (const sp of readSharing().projects) console.log(`\n== ${t(sp.path)} shared since: ${JSON.stringify(sharedSince(sp.path))} auto=${!!sp.auto}`);
  // which accounts worked on recent projects in a desktop app, and whether their Terminal can see them (read-only)
  const sctx = syncContext(profiles2, ids, false);
  console.log('\n== DESKTOP ATTRIBUTION (recent projects)');
  for (const p of [...new Set([...(state.recentProjects ?? []), ...readSharing().projects.map((x) => x.path)])]) {
    const a = desktopAttribution(p, sctx).byAccount;
    const parts = Object.entries(a).map(([id, v]) => {
      const acc = accounts.find((x: any) => x.id === id);
      return `${acc?.name ?? id}: ${v.chats} chat(s) in ${v.apps.join(', ')}${id === 'default' ? '' : ` · terminal ${terminalState(acc, p)}`}`;
    });
    console.log(`  ${t(p)} — ${parts.join(' · ') || 'no desktop chats'}`);
  }
  const after = listing(roots().appDir);
  console.log(`\n== ${t(roots().appDir)} unchanged by this check: ${before === after ? 'YES' : 'NO (!)'}`);
})();
