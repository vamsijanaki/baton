# Changelog

All notable user-visible changes to Baton are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Baton uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in [RELEASING.md](RELEASING.md).

Every pull request with a user-visible change adds a line under **Unreleased** (Added / Changed / Fixed / Security / Removed).

## [Unreleased]

## [1.0.1] - 2026-10-25

### Changed

- Turning passive usage capture on or off now opens the standard preview showing the exact `statusLine` change, and
  can be undone from History like every other change. If an account already has its own status line, Baton asks
  before replacing it and puts it back exactly when you turn capture off.

### Security

- Passive usage capture no longer edits `settings.json` outside the safety engine: both directions get a verified
  snapshot, a journal entry, an atomic write, verification and automatic rollback. Only the `statusLine` key changes,
  a file that is not valid JSON is refused, and `~/.claude/settings.json` is the guard list's only exception inside
  `~/.claude`, allowed for these operations alone.

## [1.0.0] - 2026-10-25

First public release. A Mac app (Apple silicon) for one person using more than one of their own Claude Code accounts.

### Added

- **Accounts.** Account 1 is your existing `~/.claude` (read, never written). Each extra account gets its own
  `~/.claude-<name>` config folder used through Claude Code's `CLAUDE_CONFIG_DIR`; you sign in once with
  `claude auth login`. Each account card pairs the account's Terminal side with the desktop app(s) signed in as the
  same email, with Personal / Work detected from non-secret `.claude.json` fields only.
- **One history, per-project sharing.** Transcripts stay in `~/.claude/projects`. Nothing is shared by default;
  sharing a project with an account adds one symlink into that account's `projects/` folder. Turning an account off
  removes the link and hides that project's chats from the account's desktop apps (moved into `~/.baton/hidden/`);
  turning it back on restores them. Credentials, settings and prompt history always stay per account.
- **A desktop app per account.** Each extra account gets its own APFS clone of Claude.app with a tinted Finder icon
  and its own data folder, so accounts can be open side by side; clones are rebuilt when Claude.app updates.
  Shared projects keep their Code-tab chat lists in step across the chosen accounts' apps.
- **Merge & tidy up.** When two or more desktop apps are signed in as the same account, Baton copies any missing
  Code-tab entries into the kept app (copy-only, never overwrite) and removes the extra app's launcher; its data
  folder goes to the Trash only if you tick that.
- **Adopt.** An existing `Claude-<Name>` desktop data folder found on the Mac can be adopted: Baton builds its own
  app copy for it and keeps the sign-in and chats in place.
- **Menu-bar popover.** Pick a project, continue it in Terminal or open the desktop app as any allowed account,
  see usage, and jump to Doctor or History; light and dark.
- **Usage meters.** The 5-hour and weekly percentages Claude Code's own `/usage` reports, per account, refreshed on
  open and on Refresh (at most once per 15 minutes per account, never in a background loop). Optional per-account
  status-line capture touches only that account's `statusLine` setting and is undoable. Informational only.
- **Safety engine.** Every change is planned, shown as an exact file-operation preview, then: running-app check,
  snapshot, snapshot verification, journal, step-by-step apply, verification and automatic rollback on failure.
  A hard guard refuses writes to `~/.claude`, deleting or overwriting transcripts, touching `/Applications/Claude.app`,
  and anything in a desktop data folder other than its Code-tab index files. Nothing is deleted: items are unlinked
  (symlinks only), quarantined in a snapshot, moved to the hidden backup, or moved to the Trash.
- **One writer at a time.** Before opening anything, Baton checks for running `claude` processes and warns if another
  account is still working in the same project.
- **Fair-use guardrails.** Each account must be confirmed as yours and used only by you; a second Personal plan needs
  an explicit "not to get around usage limits" confirmation; sharing into or out of a Work account shows a policy
  note; an account Claude Code reports as suspended is marked Suspended and its projects can't be continued elsewhere.
  Full text in `FAIR-USE.md` and in the app.
- **Doctor.** Checks links, sync, app copies, disk space, interrupted operations and snapshot integrity (a deep check
  re-verifies every snapshot); every fix goes through the same preview and snapshot path.
- **History & restore.** Every operation with its status and snapshot, one-click Undo, a Restore center that compares
  any snapshot with what's on disk and restores the paths you pick, and an activity log. Undo and restore are previewed and snapshotted too.
- Keyboard shortcuts (`⌘↩`, `⌘F`, `⌘1…9`, `⌘P`, `⌘N`, `⌘R`, `⌘/`), onboarding, and redacted diagnostics export.
- Existing installs from the previous name ("Claude Switch") keep using `~/.claude-switch` and their app copies as is.

### Security

- Releases are signed with a Developer ID (hardened runtime) and notarized by Apple; the DMG is signed, notarized
  and stapled, and every release ships `SHA256SUMS.txt`.
- Never reads tokens or the Keychain, never modifies Claude Code or Claude.app, no servers, no telemetry. Inherited
  `CLAUDE_*` / `ANTHROPIC_*` variables are cleared at start-up so each `claude` runs as exactly the chosen account.

[Unreleased]: https://github.com/vamsijanaki/baton/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/vamsijanaki/baton/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/vamsijanaki/baton/releases/tag/v1.0.0
