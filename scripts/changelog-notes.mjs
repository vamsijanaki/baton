#!/usr/bin/env node
// Prints the body of the "## [X.Y.Z]" section of CHANGELOG.md (used as GitHub Release notes).
//   node scripts/changelog-notes.mjs 1.2.3
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function changelogSection(version, text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')) {
  const out = [];
  let on = false;
  for (const line of text.split('\n')) {
    if (!on) {
      if (line.startsWith(`## [${version}]`)) on = true;
      continue;
    }
    if (/^## \[/.test(line) || /^\[[^\]]+\]: /.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const v = (process.argv[2] || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error('usage: node scripts/changelog-notes.mjs <x.y.z>');
    process.exit(2);
  }
  const body = changelogSection(v);
  if (!body) {
    console.error(`CHANGELOG.md has no (or an empty) "## [${v}]" section.`);
    process.exit(1);
  }
  process.stdout.write(body + '\n');
}
