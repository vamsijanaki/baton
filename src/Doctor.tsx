import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Info, TriangleAlert, OctagonAlert, RefreshCw, Stethoscope, Loader2 } from 'lucide-react';
import type { DoctorCheck, MigrationSummary } from './types';
import { Button, Card, PageHeader, cn } from './ui';
import { tilde } from './lib';
import { cleanErr, useOps } from './ops';
import { MigrationSummaryView } from './Sharing';

const ICON = { ok: CheckCircle2, info: Info, warn: TriangleAlert, error: OctagonAlert };
const TONE = { ok: 'text-ok', info: 'text-muted', warn: 'text-warn', error: 'text-danger' };
const LABEL = { ok: 'OK', info: 'Info', warn: 'Warning', error: 'Problem' };

/** Health check. Every fix goes through the same plan → preview → snapshot → apply path. */
export function DoctorView({ toast }: { toast: (t: string, tone?: 'ok' | 'warn') => void }) {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const runOp = useOps();
  const load = useCallback(async (deep = false) => {
    setBusy(true);
    try {
      setChecks(await window.cs.doctor(deep));
      setAt(Date.now());
    } catch (e) {
      toast(cleanErr(e), 'warn');
    } finally {
      setBusy(false);
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load]);

  const fix = async (c: DoctorCheck) => {
    if (!c.fix) return;
    if (c.fix.kind === 'recover') {
      const n = await window.cs.recover();
      toast(`Rolled back ${n} interrupted operation(s)`, 'ok');
      return load();
    }
    runOp({
      kind: c.fix.kind,
      args: c.fix.args,
      title: c.fix.label,
      confirmLabel: c.fix.kind === 'migrate' ? 'Apply migration' : 'Apply fix',
      renderSummary: c.fix.kind === 'migrate' ? (s: MigrationSummary) => <MigrationSummaryView s={s} /> : undefined,
      onDone: () => load(),
    });
  };

  const problems = checks?.filter((c) => c.level === 'warn' || c.level === 'error').length ?? 0;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Doctor"
        subtitle="Checks links, desktop chat-list sync, desktop app copies, disk space, interrupted operations and snapshot integrity. Fixes are previewed and snapshotted like every other change."
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => load(true)} disabled={busy} aria-label="Run deep check (re-verifies every snapshot)">
              Deep check
            </Button>
            <Button variant="secondary" onClick={() => load()} disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Check again
            </Button>
          </div>
        }
      />
      <Card
        icon={<Stethoscope size={15} />}
        title={checks ? (problems ? `${problems} thing${problems === 1 ? ' needs' : 's need'} attention` : 'All good') : 'Checking…'}
        actions={at ? <span className="text-[11px] text-subtle">checked {new Date(at).toLocaleTimeString()}</span> : undefined}
      >
        <ul className="divide-y divide-line" aria-live="polite">
          {(checks ?? []).map((c) => {
            const I = ICON[c.level];
            return (
              <li key={c.id} className="flex items-start gap-3 py-2.5">
                <I size={16} className={cn('mt-0.5 shrink-0', TONE[c.level])} aria-label={LABEL[c.level]} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{c.title}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{tilde(c.detail)}</p>
                </div>
                {c.fix && (
                  <Button size="sm" variant={c.level === 'error' || c.level === 'warn' ? 'primary' : 'secondary'} onClick={() => fix(c)}>
                    {c.fix.label}…
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
