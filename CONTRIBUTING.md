# Contributing to Baton

Thanks for helping. Baton touches people's Claude Code folders, so the bar is: **never lose or leak anyone's data**.

## Setup

```bash
npm ci
npm test          # sandboxed tests: every test runs against a fake HOME and aborts if a root points at your real home
npm run typecheck
npm start         # build and run the app
```

Requirements: macOS (Apple silicon), Node.js 22+, Xcode Command Line Tools.

## Ground rules

- **Every write goes through the safety engine** (`electron/safety.ts`): plan → preview → snapshot → journal → apply → verify → rollback. No direct `fs` writes to Claude folders from feature code.
- **Never delete user data.** Unlink symlinks, quarantine into a snapshot, move into the `hidden/` backup, or move to the Trash.
- **Never read or copy credentials.** Only the email and account id from `.claude.json` may be read.
- **Tests use the sandbox.** Add a test in `scripts/test.ts` for every behaviour change; never point a test at the real HOME.
- **No real data in fixtures, screenshots or issues**: no real emails, account/org ids, paths with your user name, or chat titles. `npm run shots` builds screenshots from a fake HOME.
- Keep the wording honest: Baton is for one person's own accounts. Don't add features or copy aimed at sharing accounts or getting around plan limits.

## Pull requests

1. Fork, branch from `main`, keep the change focused.
2. `npm test` and `npm run typecheck` must pass (CI runs both on macOS).
3. Describe what changes on disk, and how it is previewed and undone.
4. Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for every user-visible change (Added / Changed / Fixed / Security / Removed).
5. No AI co-author trailers or "Generated with" lines in commits or PRs.

## Releases

Versioning, the safety gate, and how a release is cut and published are in [RELEASING.md](RELEASING.md).
