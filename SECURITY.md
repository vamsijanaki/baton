# Security policy

Baton runs locally on your Mac and has no server. It manages links and small index files around Claude Code's and the Claude desktop app's folders, and never reads, copies or stores credentials.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on https://github.com/vamsijanaki/baton.

Include what you found, how to reproduce it, and the impact (for example: a path the safety guard should refuse but does not, a way credentials could be read or exposed, or data that could be lost). You should get a reply within a week.

## In scope

- The safety engine (`electron/safety.ts`) allowing a write, delete or overwrite it should refuse.
- Any path where Baton could read, log or export credentials or chat content.
- Launch scripts or environment handling that could make `claude` run as a different account than the one chosen.

## Out of scope

- Issues in Claude Code, the Claude desktop app or Anthropic's services — report those to Anthropic.
- The unsigned/un-notarized build itself (documented; build from source if you prefer).
