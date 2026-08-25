# hirify CLI reference

Written for an agent. Every command, what it costs, what it answers, and how it refuses.

Commands are a noun and a verb: the noun is the thing you are working with, the verb is what you do
to it. `hirify <noun>` on its own lists the verbs that noun takes. `login`, `logout`, `auth` and
`intro` stay single words: they are not operations on a thing.

**This file describes the CLI, not the state of Hirify.** It is installed with the skill and never
updated afterwards, so it names no filter, no limit and no number that our side can change. Those
come from commands: `hirify filter guide` for filters, `hirify account show` for what is left,
`hirify account show --json` for the plan and the limits. Where this file would have quoted one, it
names the command instead.

Add `--json` to any command to get the server's payload verbatim instead of the text below. Parse
`--json`; do not parse the text, it is written for a person to read. Every failure exits non-zero and
writes one line to stderr beginning with `hirify: `.

Set `HIRIFY_DEBUG=1` in front of a command to also get the server's own answer on stderr. Use it
when you need to report a problem; the normal output never contains raw payloads.

## Cost model

| Command | Cost | Reversible |
|---|---|---|
| `account show`, `feed list`, `feed show`, `vacancy search`, `profile list`, `webhook list` | free: they spend nothing | reading only |
| `vacancy read` | 1 vacancy open from a generous daily allowance, repeats the same day are free | reading only |
| `vacancy reveal` | 1 reveal, repeats on the same vacancy are free | reading only |
| `vacancy apply` | free | **no**: a real application reaches a real person |
| `feed create`, `feed deliver`, `webhook create` | free | changes the user's account |
| `feedback send` | free | a ticket is filed |
| `filter guide` | free: it spends nothing | reading only |
| `api call` | whatever the path it calls costs | whatever that path does |

Free is not unlimited: every command is rate-limited, reading more loosely than searching. A burst
answers `429` and names the seconds to wait. The numbers are the server's and change without this
file: `hirify account show --json`, block `limits`.

Two budgets run out, and they are separate. Vacancy opens are the allowance `vacancy read` draws
on: it is shared with the site, so a vacancy the user opened in a browser today costs nothing here,
and it is sized so that reading is not something to ration. Reveals are the scarce one. Both are in
`hirify account show`, and in `hirify account show --json` under `quota.read` and `quota.reveal`.

## Signing in

`hirify login` opens a browser and needs a person. Never run it yourself: ask the user to run it.
It stores access in `~/.config/hirify/auth.json` (mode 600) and renews it without asking again.
`hirify logout` forgets it. On CI or a server: `hirify auth <key>`, or `HIRIFY_KEY` in the
environment, which wins over a stored sign-in.

Permissions are fixed when the user signs in and cannot be added afterwards. A 403 naming a missing
permission means the user signed in before that permission existed: they have to run `hirify login`
again.

## Reading

```bash
hirify account show
hirify feed list
hirify feed show <id> [--limit N] [--page N]
hirify vacancy search "<phrase>" [--<criterion> <value>]... [--limit N] [--page N]
```

`account show` reports the plan, the reveals left, the vacancy opens left today, and reveal usage
over 7 and 30 days. Check it before spending reveals. Both allowances come as one number, not a
fraction.

`feed list` lists saved searches as `<id> <name>`, with `(off)` for an inactive one. `feed show
<id>` returns that feed's vacancies, using the criteria saved in the feed.

`vacancy search` is a conduit. The words are the phrase; every option is forwarded to the API under
the name you gave it, so the criteria are the server's and this CLI holds no copy of them to fall
behind. `--limit` is the page size and arrives as the API's `per_page`; `--json` steers the CLI and
is never sent. An option repeated is joined with a comma, which is how the site sends a criterion
with several values.

**The criteria come from `hirify filter guide`, and only from there.** Do not guess names or
values. An unknown criterion is not refused, it narrows nothing, and a misspelt value returns an
empty list that looks like an honest answer.

Both `feed show` and `vacancy search` page with `--page N`. The last line of a list says which page
you are on and offers the next one when there may be another.

Vacancy cards print as:

```
<slug>
  <title> · <company or "company hidden">
  [<remote> · <format> · <employment> · <english> · <salary> · verified]
```

Cards never carry contacts. `company hidden` means the name is revealed by `vacancy reveal`, not
that the field is broken.

## filter guide: what search can filter on

```bash
hirify filter guide
```

Prints the filter guide the server writes: which criteria search accepts, what their values are,
and the method for turning what a person wants into a filter that works. Free, and it needs
`agent:read` like the other reading commands.

The server derives it from the same source the site's own search reads, so it cannot fall behind
the search. That is the whole point: nothing in this package writes filter names down, because a
list written here goes stale silently and an agent acts on it without knowing.

`--json` gives `{"guide": "<text>"}`. The text is written for a model to read, so pass it through
rather than summarising it.

A server that does not serve the guide yet answers plainly: `this Hirify server does not serve the
filter guide yet.` Then the criteria have to come from the user, not from a guess.

## vacancy read: one vacancy in full

```bash
hirify vacancy read <slug>
```

The card plus everything else the vacancy page shows: area, grade, skills, location, when it was
posted, the page address, and the description as text. This is the command that decides fit, and it
is deliberately cheap.

It costs one vacancy open from the daily allowance, and the same vacancy read again the same day
costs nothing. The allowance is shared with the site, so a vacancy the user already opened in a
browser is already paid for. The output states whether an open was used and how many are left.

The last line before that says which way to apply:

- `Apply on Hirify: hirify vacancy apply <slug>` - the vacancy is hosted here.
- `Where to apply: hirify vacancy reveal <slug> (uses 1 reveal)` - it came from elsewhere, so the
  user applies themselves. Take this from `vacancy read` rather than finding out from a refusal on
  `vacancy apply`.

Contacts, the apply destination and where the vacancy came from are never in this answer. That is
what `vacancy reveal` is for.

With `--json`, `data.description` is HTML (`data.description_format` says so) and the text output is
the same content flattened for a terminal. `charged` and `quota` sit next to `data`.

Refusals: `there is no vacancy with that slug.`, and, when the day's opens are spent, `you have
opened as many vacancies today as the daily allowance covers.` - feeds and search still work then,
and so does any vacancy already read today.

## vacancy reveal: where to apply

```bash
hirify vacancy reveal <slug>
```

Spends 1 reveal and returns the company, its LinkedIn page when known, and one or more
contacts: an address, a form URL, or a link. Revealing the same vacancy again returns the same thing
and spends nothing, so a repeat is safe. The output states whether a reveal was used and how many
are left.

Shortlist with `vacancy read` first. A reveal spent at random is spent.

## vacancy apply: only on Hirify

```bash
hirify profile list
hirify vacancy apply <slug> [--profile <id>] [--cover "<text>"]
```

`profile list` lists what the user can apply with: `<profile_id> <name> [status · incomplete]`.

`vacancy apply` sends an application through Hirify. **Ask the user first, every time, and show
what you are sending.** It cannot be undone.

- `--profile` is required when the user has more than one profile. With exactly one, it is chosen
  automatically. Never guess between several.
- `--cover` is optional. There is a length ceiling and the server owns it: if the letter is too
  long, the answer says so. Write it from what the user told you and show them the draft first.

Answers:

- success: `Applied. Application <id>, status <status>.` Nothing follows up: the recruiter replies
  where they choose to.
- `there is no vacancy with that slug.`
- a refusal in the server's own words, which covers archived, flagged, someone else's profile, and
  **vacancies not hosted on Hirify**. For those, use `vacancy reveal` and let the user apply
  themselves.
- `the application could not be sent right now.` means our side failed, not the user's data.

## Saved searches and delivery

```bash
hirify feed create "<name>" [--filters '<json>'] [--telegram|--no-telegram] [--webhook <id>]
hirify feed deliver <id> [--telegram|--no-telegram] [--webhook <id>|--no-webhook]
hirify webhook list
hirify webhook create "<name>" <url>
```

These change the user's account. Propose, get a yes, then run them.

`--filters` takes the same criteria the site's filter form produces, as JSON, and the names come
from `hirify filter guide`. Omitting it saves a feed with no criteria, which means "send me
everything" and is legal.

`webhook create` answers with the endpoint and a **secret shown once**. Hand it to the user
immediately and tell them to store it: it signs every delivery and cannot be shown again.

## feedback send

```bash
hirify feedback send <bug|feature> "<title>" --body "<text>" [--vacancy <slug>]
```

Both a title and a body are required, and the CLI says so before sending anything. Their lengths
are the server's rule, not the CLI's: too short or too long comes back as the server's own sentence
naming which. Ask the user before sending and send their words. The answer gives a ticket number,
or says there is no number yet. There is no page to open, nothing writes back to the user, and no
reply, fix or date is promised. Report that it was passed on and stop there.

Refusals: too many reports in a short time (with the wait in seconds), the channel being off, or the
report not being accepted.

## api call: the raw door

```bash
hirify api call <path> [--method GET|POST|PUT|PATCH|DELETE] [--data '<json>']
```

Sends a request to the agent API as you write it and prints the answer as it comes back. It is here
so that a job this CLI has no command for is a detour rather than a dead end.

```bash
hirify api call /agent/me
hirify api call '/agent/vacancies?search=go&per_page=5'
hirify api call /agent/feeds --data '{"name":"Senior Go","filters":{}}'
hirify api call /agent/feeds/7/delivery --method PUT --data '{"notify_telegram":true}'
```

- The path is the one the API publishes and begins with `/agent/`. `/agent/me`, `agent/me` and
  `/api/agent/me` are one path written three ways and all arrive as the same request.
- `--data` makes the call a POST and travels as the JSON body. `--method` names any other method.
  A method outside the five, or a `--data` that is not JSON, is refused before anything is sent.
- The answer is printed as it arrived, refusals included, so what you parse is the server's own
  payload rather than a sentence of ours. The status goes to stderr and the exit code is non-zero
  when the server refused.

**Prefer a named command where one exists.** This one carries none of what they know: it will not
tell you that a call costs a reveal, and it will send a real application as readily as
`vacancy apply` would. The permission rules do not change: ask the user before anything that sends,
saves or configures.

## Failure modes worth knowing

| Message | What it means | What to do |
|---|---|---|
| `you are not signed in yet` | no stored access | ask the user to run `hirify login` |
| `your sign-in is no longer valid` | the session expired past renewal | ask the user to run `hirify login` |
| `the key was not accepted (401)` | a manual key was revoked or truncated | new key from the account page |
| `no access (403)` | missing permission, or the plan does not cover agent access | sign in again, or check the plan |
| `you have no reveals left right now` | the reveal budget is spent | reading still works; `hirify account show` has what is left |
| `you have opened as many vacancies today...` | the day's vacancy opens are spent | feeds, search and anything already read today still work |
| `too many requests in a short time` | asking faster than the API allows | wait the seconds it names, then carry on |
| `something went wrong on our side` | our fault, not the request | retry in a minute |
| an empty list from a filtered search | usually a criterion name or value that does not exist | check the name against what the server accepts, do not keep guessing |
| `the network seems to be unavailable` | no connection | retry |
| `hirify <noun> has no verb "..."` | a command name this CLI does not have | the message lists the verbs that noun takes; read it rather than guessing again |
