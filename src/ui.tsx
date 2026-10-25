import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react';

export const cn = (...c: ClassValue[]) => twMerge(clsx(c));

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
export function Button({ variant = 'secondary', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md' | 'lg' | 'icon' }) {
  return (
    <button
      {...p}
      className={cn(
        'no-drag inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' && 'h-7 px-2.5 text-[12px]',
        size === 'md' && 'h-8 px-3 text-[13px]',
        size === 'lg' && 'h-11 px-5 text-[14px] rounded-xl',
        size === 'icon' && 'h-7 w-7 rounded-md',
        variant === 'primary' && 'bg-accent text-accent-fg shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_1px_2px_rgba(0,0,0,0.18)] hover:brightness-105',
        variant === 'secondary' && 'bg-card text-fg border border-line shadow-[0_1px_2px_rgba(0,0,0,0.05)] hover:bg-hover',
        variant === 'outline' && 'border border-line text-fg hover:bg-hover',
        variant === 'ghost' && 'text-muted hover:text-fg hover:bg-hover',
        variant === 'danger' && 'bg-danger text-white hover:brightness-105',
        className,
      )}
    />
  );
}

export function Input({ className, ...p }: ComponentProps<"input">) {
  return (
    <input
      {...p}
      className={cn(
        'no-drag h-8 w-full rounded-lg border border-line bg-card px-2.5 text-[13px] text-fg placeholder:text-subtle outline-none transition focus:border-accent/60 focus:ring-3 focus:ring-accent/15',
        className,
      )}
    />
  );
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'ok' | 'warn' | 'accent' | 'danger'; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[11px] font-medium leading-[18px]',
        tone === 'neutral' && 'bg-hover text-muted',
        tone === 'ok' && 'bg-ok/14 text-ok',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'accent' && 'bg-accent/14 text-accent',
        tone === 'danger' && 'bg-danger/14 text-danger',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-hover px-1 py-px font-sans text-[10.5px] text-muted">{children}</kbd>;
}

export function Dot({ color, size = 10, pulse }: { color: string; size?: number; pulse?: boolean }) {
  return <span className={cn('inline-block shrink-0 rounded-full ring-2 ring-white/10', pulse && 'pulse')} style={{ background: color, width: size, height: size }} />;
}

/**
 * Modal dialog. The header and `footer` stay put; only the body scrolls, so the footer's buttons are always
 * reachable however short the window is.
 */
export function Dialog({ open, onClose, title, description, children, footer, width = 460 }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        // keep keyboard focus inside the dialog
        const f = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select,textarea,summary,[tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) (e.preventDefault(), f[f.length - 1].focus());
        else if (!e.shiftKey && i === f.length - 1) (e.preventDefault(), f[0].focus());
      }
    };
    window.addEventListener('keydown', h);
    setTimeout(() => {
      if (ref.current && !ref.current.contains(document.activeElement)) (ref.current.querySelector<HTMLElement>('[autofocus],input,button.primary-action') ?? ref.current).focus();
    }, 0);
    return () => (window.removeEventListener('keydown', h), prev?.focus?.());
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[2px] animate-in" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        tabIndex={-1}
        className="relative flex max-h-[min(86vh,calc(100vh-32px))] max-w-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_24px_60px_-12px_rgba(0,0,0,0.35)] animate-pop"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute right-3 top-3 z-10 rounded-md p-1 text-subtle hover:bg-hover hover:text-fg" aria-label="Close">
          <X size={15} />
        </button>
        <div className="shrink-0 px-5 pt-5">
          <h2 id={`${id}-t`} className="pr-6 text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {description && <div className="mt-1 text-[12.5px] leading-relaxed text-muted">{description}</div>}
        </div>
        <div data-dialog-body className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-4', footer ? 'pb-4' : 'pb-5')}>{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-panel px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="no-drag flex cursor-pointer items-center gap-2 text-[12px] text-muted">
      <span
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), onChange(!checked))}
        onClick={() => onChange(!checked)}
        className={cn('relative h-[18px] w-[30px] rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line')}
      >
        <span className={cn('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-all', checked ? 'left-[14px]' : 'left-[2px]')} />
      </span>
      {label}
    </label>
  );
}

export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="pointer-events-none absolute left-1/2 top-full z-40 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-fg px-2 py-1 text-[11px] text-panel opacity-0 shadow transition-opacity delay-300 group-hover:opacity-100">
        {text}
      </span>
    </span>
  );
}

/** Section card — the one surface style used by every screen. */
export function Card({ title, icon, actions, children, className, description }: { title?: ReactNode; icon?: ReactNode; actions?: ReactNode; description?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={cn('animate-up rounded-2xl border border-line bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]', className)}>
      {(title || actions) && (
        <div className="flex items-center gap-2">
          {icon && <span className="text-muted" aria-hidden>{icon}</span>}
          {title && <h3 className="text-[13px] font-semibold">{title}</h3>}
          <div className="flex-1" />
          {actions}
        </div>
      )}
      {description && <p className="mt-1 text-[12px] leading-relaxed text-muted">{description}</p>}
      {children && <div className={cn(title || actions || description ? 'mt-3' : '')}>{children}</div>}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-end gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-[20px] font-semibold tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-[680px] text-[12.5px] leading-relaxed text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-10 text-center">
      {icon && <div className="mb-2 text-subtle" aria-hidden>{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <p className="mt-1 max-w-[440px] text-[12px] leading-relaxed text-muted">{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[12px] leading-relaxed text-danger whitespace-pre-wrap">
      {children}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover', disabled && 'cursor-not-allowed opacity-50')}>
      <input type="checkbox" className="mt-[3px] h-3.5 w-3.5 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px]">{label}</span>
        {hint && <span className="block text-[11.5px] text-muted">{hint}</span>}
      </span>
    </label>
  );
}
