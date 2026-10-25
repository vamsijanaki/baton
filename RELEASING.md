# Releasing Baton

Project rules for versions, the changelog and shipping a build. They apply to people and to AI coding agents alike
(agents: see also [AGENTS.md](AGENTS.md)).

## Versioning (SemVer, as it applies to Baton)

Versions are `MAJOR.MINOR.PATCH`, tagged `vX.Y.Z`. `package.json` is the single source of the version.

| Bump | When |
|---|---|
| **patch** `1.0.x` | Bug fixes, wording, performance — nothing new for the user to learn, nothing different on disk. |
| **minor** `1.x.0` | New features or new screens/options, still reading and writing the same on-disk layout. |
| **major** `x.0.0` | Anything that changes **what is on disk or how it is laid out**: Baton's state/journal/snapshot formats, the shape of `~/.baton`, the symlink or hidden-backup layout, how desktop app copies or data folders are arranged, a migration that rewrites existing data, or removing a feature people rely on. |

When unsure between two levels, take the higher one.

## Changelog rule

[CHANGELOG.md](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

- **Every user-visible change adds a line under `## [Unreleased]` in the same PR**, under one of
  `### Added`, `### Changed`, `### Fixed`, `### Security`, `### Removed` (add the heading if it isn't there).
- Write for users: what they will notice, not the implementation. One line per change.
- Internal-only changes (tests, CI, refactors with no visible effect) need no entry.
- Never edit a released section except to fix a typo. `npm run release` moves Unreleased into the new version.

## Safety gate (before any release)

Baton manages people's Claude folders. A release must not lose or leak data.

1. `npm test` and `npm run typecheck` are green (the release script and the workflow both enforce this).
2. Any change to `electron/safety.ts`, sharing (`electron/sharing.ts`), desktop apps (`electron/desktop.ts`,
   `electron/apps.ts`) or a migration path has a **new sandbox test** in `scripts/test.ts` covering it.
3. **Never ship an operation that deletes data.** Unlink symlinks, quarantine into a snapshot, move into the hidden
   backup, or move to the Trash — nothing else.
4. Checks against a real home folder are **read-only** and only via `npm run check:real`. Never point tests or
   scripts at the real HOME.

## Cutting a release

Releases are built **on the maintainer's Mac**, signed with the Developer ID
`Developer ID Application: Vamsi Krishna Janaki (D9S4VXPF9P)` and notarized by Apple. Prerequisites on that Mac:
the identity in the login keychain and a notarytool keychain profile named `baton-notary`
(`xcrun notarytool store-credentials baton-notary --apple-id … --team-id D9S4VXPF9P`), and `gh` logged in.

```bash
git checkout main && git pull
npm run release -- patch        # or minor | major | 1.2.3
git push origin main && git push origin vX.Y.Z
npm run release:build           # signed + notarized + stapled build, verified
npm run release:publish         # GitHub Release for vX.Y.Z with the CHANGELOG notes + assets
```

1. **`npm run release`** (`scripts/release.mjs`) refuses if the tree is dirty, you're not on `main`, the tag exists,
   `Unreleased` is empty, or typecheck/tests fail. It bumps `package.json` + `package-lock.json`, moves `Unreleased`
   into `## [X.Y.Z] - YYYY-MM-DD`, commits `Release vX.Y.Z` with your configured git author, creates the annotated
   tag, and prints the push command (`--push` pushes too). To back out before pushing:
   `git tag -d vX.Y.Z && git reset --hard HEAD~1`.
2. **Push** main and the tag. The tag push runs the fallback workflow as a build check only; it does not publish
   (see below).
3. **`npm run release:build`**: tests, build, then `scripts/dist.mjs --require-signed` runs electron-builder with
   `APPLE_KEYCHAIN_PROFILE=baton-notary` — the app, its Electron helpers and `Resources/baton-desktop-helper` are
   signed (hardened runtime, timestamp, `build/entitlements.mac.plist`), the app is notarized and stapled, and the
   DMG is signed. `scripts/release-artifacts.mjs --require-notarized` then notarizes and staples the DMG, verifies
   (`codesign --verify --deep --strict`, `spctl -t exec` must say `source=Notarized Developer ID`,
   `stapler validate` on app and DMG, `spctl -t open` on the DMG), and writes `Baton-X.Y.Z-arm64.dmg` and
   `SHA256SUMS.txt` into `release/`. Any failure stops the release.
4. **`npm run release:publish`** (`scripts/release-publish.mjs`) refuses unless HEAD is the pushed tag and
   `release/` holds this version's files, then creates the GitHub Release (or replaces the notes and assets of an
   existing one) with `Baton-arm64.dmg`, `Baton-X.Y.Z-arm64.dmg`, `Baton-X.Y.Z-arm64-mac.zip`, `SHA256SUMS.txt`.
5. **Verify the download**: <https://trybaton.app/download> (and
   <https://github.com/vamsijanaki/baton/releases/latest/download/Baton-arm64.dmg>) serves the new DMG; open it on a
   Mac — it must open with no Gatekeeper warning — check the version in About, and `shasum -a 256 -c SHA256SUMS.txt`.
6. **Website**: if `site/` changed, redeploy it by hand from the repo root: `npx wrangler deploy` (Cloudflare,
   config in `wrangler.jsonc`). Nothing deploys the site automatically.
7. **Announce** in GitHub Discussions with the changelog section.

`npm run dist` is the everyday build: signed (not notarized) when the Developer ID is on the Mac, otherwise ad-hoc.
`BATON_UNSIGNED=1 npm run dist` forces the ad-hoc build. Ad-hoc builds are for local use only — never publish one.

### Fallback: the GitHub workflow

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds a tag on macOS arm64 (typecheck, tests,
`npm run dist`, checksums). Without signing secrets the build is **ad-hoc and not notarized**, so:

- on a **tag push** it only builds as a check and publishes nothing (unless signing secrets are set);
- **Actions → Release → Run workflow** with a tag publishes that build; if the release already exists (e.g. the
  signed local one) it refuses unless `replace_existing` is ticked.

Use it only when the Mac path is unavailable. Optional secrets, documented in the workflow: `CSC_LINK`,
`CSC_KEY_PASSWORD` (Developer ID .p12), `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (notarization).
The CI signing path has never run — check its first output by hand.

## Hotfixes and rollback

- **Hotfix**: fix on `main` (with its changelog line under `### Fixed`), then `npm run release -- patch`.
- **Yank a bad release**: never delete a published tag or release. Edit the bad release and mark it
  **pre-release** (so `releases/latest` falls back to the previous one), or mark the previous good release as
  **Latest**, and add a warning at the top of the bad release's notes. Then ship a patch with the fix.
- Tags are immutable: never move or re-push a tag that has been pushed. A fix always gets a new version.

## Commit hygiene

- Author and committer: `vamsijanaki <79586079+vamsijanaki@users.noreply.github.com>`.
- **No AI co-author trailers** (`Co-Authored-By: Claude …` or similar) and **no "Generated with …" lines** in
  commits, tags, PR titles or PR descriptions.
- Release commits are exactly `Release vX.Y.Z`, made by `npm run release`.
