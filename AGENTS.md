# Notes for AI coding agents

Baton is an Electron Mac app that manages a person's Claude Code folders. The bar: **never lose or leak anyone's data**.
Read [CONTRIBUTING.md](CONTRIBUTING.md) and [RELEASING.md](RELEASING.md); the rules below are the short version.

- **Commits / PRs**: author and committer `vamsijanaki <79586079+vamsijanaki@users.noreply.github.com>`.
  Never add `Co-Authored-By` trailers for an AI, "Generated with …" lines, or any Claude/Anthropic/AI attribution
  to commits, tags, PR titles or PR bodies.
- **Changelog**: every user-visible change adds one line under `## [Unreleased]` in `CHANGELOG.md`
  (Added / Changed / Fixed / Security / Removed) in the same change.
- **Gate**: `npm run typecheck` and `npm test` must pass. Changes to `electron/safety.ts`, sharing, desktop apps or
  migrations need a new sandbox test in `scripts/test.ts`.
- **Safety**: all writes go through the safety engine; never add an operation that deletes data; never read
  credentials; never run anything against the real HOME except the read-only `npm run check:real`.
- **Releases**: don't create tags, releases or version bumps unless asked. When asked, use
  `npm run release -- <patch|minor|major|x.y.z>`, then `npm run release:build` (signed + notarized, this Mac only)
  and `npm run release:publish`; never publish an ad-hoc build; never delete or move a pushed tag; never change repo
  visibility; never print or read keychain secrets.
- **Website** (`site/`) deploys manually with `npx wrangler deploy`; the release workflow does not touch it.
