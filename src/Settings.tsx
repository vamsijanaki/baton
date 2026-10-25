import { useEffect, useState } from 'react';
import { Settings as Cog, Info, Download, Sparkles, ShieldCheck, Heart, RefreshCw, RotateCw } from 'lucide-react';

const SPONSOR_URL = 'https://github.com/sponsors/vamsijanaki';
import type { Settings, UpdateStatus } from './types';
import { Button, Card, Input, PageHeader, Toggle } from './ui';
import { tilde, timeAgo } from './lib';
import { useOps } from './ops';

export function SettingsView({ toast, dryRun, onOnboarding }: { toast: (t: string, tone?: 'ok' | 'warn') => void; dryRun: boolean; onOnboarding: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [about, setAbout] = useState<Awaited<ReturnType<typeof window.cs.about>> | null>(null);
  const [ret, setRet] = useState('');
  const runOp = useOps();
  useEffect(() => {
    window.cs.settingsGet().then((x) => (setS(x), setRet(String(x.retention))));
    window.cs.about().then(setAbout);
  }, []);
  const save = (p: Partial<Settings>) => window.cs.settingsSet(p).then((x) => (setS(x), setRet(String(x.retention)), toast('Saved', 'ok')));
  if (!s) return null;
  return (
    <div className="space-y-5">
      <PageHeader title="Settings" />
      <Card title="Safety" icon={<ShieldCheck size={15} />}>
        <div className="space-y-3 text-[12.5px]">
          <div className="flex items-center gap-3">
            <label htmlFor="ret" className="flex-1">
              Snapshots to keep (per kind)
              <span className="block text-[11.5px] text-muted">The newest 5 are always kept, and so are conflict snapshots and any holding quarantined items. Older ones are pruned after each change.</span>
            </label>
            <Input id="ret" type="number" min={5} max={500} value={ret} onChange={(e) => setRet(e.target.value)} onBlur={() => Number(ret) !== s.retention && save({ retention: Number(ret) || 20 })} className="w-20 text-right" />
          </div>
          <div className="flex items-center gap-3">
            <span className="flex-1">
              Same account, same chat list
              <span className="block text-[11.5px] text-muted">Every desktop app signed in as the same account shows the same Code sidebar. Turning it on is previewed first (it copies the missing sidebar entries).</span>
            </span>
            <Toggle
              checked={s.sameAccountSync}
              onChange={(v) =>
                v
                  ? runOp({ kind: 'same-account-sync', title: 'Same account, same chat list', confirmLabel: 'Turn on', onDone: () => window.cs.settingsGet().then(setS) })
                  : save({ sameAccountSync: false })
              }
              label={s.sameAccountSync ? 'On' : 'Off'}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="flex-1">
              Keep shared desktop chat lists in sync
              <span className="block text-[11.5px] text-muted">Watches the desktop apps' Code-tab index folders of shared projects (and of same-account apps) and mirrors changes; an open app is updated after it quits.</span>
            </span>
            <Toggle checked={s.syncEnabled} onChange={(v) => save({ syncEnabled: v })} label={s.syncEnabled ? 'On' : 'Off'} />
          </div>
          <div className="flex items-center gap-3">
            <span className="flex-1">
              Dry run for Terminal launches
              <span className="block text-[11.5px] text-muted">Write the command to the activity log instead of opening Terminal.</span>
            </span>
            <Toggle checked={dryRun} onChange={(v) => window.cs.setDryRun(v)} label={dryRun ? 'On' : 'Off'} />
          </div>
        </div>
      </Card>
      <UpdatesCard toast={toast} />
      <Card title="Help & diagnostics" icon={<Cog size={15} />}>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onOnboarding}>
            <Sparkles size={13} /> Show the introduction again
          </Button>
          <Button variant="secondary" onClick={() => window.cs.exportDiagnostics().then((f) => f && toast('Diagnostics saved', 'ok'))}>
            <Download size={13} /> Export diagnostics…
          </Button>
        </div>
        <p className="mt-2 text-[11.5px] text-muted">Diagnostics are redacted: no tokens, no chat content, emails masked, your home folder shown as ~.</p>
      </Card>
      {about && (
        <Card title="About Baton" icon={<Info size={15} />}>
          <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-[12.5px]">
            <dt className="text-muted">Version</dt>
            <dd>{about.version}</dd>
            <dt className="text-muted">Claude desktop</dt>
            <dd>{about.claude ?? 'not found'}</dd>
            <dt className="text-muted">Electron / Node</dt>
            <dd>
              {about.electron} / {about.node}
            </dd>
            <dt className="text-muted">macOS kernel</dt>
            <dd>{about.macos}</dd>
            <dt className="text-muted">Data</dt>
            <dd className="selectable font-mono text-[11px]">{tilde(about.appDir)} (settings, journal, snapshots)</dd>
          </dl>
          <p className="mt-3 text-[12.5px] text-fg">Baton — your Claude Code accounts, one history.</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
            An independent, open-source tool (MIT). Not affiliated with or endorsed by Anthropic; “Claude” and “Claude Code” are used only to say what it works with.
          </p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
            Uses your own Claude accounts on this Mac only; nothing is uploaded and no sign-in tokens are read or copied.
          </p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
            Baton is free. If it helps you,{' '}
            <a href={SPONSOR_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              <Heart size={11} /> Sponsor on GitHub
            </a>{' '}
            (opens in your browser).
          </p>
        </Card>
      )}
    </div>
  );
}

/**
 * Settings › Updates. The one place Baton talks to the network on its own: GitHub Releases, on launch + daily when
 * "Check for updates automatically" is on, otherwise only when you press Check now. No popups, no nagging.
 */
function UpdatesCard({ toast }: { toast: (t: string, tone?: 'ok' | 'warn') => void }) {
  const [u, setU] = useState<UpdateStatus | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    window.cs.updateStatus().then(setU);
    const off = window.cs.on('update', (s: UpdateStatus) => setU(s));
    const t = setInterval(() => tick((n) => n + 1), 30_000); // keeps "last checked" fresh
    return () => (off(), clearInterval(t));
  }, []);
  if (!u) return null;
  const busy = u.phase === 'checking' || u.phase === 'downloading' || u.phase === 'installing';
  const fail = (e: unknown) => toast(String((e as any)?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, ''), 'warn');
  return (
    <Card title="Updates" icon={<RefreshCw size={15} />}>
      <div className="space-y-3 text-[12.5px]">
        <div className="flex items-center gap-3">
          <span className="flex-1">
            Check for updates automatically
            <span className="block text-[11.5px] text-muted">
              When Baton starts and once a day, it asks GitHub Releases (github.com/vamsijanaki/baton) whether there is a newer version. Nothing else is sent. Off: Baton contacts nothing unless you press Check now.
            </span>
          </span>
          <Toggle checked={u.autoCheck} onChange={(v) => window.cs.updateSetAuto(v).then(setU, fail)} label={u.autoCheck ? 'On' : 'Off'} />
        </div>
        <dl className="grid grid-cols-[160px_1fr] gap-y-1">
          <dt className="text-muted">Current version</dt>
          <dd>{u.currentVersion}</dd>
          <dt className="text-muted">Last checked</dt>
          <dd>{u.lastCheckAt ? timeAgo(u.lastCheckAt) : 'never'}</dd>
        </dl>
        {!u.supported ? (
          <p className="text-[11.5px] text-muted">{u.reason ?? 'Updates are only available in signed releases.'}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {(u.phase === 'idle' || u.phase === 'up-to-date' || u.phase === 'error' || u.phase === 'checking') && (
                <Button variant="secondary" disabled={busy} onClick={() => window.cs.updateCheck().then(setU, fail)}>
                  <RefreshCw size={13} className={u.phase === 'checking' ? 'animate-spin' : undefined} /> {u.phase === 'checking' ? 'Checking…' : 'Check now'}
                </Button>
              )}
              {u.phase === 'available' && (
                <Button variant="primary" onClick={() => window.cs.updateDownload().then(setU, fail)}>
                  <Download size={13} /> Download and install {u.available?.version}
                </Button>
              )}
              {u.phase === 'downloading' && (
                <span className="flex items-center gap-2 text-muted" role="status">
                  <span className="h-1.5 w-40 overflow-hidden rounded-full bg-hover">
                    <span className="block h-full bg-accent transition-[width]" style={{ width: `${u.progress ?? 0}%` }} />
                  </span>
                  Downloading… {u.progress ?? 0}%
                </span>
              )}
              {(u.phase === 'downloaded' || u.phase === 'waiting' || u.phase === 'installing') && (
                <Button variant="primary" disabled={u.phase !== 'downloaded'} onClick={() => window.cs.updateRestart().then(setU, fail)}>
                  <RotateCw size={13} /> {u.phase === 'installing' ? 'Restarting…' : u.phase === 'waiting' ? 'Restart waits for an operation…' : `Restart to update to ${u.available?.version}`}
                </Button>
              )}
              {u.phase === 'up-to-date' && <span className="text-muted">Baton is up to date.</span>}
            </div>
            {u.waitingFor && <p className="text-[11.5px] text-muted">{u.waitingFor} Baton restarts by itself once it is done.</p>}
            {u.error && <p className="text-[11.5px] text-danger">Update problem: {u.error}</p>}
            {u.available && u.available.notes.length > 0 && u.phase !== 'up-to-date' && (
              <div className="rounded-lg border border-line bg-card p-3">
                <div className="mb-1 text-[11.5px] font-medium">What’s new in {u.available.version}</div>
                <div className="selectable max-h-56 space-y-2 overflow-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-muted">
                  {u.available.notes.map((n, i) => (
                    <div key={i}>
                      {u.available!.notes.length > 1 && n.version && <div className="font-medium text-fg">{n.version}</div>}
                      {n.text}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="text-[11.5px] text-muted">Updates are signed by the same developer as this copy and verified before they install. Baton never restarts while one of its operations is running.</p>
          </>
        )}
      </div>
    </Card>
  );
}
