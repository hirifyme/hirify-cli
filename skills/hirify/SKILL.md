---
name: hirify
description: Job search through Hirify - vacancies from the user's saved feeds, search across the board, reading a vacancy in full, the contact to apply to, applying on Hirify, and saved searches with delivery. Use when the user asks to find jobs, look at their feeds, pick roles that fit their profile, apply, or set up alerts. Triggers - "find jobs", "what is in my feed", "where do I apply", "apply to this", "hirify".
---

# Hirify job search

You work with the Hirify job board through the `hirify` CLI. `hirify intro` is its own guide, and
`reference.md` next to this file has every command, what it costs and how it refuses. Read that
when you need the detail.

## Two rules before anything else

**Lists are free. Three commands are not, and they cost different things.**

- `read` spends one of the day's vacancy opens. The allowance is generous, it is the same one a
  browser uses, and re-reading a vacancy the same day costs nothing. Read freely.
- `reveal` spends 1 reveal, and reveals are scarce. When they run out, reading still works.
  `hirify me` shows what is left of both.
- `apply` spends nothing and cannot be taken back. It sends a real application, with the user's
  name and profile, to a person who will read it.

**Ask the user before every apply, and before anything that changes their account.** Reading needs
no permission. Sending, saving and configuring do.

## Working order

```bash
hirify me                       # plan and remaining reveals: start here
hirify feeds                    # the user's saved feeds, which are their own filters
hirify feed <id>                # vacancies from a feed: the best source
hirify search "senior go"       # when no feed fits, plus any filter the site can express
hirify read <slug>              # the whole vacancy, with its text: this is how you judge fit
hirify reveal <slug>            # where to apply: spends 1 reveal
hirify apply <slug>             # apply on Hirify: ask first
```

1. `hirify me` before revealing anything.
2. Feeds first, search second. A feed is a filter the user built, so it already says what they want.
3. Shortlist **from the cards**. They carry no contacts, and that is normal.
4. `hirify read` the shortlist. The card is a headline; the text is where fit is decided, and reading
   is cheap. Judging fit without reading is guessing.
5. `hirify reveal` only what still fits after reading.
6. Apply, and read the next section before you do.

`hirify read` also answers which of the two ways to apply the vacancy takes, so you do not have to
work it out or find out from a refusal.

## Searching

`search` is a conduit to the API, not a fixed set of flags. It takes a phrase, and any criterion
the site's own filter form can express, written as an option and passed on under that name:

```bash
hirify search "senior go" --grade senior --work_format remote
hirify search "senior go" --excluded_countries ru --page 2
hirify search "senior go" --grade senior --grade middle    # one criterion, two values
```

**Do not guess criterion names or their values.** Ask the server what it accepts rather than
trying options until one works: an unknown criterion is not refused, it simply narrows nothing,
and a misspelt value quietly returns an empty list. `--limit N` sets the page size and `--page N`
moves through the pages.

## Applying

Two cases, and they take different commands:

- **The vacancy is hosted on Hirify** -> `hirify apply <slug>` sends the application through Hirify.
- **The vacancy came from somewhere else** -> `hirify reveal <slug>` gives the link or contact, and
  **the user applies themselves**. `apply` will refuse these, and say so.

Rules:

- **Ask first, every time, and show what you are about to send.** An application cannot be taken
  back. Never apply to a list on a single "yes".
- **Never invent the cover letter.** Draft it from what the user actually said about themselves and
  show them the draft. If they did not give you anything to work with, ask rather than fill the gap.
- **Never choose the profile for them** when they have several. `hirify profiles` lists them. With
  exactly one profile, it is picked automatically.
- After a successful apply, say it was sent and stop. Nobody follows up: the recruiter replies where
  they choose to, and Hirify does not track it.

## Saved searches and delivery

These change the user's account, so the same rule applies: propose, get a yes, then do it.

```bash
hirify feed create "Senior Go remote" --filters '{"grade":["senior"]}'
hirify feed delivery <id> --telegram | --no-telegram | --webhook <id> | --no-webhook
hirify webhooks                          # existing delivery endpoints
hirify webhooks create "<name>" <url>
```

Creating a delivery endpoint returns a **secret that is shown once**. Give it to the user
immediately and tell them to store it, because it cannot be shown again and it signs every delivery.

## What not to do

- Do not reveal a vacancy to see what is inside. `hirify read` is what shows you what is inside.
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
- **A refusal on apply** is usually the vacancy, not the user: archived, flagged, or hosted
  elsewhere. Read what it says and tell the user plainly.

## Telling Hirify something is broken

When the user hits something broken or wishes a feature existed, offer to send it:

```bash
hirify feedback bug "Reveal answers 500 on archived vacancies" --body "<what happened>"
hirify feedback feature "Filter by salary currency" --body "<what the user needs>"
```

Free, and it does not touch the reveal limit. Ask before sending, send the user's words rather than
your own, and add `--vacancy <slug>` when it is about one vacancy. The answer gives a ticket number
or says there is no number yet. **Report that it was passed on, and stop there**: there is no page
to open, nothing writes back, and no reply, fix or date is promised.
