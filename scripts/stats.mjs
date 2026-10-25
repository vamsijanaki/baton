#!/usr/bin/env node
// Launch numbers from GitHub (needs `gh` signed in): downloads per release, update installs, repo traffic, stars.
// Website visits live in Cloudflare › Analytics & Logs › Web Analytics (trybaton.app).
import { execFileSync } from 'node:child_process';

const REPO = 'vamsijanaki/baton';
const api = (p) => JSON.parse(execFileSync('gh', ['api', p], { encoding: 'utf8' }));

const releases = api(`repos/${REPO}/releases`);
let dmg = 0, zip = 0;
console.log('Downloads per release (DMG = new installs, zip = in-app updates)');
for (const r of releases) {
  const d = r.assets.filter((a) => a.name.endsWith('.dmg')).reduce((n, a) => n + a.download_count, 0);
  const z = r.assets.filter((a) => a.name.endsWith('.zip')).reduce((n, a) => n + a.download_count, 0);
  dmg += d; zip += z;
  console.log(`  ${r.tag_name.padEnd(8)} DMG ${String(d).padStart(5)}   updates ${String(z).padStart(5)}   ${r.published_at.slice(0, 10)}`);
}
console.log(`  total    DMG ${String(dmg).padStart(5)}   updates ${String(zip).padStart(5)}`);

const repo = api(`repos/${REPO}`);
console.log(`\nStars ${repo.stargazers_count} · forks ${repo.forks_count} · open issues ${repo.open_issues_count}`);
try {
  const v = api(`repos/${REPO}/traffic/views`);
  const c = api(`repos/${REPO}/traffic/clones`);
  console.log(`Repo views (14 days) ${v.count} (${v.uniques} unique) · clones ${c.count} (${c.uniques} unique)`);
  const refs = api(`repos/${REPO}/traffic/popular/referrers`);
  if (refs.length) console.log('Top referrers: ' + refs.slice(0, 8).map((r) => `${r.referrer} ${r.count}`).join(' · '));
} catch {
  console.log('Repo traffic needs push access to the repo.');
}
