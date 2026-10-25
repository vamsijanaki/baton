// The in-app updater's feed: latest-mac.yml, written by electron-builder next to the .zip and the .zip.blockmap.
// electron-updater (in Baton) downloads latest-mac.yml from the GitHub Release, then the zip, and refuses the zip
// unless its sha512 matches the one listed here. So the release must ship a latest-mac.yml that matches the zip
// byte for byte — this module checks that (release-artifacts.mjs, release-publish.mjs, the test suite).
//
// Only the small, fixed shape electron-builder writes is understood (no YAML dependency):
//   version: 1.2.3
//   files:
//     - url: Baton-1.2.3-arm64-mac.zip
//       sha512: <base64>
//       size: 123
//   path: Baton-1.2.3-arm64-mac.zip
//   sha512: <base64>
//   releaseDate: '2026-01-01T00:00:00.000Z'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FEED_FILE = 'latest-mac.yml';
export const zipName = (version) => `Baton-${version}-arm64-mac.zip`;

const unquote = (v) => v.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');

/** Parse electron-builder's latest-mac.yml. Throws on anything it does not recognise. */
export function parseFeed(text) {
  const out = { version: null, path: null, sha512: null, releaseDate: null, files: [], extra: {} };
  let inFiles = false;
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    let m;
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (inFiles && (m = /^\s+-\s+(\w+):\s*(.*)$/.exec(line))) {
      cur = { [m[1]]: unquote(m[2]) };
      out.files.push(cur);
      continue;
    }
    if (inFiles && cur && (m = /^\s+(\w+):\s*(.*)$/.exec(line))) {
      cur[m[1]] = unquote(m[2]);
      continue;
    }
    if ((m = /^(\w+):\s*(.*)$/.exec(line))) {
      inFiles = false;
      cur = null;
      const [, k, v] = m;
      if (k in out && k !== 'files' && k !== 'extra') out[k] = unquote(v);
      else out.extra[k] = unquote(v);
      continue;
    }
    throw new Error(`${FEED_FILE}: unexpected line: ${line}`);
  }
  for (const f of out.files) if (f.size !== undefined) f.size = Number(f.size);
  return out;
}

export function serializeFeed(feed) {
  const lines = [`version: ${feed.version}`, 'files:'];
  for (const f of feed.files) {
    const [first, ...rest] = Object.keys(f);
    lines.push(`  - ${first}: ${f[first]}`);
    for (const k of rest) lines.push(`    ${k}: ${f[k]}`);
  }
  lines.push(`path: ${feed.path}`, `sha512: ${feed.sha512}`);
  for (const [k, v] of Object.entries(feed.extra)) lines.push(`${k}: ${v}`);
  if (feed.releaseDate) lines.push(`releaseDate: '${feed.releaseDate}'`);
  return lines.join('\n') + '\n';
}

export const sha512b64 = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

/**
 * After a file in the release folder changed (the DMG gets notarized and stapled after electron-builder wrote the
 * feed), put its real sha512 and size back into latest-mac.yml. Never touches the zip's entry.
 */
export function refreshFeedEntry(relDir, fileName) {
  const feedPath = path.join(relDir, FEED_FILE);
  const feed = parseFeed(fs.readFileSync(feedPath, 'utf8'));
  const e = feed.files.find((f) => f.url === fileName);
  if (!e) return false;
  const file = path.join(relDir, fileName);
  const sha = sha512b64(file);
  const size = fs.statSync(file).size;
  if (e.sha512 === sha && e.size === size) return false;
  e.sha512 = sha;
  e.size = size;
  fs.writeFileSync(feedPath, serializeFeed(feed));
  return true;
}

/**
 * Everything the updater relies on. Returns a list of problems (empty = good):
 *   - latest-mac.yml exists and names this version;
 *   - its `path` is the zip, and the top-level sha512 and the zip's file entry match the zip on disk (sha512 + size);
 *   - every other listed file exists in the folder with a matching sha512 and size;
 *   - the zip's .blockmap is there (for smaller, differential downloads next time).
 */
export function verifyFeed(relDir, version) {
  const problems = [];
  const feedPath = path.join(relDir, FEED_FILE);
  if (!fs.existsSync(feedPath)) return [`missing ${FEED_FILE} (electron-builder writes it when build.publish is set)`];
  let feed;
  try {
    feed = parseFeed(fs.readFileSync(feedPath, 'utf8'));
  } catch (e) {
    return [String(e?.message ?? e)];
  }
  const zip = zipName(version);
  const zipPath = path.join(relDir, zip);
  if (feed.version !== version) problems.push(`${FEED_FILE} is for ${feed.version}, not ${version}`);
  if (feed.path !== zip) problems.push(`${FEED_FILE} path is ${feed.path}, expected ${zip}`);
  if (!fs.existsSync(zipPath)) return [...problems, `missing ${zip}`];
  const zipSha = sha512b64(zipPath);
  const zipSize = fs.statSync(zipPath).size;
  if (feed.sha512 !== zipSha) problems.push(`${FEED_FILE} sha512 does not match ${zip}`);
  const ze = feed.files.find((f) => f.url === zip);
  if (!ze) problems.push(`${FEED_FILE} does not list ${zip}`);
  else if (ze.sha512 !== zipSha || ze.size !== zipSize) problems.push(`${FEED_FILE} entry for ${zip} does not match the file (sha512/size)`);
  for (const f of feed.files) {
    if (f.url === zip) continue;
    const p = path.join(relDir, f.url);
    if (!fs.existsSync(p)) problems.push(`${FEED_FILE} lists ${f.url}, which is not in the release folder`);
    else if (f.sha512 !== sha512b64(p) || f.size !== fs.statSync(p).size) problems.push(`${FEED_FILE} entry for ${f.url} does not match the file (sha512/size)`);
  }
  if (!fs.existsSync(`${zipPath}.blockmap`)) problems.push(`missing ${zip}.blockmap`);
  return problems;
}
