---
name: hirify
description: Job search through Hirify - vacancies from the user's saved feeds, search across the board, the contact to apply to, applying on Hirify, and saved searches with delivery. Use when the user asks to find jobs, look at their feeds, pick roles that fit their profile, apply, or set up alerts. Triggers - "find jobs", "what is in my feed", "where do I apply", "apply to this", "hirify".
---

# Hirify job search

You work with the Hirify job board through the `hirify` CLI. Full command reference, with every
option and every answer: `reference.md`, next to this file. Read it when you need the detail.

## Two rules before anything else

**Reading is free. Two things are not, and they are not the same kind of not-free.**

- `reveal` spends 1 of a daily limit. It is a budget, and running out costs the user their day.
- `apply` spends nothing and cannot be taken back. It sends a real application, with the user's
  name and profile, to a person who will read it.

**Ask the user before every apply, and before anything that changes their account.** Reading needs
no permission. Sending, saving and configuring do.

## Working order

```bash
hirify me                       # plan and remaining reveals: start here
hirify feeds                    # the user's saved feeds, which are their own filters
hirify feed <id>                # vacancies from a feed: the best source
hirify search "senior go"       # when no feed fits
hirify reveal <slug>            # where to apply: spends 1 reveal
hirify apply <slug>             # apply on Hirify: ask first
```

1. `hirify me` before revealing anything.
2. Feeds first, search second. A feed is a filter the user built, so it already says what they want.
3. Shortlist **from the cards**. They carry no contacts, and that is normal.
4. `hirify reveal` only for the shortlist.
5. Apply, and read the next section before you do.

## Applying

Two different things, and picking the wrong one wastes the user's day:

- **The vacancy is hosted on Hirify** -> `hirify apply <slug>` sends the application through Hirify.
- **The vacancy came from somewhere else** -> `hirify reveal <slug>` gives the link or contact, and
  **the user applies themselves**. `apply` will refuse these, and say so.

Rules that are not negotiable:

- **Ask first, every single time, and show what you are about to send.** One application is one
  irreversible message to a person. Never apply to a list in one go on a single "yes".
- **Never invent the cover letter.** Draft it from what the user actually said about themselves and
  show them the draft. If they did not give you anything to work with, ask rather than fill the gap.
- **Never choose the profile for them** when they have several. `hirify profiles` lists them; the
  server refuses to guess and so should you. With exactly one profile, it is picked automatically.
- After a successful apply, say it was sent and stop. Nobody chases the answer: the recruiter
  replies where they choose to, and Hirify does not track it for the user.

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

- Do not reveal a vacancy to see what is inside, or just in case.
- Do not apply without asking. Do not apply in bulk.
- Do not try to pull the whole database. The limit exists for that, and the account gets banned.
- **Do not run `hirify login` yourself.** It opens a browser and needs a person at the screen.

## When something goes wrong

- **"you are not signed in yet"**: ask the user to run `hirify login`. On a server with no browser:
  `hirify auth <key>`, key from hirify.me/account/api-access.
- **401**: the sign-in expired. `hirify login` again.
- **403**: the sign-in is missing a permission, or the plan does not include agent access. If the
  user signed in before a permission existed, they have to sign in again to get it.
- **429**: the daily limit is used up until midnight. Reading still works.
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
to open, nothing writes back, and nobody promised a reply, a fix or a date.
