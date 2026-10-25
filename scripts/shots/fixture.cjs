// Builds a FAKE home for screenshots. Never touches the real HOME.
const fs = require('fs'), path = require('path'), os = require('os');
const H = process.argv[2];
const tmp = fs.realpathSync(os.tmpdir());
if (!H || path.resolve(H) === os.homedir() || !(fs.realpathSync(path.dirname(H)).startsWith(tmp) || H.includes('scratchpad'))) throw new Error('the fake home must be a new folder under the temp dir');
fs.rmSync(H, { recursive: true, force: true });
const w = (p, d, mtime) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof d === 'string' ? d : JSON.stringify(d, null, 2)); if (mtime) fs.utimesSync(p, new Date(mtime), new Date(mtime)); };
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const P = path.join(H, 'Projects', 'acme-web');
const P2 = path.join(H, 'Projects', 'billing-api');
fs.mkdirSync(P, { recursive: true }); fs.mkdirSync(P2, { recursive: true });
const ME = '11111111-aaaa-4bbb-8ccc-000000000001', FT = '22222222-aaaa-4bbb-8ccc-000000000002';
const ORG_ME = '33333333-aaaa-4bbb-8ccc-000000000003', ORG_FT = '44444444-aaaa-4bbb-8ccc-000000000004', ORG_FT2 = '55555555-aaaa-4bbb-8ccc-000000000005';
w(path.join(H, '.claude.json'), { oauthAccount: { accountUuid: ME, emailAddress: 'alex@example.com', organizationUuid: ORG_ME, organizationType: 'claude_max' } });
w(path.join(H, '.claude-work', '.claude.json'), { oauthAccount: { accountUuid: FT, emailAddress: 'alex@company.example', organizationUuid: ORG_FT, organizationType: 'claude_enterprise' } });
const store = path.join(H, '.claude', 'projects');
const now = Date.now();
const titles = ['Fix the search filter on the orders page', 'Add dark mode to the settings screen', 'Export invoices as CSV', 'Tidy up the onboarding copy', 'Speed up the product list query'];
titles.forEach((t, i) => w(path.join(store, enc(P), `0${i}aa1111-2222-4333-8444-55556666777${i}.jsonl`), JSON.stringify({ type: 'user', cwd: P, gitBranch: 'main', message: { role: 'user', content: t } }) + '\n', now - (i + 1) * 3.7e6));
w(path.join(store, enc(P2), 'aa001111-2222-4333-8444-555566667777.jsonl'), JSON.stringify({ type: 'user', cwd: P2, message: { role: 'user', content: 'Retry failed webhook deliveries' } }) + '\n', now - 9e6);
// Work: per-project link for the shared project only
fs.mkdirSync(path.join(H, '.claude-work', 'projects'), { recursive: true });
fs.symlinkSync(path.join(store, enc(P)), path.join(H, '.claude-work', 'projects', enc(P)));
// Baton state
const app = path.join(H, '.baton');
w(path.join(app, 'state.json'), { accounts: [{ id: 'default', name: 'Personal', slug: null, configDir: path.join(H, '.claude'), color: '#0d7f72', kind: 'personal', kindSource: 'detected', kindHint: 'organization type: claude_max', attestedAt: '2026-10-25T07:00:00.000Z' }, { id: 'work', name: 'Work', slug: 'work', configDir: path.join(H, '.claude-work'), color: '#b48ead', kind: 'work', kindSource: 'detected', kindHint: 'organization type: claude_enterprise', attestedAt: '2026-10-25T07:00:00.000Z' }], recentProjects: [P, P2], selectedAccount: 'default', project: P, dryRun: true, appearance: 'light' });
w(path.join(app, 'settings.json'), { retention: 20, syncEnabled: true, onboarded: true });
const sharing = { version: 1, projects: [{ path: P, accounts: ['work'], desktop: [`Claude/${ME}/${ORG_ME}`] }] };
w(path.join(app, 'sharing.json'), sharing);
const at = '2026-10-25T07:09:35.405Z';
w(path.join(app, 'journal', '2026-10-25T07-09-35-394Z-migrate-0001.json'), { id: '2026-10-25T07-09-35-394Z-migrate-0001', kind: 'migrate', title: 'Migrate to per-project sharing (acme-web)', createdAt: at, finishedAt: at, status: 'done', snapshotId: 'none', steps: [{ t: 'write', path: path.join(app, 'sharing.json'), data: JSON.stringify(sharing) }], pre: [null], done: 1 });
const reset5 = now + 2.4 * 3.6e6, resetW = now + 3.2 * 86.4e6;
w(path.join(app, 'usage', 'default.probe.json'), { source: 'usage-command', capturedAt: now - 6e5, fiveHour: { pct: 18, resetsAt: reset5 }, sevenDay: { pct: 62, resetsAt: resetW }, extra: [] });
w(path.join(app, 'usage', 'work.probe.json'), { source: 'usage-command', capturedAt: now - 9e5, fiveHour: { pct: 4, resetsAt: reset5 }, sevenDay: { pct: 38, resetsAt: resetW }, extra: [] });
w(path.join(app, 'desktop-profiles.json'), { 'Claude-Work Old': { origin: 'other', autoLink: false, addedAt: at }, 'Claude-Work Test': { origin: 'other', autoLink: false, addedAt: at }, 'Claude-Claude Work': { origin: 'claude-switch', autoLink: false, addedAt: at } });
// desktop apps
const sup = path.join(H, 'Library', 'Application Support');
const profile = (id, uuid, color) => { w(path.join(sup, id, 'Preferences'), '{}'); w(path.join(sup, id, 'config.json'), { lastKnownAccountUuid: uuid, locale: 'en' }); if (color) w(path.join(sup, id, '.baton-color'), color + '\n'); };
const idx = (id, acct, org, n, cwd, t, mtime) => w(path.join(sup, id, 'claude-code-sessions', acct, org, `local_${n}.json`), { sessionId: `local_${n}`, cliSessionId: n, cwd, title: t, isArchived: false }, mtime);
profile('Claude', ME);
profile('Claude-Claude Work', FT, 'purple');
profile('Claude-Work Old', FT, 'blue');
profile('Claude-Work Test', FT, 'green');
for (let i = 0; i < 6; i++) idx('Claude', ME, ORG_ME, `me${i}`, i < 4 ? P : P2, ['Fix the search filter on the orders page','Add dark mode to the settings screen','Export invoices as CSV','Tidy up the onboarding copy','Retry failed webhook deliveries','Add an idempotency key to refunds'][i], now - i * 4e6);
idx('Claude', FT, ORG_FT, 'old1', '/tmp', 'old sign-in chat', now - 9e8); // leftover from an old sign-in
for (let i = 0; i < 5; i++) idx('Claude-Claude Work', FT, ORG_FT, `ft${i}`, P, ['Fix the search filter on the orders page','Export invoices as CSV','Tidy up the onboarding copy','Speed up the product list query','Update the README'][i], now - i * 5e6);
for (let i = 0; i < 5; i++) idx('Claude-Work Old', FT, ORG_FT, `ft${i}`, P, ['Fix the search filter on the orders page','Export invoices as CSV','Tidy up the onboarding copy','Speed up the product list query','Update the README'][i], now - i * 5e6);
idx('Claude-Work Old', FT, ORG_FT, 'side9', P, 'Add pagination to the orders table', now - 2e6);
idx('Claude-Work Old', FT, ORG_FT, 'side8', P2, 'Rotate the webhook signing secret', now - 3e6);
fs.mkdirSync(path.join(sup, 'Claude-Work Test', 'claude-code-sessions', FT, ORG_FT2), { recursive: true });
console.log('fake home ready:', H);
