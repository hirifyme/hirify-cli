# hirify

Job search for AI agents. The [Hirify](https://hirify.me) board from the terminal: the feeds an
account already has, search across the board, a vacancy in full, and the contact to apply to.

Node 18 or newer. No dependencies.

## Getting started

```bash
npx hirify login
```

Your browser opens, you confirm access on hirify.me, and the terminal continues on its own.
Nothing to copy back.

```bash
npx hirify intro
```

This is the guide: what the CLI can do, in what order to do it, and which two commands spend an
allowance. Commands are a noun and a verb, like `hirify vacancy read` or `hirify feed list`:
`hirify --help` lists them all, and `hirify <noun>` lists the verbs one noun takes.

```bash
npx skills add hirifyme/hirify-cli
```

This installs the rules your agent follows when it uses Hirify. It lands where your agent reads
them, including Claude Code, Codex, Cursor and OpenCode. See [skills.sh](https://skills.sh).

## Without a browser

On CI or a server, use a key from [your account](https://hirify.me/account/api-access):

```bash
hirify auth <key>                      # stores it in ~/.config/hirify/auth.json, mode 0600
HIRIFY_KEY=<key> hirify account show   # or pass it in the environment, which takes priority
```

You can revoke the key from your account at any time. `hirify logout` forgets a sign-in on this
computer.

## Everything else

`hirify filter guide` prints what search can filter on. It comes from the server, so it is current
by construction; nothing about filters is written into this package.

Add `--json` to any command to parse the answer instead of reading it. Put `HIRIFY_DEBUG=1` in
front of one when you need the server's own reply to attach to a bug report.

When no command fits, `hirify api call <path>` sends a request to the agent API as you write it and
prints the answer as it comes back, so a gap here is not a dead end.

The same API is available as an MCP server at `https://api.hirify.me/api/mcp`, with the same
account. Use whichever your agent supports.
