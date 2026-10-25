import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderGit2, Share2, Lock, ArrowRightLeft, TriangleAlert, Plus, Check, ChevronRight } from 'lucide-react';
import type { MigrationSummary, SharingInfo } from './types';
import { Badge, Button, Card, Checkbox, Dialog, Dot, EmptyState, PageHeader, Toggle, cn } from './ui';
import { base, tilde } from './lib';
import { useOps } from './ops';

/** Shared projects: which project folders' history is visible to which accounts and desktop lists. */
export function SharingView() {
  const [info, setInfo] = useState<SharingInfo | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const runOp = useOps();
  const load = useCallback(() => window.cs.sharingInfo().then(setInfo).catch(() => undefined), []);
  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  const legacy = info?.terminal.filter((t) => t.legacyAll) ?? [];
  const shared = info?.config.projects ?? [];
  const others = useMemo(() => (info ? info.candidates.filter((c) => !shared.some((s) => s.path === c)) : []), [info, shared]);

  const migrate = () =>
    runOp({
      kind: 'migrate',
      title: 'Migrate to per-project sharing',
      confirmLabel: 'Apply migration',
      intro: 'Replaces the old all-or-nothing sharing. Only the project below stays shared; everything else becomes private to each account again. Nothing is deleted.',
      renderSummary: (s: MigrationSummary) => <MigrationSummaryView s={s} />,
      onDone: load,
    });

  if (!info) return null;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Shared projects"
        subtitle={
          <>
            Choose which projects another account may continue. By default <b>nothing is shared</b>: each account only sees its own chats. {info.account1} holds the history, so it always
            sees everything.
          </>
        }
      />

      {legacy.length > 0 && (
        <Card className="border-warn/40 bg-warn/[0.06]" icon={<TriangleAlert size={15} className="text-warn" />} title="Old all-or-nothing sharing is still active">
          <p className="text-[12.5px] leading-relaxed text-muted">
            {legacy.map((l) => l.name).join(', ')} can see <b>every</b> project's history (its projects folder is one link to all of ~/.claude/projects). The migration keeps only the
            project you share, shows every file operation first, takes a verified snapshot and can be undone.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={migrate}>
              <ArrowRightLeft size={13} /> Review migration…
            </Button>
          </div>
        </Card>
      )}

      <Card title="Shared" icon={<Share2 size={15} />} description="Each row is one project folder and the accounts that can continue its chats — in Terminal and in their desktop apps.">
        {shared.length === 0 ? (
          <EmptyState icon={<Lock size={22} />} title="Nothing is shared">
            Every account keeps its history to itself. Share a project below when you want to continue its sessions under another account.
          </EmptyState>
        ) : (
          <div className="divide-y divide-line">
            {shared.map((p) => (
              <ProjectRow key={p.path} info={info} path={p.path} onEdit={() => setEditing(p.path)} />
            ))}
          </div>
        )}
      </Card>

      <Card title="Private projects" icon={<Lock size={15} />} description="Folders with history that are not shared. Share one to make it visible to other accounts.">
        {others.length === 0 ? (
          <p className="text-[12px] text-muted">No other folders with history.</p>
        ) : (
          <div className="divide-y divide-line">
            {(showAll ? others : others.slice(0, 8)).map((p) => (
              <ProjectRow key={p} info={info} path={p} onEdit={() => setEditing(p)} />
            ))}
          </div>
        )}
        {others.length > 8 && !showAll && (
          <button className="mt-2 text-[12px] text-accent hover:underline" onClick={() => setShowAll(true)}>
            Show all {others.length}
          </button>
        )}
      </Card>

      {editing && <ShareEditor info={info} project={editing} onClose={() => setEditing(null)} onDone={load} />}
    </div>
  );
}

function ProjectRow({ info, path, onEdit }: { info: SharingInfo; path: string; onEdit: () => void }) {
  const cfg = info.config.projects.find((p) => p.path === path);
  const accs = info.terminal.filter((t) => info.states[path]?.[t.id] === 'shared' || t.legacyAll);
  const apps = new Set((info.derived[path] ?? []).map((k) => k.split('/')[0])).size;
  return (
    <div className="flex items-center gap-3 py-2.5">
      <FolderGit2 size={16} className="shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-medium">{base(path)}</span>
          <span className="truncate font-mono text-[10.5px] text-subtle">{tilde(path)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
          <span>{info.counts[path] ?? 0} sessions</span>
          <span className="text-subtle">·</span>
          {accs.length ? (
            <>
              <span>continued by</span>
              {accs.map((a) => (
                <Badge key={a.id} tone={a.legacyAll ? 'warn' : 'ok'}>
                  <Dot color={a.color} size={6} /> {a.name}
                  {a.legacyAll ? ' (everything)' : ''}
                </Badge>
              ))}
            </>
          ) : (
            <span>only {info.account1}</span>
          )}
          {cfg && apps > 0 && (
            <>
              <span className="text-subtle">·</span>
              <span>{apps} desktop app{apps === 1 ? '' : 's'}</span>
            </>
          )}
          {cfg && cfg.accounts.length > 0 && !(info.derived[path] ?? []).some((k) => (info.desktopCounts[path]?.[k] ?? 0) > 0) && (
            <>
              <span className="text-subtle">·</span>
              <span title="Desktop sidebars only list chats started in a desktop app; Terminal chats continue with Continue in Terminal.">no desktop-app chats yet</span>
            </>
          )}
        </div>
      </div>
      <Button size="sm" variant={cfg ? 'secondary' : 'outline'} onClick={onEdit} aria-label={`Change sharing for ${base(path)}`}>
        {cfg ? 'Change…' : (
          <>
            <Plus size={12} /> Share…
          </>
        )}
      </Button>
    </div>
  );
}

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '');

/** Why the project is (not) shared right now — read from the journal of past operations. */
function reasonFor(info: SharingInfo, project: string): string {
  const cfg = info.config.projects.find((p) => p.path === project);
  if (!cfg || !cfg.accounts.length) return `Private — only ${info.account1} can continue these chats.`;
  const s = info.since[project];
  if (!s) return 'Shared (set up before Baton kept a history of changes).';
  const why = s.kind === 'migrate' ? 'kept from your old all-projects setup during migration' : 'you shared it here';
  return `Shared since ${fmtWhen(s.since)} — ${why}.`;
}

function ShareEditor({ info, project, onClose, onDone }: { info: SharingInfo; project: string; onClose: () => void; onDone: () => void }) {
  const cfg = info.config.projects.find((p) => p.path === project);
  const [accs, setAccs] = useState<string[]>(cfg?.accounts ?? info.terminal.filter((t) => info.states[project]?.[t.id] === 'shared').map((t) => t.id));
  const [custom, setCustom] = useState(false); // the Advanced matrix was edited
  const [lists, setLists] = useState<string[]>(cfg && !cfg.auto ? cfg.desktop : info.derived[project] ?? []);
  const runOp = useOps();
  const people = info.people;
  const chosen = people.filter((p) => p.isDefault || accs.includes(p.id));
  // what "automatic" means for the current toggles: every desktop list owned by a chosen account (never leftovers)
  const autoLists = useMemo(() => info.folders.filter((f) => f.owned && !f.leftover && chosen.some((p) => p.email && p.email === f.email)).map((f) => f.key), [info, chosen]);
  const shownLists = custom ? lists : autoLists;
  const byApp = useMemo(() => {
    const m = new Map<string, SharingInfo['folders']>();
    for (const f of info.folders) m.set(f.profileName, [...(m.get(f.profileName) ?? []), f]);
    return [...m.entries()];
  }, [info]);
  const setAcc = (id: string, on: boolean) => setAccs(on ? [...new Set([...accs, id])] : accs.filter((x) => x !== id));
  const toggleList = (k: string, on: boolean) => {
    setCustom(true);
    setLists((cur) => {
      const base_ = custom ? cur : autoLists;
      return on ? [...new Set([...base_, k])] : base_.filter((x) => x !== k);
    });
  };
  const names = people.filter((p) => !p.isDefault && accs.includes(p.id)).map((p) => p.name);
  const review = () => {
    onClose();
    runOp({
      kind: 'share',
      args: custom ? { project, accounts: accs, desktop: lists } : { project, accounts: accs, auto: true },
      title: `Who can continue ${base(project)}'s chats`,
      confirmLabel: 'Apply',
      intro: names.length ? `${info.account1} and ${names.join(', ')} — in Terminal and in their desktop apps.` : `Only ${info.account1}.`,
      onDone,
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={600}
      title={`Share ${base(project)}`}
      description={
        <>
          <span className="block font-mono text-[11px]">{tilde(project)}</span>
          <span className="mt-1 block text-[12px]">{reasonFor(info, project)}</span>
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="primary-action" onClick={review}>
            Review changes…
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-1 text-[12.5px] font-semibold">Who can continue this project's chats</p>
          <p className="mb-2 text-[11.5px] text-muted">An account that is on sees this project's history in Terminal and its chats in each of its desktop apps' Code sidebar. Other projects stay private.</p>
          <div className="divide-y divide-line rounded-xl border border-line">
            {people.map((p) => {
              const st = info.states[project]?.[p.id] ?? 'private';
              const on = p.isDefault || accs.includes(p.id);
              const where = `Terminal${p.apps.length ? ` + ${p.apps.join(', ')}` : ''}`;
              return (
                <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Dot color={p.color} size={9} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] font-medium">
                      {p.name} {p.email && <span className="font-normal text-muted">· {p.email}</span>}
                    </p>
                    <p className="text-[11.5px] text-muted">
                      {p.isDefault
                        ? `Always — it holds the history. ${where}.`
                        : p.legacyAll
                          ? 'Sees every project now (old setup) — run the migration first.'
                          : st === 'private-history'
                            ? `${where}. Has its own chats here: they are added to the history (never overwriting) and its folder is kept.`
                            : where}
                    </p>
                    {!p.isDefault && (() => {
                      const proj = base(project);
                      const hi = info.hideImpact?.[project]?.[p.id];
                      const wasOn = !!cfg?.accounts.includes(p.id) || st === 'shared';
                      if (wasOn && hi?.count)
                        return (
                          <p className={cn('mt-0.5 text-[11.5px]', on ? 'text-subtle' : 'text-warn')}>
                            Turning {p.name} off hides {hi.count} {proj} chat{hi.count === 1 ? '' : 's'} from {hi.apps.join(', ')} (kept in a backup; turning it back on restores them).
                          </p>
                        );
                      const hn = info.hiddenNow?.[project]?.[p.id];
                      if (hn?.count)
                        return (
                          <p className={cn('mt-0.5 text-[11.5px]', on ? 'text-ok' : 'text-subtle')}>
                            {hn.count} {proj} chat{hn.count === 1 ? ' is' : 's are'} hidden from {hn.apps.join(', ')} — {on ? 'applying restores them' : `turning ${p.name} on restores them`}.
                          </p>
                        );
                      return null;
                    })()}
                  </div>
                  {p.isDefault ? (
                    <span className="flex items-center gap-1 text-[11.5px] text-ok">
                      <Check size={13} /> always
                    </span>
                  ) : (
                    <Toggle checked={on} onChange={(v) => !p.legacyAll && setAcc(p.id, v)} label={<span className="sr-only">{p.name}</span>} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <DesktopSidebarNote info={info} project={project} lists={accs.length ? shownLists : []} />
        <details className="group rounded-xl border border-line px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-muted hover:text-fg">
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" aria-hidden /> Advanced — pick desktop chat lists by hand
          </summary>
          <p className="mb-1.5 mt-2 text-[11.5px] text-muted">
            {custom
              ? 'Custom choice: only the ticked lists sync this project.'
              : cfg && !cfg.auto && cfg.desktop.length
                ? 'This project used a hand-picked list before. Applying with the toggles above switches it to automatic (what is ticked now).'
                : 'Automatic: follows the toggles above. Ticking a box here switches to a custom choice.'}{' '}
            Only index files of chats inside this project are mirrored, both ways; the newest edit wins and the other version is saved. Nothing is deleted. An open app is updated after it
            quits.
          </p>
          {byApp.length === 0 && <p className="px-2 text-[12px] text-subtle">No desktop chat list yet — open a desktop app's Code tab once.</p>}
          {byApp.map(([name, fs]) => (
            <div key={name} className="mb-1">
              <p className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle">{name}</p>
              {fs.map((f) => (
                <Checkbox
                  key={f.key}
                  checked={shownLists.includes(f.key)}
                  onChange={(v) => toggleList(f.key, v)}
                  disabled={f.isLink}
                  label={
                    <span className="flex flex-wrap items-center gap-1.5">
                      {f.email ?? `account …${f.accountUuid.slice(-4)}`} <span className="text-subtle">· org …{f.orgUuid.slice(-4)}</span>
                      {f.leftover && <Badge tone="neutral">old sign-in leftover</Badge>}
                      {f.running && <Badge tone="neutral">open</Badge>}
                    </span>
                  }
                  hint={
                    f.isLink
                      ? 'Still an old whole-folder link — the migration converts it.'
                      : f.leftover
                        ? `From an earlier sign-in of this app (${f.sessions} chat${f.sessions === 1 ? '' : 's'}); not part of automatic sharing.`
                        : `${info.desktopCounts[project]?.[f.key] ?? 0} of ${f.sessions} chats are in this project`
                  }
                />
              ))}
            </div>
          ))}
        </details>
      </div>
    </Dialog>
  );
}

/** Desktop sidebars only list desktop-app chats; say so, say when there are none, and name open apps that update later. */
function DesktopSidebarNote({ info, project, lists }: { info: SharingInfo; project: string; lists: string[] }) {
  const counts = info.desktopCounts[project] ?? {};
  const most = Math.max(0, ...lists.map((k) => counts[k] ?? 0));
  const waiting = [...new Set(info.folders.filter((f) => lists.includes(f.key) && f.running && (counts[f.key] ?? 0) < most).map((f) => f.profileName))];
  return (
    <div className="rounded-xl bg-hover px-3 py-2 text-[11.5px] leading-relaxed text-muted">
      <p>Desktop sidebars only list chats started in a desktop app; Terminal chats continue with Continue in Terminal.</p>
      {lists.length > 0 && most === 0 && <p className="mt-0.5">No desktop-app chats for this project yet — nothing to show in desktop sidebars.</p>}
      {waiting.length > 0 && (
        <p className="mt-0.5 text-warn">
          {waiting.join(', ')} {waiting.length === 1 ? 'is open — it will show them after it quits and reopens' : 'are open — they will show them after they quit and reopen'}.
        </p>
      )}
    </div>
  );
}

export function MigrationSummaryView({ s }: { s: MigrationSummary }) {
  return (
    <div className="space-y-2 rounded-xl border border-line p-3 text-[12px] leading-relaxed">
      <p>
        <b>Stays shared:</b> {s.shareProjects.length ? s.shareProjects.map((p) => base(p)).join(', ') : 'nothing'}
      </p>
      {s.accounts.map((a) => (
        <p key={a.name}>
          <b>{a.name}:</b> {tilde(a.from)} → {a.to}. {a.hiddenProjects} other project folder(s) become private to account 1 (their transcripts are not touched).
        </p>
      ))}
      <p>
        <b>Desktop lists:</b> {s.desktop.liveLinks} old folder link(s) converted, {s.desktop.staleRecords} stale record(s) cleared. {s.desktop.participants.length} list(s) that used the old
        shared list now sync this project only — {s.desktop.copies} index file(s) copied now{s.desktop.deferred ? `, ${s.desktop.deferred} after open desktop apps quit` : ''}.
      </p>
      <ul className={cn('list-disc pl-5 text-muted')}>
        {s.unchanged.map((u) => (
          <li key={u}>{tilde(u)}</li>
        ))}
      </ul>
    </div>
  );
}
