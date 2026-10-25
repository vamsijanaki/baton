import { contextBridge, ipcRenderer } from 'electron';

const invoke = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('cs', {
  snapshot: invoke('snapshot'),
  sessions: invoke('sessions'),
  knownProjects: invoke('knownProjects'),
  signIn: invoke('signIn'),
  updateAccount: invoke('updateAccount'),
  select: invoke('select'),
  forgetProject: invoke('forgetProject'),
  chooseProject: invoke('chooseProject'),
  preview: invoke('preview'),
  launch: invoke('launch'),
  showProcess: invoke('showProcess'),
  terminateProcess: invoke('terminateProcess'),
  setDryRun: invoke('setDryRun'),
  usageRefresh: invoke('usageRefresh'),
  fairUseConfirm: invoke('fairUseConfirm'),
  fairUseAttestAll: invoke('fairUseAttestAll'),
  usageHookInfo: invoke('usageHookInfo'),
  openUsage: invoke('openUsage'),
  desktopProfiles: invoke('desktopProfiles'),
  accountsOverview: invoke('accountsOverview'),
  desktopOpen: invoke('desktopOpen'),
  reveal: invoke('reveal'),
  opPlan: invoke('opPlan'),
  opApply: invoke('opApply'),
  opQuitApply: invoke('opQuitApply'),
  opCancel: invoke('opCancel'),
  history: invoke('history'),
  snapshots: invoke('snapshots'),
  snapshotDiff: invoke('snapshotDiff'),
  snapshotVerify: invoke('snapshotVerify'),
  revealSnapshot: invoke('revealSnapshot'),
  sharingInfo: invoke('sharingInfo'),
  migrationPreview: invoke('migrationPreview'),
  doctor: invoke('doctor'),
  recover: invoke('recover'),
  settingsGet: invoke('settingsGet'),
  settingsSet: invoke('settingsSet'),
  about: invoke('about'),
  activity: invoke('activity'),
  exportDiagnostics: invoke('exportDiagnostics'),
  openLog: invoke('openLog'),
  clearLock: invoke('clearLock'),
  on: (ch: 'changed' | 'route' | 'conflict' | 'launchBlocked', fn: (payload: any) => void) => {
    const h = (_: unknown, p: any) => fn(p);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
});
