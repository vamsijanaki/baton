import { useCallback, useEffect, useState } from 'react';
import { AppWindow, ChevronRight, FolderInput, Combine, ExternalLink, KeyRound, LogIn, Palette, Plus, RefreshCw, Repeat, TerminalSquare, Trash2 } from 'lucide-react';
import type { AccountCard, AccountsOverview, AppInfo, MergeSummary, Usage } from './types';
import { Badge, Button, Card, Checkbox, cn, Dialog, Input, PageHeader, Tooltip } from './ui';
import { tilde, timeAgo } from './lib';
import { cleanErr, useOps } from './ops';

/** Swatches for the desktop-app icon colors (the app copy's icon is Claude's icon hue-rotated). */
export const SWATCH: Record<string, string> = {
  orange: '#d97757',
  red: '#cf4d45',
  yellow: '#d6b23c',
  green: '#6a9e4f',
  teal: '#3e9f98',
  blue: '#4b7fd1',
  purple: '#8b65cc',
  pink: '#cb5f9f',
};
type ToastFn = (t: string, tone?: 'ok' | 'warn') => void;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Accounts: ONE concept. An account is an email; its card shows where it works — Terminal (its config folder) and the
 * Claude desktop app(s) signed in as the same email — plus its usage.
 */
export function AccountsView({
  toast,
  usage,
  warnPct,
  onContinue,
  onAdd,
}: {
  toast: ToastFn;
  usage: Record<string, Usage>;
  warnPct: number;
  onContinue: (accountId: string) => void;
  onAdd: () => void;
}) {
  const [ov, setOv] = useState<AccountsOverview | null>(null);
  const [merging, setMerging] = useState<AccountCard | null>(null);
  const [made, setMade] = useState<{ id: string; name: string; account?: string } | null>(null);
  const [removing, setRemoving] = useState<AppInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const runOp = useOps();
  const load = useCallback(() => window.cs.accountsOverview().then(setOv).catch(() => undefined), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    window.addEventListener('focus', load);
    return () => (clearInterval(t), window.removeEventListener('focus', load));
  }, [load]);
  if (!ov) return null;

  const open = (a: AppInfo, label = a.name) => {
    setBusy(a.id);
    window.cs
      .desktopOpen(a.id)
      .then((r) => r.opened && toast(a.running ? `${label} brought forward` : `Opening ${label}…`, 'ok'))
      .catch((e) => toast(cleanErr(e), 'warn'))
      .finally(() => (setBusy(null), load()));
  };
  const create = (c: AccountCard) =>
    runOp({
      kind: 'app-create',
      args: { accountId: c.key },
      title: `Create desktop app for ${c.name}`,
      confirmLabel: 'Create desktop app',
      onDone: (r) => (load(), r.summary && setMade(r.summary)),
    });
  const dupes = ov.accounts.filter((c) => c.extras.length > 0);
  const stale = [...ov.accounts.flatMap((c) => c.apps), ...ov.unpaired].filter((a) => a.needsUpdate);
  const sameOffer = !ov.sameAccountSync && ov.offer;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Accounts"
        subtitle="An account is one Claude sign-in — one email. Each account can work in Terminal and in the Claude desktop app, and continue a shared project's chats with its history intact."
        actions={
          <Button variant="secondary" onClick={onAdd}>
            <Plus size={13} /> Add account…
          </Button>
        }
      />

      <p className="flex items-start gap-2 rounded-xl border border-line bg-hover/60 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">
        <KeyRound size={14} className="mt-0.5 shrink-0 text-subtle" aria-hidden />
        <span>
          <b className="text-fg">Signing in:</b> each desktop app needs one sign-in the first time, and stays signed in after that. Baton never copies sign-ins between apps
          or accounts — it can't, and it won't.
        </span>
      </p>

      {dupes.map((c) => (
        <section key={`d-${c.key}`} role="note" className="animate-up flex items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3 text-[12.5px]">
          <Combine size={15} className="shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 leading-relaxed">
            <b>{plural(c.extras.length, 'extra desktop app')}</b> {c.extras.length === 1 ? 'is' : 'are'} signed in as <b>{c.email ?? c.name}</b>
            <span className="block text-[11.5px] text-muted">
              {list(c.apps.slice(1).map((a) => a.name))} {c.extras.length === 1 ? 'shows' : 'show'} the same account as {c.apps[0].name}. Tidying up keeps {c.apps[0].name} and copies over any chats it is
              missing.
            </span>
          </span>
          <Button size="sm" variant="secondary" onClick={() => setMerging(c)}>
            Merge &amp; tidy up…
          </Button>
        </section>
      ))}

      {sameOffer && (
        <section role="note" className="animate-up flex items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3 text-[12.5px]">
          <Repeat size={15} className="shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 leading-relaxed">
            <b>Same account, same chat list</b>
            <span className="block text-[11.5px] text-muted">
              Keep every desktop app signed in as the same account showing the same Code sidebar.{' '}
              {ov.offer!.copies
                ? `${plural(ov.offer!.copies, 'sidebar entry', 'sidebar entries')} would be copied now${ov.offer!.deferred ? `, ${ov.offer!.deferred} more after open apps quit` : ''}.`
                : ov.offer!.deferred
                  ? `${plural(ov.offer!.deferred, 'sidebar entry', 'sidebar entries')} would be copied after open apps quit.`
                  : 'They already match.'}
            </span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              runOp({ kind: 'same-account-sync', title: 'Same account, same chat list', confirmLabel: 'Turn on', intro: 'Newest edit wins, the other version is kept in the snapshot, nothing is deleted.', onDone: load })
            }
          >
            Review…
          </Button>
        </section>
      )}

      {stale.length > 0 && (
        <section className="animate-up flex items-center gap-3 rounded-2xl border border-warn/30 bg-warn/8 px-4 py-3 text-[12.5px]">
          <RefreshCw size={14} className="shrink-0 text-warn" aria-hidden />
          <span className="flex-1">
            Claude was updated to <b>{ov.claudeVersion}</b>. {list(stale.map((a) => a.name))} still {stale.length === 1 ? 'uses' : 'use'} the older copy. Updating keeps sign-ins and chats; open
            apps are skipped.
          </span>
          <Button size="sm" variant="primary" onClick={() => runOp({ kind: 'profile-update', title: 'Update desktop apps', confirmLabel: 'Update', onDone: load })}>
            Update…
          </Button>
        </section>
      )}

      <div className="space-y-3">
        {ov.accounts.map((c) => (
          <AccountCardView
            key={c.key}
            c={c}
            usage={c.terminal ? usage[c.terminal.id] : undefined}
            warnPct={warnPct}
            busy={busy}
            onOpen={open}
            onCreate={() => create(c)}
            onContinue={() => c.terminal && onContinue(c.terminal.id)}
            onAdd={onAdd}
            onSignIn={() => c.terminal && window.cs.signIn(c.terminal.id).then(() => toast('Terminal opened for sign-in', 'ok'))}
          />
        ))}
      </div>

      {ov.unpaired.length > 0 && (
        <Card title="Desktop apps waiting for their first sign-in" icon={<LogIn size={15} />}>
          <div className="divide-y divide-line">
            {ov.unpaired.map((a) => (
              <div key={a.id} className="flex items-center gap-3 py-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ border: `2px solid ${SWATCH[a.color]}` }} aria-hidden />
                <span className="min-w-0 flex-1 text-[12.5px]">
                  <span className="font-medium">{a.name}</span> <span className="text-muted">· not signed in yet</span>
                </span>
                <Button size="sm" variant="primary" disabled={busy === a.id} onClick={() => open(a)}>
                  <LogIn size={12} /> Open to sign in
                </Button>
                {!a.isDefault && (
                  <Button size="icon" variant="ghost" aria-label={`Remove ${a.name}`} onClick={() => setRemoving(a)}>
                    <Trash2 size={13} />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Advanced ov={ov} onRemove={setRemoving} onChanged={load} />

      {merging && <MergeDialog c={merging} onClose={() => setMerging(null)} onDone={load} />}
      <FirstSignIn made={made} onClose={() => setMade(null)} toast={toast} onDone={load} />
      <RemoveDialog a={removing} onClose={() => setRemoving(null)} onDone={load} />
    </div>
  );
}

function UsagePill({ u, warnPct }: { u?: Usage; warnPct: number }) {
  if (!u?.fiveHour && !u?.sevenDay) return <span className="text-[11.5px] text-subtle">usage not checked yet</span>;
  const cell = (label: string, pct?: number) => (
    <span className="tabular-nums">
      {label} {pct != null ? `${Math.round(pct)}%` : '–'}
    </span>
  );
  return (
    <span className="flex items-center gap-2 rounded-full bg-hover px-2.5 py-0.5 text-[11.5px] text-muted" title="Usage limits used (5-hour window · week)">
      {cell('5h', u.fiveHour?.pct)}
      <span className="text-subtle">·</span>
      {cell('week', u.sevenDay?.pct)}
    </span>
  );
}

function AccountCardView({
  c,
  usage,
  warnPct,
  busy,
  onOpen,
  onCreate,
  onContinue,
  onAdd,
  onSignIn,
}: {
  c: AccountCard;
  usage?: Usage;
  warnPct: number;
  busy: string | null;
  onOpen: (a: AppInfo, label?: string) => void;
  onCreate: () => void;
  onContinue: () => void;
  onAdd: () => void;
  onSignIn: () => void;
}) {
  const main = c.apps[0];
  const waiting = c.waiting[0];
  return (
    <section className="animate-up rounded-2xl border border-line bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]" aria-label={`Account ${c.name}`}>
      <div className="flex items-center gap-3 px-4 pb-3 pt-4">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[15px] font-semibold text-white"
          style={{ background: `linear-gradient(140deg, ${c.color}, color-mix(in srgb, ${c.color} 70%, black))` }}
          aria-hidden
        >
          {c.name.trim().charAt(0).toUpperCase() || '?'}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold tracking-[-0.01em]">{c.name}</p>
          <p className="truncate text-[12px] text-muted">{c.email ?? 'Email appears after the first sign-in'}</p>
        </div>
        {c.terminal && <UsagePill u={usage} warnPct={warnPct} />}
      </div>
      <div className="divide-y divide-line border-t border-line">
        {/* Terminal */}
        <div className="flex items-center gap-3 px-4 py-2.5">
          <TerminalSquare size={15} className="shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium">Terminal</p>
            <p className="truncate text-[11.5px] text-muted">
              {c.terminal ? (
                <>
                  <button className="selectable font-mono text-[11px] hover:text-fg" onClick={() => window.cs.reveal(c.terminal!.configDir)}>
                    {tilde(c.terminal.configDir)}
                  </button>{' '}
                  · {c.terminal.signedIn ? 'signed in' : 'not signed in yet'}
                </>
              ) : (
                'No Terminal sign-in for this account yet.'
              )}
            </p>
          </div>
          {c.terminal ? (
            c.terminal.signedIn ? (
              <Button size="sm" variant="ghost" onClick={onContinue}>
                Continue in Terminal <ChevronRight size={12} />
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={onSignIn}>
                <LogIn size={12} /> Sign in
              </Button>
            )
          ) : (
            <Button size="sm" variant="ghost" onClick={onAdd}>
              <Plus size={12} /> Add to Terminal…
            </Button>
          )}
        </div>
        {/* Desktop app */}
        <div className="flex items-center gap-3 px-4 py-2.5">
          <AppWindow size={15} className="shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium">
              Desktop app
              {main && (
                <>
                  <span className="font-normal text-muted">· {main.name}</span>
                  {main.running && <Badge tone="ok">open</Badge>}
                  {c.extras.length > 0 && <Badge tone="neutral">+{c.extras.length} extra</Badge>}
                </>
              )}
            </p>
            <p className="truncate text-[11.5px] text-muted">
              {main
                ? `${plural(main.sessions, 'chat')} in its Code sidebar${c.extras.length ? ` · also signed in: ${list(c.apps.slice(1).map((a) => a.name))}` : ''}`
                : waiting
                  ? `${waiting.name} is ready — open it once and sign in as ${c.email ?? c.name}.`
                  : 'None yet. Get its own Claude desktop app, side by side with your others.'}
            </p>
          </div>
          {main ? (
            <Button size="sm" variant="secondary" disabled={busy === main.id} onClick={() => onOpen(main, `${c.name} in the desktop app`)}>
              <ExternalLink size={12} /> {main.running ? `Show ${c.name} in desktop app` : `Open ${c.name} in desktop app`}
            </Button>
          ) : waiting ? (
            <Button size="sm" variant="primary" disabled={busy === waiting.id} onClick={() => onOpen(waiting)}>
              <LogIn size={12} /> Open to sign in
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onCreate}>
              <Plus size={12} /> Create desktop app for {c.name}…
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------- merge & tidy up ----------

function MergeDialog({ c, onClose, onDone }: { c: AccountCard; onClose: () => void; onDone: () => void }) {
  const [keep, setKeep] = useState(c.kept ?? c.apps[0].id);
  const [remove, setRemove] = useState<string[]>(c.apps.filter((a) => a.id !== (c.kept ?? c.apps[0].id) && !a.isDefault).map((a) => a.id));
  const [trash, setTrash] = useState(false);
  const runOp = useOps();
  const keptApp = c.apps.find((a) => a.id === keep)!;
  const pickKeep = (id: string) => (setKeep(id), setRemove(c.apps.filter((a) => a.id !== id && !a.isDefault).map((a) => a.id)));
  const names = c.apps.filter((a) => remove.includes(a.id)).map((a) => a.name);
  const review = () => {
    onClose();
    runOp({
      kind: 'merge-apps',
      args: { keep, remove, trashData: trash },
      title: `Merge & tidy up ${c.email ?? c.name}`,
      confirmLabel: trash ? 'Merge and move to Trash' : 'Merge & tidy up',
      danger: trash,
      intro: `Keeps ${keptApp.name}. Every app involved must be quit first — Baton waits for that and changes nothing while one is open.`,
      renderSummary: (s: MergeSummary) => <MergeSummaryView s={s} />,
      onDone,
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={560}
      title={`Merge & tidy up ${c.email ?? c.name}`}
      description={`${c.apps.length} desktop apps are signed in as this account. Keep one; the others' chats are copied into it first.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!remove.length} onClick={review}>
            Review changes…
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[12.5px]">
        <fieldset>
          <legend className="mb-1 text-[12px] font-semibold">Keep</legend>
          {c.apps.map((a) => (
            <label key={a.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover">
              <input type="radio" name="keep" className="accent-[var(--accent)]" checked={keep === a.id} onChange={() => pickKeep(a.id)} />
              <span className="flex-1">
                {a.name} <span className="text-muted">· {plural(a.sessions, 'chat')}</span> {a.running && <Badge tone="neutral">open</Badge>}
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-[12px] font-semibold">Tidy up</legend>
          {c.apps
            .filter((a) => a.id !== keep)
            .map((a) => (
              <Checkbox
                key={a.id}
                checked={remove.includes(a.id)}
                disabled={a.isDefault}
                onChange={(v) => setRemove(v ? [...remove, a.id] : remove.filter((x) => x !== a.id))}
                label={a.name}
                hint={a.isDefault ? 'The default Claude app is never removed.' : `Copy its chats into ${keptApp.name}, then remove its app copy.`}
              />
            ))}
        </fieldset>
        <div className="rounded-xl border border-line p-3">
          <Checkbox
            checked={trash}
            onChange={setTrash}
            label={<span>Also move {names.length ? list(names) : 'their'}'s data folder{names.length === 1 ? '' : 's'} to the Trash</span>}
            hint="Off by default: the data folder stays where it is (sign-in, settings, local data) and is listed under Advanced. If on, Finder › Put Back restores it until you empty the Trash."
          />
        </div>
        <ul className="list-disc space-y-0.5 pl-5 text-[11.5px] leading-relaxed text-muted">
          <li>Copy-only: chats {keptApp.name} already lists are never overwritten.</li>
          <li>The chats themselves live in ~/.claude/projects and are not touched.</li>
          <li>Undo it later from History.</li>
        </ul>
      </div>
    </Dialog>
  );
}

function MergeSummaryView({ s }: { s: MergeSummary }) {
  return (
    <div className="space-y-2 rounded-xl border border-line p-3 text-[12px] leading-relaxed">
      <p>
        <b>Keep:</b> {s.keep.name} — {plural(s.keep.sessions, 'chat')} now, {s.keep.sessions + s.copies} after merging.
      </p>
      {s.remove.map((r) => (
        <p key={r.id}>
          <b>{r.name}:</b> {r.copies ? `${plural(r.copies, 'chat')} copied` : 'nothing to copy'}
          {r.alreadyThere ? ` (${r.alreadyThere} already in ${s.keep.name}, left as they are)` : ''} · app copy removed ·{' '}
          {s.trashData ? 'data folder → Trash' : <span className="text-muted">data folder kept ({tilde(r.dataDir)})</span>}
        </p>
      ))}
    </div>
  );
}

// ---------- advanced ----------

function Advanced({ ov, onRemove, onChanged }: { ov: AccountsOverview; onRemove: (a: AppInfo) => void; onChanged: () => void }) {
  const runOp = useOps();
  const all = [...ov.accounts.flatMap((c) => c.apps.map((a) => ({ a, owner: c.email ?? c.name }))), ...ov.accounts.flatMap((c) => c.waiting.map((a) => ({ a, owner: `${c.name} (sign-in pending)` })))];
  // data folders found on this Mac that Baton did not create and has no app copy for yet
  const found = [...all.map((x) => x.a), ...ov.unpaired].filter((a) => !a.isDefault && a.origin === 'other' && !a.cloneSource);
  return (
    <details className="group rounded-2xl border border-line bg-card px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[12.5px] font-medium text-muted hover:text-fg">
        <ChevronRight size={13} className="transition-transform group-open:rotate-90" aria-hidden /> Advanced — desktop app details
      </summary>
      <div className="mt-3 space-y-4 text-[12px]">
        <div>
          <p className="mb-1 font-semibold">Desktop apps on this Mac</p>
          <div className="divide-y divide-line">
            {all.map(({ a, owner }) => (
              <div key={a.id} className="flex items-center gap-2.5 py-1.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SWATCH[a.color] }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{a.name}</span> <span className="text-muted">· {owner}</span>
                  <button className="selectable block truncate font-mono text-[10.5px] text-subtle hover:text-fg" onClick={() => window.cs.reveal(a.dataDir)}>
                    {tilde(a.dataDir)}
                  </button>
                </span>
                {a.cloneVersion && <span className="text-[11px] text-subtle">Claude {a.cloneVersion}</span>}
                {!a.isDefault && (
                  <>
                    <ColorMenu a={a} colors={ov.colors} onPick={(color) => runOp({ kind: 'profile-color', args: { id: a.id, color }, title: `Icon color of ${a.name}`, onDone: onChanged })} />
                    <Tooltip text={a.running ? `Quit ${a.name} first` : 'Remove desktop app…'}>
                      <Button size="icon" variant="ghost" aria-label={`Remove ${a.name}`} disabled={a.running} onClick={() => onRemove(a)}>
                        <Trash2 size={13} />
                      </Button>
                    </Tooltip>
                  </>
                )}
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-subtle">
            Each extra desktop app is an APFS copy of /Applications/Claude.app (near-zero disk, Anthropic's signature untouched) with a tinted icon and its own data folder. App copies:{' '}
            {tilde(ov.clones)}
          </p>
        </div>
        {found.length > 0 && (
          <div>
            <p className="mb-1 font-semibold">Found on this Mac</p>
            {found.map((a) => (
              <div key={a.id} className="flex items-center gap-3 py-1">
                <FolderInput size={13} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 text-muted">
                  Found an existing desktop app data folder — <b className="text-fg">{a.name}</b>. Adopting gives it Baton's own app copy; its sign-in and chats stay where they are.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => runOp({ kind: 'profile-adopt', args: { id: a.id }, title: `Adopt ${a.name}`, confirmLabel: 'Adopt', onDone: onChanged })}
                >
                  Adopt
                </Button>
              </div>
            ))}
          </div>
        )}
        {ov.leftovers.length > 0 && (
          <div>
            <p className="mb-1 font-semibold">Old sign-in leftovers</p>
            {ov.leftovers.map((l) => (
              <p key={l.key} className="text-muted">
                {l.profileName} still keeps a chat list from an earlier sign-in as <b className="text-fg">{l.email ?? `account …${l.accountUuid.slice(-4)}`}</b> ({plural(l.sessions, 'chat')}). It is not a second
                account of that app; Baton leaves it alone and never syncs it.
              </p>
            ))}
          </div>
        )}
        {ov.retired.length > 0 && (
          <div>
            <p className="mb-1 font-semibold">Tidied-up apps (data folder kept)</p>
            {ov.retired.map((r) => (
              <p key={r.id} className="text-muted">
                {r.name} — merged into {r.into.replace(/^Claude-/, '')} {timeAgo(Date.parse(r.at))} ·{' '}
                <button className="selectable font-mono text-[10.5px] hover:text-fg" onClick={() => window.cs.reveal(r.dataDir)}>
                  {tilde(r.dataDir)}
                </button>
                . History › Undo brings the app back.
              </p>
            ))}
          </div>
        )}
        <div>
          <p className="mb-1 font-semibold">First sign-in</p>
          <p className="leading-relaxed text-muted">
            Claude's login comes back through a claude:// link, and macOS gives it to whichever Claude app is running. So for an app with no sign-in yet, the other Claude apps are quit
            first (you confirm), then only that one opens. Afterwards they all run side by side and stay signed in.
          </p>
        </div>
      </div>
    </details>
  );
}

function ColorMenu({ a, colors, onPick }: { a: AppInfo; colors: string[]; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <Tooltip text="Icon color">
        <Button size="icon" variant="ghost" aria-label={`Icon color of ${a.name}`} onClick={() => setOpen(!open)}>
          <Palette size={13} />
        </Button>
      </Tooltip>
      {open && (
        <span className="absolute right-0 top-8 z-40 flex gap-1.5 rounded-lg border border-line bg-panel p-2 shadow-lg" onMouseLeave={() => setOpen(false)}>
          {colors.map((c) => (
            <button
              key={c}
              title={c}
              aria-label={c}
              onClick={() => (onPick(c), setOpen(false))}
              className={cn('h-4 w-4 rounded-full transition-transform hover:scale-125', c === a.color && 'ring-2 ring-fg/40 ring-offset-1 ring-offset-panel')}
              style={{ background: SWATCH[c] }}
            />
          ))}
        </span>
      )}
    </span>
  );
}

function FirstSignIn({ made, onClose, toast, onDone }: { made: { id: string; name: string; account?: string } | null; onClose: () => void; toast: ToastFn; onDone: () => void }) {
  if (!made) return null;
  const who = made.account ?? made.name;
  return (
    <Dialog
      open
      onClose={onClose}
      width={500}
      title={`${who}'s desktop app is ready`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Later
          </Button>
          <Button
            variant="primary"
            autoFocus
            onClick={() =>
              window.cs
                .desktopOpen(made.id)
                .then((r) => r.opened && toast(`Opening ${made.name} — sign in there as ${who}`, 'ok'))
                .catch((e) => toast(cleanErr(e), 'warn'))
                .finally(() => (onClose(), onDone()))
            }
          >
            <LogIn size={13} /> Open to sign in
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-muted">
        Open it once and sign in as <b className="text-fg">{who}</b> — it stays signed in after that. Claude's login comes back through a claude:// link that macOS gives to whichever
        Claude app is running, so <i>Open to sign in</i> asks first and quits the other Claude apps, then opens only this one. Reopen the others afterwards; from then on they all run
        side by side.
      </p>
    </Dialog>
  );
}

function RemoveDialog({ a, onClose, onDone }: { a: AppInfo | null; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const runOp = useOps();
  useEffect(() => setTyped(''), [a]);
  if (!a) return null;
  const go = (mode: 'launcher' | 'everything') => {
    onClose();
    runOp({
      kind: 'profile-remove',
      args: { id: a.id, mode, typed: mode === 'everything' ? typed : undefined },
      title: mode === 'launcher' ? `Remove ${a.name} (keep its data)` : `Delete ${a.name} — everything`,
      confirmLabel: mode === 'launcher' ? 'Remove app' : 'Move to Trash',
      danger: mode === 'everything',
      onDone,
    });
  };
  return (
    <Dialog open onClose={onClose} width={500} title={`Remove the desktop app ${a.name}?`}>
      <div className="space-y-3 text-[12.5px]">
        <div className="rounded-xl border border-line p-3">
          <p className="font-medium">App only</p>
          <p className="mt-0.5 text-muted">
            Removes the app copy. Keeps {tilde(a.dataDir)} — sign-in, settings, {plural(a.sessions, 'chat')} in its sidebar. Opening it again rebuilds the app.
          </p>
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="secondary" onClick={() => go('launcher')}>
              Review: app only…
            </Button>
          </div>
        </div>
        <div className="rounded-xl border border-danger/40 p-3">
          <p className="font-medium text-danger">Delete everything</p>
          <p className="mt-0.5 text-muted">
            Also moves {tilde(a.dataDir)} to the macOS Trash. Chats in ~/.claude/projects are not touched. Finder › Put Back restores it until you empty the Trash.
          </p>
          <label className="mt-2 block text-[12px] text-muted">
            Type <span className="font-mono text-fg">{a.name}</span> to confirm
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="mt-1" aria-label={`Type ${a.name} to confirm`} />
          </label>
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="danger" disabled={typed !== a.name} onClick={() => go('everything')}>
              Review: delete everything…
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

