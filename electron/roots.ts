// Every filesystem root Baton's safety-critical code uses, in ONE overridable place.
// Tests point all of them at a sandbox fake HOME (setRoots) — nothing there may fall back to os.homedir().
//
// Compatibility with installs made under the app's old name ("Claude Switch"): when an old folder
// exists it keeps being used, as is. Nothing is ever moved, renamed or deleted automatically;
// only brand-new installs use the new names.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Roots {
  home: string;
  support: string; // ~/Library/Application Support
  appDir: string; // ~/.baton (or ~/.baton on installs that already have it)
  appsDir: string; // desktop app copies: ~/Library/Application Support/Baton/apps (or claude-switch/apps)
  claudeApp: string; // /Applications/Claude.app
}

export const APP_DIR_NAME = '.baton';
export const LEGACY_APP_DIR_NAME = '.claude-switch';
export const APPS_PARENT = 'Baton';
export const LEGACY_APPS_PARENT = 'claude-switch';
/** A desktop profile's stored icon color, inside its data folder (Baton's own file; absent → default color). */
export const COLOR_FILE = '.baton-color';
export const USER_DATA_NAME = 'Baton';
export const LEGACY_USER_DATA_NAME = 'Claude Switch';

/** State folder: the old ~/.baton when it exists (kept in place), else ~/.baton. */
export function resolveAppDir(home: string): string {
  const legacy = path.join(home, LEGACY_APP_DIR_NAME);
  return fs.existsSync(legacy) ? legacy : path.join(home, APP_DIR_NAME);
}
/** Desktop app copies: the old <support>/claude-switch/apps when that folder exists, else <support>/Baton/apps. */
export function resolveAppsDir(support: string): string {
  return fs.existsSync(path.join(support, LEGACY_APPS_PARENT)) ? path.join(support, LEGACY_APPS_PARENT, 'apps') : path.join(support, APPS_PARENT, 'apps');
}
/** Electron userData: the old "Claude Switch" folder when it exists (keeps window/appearance prefs), else "Baton". */
export function resolveUserData(support: string): string {
  const legacy = path.join(support, LEGACY_USER_DATA_NAME);
  return fs.existsSync(legacy) ? legacy : path.join(support, USER_DATA_NAME);
}

let R: Roots = make(os.homedir());

function make(home: string, claudeApp = '/Applications/Claude.app'): Roots {
  const support = path.join(home, 'Library', 'Application Support');
  return { home, support, appDir: resolveAppDir(home), appsDir: resolveAppsDir(support), claudeApp };
}

export const roots = () => R;
/** Tests only. */
export function setRoots(home: string, claudeApp?: string) {
  R = make(home, claudeApp);
}

export const defaultDir = () => path.join(R.home, '.claude'); // account 1, never written
export const sharedProjects = () => path.join(defaultDir(), 'projects'); // canonical transcript store
export const snapshotsDir = () => path.join(R.appDir, 'snapshots');
export const journalDir = () => path.join(R.appDir, 'journal');
export const sharingFile = () => path.join(R.appDir, 'sharing.json');
export const syncStateFile = () => path.join(R.appDir, 'sync-state.json');
export const settingsFile = () => path.join(R.appDir, 'settings.json');
export const legacyLinksFile = () => path.join(R.appDir, 'desktop-links.json');
export const legacyStore = () => path.join(R.appDir, 'desktop-sessions');
export const desktopRegistry = () => path.join(R.appDir, 'desktop-profiles.json');
export const activityLog = () => path.join(R.appDir, 'launch.log');
/** Sidebar entries hidden from an account's desktop apps when it loses access to a project (moved here, never deleted). */
export const hiddenDir = () => path.join(R.appDir, 'hidden');

/** Claude Code's folder naming: every non-alphanumeric char becomes '-'. */
export const encodeProject = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');

// Read-only mode (used by the real-machine checks): every write path in the safety engine throws.
let RO = false;
export const readOnly = () => RO;
export function setReadOnly(v: boolean) {
  RO = v;
}
