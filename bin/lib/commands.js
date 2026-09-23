import { CliError } from './errors.js'
import { flag, options, CLI_ONLY } from './cli.js'
import { serverMessage } from './messages.js'
export const CARD_FIELDS = ['slug', 'title', 'company_masked', 'remote_type', 'work_format', 'english_level', 'salary']
export function createCommands({ api, output, config, signal, event, fields }) {
const { callCapability, resolveCapability, agentDiscovery } = api
const console = output.console
const VERSION = config.version
const FEEDBACK_TYPES = ['bug', 'feature']
const count = v => typeof v === 'number' && Number.isFinite(v) ? v : null
const die = (message, exitCode = 1) => { throw new CliError(api.lastError?.code || 'command_failed', message, { ...api.lastError, exitCode }) }
const out = (data, render) => {
  if (output.jsonMode) output.json(data)
  else { if (fields) renderGeneric(data, fields.split(',').map(x => x.trim()).filter(Boolean)); else render(); const notice = data?.meta?.notice?.message; if (typeof notice === 'string' && notice.trim()) console.log('\nNotice: ' + notice.trim()) }
}
async function cmdAccountShow() {
  const body = await callCapability('account.status')
  const d = body?.data ?? {}
  const left = count(d?.quota?.reveal?.remaining)
  // Reading one vacancy in full has its own daily allowance, so it gets its own line.
  // Without it an agent planning a session can only find the wall by hitting it.
  const reads = count(d?.quota?.read?.remaining)
  // So does applying, and this line was missing while the skill told agents that applying
  // spends nothing. The server has reported `quota.apply` all along; dropping a budget the
  // server publishes is the same error as inventing one, pointing the other way.
  const applies = count(d?.quota?.apply?.remaining)
  const u = d?.usage?.reveal ?? {}
  // Whatever the server sent, and nothing else: a period it left out is simply not shown.
  const spent = [[u.today, 'today'], [u.last_7d, 'in 7d'], [u.last_30d, 'in 30d']]
    .filter(([n]) => count(n) !== null)
    .map(([n, when]) => `${n} ${when}`)
  out(body, () => {
    console.log(`plan:    ${d?.plan ?? '-'}`)
    // How many are left, and no denominator. Reveals are not a fraction of a number the
    // person has, so `N of M` would be inventing the M.
    console.log(`reveals: ${left === null ? '-' : `${left} left`}`)
    if (reads !== null) console.log(`opens:   ${reads} left today`)
    if (applies !== null) console.log(`applies: ${applies} left today`)
    if (spent.length) console.log(`usage:   ${spent.join(' · ')}`)
  })
}

async function cmdFeedList() {
  const body = await callCapability('feeds.list')
  const list = body?.data ?? []
  out(body, () => {
    if (!list.length) return console.log('You have no feeds yet. Save a filter on hirify.me and it becomes a feed.')
    for (const f of list) {
      const off = f.is_active === false ? '  (off)' : ''
      console.log(`${String(f.id ?? '-').padEnd(6)} ${f.name || '(untitled)'}${off}`)
    }
    console.log(`\nVacancies from a feed: hirify feed show <id>`)
  })
}

/**
 * The head of a vacancy, printed the same whether it comes from a list or from `read`.
 * Fields come straight from the API's vacancy resource: a card carries no contacts by
 * design, and for premium companies the name arrives masked.
 *
 * One function on purpose. A card that looks different depending on which command drew
 * it is a card an agent has to learn twice.
 */
function vacancyHead(v) {
  // `company_masked` is a FLAG meaning "the name is hidden until you reveal", not the
  // name itself. It used to be printed as it came, and cards ended up saying "- true".
  const company = v.company || (v.company_masked ? 'company hidden' : '-')
  // Some of these arrive as arrays: live data has `work_format: []` next to
  // `employee_type: ['employment']`. An empty array is truthy, so it used to survive
  // the filter and print as a blank slot between two separators: "[usa ·  · b2]".
  const label = (x) => (Array.isArray(x) ? x.filter(Boolean).join('/') : x)
  const bits = [v.remote_type, v.work_format, v.employee_type, v.english_level].map(label).filter(Boolean)
  if (v.salary && (v.salary.min || v.salary.max)) {
    const { min, max, currency } = v.salary
    bits.push([min, max].filter(Boolean).join('-') + (currency ? ` ${currency}` : ''))
  }
  if (v.verified) bits.push('verified')
  // The slug is the handle every other command takes, so it leads the card. A card
  // without one is still worth printing for its title, but the first line has to say
  // that there is nothing to copy, not print the word `undefined` where a slug goes.
  return `${v.slug ?? '-'}\n  ${v.title || '-'} · ${company}${bits.length ? `\n  [${bits.join(' · ')}]` : ''}`
}

function printVacancies(list, meta) {
  if (!list.length) return console.log('Nothing found.')
  for (const v of list) console.log(vacancyHead(v))

  const page = count(meta?.page)
  const perPage = count(meta?.per_page)
  const lastPage = count(meta?.last_page)
  const total = count(meta?.total)

  // `of N` is printed only when N is larger than what came back, because only then is it a
  // total and not a restatement of the page. The agent search endpoint currently answers
  // with the size of the page it just returned, and "Showing 50 of 50" reads as "that is
  // the whole board", which sends an agent away from vacancies that are there. The moment
  // the server sends a real total, this prints it, with no change here.
  const of = total !== null && total > list.length ? ` of ${total}` : ''
  // `of L` once there is more than one page, on the last page too: "page 4 of 4" is how
  // you know you have reached the end rather than lost the rest.
  const where = page === null ? '' : `, page ${page}${lastPage !== null && lastPage > 1 ? ` of ${lastPage}` : ''}`
  console.log(`\nShowing ${list.length}${of}${where}.`)
  // The order the product asks for: read what looks right, reveal only what fits.
  console.log('Read one: hirify vacancy read <slug>')
  console.log('Where to apply: hirify vacancy reveal <slug> (uses 1 reveal)')

  // A full page is the only honest sign that there may be another one while `last_page`
  // says otherwise. Offering the next page costs nothing if it turns out to be empty.
  const more = lastPage !== null && page !== null && lastPage > page
    ? true
    : perPage !== null && list.length >= perPage
  if (more && page !== null) console.log(`More: add --page ${page + 1}`)
}

/** The vacancies in one saved feed, using the criteria the feed already holds. */
async function cmdFeedShow(args, words) {
  const [id] = words
  if (!id) die('a feed id is required: hirify feed show <id>  (list them with hirify feed list)')

  // A feed already carries its own criteria, so only the two that say which slice of it to
  // return travel from here. Without `--page` the second page of a feed was unreachable.
  const p = new URLSearchParams()
  const limit = flag(args, '--limit'); if (limit) p.set('per_page', limit)
  const page = flag(args, '--page'); if (page) p.set('page', page)

  const body = await callCapability('feeds.vacancies', { params: { feed_id: id }, query: p })
  out(body, () => printVacancies(body?.data ?? [], body?.meta))
}

/**
 * Search the board. The words are the phrase to look for; every option is passed on to the
 * API as it was written.
 *
 * The CLI keeps no list of filters on purpose. The endpoint accepts the same criteria the
 * site's own filter form produces, and the site can express all of them: a CLI that names
 * them one flag at a time decides what is expressible, and it decided wrong for a long time.
 * So every option travels by one rule, and a criterion added on the server works from here
 * the day it ships.
 *
 * This is also why no example here names a criterion. `hirify filter guide` is the
 * vocabulary, the server writes it, and an example frozen in this file would be a second
 * answer to the same question, going stale at its own pace.
 */
async function cmdVacancySearch(args, words) {
  const p = new URLSearchParams()

  // The phrase first, so an explicit `--search` still wins if someone writes both.
  //
  // `search` and `per_page` are the only two parameter names this file is allowed to know,
  // and they are structural rather than vocabulary: this command exists to put the words on
  // `search`, and `--limit` has to land somewhere. Every other name belongs to the server
  // and is fetched with `hirify filter guide`. Adding a third name here is the regression.
  const phrase = words.join(' ')
  if (phrase) p.set('search', phrase)

  for (const [name, value] of options(args)) {
    if (CLI_ONLY.has(name)) continue
    // `--limit` is what this CLI has always called it. The API calls it `per_page`, and
    // that is the name the server publishes, so both arrive at the same parameter.
    p.set(name === 'limit' ? 'per_page' : name, value)
  }

  const body = await callCapability('vacancies.search', { query: p })
  out(body, () => printVacancies(body?.data ?? [], body?.meta))
}

/**
 * The description as the site shows it, turned into something a terminal can print. The
 * API sends it as HTML (`description_format`), so the tags have to go somewhere: a block
 * ends with a line break and a list item starts with a dash. Nothing is dropped or
 * shortened here, and `--json` hands over the original untouched.
 */
function asText(html) {
  return String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|ul|ol|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    // Last, or `&amp;lt;` would come out as `<` rather than as the `&lt;` somebody wrote.
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A timestamp as the day it names. The hour a vacancy was imported tells nobody anything. */
const dateOnly = (v) => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null)

/**
 * The rows under the head, each one printed only when the server sent something for it.
 * They are collected rather than printed straight, so a vacancy that happens to carry
 * none of them does not get a blank line standing in for the block.
 */
function detailRows(pairs) {
  return pairs
    .map(([label, value]) => [label, Array.isArray(value) ? value.filter(Boolean).join(' · ') : value])
    .filter(([, text]) => text)
    .map(([label, text]) => `${(label + ':').padEnd(10)}${text}`)
}

/**
 * One vacancy in full, with the text a person reads on the site. This is the command an
 * agent shortlists with, so it is deliberately the cheap one: it counts against the day's
 * vacancy opens, which is a generous allowance, and not against the reveal budget.
 *
 * The same vacancy read twice in a day costs nothing the second time.
 */
async function cmdVacancyRead(args, words) {
  const [slug] = words
  if (!slug) {
    die('a vacancy slug is required: hirify vacancy read <slug>' +
      '\n        Slugs come from hirify vacancy search or hirify feed show.')
  }

  const res = await callCapability('vacancies.read', { params: { slug }, allow: [200, 404] })
  if (res.status === 404) die('there is no vacancy with that slug.')

  const d = res.body?.data ?? {}
  // Codes, names and plain strings all arrive in these lists. English first: the rest of
  // the output is English, and a card that switches language mid-way reads as a glitch.
  const names = (list) => (Array.isArray(list) ? list.map((x) => x?.name_en || x?.name || x?.code || x).filter(Boolean) : [])

  out(res.body, () => {
    console.log(vacancyHead(d))

    const rows = detailRows([
      ['area', names(d.specializations)],
      ['grade', names(d.grades)],
      ['skills', names(d.skills)],
      ['location', [...names(d.regions), ...names(d.cities)]],
      ['posted', dateOnly(d.created_at)],
      ['page', d.url],
    ])
    if (rows.length) console.log('\n' + rows.join('\n'))

    const text = d.description ? asText(d.description) : ''
    console.log(text ? `\n${text}\n` : '\nThis vacancy has no text on it.\n')

    // Which of the two ways to apply this one takes, from the server's own flag. Guessing
    // it from anything else is how a card came to promise an apply that answered 422.
    console.log(d.can_apply_directly
      ? `Apply on Hirify: hirify vacancy apply ${d.slug ?? slug}`
      : `Where to apply: hirify vacancy reveal ${d.slug ?? slug} (uses 1 reveal)`)

    console.log(res.body?.charged === false
      ? '(no vacancy open used: this one was already opened today)'
      : '(1 vacancy open used)')
    const left = count(res.body?.quota?.remaining)
    if (left !== null) console.log(`${left} ${left === 1 ? 'open' : 'opens'} left today`)
  })
}

/**
 * One contact line: the address as it is, with the type only when it adds something.
 * An unknown shape is still printed as it came, because the contact is the whole point
 * of the command; an empty slot returns nothing, so no line is printed for it.
 */
function contactLine(c) {
  if (typeof c === 'string') return c
  const value = c?.value ?? c?.url ?? c?.email ?? null
  if (value) return c?.type && c.type !== 'url' ? `${value}  (${c.type})` : value
  return c === null || c === undefined ? null : JSON.stringify(c)
}

async function cmdVacancyReveal(args, words) {
  const [slug] = words
  if (!slug) die('a vacancy slug is required: hirify vacancy reveal <slug>')
  const body = await callCapability('vacancies.reveal', { params: { slug } })
  const d = body?.data ?? {}
  out(body, () => {
    console.log(`company:  ${d.company ?? '-'}`)
    if (d.linkedin) console.log(`linkedin: ${d.linkedin}`)
    // A contact arrives as {type, value, short_code}. People and agents want the address,
    // not its JSON: nobody unpacks a raw object by hand while reading a terminal.
    for (const c of d.contacts ?? []) {
      const line = contactLine(c)
      if (line) console.log(`contact:  ${line}`)
    }
    console.log(d.charged === false
      ? '\n(no reveal used: you have revealed this vacancy before)'
      : '\n(1 reveal used)')
    const left = count(d.quota?.remaining)
    if (left !== null) console.log(`${left} ${left === 1 ? 'reveal' : 'reveals'} left`)
  })
}

/**
 * Hide vacancies or whole companies so they stop coming back in search and feeds. The same
 * list the website's "Hide" button writes, so it works in both directions. Free and not
 * limited; --undo brings them back. Up to 100 per call: the server takes them in one request.
 */
function printHidden(d, one, many, undo) {
  const n = count(d.updated) ?? 0
  const noun = n === 1 ? one : many
  console.log(undo
    ? `${n} ${noun} unhidden.`
    : `${n} ${noun} hidden. ${n === 1 ? 'It no longer appears' : 'They no longer appear'} in your search and feeds.`)
  if (Array.isArray(d.not_found) && d.not_found.length) console.log(`not found: ${d.not_found.join(', ')}`)
}

async function cmdVacancyHide(args, words) {
  if (!words.length) die('at least one vacancy slug is required: hirify vacancy hide <slug>...')
  const undo = args.includes('--undo')
  const body = await callCapability('vacancies.hide', { payload: { slugs: words, hidden: !undo } })
  out(body, () => printHidden(body?.data ?? {}, 'vacancy', 'vacancies', undo))
}

async function cmdCompanyHide(args, words) {
  const vacancy = flag(args, '--vacancy')
  if (!words.length && !vacancy) die('name the company, or pass one of its vacancies: hirify company hide "<name>" | --vacancy <slug>')
  const undo = args.includes('--undo')
  const payload = { hidden: !undo, ...(words.length ? { names: words } : {}), ...(vacancy ? { slugs: [vacancy] } : {}) }
  const body = await callCapability('companies.hide', { payload })
  out(body, () => printHidden(body?.data ?? {}, 'company', 'companies', undo))
}

/**
 * Report a bug or ask for a feature. Free: it does not touch the reveal limit.
 *
 * What is required is checked here, because a missing `--body` is a fact about the command
 * and needs no round trip. How long a title may be is NOT checked here: that is the
 * server's rule, it has changed before, and a copy of it in this file is a copy that goes
 * stale and starts refusing reports the server would have taken. The server's own words
 * come back instead.
 */
async function cmdFeedbackSend(args, words) {
  const [type, title] = words
  if (!FEEDBACK_TYPES.includes(type)) {
    die('say what kind of report this is, bug or feature:\n' +
      '        hirify feedback send bug "<title>" --body "<what happened>"\n' +
      '        hirify feedback send feature "<title>" --body "<what you need>"')
  }

  const text = flag(args, '--body')
  const vacancy = flag(args, '--vacancy')

  if (!title) die('a title is required: hirify feedback send ' + type + ' "<title>" --body "<text>"')
  if (!text) die('the report needs a body: add --body "<text>"')

  const res = await callCapability('feedback.send', {
    payload: { type, title, body: text, ...(vacancy ? { vacancy_slug: vacancy } : {}), ...(flag(args, '--idempotency-key') ? { idempotency_key: flag(args, '--idempotency-key') } : {}) },
    allow: [201, 202, 404, 422, 429, 502, 503],
  })

  const d = res.body?.data ?? {}

  if (res.status === 429) {
    const wait = Number(res.retryAfter)
    die('too many reports in a short time.' +
      (Number.isFinite(wait) && wait > 0 ? ` Please try again in ${wait} seconds.` : ' Please try again a bit later.'))
  }
  if (res.status === 502) {
    // Not queued and not retried on our side, because a retry would not fix it. Say that
    // the fault is ours, so nobody rewrites a perfectly good report thinking it was them.
    throw new CliError('outcome_unknown', 'The report result could not be confirmed. Check its status before trying again.', { status: 502 })
  }
  if (res.status === 404 || res.status === 503) {
    // 404 means this API does not have the feedback endpoint at all, 503 that it has it
    // and it is switched off. Both are the same fact for the person in front of us, and
    // "not found (404)" would send them looking for a mistake in their own command.
    die('the feedback channel is not available right now. Please try again later.')
  }
  if (res.status === 422) {
    // The server owns the lengths and it says which one is wrong, so its sentence is the
    // useful one. Ours would have to name a bound, and naming a bound we do not own is how
    // a client starts telling people a limit that moved.
    die(serverMessage(res.body) || 'the report was not accepted. Please check the title and the text and try again.')
  }

  // Say `number`, never `id`. The number is the one a human at Hirify recognises; the id
  // is for reading the ticket through their API, and telling a person the id would give
  // them a number nobody there can look up. There is deliberately no link to a report:
  // ticket numbers are sequential, and a public address would let anyone walk through
  // other people's complaints. And nothing writes back afterwards, so we promise nothing.
  const ticket = d.ticket?.number ?? (typeof d.ticket === 'number' ? d.ticket : null)

  out(res.body, () => {
    if (d.status === 'queued') {
      console.log('Thank you. Your report was received and is waiting to be sent.')
    } else if (ticket && d.ticket?.duplicate) {
      console.log(`Thank you. This matches a report we already have, number ${ticket}.`)
    } else if (ticket) {
      console.log(`Thank you. Your report was passed on as number ${ticket}.`)
    } else {
      console.log('Thank you. Your report was passed on. There is no number for it yet.')
    }
    if (d.reference) console.log(`reference: ${d.reference}`)
  })
}

/** The profiles a person can apply with. Free, and the list `vacancy apply` picks from. */
async function cmdProfileList() {
  const body = await callCapability('profiles.list')
  const list = body?.data ?? []
  out(body, () => {
    if (!list.length) {
      return console.log('You have no profiles yet. Create one on hirify.me, then you can apply.')
    }
    for (const p of list) {
      const state = [p.status, p.is_complete === false ? 'incomplete' : null].filter(Boolean).join(' · ')
      console.log(`${String(p.profile_id ?? '-').padEnd(6)} ${p.name || p.title || '(untitled)'}${state ? `  [${state}]` : ''}`)
    }
    console.log('\nApply with one: hirify vacancy apply <slug> --profile <id>')
  })
}

/**
 * Send a real application, on Hirify, to a real person. This is the one command here
 * that cannot be undone, so it never guesses: if the account has several profiles and
 * none was named, the server refuses and we pass that on rather than picking one.
 */
async function cmdVacancyApply(args, words) {
  const [slug] = words
  if (!slug) die('a vacancy slug is required: hirify vacancy apply <slug> [--profile <id>]')

  const profile = flag(args, '--profile')
  const cover = flag(args, '--cover')

  // A profile id is a number, and that is a fact about the flag, not a server limit. How
  // long a cover letter may be is the server's rule and is not copied here: it answers 422
  // in its own words, and those travel back untouched.
  if (profile !== null && !/^\d+$/.test(profile)) die('--profile takes a profile id, a number. See hirify profile list.')

  const res = await callCapability('applications.apply', {
    params: { slug },
    payload: { ...(profile ? { profile_id: Number(profile) } : {}), ...(cover ? { cover_letter: cover } : {}) },
    allow: [201, 404, 422, 502],
  })

  if (res.status === 404) die('there is no vacancy with that slug.')
  if (res.status === 502) throw new CliError('outcome_unknown', 'The application result could not be confirmed. Check your applications before trying again.', { status: 502 })
  if (res.status === 422) {
    // These come from the same rules the site applies: archived, flagged, hosted
    // elsewhere, someone else's profile. They are written to be read, so pass them on
    // instead of flattening every one of them into "something went wrong".
    die(serverMessage(res.body) || 'the application was not accepted. Please check the vacancy and the profile.')
  }

  const d = res.body?.data ?? {}
  out(res.body, () => {
    console.log(d.application_id
      ? `Applied. Application ${d.application_id}, status ${d.status ?? 'sent'}.`
      : `Applied. Status ${d.status ?? 'sent'}.`)
    console.log('Hirify does not follow up for you: the recruiter replies where they choose to.')
  })
}

/** Save a search, the same thing a person does with the filter form on the site. */
async function cmdFeedCreate(args, words) {
  const [name] = words
  // Required is ours to check; how long is the server's, and it says so in its own words.
  if (!name) die('a name is required: hirify feed create "<name>" [--filters \'<json>\']')

  // An empty set of criteria is legal and means "send me everything", exactly as it does
  // on the site. So the field is always sent, and only bad JSON is refused.
  let filters = {}
  const raw = flag(args, '--filters')
  if (raw) {
    try {
      filters = JSON.parse(raw)
    } catch {
      // No example criterion in the message: the shape is ours to state, the keys are not.
      die('--filters expects JSON: the same criteria the site\'s filter form produces.\n' +
        '        Their names and values: hirify filter guide')
    }
  }

  const payload = { name, filters, notify_telegram: false }
  if (args.includes('--no-telegram')) payload.notify_telegram = false
  if (args.includes('--telegram')) payload.notify_telegram = true
  const webhook = flag(args, '--webhook')
  if (webhook) {
    if (!/^\d+$/.test(webhook)) die('--webhook takes an endpoint id, a number. See hirify webhook list.')
    payload.webhook_endpoint_id = Number(webhook)
  }

  const res = await callCapability('feeds.create', { payload, allow: [200, 201, 422] })
  if (res.status === 422) die(serverMessage(res.body) || 'the feed was not created. Please check the criteria.')

  out(res.body, () => {
    const feed = res.body?.data ?? {}
    printFeedState(feed, 'Saved.')
    if (!feed.notify_telegram && !feed.webhook_endpoint_id) {
      console.log(`To receive new matches in Telegram: hirify feed deliver ${feed.id ?? '<id>'} --telegram`)
    }
  })
}

/** Change where a feed is delivered, without touching what it searches for. */
async function cmdFeedDeliver(args, words) {
  const [id] = words
  if (!id || !/^\d+$/.test(id)) die('a feed id is required: hirify feed deliver <id> [--telegram|--no-telegram] [--webhook <id>|--no-webhook]')

  const payload = {}
  if (args.includes('--telegram')) payload.notify_telegram = true
  if (args.includes('--no-telegram')) payload.notify_telegram = false
  if (args.includes('--no-webhook')) payload.webhook_endpoint_id = null
  const webhook = flag(args, '--webhook')
  if (webhook) {
    if (!/^\d+$/.test(webhook)) die('--webhook takes an endpoint id, a number. See hirify webhook list.')
    payload.webhook_endpoint_id = Number(webhook)
  }
  if (!Object.keys(payload).length) {
    die('say what to change: --telegram, --no-telegram, --webhook <id> or --no-webhook.')
  }

  const res = await callCapability('feeds.set_delivery', { params: { feed_id: id }, payload, allow: [200, 404, 422] })
  if (res.status === 404) die('there is no feed with that id. See hirify feed list.')
  if (res.status === 422) die(serverMessage(res.body) || 'the delivery settings were not accepted.')

  out(res.body, () => printFeedState(res.body?.data ?? {}, 'Updated.'))
}

function printFeedState(f, lead) {
  const where = [
    f.notify_telegram ? 'Telegram' : null,
    f.webhook_endpoint_id ? `webhook ${f.webhook_endpoint_id}` : null,
  ].filter(Boolean)
  console.log(`${lead} Feed ${f.id ?? '-'}: ${f.name || '(untitled)'}`)
  console.log(where.length ? `Delivered to: ${where.join(' and ')}` : 'Delivery is off.')
}

/** The delivery endpoints on the account. Free; creating one needs the plan. */
async function cmdWebhookList() {
  const body = await callCapability('webhooks.list')
  const list = body?.data ?? []
  out(body, () => {
    if (!list.length) {
      return console.log('You have no delivery endpoints yet. Create one: hirify webhook create "<name>" <url>')
    }
    for (const w of list) {
      console.log(`${String(w.id ?? '-').padEnd(6)} ${w.name || '(untitled)'}  ${w.url ?? '-'}${w.state ? `  [${w.state}]` : ''}`)
    }
    console.log('\nSend a feed to one: hirify feed deliver <feed id> --webhook <id>')
  })
}

async function cmdWebhookCreate(args, words) {
  const [name, url] = words
  if (!name || !url) die('both a name and an address are required: hirify webhook create "<name>" <url>')

  const res = await callCapability('webhooks.create', { payload: { name, url }, allow: [201, 403, 422] })
  if (res.status === 403) die(serverMessage(res.body) || 'creating a delivery endpoint is not available on this account.')
  if (res.status === 422) die(serverMessage(res.body) || 'that address was not accepted.')

  const d = res.body?.data ?? {}
  out(res.body, () => {
    console.log(`Created. Endpoint ${d.id ?? '-'}: ${d.name || '(untitled)'} ${d.url ?? ''}`.trimEnd())
    // The secret is shown once and never again, so it gets its own line and a warning
    // rather than sitting inside a sentence someone may scroll past.
    if (d.secret) {
      console.log(`\nsecret: ${d.secret}`)
      console.log('Store it now. It is shown once and it signs every delivery.')
    }
  })
}

const INTRO = `hirify - job search for AI agents

Hirify is a job board. This CLI is how an agent works it for someone: the same vacancies, the
same saved filters and the same account they have at hirify.me.

Signing in
  hirify login prints a link and tries the browser when available. A person confirms access.
  Manual sign-in: hirify login --no-browser. For automation, use HIRIFY_KEY or hirify auth --stdin; get a key at
  hirify.me/account/api-access.

Start with what the account already has
  Most people who use Hirify have saved a filter or two on the site. Those are feeds, and they
  are the best place to start, because someone has already said in them what they want.

    hirify account show          the plan and allowances
    hirify feed list             what this account has saved
    hirify feed show 31          the vacancies in one of them

  When no feed fits, search the whole board. Search takes a phrase, and any criterion the
  site's own filter form can express, written as an option:

    hirify vacancy search "senior go"
    hirify vacancy search "senior go" --page 2
    hirify vacancy search "senior go" --<criterion> <value>

  The criteria are the server's, not this CLI's, and nothing here names one on purpose: a
  name written into this text would be a copy, and copies go stale quietly. Ask instead:

    hirify filter guide

  It prints what search can filter on and what the values are, written by the server from
  the same source the site searches with. An option is sent on under the name you gave it;
  give one twice and the values are joined, the way the site sends a filter with several
  values.

Read before you spend anything
  A card is a headline: title, company, terms. Fit is decided in the text.

    hirify vacancy read senior-go-engineer

  This prints the whole vacancy, and it also says which of the two ways to apply this one
  takes, so you do not have to work that out or find out from a refusal.

What costs what
  Lists and searches are free.
  Reading one vacancy in full spends one of the Agent API's daily vacancy opens. There are
  many of them, and reading a vacancy again the same day costs nothing. Read as much as you
  need to.
  Revealing where to apply spends 1 reveal, and reveals are the scarce one. Protect that
  number: shortlist by reading, then reveal only the ones worth applying to.
  Applying has a daily allowance of its own. It is not the free step it looks like.
  hirify account show has all three, and it is the only place they are current.

Where to apply
    hirify vacancy reveal senior-go-engineer

  Gives the company, its LinkedIn page when we know it, and the address to send the
  application to. Revealing the same vacancy again returns the same thing and costs nothing.

Applying
  Most vacancies here came from somewhere else: company pages, Telegram channels, other
  boards. For those, reveal brings back the address, and the application is made there rather
  than through Hirify.
  Vacancies hosted on Hirify can be applied to from here:

    hirify profile list
    hirify vacancy apply senior-go-engineer --profile 4 --cover "..."

  An application reaches a real person and cannot be recalled. Ask first, every time, and
  show what you are about to send. Nothing follows up afterwards: the recruiter replies
  where they choose to.

Two more things
  A saved search can be created from here and delivered to Telegram or to a server of yours:
  hirify feed create, hirify feed deliver, hirify webhook list.
  Something broken or missing: hirify feedback send bug "<title>" --body "<what happened>". It
  reaches the team and costs nothing.

If a command you need is not here
  hirify api call <capability> invokes any capability Hirify lists in its manifest and prints
  the answer as it comes back, so a capability without its own command is a detour and not a
  dead end. Inputs go in --data as a JSON object. Prefer the commands above where one fits:
  they say what a thing costs and what a refusal means, and this one cannot.

If you are an agent
  Install the working rules once: npx skills add hirifyme/hirify-cli. They cover the order
  above, what needs the person's permission before you do it, and what each refusal means.

Use --json for structured results and --error-format=json for structured errors.
The full list of commands: hirify --help`

async function cmdIntro() {
  // The intro is release-approved text published on the public agent well-known, so it can be
  // refreshed without shipping a new CLI. It needs no sign-in and no manifest. When Hirify
  // cannot be reached, or publishes none, the built-in text below stands in - so `hirify intro`
  // and the sign-in help it carries work before login and with no network.
  let intro
  try { intro = (await agentDiscovery()).intro } catch (error) { if (signal.aborted) throw error; event('intro', { code: error.code }) }
  const text = typeof intro === 'string' && intro ? intro : INTRO
  if (output.jsonMode) output.json({ intro: text }); else console.log(text)
}

// The fields the compact vacancy view keeps from a full summary card: the shortlist signal a
// scan needs, without the detail `vacancy read` adds. This is the selection the context budget
// is measured against - twenty of them serialize small - so a page of results does not spend an
// agent's context on fields it does not act on here. `--fields` narrows it; `--json` keeps the
// whole card.


// The projections whose compact selection is the vacancy card. `api call` renders these with
// CARD_FIELDS by default, the same shortlist view `vacancy search` prints.
const KNOWN_CARD_PROJECTIONS = new Set(['vacancy.summary'])

// The field names asked for with --fields, or null for "every field the answer carries".
const fieldList = (args) => {
  const raw = flag(args, '--fields')
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null
}

// One item reduced to the fields asked for, keeping only the ones the server actually sent, so
// a selection never manufactures a field the API did not return.
function selectFields(item, fields) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
  const keys = (fields ?? Object.keys(item)).filter((k) => Object.hasOwn(item, k))
  return Object.fromEntries(keys.map((k) => [k, item[k]]))
}

// A value on one line: an address or a number as it is, a list joined, an object as compact
// JSON. Nothing is dropped; a missing value reads as a dash rather than the word undefined.
const scalarText = (v) => {
  if (v === null || v === undefined) return '-'
  if (Array.isArray(v)) return v.map(scalarText).filter((s) => s !== '').join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * A compact view of a capability answer the CLI has no bespoke command for. It prints the
 * fields the server returned, one per line, item by item, so `hirify api call` reads without
 * --json. `--fields` narrows to the names asked for, and a known card projection is narrowed to
 * the shortlist selection by default. It never invents a field, and --json still hands over the
 * whole canonical answer.
 */
function renderGeneric(body, fields = null) {
  const payload = body && typeof body === 'object' && !Array.isArray(body) && 'data' in body ? body.data : body
  const items = Array.isArray(payload) ? payload : [payload]
  const blocks = []
  for (const item of items) {
    const picked = selectFields(item, fields)
    if (picked === null || typeof picked !== 'object' || Array.isArray(picked)) {
      const text = picked === null || picked === undefined ? '' : String(picked)
      if (text) blocks.push(text)
      continue
    }
    const rows = Object.entries(picked).map(([k, v]) => `${k}: ${scalarText(v)}`)
    if (rows.length) blocks.push(rows.join('\n'))
  }
  const text = blocks.join('\n\n')
  if (text) console.log(text)
}

// Which method takes a request body, so a `--data` input lands in the body rather than the
// query string when the manifest does not say where it goes.
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * The generic call. Every other command is a shape we chose for one job; this one takes a
 * capability by its id, looks it up in the manifest, and sends the request the manifest
 * describes, so a capability this CLI has no command for is a detour rather than a dead end -
 * and a capability the server adds later is reachable from here with no change to this file.
 *
 * Inputs travel in `--data` as one JSON object. Each value goes where the manifest says it
 * belongs: into the path, the query string, or the body. The answer is printed as it arrived,
 * refusals included: a sentence of ours in place of the server's own reply is exactly what
 * this command exists to get out of the way, and that also means it cannot say what a call
 * costs, which the named commands can.
 */
async function cmdApiCall(args, words) {
  const [id] = words
  if (!id) {
    die('a capability id is required: hirify api call <capability>\n' +
      '        The ids are the ones Hirify lists in its manifest; the named commands cover the\n' +
      '        common ones, and this reaches the rest. Inputs go in --data as a JSON object.')
  }

  // Read the inputs before reaching the server: a typo in --data is the caller's, and no
  // manifest is needed to see it.
  const data = flag(args, '--data')
  let inputs = {}
  if (data) {
    try {
      inputs = JSON.parse(data)
    } catch {
      die('--data expects JSON, for example --data \'{"slug":"senior-go-engineer"}\'')
    }
  }
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    die('--data expects a JSON object of inputs, for example --data \'{"page":2}\'')
  }

  const cap = await resolveCapability(id)

  // Where each input belongs, from the manifest. An input the manifest does not place goes to
  // the body on a writing method and to the query otherwise, which is where an unplaced input
  // most usefully lands.
  const locations = (cap.inputs && cap.inputs.locations) || {}
  const writes = BODY_METHODS.has(cap.method.toUpperCase())
  const params = Object.create(null)
  const query = new URLSearchParams()
  const body = Object.create(null)
  let hasBody = false

  for (const [key, value] of Object.entries(inputs)) {
    const where = Object.hasOwn(locations, key) ? locations[key] : (writes ? 'body' : 'query')
    if (where === 'path') {
      params[key] = value
    } else if (where === 'body') {
      body[key] = value
      hasBody = true
    } else {
      query.set(key, Array.isArray(value)
        ? value.join(',')
        : value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
  }

  // The immutable catalogue resolves this ID to the same description throughout the command.
  const res = await callCapability(id, { params, query, payload: hasBody ? body : null, raw: true })

  // Under --json, or when the server refused, or when the answer is not JSON, the canonical
  // body goes through untouched: --json is the raw contract, a refusal carries the server's own
  // machine-readable words, and a non-JSON answer has no fields to select. Otherwise the answer
  // is rendered compactly - a known card projection narrowed to its shortlist selection, any
  // other shape by its own fields - so `api call` reads without --json and stays small in an
  // agent's context. --fields narrows the selection further.
  const raw = output.jsonMode || res.status >= 400 || res.body === null
  if (raw && !(output.errorJSON && res.status >= 400)) {
    if (res.body !== null) output.json(res.body)
    else if (res.text.trim()) console.log(res.text.trim())
  } else if (res.status < 400) {
    const fields = fieldList(args) ?? (KNOWN_CARD_PROJECTIONS.has(cap.output_projection) ? CARD_FIELDS : null)
    renderGeneric(res.body, fields)
  }
  // On stderr, so that stdout stays the server's answer and nothing else.
  if (res.status >= 400) throw new CliError(res.error.code, `the server answered ${res.status}. The answer is above.`, res.error)
}

/**
 * The filter vocabulary, printed as the server wrote it.
 *
 * `guide`, not `show`, and the reason is what comes back: this is not a list of keys but
 * the method the site's own filter generator works by, and calling it `show` would promise
 * a list.
 *
 * Nothing about filters is written down in this file, and nothing should be. The endpoint
 * derives the list from the source the site searches with, so it cannot drift; a copy here
 * would start drifting the day it was written.
 */
async function cmdFilterGuide() {
  const res = await callCapability('filters.guide', { allow: [200, 404] })

  // Older servers do not serve it. Say that, rather than "not found (404)", which reads as
  // a mistake in the command. And do not offer a substitute: there is nothing here that
  // knows the filters, and inventing advice about them is the whole problem this fixes.
  if (res.status === 404) {
    die('this Hirify server does not serve the filter guide yet.\n' +
      '        Search still takes every criterion the site\'s filter form can express, but\n' +
      '        their names have to come from someone who knows them.')
  }

  const guide = typeof res.body?.data?.guide === 'string' ? res.body.data.guide.trim() : ''
  if (!guide) die('the server answered without a guide. Please try again in a minute.')

  out(res.body, () => console.log(guide))
}

/** The skill ships through skills.sh now: one command installs it into every harness. */
function cmdSkill() {
  console.log('The rules for your agent install with one command:\n\n  npx skills add hirifyme/hirify-cli\n')
  console.log('It puts them where your agent reads them: Claude Code, Codex, Cursor, OpenCode and others.')
}


return {
  intro: cmdIntro, skill: cmdSkill,
  'account show': cmdAccountShow,
  'vacancy search': cmdVacancySearch, 'vacancy read': cmdVacancyRead, 'vacancy reveal': cmdVacancyReveal, 'vacancy apply': cmdVacancyApply,
  'vacancy hide': cmdVacancyHide, 'company hide': cmdCompanyHide,
  'feed list': cmdFeedList, 'feed show': cmdFeedShow, 'feed create': cmdFeedCreate, 'feed deliver': cmdFeedDeliver,
  'profile list': cmdProfileList, 'webhook list': cmdWebhookList, 'webhook create': cmdWebhookCreate,
  'feedback send': cmdFeedbackSend, 'filter guide': cmdFilterGuide, 'api call': cmdApiCall,
  'capabilities list': async () => output.json(await api.loadManifest()),
  'capabilities show': async (_, words) => output.json(await api.resolveCapability(words[0])),
}
}
