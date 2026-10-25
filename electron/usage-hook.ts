// Baton — passive usage capture (status-line hook), planned as safety-engine operations.
//
//   usage-hook-on   writes a small status-line script + a backup record, and sets ONE key, `statusLine`, in the
//                   account's settings.json.
//   usage-hook-off  puts settings.json back: byte-for-byte the original file when nothing else changed it since,
//                   otherwise only the `statusLine` key goes back to its previous value (or is removed).
//
// Both go through plan → dry-run preview → confirm → verified snapshot → journal → atomic write → verify →
// rollback, and can be undone from History. settings.json is edited as TEXT: only the statusLine member's bytes
// change, so every other key keeps its exact formatting. A file that is not a valid JSON object is refused, and an
// existing status line that is not Baton's is only replaced when the user explicitly chooses to.
//
// For account 1 the file is ~/.claude/settings.json — the one path inside ~/.claude the guard list allows, and only
// for these two operation kinds (safety.CLAUDE_SETTINGS_OPS).

import fs from 'node:fs';
import path from 'node:path';
import type { Account } from './core';
import type { Operation, Step } from './safety';
import { sha256 } from './safety';
import { roots } from './roots';

export const usageId = (acc: Pick<Account, 'slug'>) => acc.slug ?? 'default';
export const usageDir = () => path.join(roots().appDir, 'usage');
export const hooksDir = () => path.join(roots().appDir, 'hooks');
export const passiveFile = (acc: Pick<Account, 'slug'>) => path.join(usageDir(), `${usageId(acc)}.json`);
export const backupFile = (acc: Pick<Account, 'slug'>) => path.join(usageDir(), `${usageId(acc)}.hook-backup.json`);
export const hookScript = (acc: Pick<Account, 'slug'>) => path.join(hooksDir(), `statusline-${usageId(acc)}.sh`);
export const settingsFileOf = (acc: Pick<Account, 'configDir'>) => path.join(acc.configDir, 'settings.json');

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export interface HookStatus {
  installed: boolean;
  settingsFile: string;
  script: string;
  previous: unknown; // the statusLine value that turning it off restores
  current: unknown; // the statusLine value in settings.json now
  /** settings.json has a status line that is not Baton's (turning on would replace it — needs an explicit choice). */
  foreign: boolean;
}

const isOurs = (acc: Pick<Account, 'slug'>, v: any) => !!v && typeof v === 'object' && typeof v.command === 'string' && v.command.includes(hookScript(acc));

export function hookStatus(acc: Pick<Account, 'slug' | 'configDir'>): HookStatus {
  const s = readJson(settingsFileOf(acc));
  const current = s && typeof s === 'object' && !Array.isArray(s) ? (s.statusLine ?? null) : null;
  const installed = isOurs(acc, current);
  const backup = readJson(backupFile(acc));
  return {
    installed,
    settingsFile: settingsFileOf(acc),
    script: hookScript(acc),
    previous: installed ? (backup?.previousStatusLine ?? null) : current,
    current,
    foreign: !installed && current != null,
  };
}

// ---------- settings.json as text: find and edit ONE top-level member ----------

interface Member {
  key: string;
  start: number; // index of the key's opening quote
  valueStart: number;
  valueEnd: number; // exclusive
}
interface TopLevel {
  open: number; // index of '{'
  close: number; // index of the matching '}'
  members: Member[];
}

/** Parses settings.json text: refuses anything that is not a JSON object; returns the value and member spans. */
export function parseSettingsText(raw: string, file: string): { value: Record<string, unknown>; top: TopLevel | null } {
  if (!raw.trim()) return { value: {}, top: null }; // empty file = no settings yet
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`${file} is not valid JSON (${String(e?.message ?? e).split('\n')[0]}) — nothing was changed. Fix the file, then try again.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} is not a JSON object — nothing was changed.`);
  return { value: value as Record<string, unknown>, top: scanTop(raw) };
}

function scanTop(raw: string): TopLevel {
  let i = 0;
  const ws = () => {
    while (i < raw.length && /[\s﻿]/.test(raw[i])) i++;
  };
  const str = () => {
    const s = i;
    i++; // opening quote
    while (raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
    i++;
    return raw.slice(s, i);
  };
  const value = () => {
    if (raw[i] === '"') return void str();
    if (raw[i] === '{' || raw[i] === '[') {
      let depth = 0;
      do {
        if (raw[i] === '"') {
          str();
          continue;
        }
        if (raw[i] === '{' || raw[i] === '[') depth++;
        else if (raw[i] === '}' || raw[i] === ']') depth--;
        i++;
      } while (depth > 0);
      return;
    }
    while (i < raw.length && !/[\s,}\]]/.test(raw[i])) i++;
  };
  ws();
  const open = i;
  i++;
  const members: Member[] = [];
  for (;;) {
    ws();
    if (raw[i] === '}') break;
    const start = i;
    const key = JSON.parse(str()) as string;
    ws();
    i++; // ':'
    ws();
    const valueStart = i;
    value();
    members.push({ key, start, valueStart, valueEnd: i });
    ws();
    if (raw[i] === ',') i++;
  }
  return { open, close: i, members };
}

/** Indentation of the line a position is on (only when that line holds nothing else before it). */
function lineIndent(raw: string, pos: number): string | null {
  const nl = raw.lastIndexOf('\n', pos - 1);
  const before = raw.slice(nl + 1, pos);
  return /^[ \t]*$/.test(before) ? before : null;
}

const valueText = (v: unknown, indent: string) => JSON.stringify(v, null, 2).split('\n').join('\n' + indent);

/**
 * settings.json text with ONE top-level key set to `v` (or removed when `v` is undefined). Every other byte of the
 * file is kept. The result is re-parsed and must equal the original object with only that key changed.
 */
export function editSettingsKey(raw: string, key: string, v: unknown, file: string): string {
  const { value, top } = parseSettingsText(raw, file);
  const want: Record<string, unknown> = { ...value };
  if (v === undefined) delete want[key];
  else want[key] = v;
  let out: string;
  if (!top) {
    out = v === undefined ? raw : JSON.stringify({ [key]: v }, null, 2) + '\n';
  } else {
    const hits = top.members.filter((m) => m.key === key);
    if (hits.length > 1) throw new Error(`${file} has "${key}" more than once — nothing was changed. Remove the duplicate, then try again.`);
    const m = hits[0];
    if (m && v !== undefined) {
      out = raw.slice(0, m.valueStart) + valueText(v, lineIndent(raw, m.start) ?? '') + raw.slice(m.valueEnd);
    } else if (m) {
      const idx = top.members.indexOf(m);
      if (top.members.length === 1) out = raw.slice(0, top.open + 1) + raw.slice(top.close);
      else if (idx > 0) out = raw.slice(0, top.members[idx - 1].valueEnd) + raw.slice(m.valueEnd);
      else out = raw.slice(0, m.start) + raw.slice(top.members[1].start);
    } else if (v === undefined) {
      out = raw;
    } else if (top.members.length) {
      const last = top.members[top.members.length - 1];
      const multiline = raw.slice(top.open, top.members[0].start).includes('\n');
      const indent = lineIndent(raw, last.start) ?? '  ';
      out = multiline
        ? raw.slice(0, last.valueEnd) + `,\n${indent}${JSON.stringify(key)}: ${valueText(v, indent)}` + raw.slice(last.valueEnd)
        : raw.slice(0, last.valueEnd) + `, ${JSON.stringify(key)}: ${JSON.stringify(v)}` + raw.slice(last.valueEnd);
    } else {
      out = raw.slice(0, top.open) + `{\n  ${JSON.stringify(key)}: ${valueText(v, '  ')}\n}` + raw.slice(top.close + 1);
    }
  }
  // self-check: only that key differs
  const got = out.trim() ? JSON.parse(out) : {};
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`Could not edit ${file} safely — nothing was changed.`);
  return out;
}

// ---------- the hook script ----------

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function scriptBody(acc: Pick<Account, 'slug' | 'name' | 'configDir'>, previousCommand: string | null) {
  const out = passiveFile(acc);
  return `#!/bin/sh
# Baton — usage capture for "${acc.name.replace(/[^\w .-]/g, '')}" (${acc.configDir}).
# Saves only the rate_limits object from the status-line JSON to ${out}.
# Turn it off in Baton (Usage → Passive capture), which restores your previous statusLine.
in=$(cat)
out=${shq(out)}
rl=$(printf '%s' "$in" | /usr/bin/sed -nE 's/.*"rate_limits":(\\{("[a-z_]+":\\{[^{}]*\\},?)*\\}).*/\\1/p')
if [ -n "$rl" ]; then
  /bin/mkdir -p "$(dirname "$out")"
  printf '{"source":"statusline","capturedAt":%s,"rate_limits":%s}\\n' "$(/bin/date +%s)" "$rl" > "$out.tmp" && /bin/mv -f "$out.tmp" "$out"
fi
${
  previousCommand
    ? `# your previous status line, unchanged:\nprintf '%s' "$in" | /bin/sh -c ${shq(previousCommand)}`
    : `# no previous status line: show a short limits summary
p5=$(printf '%s' "$rl" | /usr/bin/sed -nE 's/.*"five_hour":\\{[^}]*"used_percentage":([0-9.]+).*/\\1/p' | cut -d. -f1)
p7=$(printf '%s' "$rl" | /usr/bin/sed -nE 's/.*"seven_day":\\{[^}]*"used_percentage":([0-9.]+).*/\\1/p' | cut -d. -f1)
[ -n "$p5$p7" ] && printf '5h %s%% · week %s%%\\n' "\${p5:-–}" "\${p7:-–}"`
}
exit 0
`;
}

// ---------- the two operations ----------

export interface HookBackup {
  settingsFile: string;
  fileExisted: boolean;
  previousStatusLine: unknown; // null = there was none
  originalFile: string; // the whole file before (restored byte-for-byte when nothing else changed it)
  wroteSha256?: string; // sha256 of the settings.json Baton wrote (absent in v1.0.0 backups)
  installedAt: string;
}

export interface HookPlanSummary {
  account: string;
  settingsFile: string;
  key: 'statusLine';
  before: unknown;
  after: unknown;
  replacesForeign: boolean;
}

const fmt = (v: unknown) => (v == null ? '(none)' : JSON.stringify(v));

/** Turn passive capture on. A foreign status line is replaced only when `replace` is true. */
export function planHookOn(acc: Account, o: { replace?: boolean } = {}): { op: Operation; summary: HookPlanSummary } {
  const file = settingsFileOf(acc);
  const exists = fs.existsSync(file);
  if (exists && !fs.lstatSync(file).isFile()) throw new Error(`${file} is not a regular file — nothing was changed.`);
  const raw = exists ? fs.readFileSync(file, 'utf8') : '';
  const { value } = parseSettingsText(raw, file);
  const prev = (value.statusLine ?? null) as any;
  const kind = 'usage-hook-on';
  const title = `Turn on passive usage capture for ${acc.name}`;
  if (isOurs(acc, prev)) {
    return { op: { kind, title, steps: [], touches: [], notes: ['Passive capture is already on for this account.'] }, summary: { account: acc.name, settingsFile: file, key: 'statusLine', before: prev, after: prev, replacesForeign: false } };
  }
  if (prev != null && !o.replace) {
    throw Object.assign(new Error(`${file} already has a status line (${fmt(prev)}). Choose "Replace" to continue: Baton keeps running it inside its own status line and restores it exactly when you turn capture off.`), { code: 'foreign-statusline' });
  }
  const prevCmd = prev && prev.type === 'command' && typeof prev.command === 'string' ? prev.command : null;
  const next: Record<string, unknown> = { type: 'command', command: hookScript(acc) };
  if (prev && typeof prev === 'object') {
    if (prev.padding != null) next.padding = prev.padding;
    if (prev.refreshInterval != null) next.refreshInterval = prev.refreshInterval;
  }
  const text = editSettingsKey(raw, 'statusLine', next, file);
  const backup: HookBackup = { settingsFile: file, fileExisted: exists, previousStatusLine: prev, originalFile: raw, wroteSha256: sha256(text), installedAt: new Date().toISOString() };
  const steps: Step[] = [
    { t: 'write', path: backupFile(acc), data: JSON.stringify(backup, null, 2) },
    { t: 'write', path: hookScript(acc), data: scriptBody(acc, prevCmd), mode: 0o755 },
    { t: 'write', path: file, data: text },
  ];
  const notes = [
    `${file}: only the "statusLine" key changes. Every other key stays exactly as it is.`,
    `statusLine before: ${fmt(prev)}`,
    `statusLine after: ${fmt(next)}`,
    `${hookScript(acc)} saves only the 5-hour and weekly limits from Claude Code's status-line data to ${passiveFile(acc)}. ` +
      (prevCmd ? 'It runs your previous status line unchanged.' : 'It prints a short "5h x% · week y%" status line.'),
    'To reverse: turn Passive capture off (restores statusLine exactly), or History › Undo this.',
  ];
  if (prev != null) notes.unshift(`Replaces your existing status line — it is kept in the backup and restored exactly when you turn capture off.`);
  return {
    op: { kind, title, steps, touches: steps.map((s) => s.path), notes },
    summary: { account: acc.name, settingsFile: file, key: 'statusLine', before: prev, after: next, replacesForeign: prev != null },
  };
}

/** Turn passive capture off: restore the previous statusLine exactly (and the original file when nothing else changed). */
export function planHookOff(acc: Account): { op: Operation; summary: HookPlanSummary } {
  const file = settingsFileOf(acc);
  const kind = 'usage-hook-off';
  const title = `Turn off passive usage capture for ${acc.name}`;
  const exists = fs.existsSync(file);
  if (exists && !fs.lstatSync(file).isFile()) throw new Error(`${file} is not a regular file — nothing was changed.`);
  const raw = exists ? fs.readFileSync(file, 'utf8') : '';
  const { value } = parseSettingsText(raw, file);
  const cur = (value.statusLine ?? null) as any;
  if (!isOurs(acc, cur)) {
    return { op: { kind, title, steps: [], touches: [], notes: ["Passive capture is not on for this account (settings.json's statusLine is not Baton's), so there is nothing to restore."] }, summary: { account: acc.name, settingsFile: file, key: 'statusLine', before: cur, after: cur, replacesForeign: false } };
  }
  const backup = readJson(backupFile(acc)) as HookBackup | null;
  const prev = backup?.previousStatusLine ?? null;
  const steps: Step[] = [];
  const untouched = !!backup?.wroteSha256 && backup.wroteSha256 === sha256(raw);
  if (untouched && !backup!.fileExisted) steps.push({ t: 'quarantine', path: file }); // Baton created it: put it back to "no file" (kept in the snapshot)
  else if (untouched) steps.push({ t: 'write', path: file, data: backup!.originalFile });
  else steps.push({ t: 'write', path: file, data: editSettingsKey(raw, 'statusLine', prev ?? undefined, file) });
  if (fs.existsSync(hookScript(acc))) steps.push({ t: 'quarantine', path: hookScript(acc) });
  const notes = [
    untouched
      ? backup!.fileExisted
        ? `${file}: put back exactly as it was before capture was turned on (nothing else changed it since).`
        : `${file}: did not exist before capture was turned on — moved into this operation's snapshot (kept, restorable).`
      : `${file}: only the "statusLine" key changes. Every other key stays exactly as it is.`,
    `statusLine before: ${fmt(cur)}`,
    `statusLine after: ${fmt(prev)}`,
    `${hookScript(acc)} moves into the snapshot (kept, restorable).`,
  ];
  return {
    op: { kind, title, steps, touches: steps.map((s) => s.path), notes },
    summary: { account: acc.name, settingsFile: file, key: 'statusLine', before: cur, after: prev, replacesForeign: false },
  };
}
