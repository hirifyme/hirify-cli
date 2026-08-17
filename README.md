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
hirify logout                # sign out on this computer
```

Every command takes `--json` if you want to parse the output instead of reading it.

## Limits

Reading is free and unlimited: `me`, `feeds`, `feed` and `search`.

`reveal` is the only metered call. It spends 1 of your daily limit and returns the company, its
LinkedIn page and where to send the application. Revealing the same vacancy again is free. The limit
resets at midnight, and `hirify me` always shows what is left.

Pick with reading first and reveal only what fits. The limit is there for people applying to jobs,
not for copying the database.

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

## There is no apply endpoint

Hirify does not send applications for you, and the API has no call for it. The CLI brings back the
link and the contact; a person sends the application.

## MCP

The same API is available as an MCP server at `https://api.hirify.me/api/mcp`, with the same
account. Use whichever your agent supports. The CLI is usually cheaper in tokens for agents running
in a terminal.
