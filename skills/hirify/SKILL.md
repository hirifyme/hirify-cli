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

## Two rules before anything else

**Lists are free. Three commands are not, and they cost different things.**

- `vacancy read` spends one of the day's vacancy opens. The allowance is generous, it is the same
  one a browser uses, and re-reading a vacancy the same day costs nothing. Read freely.
- `vacancy reveal` spends 1 reveal, and reveals are scarce. When they run out, reading still works.
  `hirify account show` has what is left of both.
- `vacancy apply` spends nothing and cannot be taken back. It sends a real application, with the
  user's name and profile, to a person who will read it.

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
criterion the site's own filter form can express, written as an option and passed on under that name:

```bash
hirify vacancy search "senior go" --grade senior --work_format remote
hirify vacancy search "senior go" --excluded_countries ru --page 2
hirify vacancy search "senior go" --grade senior --grade middle    # one criterion, two values
```

**Do not guess criterion names or their values.** Ask the server what it accepts rather than
trying options until one works: an unknown criterion is not refused, it simply narrows nothing,
and a misspelt value quietly returns an empty list. `--limit N` sets the page size and `--page N`
moves through the pages.

## Applying

Two cases, and they take different commands:

- **The vacancy is hosted on Hirify** -> `hirify vacancy apply <slug>` sends the application through
  Hirify.
- **The vacancy came from somewhere else** -> `hirify vacancy reveal <slug>` gives the link or
  contact, and **the user applies themselves**. `vacancy apply` will refuse these, and say so.

Rules:

- **Ask first, every time, and show what you are about to send.** An application cannot be taken
  back. Never apply to a list on a single "yes".
- **Never invent the cover letter.** Draft it from what the user actually said about themselves and
  show them the draft. If they did not give you anything to work with, ask rather than fill the gap.
- **Never choose the profile for them** when they have several. `hirify profile list` lists them.
  With exactly one profile, it is picked automatically.
- After a successful apply, say it was sent and stop. Nobody follows up: the recruiter replies where
  they choose to, and Hirify does not track it.

## Saved searches and delivery

These change the user's account, so the same rule applies: propose, get a yes, then do it.

```bash
hirify feed create "Senior Go remote" --filters '{"grade":["senior"]}'
hirify feed deliver <id> --telegram | --no-telegram | --webhook <id> | --no-webhook
hirify webhook list                      # existing delivery endpoints
hirify webhook create "<name>" <url>
```

Creating a delivery endpoint returns a **secret that is shown once**. Give it to the user
immediately and tell them to store it, because it cannot be shown again and it signs every delivery.

## What not to do

- Do not reveal a vacancy to see what is inside. `hirify vacancy read` is what shows you what is
  inside.
- Do not apply without asking. Do not apply in bulk.
- Do not try to pull the whole board. That is what the limit is for.
- **Do not run `hirify login` yourself.** It opens a browser and needs a person at the screen.

## When something goes wrong

- **"you are not signed in yet"**: ask the user to run `hirify login`. On a server with no browser:
  `hirify auth <key>`, key from hirify.me/account/api-access.
- **401**: the sign-in expired. `hirify login` again.
- **403**: the sign-in is missing a permission, or the plan does not include agent access. If the
  user signed in before a permission existed, they have to sign in again to get it.
- **429**: the reveals are spent, the day's vacancy opens are spent, or the commands came too fast.
  The message says which. Feeds and search keep working in all three cases.
- **A refusal on `vacancy apply`** is usually the vacancy, not the user: archived, flagged, or hosted
  elsewhere. Read what it says and tell the user plainly.
- **`hirify <noun> has no verb "..."`**: you used a name this CLI does not have. The message lists
  the verbs that noun takes. Do not guess a second time; read the list.

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
hirify feedback send bug "Reveal answers 500 on archived vacancies" --body "<what happened>"
hirify feedback send feature "Filter by salary currency" --body "<what the user needs>"
```

Free, and it does not touch the reveal limit. Ask before sending, send the user's words rather than
your own, and add `--vacancy <slug>` when it is about one vacancy. The answer gives a ticket number
or says there is no number yet. **Report that it was passed on, and stop there**: there is no page
to open, nothing writes back, and no reply, fix or date is promised.
