// Baton — tray popover logic. Pure functions only (no Electron, no node:fs), so the test suite and the
// popover renderer can both import it.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const POPOVER_WIDTH = 360;
export const POPOVER_MIN_HEIGHT = 220;
export const POPOVER_MAX_HEIGHT = 560;
/** Space between the menu-bar icon and the popover. */
export const POPOVER_GAP = 6;
/** The popover never touches a screen edge. */
export const POPOVER_MARGIN = 8;

/**
 * Where the popover goes for a tray icon. `tray` is the icon's bounds in screen coordinates (may be all zero
 * when macOS has not laid the icon out yet — pass the cursor point as a 0×0 rect then). `workArea` is the
 * work area of the display the icon is on (menu bar and Dock excluded), `bounds` that display's full bounds.
 * A menu bar at the top puts the popover below the icon; an icon in the lower half of its display (a bottom
 * bar) puts it above. Always clamped inside the work area, horizontally centred on the icon when there is room.
 */
export function popoverPosition(tray: Rect, workArea: Rect, bounds: Rect, size: { width: number; height: number }, gap = POPOVER_GAP, margin = POPOVER_MARGIN) {
  const width = Math.min(size.width, workArea.width - 2 * margin);
  const height = Math.max(0, Math.min(size.height, POPOVER_MAX_HEIGHT, workArea.height - 2 * margin));
  const cx = tray.x + tray.width / 2;
  const cy = tray.y + tray.height / 2;
  const below = cy < bounds.y + bounds.height / 2;
  const minX = workArea.x + margin;
  const maxX = workArea.x + workArea.width - width - margin;
  const x = Math.round(Math.min(Math.max(cx - width / 2, minX), maxX));
  const minY = workArea.y + margin;
  const maxY = workArea.y + workArea.height - height - margin;
  // below a top menu bar: just under the icon, but never above the work area (the icon sits in the menu bar)
  const raw = below ? Math.max(tray.y + tray.height, workArea.y) + gap : Math.min(tray.y, workArea.y + workArea.height) - gap - height;
  const y = Math.round(Math.min(Math.max(raw, below ? workArea.y + gap : minY), maxY));
  return { x, y, width, height, edge: below ? ('top' as const) : ('bottom' as const) };
}

/** A label for a native menu item: "&" is a mnemonic marker there, so a literal one has to be doubled. */
export const menuLabel = (s: string) => s.replace(/&/g, '&&');

/** Same value as USAGE_MIN_INTERVAL_MS in fairuse.ts (the test suite checks they agree). */
export const USAGE_CHECK_INTERVAL_MS = 15 * 60_000;

/**
 * When the next usage check is allowed. Informational only: the 15-minute gate itself lives in usage.ts
 * (usageGate) and runs for every Refresh, whichever window it comes from.
 */
export function nextUsageCheck(lastProbeAt: number | null | undefined, now = Date.now(), interval = USAGE_CHECK_INTERVAL_MS) {
  if (!lastProbeAt) return { ready: true, minutes: 0, at: now };
  const at = lastProbeAt + interval;
  if (at <= now) return { ready: true, minutes: 0, at };
  return { ready: false, minutes: Math.max(1, Math.ceil((at - now) / 60_000)), at };
}

/** "just now" / "4 min ago" / "2 h ago" / "3 d ago". */
export function ago(t: number | null | undefined, now = Date.now()) {
  if (!t) return 'never';
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export type LaunchResult =
  | { status: 'launched'; command: string; dryRun: boolean }
  | { status: 'fairuse'; accountId: string; problem: { code: string; message: string } }
  | { status: 'suspended'; accountId: string; owners: string[]; message: string; support: string }
  | { status: 'conflict'; conflicts: unknown[] };

/**
 * What happens after a "Continue" from the tray (popover or native menu). Anything the launch gates refused
 * goes to the main window, which shows the same confirmation / suspended / conflict dialogs as everywhere else.
 */
export function routeLaunchResult(accountId: string, r: LaunchResult | null) {
  if (!r) return { kind: 'error' as const };
  if (r.status === 'launched') return { kind: 'done' as const, dryRun: r.dryRun };
  if (r.status === 'conflict') return { kind: 'window' as const, route: 'conflict', event: 'conflict' as const, payload: { accountId, conflicts: r.conflicts, continueLast: true } };
  return { kind: 'window' as const, route: undefined, event: 'launchBlocked' as const, payload: r };
}

/** Main-window pages the popover may open. Anything else is ignored. */
export const TRAY_ROUTES = ['home', 'accounts', 'sharing', 'doctor', 'history', 'settings', 'add'] as const;
export type TrayRoute = (typeof TRAY_ROUTES)[number];
export const isTrayRoute = (r: unknown): r is TrayRoute => typeof r === 'string' && (TRAY_ROUTES as readonly string[]).includes(r);
