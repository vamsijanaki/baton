import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ShieldCheck, TriangleAlert, Loader2, CheckCircle2, Clock, ListChecks, Ban, Power } from 'lucide-react';
import type { OpPlan, OpResult } from './types';
import { Button, Dialog, ErrorNote, cn } from './ui';
import { tilde } from './lib';

export interface OpRequest {
  kind: string;
  args?: unknown;
  title?: string;
  intro?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  renderSummary?: (summary: any) => ReactNode;
  onDone?: (r: Extract<OpResult, { status: 'done' }>) => void;
}
type Phase = 'planning' | 'preview' | 'applying' | 'waiting' | 'done' | 'error';

const Ctx = createContext<(r: OpRequest) => void>(() => undefined);
export const useOps = () => useContext(Ctx);
export const cleanErr = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, '');

/**
 * Every change goes through this dialog: plan → dry-run preview (exact file operations) → confirm → apply
 * (snapshot + journal + verify + automatic rollback happen in the main process).
 */
export function OpsProvider({ children, toast }: { children: ReactNode; toast: (t: string, tone?: 'ok' | 'warn') => void }) {
  const [req, setReq] = useState<OpRequest | null>(null);
  const [plan, setPlan] = useState<OpPlan | null>(null);
  const [phase, setPhase] = useState<Phase>('planning');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Extract<OpResult, { status: 'done' }> | null>(null);
  const [showAll, setShowAll] = useState(false);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const token = useRef<string | null>(null);

  const doPlan = useCallback(async (r: OpRequest) => {
    try {
      const p = await window.cs.opPlan(r.kind, r.args);
      token.current = p.token;
      setPlan(p);
      return p;
    } catch (e) {
      setError(cleanErr(e));
      setPhase('error');
      return null;
    }
  }, []);

  const start = useCallback(
    (r: OpRequest) => {
      setReq(r);
      setPlan(null);
      setError('');
      setResult(null);
      setShowAll(false);
      setPhase('planning');
      doPlan(r).then((p) => p && setPhase('preview'));
    },
    [doPlan],
  );

  const stopWaiting = () => waitTimer.current && (clearTimeout(waitTimer.current), (waitTimer.current = null));
  const close = () => {
    stopWaiting();
    if (token.current && phase !== 'done') window.cs.opCancel(token.current);
    token.current = null;
    setReq(null);
  };

  const apply = async (quitFirst = false) => {
    if (!token.current || !req) return;
    setPhase('applying');
    try {
      const r = quitFirst ? await window.cs.opQuitApply(token.current) : await window.cs.opApply(token.current);
      if (r.status === 'busy') {
        // re-plan so the preview stays exact, then poll until the processes are gone
        setPhase('waiting');
        const p = await doPlan(req);
        if (p) setPlan({ ...p, preview: { ...p.preview, busy: r.busy } });
        return;
      }
      token.current = null;
      if (r.status === 'done') {
        setResult(r);
        setPhase('done');
        req.onDone?.(r);
        toast(`${plan?.preview.title ?? 'Done'} — snapshot kept`, 'ok');
      } else {
        setPhase('done');
      }
    } catch (e) {
      token.current = null;
      setError(cleanErr(e));
      setPhase('error');
    }
  };

  // waiting for running Claude processes to quit: re-check every 3 s, apply when free
  useEffect(() => {
    if (phase !== 'waiting' || !req) return;
    const tick = async () => {
      if (token.current) await window.cs.opCancel(token.current);
      const p = await doPlan(req);
      if (!p) return;
      if (!p.preview.busy.length) return apply();
      waitTimer.current = setTimeout(tick, 3000);
    };
    waitTimer.current = setTimeout(tick, 3000);
    return () => {
      stopWaiting();
    };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const pv = plan?.preview;
  const quit = plan?.quittable ?? [];
  const lines = pv?.lines ?? [];
  const shown = showAll ? lines : lines.slice(0, 14);
  const blocked = !!pv?.refused.length;
  const title = req?.title ?? pv?.title ?? 'Review changes';
  // the footer stays visible below the scrolling body (long previews never hide the Apply button)
  const footer =
    pv && (phase === 'preview' || phase === 'applying' || phase === 'waiting') ? (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        {pv.busy.length > 0 && phase !== 'waiting' && phase !== 'applying' ? (
          <>
            <Button variant={quit.length ? 'secondary' : 'primary'} className={quit.length ? undefined : 'primary-action'} disabled={blocked} onClick={() => setPhase('waiting')}>
              <Clock size={13} /> Wait, then apply
            </Button>
            {quit.length > 0 && (
              <Button variant="primary" className="primary-action" disabled={blocked || !lines.length} onClick={() => apply(true)}>
                <Power size={13} /> Quit {quit.map((q) => q.name).join(' and ')} and continue
              </Button>
            )}
          </>
        ) : (
          <Button variant={req?.danger ? 'danger' : 'primary'} className="primary-action" disabled={blocked || phase !== 'preview' || !lines.length} onClick={() => apply()} autoFocus>
            {phase === 'applying' ? <Loader2 size={13} className="animate-spin" /> : null}
            {phase === 'applying' ? 'Applying…' : phase === 'waiting' ? 'Waiting…' : (req?.confirmLabel ?? 'Apply')}
          </Button>
        )}
      </>
    ) : phase === 'done' ? (
      <Button variant="primary" onClick={close} autoFocus>
        Close
      </Button>
    ) : phase === 'error' ? (
      <Button onClick={close} autoFocus>
        Close
      </Button>
    ) : undefined;

  return (
    <Ctx.Provider value={start}>
      {children}
      <Dialog open={!!req} onClose={close} width={660} title={title} description={req?.intro} footer={footer}>
        {phase === 'planning' && (
          <p className="flex items-center gap-2 text-[12.5px] text-muted" role="status">
            <Loader2 size={14} className="animate-spin" /> Working out exactly what would change…
          </p>
        )}
        {pv && (phase === 'preview' || phase === 'applying' || phase === 'waiting') && (
          <div className="space-y-3">
            {req?.renderSummary && plan?.summary && req.renderSummary(plan.summary)}
            {pv.notes.length > 0 && (
              <ul className="space-y-1 text-[12px] leading-relaxed text-muted">
                {pv.notes.map((n, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span aria-hidden>·</span>
                    <span>{tilde(n)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-subtle">
                <ListChecks size={12} /> Dry run — {lines.length} file operation{lines.length === 1 ? '' : 's'}
              </div>
              {lines.length ? (
                <ol className="selectable max-h-[260px] list-decimal space-y-0.5 overflow-auto rounded-lg bg-hover py-2 pl-8 pr-2.5 font-mono text-[10.8px] leading-relaxed" aria-label="File operations">
                  {shown.map((l, i) => (
                    <li key={i}>{tilde(l)}</li>
                  ))}
                </ol>
              ) : (
                <p className="rounded-lg bg-hover px-3 py-2 text-[12px] text-muted">Nothing to change — it already looks like this.</p>
              )}
              {lines.length > shown.length && (
                <button className="mt-1 text-[11.5px] text-accent hover:underline" onClick={() => setShowAll(true)}>
                  Show all {lines.length}
                </button>
              )}
            </div>
            <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-muted">
              <ShieldCheck size={13} className="mt-px shrink-0 text-ok" />
              Before anything changes, every touched path is snapshotted and the snapshot is verified. Steps are journaled; if one fails — or the app quits mid-way — everything is
              rolled back. You can undo it later from History.
            </p>
            {blocked && (
              <ErrorNote>
                <b>Refused by the safety guard:</b>
                {'\n'}
                {pv.refused.map(tilde).join('\n')}
              </ErrorNote>
            )}
            {pv.busy.length > 0 && (
              <div role="status" className="rounded-lg border border-warn/40 bg-warn/8 px-3 py-2 text-[12px] text-warn">
                <p className="flex items-center gap-1.5 font-medium">
                  <Clock size={13} /> {phase === 'waiting' ? 'Waiting for these to quit — it will apply by itself:' : 'Still running — quit these first (⌘Q), or wait:'}
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {pv.busy.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                {quit.length > 0 && phase !== 'waiting' && (
                  <p className="mt-1 text-[11.5px]">“Quit and continue” asks {quit.length === 1 ? 'it' : 'them'} to quit like ⌘Q, waits up to 20 s (nothing changes if {quit.length === 1 ? 'it stays' : 'one stays'} open), applies, then reopens {quit.length === 1 ? 'it' : 'them'}.</p>
                )}
              </div>
            )}
          </div>
        )}
        {phase === 'done' && (
          <div className="space-y-3" role="status">
            <p className="flex items-center gap-2 text-[13px] font-medium text-ok">
              <CheckCircle2 size={16} /> Done and verified.
            </p>
            {result && (
              <p className="text-[12px] text-muted">
                Snapshot <span className="selectable font-mono text-[11px]">{result.snapshotId}</span>. To reverse it: History › <b>Undo this</b>.
              </p>
            )}
          </div>
        )}
        {phase === 'error' && (
          <div className="space-y-3">
            <p className={cn('flex items-center gap-2 text-[13px] font-medium', /Rolled back/.test(error) ? 'text-warn' : 'text-danger')}>
              {/Rolled back/.test(error) ? <TriangleAlert size={16} /> : <Ban size={16} />} {/Rolled back/.test(error) ? 'It failed, and everything was put back.' : 'Could not do that.'}
            </p>
            <ErrorNote>{tilde(error)}</ErrorNote>
          </div>
        )}
      </Dialog>
    </Ctx.Provider>
  );
}
