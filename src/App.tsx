import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  GitBranch,
  HelpCircle,
  History,
  KeyRound,
  Link2,
  LogIn,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  TriangleAlert,
  Wrench,
  Eye,
  Power,
  Sparkles,
} from 'lucide-react';
import type { Account, AccountCard, LaunchResult, Proc, Session, Snapshot } from './types';
import { Badge, Button, Checkbox, cn, Dialog, Dot, Input, Kbd, Toggle, Tooltip } from './ui';
import { base, bytes, setHome, shareArgsFor, SHARED_STORE_LABEL, tilde, timeAgo, unlinkedNotice } from './lib';
import { UsageCard } from './UsageCard';
import { AccountsView } from './Accounts';
import { OpsProvider, useOps } from './ops';
import { SharingView } from './Sharing';
import { DoctorView } from './Doctor';
import { HistoryView } from './History';
import { SettingsView } from './Settings';
import { OnboardingWizard } from './Onboarding';
import { FairUseDialog, FairUseView, KindBadge, SecondPlanWarning, SuspendedDialog, KindPicker, OWN_TEXT } from './FairUse';
import type { AccountKind, FairUseInfo, LaunchBlocked } from './types';
import { Share2, Stethoscope, Settings as Cog, AppWindow, Home, Users, ExternalLink, ShieldCheck, Ban } from 'lucide-react';

type View = 'home' | 'accounts' | 'sharing' | 'doctor' | 'history' | 'settings' | 'fairuse';
/** Meter colour only — Baton never warns or suggests another account at any level. */
const METER_HIGH = 90;

const COLORS = ['#0d7f72', '#6a9bcc', '#788c5d', '#b48ead', '#e0b252', '#5fb3b3', '#c96f8f'];

type Toast = { id: number; text: string; tone?: 'ok' | 'warn' };
type Conflict = { accountId: string; conflicts: Proc[]; resume?: string | null; continueLast?: boolean };

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [view, setView] = useState<View>('home');
  const [historyTab, setHistoryTab] = useState<'ops' | 'restore' | 'activity'>('ops');
  const [wizard, setWizard] = useState(false);
  const [wizardSeen, setWizardSeen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [fairUseFor, setFairUseFor] = useState<string | null>(null);
  const [suspendedBlock, setSuspendedBlock] = useState<Extract<LaunchBlocked, { status: 'suspended' }> | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [preview, setPreview] = useState('');
  const [now, setNow] = useState(Date.now());
  const searchRef = useRef<HTMLInputElement>(null);

  const toast = useCallback((text: string, tone?: Toast['tone']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);

  const refresh = useCallback(async () => setSnap(await window.cs.snapshot()), []);
  if (snap?.home) setHome(snap.home);

  useEffect(() => {
    refresh();
    const offs = [
      window.cs.on('changed', (s: Snapshot) => setSnap(s)),
      window.cs.on('route', (r: string) => {
        if (r === 'add') setAddOpen(true);
        if (r === 'help') setHelpOpen(true);
        if (r === 'refresh') refresh();
        if (r === 'sharing' || r === 'doctor' || r === 'settings' || r === 'accounts' || r === 'fairuse') setView(r);
        if (r === 'desktop') setView('accounts');
        if (r === 'history' || r === 'restore') (setView('history'), setHistoryTab(r === 'restore' ? 'restore' : 'ops'));
        if (r === 'about') setView('settings');
        if (r === 'onboarding') setWizard(true);
      }),
      window.cs.on('conflict', (c: Conflict) => setConflict(c)),
      window.cs.on('launchBlocked', (b: LaunchBlocked) => (b.status === 'fairuse' ? setFairUseFor(b.accountId) : setSuspendedBlock(b))),
    ];
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      offs.forEach((o) => o());
      clearInterval(t);
    };
  }, [refresh]);

  const project = snap?.state.project ?? '';
  const accounts = snap?.accounts ?? [];
  const account = accounts.find((a) => a.id === snap?.state.selectedAccount) ?? accounts[0];

  const loadSessions = useCallback(async () => {
    if (!project) return;
    setLoadingSessions(true);
    const r = await window.cs.sessions(project);
    setSessions(r.sessions);
    setLoadingSessions(false);
  }, [project]);

  useEffect(() => {
    setSelectedSession(null);
    loadSessions();
  }, [loadSessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q) || s.id.startsWith(q) || (s.gitBranch ?? '').toLowerCase().includes(q));
  }, [sessions, query]);

  useEffect(() => {
    if (!account || !project) return;
    window.cs
      .preview({ accountId: account.id, project, resume: selectedSession, continueLast: !selectedSession && sessions.length > 0 })
      .then(setPreview);
  }, [account, project, selectedSession, sessions.length]);

  const onProject = (p: Proc) => p.cwd && (p.cwd === project || p.cwd.startsWith(project + '/'));
  const projectProcs = (snap?.running ?? []).filter(onProject);
  const accName = (id: string | null, p?: Proc) => {
    const who =
      p?.source === 'desktop' && id && id === account?.id
        ? 'This account'
        : accounts.find((a) => a.id === id)?.name ?? (p?.email ? p.email : p?.configDir ? tilde(p.configDir) : 'Another account');
    return p?.source === 'desktop' ? `${who} — Claude desktop app «${p.profile ?? 'Claude (default)'}» · pid ${p.pid}` : who;
  };

  const doLaunch = useCallback(
    async (o: { resume?: string | null; continueLast?: boolean; force?: boolean; accountId?: string }) => {
      if (!account) return;
      const accountId = o.accountId ?? account.id;
      try {
        const r: LaunchResult = await window.cs.launch({ accountId, project, resume: o.resume, continueLast: o.continueLast, force: o.force });
        if (r.status === 'conflict') {
          setConflict({ accountId, conflicts: r.conflicts, resume: o.resume, continueLast: o.continueLast });
          return;
        }
        if (r.status === 'fairuse') return setFairUseFor(r.accountId);
        if (r.status === 'suspended') return setSuspendedBlock(r);
        setConflict(null);
        toast(r.dryRun ? 'Dry run — command written to the launch log' : `Opened Terminal as ${accounts.find((a) => a.id === accountId)?.name}`, 'ok');
      } catch (e: any) {
        toast(String(e?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, ''), 'warn');
      }
    },
    [account, project, accounts, toast],
  );

  // this account's Terminal can't see the project's history (not linked): Continue starts fresh there
  const pst = account && !account.isDefault ? snap?.projectSharing[account.id] : undefined;
  const unlinked = !!pst && pst !== 'shared' && pst !== 'legacy-all';
  const continueNow = () => doLaunch(selectedSession ? { resume: selectedSession } : { continueLast: sessions.length > 0 && !unlinked });

  // keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA';
      if (meta && e.key === 'Enter') return e.preventDefault(), continueNow();
      if (meta && e.key.toLowerCase() === 'f') return e.preventDefault(), searchRef.current?.focus();
      if (meta && e.key.toLowerCase() === 'o') return e.preventDefault(), window.cs.chooseProject();
      if (meta && e.key.toLowerCase() === 'n') return e.preventDefault(), setAddOpen(true);
      if (meta && e.key.toLowerCase() === 'p') return e.preventDefault(), setProjectOpen((v) => !v);
      if (meta && e.key === '/') return e.preventDefault(), setHelpOpen(true);
      if (meta && /^[1-9]$/.test(e.key) && !e.altKey) {
        const a = accounts[Number(e.key) - 1];
        if (a) window.cs.select({ account: a.id });
        return e.preventDefault();
      }
      if (addOpen || helpOpen || conflict) return;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (!typing || e.target === searchRef.current)) {
        e.preventDefault();
        const i = filtered.findIndex((s) => s.id === selectedSession);
        const n = e.key === 'ArrowDown' ? Math.min(filtered.length - 1, i + 1) : Math.max(-1, i - 1);
        setSelectedSession(n >= 0 ? filtered[n].id : null);
        document.getElementById(`s-${filtered[n]?.id}`)?.scrollIntoView({ block: 'nearest' });
      }
      if (e.key === 'Enter' && selectedSession && (!typing || e.target === searchRef.current)) doLaunch({ resume: selectedSession });
      if (e.key === 'Escape' && !typing) setSelectedSession(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  useEffect(() => {
    if (snap && !snap.onboarded && !wizardSeen) (setWizard(true), setWizardSeen(true));
  }, [snap, wizardSeen]);

  if (!snap || !account) return <div className="h-full bg-panel" />;

  const lockAcc = snap.lock ? accounts.find((a) => a.id === snap.lock!.account) : null;
  const otherRunning = projectProcs.filter((p) => p.accountId !== account.id);
  const onboarding = accounts.length < 2;

  return (
    <OpsProvider toast={toast}>
    <div className="flex h-full">
      {/* ---------------- sidebar (vibrancy shows through) ---------------- */}
      <aside className="drag flex w-[256px] shrink-0 flex-col border-r border-line">
        <div className="h-[52px] shrink-0" />
        <div className="flex items-center justify-between px-4 pb-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">Accounts</span>
          <Tooltip text="Add account  ⌘N">
            <Button variant="ghost" size="icon" onClick={() => setAddOpen(true)} aria-label="Add account">
              <Plus size={15} />
            </Button>
          </Tooltip>
        </div>
        <nav className="no-drag flex-1 space-y-0.5 overflow-y-auto px-2">
          {accounts.map((a, i) => {
            const selected = a.id === account.id;
            const active = snap.lock?.account === a.id;
            const busy = projectProcs.some((p) => p.accountId === a.id);
            const u = snap.usage?.[a.id];
            const wk = u?.sevenDay ? Math.round(u.sevenDay.pct) : null;
            const h5 = u?.fiveHour ? Math.round(u.fiveHour.pct) : null;
            const hot = false; // informational only: never a red signal that nudges toward another account
            return (
              <button
                key={a.id}
                onClick={() => (window.cs.select({ account: a.id }), setView('home'))}
                aria-current={selected && view === 'home' ? 'page' : undefined}
                className={cn(
                  'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                  selected && view === 'home' ? 'bg-fg/[0.08] dark:bg-white/[0.09]' : 'hover:bg-hover',
                )}
              >
                <Dot color={a.color} size={10} pulse={busy} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">{a.name}</span>
                    {active && <Badge tone="ok">Active</Badge>}
                    {snap.fairUse?.[a.id]?.suspended && <Ban size={11} className="text-danger" aria-label="Suspended" />}
                    {(wk != null || h5 != null) && (
                      <span
                        title={`5-hour ${h5 ?? '–'}% · weekly ${wk ?? '–'}%`}
                        className={cn(
                          'ml-auto shrink-0 rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums leading-[16px]',
                          hot ? 'bg-danger text-white' : 'bg-hover text-muted',
                        )}
                      >
                        {wk ?? '–'}%
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[11.5px] text-muted">
                    {a.email ?? (a.isDefault ? '~/.claude' : 'Not signed in yet')}
                  </span>
                </span>
                {i < 9 && <span className="text-[10.5px] text-subtle opacity-0 transition-opacity group-hover:opacity-100">⌘{i + 1}</span>}
              </button>
            );
          })}
          <button
            onClick={() => setAddOpen(true)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <span className="flex h-[10px] w-[10px] items-center justify-center rounded-full border border-dashed border-subtle" />
            Add account…
          </button>
        </nav>

        <nav aria-label="Workspace" className="no-drag space-y-0.5 border-t border-line px-2 py-2">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">Workspace</div>
          {(
            [
              ['home', 'Sessions', Home],
              ['accounts', 'Accounts', Users],
              ['sharing', 'Shared projects', Share2],
              ['doctor', 'Doctor', Stethoscope],
              ['history', 'History & restore', History],
              ['settings', 'Settings', Cog],
              ['fairuse', 'Fair use', ShieldCheck],
            ] as [View, string, typeof Home][]
          ).map(([k, label, I]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              aria-current={view === k ? 'page' : undefined}
              className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors', view === k ? 'bg-fg/[0.08] font-medium dark:bg-white/[0.09]' : 'text-muted hover:bg-hover hover:text-fg')}
            >
              <I size={14} aria-hidden /> {label}
            </button>
          ))}
        </nav>

        <div className="no-drag space-y-2.5 border-t border-line p-3">
          <RunningSummary procs={snap.running} accName={accName} project={project} />
          <div className="flex items-center justify-between">
            <Toggle
              checked={snap.dryRun}
              onChange={(v) => window.cs.setDryRun(v)}
              label={<span title="Write the Terminal command to the launch log instead of running it">Dry run</span>}
            />
            <div className="flex">
              <Tooltip text="Launch log">
                <Button variant="ghost" size="icon" onClick={() => window.cs.openLog()} aria-label="Launch log">
                  <History size={14} />
                </Button>
              </Tooltip>
              <Tooltip text="Help  ⌘/">
                <Button variant="ghost" size="icon" onClick={() => setHelpOpen(true)} aria-label="Help">
                  <HelpCircle size={14} />
                </Button>
              </Tooltip>
            </div>
          </div>
        </div>
      </aside>

      {/* ---------------- main ---------------- */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-panel">
        <header className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-5">
          {view === 'home' && <ProjectPicker
            open={projectOpen}
            setOpen={setProjectOpen}
            project={project}
            recents={snap.state.recentProjects}
            onPick={(p) => window.cs.select({ project: p })}
          />}
          <div className="flex-1" />
          {snap.lock && lockAcc && (
            <Badge tone="ok" className="no-drag">
              <Dot color={lockAcc.color} size={7} /> {lockAcc.name} active on {base(snap.lock.project)}
              {!snap.lock.pid && ' · starting'}
            </Badge>
          )}
          <Tooltip text="Refresh  ⌘R">
            <Button variant="ghost" size="icon" onClick={() => (refresh(), loadSessions())} aria-label="Refresh">
              <RefreshCw size={14} />
            </Button>
          </Tooltip>
        </header>

        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-[900px] space-y-5 px-7 py-6">
            {view === 'sharing' && <SharingView />}
            {view === 'accounts' && (
              <AccountsView
                toast={toast}
                usage={snap.usage}
                warnPct={METER_HIGH}
                onContinue={(id) => (window.cs.select({ account: id }), setView('home'))}
                onAdd={() => setAddOpen(true)}
              />
            )}
            {view === 'doctor' && <DoctorView toast={toast} />}
            {view === 'history' && <HistoryView initialTab={historyTab} />}
            {view === 'fairuse' && <FairUseView snap={snap} onConfirm={setFairUseFor} />}
            {view === 'settings' && <SettingsView toast={toast} dryRun={snap.dryRun} onOnboarding={() => setWizard(true)} />}
            {view === 'home' && (<>
            {otherRunning.length > 0 && (
              <RunningWarning procs={otherRunning} accName={accName} onShow={(pid) => window.cs.showProcess(pid)} onQuit={(pid) => window.cs.terminateProcess(pid)} />
            )}

            <AccountHero key={account.id} account={account} active={snap.lock?.account === account.id} now={now} toast={toast} onAccounts={() => setView('accounts')} fairUse={snap.fairUse?.[account.id]} onFairUse={() => setFairUseFor(account.id)} links={snap.links} />

            <UsageCard
              key={`u-${account.id}`}
              account={account}
              usage={snap.usage?.[account.id]}
              warnPct={METER_HIGH}
              isActive={snap.activeAccountId === account.id}
              now={now}
              toast={toast}
            />

            {/* Continue */}
            <section className="animate-up rounded-2xl border border-line bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
              <div className="flex items-center gap-3">
                <Button variant="primary" size="lg" className="min-w-[230px]" onClick={continueNow}>
                  <Terminal size={17} />
                  {selectedSession ? 'Resume in Terminal' : 'Continue in Terminal'}
                  <span className="ml-1 rounded bg-black/12 px-1.5 text-[11px] font-normal">⌘↩</span>
                </Button>
                <Button variant="secondary" onClick={() => doLaunch({})}>
                  <Plus size={14} /> New session
                </Button>
                <div className="min-w-0 flex-1 text-right text-[12px] leading-snug text-muted">
                  as <b className="font-semibold text-fg">{account.name}</b>
                  <br />
                  {unlinked ? (
                    <>starts fresh — {base(project)} isn't linked for {account.name}'s Terminal yet</>
                  ) : selectedSession ? (
                    <>resumes the selected session</>
                  ) : sessions.length ? (
                    <>picks up the latest session</>
                  ) : (
                    <>starts fresh in {base(project)}</>
                  )}
                </div>
              </div>
              {preview && (
                <div className="group mt-3 flex items-center gap-2 rounded-lg bg-hover px-3 py-2">
                  <code className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{preview.replace(/printf '[^']*' && /, '')}</code>
                  <button
                    className="text-subtle opacity-0 transition group-hover:opacity-100 hover:text-fg"
                    onClick={() => (navigator.clipboard.writeText(preview), toast('Command copied'))}
                    aria-label="Copy command"
                  >
                    <Copy size={13} />
                  </button>
                </div>
              )}
            </section>

            {onboarding && <Onboarding onAdd={() => setAddOpen(true)} />}

            <ShareBanner account={account} project={project} state={snap.projectSharing[account.id]} desktop={snap.projectDesktop?.[account.id]} onOpen={() => setView('sharing')} />

            {/* Sessions */}
            <section className="animate-up">
              <div className="mb-2.5 flex items-center gap-3">
                <h3 className="text-[13px] font-semibold">Sessions in {base(project)}</h3>
                <span className="text-[12px] text-subtle">{sessions.length} · in the {SHARED_STORE_LABEL}{snap.sharedProjects.includes(project) ? ' · shared project' : ''}</span>
                <div className="relative ml-auto w-[260px]">
                  <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
                  <Input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sessions" className="pl-7 pr-10" />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                    <Kbd>⌘F</Kbd>
                  </span>
                </div>
              </div>
              <div className="overflow-hidden rounded-2xl border border-line bg-card">
                {loadingSessions && sessions.length === 0 && <div className="p-6 text-center text-muted">Reading transcripts…</div>}
                {!loadingSessions && filtered.length === 0 && (
                  <div className="p-8 text-center">
                    <p className="font-medium">{query ? 'No session matches.' : 'No sessions for this folder yet.'}</p>
                    <p className="mt-1 text-[12px] text-muted">{query ? 'Try other words or a session id.' : 'Continue in Terminal to start the first one.'}</p>
                  </div>
                )}
                {filtered.map((s, i) => {
                  const sel = s.id === selectedSession;
                  const live = projectProcs.length > 0 && i === 0 && !query;
                  const child = !!s.parentId && sessions.some((x) => x.id === s.parentId);
                  return (
                    <div
                      id={`s-${s.id}`}
                      key={s.id}
                      onClick={() => setSelectedSession(sel ? null : s.id)}
                      onDoubleClick={() => doLaunch({ resume: s.id })}
                      className={cn(
                        'group flex items-center gap-3 border-b border-line px-4 py-2.5 transition-colors last:border-0',
                        child && 'pl-10',
                        sel ? 'bg-accent/[0.09]' : 'hover:bg-hover',
                      )}
                    >
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', sel ? 'bg-accent' : 'bg-transparent')} />
                      <div className="min-w-0 flex-1">
                        <div className={cn('truncate font-medium', child ? 'text-[12.5px] text-muted' : 'text-[13px]')}>
                          {child && <span className="mr-1.5 text-subtle">↳</span>}
                          {s.title}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2.5 text-[11.5px] text-muted">
                          <span>{timeAgo(s.mtime)}</span>
                          <span className="text-subtle">·</span>
                          <span>{bytes(s.size)}</span>
                          {s.gitBranch && (
                            <>
                              <span className="text-subtle">·</span>
                              <span className="flex items-center gap-1">
                                <GitBranch size={11} /> {s.gitBranch}
                              </span>
                            </>
                          )}
                          <span className="text-subtle">·</span>
                          <span className="selectable font-mono text-[10.5px] text-subtle">{s.id.slice(0, 8)}</span>
                          {s.desktopFrom?.length ? (
                            <>
                              <span className="text-subtle">·</span>
                              <span title={s.desktopFrom.map((o) => `${accounts.find((a) => a.id === o.account)?.name ?? o.account} · ${o.app}`).join('\n')}>
                                {[...new Set(s.desktopFrom.map((o) => accounts.find((a) => a.id === o.account)?.name ?? o.account))].join(', ')} · desktop
                              </span>
                            </>
                          ) : null}
                          {live && <Badge tone="ok">recently active</Badge>}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={sel ? 'primary' : 'outline'}
                        className={cn('transition-opacity', sel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
                        onClick={(e) => (e.stopPropagation(), doLaunch({ resume: s.id }))}
                      >
                        Resume <ArrowRight size={12} />
                      </Button>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-[11.5px] text-subtle">
                ↑↓ to select · ↩ or double-click to resume · transcripts in <span className="selectable">{tilde(snap.paths.shared)}</span>
              </p>
            </section>
            </>)}
          </div>
        </div>

        {/* toasts */}
        <div className="pointer-events-none absolute bottom-4 right-4 z-50 flex flex-col items-end gap-2" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cn(
                'flex items-center gap-2 rounded-xl border border-line bg-card px-3.5 py-2.5 text-[12.5px] shadow-lg animate-pop',
                t.tone === 'warn' && 'text-warn',
              )}
            >
              {t.tone === 'warn' ? <TriangleAlert size={14} /> : <Check size={14} className="text-ok" />} {t.text}
            </div>
          ))}
        </div>
      </main>

      <AddAccountDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        toast={toast}
        dryRun={snap.dryRun}
        used={accounts.map((a) => a.color)}
        hasPersonal={accounts.some((a) => snap.fairUse?.[a.id]?.kind === 'personal')}
      />
      <FairUseDialog account={accounts.find((a) => a.id === fairUseFor) ?? null} info={fairUseFor ? snap.fairUse?.[fairUseFor] : undefined} onClose={() => setFairUseFor(null)} onDone={() => toast('Confirmed — thanks for using Baton fairly', 'ok')} />
      <SuspendedDialog blocked={suspendedBlock} links={snap.links} onClose={() => setSuspendedBlock(null)} />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ConflictDialog
        conflict={conflict}
        accounts={accounts}
        accName={accName}
        project={project}
        onClose={() => setConflict(null)}
        onForce={() => conflict && doLaunch({ accountId: conflict.accountId, resume: conflict.resume, continueLast: conflict.continueLast, force: true })}
        onRecheck={() => conflict && doLaunch({ accountId: conflict.accountId, resume: conflict.resume, continueLast: conflict.continueLast })}
      />
      <OnboardingWizard open={wizard} onClose={() => (setWizard(false), refresh())} onGo={(v) => setView(v)} />
    </div>
    </OpsProvider>
  );
}

/** Home: tells the user when the selected account cannot see this project's history, with a one-click (previewed) share. */
function ShareBanner({ account, project, state, desktop, onOpen }: { account: Account; project: string; state?: string; desktop?: { chats: number; apps: string[] }; onOpen: () => void }) {
  const runOp = useOps();
  if (account.isDefault || !state || state === 'shared') return null;
  const legacy = state === 'legacy-all';
  const n = unlinkedNotice(account.name, base(project), desktop);
  return (
    <section role="note" className={cn('animate-up flex items-center gap-3 rounded-2xl border px-4 py-3 text-[12.5px]', legacy ? 'border-warn/40 bg-warn/[0.06]' : 'border-line bg-card')}>
      <Share2 size={15} className={legacy ? 'text-warn' : 'text-muted'} aria-hidden />
      <span className="flex-1 leading-relaxed">
        {legacy ? (
          <>
            <b>{account.name}</b> still sees <b>every</b> project's history (old all-or-nothing sharing). Review the migration to share only what you choose.
          </>
        ) : (
          <>
            {n.lead && <b className="block">{n.lead}</b>}
            {n.body}
          </>
        )}
      </span>
      {legacy ? (
        <Button size="sm" variant="primary" onClick={onOpen}>
          Review migration…
        </Button>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            const info = await window.cs.sharingInfo();
            const cur = info.config.projects.find((p) => p.path === project);
            runOp({
              kind: 'share',
              // always the normal previewed share; desktop lists follow the accounts unless a hand-picked list exists
              args: shareArgsFor(project, account.id, cur),
              title: desktop?.chats ? `Link ${base(project)} for ${account.name}'s Terminal` : `Share ${base(project)} with ${account.name}`,
              confirmLabel: desktop?.chats ? 'Link' : 'Share',
            });
          }}
        >
          {n.cta}
        </Button>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------

function RunningSummary({ procs, accName, project }: { procs: Proc[]; accName: (id: string | null, p?: Proc) => string; project: string }) {
  const here = procs.filter((p) => p.cwd && (p.cwd === project || p.cwd.startsWith(project + '/')));
  return (
    <div className="rounded-lg bg-hover px-2.5 py-2 text-[11.5px] text-muted">
      <div className="flex items-center gap-1.5 font-medium text-fg">
        <span className={cn('h-1.5 w-1.5 rounded-full', here.length ? 'bg-ok pulse' : 'bg-subtle')} />
        {here.length ? `${here.length} claude running here` : 'Nothing running here'}
      </div>
      <div className="mt-0.5">
        {procs.length} claude process{procs.length === 1 ? '' : 'es'} on this Mac
        {here.length > 0 &&
          ` · ${[...new Set(here.map((p) => accName(p.accountId, p).replace(/ · pid \d+$/, '')))].join(', ')}`}
      </div>
    </div>
  );
}

function RunningWarning({ procs, accName, onShow, onQuit }: { procs: Proc[]; accName: (id: string | null, p?: Proc) => string; onShow: (pid: number) => void; onQuit: (pid: number) => void }) {
  const first = procs[0];
  return (
    <div className="animate-up flex items-start gap-3 rounded-2xl border border-warn/30 bg-warn/[0.08] px-4 py-3">
      <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {accName(first.accountId, first)} is still running on this project{procs.length > 1 ? ` (+${procs.length - 1} more)` : ''} — quit it first.
        </p>
        <p className="mt-0.5 text-[12px] text-muted">One account at a time keeps the shared history clean. Switching never stops anything for you.</p>
      </div>
      <Button size="sm" onClick={() => onShow(first.pid)}>
        <Eye size={13} /> Show it
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onQuit(first.pid)}>
        <Power size={13} /> Quit…
      </Button>
    </div>
  );
}

function ProjectPicker({ open, setOpen, project, recents, onPick }: { open: boolean; setOpen: (v: boolean) => void; project: string; recents: string[]; onPick: (p: string) => void }) {
  const [known, setKnown] = useState<{ path: string; count: number; mtime: number }[]>([]);
  useEffect(() => {
    if (open) window.cs.knownProjects().then(setKnown);
  }, [open]);
  const others = known.filter((k) => !recents.includes(k.path)).slice(0, 10);
  return (
    <div className="no-drag relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-hover">
        <FolderOpen size={15} className="text-accent" />
        <span className="text-[14px] font-semibold tracking-[-0.01em]">{base(project)}</span>
        <span className="max-w-[340px] truncate text-[12px] text-subtle">{tilde(project)}</span>
        <ChevronDown size={13} className="text-subtle" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1.5 w-[440px] overflow-hidden rounded-xl border border-line bg-panel p-1.5 shadow-[0_18px_40px_-10px_rgba(0,0,0,0.3)] animate-pop">
            <Label>Recent</Label>
            {recents.map((p) => (
              <ProjectRow key={p} p={p} current={p === project} onClick={() => (onPick(p), setOpen(false))} />
            ))}
            {others.length > 0 && <Label>Folders with Claude history</Label>}
            {others.map((k) => (
              <ProjectRow key={k.path} p={k.path} meta={`${k.count} session${k.count === 1 ? '' : 's'}`} onClick={() => (onPick(k.path), setOpen(false))} />
            ))}
            <div className="mt-1 border-t border-line pt-1">
              <button
                onClick={async () => (setOpen(false), await window.cs.chooseProject())}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-hover"
              >
                <Plus size={14} className="text-muted" /> Choose folder… <span className="ml-auto"><Kbd>⌘O</Kbd></span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-subtle">{children}</div>
);

function ProjectRow({ p, current, meta, onClick }: { p: string; current?: boolean; meta?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover">
      <span className="w-3.5">{current && <Check size={13} className="text-accent" />}</span>
      <span className="font-medium">{base(p)}</span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-subtle">{tilde(p)}</span>
      {meta && <span className="text-[11px] text-subtle">{meta}</span>}
    </button>
  );
}

/** The selected account's desktop app (same email), with one button to open it — or a pointer to create one. */
function DesktopLine({ account, toast, onAccounts }: { account: Account; toast: (t: string, tone?: 'ok' | 'warn') => void; onAccounts: () => void }) {
  const [card, setCard] = useState<AccountCard | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const load = () => window.cs.accountsOverview().then((o) => live && setCard(o.accounts.find((c) => c.key === account.id) ?? null)).catch(() => undefined);
    load();
    const t = setInterval(load, 8000);
    return () => ((live = false), clearInterval(t));
  }, [account.id]);
  if (card === undefined) return null;
  const app = card?.apps[0];
  return (
    <div className="mt-3 flex items-center gap-2 text-[12px] text-muted">
      <AppWindow size={13} className="shrink-0" aria-hidden />
      {app ? (
        <>
          <span className="min-w-0 flex-1 truncate">
            Desktop app: <b className="font-medium text-fg">{app.name}</b>
            {app.running ? ' · open' : ''}
            {card!.extras.length ? ` · +${card!.extras.length} extra (see Accounts)` : ''}
          </span>
          <Button size="sm" variant="ghost" onClick={() => window.cs.desktopOpen(app.id).then((r) => r.opened && toast(`Opening ${account.name} in the desktop app…`, 'ok')).catch((e) => toast(String(e?.message ?? e), 'warn'))}>
            <ExternalLink size={12} /> Open {account.name} in desktop app
          </Button>
        </>
      ) : (
        <>
          <span className="flex-1">No desktop app for {account.name} yet.</span>
          <Button size="sm" variant="ghost" onClick={onAccounts}>
            Create desktop app for {account.name}…
          </Button>
        </>
      )}
    </div>
  );
}

function AccountHero({
  account,
  active,
  now,
  toast,
  onAccounts,
  fairUse,
  onFairUse,
  links,
}: {
  account: Account;
  active: boolean;
  now: number;
  toast: (t: string, tone?: 'ok' | 'warn') => void;
  onAccounts: () => void;
  fairUse?: FairUseInfo;
  onFairUse: () => void;
  links: Snapshot['links'];
}) {
  const [name, setName] = useState(account.name);
  const save = (patch: Partial<Account>) => window.cs.updateAccount(account.id, patch);
  const runOp = useOps();

  return (
    <section className="animate-up rounded-2xl border border-line bg-card p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-start gap-4">
        <div className="relative">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-2xl text-[19px] font-semibold text-white shadow-inner"
            style={{ background: `linear-gradient(140deg, ${account.color}, color-mix(in srgb, ${account.color} 70%, black))` }}
          >
            {account.name.trim().charAt(0).toUpperCase() || '?'}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name !== account.name && save({ name: name.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              style={{ fieldSizing: 'content' } as React.CSSProperties}
              className="min-w-[40px] max-w-[320px] rounded-md bg-transparent px-1 -mx-1 text-[18px] font-semibold tracking-[-0.015em] outline-none hover:bg-hover focus:bg-hover"
              aria-label="Account name"
            />
            {active && <Badge tone="ok">Active</Badge>}
            <KindBadge f={fairUse} />
            {account.signedIn ? (
              <Badge tone="neutral">
                <KeyRound size={10} /> Signed in
              </Badge>
            ) : (
              <Badge tone="warn">Not signed in</Badge>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
            <span>{account.email ?? 'Email appears after the first sign-in'}</span>
            <button className="selectable font-mono text-[11px] text-subtle hover:text-fg" onClick={() => window.cs.reveal(account.configDir)}>
              {tilde(account.configDir)}
            </button>
          </div>
          <DesktopLine account={account} toast={toast} onAccounts={onAccounts} />
          <div className="mt-2 flex items-center gap-1.5">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => save({ color: c })}
                className={cn('h-3.5 w-3.5 rounded-full transition-transform hover:scale-125', c === account.color && 'ring-2 ring-fg/40 ring-offset-1 ring-offset-card')}
                style={{ background: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {(!account.isDefault || !account.signedIn) && (
            <Button size="sm" variant={account.signedIn ? 'ghost' : 'primary'} onClick={() => window.cs.signIn(account.id).then(() => toast('Terminal opened for sign-in', 'ok'))}>
              <LogIn size={13} /> {account.signedIn ? 'Sign in again' : 'Sign in'}
            </Button>
          )}
          {!account.isDefault && (
            <Tooltip text="Remove account">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Remove account"
                onClick={() =>
                  runOp({
                    kind: 'account-remove',
                    args: { id: account.id },
                    title: `Remove ${account.name}?`,
                    confirmLabel: 'Move to Trash',
                    danger: true,
                    intro: `Moves ${tilde(account.configDir)} (its sign-in and settings) to the Trash. Links are removed first, so the history they point at is never touched.`,
                    onDone: () => toast(`${account.name} removed — ~/.claude untouched`, 'ok'),
                  })
                }
              >
                <Trash2 size={14} />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      {fairUse?.suspended ? (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/[0.06] px-3 py-2 text-[12px] leading-relaxed">
          <Ban size={14} className="mt-0.5 shrink-0 text-danger" />
          <span className="text-muted">
            <b className="text-fg">Suspended</b> — Claude Code reported: “{fairUse.suspended.reason}”. Baton won't continue this account's projects in another account; that
            would violate Anthropic's Usage Policy.{' '}
            <a href={links.support} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Contact Anthropic support to appeal
            </a>
            .
          </span>
        </div>
      ) : (
        fairUse?.problem && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px]">
            <ShieldCheck size={14} className="shrink-0 text-warn" />
            <span className="flex-1 text-muted">{fairUse.problem.message}</span>
            <Button size="sm" variant="primary" onClick={onFairUse}>
              Confirm…
            </Button>
          </div>
        )
      )}

      {!account.isDefault && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[11.5px]">
          {account.links.find((l) => l.name === 'projects')?.ok ? (
            <Badge tone="warn">
              <Link2 size={10} /> sees every project (old style)
            </Badge>
          ) : (
            <Badge tone="neutral">
              <Share2 size={10} /> history: only shared projects
            </Badge>
          )}
          <Badge tone="neutral">credentials · settings · own</Badge>
        </div>
      )}

    </section>
  );
}

function Onboarding({ onAdd }: { onAdd: () => void }) {
  const steps = [
    { t: 'Add your second account', d: 'Creates its own ~/.claude-<name> folder. It shares nothing until you pick projects in Shared projects.', icon: Plus },
    { t: 'Sign in once', d: 'A Terminal opens running claude /login for that account. Credentials stay in that account only.', icon: LogIn },
    { t: 'Pick a project and continue', d: 'Choose the account, select a session, press Continue. Same history, different account.', icon: Terminal },
  ];
  return (
    <section className="animate-up rounded-2xl border border-dashed border-accent/40 bg-accent/[0.05] p-5">
      <div className="flex items-center gap-2">
        <Sparkles size={15} className="text-accent" />
        <h3 className="text-[14px] font-semibold">Set up a second account in three steps</h3>
      </div>
      <ol className="mt-4 grid grid-cols-3 gap-3">
        {steps.map((s, i) => (
          <li key={i} className="rounded-xl border border-line bg-card p-3.5">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[12px] font-semibold text-accent-fg">{i + 1}</span>
              <s.icon size={14} className="text-muted" />
            </div>
            <p className="mt-2.5 text-[13px] font-semibold">{s.t}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">{s.d}</p>
          </li>
        ))}
      </ol>
      <Button variant="primary" className="mt-4" onClick={onAdd}>
        <Plus size={14} /> Add second account
      </Button>
    </section>
  );
}

function AddAccountDialog({ open, onClose, toast, dryRun, used, hasPersonal }: { open: boolean; onClose: () => void; toast: (t: string, tone?: 'ok' | 'warn') => void; dryRun: boolean; used: string[]; hasPersonal: boolean }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AccountKind | null>(null);
  const [own, setOwn] = useState(false);
  const [limits, setLimits] = useState(false);
  const [color, setColor] = useState(COLORS[1]);
  const [signIn, setSignIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) {
      setName('');
      setErr('');
      setKind(null);
      setOwn(false);
      setLimits(false);
      setColor(COLORS.find((c) => !used.includes(c)) ?? COLORS[1]);
    }
  }, [open]);
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const runOp = useOps();
  const secondPersonal = kind === 'personal' && hasPersonal;
  const ready = !!slug && !!kind && own && (!secondPersonal || limits);
  const submit = () => {
    if (!slug) return setErr('Give it a name with letters or numbers.');
    if (!kind) return setErr('Choose Personal or Work/Team/Enterprise.');
    if (!own) return setErr(`Tick “${OWN_TEXT}”`);
    if (secondPersonal && !limits) return setErr('Tick the usage-limits confirmation for a second Personal plan.');
    onClose();
    runOp({
      kind: 'account-add',
      args: { name: name.trim(), color, signIn, kind, attested: own, notLimitDodging: secondPersonal ? limits : false },
      title: `Add account ${name.trim()}`,
      confirmLabel: 'Add account',
      onDone: () => toast(signIn ? (dryRun ? `Created ~/.claude-${slug} · sign-in logged (dry run)` : `Created ~/.claude-${slug} — finish sign-in in Terminal`) : `Created ~/.claude-${slug}`, 'ok'),
    });
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add an account" description="Another Claude account that is yours. It gets its own sign-in and starts with no shared history — you choose which projects it sees.">
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-muted">Name</label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="e.g. Work 2, Team, Personal" />
          <p className="mt-1.5 font-mono text-[11px] text-subtle">{slug ? `~/.claude-${slug}` : '~/.claude-…'}</p>
        </div>
        <div className="flex items-center gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={cn('h-5 w-5 rounded-full transition-transform hover:scale-110', color === c && 'ring-2 ring-fg/50 ring-offset-2 ring-offset-panel')}
              style={{ background: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
        <div className="rounded-xl bg-hover p-3 text-[12px] leading-relaxed text-muted">
          <div className="flex gap-2">
            <Link2 size={13} className="mt-0.5 shrink-0" />
            <span>
              <b className="text-fg">Shared:</b> nothing yet. Share a project afterwards (Shared projects) to continue its sessions under this account.
            </span>
          </div>
          <div className="mt-1 flex gap-2">
            <KeyRound size={13} className="mt-0.5 shrink-0" />
            <span>
              <b className="text-fg">Its own:</b> sign-in, settings, statsig. ~/.claude itself is never changed.
            </span>
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-muted">Kind</label>
          <KindPicker value={kind} onChange={setKind} />
          <p className="mt-1 text-[11px] text-subtle">After sign-in Baton checks this against Claude Code's own account info and corrects it if needed.</p>
        </div>
        <Checkbox checked={own} onChange={setOwn} label={<b>{OWN_TEXT}</b>} hint="Required. Baton is for one person using their own accounts." />
        {secondPersonal && <SecondPlanWarning checked={limits} onChange={setLimits} />}
        <Toggle checked={signIn} onChange={setSignIn} label="Open Terminal to sign in now" />
        {err && <p className="text-[12px] text-danger">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !ready}>
            Review…
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ConflictDialog({
  conflict,
  accounts,
  accName,
  project,
  onClose,
  onForce,
  onRecheck,
}: {
  conflict: Conflict | null;
  accounts: Account[];
  accName: (id: string | null, p?: Proc) => string;
  project: string;
  onClose: () => void;
  onForce: () => void;
  onRecheck: () => void;
}) {
  if (!conflict) return null;
  const target = accounts.find((a) => a.id === conflict.accountId);
  const first = conflict.conflicts[0];
  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      title={`${accName(first?.accountId ?? null, first)} is still running on this project — quit it first`}
      description={`Switching to ${target?.name ?? 'this account'} while another account works in ${base(project)} would interleave two writers on one history. Nothing is stopped without your confirmation.`}
    >
      <div className="space-y-2">
        {conflict.conflicts.map((p) => (
          <div key={p.pid} className="flex items-center gap-3 rounded-xl border border-line bg-card px-3 py-2.5">
            {p.source === 'terminal' ? <Terminal size={15} className="text-muted" /> : <MonitorSmartphone size={15} className="text-muted" />}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{accName(p.accountId, p)}</div>
              <div className="truncate text-[11.5px] text-muted">
                {p.source === 'terminal' ? `Terminal ${p.tty?.replace('/dev/', '')}` : p.source === 'desktop' ? `Claude desktop app «${p.profile ?? 'Claude (default)'}»` : 'Background'} · pid {p.pid} · {tilde(p.cwd ?? '')}
              </div>
            </div>
            <Button size="sm" onClick={() => window.cs.showProcess(p.pid)}>
              <Eye size={13} /> Show it
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.cs.terminateProcess(p.pid).then(() => setTimeout(onRecheck, 1600))}>
              <Power size={13} /> Quit…
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center justify-between">
        <Button variant="ghost" size="sm" className="text-warn" onClick={onForce}>
          Open anyway
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onRecheck}>
            <RefreshCw size={13} /> Check again
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} width={540} title="How Baton works">
      <div className="space-y-4 text-[12.5px] leading-relaxed text-muted [&_b]:text-fg">
        <div>
          <p className="font-semibold text-fg">One account at a time</p>
          <p>
            Every account reads and writes the same project history. Run only one of them on a project at a time — to change account, quit claude, pick the other account and press
            Continue. Baton warns you when another account is still running and never stops anything without asking.
          </p>
        </div>
        <div>
          <p className="font-semibold text-fg">Fair use</p>
          <p>
            Baton is for <b>one person</b> using their <b>own</b> Claude accounts — never shared accounts, never rotating personal plans past their limits, never continuing after
            a ban with another account. Usage meters are informational only. See <b>Fair use</b> in the sidebar.
          </p>
        </div>
        <div>
          <p className="font-semibold text-fg">History lives on this Mac</p>
          <p>
            Transcripts are files in ~/.claude/projects (account 1's store). Nothing is shared by default: in <b>Shared projects</b> you choose which accounts can continue a project's
            chats — in Terminal and in their desktop apps. Nothing is uploaded by this app.
          </p>
        </div>
        <div>
          <p className="font-semibold text-fg">Every change is reversible</p>
          <p>Each change shows its exact file operations first, takes a verified snapshot, and rolls back by itself if a step fails. History › Undo and the Restore center take you back.</p>
        </div>
        <div>
          <p className="font-semibold text-fg">What each account keeps to itself</p>
          <p>Its sign-in (Keychain), settings, and statsig live in its own ~/.claude-&lt;name&gt; folder. ~/.claude is account 1 and is never changed.</p>
        </div>
        <div>
          <p className="font-semibold text-fg">One account, Terminal and desktop app</p>
          <p>
            An <b>account</b> is one email. It works in Terminal and in the Claude desktop app; Accounts shows both on one card. Each account gets its own desktop app, side by side with
            the others. It needs one sign-in the first time and stays signed in after — Baton never copies sign-ins.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl bg-hover p-3 text-[12px]">
          {[
            ['Continue / resume', '⌘↩'],
            ['Search sessions', '⌘F'],
            ['Switch account', '⌘1 … ⌘9'],
            ['Project picker', '⌘P'],
            ['Choose folder', '⌘O'],
            ['Add account', '⌘N'],
            ['Refresh', '⌘R'],
            ['Quick switch', 'menu-bar icon'],
          ].map(([a, k]) => (
            <div key={a} className="flex items-center justify-between">
              <span>{a}</span>
              <Kbd>{k}</Kbd>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
