import { useCallback, useEffect, useMemo, useState } from 'react';
import { History as HistoryIcon, Undo2, ChevronRight, Archive, ScrollText, ShieldCheck, Pin, FolderOpen, RotateCcw } from 'lucide-react';
import type { HistoryItem, RestoreItem, SnapshotInfo } from './types';
import { Badge, Button, Card, Checkbox, EmptyState, PageHeader, cn } from './ui';
import { bytes, tilde, timeAgo } from './lib';
import { useOps } from './ops';

type Tab = 'ops' | 'restore' | 'activity';
const STATUS: Record<HistoryItem['status'], { t: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  done: { t: 'done', tone: 'ok' },
  'rolled-back': { t: 'rolled back', tone: 'warn' },
  'failed-rollback': { t: 'rollback had problems', tone: 'danger' },
  applying: { t: 'interrupted', tone: 'danger' },
};

export function HistoryView({ initialTab = 'ops' }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const tabs: [Tab, string, typeof HistoryIcon][] = [
    ['ops', 'Operations', HistoryIcon],
    ['restore', 'Restore center', Archive],
    ['activity', 'Activity log', ScrollText],
  ];
  return (
    <div className="space-y-5">
      <PageHeader title="History & restore" subtitle="Every change Baton made, the snapshot taken before it, and a way back. Undo and restore are previewed and snapshotted too." />
      <div role="tablist" aria-label="History sections" className="flex gap-1 rounded-xl bg-hover p-1">
        {tabs.map(([k, label, I]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors', tab === k ? 'bg-card shadow-sm' : 'text-muted hover:text-fg')}
          >
            <I size={13} /> {label}
          </button>
        ))}
      </div>
      {tab === 'ops' && <Operations />}
      {tab === 'restore' && <RestoreCenter />}
      {tab === 'activity' && <Activity />}
    </div>
  );
}

function Operations() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showSync, setShowSync] = useState(false);
  const runOp = useOps();
  const load = useCallback(() => window.cs.history().then(setItems), []);
  useEffect(() => {
    load();
  }, [load]);
  const shown = (items ?? []).filter((i) => showSync || i.kind !== 'sync');
  if (!items) return null;
  if (!items.length)
    return (
      <EmptyState icon={<HistoryIcon size={22} />} title="No operations yet">
        Sharing changes, migrations, desktop app changes and restores will appear here, each with its snapshot and an Undo.
      </EmptyState>
    );
  return (
    <Card
      actions={
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          <input type="checkbox" checked={showSync} onChange={(e) => setShowSync(e.target.checked)} className="accent-[var(--accent)]" /> Show background sync passes ({items.filter((i) => i.kind === 'sync').length})
        </label>
      }
    >
      <ul className="divide-y divide-line">
        {shown.map((i) => {
          const st = STATUS[i.status];
          const isOpen = open === i.id;
          return (
            <li key={i.id} className="py-2">
              <div className="flex items-center gap-2">
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(isOpen ? null : i.id)} aria-expanded={isOpen}>
                  <ChevronRight size={13} className={cn('shrink-0 text-subtle transition-transform', isOpen && 'rotate-90')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{i.title}</span>
                    <span className="text-[11.5px] text-muted">
                      {new Date(i.createdAt).toLocaleString()} · {i.steps.length} step{i.steps.length === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>
                <Badge tone={st.tone}>{st.t}</Badge>
                {i.undoneBy && <Badge tone="neutral">undone</Badge>}
                {i.status === 'done' && !i.undoneBy && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      runOp({
                        kind: 'undo',
                        args: { journalId: i.id },
                        title: `Undo: ${i.title}`,
                        confirmLabel: 'Undo',
                        intro: 'Puts every path this operation touched back the way the snapshot recorded it. The current state is snapshotted first, so this can be undone too.',
                        onDone: load,
                      })
                    }
                  >
                    <Undo2 size={12} /> Undo this
                  </Button>
                )}
              </div>
              {isOpen && (
                <div className="mt-2 space-y-2 pl-6 text-[12px]">
                  {i.error && <p className="text-warn">{tilde(i.error)}</p>}
                  <ol className="selectable list-decimal space-y-0.5 rounded-lg bg-hover py-2 pl-8 pr-2 font-mono text-[10.8px]">
                    {i.steps.map((s, n) => (
                      <li key={n}>{tilde(s)}</li>
                    ))}
                  </ol>
                  {i.rollbackLog?.length ? (
                    <div>
                      <p className="font-medium">Rollback</p>
                      <ul className="list-disc pl-5 text-muted">
                        {i.rollbackLog.map((l, n) => (
                          <li key={n}>{tilde(l)}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <p className="text-muted">
                    Snapshot <span className="selectable font-mono text-[11px]">{i.snapshotId}</span>
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function RestoreCenter() {
  const [snaps, setSnaps] = useState<SnapshotInfo[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<RestoreItem[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [verify, setVerify] = useState<Record<string, boolean>>({});
  const [showSync, setShowSync] = useState(false);
  const runOp = useOps();
  const load = useCallback(() => window.cs.snapshots().then(setSnaps), []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!sel) return;
    setDiff(null);
    window.cs.snapshotDiff(sel).then((d) => {
      setDiff(d);
      setPicked(d.filter((x) => x.current !== 'same').map((x) => x.path));
    });
  }, [sel]);
  const changed = useMemo(() => (diff ?? []).filter((d) => d.current !== 'same'), [diff]);
  const list = (snaps ?? []).filter((s) => showSync || s.category !== 'sync' || s.pinned);
  if (!snaps) return null;
  if (!snaps.length) return <EmptyState icon={<Archive size={22} />} title="No snapshots yet">A verified snapshot is taken before every change.</EmptyState>;
  const current = snaps.find((s) => s.id === sel);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-4">
      <Card
        title="Snapshots"
        actions={
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <input type="checkbox" checked={showSync} onChange={(e) => setShowSync(e.target.checked)} className="accent-[var(--accent)]" /> sync
          </label>
        }
      >
        <ul className="max-h-[520px] space-y-1 overflow-auto" role="listbox" aria-label="Snapshots">
          {list.map((s) => (
            <li key={s.id}>
              <button
                role="option"
                aria-selected={sel === s.id}
                onClick={() => setSel(s.id)}
                className={cn('w-full rounded-lg px-2.5 py-2 text-left', sel === s.id ? 'bg-accent/[0.1]' : 'hover:bg-hover')}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium">{s.title}</span>
                  {s.pinned && <Pin size={11} className="shrink-0 text-accent" aria-label="pinned" />}
                </span>
                <span className="text-[11px] text-muted">
                  {timeAgo(Date.parse(s.createdAt))} · {s.entryCount} path(s) · {bytes(s.bytes)}
                  {s.quarantined ? ` · ${s.quarantined} quarantined` : ''} {s.verified ? '· verified' : '· NOT verified'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={current ? current.title : 'Pick a snapshot'} icon={<RotateCcw size={14} />}>
        {!current && <p className="text-[12px] text-muted">Choose a snapshot to see what restoring it would change.</p>}
        {current && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => window.cs.snapshotVerify(current.id).then((v) => setVerify((m) => ({ ...m, [current.id]: v.ok })))}
              >
                <ShieldCheck size={12} /> Verify now
              </Button>
              {current.id in verify && <Badge tone={verify[current.id] ? 'ok' : 'danger'}>{verify[current.id] ? 'archive verified' : 'verification FAILED'}</Badge>}
              <Button size="sm" variant="ghost" onClick={() => window.cs.revealSnapshot(current.id)}>
                <FolderOpen size={12} /> Show in Finder
              </Button>
            </div>
            {!diff && <p className="text-[12px] text-muted">Comparing with the current files…</p>}
            {diff && changed.length === 0 && <p className="text-[12px] text-ok">Everything already matches this snapshot.</p>}
            {diff && changed.length > 0 && (
              <>
                <p className="text-[12px] text-muted">{changed.length} path(s) differ from the snapshot. Pick what to restore:</p>
                <div className="max-h-[320px] overflow-auto rounded-lg border border-line p-1">
                  {changed.map((d) => (
                    <Checkbox
                      key={d.path}
                      checked={picked.includes(d.path)}
                      onChange={(v) => setPicked((p) => (v ? [...p, d.path] : p.filter((x) => x !== d.path)))}
                      label={<span className="font-mono text-[11px]">{tilde(d.path)}</span>}
                      hint={{ different: `changed since (snapshot has a ${d.snapType})`, missing: `gone now (snapshot has a ${d.snapType})`, extra: 'created since — restoring moves it to quarantine (links are just removed)', same: '' }[d.current]}
                    />
                  ))}
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="primary"
                    disabled={!picked.length}
                    onClick={() =>
                      runOp({
                        kind: 'restore',
                        args: { snapshotId: current.id, paths: picked.length === changed.length ? [] : picked },
                        title: picked.length === changed.length ? 'Restore all' : `Restore ${picked.length} path(s)`,
                        confirmLabel: 'Restore',
                        intro: 'Anything replaced is moved into quarantine (never deleted), and the current state is snapshotted first.',
                        onDone: () => (load(), setSel(null)),
                      })
                    }
                  >
                    Restore {picked.length === changed.length ? 'all' : `${picked.length} selected`}…
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function Activity() {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    window.cs.activity(400).then(setLines);
  }, []);
  if (!lines) return null;
  if (!lines.length) return <EmptyState icon={<ScrollText size={22} />} title="No activity yet" />;
  return (
    <Card title="Activity log" description="Launches, sign-ins, usage checks, operations and sync passes — newest first. Emails are masked.">
      <ol className="selectable max-h-[560px] space-y-0.5 overflow-auto font-mono text-[10.8px] leading-relaxed">
        {lines.map((l, i) => (
          <li key={i} className="border-b border-line/50 py-0.5">
            <span className="text-subtle">{l.slice(0, 19).replace('T', ' ')}</span> {l.slice(25)}
          </li>
        ))}
      </ol>
    </Card>
  );
}
