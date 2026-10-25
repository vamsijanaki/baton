#!/usr/bin/env node
// Publish the locally built (signed + notarized) release to GitHub.
//
//   npm run release:publish            (after `npm run release`, pushing the tag, and `npm run release:build`)
//
// Refuses unless HEAD is the pushed tag vX.Y.Z for package.json's version and release/ holds that version's files.
// Creates the GitHub Release (notes = CHANGELOG section) or, if it exists (e.g. the fallback workflow made an
// unsigned one), replaces its notes and assets with these. Uses the `gh` CLI's own login.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogSection } from './changelog-notes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'vamsijanaki/baton';
const die = (m) => {
  console.error(`release:publish: ${m}`);
  process.exit(1);
};
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: root, encoding: 'utf8', ...opts });

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;

let tagCommit;
try {
  tagCommit = sh('git', ['rev-parse', `${tag}^{commit}`]).trim();
} catch {
  die(`tag ${tag} does not exist locally — run \`npm run release\` first.`);
}
if (sh('git', ['rev-parse', 'HEAD']).trim() !== tagCommit) die(`HEAD is not ${tag} — check out the tag (or main at the release commit) and rebuild.`);
if (!sh('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).trim()) die(`tag ${tag} is not on origin — push it first: git push origin ${tag}`);

const rel = path.join(root, 'release');
const files = ['Baton-arm64.dmg', `Baton-${version}-arm64.dmg`, `Baton-${version}-arm64-mac.zip`, 'SHA256SUMS.txt'].map((f) => path.join(rel, f));
for (const f of files) if (!fs.existsSync(f)) die(`missing release/${path.basename(f)} — run \`npm run release:build\`.`);
const sums = fs.readFileSync(files[3], 'utf8');
if (!sums.includes(`Baton-${version}-arm64.dmg`)) die('SHA256SUMS.txt is not for this version — rebuild.');

const body = changelogSection(version);
if (!body) die(`CHANGELOG.md has no "## [${version}]" section.`);
const notes =
  body +
  '\n\n---\n\n**Download:** `Baton-arm64.dmg` (Apple silicon, signed and notarized). Verify with `shasum -a 256 -c SHA256SUMS.txt`.\n';
const notesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'baton-notes-')), 'notes.md');
fs.writeFileSync(notesFile, notes);

let exists = true;
try {
  sh('gh', ['release', 'view', tag, '--repo', REPO], { stdio: 'pipe' });
} catch {
  exists = false;
}
const io = { stdio: 'inherit' };
if (exists) {
  console.log(`Release ${tag} exists — replacing notes and assets.`);
  sh('gh', ['release', 'edit', tag, '--repo', REPO, '--title', `Baton ${version}`, '--notes-file', notesFile], io);
  sh('gh', ['release', 'upload', tag, ...files, '--repo', REPO, '--clobber'], io);
} else {
  sh('gh', ['release', 'create', tag, ...files, '--repo', REPO, '--title', `Baton ${version}`, '--notes-file', notesFile, '--verify-tag', '--latest'], io);
}
console.log(`\nPublished https://github.com/${REPO}/releases/tag/${tag}`);
console.log('Next: check https://trybaton.app/download serves the new DMG; redeploy the site if it changed (npx wrangler deploy); post in Discussions.');
