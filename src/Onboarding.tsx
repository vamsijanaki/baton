import { useState } from 'react';
import { KeyRound, AppWindow, Share2, ShieldCheck, ArrowRight, ArrowLeft, Scale } from 'lucide-react';
import { Button, Checkbox, Dialog, cn } from './ui';

const STEPS: { icon: typeof KeyRound; title: string; body: React.ReactNode; fair?: boolean }[] = [
  {
    icon: KeyRound,
    title: 'Accounts — one per email',
    body: (
      <>
        <p>
          An <b>account</b> is one Claude sign-in: one email. Each account works in two places, shown together on its card in <b>Accounts</b>: in Terminal (its own config folder, e.g.{' '}
          <code>~/.claude</code> or <code>~/.claude-&lt;name&gt;</code>) and in the Claude desktop app.
        </p>
        <p>Use whichever of your accounts fits the work — personal or work — and continue the same project with its history intact.</p>
      </>
    ),
  },
  {
    icon: Scale,
    title: 'Fair use',
    fair: true,
    body: (
      <>
        <p>
          Baton is for <b>one person</b> using <b>their own</b> Claude accounts. <b>Do</b> use the right account for the right work and follow your employer's policy.{' '}
          <b>Don't</b> share accounts, buy several personal plans to rotate past usage limits, continue with another account after a ban, or resell access.
        </p>
        <p>Usage meters are informational only — Baton never suggests another account when one runs low. Full list: sidebar › Fair use. Not legal advice; not affiliated with Anthropic.</p>
      </>
    ),
  },
  {
    icon: AppWindow,
    title: 'The desktop app',
    body: (
      <>
        <p>
          Each account gets its own Claude desktop app, so several accounts can be open side by side. Press <b>Open &lt;account&gt; in desktop app</b>, or <b>Create desktop app for
          &lt;account&gt;</b> if it has none yet.
        </p>
        <p>
          Each desktop app needs <b>one sign-in the first time</b> and stays signed in after that. Baton never copies sign-ins. If two desktop apps are signed in as the same
          email, Accounts offers to merge and tidy them up.
        </p>
      </>
    ),
  },
  {
    icon: Share2,
    title: 'Shared projects',
    body: (
      <>
        <p>
          <b>Nothing is shared by default.</b> For a project, you switch on which accounts can continue its chats. That account then sees the project's history in Terminal and its chats in
          each of its desktop apps' sidebar. Other projects stay private.
        </p>
        <p>The same account always shows the same chat list in all of its desktop apps.</p>
      </>
    ),
  },
  {
    icon: ShieldCheck,
    title: 'Nothing changes without a preview',
    body: (
      <>
        <p>Every change shows the exact file operations first. Then it takes a verified snapshot, applies step by step, checks the result, and rolls back by itself if anything fails.</p>
        <p>
          <b>History</b> can undo any change. The <b>Restore center</b> brings back any snapshot. <b>Doctor</b> finds broken links and other problems. Chats, sign-ins and Claude.app
          itself are protected: Baton refuses to delete or overwrite them.
        </p>
      </>
    ),
  },
];

export function OnboardingWizard({ open, onClose, onGo }: { open: boolean; onClose: () => void; onGo: (view: 'sharing' | 'accounts') => void }) {
  const [i, setI] = useState(0);
  const [own, setOwn] = useState(false);
  const s = STEPS[i];
  const blocked = !!s.fair && !own;
  const next = () => {
    if (s.fair) window.cs.fairUseAttestAll(true).catch(() => undefined);
    setI(i + 1);
  };
  const last = i === STEPS.length - 1;
  const finish = (go?: 'sharing' | 'accounts') => {
    window.cs.settingsSet({ onboarded: true });
    setI(0);
    onClose();
    if (go) onGo(go);
  };
  return (
    <Dialog open={open} onClose={() => finish()} width={560} title="Welcome to Baton">
      <div className="space-y-4">
        <div className="flex gap-1.5" aria-hidden>
          {STEPS.map((_, k) => (
            <span key={k} className={cn('h-1 flex-1 rounded-full transition-colors', k <= i ? 'bg-accent' : 'bg-line')} />
          ))}
        </div>
        <div className="flex items-start gap-3" aria-live="polite">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent">
            <s.icon size={19} />
          </span>
          <div className="min-w-0 space-y-2 text-[12.5px] leading-relaxed text-muted [&_b]:text-fg [&_code]:rounded [&_code]:bg-hover [&_code]:px-1 [&_code]:text-[11.5px]">
            <p className="text-[14px] font-semibold text-fg">
              {i + 1}. {s.title}
            </p>
            {s.body}
            {s.fair && <Checkbox checked={own} onChange={setOwn} label={<b className="text-fg">These accounts are mine, and only I use them.</b>} hint="Required. Each account you add later asks again." />}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-line pt-3">
          <span className="text-[11.5px] text-subtle">
            Step {i + 1} of {STEPS.length}
          </span>
          <div className="flex-1" />
          {i > 0 && (
            <Button variant="ghost" onClick={() => setI(i - 1)}>
              <ArrowLeft size={13} /> Back
            </Button>
          )}
          {!last ? (
            <Button variant="primary" onClick={next} disabled={blocked} autoFocus>
              Next <ArrowRight size={13} />
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => finish('accounts')}>
                Show my accounts
              </Button>
              <Button variant="primary" onClick={() => finish('sharing')} autoFocus>
                Choose shared projects
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
