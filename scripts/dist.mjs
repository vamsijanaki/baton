#!/usr/bin/env node
// Runs electron-builder for the Mac arm64 build, never publishing by itself.
//
// Signed when the Developer ID identity from package.json (build.mac.identity) is in a keychain on this Mac, or when
// CI provides CSC_LINK. Otherwise it falls back to an ad-hoc signed build (Apple silicon refuses to run unsigned
// code, so "unsigned" here means ad-hoc: no Developer ID, no hardened runtime, no notarization, DMG unsigned).
// Notarization happens when electron-builder finds credentials in env: APPLE_KEYCHAIN_PROFILE (local, set by
// `npm run release:build`), or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (CI).
//
//   node scripts/dist.mjs [--require-signed] [--unsigned]       (normally via `npm run dist` / `npm run release:build`)
//   BATON_UNSIGNED=1 npm run dist                                force the ad-hoc build
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const requireSigned = args.includes('--require-signed');
const forceUnsigned = args.includes('--unsigned') || process.env.BATON_UNSIGNED === '1';

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const identity = pkg.build?.mac?.identity;

function identityInKeychain(name) {
  if (!name || name === '-') return false;
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    return out.includes(`"Developer ID Application: ${name}"`);
  } catch {
    return false;
  }
}

const signed = !forceUnsigned && (identityInKeychain(identity) || !!process.env.CSC_LINK);
const notarizeCreds =
  !!process.env.APPLE_KEYCHAIN_PROFILE ||
  !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ||
  !!(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);

if (requireSigned && !signed) {
  console.error(`dist: --require-signed but "Developer ID Application: ${identity}" is not in a keychain on this Mac.`);
  process.exit(1);
}
if (requireSigned && !notarizeCreds) {
  console.error('dist: --require-signed needs notarization credentials (APPLE_KEYCHAIN_PROFILE, or the APPLE_ID trio).');
  process.exit(1);
}

const builderArgs = ['electron-builder', '--mac', '--arm64', '--publish', 'never'];
const env = { ...process.env };
if (signed) {
  console.log(`dist: signing as "Developer ID Application: ${identity}" (hardened runtime)` + (notarizeCreds ? ', notarizing' : ' — NOT notarized (no Apple credentials in env)'));
} else {
  console.log('dist: Developer ID identity not available — building ad-hoc signed (not notarized). Fine for local use only.');
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  builderArgs.push('-c.mac.identity=-', '-c.mac.hardenedRuntime=false', '-c.mac.notarize=false', '-c.dmg.sign=false');
}
builderArgs.push(...args.filter((a) => !['--require-signed', '--unsigned'].includes(a)));

const r = spawnSync('npx', builderArgs, { cwd: root, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
