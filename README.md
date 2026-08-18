# hirify

Job search for AI agents. Search [Hirify](https://hirify.me) vacancies, read the feeds you saved on
the site, and get the contact to apply to.

Node 18 or newer. No dependencies.

## Getting started

```bash
npx hirify login
```

Your browser opens, you confirm access on hirify.me, and the terminal continues on its own. Nothing
to copy back.

```bash
npx skills add hirifyme/hirify-cli
```

This installs the rules your agent follows when it uses Hirify: what is free, what costs a reveal,
and in which order to work. It lands where your agent reads it, including Claude Code, Codex, Cursor
and OpenCode. See [skills.sh](https://skills.sh).

## Commands

```bash
hirify me                    # your plan and today's remaining reveals
hirify feeds                 # the feeds you saved on the site
hirify feed <id>             # vacancies from one feed      [--limit N]
hirify search "senior go"    # search vacancies             [--limit N] [--grade G]
hirify reveal <slug>         # where to apply: uses 1 reveal
hirify profiles              # the profiles you can apply with
hirify apply <slug>          # apply on Hirify   [--profile N] [--cover T]
hirify feed create "<name>"  # save a search     [--filters JSON] [--webhook N]
hirify feed delivery <id>    # change how a feed reaches you
hirify webhooks              # your delivery endpoints
hirify feedback <kind> "..." # report a bug or ask for a feature  [--body T]
hirify logout                # sign out on this computer
```

Every command takes `--json` if you want to parse the output instead of reading it.

## Limits

Reading is free and unlimited: `me`, `feeds`, `feed`, `search`, `profiles` and `webhooks`.

`reveal` is the only metered call. It spends 1 of your daily limit and returns the company, its
LinkedIn page and where to send the application. Revealing the same vacancy again is free. The limit
resets at midnight, and `hirify me` always shows what is left.

Pick with reading first and reveal only what fits. The limit is there for people applying to jobs,
not for copying the database.

## Telling us something is broken

```bash
hirify feedback bug "Reveal answers 500 on archived vacancies" --body "What happened, and what you expected."
hirify feedback feature "Filter by salary currency" --body "What you need and why."
```

It goes to the Hirify team under your name and comes back with a ticket number, or with a note that
there is no number yet. A report has no page you can open and nothing writes back to you, so keep
the number if you want to refer to it later. Add `--vacancy <slug>` when it is about one vacancy.
This is free and does not touch your reveal limit.

## Signing in

`hirify login` stores access in `~/.config/hirify/auth.json` with `0600` permissions and renews it
on its own, so you confirm once. `hirify logout` forgets it on this computer.

Where there is no browser, on CI or a server, use a key from
[your account](https://hirify.me/account/api-access):

```bash
hirify auth <key>            # stores it in the same file
HIRIFY_KEY=<key> hirify me   # or pass it in the environment, which takes priority
```

You can revoke the key from your account at any time.

## Troubleshooting

Commands explain problems in plain words. When you need the server's own answer to attach to a
support request, put `HIRIFY_DEBUG=1` in front of the command.

## Applying

`hirify apply <slug>` sends an application through Hirify, using one of your profiles and an
optional cover letter. It works for vacancies hosted on Hirify.

Most vacancies on the board come from elsewhere: company career pages, Telegram channels, other
boards. Those cannot be applied to through us. For them `hirify reveal` brings back the link or the
contact, and you send the application yourself.

An application cannot be recalled, and nothing follows up on it: the recruiter replies where they
choose to.

## Saved searches and delivery

```bash
hirify feed create "Senior Go remote" --filters '{"grade":["senior"]}'
hirify feed delivery 31 --webhook 4
hirify webhooks create "my server" https://example.com/hirify
```

A saved search is the same thing as saving a filter on the site. New matches reach you in Telegram,
at a webhook of yours, or both. Creating a webhook returns a secret once: store it, because it signs
every delivery and is not shown again.

## MCP

The same API is available as an MCP server at `https://api.hirify.me/api/mcp`, with the same
account. Use whichever your agent supports. The CLI is usually cheaper in tokens for agents running
in a terminal.
