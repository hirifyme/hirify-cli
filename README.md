# hirify

Job search for AI agents. The [Hirify](https://hirify.me) board from the terminal: the feeds an
account already has, search across the board, a vacancy in full, and the contact to apply to.

Node 18 or newer. No dependencies.

Install it globally with `npm install -g hirify-cli`, or run it without installing through `npx`
as shown below. In either case, the command is `hirify` after a global install.

## Getting started

```bash
npx hirify-cli login
```

Your browser opens, you confirm access on hirify.me, and the terminal continues on its own.
Nothing to copy back.

```bash
npx hirify-cli intro
```

This is the guide: what the CLI can do, in what order to do it, and which three commands use an
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

`hirify filter guide` explains how to turn a request into a search filter and which criteria and
values are available. It comes from the server, so it stays current as search changes. The guide
requires a compact preview before the final search, so the agent can correct an empty or irrelevant
filter before relying on it.

Add `--json` to any command for the server's answer as JSON instead of the text a person reads.
`--fields a,b` narrows a compact answer to the fields you name. Put `HIRIFY_DEBUG=1` in front of a
command when you need the server's own reply to attach to a bug report.

When no command fits, `hirify api call <capability>` invokes any capability Hirify lists in its
manifest and prints the answer, so a gap here is a detour, not a dead end. Inputs go in `--data` as a
JSON object; `--json` gives the raw answer.

The same API is available as an MCP server at `https://api.hirify.me/api/mcp`, with the same
account. Use whichever your agent supports.
