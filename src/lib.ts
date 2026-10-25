export function timeAgo(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function countdown(iso: string | null | undefined, now: number) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = t - now;
  if (d <= 0) return { done: true, label: 'Reset — ready again' };
  const h = Math.floor(d / 3.6e6);
  const m = Math.floor((d % 3.6e6) / 6e4);
  const s = Math.floor((d % 6e4) / 1000);
  const days = Math.floor(h / 24);
  const label = days > 0 ? `${days}d ${h % 24}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s`;
  return { done: false, label: `Resets in ${label}` };
}

let HOME_DIR = '';
/** The real home folder (from the main process), so ~ works for any home location. */
export const setHome = (h: string) => void (HOME_DIR = h.replace(/\/+$/, ''));
export const tilde = (p: string) => (HOME_DIR && HOME_DIR !== '/' ? p.split(HOME_DIR).join('~') : p).replace(/\/Users\/[^/\s]+/g, '~');
export const base = (p: string) => p.split('/').filter(Boolean).pop() || p;

export function toLocalInput(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
