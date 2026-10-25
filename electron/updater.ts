// Baton — in-app updates, the Electron side. Decisions live in update-logic.ts; this file only connects them to
// electron-updater (GitHub provider → Squirrel.Mac), the settings file and IPC.
//
// Network: requests go to github.com/vamsijanaki/baton/releases (latest tag, releases feed for the notes,
// latest-mac.yml) and GitHub's download host for the .zip and its .blockmap. Nothing else, and nothing at all while
// automatic checks are off and nobody presses Check now. electron-updater is not even loaded in a build where
// updates are off (unsigned/dev, dry run, fake HOME).
//
// Integrity: electron-updater checks the zip's sha512 against latest-mac.yml; Squirrel.Mac then refuses an app whose
// code signature does not satisfy this app's designated requirement (same bundle id, same Developer ID team).
import { app, ipcMain, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readJson, readSettings, writeJsonAtomic, writeSettings } from './safety';
import { updateStateFile } from './roots';
import { isFakeHome, releaseNotes, signatureKind, UPDATE_FEED, UpdateController, updateSupport, type Support, type UpdateStatus } from './update-logic';

export interface UpdaterContext {
  envDryRun: boolean;
  win: () => BrowserWindow | null;
  /** Something about the update badge changed: refresh the snapshot (sidebar footer, tray). */
  broadcast: () => void;
  log: (line: string) => void;
  /** Why installing must wait (a safety operation is running), or null. */
  blocker: () => string | null;
  /** Refuse new operations and write state to disk; called right before the restart. */
  prepareInstall: () => void;
  /** Squirrel refused the update after prepareInstall: let operations and normal window closing work again. */
  installAborted: () => void;
}

let controller: UpdateController | null = null;
export const updateBadge = () => controller?.badge() ?? null;

export function registerUpdater(ctx: UpdaterContext) {
  let signature: 'pending' | 'developer-id' | 'other' = app.isPackaged ? 'pending' : 'other';
  const fakeHome = isFakeHome(process.env.HOME, os.userInfo().homedir, process.env.CS_FAKE_HOME);
  const bundle = path.resolve(process.execPath, '..', '..', '..'); // …/Baton.app
  const support = (): Support => updateSupport({ packaged: app.isPackaged, signature, envDryRun: ctx.envDryRun, fakeHome, appPath: bundle });

  let updater: import('electron-updater').AppUpdater | null = null;
  const getUpdater = () => {
    if (updater) return updater;
    if (!support().enabled) throw new Error(support().reason ?? 'Updates are off.');
    // loaded only here, only when updates are allowed
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    autoUpdater.setFeedURL({ ...UPDATE_FEED });
    autoUpdater.autoDownload = false; // the user presses "Download and install"
    autoUpdater.autoInstallOnAppQuit = false; // installs only through "Restart to update", which waits for operations
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.fullChangelog = true; // notes of every release since the running one
    autoUpdater.logger = { info: () => undefined, warn: (m: unknown) => ctx.log(`updater: ${String(m)}`), error: (m: unknown) => ctx.log(`updater error: ${String(m)}`) } as any;
    autoUpdater.on('error', (e) => {
      // after "Restart to update", Squirrel.Mac's own refusal (e.g. signature mismatch) lands here
      if (controller?.status().phase === 'installing') {
        quittingForUpdate = false;
        ctx.installAborted();
        controller.installFailed(e);
      }
    });
    updater = autoUpdater;
    return autoUpdater;
  };

  let quittingForUpdate = false;
  const readState = () => readJson<{ lastCheckAt?: number | null }>(updateStateFile(), {});

  controller = new UpdateController({
    currentVersion: app.getVersion(),
    support,
    autoCheck: () => readSettings().autoUpdateCheck !== false,
    setAutoCheck: (v) => void writeSettings({ autoUpdateCheck: v }),
    lastCheckAt: () => readState().lastCheckAt ?? null,
    setLastCheckAt: (t) => {
      try {
        writeJsonAtomic(updateStateFile(), { ...readState(), lastCheckAt: t });
      } catch {
        /* read-only mode */
      }
    },
    check: async () => {
      const r = await getUpdater().checkForUpdates();
      if (!r?.isUpdateAvailable) return null;
      const i = r.updateInfo;
      return { version: i.version, date: i.releaseDate ?? null, notes: releaseNotes(i.releaseNotes as any, i.version) };
    },
    download: async (progress) => {
      const u = getUpdater();
      const onProgress = (p: { percent: number }) => progress(p.percent);
      u.on('download-progress', onProgress);
      try {
        await u.downloadUpdate();
      } finally {
        u.removeListener('download-progress', onProgress);
      }
    },
    blocker: ctx.blocker,
    prepareInstall: () => {
      ctx.prepareInstall();
      quittingForUpdate = true;
    },
    install: () => getUpdater().quitAndInstall(false, true),
    emit: (s: UpdateStatus) => {
      ctx.win()?.webContents.send('update', s);
      ctx.broadcast();
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log: ctx.log,
  });

  ipcMain.handle('updateStatus', () => controller!.status());
  ipcMain.handle('updateCheck', () => controller!.checkNow());
  ipcMain.handle('updateDownload', () => controller!.download());
  ipcMain.handle('updateRestart', () => controller!.restart());
  ipcMain.handle('updateSetAuto', (_e, v: boolean) => (controller!.setAutoCheck(v === true), controller!.status()));

  // Who signed this copy? Local only (codesign), never the network. Then the launch check + daily timer.
  const start = () => {
    ctx.broadcast();
    if (support().enabled) controller!.start();
  };
  if (signature === 'pending' && !ctx.envDryRun && !fakeHome) {
    promisify(execFile)('codesign', ['-dv', '--verbose=2', bundle])
      .then(
        (r) => (signature = signatureKind(`${r.stdout}${r.stderr}`)),
        (e) => (signature = signatureKind(`${e?.stdout ?? ''}${e?.stderr ?? ''}`)),
      )
      .finally(start);
  } else start();

  return { isQuittingForUpdate: () => quittingForUpdate };
}
