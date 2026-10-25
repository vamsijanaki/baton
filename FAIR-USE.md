# Fair use

Baton is for **one person** using **their own** Claude accounts on **their own Mac** — for example a personal account and the account your employer gave you — so you can keep the right work on the right account and still continue your own project's history. It is not a way around usage limits, bans or sharing rules.

> **Not legal advice.** Baton is an independent open-source project and is **not affiliated with, endorsed by or supported by Anthropic**. Anthropic's own pages (linked below) are what count; read them.

## Do

- **One person, your own accounts.** Use Baton by yourself, with Claude accounts that belong to you.
- **Right account for the right work.** Personal projects on your personal account; employer work on the account your organization provides.
- **Follow your employer's policy.** Organization-provided accounts may be linked to the organization, and its admin may be able to monitor and control them, including content. Company code and data may not be allowed in a personal account.

## Don't

- **Share accounts.** Don't give your login to anyone or make your account available to anyone else — through Baton or otherwise.
- **Buy several personal plans to rotate past limits.** Pro and Max usage limits assume ordinary, individual use. Creating or coordinating several accounts to keep working past their limits may be treated as circumventing restrictions and risks suspension.
- **Continue with another account after a ban.** If an account is suspended or banned, using a different account to carry on violates the Usage Policy. Appeal through [Anthropic support](https://support.anthropic.com) instead.
- **Resell or proxy access.** Don't offer your plan to other people or route their requests through your subscription.
- **Modify Claude Code.** Baton runs the official, unmodified `claude` CLI and Claude desktop app, signed in by you through their own sign-in flows.

## What Baton does to help

| Guardrail | How it works |
|---|---|
| Account kind | Each account is *Personal (Free/Pro/Max)* or *Work/Team/Enterprise (organization-provided)*. Detected from non-secret fields only — `subscriptionType` printed by `claude auth status`, and `organizationType` / `billingType` in `.claude.json`'s `oauthAccount`. Never tokens, credentials or the Keychain. When nothing clearly says, Baton asks. |
| Ownership attestation | Adding an account — or first using an existing one — requires ticking **"This account is mine, and only I use it."** The time is stored in Baton's state. |
| Second Personal plan | Adding (or confirming) a second Personal account shows why rotating personal plans is risky, lists legitimate reasons, and requires **"I'm not using this to get around usage limits."** |
| No limit-dodging | Usage meters are informational. Baton sends no limit notifications, never suggests "continue in another account" when one runs low, and never rotates accounts automatically. |
| Usage checks | Only when Baton opens and when you press Refresh; at most once per 15 minutes per account; never a background polling loop. |
| Work accounts | Sharing a project into a Work account notes that your organization's admin may be able to see those chats. Sharing a project from a Work account into a Personal one notes it may move your employer's code/data — check your company's policy. |
| Suspended accounts | When Claude Code clearly reports that an account is suspended or disabled, Baton marks it **Suspended** and refuses to continue its projects in another account, with a link to Anthropic support to appeal. The mark clears itself when a later check reads the account's limits normally. |
| Single person | No export or sync of sessions to other people or machines. History stays on this Mac. |

## Official pages

- Anthropic **Usage Policy** — <https://www.anthropic.com/legal/aup> ("Do Not Abuse Our Platform")
- Anthropic **Consumer Terms of Service** — <https://www.anthropic.com/legal/consumer-terms>
- **Claude Code legal and compliance** — <https://code.claude.com/docs/en/legal-and-compliance>
