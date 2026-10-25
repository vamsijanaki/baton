import { useEffect, useState } from 'react';
import { Ban, Briefcase, Check, ExternalLink, ShieldCheck, TriangleAlert, User, X } from 'lucide-react';
import type { Account, AccountKind, FairUseInfo, LaunchBlocked, Snapshot } from './types';
import { Badge, Button, Card, Checkbox, Dialog, Dot, ErrorNote, PageHeader, cn } from './ui';

type Links = Snapshot['links'];
const errText = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '\w+': (Error: )?/, '');

export const OWN_TEXT = 'This account is mine, and only I use it.';
export const LIMITS_TEXT = "I'm not using this to get around usage limits.";

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
      {children} <ExternalLink size={10} aria-hidden />
    </a>
  );
}

export function OfficialLinks({ links }: { links: Links }) {
  return (
    <ul className="space-y-1 text-[12px]">
      <li>
        <A href={links.aup}>Anthropic Usage Policy</A> — see “Do Not Abuse Our Platform”
      </li>
      <li>
        <A href={links.consumerTerms}>Consumer Terms of Service</A> — no sharing your login; work-email accounts may be linked to your organization
      </li>
      <li>
        <A href={links.claudeCodeLegal}>Claude Code legal and compliance</A> — Pro/Max limits assume ordinary, individual use
      </li>
    </ul>
  );
}

export function Disclaimer() {
  return <p className="text-[11.5px] text-subtle">Not legal advice. Baton is an independent tool and is not affiliated with or endorsed by Anthropic.</p>;
}

export const KIND_LABEL: Record<AccountKind, string> = { personal: 'Personal (Free/Pro/Max)', work: 'Work/Team/Enterprise (organization-provided)' };

export function KindBadge({ f }: { f?: FairUseInfo }) {
  if (!f) return null;
  if (f.suspended)
    return (
      <Badge tone="danger">
        <Ban size={10} /> Suspended
      </Badge>
    );
  if (!f.kind) return <Badge tone="warn">Kind not set</Badge>;
  return (
    <Badge tone="neutral">
      {f.kind === 'work' ? <Briefcase size={10} /> : <User size={10} />} {f.kind === 'work' ? 'Work' : 'Personal'}
    </Badge>
  );
}

/** Shown whenever a 2nd+ Personal account is being added or confirmed. */
export function SecondPlanWarning({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div data-second-plan className="rounded-xl border border-warn/40 bg-warn/[0.07] p-3 text-[12px] leading-relaxed">
      <p className="flex items-center gap-1.5 font-semibold text-fg">
        <TriangleAlert size={13} className="text-warn" /> This would be a second Personal plan
      </p>
      <p className="mt-1 text-muted">
        Anthropic's usage limits for Pro and Max assume ordinary, individual use. Rotating several personal plans to keep working past their limits may be treated as{' '}
        <b className="text-fg">circumventing restrictions</b> under the Usage Policy and risks suspension of your accounts. Baton never switches accounts for you when one runs low.
      </p>
      <p className="mt-1.5 text-muted">
        <b className="text-fg">Legitimate reasons</b> include keeping separate identities apart (e.g. your personal account and one for a side business you own), or moving from an old
        account to a new one. Each account still has to be yours alone.
      </p>
      <div className="mt-2">
        <Checkbox checked={checked} onChange={onChange} label={<b>{LIMITS_TEXT}</b>} />
      </div>
    </div>
  );
}

export function KindPicker({ value, onChange, detected }: { value: AccountKind | null; onChange: (k: AccountKind) => void; detected?: string | null }) {
  return (
    <div role="radiogroup" aria-label="Account kind" className="grid grid-cols-2 gap-2">
      {(['personal', 'work'] as AccountKind[]).map((k) => (
        <button
          key={k}
          role="radio"
          aria-checked={value === k}
          disabled={!!detected && value !== k}
          onClick={() => onChange(k)}
          className={cn(
            'rounded-xl border px-3 py-2 text-left text-[12px] transition-colors disabled:opacity-40',
            value === k ? 'border-accent bg-accent/[0.08]' : 'border-line hover:bg-hover',
          )}
        >
          <span className="flex items-center gap-1.5 font-medium">
            {k === 'work' ? <Briefcase size={12} /> : <User size={12} />} {k === 'work' ? 'Work/Team/Enterprise' : 'Personal'}
          </span>
          <span className="mt-0.5 block text-[11px] text-muted">{k === 'work' ? 'Provided by your organization' : 'Your own Free, Pro or Max plan'}</span>
        </button>
      ))}
      {detected && <p className="col-span-2 text-[11px] text-subtle">Detected from Claude Code's own account info ({detected}).</p>}
    </div>
  );
}

/** Confirm one existing account (kind, ownership, and the limits tick when it is a 2nd+ Personal plan). */
export function FairUseDialog({ account, info, onClose, onDone }: { account: Account | null; info?: FairUseInfo; onClose: () => void; onDone?: () => void }) {
  const [kind, setKind] = useState<AccountKind | null>(null);
  const [own, setOwn] = useState(false);
  const [limits, setLimits] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    setKind(info?.kind ?? null);
    setOwn(!!info?.attestedAt);
    setLimits(!!info?.limitsAckAt);
    setErr('');
  }, [account?.id]);
  if (!account || !info) return null;
  const detected = info.kindSource === 'detected' ? info.kindHint : null;
  // a 2nd+ Personal plan: another Personal account was added before this one
  const needsLimits = kind === 'personal' && info.personalBefore;
  const ok = own && !!kind && (!needsLimits || limits || !!info.limitsAckAt);
  const save = () =>
    window.cs
      .fairUseConfirm(account.id, { kind, attested: own, notLimitDodging: limits })
      .then(() => (onDone?.(), onClose()))
      .catch((e) => setErr(errText(e)));
  return (
    <Dialog
      open
      onClose={onClose}
      width={540}
      title={`Fair use — ${account.name}`}
      description="Baton is for one person using their own Claude accounts. Confirm this account before Baton opens Claude Code with it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok} onClick={save}>
            <Check size={13} /> Confirm
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <KindPicker value={kind} onChange={setKind} detected={detected} />
        <Checkbox checked={own} onChange={setOwn} label={<b>{OWN_TEXT}</b>} hint="Sharing a login or making your account available to anyone else isn't allowed by Anthropic's terms." />
        {needsLimits && !info.limitsAckAt && <SecondPlanWarning checked={limits} onChange={setLimits} />}
        {kind === 'work' && (
          <p className="rounded-lg bg-hover px-3 py-2 text-[11.5px] text-muted">
            Organization-provided accounts may be monitored and controlled by your organization's admin, including chat content. Follow your employer's policy.
          </p>
        )}
        {err && <ErrorNote>{err}</ErrorNote>}
      </div>
    </Dialog>
  );
}

/** Launch refused: a suspended account's project, or a fair-use confirmation is missing. */
export function SuspendedDialog({ blocked, links, onClose }: { blocked: Extract<LaunchBlocked, { status: 'suspended' }> | null; links: Links; onClose: () => void }) {
  if (!blocked) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      title="Baton won't continue this project in another account"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <a href={links.support} target="_blank" rel="noreferrer">
            <Button variant="primary">
              Contact Anthropic support <ExternalLink size={12} />
            </Button>
          </a>
        </>
      }
    >
      <div className="space-y-3 text-[12.5px] leading-relaxed text-muted">
        <div className="flex gap-2 rounded-xl border border-danger/30 bg-danger/[0.06] p-3 text-fg">
          <Ban size={15} className="mt-0.5 shrink-0 text-danger" />
          <span>{blocked.message}</span>
        </div>
        <p>
          Appeals and questions go to <A href={links.support}>support.anthropic.com</A>. Baton marks an account Suspended only when Claude Code itself says so, and clears it by
          itself once a later check reads the account's limits normally.
        </p>
      </div>
    </Dialog>
  );
}

const DO = [
  ['One person, your own accounts', 'Baton is for you alone, on your Mac, with Claude accounts that are yours.'],
  ['The right account for the right work', 'Personal projects on your personal account; employer work on the account your organization gave you.'],
  ["Follow your employer's policy", 'Organization accounts may be monitored by their admin; company code may not belong in a personal account.'],
];
const DONT = [
  ['Share accounts', 'No giving your login to anyone, and no letting others use your account through Baton.'],
  ['Buy several personal plans to rotate past limits', 'Using extra Pro/Max plans to keep working past usage limits may be treated as circumventing restrictions.'],
  ['Continue with another account after a ban', 'If an account is suspended, appeal to Anthropic — don’t move its work to a different account.'],
  ['Resell or proxy access', 'No offering your plan to others, and no routing other people’s requests through your subscription.'],
  ['Modify Claude Code', 'Baton runs the unmodified, official claude CLI and Claude desktop app — signed in by you.'],
];

export function FairUseView({ snap, onConfirm }: { snap: Snapshot; onConfirm: (id: string) => void }) {
  return (
    <>
      <PageHeader
        title="Fair use"
        subtitle="Baton helps one person keep their own Claude accounts on the same project history. It is not a way around limits, bans or sharing rules — here is what that means in practice."
      />
      <div className="grid grid-cols-2 gap-4">
        <Card title="Do" icon={<Check size={14} className="text-ok" />}>
          <ul className="space-y-2.5">
            {DO.map(([t, d]) => (
              <li key={t} className="flex gap-2 text-[12.5px]">
                <Check size={13} className="mt-0.5 shrink-0 text-ok" />
                <span>
                  <b>{t}</b>
                  <span className="block text-[12px] text-muted">{d}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Don't" icon={<X size={14} className="text-danger" />}>
          <ul className="space-y-2.5">
            {DONT.map(([t, d]) => (
              <li key={t} className="flex gap-2 text-[12.5px]">
                <X size={13} className="mt-0.5 shrink-0 text-danger" />
                <span>
                  <b>{t}</b>
                  <span className="block text-[12px] text-muted">{d}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title="Your accounts" icon={<ShieldCheck size={14} />} description="Each account needs its kind and your confirmation that it is yours and only you use it. Usage meters are informational — know where you stand.">
        <ul className="divide-y divide-line">
          {snap.accounts.map((a) => {
            const f = snap.fairUse?.[a.id];
            return (
              <li key={a.id} className="flex items-center gap-3 py-2 text-[12.5px]">
                <Dot color={a.color} size={9} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{a.name}</span>
                  <span className="ml-2 text-[11.5px] text-muted">{a.email ?? 'not signed in yet'}</span>
                  {f?.suspended && <span className="block text-[11.5px] text-danger">{f.suspended.reason}</span>}
                  {!f?.suspended && f?.problem && <span className="block text-[11.5px] text-warn">{f.problem.message}</span>}
                </span>
                <KindBadge f={f} />
                {f?.kind && f.kindSource === 'detected' && <span className="text-[11px] text-subtle">detected</span>}
                {f?.attestedAt && !f.problem ? (
                  <Badge tone="ok">
                    <Check size={10} /> Confirmed
                  </Badge>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => onConfirm(a.id)}>
                    Confirm…
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      <Card title="Official pages" description="Read Anthropic's own words — they win over anything Baton says.">
        <OfficialLinks links={snap.links} />
        <p className="mt-3 text-[12px] text-muted">
          Baton never stores, reads or forwards your Claude credentials or tokens, never routes requests through your plan, and never syncs or exports sessions to other people or
          machines. Your history stays on this Mac.
        </p>
        <div className="mt-2">
          <Disclaimer />
        </div>
      </Card>
    </>
  );
}
