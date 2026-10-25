// Preload for the tray popover. A deliberately small surface: it reads the same snapshot as the main window,
// refreshes usage through the same gated IPC, and hands every launch to main, where the fair-use gates run.
// It cannot confirm accounts, change sharing or run operations — those stay in the main window.
import { contextBridge, ipcRenderer } from 'electron';

const invoke = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('baton', {
  snapshot: invoke('snapshot'),
  desktopProfiles: invoke('desktopProfiles'),
  select: invoke('select'),
  usageRefresh: invoke('usageRefresh'),
  continueIn: invoke('trayContinue'),
  openDesktop: invoke('trayDesktop'),
  open: invoke('trayOpen'),
  hide: invoke('trayHide'),
  quit: invoke('trayQuit'),
  resize: invoke('trayResize'),
  on: (ch: 'changed' | 'trayShown', fn: (payload: any) => void) => {
    const h = (_: unknown, p: any) => fn(p);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
});
