---
name: hirify
description: Job search through Hirify - vacancies from the user's saved feeds, search across the board, reading a vacancy in full, the contact to apply to, applying on Hirify, and saved searches with delivery. Use when the user asks to find jobs, look at their feeds, pick roles that fit their profile, apply, or set up alerts. Triggers - "find jobs", "what is in my feed", "where do I apply", "apply to this", "hirify".
---

# Hirify job search

You work with the Hirify job board through the `hirify` CLI. `hirify intro` is its own guide, and
`reference.md` next to this file has every command, what it costs and how it refuses. Read that
when you need the detail.

Commands are a noun and a verb: `hirify vacancy read`, `hirify feed list`. A noun on its own lists
the verbs it takes, and `hirify --help` lists the whole surface.

## What this file may state, and what it must ask for

This file is installed once and then sits in your harness, unchanged, while Hirify keeps shipping.
So it holds only what stays true across that gap:

- **how to work**: the order, what needs the user's permission, what cannot be undone;
- **what the CLI does**: which command sends, which command spends, how a refusal reads.

Everything that is Hirify's to change is **fetched, never written here**:

| What you need | Ask for it |
|---|---|
| Filter names and their values | `hirify filter guide` |
| Reveals and vacancy opens left | `hirify account show` |
| Rate limits, plan, abilities | `hirify account show --json` |
| The commands that exist | `hirify --help`, `hirify <noun>` |
| Anything with no command yet | `hirify api call <path>` |

**Adding a line here? Decide which half it belongs to.** If a deploy on our side could make it
false, it does not go in this file: name the command that answers it instead. A sentence in this
file that names a filter, a limit or a number is a sentence that will be wrong one day, and you
will act on it without knowing.

## Two rules before anything else

**Lists are free. Three commands are metered, and they spend different things.**

- `vacancy read` spends one of the day's vacancy opens. The allowance is generous, it is the same
  one a browser uses, and re-reading a vacancy the same day costs nothing. Read freely.
- `vacancy reveal` spends 1 reveal, and reveals are scarce. When they run out, reading still works.
- `vacancy apply` counts against a daily allowance of its own **and cannot be taken back**. It
  sends a real application, with the user's name and profile, to a person who will read it.

**`hirify account show` is the only place any of these numbers is true.** Read it before you spend,
and read it again rather than carrying a figure from one answer into the next: all three move while
you work, and two of them are shared with what the user does on the site.

Never tell the user how much of anything is left from memory, and never plan a batch on a number
you are not currently looking at.

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
5. `hirify vacancy reveal` only what still fits after reading.
6. Apply, and read the next section before you do.

`hirify vacancy read` also answers which of the two ways to apply the vacancy takes, so you do not
have to work it out or find out from a refusal.

## Searching

`vacancy search` is a conduit to the API, not a fixed set of flags. It takes a phrase, and any
criterion the site's own filter form can express, written as an option and passed on under that
name:

```bash
hirify filter guide                                       # read this BEFORE building a filter
hirify vacancy search "senior go"
hirify vacancy search "senior go" --<criterion> <value>
hirify vacancy search "senior go" --<criterion> a --<criterion> b   # one criterion, two values
```

**`hirify filter guide` is the vocabulary.** The server writes it from the same source the site
searches with, so it cannot drift; this file deliberately names no criterion, because a name
written here would be a snapshot going stale on its own.

**Do not guess criterion names or their values, and do not try options until one works.** A
criterion the server does not know narrows nothing, and a misspelt value returns an empty list that
looks like an honest "nothing matches". Read the guide, then filter.

`--limit N` sets the page size and `--page N` moves through the pages. Those two are the CLI's own
and are not filters.

If the guide is not available on the server the user is on, `hirify filter guide` says so plainly.
Then ask the user what to filter on rather than guessing names.

## Applying

Two cases, and they take different commands:

- **The vacancy is hosted on Hirify** -> `hirify vacancy apply <slug>` sends the application through
  Hirify.
- **The vacancy came from somewhere else** -> `hirify vacancy reveal <slug>` gives the link or
  contact, and **the user applies themselves**. `vacancy apply` will refuse these, and say so.

Rules:

- **Ask first, every time, and show what you are about to send.** An application cannot be taken
  back. Never apply to a list on a single "yes".
- **Applying is metered.** The server declares a daily allowance for it and `hirify account show`
  reports what is left, in the `applies` line. It is far smaller than the reading allowance, so
  applying to everything that looks plausible spends it on the ones that were not worth it. Read
  the line; do not assume the number, in either direction.
- **Never invent the cover letter.** Draft it from what the user actually said about themselves and
  show them the draft. If they did not give you anything to work with, ask rather than fill the gap.
- **Never choose the profile for them** when they have several. `hirify profile list` lists them.
  With exactly one profile, it is picked automatically.
- After a successful apply, say it was sent and stop. Nobody follows up: the recruiter replies where
  they choose to, and Hirify does not track it.

## Saved searches and delivery

These change the user's account, so the same rule applies: propose, get a yes, then do it.

```bash
hirify feed create "<name>" --filters '<json>'   # criteria: hirify filter guide
hirify feed deliver <id> --telegram | --no-telegram | --webhook <id> | --no-webhook
hirify webhook list                              # existing delivery endpoints
hirify webhook create "<name>" <url>
```

`--filters` takes the same criteria the filter form on the site produces. Read `hirify filter
guide` first and use only what it names.

Creating a delivery endpoint returns a **secret that is shown once**. Give it to the user
immediately and tell them to store it, because it cannot be shown again and it signs every delivery.

## What not to do

- Do not reveal a vacancy to see what is inside. `hirify vacancy read` is what shows you what is
  inside.
- Do not apply without asking. Do not apply in bulk.
- Do not try to pull the whole board. That is what the limit is for.
- **Do not run `hirify login` yourself.** It opens a browser and needs a person at the screen.

## When something goes wrong

**The message you were given is the truth; this list is a map of the kinds, not a table to match
strings against.** Every failure exits non-zero and writes one line to stderr. Read that line and
tell the user what it says.

- **Not signed in**: ask the user to run `hirify login`. On a server with no browser:
  `hirify auth <key>`, key from hirify.me/account/api-access. Never run `login` yourself.
- **The sign-in is no longer good** (401): expired or revoked. `hirify login` again.
- **No access** (403): the sign-in is missing an ability, or the plan does not cover agent access.
  Abilities are fixed when the user signs in and cannot be added afterwards, so a user who signed
  in before an ability existed has to sign in again. `hirify account show --json` reports the plan.
- **A budget or the pace** (429): a metered action is used up - reveals, the day's vacancy opens,
  or applications - or commands were sent too fast. The message names which one, and feeds and
  search keep working in every case. What is left: `hirify account show`.
- **A refusal on `vacancy apply`** is usually about the vacancy, not the user: archived, flagged,
  or hosted elsewhere. The server's own sentence comes through; pass it on as it is.
- **A refusal naming a length or a value** comes from the server, not from the CLI. Do not argue
  with it and do not assume a bound - shorten what it named and send again.
- **`hirify <noun> has no verb "..."`**: a command name that does not exist. The message lists the
  verbs that noun takes. Do not guess a second time; read the list.

## When no command fits

`hirify api call <path>` sends a request to the agent API as you write it and prints the answer as
it comes back. It exists so that a job this CLI has no command for is a detour rather than a
dead end.

```bash
hirify api call /agent/me
hirify api call '/agent/vacancies?search=go&per_page=5'
hirify api call /agent/feeds --data '{"name":"Senior Go","filters":{}}'
```

`--data` makes it a POST; `--method` names any other method. The answer is printed unchanged,
refusals included, and the exit code is non-zero when the server refused.

**Reach for a named command first when one exists.** They say what a call costs and what a refusal
means; this one cannot, and it will spend a reveal or send a real application just as readily as the
named command would. The same permission rules apply: ask the user before anything that sends,
saves or configures.

## Telling Hirify something is broken

When the user hits something broken or wishes a feature existed, offer to send it:

```bash
hirify feedback send bug "<what broke, in a line>" --body "<what happened>"
hirify feedback send feature "<what is missing>" --body "<what the user needs>"
```

Free, and it does not touch the reveal limit. Ask before sending, send the user's words rather than
your own, and add `--vacancy <slug>` when it is about one vacancy. The answer gives a ticket number
or says there is no number yet. **Report that it was passed on, and stop there**: there is no page
to open, nothing writes back, and no reply, fix or date is promised.
