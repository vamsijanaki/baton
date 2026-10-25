export interface Account {
  id: string;
  name: string;
  slug: string | null;
  configDir: string;
  color: string;
  limitNote?: string;
  limitResetAt?: string | null;
  email: string | null;
  signedIn: boolean;
  isDefault: boolean;
  links: { name: string; ok: boolean; target: string | null }[];
}
export interface Proc {
  pid: number;
  tty: string | null;
  cwd: string | null;
  configDir: string | null;
  email: string | null;
  source: 'terminal' | 'desktop' | 'background';
  accountId: string | null;
  profile: string | null;
  appPath: string | null;
}
export interface Lock { account: string; project: string; pid: number | null; since: string; sessionId?: string | null }
export interface Snapshot {
  state: { accounts: unknown[]; recentProjects: string[]; selectedAccount: string; project: string; dryRun: boolean };
  accounts: Account[];
  lock: Lock | null;
  running: Proc[];
  dryRun: boolean;
  envDryRun: boolean;
  paths: { shared: string; launchLog: string };
  theme: 'dark' | 'light';
  usage: Record<string, Usage>;
  fairUse: Record<string, FairUseInfo>;
  links: { aup: string; consumerTerms: string; claudeCodeLegal: string; support: string };
  activeAccountId: string;
  projectSharing: Record<string, TermState>;
  /** Account id → its desktop-app chats in the current project (from the apps' sidebar lists). */
  projectDesktop?: Record<string, { chats: number; apps: string[] }>;
  sharedProjects: string[];
  onboarded: boolean;
  home: string;
}
export type AccountKind = 'personal' | 'work';
export interface FairUseInfo {
  kind: AccountKind | null;
  kindSource: 'detected' | 'user' | null;
  kindHint: string | null;
  attestedAt: string | null;
  limitsAckAt: string | null;
  needsLimitsAck: boolean;
  personalBefore: boolean;
  problem: { code: 'attest' | 'kind' | 'limits'; message: string } | null;
  suspended: { at: string; reason: string } | null;
}
export interface AttestInput { kind?: AccountKind | null; attested?: boolean; notLimitDodging?: boolean }
export type LaunchBlocked =
  | { status: 'fairuse'; accountId: string; problem: NonNullable<FairUseInfo['problem']> }
  | { status: 'suspended'; accountId: string; owners: string[]; message: string; support: string };
export interface UsageWindow { pct: number; resetsAt: number | null; resetText?: string }
export interface Usage {
  has: boolean;
  probing: boolean;
  hook: boolean;
  source?: 'usage-command' | 'statusline';
  capturedAt?: number;
  probeAt?: number | null;
  passiveAt?: number | null;
  fiveHour?: UsageWindow | null;
  sevenDay?: UsageWindow | null;
  extra?: { label: string; pct: number; resetsAt: number | null }[];
  error?: string;
  auth?: {
    checkedAt: number;
    loggedIn: boolean;
    email: string | null;
    orgName: string | null;
    subscription: string | null;
    error?: string;
    usageAccountTail: string | null;
    usageFetchedAt: number | null;
  } | null;
}
export interface DesktopProfile {
  id: string;
  name: string;
  dataDir: string;
  appPath: string | null;
  cloneSource: 'claude-switch' | 'system' | null;
  cloneVersion: string | null;
  needsUpdate: boolean;
  color: string;
  origin: 'default' | 'claude-switch' | 'other';
  autoLink: boolean;
  running: boolean;
  pid: number | null;
  signedIn: boolean;
  codeReady: boolean;
  folders: { rel: string; accountUuid: string; email: string | null; linked: boolean; sessions: number }[];
  linked: 'all' | 'some' | 'none';
}
export interface DesktopData { profiles: DesktopProfile[]; clones: string; claudeVersion: string | null; colors: string[] }
export type TermState = 'shared' | 'private' | 'legacy-all' | 'wrong-link' | 'private-history' | 'no-folder';
export interface OpPreview { title: string; kind: string; lines: string[]; refused: string[]; busy: string[]; touches: string[]; notes: string[] }
export interface OpPlan { token: string; preview: OpPreview; summary: any; steps: number; quittable?: { pid: number; name: string; appPath: string; dataDir: string }[] }
export type OpResult = { status: 'done'; journalId: string; snapshotId: string; summary: any } | { status: 'busy'; busy: string[] } | { status: 'nothing' };
export interface HistoryItem {
  id: string; kind: string; title: string; createdAt: string; finishedAt?: string;
  status: 'applying' | 'done' | 'rolled-back' | 'failed-rollback';
  steps: string[]; error?: string; rollbackLog?: string[]; notes?: string[]; undoneBy?: string; undoOf?: string; snapshotId: string;
}
export interface SnapshotInfo { id: string; op: string; title: string; createdAt: string; category: 'op' | 'sync'; pinned: boolean; roots: string[]; verified: boolean; bytes: number; quarantined: number; entryCount: number }
export interface RestoreItem { path: string; snapType: 'absent' | 'file' | 'dir' | 'symlink'; current: 'same' | 'different' | 'missing' | 'extra' }
export interface DoctorCheck { id: string; level: 'ok' | 'info' | 'warn' | 'error'; title: string; detail: string; fix?: { kind: string; label: string; args?: unknown } }
export interface Settings { retention: number; syncEnabled: boolean; onboarded: boolean; sameAccountSync: boolean }
export interface AppInfo {
  id: string;
  name: string;
  dataDir: string;
  isDefault: boolean;
  running: boolean;
  signedIn: boolean;
  sessions: number;
  color: string;
  needsUpdate: boolean;
  cloneVersion: string | null;
  cloneSource: 'claude-switch' | 'system' | null;
  origin: 'default' | 'claude-switch' | 'other';
  accountUuid: string | null;
}
export interface AccountCard {
  key: string;
  name: string;
  email: string | null;
  accountUuid: string | null;
  color: string;
  terminal: { id: string; configDir: string; signedIn: boolean; isDefault: boolean } | null;
  apps: AppInfo[];
  kept: string | null;
  extras: string[];
  waiting: AppInfo[];
}
export interface Leftover { key: string; profile: string; profileName: string; accountUuid: string; email: string | null; sessions: number }
export interface AccountsOverview {
  accounts: AccountCard[];
  unpaired: AppInfo[];
  leftovers: Leftover[];
  retired: (AppInfo & { into: string; at: string })[];
  sameAccountSync: boolean;
  offer: { copies: number; deferred: number } | null;
  claudeVersion: string | null;
  clones: string;
  colors: string[];
}
export interface MergeSummary {
  email: string | null;
  keep: { id: string; name: string; sessions: number };
  remove: { id: string; name: string; sessions: number; copies: number; alreadyThere: number; dataDir: string }[];
  copies: number;
  alreadyThere: number;
  trashData: boolean;
}
export interface SharingInfo {
  config: { version: 1; projects: { path: string; accounts: string[]; desktop: string[]; auto?: boolean }[] };
  candidates: string[];
  counts: Record<string, number>;
  terminal: { id: string; name: string; color: string; configDir: string; legacyAll: boolean }[];
  states: Record<string, Record<string, TermState>>;
  folders: { key: string; profile: string; profileName: string; accountUuid: string; orgUuid: string; dir: string; isLink: boolean; sessions: number; email: string | null; running: boolean; leftover: boolean; owned: boolean }[];
  desktopCounts: Record<string, Record<string, number>>;
  account1: string;
  store: string;
  people: { id: string; name: string; color: string; email: string | null; isDefault: boolean; apps: string[]; legacyAll: boolean }[];
  derived: Record<string, string[]>;
  since: Record<string, { since: string; kind: string; title: string } | null>;
  hideImpact: Record<string, Record<string, { count: number; apps: string[] }>>;
  hiddenNow: Record<string, Record<string, { count: number; apps: string[] }>>;
}
export interface MigrationSummary {
  shareProjects: string[];
  accounts: { name: string; from: string; to: string; hiddenProjects: number }[];
  desktop: { legacyRecords: number; liveLinks: number; staleRecords: number; participants: string[]; copies: number; deferred: number; legacyStoreFiles: number };
  unchanged: string[];
  needed: boolean;
}
export interface Session { id: string; title: string; mtime: number; size: number; gitBranch: string | null; parentId?: string | null; desktopFrom?: { account: string; app: string }[] }
export type LaunchResult = { status: 'conflict'; conflicts: Proc[] } | { status: 'launched'; command: string; dryRun: boolean } | LaunchBlocked;

declare global {
  interface Window {
    cs: {
      snapshot(): Promise<Snapshot>;
      sessions(project: string): Promise<{ dir: string; sessions: Session[] }>;
      knownProjects(): Promise<{ path: string; mtime: number; count: number }[]>;
      signIn(id: string): Promise<string>;
      updateAccount(id: string, patch: Partial<Account>): Promise<void>;
      select(p: { account?: string; project?: string }): Promise<void>;
      forgetProject(p: string): Promise<void>;
      chooseProject(): Promise<string | null>;
      preview(o: { accountId: string; project: string; resume?: string | null; continueLast?: boolean }): Promise<string>;
      launch(o: { accountId: string; project: string; resume?: string | null; continueLast?: boolean; force?: boolean }): Promise<LaunchResult>;
      showProcess(pid: number): Promise<boolean>;
      terminateProcess(pid: number): Promise<boolean>;
      setDryRun(v: boolean): Promise<void>;
      usageRefresh(id: string): Promise<{ throttled?: { nextAt: number; reason: string }; error?: string; suspended?: string | null }>;
      fairUseConfirm(id: string, input: AttestInput): Promise<FairUseInfo>;
      fairUseAttestAll(attested: boolean): Promise<void>;
      usageHookInfo(id: string): Promise<{ installed: boolean; foreign: boolean; current: unknown; settingsFile: string }>;
      openUsage(id: string): Promise<string>;
      desktopProfiles(): Promise<DesktopData>;
      accountsOverview(): Promise<AccountsOverview>;
      desktopOpen(id: string): Promise<{ opened: boolean }>;
      opPlan(kind: string, args?: unknown): Promise<OpPlan>;
      opApply(token: string): Promise<OpResult>;
      opQuitApply(token: string): Promise<OpResult>;
      opCancel(token: string): Promise<void>;
      history(): Promise<HistoryItem[]>;
      snapshots(): Promise<SnapshotInfo[]>;
      snapshotDiff(id: string): Promise<RestoreItem[]>;
      snapshotVerify(id: string): Promise<{ ok: boolean; problems: string[] }>;
      revealSnapshot(id: string): Promise<void>;
      sharingInfo(): Promise<SharingInfo>;
      migrationPreview(): Promise<{ summary: MigrationSummary; preview: OpPreview }>;
      doctor(deep?: boolean): Promise<DoctorCheck[]>;
      recover(): Promise<number>;
      settingsGet(): Promise<Settings>;
      settingsSet(p: Partial<Settings>): Promise<Settings>;
      about(): Promise<{ version: string; electron: string; node: string; macos: string; claude: string | null; appDir: string }>;
      activity(n?: number): Promise<string[]>;
      exportDiagnostics(): Promise<string | null>;
      reveal(p: string): Promise<void>;
      openLog(): Promise<void>;
      clearLock(): Promise<void>;
      on(ch: 'changed' | 'route' | 'conflict' | 'launchBlocked', fn: (p: any) => void): () => void;
    };
  }
}
