# hirify CLI reference

Written for an agent. Every command, what it costs, what it answers, and how it refuses.

Add `--json` to any command to get the server's payload verbatim instead of the text below. Parse
`--json`; do not parse the text, it is written for a person to read. Every failure exits non-zero and
writes one line to stderr beginning with `hirify: `.

Set `HIRIFY_DEBUG=1` in front of a command to also get the server's own answer on stderr. Use it
when you need to report a problem; the normal output never contains raw payloads.

## Cost model

| Command | Cost | Reversible |
|---|---|---|
| `me`, `feeds`, `feed`, `search`, `profiles`, `webhooks` | free: they spend nothing | reading only |
| `read` | 1 vacancy open from a generous daily allowance, repeats the same day are free | reading only |
| `reveal` | 1 reveal, repeats on the same vacancy are free | reading only |
| `apply` | free | **no**: a real application reaches a real person |
| `feed create`, `feed delivery`, `webhooks create` | free | changes the user's account |
| `feedback` | free | a ticket is filed |

Free is not unlimited. Every command is rate-limited per minute, `feed` and `search` more tightly
than the rest, and `feedback` also per day. A burst answers `429`; wait the seconds it names and
carry on. The current numbers come from the server: `hirify me --json`, block `limits`.

Two budgets run out, and they are separate. Vacancy opens are the allowance `read` draws on: it is
shared with the site, so a vacancy the user opened in a browser today costs nothing here, and it is
sized so that reading is not something to ration. Reveals are the scarce one. Both are in
`hirify me`, and in `hirify me --json` under `quota.read` and `quota.reveal`.

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
hirify me
hirify feeds
hirify feed <id> [--limit N]
hirify search "<query>" [--limit N] [--grade G]
```

`me` reports the plan, the reveals left, the vacancy opens left today, and reveal usage over 7 and
30 days. Check it before spending reveals. Both allowances come as one number, not a fraction.

`feeds` lists saved searches as `<id> <name>`, with `(off)` for an inactive one. `feed <id>` returns
that feed's vacancies; `search` takes a free-text query.

Vacancy cards print as:

```
<slug>
  <title> · <company or "company hidden">
  [<remote> · <format> · <employment> · <english> · <salary> · verified]
```

Cards never carry contacts. `company hidden` means the name is revealed by `reveal`, not that the
field is broken.

## Read: one vacancy in full

```bash
hirify read <slug>
```

The card plus everything else the vacancy page shows: area, grade, skills, location, when it was
posted, the page address, and the description as text. This is the command that decides fit, and it
is deliberately cheap.

It costs one vacancy open from the daily allowance, and the same vacancy read again the same day
costs nothing. The allowance is shared with the site, so a vacancy the user already opened in a
browser is already paid for. The output states whether an open was used and how many are left.

The last line before that says which way to apply:

- `Apply on Hirify: hirify apply <slug>` - the vacancy is hosted here.
- `Where to apply: hirify reveal <slug> (uses 1 reveal)` - it came from elsewhere, so the user
  applies themselves. Take this from `read` rather than finding out from a refusal on `apply`.

Contacts, the apply destination and where the vacancy came from are never in this answer. That is
what `reveal` is for.

With `--json`, `data.description` is HTML (`data.description_format` says so) and the text output is
the same content flattened for a terminal. `charged` and `quota` sit next to `data`.

Refusals: `there is no vacancy with that slug.`, and, when the day's opens are spent, `you have
opened as many vacancies today as the daily allowance covers.` - feeds and search still work then,
and so does any vacancy already read today.

## Reveal: where to apply

```bash
hirify reveal <slug>
```

Spends 1 reveal and returns the company, its LinkedIn page when known, and one or more
contacts: an address, a form URL, or a link. Revealing the same vacancy again returns the same thing
and spends nothing, so a repeat is safe. The output states whether a reveal was used and how many
are left.

Shortlist with `read` first. A reveal spent at random is spent.

## Apply: only on Hirify

```bash
hirify profiles
hirify apply <slug> [--profile <id>] [--cover "<text>"]
```

`profiles` lists what the user can apply with: `<profile_id> <name> [status · incomplete]`.

`apply` sends an application through Hirify. **Ask the user first, every time, and show what you are
sending.** It cannot be undone.

- `--profile` is required when the user has more than one profile. With exactly one, it is chosen
  automatically. Never guess between several.
- `--cover` is optional, at most 10000 characters. Write it from what the user told you and show
  them the draft first.

Answers:

- success: `Applied. Application <id>, status <status>.` Nothing follows up: the recruiter replies
  where they choose to.
- `there is no vacancy with that slug.`
- a refusal in the server's own words, which covers archived, flagged, someone else's profile, and
  **vacancies not hosted on Hirify**. For those, use `reveal` and let the user apply themselves.
- `the application could not be sent right now.` means our side failed, not the user's data.

## Saved searches and delivery

```bash
hirify feed create "<name>" [--filters '<json>'] [--telegram|--no-telegram] [--webhook <id>]
hirify feed delivery <id> [--telegram|--no-telegram] [--webhook <id>|--no-webhook]
hirify webhooks
hirify webhooks create "<name>" <url>
```

These change the user's account. Propose, get a yes, then run them.

`--filters` takes the same criteria the site's filter form produces, as JSON. Omitting it saves a
feed with no criteria, which means "send me everything" and is legal.

`webhooks create` answers with the endpoint and a **secret shown once**. Hand it to the user
immediately and tell them to store it: it signs every delivery and cannot be shown again.

## Feedback

```bash
hirify feedback <bug|feature> "<title>" --body "<text>" [--vacancy <slug>]
```

Title 5 to 140 characters, body 10 to 5000. Ask the user before sending and send their words.
The answer gives a ticket number, or says there is no number yet. There is no page to open, nothing
writes back to the user, and no reply, fix or date is promised. Report that it was passed on and
stop there.

Refusals: too many reports in a short time (with the wait in seconds), the channel being off, or the
report not being accepted.

## Failure modes worth knowing

| Message | What it means | What to do |
|---|---|---|
| `you are not signed in yet` | no stored access | ask the user to run `hirify login` |
| `your sign-in is no longer valid` | the session expired past renewal | ask the user to run `hirify login` |
| `the key was not accepted (401)` | a manual key was revoked or truncated | new key from the account page |
| `no access (403)` | missing permission, or the plan does not cover agent access | sign in again, or check the plan |
| `you have no reveals left right now` | the reveal budget is spent | reading still works; `hirify me` shows what is left |
| `you have opened as many vacancies today...` | the day's vacancy opens are spent | feeds, search and anything already read today still work |
| `too many requests in a short time` | asking faster than the API allows | wait the seconds it names, then carry on |
| `something went wrong on our side` | our fault, not the request | retry in a minute |
| `the network seems to be unavailable` | no connection | retry |
