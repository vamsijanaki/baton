#!/usr/bin/env node
// After electron-builder: notarize + staple the DMG (the app inside is already notarized and stapled by
// electron-builder), verify signatures, check the in-app updater's feed (latest-mac.yml must match the zip; the
// app inside the zip must carry Baton's designated requirement), add the versioned DMG copy and SHA256SUMS.txt.
//
//   node scripts/release-artifacts.mjs [--require-notarized]
//
// Notarization credentials (never printed): APPLE_KEYCHAIN_PROFILE (a `xcrun notarytool store-credentials` profile),
// or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID. Without them, or for an ad-hoc build, the DMG is left
// as is and only the copy + checksums are made — unless --require-notarized, which then fails.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FEED_FILE, refreshFeedEntry, verifyFeed } from './update-feed.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireNotarized = process.argv.includes('--require-notarized');
const { version, build: pkgBuild } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const rel = path.join(root, 'release');
const app = path.join(rel, 'mac-arm64', 'Baton.app');
const dmg = path.join(rel, 'Baton-arm64.dmg');
const vdmg = path.join(rel, `Baton-${version}-arm64.dmg`);
const zip = path.join(rel, `Baton-${version}-arm64-mac.zip`);

function die(msg) {
  console.error(`release-artifacts: ${msg}`);
  process.exit(1);
}
for (const f of [app, dmg, zip, path.join(rel, FEED_FILE), `${zip}.blockmap`]) if (!fs.existsSync(f)) die(`missing ${path.relative(root, f)} — run the build first.`);

/** Run a command, echo it and its combined output; returns { ok, out }. */
function check(cmd, a) {
  const r = spawnSync(cmd, a, { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  console.log(`\n$ ${cmd} ${a.map((x) => (x.includes(' ') ? `"${x}"` : x)).join(' ')}\n${out}`);
  return { ok: r.status === 0, out };
}

const sigInfo = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' }).stderr || '';
const developerId = /Authority=Developer ID Application:/.test(sigInfo);

let notaryArgs = null;
if (process.env.APPLE_KEYCHAIN_PROFILE) notaryArgs = ['--keychain-profile', process.env.APPLE_KEYCHAIN_PROFILE];
else if (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
  notaryArgs = ['--apple-id', process.env.APPLE_ID, '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', process.env.APPLE_TEAM_ID];

if (requireNotarized && !developerId) die('the app is not Developer ID signed.');
if (requireNotarized && !notaryArgs) die('no notarization credentials in env (APPLE_KEYCHAIN_PROFILE or the APPLE_ID trio).');

if (developerId && notaryArgs) {
  const dmgSig = spawnSync('codesign', ['-dv', dmg], { encoding: 'utf8' }).stderr || '';
  if (!/Authority=Developer ID Application:/.test(dmgSig) && !/TeamIdentifier=\w/.test(dmgSig)) die('the DMG is not signed (build.dmg.sign).');
  console.log('\nNotarizing the DMG (uploads to Apple, waits for the result)…');
  const sub = spawnSync('xcrun', ['notarytool', 'submit', dmg, ...notaryArgs, '--wait', '--output-format', 'json'], { encoding: 'utf8' });
  let res = {};
  try {
    res = JSON.parse(sub.stdout || '{}');
  } catch {}
  console.log(`notarytool: status=${res.status ?? 'unknown'} id=${res.id ?? '?'}`);
  if (sub.status !== 0 || res.status !== 'Accepted') {
    if (sub.stderr) console.error(sub.stderr.trim());
    if (res.id) console.error(`Log: xcrun notarytool log ${res.id} --keychain-profile <profile>`);
    die('DMG notarization failed.');
  }
  try {
    execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
  } catch {
    die('stapling the DMG failed.');
  }
} else {
  console.log(developerId ? '\nNo notarization credentials — DMG not notarized.' : '\nAd-hoc build — skipping notarization.');
}

// ---- verification (always printed; fatal only with --require-notarized) ----
if (developerId) {
  const results = [
    check('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]),
    check('codesign', ['--verify', '--strict', '--verbose=2', path.join(app, 'Contents', 'Resources', 'baton-desktop-helper')]),
    check('spctl', ['-a', '-vvv', '-t', 'exec', app]),
    check('xcrun', ['stapler', 'validate', app]),
    check('xcrun', ['stapler', 'validate', dmg]),
    check('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-v', dmg]),
  ];
  const notarizedApp = /source=Notarized Developer ID/.test(results[2].out);
  if (requireNotarized && (results.some((r) => !r.ok) || !notarizedApp)) die('verification failed (see above).');
}

// ---- in-app updater feed ----
// The DMG was stapled after electron-builder wrote latest-mac.yml: put its real hash back (the updater itself only
// uses the zip, whose entry is never rewritten — it must already match).
if (refreshFeedEntry(rel, path.basename(dmg))) console.log(`\n${FEED_FILE}: updated the stapled DMG's sha512/size.`);
const feedProblems = verifyFeed(rel, version);
if (feedProblems.length) die(`${FEED_FILE} does not match the release files:\n  ${feedProblems.join('\n  ')}`);
console.log(`\n${FEED_FILE}: matches ${path.basename(zip)} (sha512 + size), blockmap present.`);

// Squirrel.Mac installs an update only if the new app satisfies the running app's designated requirement, so the
// app inside the zip must be signed with the same bundle id and Developer ID team as every earlier release.
if (developerId) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-zip-'));
  try {
    execFileSync('ditto', ['-x', '-k', zip, tmp]);
    const zapp = path.join(tmp, 'Baton.app');
    const verify = check('codesign', ['--verify', '--deep', '--strict', '--verbose=2', zapp]);
    const dr = spawnSync('codesign', ['-d', '-r-', zapp], { encoding: 'utf8' });
    const req = `${dr.stdout || ''}${dr.stderr || ''}`;
    const id = pkgBuild.appId;
    const team = /\((\w{10})\)\s*$/.exec(pkgBuild.mac.identity)?.[1];
    const drOk = req.includes(`identifier "${id}"`) && !!team && req.includes(team) && /anchor apple generic/.test(req);
    console.log(`\nDesignated requirement of the app in the zip:\n${req.trim()}`);
    const sameApp = sigInfo.includes(`TeamIdentifier=${team}`);
    if (!verify.ok || !drOk || !sameApp) {
      const msg = `the app inside ${path.basename(zip)} is not signed as ${id} by team ${team} — the in-app updater would refuse it.`;
      if (requireNotarized) die(msg);
      console.warn(`WARNING: ${msg}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- versioned copy + checksums (after stapling, so they match what ships) ----
fs.copyFileSync(dmg, vdmg);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const files = [dmg, vdmg, zip];
fs.writeFileSync(path.join(rel, 'SHA256SUMS.txt'), files.map((f) => `${sha(f)}  ${path.basename(f)}`).join('\n') + '\n');
console.log(`\nRelease files in release/:\n${[...files, path.join(rel, FEED_FILE), `${zip}.blockmap`].map((f) => `  ${path.basename(f)}`).join('\n')}\n  SHA256SUMS.txt`);
