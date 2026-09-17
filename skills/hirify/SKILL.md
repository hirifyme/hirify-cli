---
name: hirify
description: Job search through Hirify - vacancies from the user's saved feeds, search across the board, reading a vacancy in full, the contact to apply to, applying on Hirify, and saved searches with delivery. Use when the user asks to find jobs, look at their feeds, pick roles that fit their profile, apply, or set up alerts. Triggers - "find jobs", "what is in my feed", "where do I apply", "apply to this", "hirify".
---

# Hirify job search

Use the Hirify job board through the `hirify` CLI. This file gives the working order; `reference.md`
has every command in full, and `hirify intro` is the server's guide.

## Setup and automation

Package: `hirify-cli`; command: `hirify`; Node >=18. Prefer Node 22 or 24.
Without a global install use `npx -y hirify-cli <command>` (npm may cache it).
Offer `npm install -g hirify-cli` only with permission. Global installs can update automatically;
for reproducible work use an exact version and `HIRIFY_NO_AUTO_UPDATE=1`.

A person runs `hirify login` and confirms the printed link. The CLI tries a browser only when
appropriate. Do not run login for them. `--no-browser` is manual callback login, not device flow.
SSH needs `--callback-port` with a matching SSH local port forward. For agents, CI and containers,
use `HIRIFY_KEY` or pipe a key to `hirify auth --stdin`; never put a key in a command, log or chat.
`hirify auth status --json` identifies the local source. Environment keys override saved access;
logout is local and does not unset them. Use `hirify login --force` to replace expired access.

Fetch mutable facts: `filter guide` for filter names/values, `account show --json` for current
allowances and permissions, `--help` for commands, `capabilities show <id> --json` for inputs,
effects and metering. This file supplies working rules, not a snapshot of server policy.

## Two rules before anything else

**Lists are free. Three commands are metered, and they spend different things.**

- `vacancy read` spends one of the day's vacancy opens. Re-reading a vacancy the same day is free.
- `vacancy reveal` spends 1 reveal, and reveals are scarce. When they run out, reading still works.
- `vacancy apply` counts against a small daily allowance of its own and **cannot be taken back**. It
  sends a real application, with the user's name and profile, to a person who will read it.

**`hirify account show` is the only place these numbers are true.** Read it before spending; never
state what is left from memory or plan a batch on a stale figure.

**Ask the user before every apply, and before anything that changes their account.** Reading needs
no permission. Sending, saving and configuring do.

## Working order

1. `hirify account show` before spending; use `feed list` and `feed show <id>` first.
2. Search when no saved feed fits. Shortlist from cards; missing contacts are normal.
3. `vacancy read <slug>` to assess fit from the full text rather than a headline.
4. `vacancy reveal <slug>` only for vacancies that still fit after reading.
5. Apply only after the person's approval and the rules below.

## Searching

`vacancy search` takes a phrase and server-defined filter options; `--limit` and `--page` control
pagination. Never guess criterion names or values. An empty result can mean a misspelt value.

1. Read `hirify filter guide` and build criteria from the user's request or profile.
2. Run `hirify api call filters.preview --data '{"filters":{...},"mode":"compact","per_page":20}'`.
3. Inspect cards and `meta.total`; refine and preview again if empty, broad or irrelevant.
4. Run `hirify vacancy search` with the validated criteria.

If the guide is unavailable, ask the user about criteria rather than guessing.

## Applying

Two cases, two commands:

- **Hosted on Hirify** -> `hirify vacancy apply <slug>` sends the application through Hirify.
- **From somewhere else** -> `hirify vacancy reveal <slug>` gives the link or contact, and the
  application goes there rather than through Hirify. `vacancy apply` refuses these and says so.
  What you do with that destination is between you and your user.

- **Ask first, every time, and show what you are about to send.** An application cannot be taken
  back. Never apply to a list on a single "yes".
- **Never invent the cover letter.** Draft it from what the user actually said about themselves and
  show them the draft; if they gave you nothing, ask rather than fill the gap.
- **Never choose the profile** when the user has several: `hirify profile list` lists them. With
  exactly one profile it is chosen automatically.
- After a successful apply, say it was sent and stop. Nobody follows up: the recruiter replies where
  they choose to, and Hirify does not track it.

## Saved searches and delivery

These commands change the user's account, so get a yes. Creation leaves delivery off: report that,
offer the exact `feed deliver` command, and run it only after a separate yes.

```bash
hirify feed create "<name>" --filters '<json>'   # criteria: hirify filter guide
hirify feed deliver <id> --telegram | --no-telegram | --webhook <id> | --no-webhook
hirify webhook list
hirify webhook create "<name>" <url>
```

`--filters` uses the site's filter criteria; read `hirify filter guide` first.
Creating a delivery endpoint returns a **secret shown once**: give it to the user immediately to
store, because it signs every delivery and cannot be shown again.

## Feedback and failures

`hirify feedback send <bug|feature> "<title>" --body "<text>" [--vacancy <slug>]` is free.
Ask first and send the user's words. Report the actual received/queued status and retain the
reference; do not promise a reply or a fix. Keep an explicit `--idempotency-key` for deliberate
retries when the server supports it.

Parse `--json` success output, never human text. Use `--error-format=json` for structured stderr
errors; do not combine it with debug if expecting one object. Exit 0 means success, 1 failure,
2 unsupported server manifest, 130/143 interruption. Read the stable error code and message.

- `interaction_required`: ask the person to sign in or configure a key; do not wait on browser login.
- Authentication failure: inspect `auth status`, then ask for `login --force`. Never expose a token.
- 403: permission or plan restriction. 429: pace or a named allowance; inspect `account show`.
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
