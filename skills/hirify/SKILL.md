---
name: hirify
description: Job search through Hirify - vacancies from the user's saved feeds, search across the board, reading a vacancy in full, the contact to apply to, applying on Hirify, and saved searches with delivery. Use when the user asks to find jobs, look at their feeds, pick roles that fit their profile, apply, or set up alerts. Triggers - "find jobs", "what is in my feed", "where do I apply", "apply to this", "hirify".
---

# Hirify job search

You work with the Hirify job board through the `hirify` CLI. This file is the working order and the
rules that do not change; `reference.md` beside it has every command in full, and `hirify intro` is
the server's own guide. This file is what to do and in what order.

Commands are a noun and a verb: `hirify vacancy read`, `hirify feed list`. A noun on its own lists
its verbs, and `hirify --help` lists them all.

## What stays here, and what you fetch

This file is installed once and sits unchanged while Hirify keeps shipping, so it holds only what
stays true. Anything Hirify can change is fetched, never written here:

| What you need | Ask for it |
|---|---|
| Filter names and their values | `hirify filter guide` |
| Reveals, vacancy opens and applies left | `hirify account show` |
| Rate limits, plan, abilities | `hirify account show --json` |
| The commands that exist | `hirify --help`, `hirify <noun>` |

A number or filter name written here goes stale on a deploy; name the command that answers it.

## Two rules before anything else

**Lists are free. Three commands are metered, and they spend different things.**

- `vacancy read` spends one of the day's vacancy opens. The allowance is generous, it is the same
  one a browser uses, and re-reading a vacancy the same day is free. Read freely.
- `vacancy reveal` spends 1 reveal, and reveals are scarce. When they run out, reading still works.
- `vacancy apply` counts against a small daily allowance of its own and **cannot be taken back**. It
  sends a real application, with the user's name and profile, to a person who will read it.

**`hirify account show` is the only place these numbers are true.** Read it before you spend, and
read it again rather than carrying a figure from one answer to the next: all three move while you
work, and two are shared with what the user does on the site. Never state what is left from memory,
and never plan a batch on a number you are not currently looking at.

**Ask the user before every apply, and before anything that changes their account.** Reading needs
no permission. Sending, saving and configuring do.

## Working order

```bash
hirify account show                  # plan and remaining reveals: start here
hirify feed list                     # the user's saved feeds, which are their own filters
hirify feed show <id>                # vacancies from a feed: the best source
hirify vacancy search "senior go"    # when no feed fits, plus any filter the site can express
hirify vacancy read <slug>           # the whole vacancy, with its text: this is how you judge fit
hirify vacancy reveal <slug>         # where to apply: spends 1 reveal
hirify vacancy apply <slug>          # apply on Hirify: ask first
```

1. `hirify account show` before revealing anything.
2. Feeds first, search second. A feed is a filter the user built, so it already says what they want.
3. Shortlist **from the cards**. They carry no contacts, and that is normal.
4. `hirify vacancy read` the shortlist. The card is a headline; the text is where fit is decided, and
   reading is cheap. Judging fit without reading is guessing.
5. `hirify vacancy reveal` only what still fits after reading. A reveal spent at random is spent.
6. Apply only after the user says yes, and read the rules below first.

`hirify vacancy read` also tells you which of the two ways to apply the vacancy takes, so you do not
have to work it out or find out from a refusal.

## Searching

`vacancy search` takes a phrase and any criterion the site's filter form can express, passed as an
option under its own name. `--limit` sets the page size and `--page` moves through pages; those two
are the CLI's own, not filters.

**`hirify filter guide` is the vocabulary, and the only source for it.** Do not guess criterion
names or values: an unknown one narrows nothing, and a misspelt value returns an empty list that
looks like an honest "nothing matches". If a server does not serve the guide, it says so; then ask
the user what to filter on.

## Applying

Two cases, two commands:

- **Hosted on Hirify** -> `hirify vacancy apply <slug>` sends the application through Hirify.
- **From somewhere else** -> `hirify vacancy reveal <slug>` gives the link or contact, and **the
  user applies themselves**. `vacancy apply` refuses these and says so.

- **Ask first, every time, and show what you are about to send.** An application cannot be taken
  back. Never apply to a list on a single "yes".
- **Never invent the cover letter.** Draft it from what the user actually said about themselves and
  show them the draft; if they gave you nothing, ask rather than fill the gap.
- **Never choose the profile** when the user has several: `hirify profile list` lists them. With
  exactly one profile it is chosen automatically.
- After a successful apply, say it was sent and stop. Nobody follows up: the recruiter replies where
  they choose to, and Hirify does not track it.

## Saved searches and delivery

These change the user's account, so the same rule holds: propose, get a yes, then do it.

```bash
hirify feed create "<name>" --filters '<json>'   # criteria: hirify filter guide
hirify feed deliver <id> --telegram | --no-telegram | --webhook <id> | --no-webhook
hirify webhook list
hirify webhook create "<name>" <url>
```

`--filters` takes the same criteria as the site's filter form; read `hirify filter guide` first.
Creating a delivery endpoint returns a **secret shown once**: give it to the user immediately to
store, because it signs every delivery and cannot be shown again.

## Telling Hirify something is broken

`hirify feedback send <bug|feature> "<title>" --body "<text>" [--vacancy <slug>]` sends a report,
free. Ask first, send the user's words rather than your own, and report that it was passed on: it
gives a ticket number or says there is none yet, nothing writes back, and no fix or date is promised.

## When something goes wrong

**The message you were given is the truth; this is a map of the kinds, not strings to match.** Every
failure exits non-zero and writes one line to stderr. Read that line and tell the user what it says.

- **Not signed in**: ask the user to run `hirify login` (it opens a browser and needs a person -
  never run it yourself). On a server with no browser: `hirify auth <key>`, key from
  hirify.me/account/api-access.
- **Sign-in no longer good** (401): expired or revoked. Ask the user to run `hirify login` again.
- **No access** (403): the sign-in is missing an ability, or the plan does not cover agent access.
  Abilities are fixed at sign-in, so a user who signed in before an ability existed signs in again.
- **A budget or the pace** (429): a metered action is used up - reveals, vacancy opens, or applies -
  or commands came too fast. The message names which; feeds and search keep working. What is left:
  `hirify account show`.
- **A refusal naming a length or a value** comes from the server: shorten what it named and send
  again, do not argue with it or assume a bound.
- **`hirify <noun> has no verb "..."`**: the name does not exist and the message lists the verbs that
  noun takes. Read the list rather than guessing again.

## When no command fits

`hirify api call <capability-id> --data '<json>'` runs a capability by its id and prints the answer
as it comes back, so a job with no named command is a detour, not a dead end. `hirify --help` and
the server's own catalogue name the capabilities.

Reach for a named command first where one exists: it says what a call costs and what a refusal means,
and this one cannot. It will spend a reveal or send a real application just as readily, so the same
rule holds - ask the user before anything that sends, saves or configures.
