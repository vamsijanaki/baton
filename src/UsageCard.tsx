import { Activity, Gauge, RefreshCw, Terminal } from 'lucide-react';
import type { Account, Usage, UsageWindow } from './types';
import { useState } from 'react';
import { Badge, Button, cn, Dialog, Toggle, Tooltip } from './ui';
import { tilde, timeAgo } from './lib';
import { useOps } from './ops';

const fmtLine = (v: unknown) => (v == null ? '(none)' : JSON.stringify(v, null, 2));

/** The exact statusLine change, shown above the dry run. */
function HookSummary({ s }: { s: { settingsFile: string; before: unknown; after: unknown } }) {
  return (
    <div className="space-y-1 text-[12px]">
      <p className="text-muted">
        Changes one key, <code>statusLine</code>, in <span className="selectable font-mono text-[11px]">{tilde(s.settingsFile)}</span>. Every other key is kept exactly as it is.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {(['before', 'after'] as const).map((k) => (
          <div key={k}>
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle">{k}</div>
            <pre className="selectable max-h-[140px] overflow-auto rounded-lg bg-hover px-2.5 py-1.5 font-mono text-[10.8px] leading-relaxed">{tilde(fmtLine(s[k]))}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function until(ms: number | null | undefined, now: number) {
  if (!ms) return null;
  const d = ms - now;
  if (d <= 0) return 'reset now';
  const m = Math.floor(d / 6e4);
  const h = Math.floor(m / 60);
  const days = Math.floor(h / 24);
  return days > 0 ? `${days}d ${h % 24}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function Bar({ label, w, warn, now }: { label: string; w: UsageWindow | null | undefined; warn: number; now: number }) {
  const pct = w ? Math.max(0, Math.min(100, w.pct)) : 0;
  const tone = !w ? 'bg-line' : pct >= warn ? 'bg-danger' : pct >= warn * 0.75 ? 'bg-warn' : 'bg-ok';
  const reset = w?.resetsAt
    ? `resets in ${until(w.resetsAt, now)} · ${new Date(w.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
    : w?.resetText
      ? `resets ${w.resetText}`
      : w
        ? 'no reset pending'
        : 'not known yet';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium">{label}</span>
        <span className={cn('text-[18px] font-semibold tabular-nums tracking-[-0.02em]', w && pct >= warn && 'text-danger')}>
          {w ? `${Math.round(pct)}%` : '–'}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-hover">
        <div className={cn('h-full rounded-full transition-[width] duration-500', tone)} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-[11px] tabular-nums text-muted">{reset}</div>
    </div>
  );
}

export function UsageCard({
  account,
  usage,
  warnPct,
  isActive,
  now,
  toast,
}: {
  account: Account;
  usage: Usage | undefined;
  warnPct: number;
  isActive: boolean;
  now: number;
  toast: (t: string, tone?: 'ok' | 'warn') => void;
}) {
  const err = (e: any) => toast(String(e?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, ''), 'warn');
  const runOp = useOps();
  const [askReplace, setAskReplace] = useState<{ current: unknown; settingsFile: string } | null>(null);
  // passive capture on/off = a safety-engine operation (preview → confirm → snapshot → journal → undo in History)
  const hookOp = (on: boolean, replace = false) =>
    runOp({
      kind: on ? 'usage-hook-on' : 'usage-hook-off',
      args: { id: account.id, replace },
      title: on ? `Passive capture for “${account.name}”` : `Turn off passive capture for “${account.name}”`,
      confirmLabel: on ? 'Turn on' : 'Turn off',
      danger: account.isDefault,
      renderSummary: (sum) => <HookSummary s={sum} />,
      onDone: () => toast(on ? 'Passive capture on — updates as you work' : 'Passive capture off — status line restored', 'ok'),
    });
  const toggleHook = (on: boolean) =>
    window.cs
      .usageHookInfo(account.id)
      .then((info) => {
        if (on && !info.installed && info.foreign) setAskReplace({ current: info.current, settingsFile: info.settingsFile });
        else hookOp(on);
      })
      .catch(err);
  const u = usage;
  const checked = u?.capturedAt ?? null;
  const refresh = () =>
    window.cs
      .usageRefresh(account.id)
      .then((r) => r?.throttled && toast(`Checked less than 15 minutes ago — next check from ${new Date(r.throttled.nextAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`, 'ok'))
      .catch(err);

  return (
    <section className={'animate-up rounded-2xl border border-line bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]'}>
      <div className="flex items-center gap-2">
        <Gauge size={15} className="text-muted" />
        <h3 className="text-[13px] font-semibold">Usage limits</h3>
        <span className="text-[11.5px] text-subtle">
          {checked ? `checked ${timeAgo(checked)}` : 'not checked yet'}
          {u?.source === 'statusline' ? ' · from status line' : u?.source === 'usage-command' ? ' · from /usage' : ''}
        </span>
        <div className="flex-1" />
        <Tooltip text="Opens Terminal running claude /usage for this account">
          <Button size="sm" variant="ghost" onClick={() => window.cs.openUsage(account.id).catch(err)}>
            <Terminal size={12} /> Open /usage
          </Button>
        </Tooltip>
        <Button
          size="sm"
          variant="secondary"
          disabled={!account.signedIn || u?.probing}
          onClick={() => refresh()}
        >
          <RefreshCw size={12} className={cn(u?.probing && 'animate-spin')} /> {u?.probing ? 'Checking…' : 'Refresh'}
        </Button>
      </div>

      {!account.signedIn ? (
        <p className="mt-3 text-[12px] text-muted">
          Sign in first — limits come from this account's own Claude Code. {account.isDefault && 'Use Sign in above (opens Terminal running claude /login for ~/.claude).'}
        </p>
      ) : (
        <>
          {!u?.probing && !u?.fiveHour && !u?.sevenDay && (
            <p className="mt-3 text-[12px] text-muted" role="status">
              Usage unavailable —{' '}
              <button className="text-accent hover:underline" onClick={() => refresh()}>
                Refresh
              </button>
            </p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-5">
            <Bar label="5-hour session" w={u?.fiveHour} warn={warnPct} now={now} />
            <Bar label="Weekly · all models" w={u?.sevenDay} warn={warnPct} now={now} />
          </div>
          {!!u?.extra?.length && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {u.extra.map((x) => (
                <Badge key={x.label} tone={x.pct >= warnPct ? 'danger' : 'neutral'}>
                  {x.label}: {Math.round(x.pct)}%
                </Badge>
              ))}
            </div>
          )}
          {u?.error && <p className="mt-2 text-[11.5px] text-warn">{u.error}</p>}
        </>
      )}

      <AuthLine account={account} usage={u} />

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-[11.5px] text-muted">
        <Toggle
          checked={!!u?.hook}
          onChange={toggleHook}
          label={
            <span title="Installs a tiny status-line command in this account's settings.json that saves the limits Claude Code already shows it. Free; turn off to restore.">
              <Activity size={11} className="mr-1 inline" />
              Passive capture
            </span>
          }
        />
        <span className="ml-auto text-subtle" title="Informational only — know where you stand. Baton never switches accounts or suggests another one when a limit is near.">
          Checked when Baton opens and on Refresh · at most every 15 min
        </span>
      </div>
      <Dialog
        open={!!askReplace}
        onClose={() => setAskReplace(null)}
        width={560}
        title="Replace your status line?"
        description={askReplace ? <>This account's <span className="font-mono text-[11px]">{tilde(askReplace.settingsFile)}</span> already has a status line that is not Baton's.</> : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAskReplace(null)} autoFocus>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => (setAskReplace(null), hookOp(true, true))}>
              Replace and review…
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-[12px] text-muted">
          <pre className="selectable max-h-[140px] overflow-auto rounded-lg bg-hover px-2.5 py-1.5 font-mono text-[10.8px] leading-relaxed">{fmtLine(askReplace?.current)}</pre>
          <p>Baton's status line keeps running this command, so what you see stays the same. Turning capture off puts this value back exactly. You will see the exact change before anything is written.</p>
        </div>
      </Dialog>
    </section>
  );
}

function AuthLine({ account, usage }: { account: Account; usage: Usage | undefined }) {
  const a = usage?.auth;
  if (!account.signedIn && !a) return null;
  if (!a) return <p className="mt-2 text-[11px] text-subtle">Auth check: running claude auth status…</p>;
  const expected = account.email?.toLowerCase() ?? null;
  const actual = a.email?.toLowerCase() ?? null;
  const mismatch = !!expected && !!actual && expected !== actual;
  const fetched = a.usageFetchedAt ? new Date(a.usageFetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : null;
  return (
    <div
      className={cn(
        'mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg px-2.5 py-1.5 text-[11px] tabular-nums',
        mismatch || a.error || !a.loggedIn ? 'bg-danger/10 text-danger' : 'bg-hover text-muted',
      )}
      title="From `claude auth status`, run with a clean environment for this account's config dir"
    >
      <span className="font-medium">Auth check:</span>
      {a.error ? (
        <span>{a.error}</span>
      ) : !a.loggedIn ? (
        <span>not signed in</span>
      ) : (
        <span>
          signs in as <b className="font-semibold">{a.email}</b>
          {a.subscription ? ` · ${a.subscription}` : ''}
        </span>
      )}
      {mismatch && <span className="font-semibold">— expected {account.email}! Limits shown may belong to another account.</span>}
      <span className="ml-auto text-subtle">
        {a.usageAccountTail ? `account …${a.usageAccountTail}` : 'account ?'}
        {fetched ? ` · server fetched ${fetched}` : ''}
      </span>
    </div>
  );
}
