---
name: hirify
description: Job search through Hirify - vacancies from the user's saved feeds, search across the board, and the contact to apply to. Use when the user asks to find jobs, look at their feeds, pick roles that fit their profile, or find out where to send an application. Triggers - "find jobs", "what is in my feed", "where do I apply", "hirify".
---

# Hirify job search

You work with the Hirify job board through the `hirify` CLI.

## The rule that matters: the limit

- **Reading is free and unlimited**: `me`, `feeds`, `feed`, `search`. Read as much as you need.
- **`reveal` spends 1 of the daily limit.** It is the only metered call.
- Revealing the same vacancy again is **free** (the server deduplicates).
- **Do not burn the limit.** Shortlist by reading first, then reveal only what genuinely fits the
  user. Revealing at random spends the whole day.
- The limit resets at midnight. `hirify me` always shows what is left.

## How to work

```bash
hirify me                       # plan and remaining limit: start here
hirify feeds                    # the user's saved feeds, which are their own filters
hirify feed <id>                # vacancies from a feed: the best source
hirify search "senior go"       # when no feed fits
hirify reveal <slug>            # WHERE TO APPLY: spends the limit
```

Every command takes `--json`. Use it when you need to parse rather than show.

1. `hirify me` to check what is left before revealing anything.
2. `hirify feeds`, then `hirify feed <id>`. Feeds are filters the user saved themselves, so they
   already describe what the user wants. That beats a blind search.
3. No fitting feed: `hirify search "<query>" --limit 20`.
4. Shortlist **from the cards**. Cards carry no contacts, and that is normal.
5. `hirify reveal <slug>` only for the shortlist. It returns the company, its LinkedIn page and
   where to send the application.

## What not to do

- **Do not apply on the user's behalf.** There is no API for it and there will not be one. Your work
  ends when you bring back the link and the contact. The person sends the application.
- Do not reveal a vacancy to see what is inside, or just in case.
- Do not try to pull the whole database. The limit exists for exactly that, and the account gets
  banned.
- **Do not run `hirify login` yourself.** It opens a browser and needs a person at the screen. Ask
  the user to run it and wait for them.

## When something goes wrong

- **"you are not signed in yet"**: ask the user to run `hirify login`. Their browser opens, they
  confirm, and the terminal continues on its own. On a server with no browser: `hirify auth <key>`,
  key from hirify.me/account/api-access.
- **401, sign-in no longer valid**: same answer, `hirify login` again.
- **403**: the sign-in is missing a permission, or the plan does not include agent access. Point the
  user at hirify.me/account/api-access.
- **429**: the daily limit is used up until midnight. Reading still works.
