#!/usr/bin/env node
// Cut a Baton release locally. See RELEASING.md.
//
//   npm run release -- <patch|minor|major|x.y.z> [--push] [--skip-checks]
//
// Refuses unless: on main, working tree clean, tag free, CHANGELOG "Unreleased" has entries, tests + typecheck green.
// Then: bumps package.json + package-lock.json, moves Unreleased into a dated section, commits "Release vX.Y.Z"
// with the repo's configured git author (no trailers), creates annotated tag vX.Y.Z, and prints the push command.
// Pushes only with --push. Pushing the tag triggers .github/workflows/release.yml.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const push = args.includes('--push');
const skipChecks = args.includes('--skip-checks'); // escape hatch for re-running after checks already passed; not for normal use
const bumpArg = args.find((a) => !a.startsWith('--'));

function die(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}
function git(...a) {
  return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
}
function run(cmd, a, failMsg = 'nothing was changed') {
  console.log(`\n$ ${cmd} ${a.join(' ')}`);
  try {
    execFileSync(cmd, a, { cwd: root, stdio: 'inherit' });
  } catch {
    die(`"${cmd} ${a.join(' ')}" failed — ${failMsg}.`);
  }
}

if (!bumpArg) die('usage: npm run release -- <patch|minor|major|x.y.z> [--push]');

// ---- preconditions ----
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') die(`must be on main (currently on ${branch}).`);
if (git('status', '--porcelain')) die('working tree is not clean — commit or stash first.');

const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const clPath = path.join(root, 'CHANGELOG.md');
const pkgText = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(pkgText);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const cur = SEMVER.exec(pkg.version);
if (!cur) die(`package.json version "${pkg.version}" is not x.y.z.`);
const [maj, min, pat] = cur.slice(1).map(Number);

let next;
if (bumpArg === 'patch') next = `${maj}.${min}.${pat + 1}`;
else if (bumpArg === 'minor') next = `${maj}.${min + 1}.0`;
else if (bumpArg === 'major') next = `${maj + 1}.0.0`;
else if (SEMVER.test(bumpArg.replace(/^v/, ''))) next = bumpArg.replace(/^v/, '');
else die(`unknown bump "${bumpArg}" — use patch, minor, major or x.y.z.`);

const cmp = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
if (cmp(next, pkg.version) <= 0) die(`new version ${next} must be greater than ${pkg.version}.`);
const tag = `v${next}`;
if (git('tag', '--list', tag)) die(`tag ${tag} already exists.`);

// ---- changelog: Unreleased must have entries ----
const cl = fs.readFileSync(clPath, 'utf8');
const unrelRe = /^## \[Unreleased\][^\n]*\n/m;
const um = unrelRe.exec(cl);
if (!um) die('CHANGELOG.md has no "## [Unreleased]" section.');
const bodyStart = um.index + um[0].length;
const nextHeading = cl.slice(bodyStart).search(/^## \[/m);
const bodyEnd = nextHeading === -1 ? cl.length : bodyStart + nextHeading;
// stop at the link-reference block if Unreleased is the last section
let body = cl.slice(bodyStart, bodyEnd);
const linkBlock = body.search(/^\[[^\]]+\]: /m);
if (linkBlock !== -1) body = body.slice(0, linkBlock);
const realBodyEnd = bodyStart + body.length;
if (!/^\s*[-*] \S/m.test(body)) die('CHANGELOG "Unreleased" is empty — add the user-visible changes first (see RELEASING.md).');

// drop empty "### X" subsections, normalise whitespace
const cleaned = body
  .trim()
  .split(/(?=^### )/m)
  .filter((s) => !/^### /.test(s) || /^\s*[-*] \S/m.test(s))
  .map((s) => s.trim())
  .join('\n\n');

if (!skipChecks) {
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);
}

// ---- write files ----
const d = new Date();
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
let newCl = cl.slice(0, bodyStart) + `\n## [${next}] - ${date}\n\n${cleaned}\n\n` + cl.slice(realBodyEnd).replace(/^\n+/, '');

// link references (Keep a Changelog footer)
const repo = 'https://github.com/vamsijanaki/baton';
if (/^\[Unreleased\]: .*$/m.test(newCl)) {
  newCl = newCl.replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${repo}/compare/${tag}...HEAD\n[${next}]: ${repo}/compare/v${pkg.version}...${tag}`);
}
fs.writeFileSync(clPath, newCl);

const indent = (pkgText.match(/^\{\n([ \t]+)/) || [, '  '])[1];
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + '\n');

const files = ['package.json', 'CHANGELOG.md'];
if (fs.existsSync(lockPath)) {
  const lockText = fs.readFileSync(lockPath, 'utf8');
  const lock = JSON.parse(lockText);
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  const lindent = (lockText.match(/^\{\n([ \t]+)/) || [, '  '])[1];
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, lindent) + '\n');
  files.push('package-lock.json');
}

// The website's download note ("v1.2.3 · Apple silicon · Changelog") follows the release.
const sitePath = path.join(root, 'site', 'index.html');
if (fs.existsSync(sitePath)) {
  const siteText = fs.readFileSync(sitePath, 'utf8');
  const siteNext = siteText.replace(/(<p class="cta-note">)v\d+\.\d+\.\d+( · )/g, `$1v${next}$2`);
  if (siteNext !== siteText) {
    fs.writeFileSync(sitePath, siteNext);
    files.push('site/index.html');
  }
}

// ---- commit + tag (repo's configured author; no trailers) ----
git('add', '--', ...files);
git('commit', '-m', `Release ${tag}`, '--', ...files);
git('tag', '-a', tag, '-m', `Baton ${next}`);

console.log(`\nCreated commit "Release ${tag}" and annotated tag ${tag}.`);
const pushCmd = `git push origin main && git push origin ${tag}`;
if (push) {
  run('git', ['push', 'origin', 'main'], `commit and tag ${tag} exist locally; push manually: ${pushCmd}`);
  run('git', ['push', 'origin', tag], `push the tag manually: git push origin ${tag}`);
  console.log(`\nPushed. The Release workflow is building ${tag}: ${repo}/actions/workflows/release.yml`);
} else {
  console.log(`\nNothing pushed. When ready:\n\n  ${pushCmd}\n\nPushing the tag starts the Release workflow (${repo}/actions/workflows/release.yml).`);
  console.log(`To undo before pushing:  git tag -d ${tag} && git reset --hard HEAD~1`);
}
