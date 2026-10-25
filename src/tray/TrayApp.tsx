// Baton — menu-bar popover.
//
// Fair use: usage here is information only. Accounts are listed in the order you added them (never by what is
// left), meters look the same at any level, and nothing suggests moving to another account. Every action goes
// through main (continueFromTray → launch → launchGate), so confirmations and the suspended-account rule apply.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Check, ChevronDown, History, Monitor, Plus, Power, RefreshCw, Settings, Share2, Stethoscope, TerminalSquare } from 'lucide-react';
import type { Account, DesktopProfile, FairUseInfo, Snapshot, Usage, UsageWindow } from '../types';
import { ago, nextUsageCheck } from '../../electron/tray-logic';
import { api, type TrayRoute } from './api';

type Profile = DesktopProfile & { email?: string | null; forAccount?: string | null; retired?: unknown };

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const tilde = (p: string, home: string) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p);
const inside = (cwd: string | null, project: string) => !!cwd && (cwd === project || cwd.startsWith(project.replace(/\/+$/, '') + '/'));

function resetLabel(w: UsageWindow | null | undefined, now: number) {
  if (!w) return '';
  if (w.resetsAt) {
    const d = new Date(w.resetsAt);
    const sameDay = w.resetsAt - now < 20 * 3.6e6 && d.getDate() === new Date(now).getDate();
    return sameDay
      ? `resets ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
      : `resets ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric' })}`;
  }
  return w.resetText ? `resets ${w.resetText}` : '';
}

function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg className="t-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <rect x="6" y="30" width="56" height="14" rx="7" fill="currentColor" />
      <rect x="38" y="56" width="56" height="14" rx="7" className="t-mark-teal" />
    </svg>
  );
}

function Meter({ label, w, now }: { label: string; w: UsageWindow | null | undefined; now: number }) {
  const pct = w ? Math.max(0, Math.min(100, Math.round(w.pct))) : null;
  return (
    <div className="t-meter" aria-label={`${label} window: ${pct == null ? 'not read yet' : pct + '% used'}`}>
      <span className="t-meter-label">{label}</span>
      <span className="t-meter-track">
        <span className="t-meter-fill" style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span className="t-meter-pct">{pct == null ? '–' : `${pct}%`}</span>
      <span className="t-meter-reset">{resetLabel(w, now)}</span>
    </div>
  );
}

function AccountCard(props: {
  acc: Account;
  index: number;
  usage: Usage | undefined;
  fair: FairUseInfo | undefined;
  activeHere: 'running' | 'starting' | null;
  profile: Profile | null;
  focused: boolean;
  now: number;
  busy: boolean;
  onFocus: () => void;
  onContinue: () => void;
  onDesktop: () => void;
  onRefresh: () => void;
  onSignIn: () => void;
}) {
  const { acc, usage: u, fair, now } = props;
  const kind = fair?.kind;
  const next = nextUsageCheck(u?.probeAt ?? null, now);
  const needsConfirm = !!fair?.problem;
  const suspended = !!fair?.suspended;
  const hasLimits = !!(u?.fiveHour || u?.sevenDay);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.focused && document.activeElement !== ref.current && !ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: false });
  }, [props.focused]);
  return (
    <div
      ref={ref}
      className={`t-card${props.focused ? ' is-focused' : ''}${props.activeHere ? ' is-active' : ''}`}
      tabIndex={0}
      data-nav="card"
      role="group"
      aria-label={`${acc.name}${acc.email ? `, ${acc.email}` : ''}`}
      style={{ ['--acc' as string]: acc.color }}
      onFocus={props.onFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          acc.signedIn ? props.onContinue() : props.onSignIn();
        }
      }}
    >
      <div className="t-card-head">
        <span className="t-dot" />
        <span className="t-name">{acc.name}</span>
        {kind && <span className="t-chip">{kind === 'work' ? 'Work' : 'Personal'}</span>}
        <span className="t-grow" />
        {props.activeHere && (
          <span className="t-live">
            <span className="t-live-dot" />
            {props.activeHere === 'starting' ? 'Starting…' : 'Active here'}
          </span>
        )}
        {props.index < 9 && <kbd className="t-kbd">⌘{props.index + 1}</kbd>}
      </div>
      <div className="t-sub">
        <span className="t-email" title={acc.email ?? undefined}>
          {acc.email ?? (acc.signedIn ? 'Signed in' : 'Not signed in yet')}
        </span>
        {acc.signedIn && (
          <span className="t-usage-foot" title={u?.probing ? 'Checking usage…' : `Usage checked ${ago(u?.capturedAt ?? null, now)} · checked when Baton opens and on Refresh, at most every 15 min`}>
            <span>{u?.probing ? 'checking…' : next.ready ? 'can check now' : `next check in ${next.minutes} min`}</span>
            <button
              className="t-icon-btn"
              data-nav="btn"
              disabled={!next.ready || !!u?.probing}
              title={next.ready ? 'Check usage now' : 'Usage is checked at most every 15 minutes'}
              aria-label={`Check usage for ${acc.name}`}
              onClick={props.onRefresh}
            >
              <RefreshCw size={11} className={u?.probing ? 't-spin' : ''} />
            </button>
          </span>
        )}
      </div>

      {(suspended || needsConfirm) && (
        <div className={`t-note${suspended ? ' is-suspended' : ''}`}>
          {suspended ? 'Suspended — Baton won’t continue its projects in another account.' : 'Needs a quick confirmation before Baton opens claude for it.'}
        </div>
      )}

      {acc.signedIn && (
        <div className="t-usage">
          {hasLimits ? (
            <>
              <Meter label="5h" w={u?.fiveHour} now={now} />
              <Meter label="week" w={u?.sevenDay} now={now} />
            </>
          ) : (
            <div className="t-usage-empty">{u?.probing ? 'Checking usage…' : 'Usage not read yet'}</div>
          )}
        </div>
      )}

      <div className="t-actions">
        {acc.signedIn ? (
          <button className="t-btn t-btn-primary" data-nav="btn" disabled={props.busy} onClick={props.onContinue}>
            <TerminalSquare size={13} />
            {needsConfirm ? 'Confirm & continue…' : 'Continue in Terminal'}
          </button>
        ) : (
          <button className="t-btn t-btn-primary" data-nav="btn" onClick={props.onSignIn}>
            Sign in…
          </button>
        )}
        <button className="t-btn" data-nav="btn" onClick={props.onDesktop} title={props.profile ? props.profile.name : 'Set up a Claude desktop app for this account'}>
          <Monitor size={13} />
          {props.profile ? 'Open desktop app' : 'Desktop app…'}
        </button>
      </div>
    </div>
  );
}

export default function TrayApp() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [focus, setFocus] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(0);
  const [now, setNow] = useState(Date.now());
  const panel = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [s, d] = await Promise.all([api().snapshot(), api().desktopProfiles().catch(() => null)]);
    setSnap(s);
    if (d) setProfiles(d.profiles as Profile[]);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const offs = [
      api().on('changed', (s) => s && (setSnap(s), setNow(Date.now()))),
      api().on('trayShown', () => {
        setShown((n) => n + 1);
        setMenuOpen(false);
        setNote(null);
        setFocus(0);
        void load();
      }),
    ];
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => (offs.forEach((o) => o()), clearInterval(t));
  }, [load]);

  // the window follows the content height (main clamps it to the screen and 560 px)
  useLayoutEffect(() => {
    const el = panel.current;
    const list = el?.querySelector<HTMLElement>('.t-cards');
    const inner = el?.querySelector<HTMLElement>('.t-cards-inner');
    if (!el || !list || !inner) return;
    // natural height = the panel with the account list fully expanded (the list scrolls once the window is at its max)
    const measure = () => void api().resize(Math.ceil(el.getBoundingClientRect().height - list.clientHeight + inner.getBoundingClientRect().height) + 2);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // replay the open animation each time the popover is shown (CSS turns it off for reduced motion)
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    el.classList.remove('is-in');
    void el.offsetWidth;
    el.classList.add('is-in');
  }, [shown]);

  const accounts = snap?.accounts ?? []; // the order they were added in — never sorted by usage
  const project = snap?.state.project ?? '';
  const home = snap?.home ?? '';

  const activeHere = useCallback(
    (id: string): 'running' | 'starting' | null => {
      if (!snap) return null;
      if (snap.running.some((p) => p.accountId === id && inside(p.cwd, project))) return 'running';
      if (snap.lock && snap.lock.account === id && snap.lock.project === project) return snap.lock.pid ? 'running' : 'starting';
      return null;
    },
    [snap, project],
  );

  const profileFor = useMemo(() => {
    const live = profiles.filter((p) => !p.retired);
    return (acc: Account) => live.find((p) => (acc.email && p.email === acc.email) || p.forAccount === acc.id) ?? null;
  }, [profiles]);

  const flash = (m: string) => {
    setNote(m);
    setTimeout(() => setNote((n) => (n === m ? null : n)), 3200);
  };

  const continueAs = async (acc: Account) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api().continueIn(acc.id);
      if (r?.kind === 'done') {
        flash(r.dryRun ? `Dry run — command for ${acc.name} written to the log` : `Opening ${acc.name} in Terminal…`);
        if (!r.dryRun) setTimeout(() => void api().hide(), 450);
      } else if (r?.kind === 'error') flash(r.message ?? 'Could not open Terminal');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (acc: Account) => {
    const r = await api().usageRefresh(acc.id).catch((e) => ({ error: String(e?.message ?? e) }) as { error: string; throttled?: undefined });
    if (r?.throttled) flash(`Checked less than 15 minutes ago — next check from ${new Date(r.throttled.nextAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`);
    else if (r?.error) flash(`Couldn’t read usage: ${r.error}`);
  };

  const open = (route: TrayRoute) => void api().open(route);

  // keyboard: ↑/↓ move between cards and buttons, Enter acts, Esc closes, ⌘1–⌘9 continue as that account
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (menuOpen) setMenuOpen(false);
        else void api().hide();
        return;
      }
      if (e.metaKey && /^[1-9]$/.test(e.key)) {
        const acc = accounts[Number(e.key) - 1];
        if (acc) {
          e.preventDefault();
          setFocus(Number(e.key) - 1);
          acc.signedIn ? void continueAs(acc) : open('accounts');
        }
        return;
      }
      if (e.metaKey && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        void api().quit();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const scope = menuOpen ? document.querySelector('.t-menu') : panel.current;
        const items = [...(scope?.querySelectorAll<HTMLElement>(menuOpen ? '[data-menu-item]' : '[data-nav="card"], [data-nav="tile"], [data-nav="foot"]') ?? [])];
        if (!items.length) return;
        e.preventDefault();
        const i = items.findIndex((el) => el === document.activeElement || el.contains(document.activeElement));
        const n = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1;
        items[n].focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="t-stage">
      <div ref={panel} data-shown={shown} className="t-panel" role="dialog" aria-label="Baton">
        <div className="t-glow" aria-hidden />
        <header className="t-header">
          <Mark />
          <span className="t-brand">Baton</span>
          <span className="t-grow" />
          {snap?.dryRun && <span className="t-chip t-chip-dim">dry run</span>}
        </header>

        <div className="t-project">
          <button className="t-project-btn" data-nav="tile" title={project} aria-haspopup="listbox" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            <span className="t-project-kicker">Project</span>
            <span className="t-project-name">{project ? basename(project) : 'No project yet'}</span>
            <span className="t-project-path">{project ? tilde(project, home) : ''}</span>
            <ChevronDown size={14} className={`t-chev${menuOpen ? ' is-open' : ''}`} />
          </button>
          {menuOpen && (
            <div className="t-menu" role="listbox" aria-label="Recent projects">
              {(snap?.state.recentProjects ?? []).map((p) => (
                <button
                  key={p}
                  role="option"
                  aria-selected={p === project}
                  data-menu-item
                  className="t-menu-item"
                  title={p}
                  onClick={async () => {
                    setMenuOpen(false);
                    if (p !== project) await api().select({ project: p });
                  }}
                >
                  <span className="t-menu-check">{p === project && <Check size={13} />}</span>
                  <span className="t-menu-name">{basename(p)}</span>
                  <span className="t-menu-path">{tilde(p, home)}</span>
                </button>
              ))}
              <button data-menu-item className="t-menu-item t-menu-more" onClick={() => open('home')}>
                <span className="t-menu-check" />
                <span className="t-menu-name">Choose another folder in Baton…</span>
              </button>
            </div>
          )}
        </div>

        <div className="t-section">
          <span>Accounts</span>
          <span className="t-section-hint">continue latest session</span>
        </div>
        <div className="t-cards">
          <div className="t-cards-inner">
          {accounts.map((a, i) => (
            <AccountCard
              key={a.id}
              acc={a}
              index={i}
              usage={snap?.usage[a.id]}
              fair={snap?.fairUse[a.id]}
              activeHere={activeHere(a.id)}
              profile={profileFor(a)}
              focused={focus === i}
              now={now}
              busy={busy}
              onFocus={() => setFocus(i)}
              onContinue={() => void continueAs(a)}
              onDesktop={() => void api().openDesktop(profileFor(a)?.id ?? null)}
              onRefresh={() => void refresh(a)}
              onSignIn={() => open('accounts')}
            />
          ))}
          {snap && !accounts.length && <div className="t-usage-empty">No accounts yet.</div>}
          </div>
        </div>

        <div className="t-tiles">
          {(
            [
              ['home', 'Open Baton', AppWindow],
              ['sharing', 'Shared projects', Share2],
              ['doctor', 'Doctor', Stethoscope],
              ['history', 'History & restore', History],
            ] as const
          ).map(([route, label, Icon]) => (
            <button key={route} className="t-tile" data-nav="tile" onClick={() => open(route)}>
              <Icon size={15} />
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div className={`t-toast${note ? ' is-on' : ''}`} role="status" aria-live="polite">
          {note}
        </div>

        <footer className="t-footer">
          <button className="t-foot-btn" data-nav="foot" onClick={() => open('add')}>
            <Plus size={14} /> Add account
          </button>
          <span className="t-grow" />
          <button className="t-icon-btn t-foot-icon" data-nav="foot" title="Settings" aria-label="Settings" onClick={() => open('settings')}>
            <Settings size={14} />
          </button>
          <button className="t-icon-btn t-foot-icon" data-nav="foot" title="Quit Baton (⌘Q)" aria-label="Quit Baton" onClick={() => void api().quit()}>
            <Power size={14} />
          </button>
        </footer>
      </div>
    </div>
  );
}
