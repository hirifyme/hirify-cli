#!/usr/bin/env node
// Hirify CLI: job search for AI agents.
//
// A thin client over `api.hirify.me/api/agent/*`, the same API the MCP server serves.
// No dependencies: Node 18+ (built-in fetch), runs through `npx hirify`.
//
// Metering, same as on the server: reading vacancies is free and unlimited, revealing a
// contact spends 1 of the daily limit, and revealing the same vacancy again is free.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'

const API = process.env.HIRIFY_API || 'https://api.hirify.me'
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hirify')
// One file for either way of signing in. Working out where the current token came from
// is cheaper from a single `kind` field than from two files that may both exist.
const AUTH_FILE = join(CONFIG_DIR, 'auth.json')
// The key file from 0.1: still read for anyone who has one, never written again.
const LEGACY_KEY_FILE = join(CONFIG_DIR, 'key')

// Asked for at sign-in, all at once, and every one of them before publication on purpose:
// an OAuth token carries exactly what the person agreed to, and nothing can add an ability
// to it later without sending them back through the consent screen. The server narrows the
// set to what it actually supports, so asking for one it does not know yet costs nothing.
const SCOPES = 'agent:read agent:reveal agent:apply agent:manage agent:feedback offline_access'
const CALLBACK_PATH = '/callback'
// How long we wait for the browser. The authorization code lives the same five minutes.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

// Feedback limits, mirrored from the API so a person is told what is wrong before the
// request is sent, in words, instead of getting a field-error object back.
const FEEDBACK_TYPES = ['bug', 'feature']
const TITLE_RANGE = [5, 140]
const BODY_RANGE = [10, 5000]

// Read from package.json rather than repeated here: the server records which client sent
// a report, and a version that drifts from the published one makes that record useless.
const VERSION = (() => {
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return JSON.parse(readFileSync(pkg, 'utf8')).version || '0'
  } catch {
    return '0'
  }
})()
const USER_AGENT = `hirify-cli/${VERSION}`

const HELP = `hirify - job search for AI agents

  hirify login                 sign in through your browser
  hirify me                    your plan and today's remaining reveals
  hirify feeds                 the feeds you saved on the site
  hirify feed <id>             vacancies from one feed      [--limit N]
  hirify search <query>        search vacancies             [--limit N] [--grade G]
  hirify reveal <slug>         WHERE TO APPLY: uses 1 reveal
  hirify profiles              the profiles you can apply with

  hirify apply <slug>          APPLY on Hirify              [--profile N] [--cover T]
  hirify feed create <name>    save a search                [--filters JSON] [--webhook N]
  hirify feed delivery <id>    change how a feed reaches you
  hirify webhooks              your delivery endpoints
  hirify webhooks create <name> <url>

  hirify feedback <kind>       report a bug or ask for a feature  [--body T] [--vacancy S]
  hirify logout                sign out on this computer

  --json                       raw JSON instead of text

Reading is free and unlimited: me, feeds, feed, search, profiles, webhooks.
Only reveal is metered, and revealing the same vacancy again is free.
apply sends a real application to a real recruiter. Ask the person first.
The limit resets at midnight; hirify me shows what is left.

Rules for your agent: npx skills add hirifyme/hirify-cli
No browser (CI, servers): hirify auth <key>, or the HIRIFY_KEY variable.
Key: hirify.me/account/api-access`

// ── helpers ────────────────────────────────────────────────────────────────
const die = (msg, code = 1) => { console.error(`hirify: ${msg}`); process.exit(code) }

// Options that take a value. Needed by `positional` below: without knowing them we
// cannot tell `--grade senior` (a filter) from `senior` (a search word).
const VALUE_FLAGS = new Set(['--limit', '--grade', '--body', '--vacancy', '--profile', '--cover', '--filters', '--webhook'])

const flag = (args, name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}

/**
 * The arguments that are not options. Every command reads its slug, id or verb through
 * this, because reading `args[0]` directly made a flag look like one: `hirify webhooks
 * --json` was refused as an unknown verb, and `hirify feed --json` asked the server for a
 * feed literally called "--json".
 */
const positional = (args) => {
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (VALUE_FLAGS.has(args[i])) i++
      continue
    }
    rest.push(args[i])
  }
  return rest
}
const out = (data, text) => {
  if (process.argv.includes('--json')) console.log(JSON.stringify(data, null, 2))
  else text()
}

// Text our own server wrote for the agent to read: application rules, address rejections.
// Passing it through beats paraphrasing, because paraphrasing drifts from the real rule.
const serverMessage = (body) => (typeof body?.message === 'string' && body.message ? body.message : null)

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const now = () => Math.floor(Date.now() / 1000)

// ── stored access ──────────────────────────────────────────────────────────
function readSession() {
  if (existsSync(AUTH_FILE)) {
    try {
      const s = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
      if (s && typeof s.access_token === 'string' && s.access_token) return s
    } catch {
      // A damaged file is not worth crashing over: behave as if nobody is signed in.
    }
  }
  if (existsSync(LEGACY_KEY_FILE)) {
    const key = readFileSync(LEGACY_KEY_FILE, 'utf8').trim()
    if (key) return { kind: 'key', access_token: key }
  }
  return null
}

function writeSession(session) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(AUTH_FILE, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 })
}

function forgetSession() {
  let had = false
  for (const file of [AUTH_FILE, LEGACY_KEY_FILE]) {
    if (existsSync(file)) { rmSync(file); had = true }
  }
  return had
}

const NOT_SIGNED_IN =
  'you are not signed in yet. Run `hirify login` and your browser will open.\n' +
  '        No browser (CI, servers): `hirify auth <key>`, or set HIRIFY_KEY.\n' +
  '        Key: hirify.me/account/api-access'

/**
 * The token for a request. The environment variable wins: it is only ever set on
 * purpose, on CI or a server, and a local sign-in should not quietly override it.
 * A browser session is renewed a minute before it expires, so nobody meets a 401
 * they could have avoided.
 */
async function accessToken() {
  if (process.env.HIRIFY_KEY) return process.env.HIRIFY_KEY

  const session = readSession()
  if (!session) die(NOT_SIGNED_IN)

  if (session.kind === 'oauth' && session.expires_at && session.expires_at - 60 <= now()) {
    return (await refreshSession(session)).access_token
  }
  return session.access_token
}

// ── talking to the API ─────────────────────────────────────────────────────
async function request(path, method, token, payload) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT }
  if (payload) headers['Content-Type'] = 'application/json'
  try {
    return await fetch(`${API}/api${path}`, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    })
  } catch (e) {
    die(`the network seems to be unavailable: ${e.message}`)
  }
}

/**
 * `allow` lists statuses the caller wants to read itself instead of dying on. Feedback
 * needs it: a 429 there means "too many reports", not "your reveals are used up", and
 * saying the wrong one sends the person looking in the wrong place.
 */
async function api(path, { method = 'GET', payload = null, allow = [] } = {}) {
  let res = await request(path, method, await accessToken(), payload)

  // A 401 on a live session is ordinary: the access token is dropped when the refresh
  // token rotates. One quiet exchange and a retry, and only then ask for a new sign-in.
  if (res.status === 401 && !process.env.HIRIFY_KEY) {
    const session = readSession()
    if (session?.kind === 'oauth' && session.refresh_token) {
      const fresh = await refreshSession(session)
      res = await request(path, method, fresh.access_token, payload)
    }
  }

  if (allow.includes(res.status)) {
    return {
      status: res.status,
      body: await res.json().catch(() => null),
      retryAfter: res.headers.get('retry-after'),
    }
  }

  if (res.status === 401) {
    die(process.env.HIRIFY_KEY || readSession()?.kind === 'key'
      ? 'the key was not accepted (401). It may have been revoked, or copied incompletely.'
      : 'your sign-in is no longer valid. Please run `hirify login` again.')
  }
  if (res.status === 403) die('no access (403). This needs an active paid plan, or the sign-in is missing a permission.')
  if (res.status === 404) die('not found (404).')
  if (res.status === 429) die("today's reveal limit is used up (429). It resets at midnight.")
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    // Everything expected is handled above. What lands here is not, and it used to print
    // the raw response body: status codes and internal fields in front of a person. The
    // answer is for debugging, not for reading, so it goes behind HIRIFY_DEBUG.
    if (process.env.HIRIFY_DEBUG) {
      console.error(`hirify: server answered ${res.status}: ${body ? JSON.stringify(body) : '(empty body)'}`)
    }
    die(res.status >= 500
      ? 'something went wrong on our side. Please try again in a minute.'
      : 'that command could not be completed. Please check it and try again.')
  }
  // Return the WHOLE body: lists carry `meta` (total/last_page) next to `data`, and an
  // agent reading --json needs it too. Unwrapping happens in the commands.
  return body
}

// ── signing in through the browser ─────────────────────────────────────────
/**
 * Where the authorization server lives. We ask it rather than hardcode it (RFC 8414),
 * so the CLI follows if the endpoints move. No document, no problem: use the defaults.
 */
async function discover() {
  const fallback = {
    authorization_endpoint: `${API}/oauth/authorize`,
    token_endpoint: `${API}/oauth/token`,
    registration_endpoint: `${API}/oauth/register`,
  }
  try {
    const res = await fetch(`${API}/.well-known/oauth-authorization-server`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return fallback
    const meta = await res.json()
    return {
      authorization_endpoint: meta.authorization_endpoint || fallback.authorization_endpoint,
      token_endpoint: meta.token_endpoint || fallback.token_endpoint,
      registration_endpoint: meta.registration_endpoint || fallback.registration_endpoint,
    }
  } catch {
    return fallback
  }
}

/** A form body, not JSON: RFC 6749 requires it and the server expects it. */
async function postForm(url, params) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
    })
  } catch (e) {
    die(`the network seems to be unavailable: ${e.message}`)
  }
  const body = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, body }
}

/**
 * Listen for the browser on the loopback interface. The port is ephemeral (0), so it is
 * always free and two sign-ins in a row never fight over the same number.
 */
async function startCallbackServer() {
  let settle
  const received = new Promise((resolve) => { settle = resolve })

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const error = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(browserPage(error))
    settle({
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error,
      // Only the server attaches a description, and only when the server itself refused.
      // A person pressing "deny" arrives without one, which is how we tell them apart.
      description: url.searchParams.get('error_description'),
    })
  })

  await new Promise((resolve, reject) => {
    const onError = (e) => reject(e)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      // Past this point one malformed browser request should not bring the CLI down.
      server.on('error', () => {})
      resolve()
    })
  })

  return { port: server.address().port, received, close: () => server.close() }
}

/**
 * What the person sees in the browser. It does not say "you are signed in": the code is
 * exchanged for tokens after this page is served, and the page cannot promise the result.
 * The result belongs in the terminal.
 */
function browserPage(error) {
  const title = error ? 'Sign-in was not completed' : 'Confirmation received'
  const text = error
    ? 'Please return to your terminal and try again.'
    : 'You can close this tab and return to your terminal.'
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hirify</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         color:#1a1a1a; background:#fafafa; }
  main { max-width:32rem; padding:2rem; text-align:center; }
  h1 { font-size:1.4rem; margin:0 0 .5rem; }
  p { margin:0; color:#555; }
</style>
<main><h1>${title}</h1><p>${text}</p></main></html>`
}

/**
 * Open the browser. Success here means the command started: whether a window actually
 * appeared is not something we can know, so the link is printed either way.
 */
function openBrowser(url) {
  const candidates = process.env.BROWSER
    ? [[process.env.BROWSER, [url]]]
    : process.platform === 'darwin' ? [['open', [url]]]
    : process.platform === 'win32' ? [['cmd', ['/c', 'start', '', url]]]
    : [['xdg-open', [url]], ['gio', ['open', url]], ['sensible-browser', [url]], ['x-www-browser', [url]]]

  const tryOne = (i) => new Promise((resolve) => {
    if (i >= candidates.length) return resolve(false)
    const [cmd, args] = candidates[i]
    let child
    try {
      child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    } catch {
      return resolve(tryOne(i + 1))
    }
    child.once('error', () => resolve(tryOne(i + 1)))
    child.once('spawn', () => { child.unref(); resolve(true) })
  })

  return tryOne(0)
}

async function cmdLogin(args) {
  const noBrowser = args.includes('--no-browser')
  const endpoints = await discover()

  let listener
  try {
    listener = await startCallbackServer()
  } catch (e) {
    die('could not open a local address for the browser to answer on: ' + e.message +
      '\n        Please sign in with a key instead: `hirify auth <key>` (hirify.me/account/api-access).')
  }

  const redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`

  // A client is registered on every sign-in: the return address is matched exactly and
  // our port is new each time. The client holds no secret; PKCE is what protects the code.
  let clientId
  try {
    const res = await fetch(endpoints.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_name: 'Hirify CLI', redirect_uris: [redirectUri] }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.client_id) {
      listener.close()
      die(`could not start the sign-in: the server answered ${res.status}. Please try again.`)
    }
    clientId = body.client_id
  } catch (e) {
    listener.close()
    die(`the network seems to be unavailable: ${e.message}`)
  }

  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const authUrl = `${endpoints.authorization_endpoint}?` + new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  const opened = noBrowser ? false : await openBrowser(authUrl)
  console.log(opened
    ? 'Opening your browser. Please confirm access on hirify.me.'
    : 'Please open this link in your browser and confirm access:')
  if (!opened) console.log(`\n${authUrl}\n`)
  else console.log(`If it did not open, use this link:\n${authUrl}`)

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), LOGIN_TIMEOUT_MS))
  const answer = await Promise.race([listener.received, timeout])
  listener.close()

  if (answer.timedOut) {
    // Older servers show a refusal as a page on their own domain instead of returning it
    // here, and then the browser stops there while we wait out the clock. This hint is
    // the only place a person learns it was about access rather than about the command.
    die('we did not get a confirmation in the browser. Please run `hirify login` again.' +
      '\n        If the browser said API access is not enabled, that is about your plan,' +
      '\n        not about the command: hirify.me/account/api-access')
  }
  if (answer.error === 'access_denied') {
    // The server sends its description for a program to read, in ASCII, as the spec
    // requires. A person gets our own sentence; the machine string stays behind
    // HIRIFY_DEBUG rather than sitting in the middle of the normal output.
    if (answer.description) {
      if (process.env.HIRIFY_DEBUG) console.error(`hirify: the server refused: ${answer.description}`)
      die('API access is not enabled for this account, and nothing was saved.' +
        '\n        Details and how to enable it: hirify.me/account/api-access')
    }
    die('access was not confirmed and nothing was saved. If that was a mistake, run `hirify login` again.')
  }
  if (answer.error) {
    die('the sign-in did not finish. Please run `hirify login` again.')
  }
  if (answer.state !== state) {
    die('the browser answered a different sign-in. Please run `hirify login` again.')
  }
  if (!answer.code) {
    die('the browser came back without a confirmation code. Please run `hirify login` again.')
  }

  const { ok, body } = await postForm(endpoints.token_endpoint, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: answer.code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })

  if (!ok || !body?.access_token) {
    // The confirmation code lives five minutes and works once. Most arrivals here simply
    // took too long, so the useful advice is to start again.
    die('the sign-in did not finish: the confirmation expired or was already used.' +
      '\n        Please run `hirify login` again.')
  }

  writeSession({
    kind: 'oauth',
    issuer: API,
    client_id: clientId,
    token_endpoint: endpoints.token_endpoint,
    access_token: body.access_token,
    refresh_token: body.refresh_token || null,
    scope: body.scope || SCOPES,
    expires_at: body.expires_in ? now() + Number(body.expires_in) : null,
  })

  console.log(`\nSigned in. Access saved to ${AUTH_FILE}`)
  // Show the remaining limit right away: it is the first thing anyone asks anyway.
  try {
    await cmdMe()
  } catch {
    // The sign-in worked; the plan summary is a nicety, not a requirement.
  }
  console.log('\nRules for your agent: npx skills add hirifyme/hirify-cli')
}

/**
 * Trade the refresh token for a new pair. It rotates on every exchange, so the file is
 * written immediately: losing the new refresh token costs more than one extra write.
 */
async function refreshSession(session) {
  if (!session.refresh_token) {
    die('your sign-in has expired. Please run `hirify login` again.')
  }

  const { ok, body } = await postForm(session.token_endpoint || `${API}/oauth/token`, {
    grant_type: 'refresh_token',
    client_id: session.client_id,
    refresh_token: session.refresh_token,
  })

  if (!ok || !body?.access_token) {
    die('your sign-in has expired. Please run `hirify login` again.')
  }

  const fresh = {
    ...session,
    access_token: body.access_token,
    refresh_token: body.refresh_token || session.refresh_token,
    scope: body.scope || session.scope,
    expires_at: body.expires_in ? now() + Number(body.expires_in) : null,
  }
  writeSession(fresh)
  return fresh
}

function cmdLogout() {
  console.log(forgetSession()
    ? 'Signed out on this computer.'
    : 'Nobody is signed in here.')
}

// ── commands ───────────────────────────────────────────────────────────────
async function cmdMe() {
  const body = await api('/agent/me')
  const d = body?.data ?? {}
  const q = d?.quota?.reveal
  const u = d?.usage?.reveal
  out(body, () => {
    console.log(`plan:    ${d?.plan ?? '-'}`)
    if (q) console.log(`reveals: ${q.used} of ${q.limit} used today (${q.remaining} left)`)
    if (u) console.log(`usage:   ${u.today} today · ${u.last_7d} in 7d · ${u.last_30d} in 30d`)
  })
}

async function cmdFeeds() {
  const body = await api('/agent/feeds')
  const list = body?.data ?? []
  out(body, () => {
    if (!list.length) return console.log('You have no feeds yet. Save a filter on hirify.me and it becomes a feed.')
    for (const f of list) {
      const off = f.is_active === false ? '  (off)' : ''
      console.log(`${String(f.id).padEnd(6)} ${f.name || '(untitled)'}${off}`)
    }
    console.log(`\nVacancies from a feed: hirify feed <id>`)
  })
}

// Fields come straight from the API's vacancy resource: a card carries no contacts by
// design, and for premium companies the name arrives masked.
function printVacancies(list, meta) {
  if (!list.length) return console.log('Nothing found.')
  for (const v of list) {
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
    console.log(`${v.slug}\n  ${v.title || '-'} · ${company}${bits.length ? `\n  [${bits.join(' · ')}]` : ''}`)
  }
  const total = meta?.total
  console.log(`\nShowing ${list.length}${total ? ` of ${total}` : ''}. Where to apply: hirify reveal <slug> (uses 1 reveal).`)
}

async function cmdFeed(args) {
  // `feed` reads one feed, and it also carries the two verbs that change feeds. Feed ids
  // are numbers, so a word in that position can only be a verb and never an id.
  // Both halves matter. The verb is found among the positionals, so a flag before it
  // cannot hide it; and what the sub-command gets is the positionals AFTER the verb, not
  // the raw argv sliced at index 1. Slicing raw argv broke as soon as a flag stood in
  // front: `feed --limit 5 delivery 7` used to change the delivery of feed 5.
  const rest = positional(args)
  if (rest[0] === 'create') return cmdFeedCreate(args, rest.slice(1))
  if (rest[0] === 'delivery') return cmdFeedDelivery(args, rest.slice(1))

  const id = rest[0]
  if (!id) die('a feed id is required: hirify feed <id>  (list them with hirify feeds)')
  const limit = flag(args, '--limit')
  const body = await api(`/agent/feeds/${encodeURIComponent(id)}/vacancies${limit ? `?per_page=${limit}` : ''}`)
  out(body, () => printVacancies(body?.data ?? [], body?.meta))
}

async function cmdSearch(args) {
  const query = positional(args).join(' ')
  const p = new URLSearchParams()
  if (query) p.set('search', query)
  const limit = flag(args, '--limit'); if (limit) p.set('per_page', limit)
  const grade = flag(args, '--grade'); if (grade) p.set('grade', grade)
  const body = await api(`/agent/vacancies?${p}`)
  out(body, () => printVacancies(body?.data ?? [], body?.meta))
}

/** One contact line: the address as it is, with the type only when it adds something. */
function contactLine(c) {
  if (typeof c === 'string') return c
  const value = c?.value ?? c?.url ?? c?.email ?? null
  if (!value) return JSON.stringify(c)
  return c?.type && c.type !== 'url' ? `${value}  (${c.type})` : value
}

async function cmdReveal(args) {
  const [slug] = positional(args)
  if (!slug) die('a slug is required: hirify reveal <slug>')
  const body = await api(`/agent/vacancies/${encodeURIComponent(slug)}/reveal`, { method: 'POST' })
  const d = body?.data ?? {}
  out(body, () => {
    console.log(`company:  ${d.company ?? '-'}`)
    if (d.linkedin) console.log(`linkedin: ${d.linkedin}`)
    // A contact arrives as {type, value, short_code}. People and agents want the address,
    // not its JSON: nobody unpacks a raw object by hand while reading a terminal.
    for (const c of d.contacts ?? []) console.log(`contact:  ${contactLine(c)}`)
    console.log(d.charged === false
      ? '\n(no reveal used: you have revealed this vacancy before)'
      : '\n(1 reveal used)')
    const q = d.quota
    if (q) console.log(`${q.remaining} of ${q.limit} left today`)
  })
}

/**
 * Report a bug or ask for a feature. Free: it does not touch the reveal limit.
 *
 * The length bounds are checked here as well as on the server, so a mistake comes back
 * as a sentence about the title being too short rather than as a field-error object.
 */
async function cmdFeedback(args) {
  const [type, title] = positional(args)
  if (!FEEDBACK_TYPES.includes(type)) {
    die('say what kind of report this is, bug or feature:\n' +
      '        hirify feedback bug "<title>" --body "<what happened>"\n' +
      '        hirify feedback feature "<title>" --body "<what you need>"')
  }

  const text = flag(args, '--body')
  const vacancy = flag(args, '--vacancy')

  if (!title) die('a title is required: hirify feedback ' + type + ' "<title>" --body "<text>"')
  if (title.length < TITLE_RANGE[0] || title.length > TITLE_RANGE[1]) {
    die(`the title should be between ${TITLE_RANGE[0]} and ${TITLE_RANGE[1]} characters. Yours is ${title.length}.`)
  }
  if (!text) die('the report needs a body: add --body "<text>"')
  if (text.length < BODY_RANGE[0] || text.length > BODY_RANGE[1]) {
    die(`the body should be between ${BODY_RANGE[0]} and ${BODY_RANGE[1]} characters. Yours is ${text.length}.`)
  }

  const res = await api('/agent/feedback', {
    method: 'POST',
    payload: { type, title, body: text, ...(vacancy ? { vacancy_slug: vacancy } : {}) },
    allow: [201, 202, 404, 422, 429, 502, 503],
  })

  const d = res.body?.data ?? {}

  if (res.status === 429) {
    const wait = Number(res.retryAfter)
    die('that is a lot of reports in a short time.' +
      (Number.isFinite(wait) && wait > 0 ? ` Please try again in ${wait} seconds.` : ' Please try again a bit later.'))
  }
  if (res.status === 502) {
    // Not queued and not retried on our side, because a retry would not fix it. Say that
    // the fault is ours, so nobody rewrites a perfectly good report thinking it was them.
    die('we could not pass your report on. That is a fault on our side, not in what you wrote.' +
      '\n        Please try again a bit later.')
  }
  if (res.status === 404 || res.status === 503) {
    // 404 means this API does not have the feedback endpoint at all, 503 that it has it
    // and it is switched off. Both are the same fact for the person in front of us, and
    // "not found (404)" would send them looking for a mistake in their own command.
    die('the feedback channel is not available right now. Please try again later.')
  }
  if (res.status === 422) {
    // We check the same bounds above, so this means ours and the server's drifted apart.
    // The person cannot act on that, so they get a plain sentence and we keep the detail.
    if (process.env.HIRIFY_DEBUG) console.error(`hirify: server answered 422: ${JSON.stringify(res.body)}`)
    die('the report was not accepted. Please check the title and the text and try again.')
  }

  // Say `number`, never `id`. The number is the one a human at Hirify recognises; the id
  // is for reading the ticket through their API, and telling a person the id would give
  // them a number nobody there can look up. There is deliberately no link to a report:
  // ticket numbers are sequential, and a public address would let anyone walk through
  // other people's complaints. And nothing writes back afterwards, so we promise nothing.
  const ticket = d.ticket?.number ?? (typeof d.ticket === 'number' ? d.ticket : null)

  out(res.body, () => {
    if (ticket && d.ticket?.duplicate) {
      console.log(`Thank you. This matches a report we already have, number ${ticket}.`)
    } else if (ticket) {
      console.log(`Thank you. Your report was passed on as number ${ticket}.`)
    } else {
      console.log('Thank you. Your report is with us and on its way to the team, without a number yet.')
    }
    if (d.reference) console.log(`reference: ${d.reference}`)
  })
}

/** The profiles a person can apply with. Free, and the list `apply` picks from. */
async function cmdProfiles() {
  const body = await api('/agent/profiles')
  const list = body?.data ?? []
  out(body, () => {
    if (!list.length) {
      return console.log('You have no profiles yet. Create one on hirify.me, then you can apply.')
    }
    for (const p of list) {
      const state = [p.status, p.is_complete === false ? 'incomplete' : null].filter(Boolean).join(' · ')
      console.log(`${String(p.profile_id).padEnd(6)} ${p.name || p.title || '(untitled)'}${state ? `  [${state}]` : ''}`)
    }
    console.log('\nApply with one: hirify apply <slug> --profile <id>')
  })
}

/**
 * Send a real application, on Hirify, to a real person. This is the one command here
 * that cannot be undone, so it never guesses: if the account has several profiles and
 * none was named, the server refuses and we pass that on rather than picking one.
 */
async function cmdApply(args) {
  const [slug] = positional(args)
  if (!slug) die('a vacancy slug is required: hirify apply <slug> [--profile <id>]')

  const profile = flag(args, '--profile')
  const cover = flag(args, '--cover')

  if (profile !== null && !/^\d+$/.test(profile)) die('--profile takes a profile id, a number. See hirify profiles.')
  if (cover !== null && cover.length > 10000) {
    die(`the cover letter should be at most 10000 characters. Yours is ${cover.length}.`)
  }

  const res = await api(`/agent/vacancies/${encodeURIComponent(slug)}/apply`, {
    method: 'POST',
    payload: { ...(profile ? { profile_id: Number(profile) } : {}), ...(cover ? { cover_letter: cover } : {}) },
    allow: [201, 404, 422, 502],
  })

  if (res.status === 404) die('there is no vacancy with that slug.')
  if (res.status === 502) die('the application could not be sent right now. Please try again in a minute.')
  if (res.status === 422) {
    // These come from the same rules the site applies: archived, flagged, hosted
    // elsewhere, someone else's profile. They are written to be read, so pass them on
    // instead of flattening every one of them into "something went wrong".
    die(serverMessage(res.body) || 'the application was not accepted. Please check the vacancy and the profile.')
  }

  const d = res.body?.data ?? {}
  out(res.body, () => {
    console.log(`Applied. Application ${d.application_id ?? ''}, status ${d.status ?? 'sent'}.`.replace('  ', ' '))
    console.log('Hirify does not chase the answer for you: the recruiter replies where they choose to.')
  })
}

/** Save a search, the same thing a person does with the filter form on the site. */
async function cmdFeedCreate(args, words) {
  const [name] = words
  if (!name) die('a name is required: hirify feed create "<name>" [--filters \'<json>\']')
  if (name.length > 120) die(`the name should be at most 120 characters. Yours is ${name.length}.`)

  // An empty set of criteria is legal and means "send me everything", exactly as it does
  // on the site. So the field is always sent, and only bad JSON is refused.
  let filters = {}
  const raw = flag(args, '--filters')
  if (raw) {
    try {
      filters = JSON.parse(raw)
    } catch {
      die('--filters expects JSON, for example --filters \'{"grade":["senior"]}\'')
    }
  }

  const payload = { name, filters }
  if (args.includes('--no-telegram')) payload.notify_telegram = false
  if (args.includes('--telegram')) payload.notify_telegram = true
  const webhook = flag(args, '--webhook')
  if (webhook) {
    if (!/^\d+$/.test(webhook)) die('--webhook takes an endpoint id, a number. See hirify webhooks.')
    payload.webhook_endpoint_id = Number(webhook)
  }

  const res = await api('/agent/feeds', { method: 'POST', payload, allow: [201, 422] })
  if (res.status === 422) die(serverMessage(res.body) || 'the feed was not created. Please check the criteria.')

  out(res.body, () => printFeedState(res.body?.data ?? {}, 'Saved.'))
}

/** Change where a feed is delivered, without touching what it searches for. */
async function cmdFeedDelivery(args, words) {
  const [id] = words
  if (!id || !/^\d+$/.test(id)) die('a feed id is required: hirify feed delivery <id> [--telegram] [--webhook <id>]')

  const payload = {}
  if (args.includes('--telegram')) payload.notify_telegram = true
  if (args.includes('--no-telegram')) payload.notify_telegram = false
  if (args.includes('--no-webhook')) payload.webhook_endpoint_id = null
  const webhook = flag(args, '--webhook')
  if (webhook) {
    if (!/^\d+$/.test(webhook)) die('--webhook takes an endpoint id, a number. See hirify webhooks.')
    payload.webhook_endpoint_id = Number(webhook)
  }
  if (!Object.keys(payload).length) {
    die('say what to change: --telegram, --no-telegram, --webhook <id> or --no-webhook.')
  }

  const res = await api(`/agent/feeds/${encodeURIComponent(id)}/delivery`, { method: 'PUT', payload, allow: [200, 404, 422] })
  if (res.status === 404) die('there is no feed with that id. See hirify feeds.')
  if (res.status === 422) die(serverMessage(res.body) || 'the delivery settings were not accepted.')

  out(res.body, () => printFeedState(res.body?.data ?? {}, 'Updated.'))
}

function printFeedState(f, lead) {
  const where = [
    f.notify_telegram ? 'Telegram' : null,
    f.webhook_endpoint_id ? `webhook ${f.webhook_endpoint_id}` : null,
  ].filter(Boolean)
  console.log(`${lead} Feed ${f.id ?? ''}: ${f.name ?? ''}`.replace('  ', ' ').trimEnd())
  console.log(where.length ? `Delivered to: ${where.join(' and ')}` : 'Not delivered anywhere yet.')
}

/** Delivery endpoints, and creating one. Listing is free; creating needs the plan. */
async function cmdWebhooks(args) {
  const rest = positional(args)
  if (rest[0] === 'create') return cmdWebhookCreate(args, rest.slice(1))
  if (rest[0] && rest[0] !== 'list') die('supported: hirify webhooks, hirify webhooks create "<name>" <url>')

  const body = await api('/agent/webhooks')
  const list = body?.data ?? []
  out(body, () => {
    if (!list.length) {
      return console.log('You have no delivery endpoints yet. Create one: hirify webhooks create "<name>" <url>')
    }
    for (const w of list) {
      console.log(`${String(w.id).padEnd(6)} ${w.name || '(untitled)'}  ${w.url}${w.state ? `  [${w.state}]` : ''}`)
    }
    console.log('\nSend a feed to one: hirify feed delivery <feed id> --webhook <id>')
  })
}

async function cmdWebhookCreate(args, words) {
  const [name, url] = words
  if (!name || !url) die('both a name and an address are required: hirify webhooks create "<name>" <url>')
  if (name.length > 60) die(`the name should be at most 60 characters. Yours is ${name.length}.`)

  const res = await api('/agent/webhooks', { method: 'POST', payload: { name, url }, allow: [201, 403, 422] })
  if (res.status === 403) die(serverMessage(res.body) || 'creating a delivery endpoint is not available on this account.')
  if (res.status === 422) die(serverMessage(res.body) || 'that address was not accepted.')

  const d = res.body?.data ?? {}
  out(res.body, () => {
    console.log(`Created. Endpoint ${d.id ?? ''}: ${d.name ?? ''} ${d.url ?? ''}`.replace(/ +/g, ' ').trimEnd())
    // The secret is shown once and never again, so it gets its own line and a warning
    // rather than sitting inside a sentence someone may scroll past.
    if (d.secret) {
      console.log(`\nsecret: ${d.secret}`)
      console.log('Store it now. It is shown once and it signs every delivery.')
    }
  })
}

/** The fallback for CI and servers with no browser. The normal way in is `hirify login`. */
function cmdAuth(args) {
  const [key] = positional(args)
  if (!key) {
    die('to sign in through the browser: `hirify login`.\n' +
      '        With a key (CI, servers): `hirify auth <key>`, from hirify.me/account/api-access')
  }
  writeSession({ kind: 'key', access_token: key })
  if (existsSync(LEGACY_KEY_FILE)) rmSync(LEGACY_KEY_FILE)
  console.log(`Key saved to ${AUTH_FILE}`)
}

/** The skill ships through skills.sh now: one command installs it into every harness. */
function cmdSkill() {
  console.log('The rules for your agent install with one command:\n\n  npx skills add hirifyme/hirify-cli\n')
  console.log('It puts them where your agent reads them: Claude Code, Codex, Cursor, OpenCode and others.')
}

// ── router ─────────────────────────────────────────────────────────────────
const [cmd, ...args] = process.argv.slice(2)
const routes = {
  login: cmdLogin, logout: cmdLogout, auth: cmdAuth,
  me: cmdMe, feeds: cmdFeeds, feed: cmdFeed, search: cmdSearch, reveal: cmdReveal,
  profiles: cmdProfiles, apply: cmdApply, webhooks: cmdWebhooks,
  feedback: cmdFeedback,
  skill: cmdSkill,
}

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); process.exit(0) }
if (!routes[cmd]) die(`unknown command: ${cmd}\n\n${HELP}`)
await routes[cmd](args)
