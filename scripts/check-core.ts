import { listSessions, encodeProject, knownProjects, DEFAULT_PROJECT, SHARED_PROJECTS, listClaudeProcesses, loadState, buildShellCommand } from '../electron/core';
// Read-only smoke check against the real Mac: run with the project you want to inspect as the first argument.
const PROJECT = process.argv[2] || loadState().project || DEFAULT_PROJECT;
import fs from 'node:fs';
(async () => {
  const enc = encodeProject(PROJECT);
  console.log('encoded:', enc, 'exists:', fs.existsSync(`${SHARED_PROJECTS}/${enc}`));
  const t = Date.now();
  const { sessions } = await listSessions(PROJECT);
  console.log('sessions:', sessions.length, 'in', Date.now() - t, 'ms');
  for (const x of sessions.slice(0, 5)) console.log(' -', x.id.slice(0, 8), new Date(x.mtime).toISOString().slice(0, 16), x.title.slice(0, 70));
  const kp = await knownProjects();
  console.log('known projects:', kp.length, kp.slice(0, 3).map((k) => k.path));
  const st = loadState();
  const procs = await listClaudeProcesses(st.accounts, { default: null });
  console.log('procs:', procs.map((p) => ({ pid: p.pid, src: p.source, acc: p.accountId, cwd: p.cwd, cfg: p.configDir, hasEmail: !!p.email })));
  console.log(buildShellCommand({ id: 'test', slug: 'test', name: 'test', configDir: process.env.HOME + '/.claude-test', color: '' }, PROJECT, { resume: sessions[0]?.id ?? '00000000-0000-4000-8000-000000000000' }));
})();
