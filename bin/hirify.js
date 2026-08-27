#!/usr/bin/env node
// Hirify CLI: job search for AI agents.
//
// A thin client over `api.hirify.me/api/agent/*`, the same API the MCP server serves.
// No dependencies: Node 18+ (built-in fetch), runs through `npx hirify-cli`.
//
// Metering, same as on the server: lists and searches are free, and three actions are
// metered - reading a vacancy in full, revealing a contact, and applying. Repeating a read
// or a reveal on the same vacancy is free. No number for any of them is written down in
// this file: `hirify account show` reports what the server has left, and that is the only
// place any of them is true.
//
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'

const API = process.env.HIRIFY_API || 'https://api.hirify.me'
// The two public well-known documents the CLI is allowed to hardcode. OAuth discovery is
// unchanged; the Hirify agent document is where the CLI learns the manifest URL, so it never
// has to hardcode an agent operation path of its own.
const OAUTH_WELL_KNOWN = '/.well-known/oauth-authorization-server'
const AGENT_WELL_KNOWN = '/.well-known/hirify-agent'
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hirify')
// One file for either way of signing in. Working out where the current token came from
// is cheaper from a single `kind` field than from two files that may both exist.
const AUTH_FILE = join(CONFIG_DIR, 'auth.json')
// The key file from 0.1: still read for anyone who has one, never written again.
const LEGACY_KEY_FILE = join(CONFIG_DIR, 'key')

// What to ask for at sign-in when the server does not publish its own list. An OAuth token
// carries exactly what the person agreed to, and nothing can add an ability to it later
// without sending them back through the consent screen, so a sign-in that asks for too
// little is a sign-in the person has to repeat.
//
// This is a fallback, not the list. The authorization server publishes `scopes_supported`
// (RFC 8414) and that is what we ask for, because a list frozen here is a list that goes
// stale: on 18.08 the server had no `agent:feedback` and dropped it from the request in
// silence, and everyone who signed in that day still cannot send a report.
const FALLBACK_SCOPES = 'agent:read agent:reveal agent:apply agent:manage agent:feedback offline_access'
const CALLBACK_PATH = '/callback'
// How long we wait for the browser. The authorization code lives the same five minutes.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

// The two kinds of report the API takes. This one is ours to know: it is the word a
// person types, and the CLI has to tell them which words there are before it can send
// anything at all.
const FEEDBACK_TYPES = ['bug', 'feature']

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

  hirify intro                    what this can do, and in what order

  hirify login                    sign in through your browser
  hirify logout                   sign out on this computer
  hirify account show             your plan and allowances

  hirify vacancy search <query>   search the board          [--limit N] [--page N]
  hirify vacancy read <slug>      one vacancy in full, with its text
  hirify vacancy reveal <slug>    where to apply: uses 1 reveal
  hirify vacancy apply <slug>     apply on Hirify           [--profile N] [--cover T]

  hirify feed list                the feeds you saved on the site
  hirify feed show <id>           vacancies from one feed   [--limit N] [--page N]
  hirify feed create <name>       save a search             [--filters JSON] [--webhook N]
  hirify feed deliver <id>        change how a feed reaches you

  hirify profile list             the profiles you can apply with
  hirify webhook list             your delivery endpoints
  hirify webhook create <name> <url>

  hirify filter guide             what search can filter on, from the server
  hirify feedback send <kind>     report a bug or ask for a feature
  hirify api call <capability>    invoke any capability        [--data JSON] [--fields a,b]

  --json                          raw JSON instead of text

Free: account show, feed list, feed show, vacancy search, profile list, webhook list,
filter guide.
Metered: vacancy read spends one of the day's vacancy opens, vacancy reveal spends 1 reveal,
and vacancy apply counts against its own daily allowance. Repeating a read or a reveal on the
same vacancy is free. vacancy apply also sends a real application to a recruiter and cannot be
taken back, so ask the person first.
What is left of each: hirify account show.

New here: hirify intro
A noun on its own lists its verbs: hirify vacancy
Rules for your agent: npx skills add hirifyme/hirify-cli
No browser (CI, servers): hirify auth <key>, or the HIRIFY_KEY variable.
Key: hirify.me/account/api-access`

// ── helpers ────────────────────────────────────────────────────────────────
// Exit codes are a stable contract, so a caller can branch on them: 0 is success, 1 is an
// ordinary error, and 2 means this Hirify speaks a newer manifest than this build can read -
// "update the CLI", told apart from "the command failed". These three do not change.
const EXIT_OK = 0
const EXIT_ERROR = 1
const EXIT_MANIFEST_UNSUPPORTED = 2

const die = (msg, code = EXIT_ERROR) => { console.error(`hirify: ${msg}`); process.exit(code) }

// Options that stand on their own. Everything else takes the next word as its value, and
// that rule is what lets `search` carry a filter the CLI has never heard of: the list of
// filters lives on the server, and a CLI that keeps its own copy is a CLI that lags.
//
// It used to be the other way round, a list of options known to take a value. That list
// was the ceiling: an option missing from it silently swallowed nothing and its value was
// read as data.
const BOOLEAN_FLAGS = new Set(['--json', '--help', '--no-browser', '--telegram', '--no-telegram', '--no-webhook'])

// Ours, not the API's. These never reach a query string: `--json` steers the CLI, and
// `--fields` chooses which fields a compact render prints.
const CLI_ONLY = new Set(['json', 'fields'])

/** Does this option take the word after it, or does it stand alone? */
const takesValue = (args, i) =>
  !BOOLEAN_FLAGS.has(args[i]) && args[i + 1] !== undefined && !args[i + 1].startsWith('--')

const flag = (args, name) => {
  const i = args.indexOf(name)
  if (i !== -1) return args[i + 1]
  const eq = args.find((a) => a.startsWith(`${name}=`))
  return eq === undefined ? null : eq.slice(name.length + 1)
}

/**
 * The arguments that are not options. The router finds the verb through this, and every
 * command reads its slug or id through it, because reading `args[0]` directly made a flag
 * look like one: `hirify webhook --json list` was refused as an unknown verb, and `hirify
 * feed --json show 7` asked the server for a feed literally called "--json".
 */
const positional = (args) => {
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (takesValue(args, i)) i++
      continue
    }
    rest.push(args[i])
  }
  return rest
}

/**
 * Every option and the value it was given, as a plain map. `search` forwards these to the
 * API unchanged, so a filter added on the server works from the terminal the same day,
 * without a new flag being written here.
 *
 * Both `--key value` and `--key=value` are the same thing. A key given more than once is
 * joined with a comma, which is how the site sends a filter with several values.
 */
const options = (args) => {
  const found = new Map()
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue
    const eq = args[i].indexOf('=')
    const name = eq === -1 ? args[i].slice(2) : args[i].slice(2, eq)
    if (!name) continue
    const value = eq !== -1 ? args[i].slice(eq + 1) : takesValue(args, i) ? args[++i] : 'true'
    found.set(name, found.has(name) ? `${found.get(name)},${value}` : value)
  }
  return found
}

/**
 * A number as the server sent it, or `null` when the field is not there. Every printed
 * figure goes through this: a field the API stopped sending used to reach the screen as
 * the word `undefined`, which reads like a fact about the account and is not one.
 */
const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

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
// `path` is a whole path under the API base, the way the manifest writes it
// (`/api/agent/...`). The CLI does not assemble it from parts of its own, so a path the
// server moves is followed from the manifest without a change here.
async function request(path, method, token, payload) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT }
  if (payload) headers['Content-Type'] = 'application/json'
  try {
    return await fetch(`${API}${path}`, {
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
async function api(path, { method = 'GET', payload = null, allow = [], raw = false } = {}) {
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

  // `api call` reads every answer itself, refusal included: that is what it is for, and a
  // sentence of ours in place of the server's own reply would defeat the point of `api call`.
  if (raw) {
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      // Not JSON. The text is handed over as it came rather than thrown away.
    }
    return { status: res.status, body, text }
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
  if (res.status === 429) {
    // Several walls answer 429: a metered action has run out, or the requests came too
    // fast. The metered ones carry a quota block naming themselves in `quota.action`.
    // Naming the wrong wall leaves someone waiting out a limit they still have, or
    // spending reveals they no longer do.
    const spent = await res.json().catch(() => null)
    const wait = Number(res.headers.get('retry-after'))
    const action = spent?.quota?.action
    if (action === 'vacancy_opens') {
      die('you have opened as many vacancies today as the daily allowance covers.' +
        '\n        Feeds and search still work, and so does anything already read today.')
    }
    if (action === 'contact_reveals') die('you have no reveals left right now. Reading still works.')
    if (action === 'apply') {
      die('you have sent as many applications today as the daily allowance covers.' +
        '\n        Reading and revealing still work. What is left: hirify account show')
    }
    // A budget we have no sentence for yet. Name the one the server named rather than
    // guessing: guessing is how a spent read once came back as a spent reveal.
    if (spent?.quota) {
      die(`today's allowance for ${String(action ?? 'that action').replace(/_/g, ' ')} is used up.` +
        '\n        What is left: hirify account show')
    }
    die('too many requests in a short time.' +
      (Number.isFinite(wait) && wait > 0 ? ` Please try again in ${wait} seconds.` : ' Please try again in a minute.'))
  }
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

// ── the capability manifest ─────────────────────────────────────────────────
// The version of the manifest this CLI can read. A server that answers with a higher one
// speaks a document this build cannot interpret safely, and the CLI says so rather than
// guessing. Lower or equal is fine: unknown fields are ignored, not refused.
const SUPPORTED_SCHEMA_VERSION = 1

/**
 * Where the manifest lives, learned from the public Hirify agent document rather than
 * hardcoded. The CLI is allowed to know the well-known path and nothing past it, so the
 * address of every operation stays the server's to move.
 *
 * Cached for the process: the document does not change under one command.
 */
let agentDiscoveryCache = null
async function agentDiscovery() {
  if (agentDiscoveryCache) return agentDiscoveryCache
  try {
    const res = await fetch(`${API}${AGENT_WELL_KNOWN}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return (agentDiscoveryCache = { manifest_url: null, intro: null })
    const doc = await res.json()
    agentDiscoveryCache = {
      manifest_url: typeof doc.manifest_url === 'string' && doc.manifest_url ? doc.manifest_url : null,
      // Release-approved intro text, published here so it can be refreshed without a new CLI.
      // `hirify intro` prints it and falls back to the built-in text when it is absent.
      intro: typeof doc.intro === 'string' && doc.intro ? doc.intro : null,
    }
  } catch {
    // Unreachable is the same fact as unusable to the caller: no manifest, so no operations.
    agentDiscoveryCache = { manifest_url: null, intro: null }
  }
  return agentDiscoveryCache
}

// The manifest, held for this process only and never written to disk, so a fresh run always
// starts from the server's current document. `etag` rides along so a later fetch in the same
// process can revalidate instead of downloading the whole thing again.
let manifestCache = null

/**
 * Fetch and validate the manifest once per process. The first call downloads and checks it;
 * a later call in the same process sends the stored ETag and reuses the cache on a 304, so
 * the document is parsed and validated once even if it is asked for again.
 */
async function loadManifest() {
  const { manifest_url } = await agentDiscovery()
  if (!manifest_url) {
    die('could not reach Hirify to load what it can do. Please check your connection and try again.')
  }

  const headers = {
    Authorization: `Bearer ${await accessToken()}`,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  }
  if (manifestCache?.etag) headers['If-None-Match'] = manifestCache.etag

  let res
  try {
    res = await fetch(manifest_url, { headers })
  } catch (e) {
    if (manifestCache) return manifestCache.doc
    die(`the network seems to be unavailable: ${e.message}`)
  }

  // The manifest is behind the sign-in, so a rotated access token answers 401 once. One
  // quiet exchange and a retry, the same as an ordinary request.
  if (res.status === 401 && !process.env.HIRIFY_KEY) {
    const session = readSession()
    if (session?.kind === 'oauth' && session.refresh_token) {
      headers.Authorization = `Bearer ${(await refreshSession(session)).access_token}`
      try {
        res = await fetch(manifest_url, { headers })
      } catch (e) {
        die(`the network seems to be unavailable: ${e.message}`)
      }
    }
  }

  if (res.status === 304 && manifestCache) return manifestCache.doc
  if (res.status === 401) {
    die(process.env.HIRIFY_KEY || readSession()?.kind === 'key'
      ? 'the key was not accepted (401). It may have been revoked, or copied incompletely.'
      : 'your sign-in is no longer valid. Please run `hirify login` again.')
  }
  if (!res.ok) die('could not load what Hirify can do right now. Please try again in a minute.')

  const doc = await res.json().catch(() => null)
  validateManifest(doc)
  manifestCache = { doc, etag: res.headers.get('etag') || null }
  return doc
}

/** Refuse a manifest this build cannot read, and say which way to fix it. */
function validateManifest(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    die('Hirify sent something this CLI could not read as a manifest. Please try again in a minute.')
  }
  const version = doc.schema_version
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    die('Hirify sent a manifest without a version. Please try again in a minute.')
  }
  if (version > SUPPORTED_SCHEMA_VERSION) {
    die('this Hirify speaks a newer manifest than this CLI can read' +
      ` (its version is ${version}, this CLI reads ${SUPPORTED_SCHEMA_VERSION}).` +
      '\n        Please update the CLI: npm install -g hirify-cli, or run it with npx hirify-cli.',
      EXIT_MANIFEST_UNSUPPORTED)
  }
  if (!Array.isArray(doc.capabilities)) {
    die('Hirify sent a manifest with no list of what it can do. Please try again in a minute.')
  }
}

/**
 * Find one capability by its stable id. This is how a command reaches the server: it names
 * the capability it wants, and the manifest says which method and path answer it today.
 */
async function resolveCapability(id) {
  const manifest = await loadManifest()
  const cap = manifest.capabilities.find((c) => c && c.id === id)
  if (!cap || typeof cap.method !== 'string' || typeof cap.path !== 'string') {
    die(`this Hirify does not offer "${id}". It may be an older server, or the operation has moved.`)
  }
  return cap
}

/** Put values into a path template: `/api/agent/vacancies/{slug}` plus `{slug}` -> a path. */
function fillPath(template, params = {}) {
  return template.replace(/\{([a-z_]+)\}/g, (_, name) => {
    const value = params[name]
    if (value === undefined || value === null) {
      die(`this call needs "${name}", and it was not given.`)
    }
    return encodeURIComponent(String(value))
  })
}

/**
 * Call a capability by its id. The command supplies the parts it owns - the path values, the
 * query, the body - and the manifest supplies the method and the path, so no route is written
 * into this file.
 */
async function callCapability(id, { params = {}, query = null, payload = null, allow = [], raw = false } = {}) {
  const cap = await resolveCapability(id)
  let path = fillPath(cap.path, params)
  const qs = query ? query.toString() : ''
  if (qs) path += `?${qs}`
  return api(path, { method: cap.method, payload, allow, raw })
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
    scopes: FALLBACK_SCOPES,
  }
  try {
    const res = await fetch(`${API}${OAUTH_WELL_KNOWN}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return fallback
    const meta = await res.json()
    // The abilities are the server's to name. We ask for every one it publishes, because
    // the person is agreeing once and cannot be given a missing one afterwards.
    const published = Array.isArray(meta.scopes_supported)
      ? meta.scopes_supported.filter((s) => typeof s === 'string' && s).join(' ')
      : ''
    return {
      authorization_endpoint: meta.authorization_endpoint || fallback.authorization_endpoint,
      token_endpoint: meta.token_endpoint || fallback.token_endpoint,
      registration_endpoint: meta.registration_endpoint || fallback.registration_endpoint,
      scopes: published || fallback.scopes,
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
    scope: endpoints.scopes,
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
      '\n        not the command: hirify.me/account/api-access')
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
    die('that answer came from a different sign-in. Please run `hirify login` again.')
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
    scope: body.scope || endpoints.scopes,
    expires_at: body.expires_in ? now() + Number(body.expires_in) : null,
  })

  console.log(`\nSigned in. Access saved to ${AUTH_FILE}`)
  // Show the remaining limit right away: it is the first thing anyone asks anyway.
  try {
    await cmdAccountShow()
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
    payload: { type, title, body: text, ...(vacancy ? { vacancy_slug: vacancy } : {}) },
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
    die('we could not pass your report on. That is on our side, not in what you wrote.' +
      '\n        Please try again a bit later.')
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
    if (process.env.HIRIFY_DEBUG) console.error(`hirify: server answered 422: ${JSON.stringify(res.body)}`)
    die(serverMessage(res.body) || 'the report was not accepted. Please check the title and the text and try again.')
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
  if (res.status === 502) die('the application could not be sent right now. Please try again in a minute.')
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

  const payload = { name, filters }
  if (args.includes('--no-telegram')) payload.notify_telegram = false
  if (args.includes('--telegram')) payload.notify_telegram = true
  const webhook = flag(args, '--webhook')
  if (webhook) {
    if (!/^\d+$/.test(webhook)) die('--webhook takes an endpoint id, a number. See hirify webhook list.')
    payload.webhook_endpoint_id = Number(webhook)
  }

  const res = await callCapability('feeds.create', { payload, allow: [201, 422] })
  if (res.status === 422) die(serverMessage(res.body) || 'the feed was not created. Please check the criteria.')

  out(res.body, () => printFeedState(res.body?.data ?? {}, 'Saved.'))
}

/** Change where a feed is delivered, without touching what it searches for. */
async function cmdFeedDeliver(args, words) {
  const [id] = words
  if (!id || !/^\d+$/.test(id)) die('a feed id is required: hirify feed deliver <id> [--telegram] [--webhook <id>]')

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
  console.log(where.length ? `Delivered to: ${where.join(' and ')}` : 'Not delivered anywhere yet.')
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

/** The fallback for CI and servers with no browser. The normal way in is `hirify login`. */
function cmdAuth(args, words) {
  const [key] = words
  if (!key) {
    die('to sign in through the browser: `hirify login`.\n' +
      '        With a key (CI, servers): `hirify auth <key>`, from hirify.me/account/api-access')
  }
  writeSession({ kind: 'key', access_token: key })
  if (existsSync(LEGACY_KEY_FILE)) rmSync(LEGACY_KEY_FILE)
  console.log(`Key saved to ${AUTH_FILE}`)
}

/**
 * The first command anyone runs, and the only long text the CLI carries. It is prose, not a
 * list: `--help` already lists the commands, and a list does not tell you the order to use
 * them in or which of them spends something.
 *
 * Written for two readers at once, because that is who is there: the agent doing the work,
 * and the person watching it. Neither needs a different version of the truth.
 *
 * No network call. This has to work before anyone has signed in.
 */
const INTRO = `hirify - job search for AI agents

Hirify is a job board. This CLI is how an agent works it for someone: the same vacancies, the
same saved filters and the same account they have at hirify.me.

Signing in
  hirify login opens a browser and needs a person at the screen, so ask for it rather than
  running it. On a server with no browser there is a key instead: hirify auth <key>, from
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
  boards. For those, reveal brings back the address and the person applies themselves.
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

Every command takes --json. The full list of them: hirify --help`

async function cmdIntro() {
  // The intro is release-approved text published on the public agent well-known, so it can be
  // refreshed without shipping a new CLI. It needs no sign-in and no manifest. When Hirify
  // cannot be reached, or publishes none, the built-in text below stands in - so `hirify intro`
  // and the sign-in help it carries work before login and with no network.
  const { intro } = await agentDiscovery()
  console.log(typeof intro === 'string' && intro ? intro : INTRO)
}

// The fields the compact vacancy view keeps from a full summary card: the shortlist signal a
// scan needs, without the detail `vacancy read` adds. This is the selection the context budget
// is measured against - twenty of them serialize small - so a page of results does not spend an
// agent's context on fields it does not act on here. `--fields` narrows it; `--json` keeps the
// whole card.
const CARD_FIELDS = ['slug', 'title', 'company_masked', 'remote_type', 'work_format', 'english_level', 'salary']

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
  const params = {}
  const query = new URLSearchParams()
  const body = {}
  let hasBody = false

  for (const [key, value] of Object.entries(inputs)) {
    const where = locations[key] || (writes ? 'body' : 'query')
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

  // Invoke it. The capability is looked up again here, which revalidates the manifest with
  // its ETag and reuses the cached document on a 304 rather than downloading it twice.
  const res = await callCapability(id, { params, query, payload: hasBody ? body : null, raw: true })

  // Under --json, or when the server refused, or when the answer is not JSON, the canonical
  // body goes through untouched: --json is the raw contract, a refusal carries the server's own
  // machine-readable words, and a non-JSON answer has no fields to select. Otherwise the answer
  // is rendered compactly - a known card projection narrowed to its shortlist selection, any
  // other shape by its own fields - so `api call` reads without --json and stays small in an
  // agent's context. --fields narrows the selection further.
  const raw = process.argv.includes('--json') || res.status >= 400 || res.body === null
  if (raw) {
    const text = res.body === null ? res.text.trim() : JSON.stringify(res.body, null, 2)
    if (text) console.log(text)
  } else {
    const fields = fieldList(args) ?? (KNOWN_CARD_PROJECTIONS.has(cap.output_projection) ? CARD_FIELDS : null)
    renderGeneric(res.body, fields)
  }
  // On stderr, so that stdout stays the server's answer and nothing else.
  if (res.status >= 400) die(`the server answered ${res.status}. The answer is above.`)
}

/**
 * The filter vocabulary, printed as the server wrote it.
 *
 * `guide`, not `show`, and the reason is what comes back: this is not a list of keys but
 * the method the site's own filter generator works by, and calling it `show` would promise
 * a list. `eco mail inbox` is the same shape in the same grammar.
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

  const guide = typeof res.body?.guide === 'string' ? res.body.guide.trim() : ''
  if (!guide) die('the server answered without a guide. Please try again in a minute.')

  out(res.body, () => console.log(guide))
}

/** The skill ships through skills.sh now: one command installs it into every harness. */
function cmdSkill() {
  console.log('The rules for your agent install with one command:\n\n  npx skills add hirifyme/hirify-cli\n')
  console.log('It puts them where your agent reads them: Claude Code, Codex, Cursor, OpenCode and others.')
}

// ── router ─────────────────────────────────────────────────────────────────
// Commands that are not something you do to a thing. Signing in is not an operation on a
// vacancy or a feed, and `intro` is the first thing anyone runs, so it stays one word.
const PLAIN = {
  intro: cmdIntro, skill: cmdSkill,
  login: cmdLogin, logout: cmdLogout, auth: cmdAuth,
}

// Everything else is a noun and a verb, the grammar the rest of our tools already use.
// The noun is the thing you are working with, the verb is what you are doing to it.
const NOUNS = {
  account: { show: cmdAccountShow },
  vacancy: { search: cmdVacancySearch, read: cmdVacancyRead, reveal: cmdVacancyReveal, apply: cmdVacancyApply },
  feed: { list: cmdFeedList, show: cmdFeedShow, create: cmdFeedCreate, deliver: cmdFeedDeliver },
  profile: { list: cmdProfileList },
  webhook: { list: cmdWebhookList, create: cmdWebhookCreate },
  feedback: { send: cmdFeedbackSend },
  filter: { guide: cmdFilterGuide },
  api: { call: cmdApiCall },
}

const [noun, ...args] = process.argv.slice(2)

if (!noun || noun === '--help' || noun === '-h' || noun === 'help') { console.log(HELP); process.exit(EXIT_OK) }

// `Object.hasOwn`, not a plain lookup: every object inherits `toString` and `constructor`,
// and `hirify toString` used to find one and run it, which exits 0 having done nothing.
if (Object.hasOwn(PLAIN, noun)) {
  await PLAIN[noun](args, positional(args))
} else if (Object.hasOwn(NOUNS, noun)) {
  const verbs = NOUNS[noun]
  const known = `hirify ${noun} takes a verb: ${Object.keys(verbs).join(', ')}`
  if (args.includes('--help') || args.includes('-h')) { console.log(known); process.exit(EXIT_OK) }

  // The verb is read from the positionals, so an option written in front of it cannot
  // stand in for it: `hirify feed --json list` is still the list.
  const [verb, ...rest] = positional(args)
  if (!verb) die(known)
  if (!Object.hasOwn(verbs, verb)) die(`hirify ${noun} has no verb "${verb}".\n        ${known}`)
  await verbs[verb](args, rest)
} else {
  die(`unknown command: ${noun}\n\n${HELP}`)
}
