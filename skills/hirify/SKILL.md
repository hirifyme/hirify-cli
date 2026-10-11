---
name: hirify
description: Job search through Hirify - vacancies from the user's saved feeds, search across the board, reading a vacancy in full, the contact to apply to, applying on Hirify, and saved searches with delivery. Use when the user asks to find jobs, look at their feeds, pick roles that fit their profile, apply, or set up alerts. Triggers - "find jobs", "what is in my feed", "where do I apply", "apply to this", "hirify".
---

# Hirify job search

## Start here

Run `hirify intro` once per session, before anything else. It prints the Hirify playbook, the
working method: interviewing your user, setting up the search, going through the results, judging
a vacancy, applying. Hirify keeps it current on the server (it is also at
https://hirify.me/agent-playbook.txt), so follow it rather than any older notes. This file only
covers running the CLI; `reference.md` has every command.

One rule stands regardless: `vacancy apply` sends a real application that cannot be taken back.
Ask your user first, every time, and show what you are about to send.

## Setup and automation

Package: `hirify-cli`; command: `hirify`; Node >=18.
If `hirify` is missing, run `npx -y hirify-cli@latest init`: it installs the CLI and this skill,
then signs in. Until then use `npx -y hirify-cli <command>`. Global installs update themselves,
and this skill with them; pin an exact version with `HIRIFY_NO_AUTO_UPDATE=1`.

To sign in, run `hirify login`; your user confirms access in the browser within five minutes.
It fails at once over SSH, and without a terminal in CI or with no display. `--no-browser` is
manual callback login. SSH needs `--callback-port` with a matching SSH local port forward. Local
agents reuse your user's saved sign-in when permitted to access the same configuration directory.
CI and separate containers can use `HIRIFY_KEY` or `hirify auth --stdin`; never put a key in a
command, log or chat.
`hirify auth status --json` identifies the local source. Environment keys override saved access;
logout is local and does not unset them. Use `hirify login --force` to replace expired access.

## Where current facts live

Fetch mutable facts instead of remembering them: `filter guide` for filter names, values and how
a request becomes a filter; `account show --json` for current allowances and permissions;
`--help` for commands; `capabilities show <id> --json` for inputs, effects and metering.

`vacancy search` takes a phrase and server-defined filter options; `--limit` and `--page` control
pagination. Check a draft with
`hirify api call filters.preview --data '{"filters":{...},"mode":"compact","per_page":20}'`.

Creating a delivery endpoint (`hirify webhook create`) returns a **secret shown once**: give it to
your user immediately to store, because it signs every delivery and cannot be shown again.

## Feedback and failures

`hirify feedback send <bug|feature> "<title>" --body "<text>" [--vacancy <slug>]` is free.
Ask first and send your user's words. Report the actual received/queued status and retain the
reference; do not promise a reply or a fix. Keep an explicit `--idempotency-key` for deliberate
retries when the server supports it.

Parse `--json` success output, never human text. Use `--error-format=json` for structured stderr
errors; do not combine it with debug if expecting one object. Exit 0 means success, 1 failure,
2 unsupported server manifest, 130/143 interruption. Read the stable error code and message.

- `interaction_required`: ask your user to sign in or configure a key; do not wait on browser login.
- Storage access failure: compare `doctor`, `version`, and `auth status` with the normal terminal.
  Request permission for the specific command through the agent's approval mechanism. Reading a
  current token needs read access; renewal needs write access. Do not treat storage errors as an
  expired login, copy credentials into the workspace, broaden Windows ACLs, or disable the sandbox.
  Codex on Windows may use a different account; WSL/containers do not share the Windows home.
- Authentication failure: inspect `auth status`; ask for `login --force` only when renewal requires
  a new sign-in. Never expose a token.
- 403: permission or plan restriction. 429: pace or a named allowance; inspect `account show`.
- `action_required`: stop and show your user the message; it concerns their account.
- Network/TLS/proxy failure: fix connectivity or trust configuration; never disable TLS verification.
- `outcome_unknown`: a metered action or mutation may have succeeded. Check before repeating;
  the CLI does not automatically retry it. Do not blindly repeat apply, reveal or feedback.
- Server validation names the bound or value to correct; use its message rather than inventing one.

`hirify doctor` and `--debug` provide sanitized local diagnostics. Exclude the login URL from reports.

## When no command fits

Read `hirify capabilities list --json`, then `hirify capabilities show <id> --json`.
Prefer a named command where available. Otherwise use
`hirify api call <id> --data-file request.json --json --error-format=json`.
JSON files avoid shell quoting errors; `--data-file -` reads stdin. `--cover-file` does the same for
application text. Use `--` before literal positional values starting with a hyphen.
Generic calls can spend allowances or mutate the account: the same consent rules apply.
