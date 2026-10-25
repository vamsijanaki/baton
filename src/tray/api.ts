import type { DesktopData, Snapshot } from '../types';

export type TrayContinueResult = { kind: 'done'; dryRun: boolean } | { kind: 'window'; status: string } | { kind: 'error'; message?: string } | null;
export type TrayRoute = 'home' | 'accounts' | 'sharing' | 'doctor' | 'history' | 'settings' | 'add';

/** What tray-preload.ts exposes. Nothing here can confirm accounts or bypass the launch gates. */
export interface BatonTrayApi {
  snapshot(): Promise<Snapshot>;
  desktopProfiles(): Promise<DesktopData>;
  select(patch: { project?: string }): Promise<void>;
  usageRefresh(accountId: string): Promise<{ throttled?: { nextAt: number; reason: string }; error?: string }>;
  continueIn(accountId: string): Promise<TrayContinueResult>;
  openDesktop(profileId: string | null): Promise<{ opened: boolean } | null>;
  open(route: TrayRoute): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<void>;
  resize(height: number): Promise<void>;
  on(ch: 'changed', fn: (s: Snapshot) => void): () => void;
  on(ch: 'trayShown', fn: (p: { reduceMotion: boolean }) => void): () => void;
}

declare global {
  interface Window {
    baton: BatonTrayApi;
  }
}

export const api = () => window.baton;
