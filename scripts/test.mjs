// Behaviour tests for the CLI. Run them with `npm test`.
//
// They start a stub of the Hirify API on the loopback interface and run the real
// `bin/hirify.js` against it, so what is checked is what a person would see: the exit
// code, stdout and stderr of an actual command. No network and no account are involved.
//
// Repo-only tooling: `files` in package.json does not carry this into the npm package.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hirify.js')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// A throwaway config directory for the whole run. `logout` deletes the stored sign-in, and
// a test that reached the real one would sign the person running the suite out of Hirify.
const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'hirify-test-'))

/**
 * A vacancy shaped like the API's own detail resource. Tests override only the field
 * they are about, so a field renamed on the server breaks one place, not twelve.
 */
const VACANCY = {
  id: 42,
  title: 'Senior Go Engineer',
  slug: 'senior-go-engineer',
  url: 'https://hirify.me/jobs/senior-go-engineer?utm_source=agent-api',
  company: 'Acme',
  company_masked: false,
  remote_type: 'remote',
  work_format: [],
  employee_type: ['employment'],
  english_level: 'b2',
  verified: true,
  can_apply_directly: true,
  created_at: '2026-08-20T09:00:00.000000Z',
  salary: { currency: 'USD', min: 5000, max: 7000 },
  specializations: [{ code: 'backend', name: 'Бэкенд', name_en: 'Backend' }],
  grades: ['senior'],
  skills: ['go', 'kubernetes'],
  regions: [{ code: 'eu', name: 'Европа', name_en: 'Europe' }],
  cities: ['berlin'],
  description: '<p>We build <b>payments</b>.</p><ul><li>Go &amp; Postgres</li><li>On call</li></ul>',
  description_format: 'html',
}

const OK_BODY = {
  data: VACANCY,
  charged: true,
  quota: { action: 'vacancy_opens', limit: 1000, used: 2, remaining: 998, used_by_agent: 2 },
}

/**
 * A compact search card shaped like VacancySummaryProjection (spec §6): the fields the server
 * returns for search, feed lists and webhook cards. This is NOT the full detail card (VACANCY
 * above) - it carries no `company` string, no url, no created_at. The context-budget gate
 * measures a page of these after the CLI selects the shortlist fields from them, and each card
 * is deliberately richer than a median production card so the guard has no slack it should not.
 */
function summaryCard(i) {
  return {
    title: ['Senior Go Engineer', 'Backend Developer (Python)', 'Full-Stack Engineer', 'Data Platform Engineer'][i % 4],
    slug: `vacancy-${i}-some-company`,
    company_masked: i % 3 === 0,
    can_apply_directly: i % 2 === 0,
    skills: ['go', 'kubernetes', 'postgres', 'grpc'].slice(0, (i % 4) + 1),
    specializations: [{ code: 'backend', name: 'Бэкенд', name_en: 'Backend' }],
    grades: ['senior'],
    regions: [{ code: 'eu', name: 'Европа', name_en: 'Europe' }],
    cities: ['berlin'],
    remote_type: ['remote', 'hybrid', 'onsite'][i % 3],
    work_format: i % 2 ? ['fulltime'] : [],
    salary: i % 2 ? { currency: 'USD', min: 5000, max: 7000, salary_in_usd: 6000 } : null,
    vacancy_language: 'en',
    english_level: ['b1', 'b2', 'c1'][i % 3],
  }
}

/**
 * The compact card selection the CLI actually applies, read from the source so the gate measures
 * the real field list and not a copy of it that could drift. The gate is the CLI's selection, so
 * it has to be the CLI's own list.
 */
function cliCardFields() {
  const cli = readFileSync(CLI, 'utf8')
  const m = cli.match(/const CARD_FIELDS = \[([^\]]*)\]/)
  assert.ok(m, 'CARD_FIELDS is defined in the CLI')
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
}

/**
 * The capabilities the curated commands resolve, at their real REST method and path. Every
 * behaviour test reuses this manifest so a command can find the capability it asks for;
 * transport tests hand in their own to prove the CLI follows the manifest and not a path of
 * its own. Each row is [id, method, path, extra?].
 */
const CAPS = [
  ['account.status', 'GET', '/api/agent/me'],
  ['vacancies.search', 'GET', '/api/agent/vacancies'],
  ['vacancies.read', 'GET', '/api/agent/vacancies/{slug}'],
  ['vacancies.reveal', 'POST', '/api/agent/vacancies/{slug}/reveal'],
  ['applications.apply', 'POST', '/api/agent/vacancies/{slug}/apply'],
  ['feeds.list', 'GET', '/api/agent/feeds'],
  ['feeds.vacancies', 'GET', '/api/agent/feeds/{feed_id}/vacancies'],
  ['feeds.create', 'POST', '/api/agent/feeds'],
  ['feeds.set_delivery', 'PUT', '/api/agent/feeds/{feed_id}/delivery'],
  ['profiles.list', 'GET', '/api/agent/profiles'],
  ['webhooks.list', 'GET', '/api/agent/webhooks'],
  ['webhooks.create', 'POST', '/api/agent/webhooks'],
  ['feedback.send', 'POST', '/api/agent/feedback'],
  ['filters.guide', 'GET', '/api/agent/filters/guide'],
]

/**
 * One capability, shaped like the API's own manifest entry (AgentManifest::capability). Path
 * placeholders are marked `path` in the input locations; `extra.locations` adds the rest,
 * which is all a generic `api call` needs to route an input.
 */
function capability(id, method, path, extra = {}) {
  const placeholders = [...path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1])
  const locations = {}
  for (const name of placeholders) locations[name] = 'path'
  return {
    id,
    method,
    path,
    inputs: {
      schema: { type: 'object', properties: {}, additionalProperties: false },
      locations: { ...locations, ...(extra.locations || {}) },
    },
    ability: 'agent:read',
    usage_class: 'daily',
    stability: 'beta',
    contract_version: 1,
    mcp_exposure: 'resident',
    meter: 'none',
    rate_limit_policies: [],
    retry_policy: 'read_only',
    output_projection: extra.projection ?? 'x',
    cli_alias: null,
    description: 'x',
  }
}

/** A whole manifest document, versioned and with a revision, the way GET /api/agent/meta answers. */
function manifestDoc(rows = CAPS) {
  return {
    schema_version: 1,
    capabilities: rows.map(([id, method, path, extra]) => capability(id, method, path, extra || {})),
    manifest_revision: 'test-revision',
  }
}

/**
 * Run one command against a stub Hirify. The stub answers the two bootstrap documents itself -
 * the public well-known and the authenticated manifest - so a test only has to describe the
 * capability response through `reply`. Returns what the person would have seen, the capability
 * requests in `seen` (bootstrap excluded), and the bootstrap requests with their headers.
 *
 * `opts`: `manifest` (the document, or null to make the manifest unservable), `wellKnown`
 * (override the public document), `etag` (the manifest ETag, for revalidation).
 */
async function run(argv, reply, opts = {}) {
  const { manifest = manifestDoc(), wellKnown = undefined, etag = '"m1"', wellKnownStatus = 200 } = opts
  const seen = []
  const bootstrap = []
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0]

    if (path === '/.well-known/hirify-agent') {
      bootstrap.push({ url: req.url, headers: req.headers })
      // `wellKnownStatus: 'drop'` cuts the socket so the fetch throws: the deterministic stand-in
      // for Hirify being unreachable, which `intro` has to survive.
      if (wellKnownStatus === 'drop') { req.socket.destroy(); return }
      const doc = wellKnown !== undefined
        ? wellKnown
        : { schema_version: 1, manifest_url: `http://${req.headers.host}/api/agent/meta`, openapi_url: `http://${req.headers.host}/api/agent/openapi.json`, intro: null }
      res.writeHead(wellKnownStatus, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(doc))
      return
    }

    if (path === '/api/agent/meta') {
      bootstrap.push({ url: req.url, headers: req.headers })
      if (manifest === null) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{}'); return }
      const headers = { 'Content-Type': 'application/json' }
      if (etag) headers.ETag = etag
      if (etag && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return }
      res.writeHead(200, headers); res.end(JSON.stringify(manifest))
      return
    }

    seen.push(req.url)
    // `text` sends the bytes as they are, for the cases where the answer is not JSON.
    const { status = 200, body = {}, text = null, headers = {} } = reply(req) ?? {}
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(text === null ? JSON.stringify(body) : text)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${server.address().port}`

  try {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: {
        ...process.env,
        HIRIFY_API: api,
        HIRIFY_KEY: 'test-key',
        HIRIFY_DEBUG: '',
        XDG_CONFIG_HOME: CONFIG_HOME,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    const code = await new Promise((resolve) => child.once('close', resolve))
    return { code, stdout, stderr, seen, bootstrap }
  } finally {
    server.close()
  }
}

const answer = (status, body) => () => ({ status, body })

// ── read: the card ─────────────────────────────────────────────────────────
test('read prints the vacancy, its terms and its text', async () => {
  const { code, stdout } = await run(['vacancy', 'read', 'senior-go-engineer'], answer(200, OK_BODY))

  assert.equal(code, 0)
  assert.match(stdout, /^senior-go-engineer\n {2}Senior Go Engineer · Acme\n {2}\[remote · employment · b2 · 5000-7000 USD · verified\]/)
  assert.match(stdout, /^area: {5}Backend$/m)
  assert.match(stdout, /^grade: {4}senior$/m)
  assert.match(stdout, /^skills: {3}go · kubernetes$/m)
  assert.match(stdout, /^location: Europe · berlin$/m)
  assert.match(stdout, /^posted: {3}2026-08-20$/m)
  assert.match(stdout, /^page: {5}https:\/\/hirify\.me\/jobs\/senior-go-engineer/m)
})

test('read turns the html description into lines a terminal can print', async () => {
  const { stdout } = await run(['vacancy', 'read', 'senior-go-engineer'], answer(200, OK_BODY))

  assert.match(stdout, /We build payments\./)
  assert.match(stdout, /- Go & Postgres/)
  assert.match(stdout, /- On call/)
  assert.ok(!stdout.includes('<p>'), 'no tags survive into the output')
  assert.ok(!stdout.includes('&amp;'), 'entities are decoded')
})

test('read says which of the two ways to apply this vacancy takes', async () => {
  const hosted = await run(['vacancy', 'read', 'senior-go-engineer'], answer(200, OK_BODY))
  assert.match(hosted.stdout, /Apply on Hirify: hirify vacancy apply senior-go-engineer/)

  const elsewhere = await run(['vacancy', 'read', 'senior-go-engineer'], answer(200, {
    ...OK_BODY,
    data: { ...VACANCY, can_apply_directly: false },
  }))
  assert.match(elsewhere.stdout, /Where to apply: hirify vacancy reveal senior-go-engineer \(uses 1 reveal\)/)
  assert.ok(!elsewhere.stdout.includes('hirify vacancy apply'), 'an apply we cannot make is never offered')
})

test('read reports what the open cost and what is left', async () => {
  const first = await run(['vacancy', 'read', 'senior-go-engineer'], answer(200, OK_BODY))
  assert.match(first.stdout, /\(1 vacancy open used\)/)
  assert.match(first.stdout, /998 opens left today/)

  const again = await run(['vacancy', 'read', 'senior-go-engineer'], answer(200, { ...OK_BODY, charged: false }))
  assert.match(again.stdout, /\(no vacancy open used: this one was already opened today\)/)
})

test('read keeps quiet about a text that is not there', async () => {
  const { stdout } = await run(['vacancy', 'read', 'senior-go-engineer'], answer(200, {
    ...OK_BODY,
    data: { ...VACANCY, description: null },
  }))
  assert.match(stdout, /This vacancy has no text on it\./)
  assert.ok(!stdout.includes('undefined'), 'a missing field never reaches the screen as a word')
})

test('read --json hands over the server payload untouched', async () => {
  const { code, stdout } = await run(['vacancy', 'read', 'senior-go-engineer', '--json'], answer(200, OK_BODY))

  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), OK_BODY)
})

// ── read: flags and arguments ──────────────────────────────────────────────
// Two defects in this CLI were flags being read as data. Both directions are pinned here.
test('a flag before the slug does not become the slug', async () => {
  const { code, seen } = await run(['vacancy', 'read', '--json', 'senior-go-engineer'], answer(200, OK_BODY))

  assert.equal(code, 0)
  assert.deepEqual(seen, ['/api/agent/vacancies/senior-go-engineer'])
})

test('read without a slug asks for one and sends nothing', async () => {
  const { code, stderr, seen } = await run(['vacancy', 'read'], answer(200, OK_BODY))

  assert.equal(code, 1)
  assert.match(stderr, /a vacancy slug is required: hirify vacancy read <slug>/)
  assert.deepEqual(seen, [], 'nothing is asked of the server')
})

test('a slug with a slash in it is still asked for as one slug', async () => {
  const { seen } = await run(['vacancy', 'read', 'a/b'], answer(404, { message: 'Vacancy not found.' }))

  assert.deepEqual(seen, ['/api/agent/vacancies/a%2Fb'])
})

// ── read: refusals ─────────────────────────────────────────────────────────
test('an unknown slug is named as an unknown slug', async () => {
  const { code, stderr } = await run(['vacancy', 'read', 'nope'], answer(404, { error: true, message: 'Vacancy not found.' }))

  assert.equal(code, 1)
  assert.match(stderr, /there is no vacancy with that slug\./)
})

test("the day's opens running out is not reported as reveals running out", async () => {
  const { code, stderr } = await run(['vacancy', 'read', 'senior-go-engineer'], answer(429, {
    error: true,
    message: 'Rate limit exceeded. You cannot open more than 1000 vacancies per day.',
    quota: { action: 'vacancy_opens', limit: 1000, used: 1000, remaining: 0 },
  }))

  assert.equal(code, 1)
  assert.match(stderr, /opened as many vacancies today as the daily allowance covers/)
  assert.ok(!stderr.includes('reveal'), 'the reveal budget is a different wall and is not named here')
})

test('reveals running out still reads as reveals running out', async () => {
  const { code, stderr } = await run(['vacancy', 'reveal', 'senior-go-engineer'], answer(429, {
    error: true,
    message: 'Rate limit exceeded. You have no contact reveals left right now.',
    quota: { action: 'contact_reveals', used: 30, remaining: 0 },
  }))

  assert.equal(code, 1)
  assert.match(stderr, /you have no reveals left right now/)
})

test('going too fast is told apart from running out', async () => {
  const { code, stderr } = await run(['vacancy', 'read', 'senior-go-engineer'], () => ({
    status: 429,
    body: { error: true, message: 'Too Many Attempts.' },
    headers: { 'Retry-After': '12' },
  }))

  assert.equal(code, 1)
  assert.match(stderr, /too many requests in a short time\. Please try again in 12 seconds\./)
})

// ── the server notice on a successful answer, and the policy restriction ────
// A successful answer can carry a structured `meta.notice`: the CLI prints the useful result
// and then the notice, and keeps the call a success. A restriction is a separate wall - a
// canonical 403 that names itself `access_restricted` - never a quota or a rate limit, and
// never retried. The CLI renders only what the server sent and knows nothing of the policy.

const NOTICE = {
  id: 'ntc_1',
  code: 'site_automation_warning',
  policy: 'site_automation',
  message: 'Your access is not restricted. For automated workflows, use the official AI access through REST API, MCP, or CLI.',
  actions: ['open_ai_access', 'continue_site'],
  repeat_until: '2026-09-06T00:00:00Z',
}

const RESTRICTED = {
  error: {
    code: 'access_restricted',
    policy: 'catalog_mirroring',
    restricted_until: '2026-09-01T12:00:00Z',
    appeal_url: 'https://hirify.me/account/appeal',
    retryable: false,
    message: 'Access on this account is restricted for now.',
  },
}

// A blocking notice: a canonical 409 that names itself `action_required` and carries the whole
// notice under `error.notice`. It stands in place of the answer until the person acknowledges it,
// so - unlike the `meta.notice` on a success above - it must never let a useful result through and
// never retry. In the Agent API this is the catalog_mirroring case, whose only advertised action is
// `acknowledge`. The acknowledgement is a capability the manifest advertises, `security.notices.ack`.
const BLOCKING = {
  ok: false,
  error: {
    code: 'action_required',
    retryable: false,
    notice: {
      id: 'ntc_2',
      code: 'catalog_mirroring_warning',
      policy: 'catalog_mirroring',
      message: 'Please confirm how you want to continue before we return more of the catalog.',
      actions: ['acknowledge'],
      repeat_until: '2026-09-06T00:00:00Z',
    },
  },
}

test('a notice on a successful read is printed after the useful result, still a success', async () => {
  const { code, stdout } = await run(['vacancy', 'read', 'senior-go-engineer'],
    answer(200, { ...OK_BODY, meta: { notice: NOTICE } }))

  assert.equal(code, 0, 'the notice does not turn a success into a failure')
  assert.match(stdout, /Senior Go Engineer · Acme/, 'the useful result is still emitted')
  assert.match(stdout, /Notice: Your access is not restricted\./, 'the notice text is shown to the person')
  assert.ok(stdout.indexOf('Notice:') > stdout.indexOf('Senior Go Engineer'),
    'the notice comes after the useful result, not before it')
})

test('a notice rides along a list result without disturbing its pagination', async () => {
  const { code, stdout } = await run(['vacancy', 'search', 'go'], answer(200, {
    data: [VACANCY],
    meta: { page: 1, per_page: 20, total: 1, last_page: 1, notice: NOTICE },
  }))

  assert.equal(code, 0)
  assert.match(stdout, /Senior Go Engineer/, 'the list is still printed')
  assert.match(stdout, /Notice: Your access is not restricted\./)
  assert.ok(stdout.indexOf('Notice:') > stdout.indexOf('Senior Go Engineer'), 'the notice follows the list')
})

test('--json keeps the notice structured and does not paraphrase it', async () => {
  const body = { ...OK_BODY, meta: { notice: NOTICE } }
  const { code, stdout } = await run(['vacancy', 'read', 'senior-go-engineer', '--json'], answer(200, body))

  assert.equal(code, 0)
  // The whole envelope is handed over untouched: the notice stays a structured object with its
  // own fields, so a machine reader never has to scrape the message text out of a sentence.
  assert.deepEqual(JSON.parse(stdout), body)
  assert.deepEqual(JSON.parse(stdout).meta.notice, NOTICE)
  assert.ok(!/^Notice:/m.test(stdout), 'machine output carries no human notice line')
})

test('a successful answer with no notice keeps its exact prior behaviour', async () => {
  const human = await run(['vacancy', 'read', 'senior-go-engineer'], answer(200, OK_BODY))
  assert.equal(human.code, 0)
  assert.ok(!human.stdout.includes('Notice:'), 'no notice, no notice line')

  const json = await run(['vacancy', 'read', 'senior-go-engineer', '--json'], answer(200, OK_BODY))
  assert.equal(json.code, 0)
  assert.deepEqual(JSON.parse(json.stdout), OK_BODY, 'the payload is handed over exactly as before')
})

test('access_restricted is reported as a policy restriction and never retried', async () => {
  const { code, stderr, seen } = await run(['vacancy', 'read', 'senior-go-engineer'], answer(403, RESTRICTED))

  assert.equal(code, 1)
  assert.match(stderr, /Access on this account is restricted for now\./, 'the server message is passed on')
  assert.match(stderr, /2026-09-01T12:00:00Z/, 'when it lifts is shown')
  assert.match(stderr, /https:\/\/hirify\.me\/account\/appeal/, 'where to appeal is shown')
  assert.equal(seen.length, 1, 'a policy 403 is asked once and not retried')
  assert.ok(!/allowance|too many requests/i.test(stderr), 'a restriction is not a quota or a rate limit')
})

test('a restriction with no server message still reads distinctly and carries its fields', async () => {
  const { code, stderr } = await run(['vacancy', 'reveal', 'senior-go-engineer'], answer(403, {
    error: { code: 'access_restricted', policy: 'contact_breadth', restricted_until: '2026-09-02T00:00:00Z', retryable: false },
  }))

  assert.equal(code, 1)
  assert.match(stderr, /access on this account is restricted \(403\)/i)
  assert.match(stderr, /2026-09-02T00:00:00Z/)
  assert.ok(!/appeal/i.test(stderr), 'a field the server omitted is not invented')
})

test('the restriction, the quota wall and the rate-limit wall stay three different messages', async () => {
  const restricted = await run(['vacancy', 'read', 'senior-go-engineer'], answer(403, RESTRICTED))
  const quota = await run(['vacancy', 'read', 'senior-go-engineer'], answer(429, {
    error: true, message: 'Rate limit exceeded.', quota: { action: 'vacancy_opens', limit: 1000, used: 1000, remaining: 0 },
  }))
  const rate = await run(['vacancy', 'read', 'senior-go-engineer'], () => ({
    status: 429, body: { error: true, message: 'Too Many Attempts.' }, headers: { 'Retry-After': '12' },
  }))

  assert.match(restricted.stderr, /restricted/i)
  assert.match(quota.stderr, /opened as many vacancies today as the daily allowance covers/)
  assert.match(rate.stderr, /too many requests in a short time/)
  assert.ok(!/allowance|too many requests/i.test(restricted.stderr))
  assert.ok(!/restricted/i.test(quota.stderr) && !/restricted/i.test(rate.stderr))
})

test('a caller that reads its own 403 still cannot mistake access_restricted for its refusal', async () => {
  const { code, stderr, seen } = await run(['webhook', 'create', 'My hook', 'https://example.com/hook'],
    answer(403, RESTRICTED))

  assert.equal(code, 1)
  assert.match(stderr, /Access on this account is restricted for now\./)
  assert.ok(!/creating a delivery endpoint is not available/.test(stderr),
    'a policy restriction is not flattened into the capability-level refusal')
  assert.equal(seen.length, 1, 'still asked once and not retried')
})

// ── the blocking notice that stands in place of the answer ──────────────────
// `action_required` is a 409 the useful answer never survives: the CLI stops, shows the server's
// notice and the one command that clears it, exits unsuccessfully and never retries. A generic
// client can skim a notice riding on a success; it cannot skim a failure that carries no result.

test('action_required stops the command, prints no useful result, and points at the acknowledgement', async () => {
  const { code, stdout, stderr, seen } = await run(['vacancy', 'read', 'senior-go-engineer'], answer(409, BLOCKING))

  assert.equal(code, 1, 'a blocking notice exits unsuccessfully')
  assert.equal(stdout, '', 'no vacancy result reaches the screen while the notice stands')
  assert.match(stderr, /Please confirm how you want to continue before we return more of the catalog\./,
    'the server notice is passed on unchanged')
  // The printed acknowledgement runs as it stands: the advertised capability, resolved through the
  // manifest, carrying the notice's own id and its advertised action, exactly as sent.
  assert.ok(
    stderr.includes(`To continue, acknowledge this notice: hirify api call security.notices.ack --data '{"id":"ntc_2","action":"acknowledge"}'`),
    'the exact, runnable acknowledgement command and payload are shown')
  assert.equal(seen.length, 1, 'a blocking 409 is asked once and never retried automatically')
})

test('a blocking action_required is not a success notice: no useful result, never exit 0', async () => {
  // The mutation this guards against: treating `action_required` like a `meta.notice` on a success -
  // printing the useful result and a trailing notice, exit 0. That is exactly the gap the blocking
  // status closes, so turning it back into a success notice must fail here.
  const { code, stdout } = await run(['vacancy', 'read', 'senior-go-engineer'], answer(409, BLOCKING))

  assert.equal(code, 1, 'a blocking notice is a failure, not a success with a trailing note')
  assert.ok(!stdout.includes('Senior Go Engineer'), 'the useful result is withheld, not printed under the notice')
  assert.ok(!/^Notice:/m.test(stdout), 'it is not rendered as the success-path meta.notice line')
})

test('a blocking notice on the metered reveal fires ahead of the command reading its own answer', async () => {
  const { code, stdout, stderr, seen } = await run(['vacancy', 'reveal', 'senior-go-engineer'], answer(409, BLOCKING))

  assert.equal(code, 1)
  assert.equal(stdout, '', 'no contacts are printed and no spend is implied while the notice stands')
  assert.match(stderr, /Please confirm how you want to continue/, 'the notice is what the person sees, not a reveal refusal')
  assert.match(stderr, /hirify api call security\.notices\.ack --data '\{"id":"ntc_2","action":"acknowledge"\}'/)
  assert.equal(seen.length, 1, 'asked once and not retried')
})

test('api call exposes a blocking 409 envelope untouched, without a next step of ours', async () => {
  const { code, stdout, stderr } = await run(
    ['api', 'call', 'vacancies.read', '--data', '{"slug":"senior-go-engineer"}', '--json'],
    answer(409, BLOCKING))

  assert.equal(code, 1, 'a 4xx from api call still exits unsuccessfully')
  assert.deepEqual(JSON.parse(stdout), BLOCKING, 'the server envelope is handed over exactly, notice and all')
  assert.ok(!stdout.includes('hirify api call security.notices.ack'),
    'api call renders the server contract only and adds no acknowledgement sentence of ours')
  assert.match(stderr, /the server answered 409/, 'the refusal is noted on stderr while the envelope stays on stdout')
})

test('an ordinary 409 without the action_required code keeps its plain refusal, unchanged', async () => {
  const { code, stdout, stderr } = await run(['vacancy', 'read', 'senior-go-engineer'], answer(409, {
    error: { code: 'conflict', message: 'Something conflicted.' },
  }))

  assert.equal(code, 1)
  assert.equal(stdout, '', 'still no useful result on a refusal')
  assert.match(stderr, /that command could not be completed/, 'a plain conflict falls to the ordinary handling, unchanged')
  assert.ok(!stderr.includes('security.notices.ack'), 'only action_required earns the acknowledgement step')
})

// ── what the rest of the CLI now says ──────────────────────────────────────
test('me shows every budget the server reports', async () => {
  const { stdout } = await run(['account', 'show'], answer(200, {
    data: {
      plan: 'pro',
      quota: {
        reveal: { action: 'contact_reveals', used: 4, remaining: 26 },
        read: { action: 'vacancy_opens', limit: 1000, used: 2, remaining: 998 },
        apply: { action: 'apply', limit: 30, used: 7, remaining: 23 },
      },
      usage: { reveal: { today: 4, last_7d: 11 } },
    },
  }))

  assert.match(stdout, /^plan: {4}pro$/m)
  assert.match(stdout, /^reveals: 26 left$/m)
  assert.match(stdout, /^opens: {3}998 left today$/m)
  // Applying is metered and the server has always said so. Leaving this line out is how
  // the skill came to tell agents that applying spends nothing.
  assert.match(stdout, /^applies: 23 left today$/m)
  assert.match(stdout, /^usage: {3}4 today · 11 in 7d$/m)
})

test('a budget the server does not report is not invented', async () => {
  const { stdout } = await run(['account', 'show'], answer(200, {
    data: { plan: 'free', quota: { reveal: { remaining: 3 } } },
  }))

  assert.match(stdout, /^reveals: 3 left$/m)
  assert.ok(!stdout.includes('applies:'), 'an absent budget gets no line')
  assert.ok(!stdout.includes('opens:'), 'an absent budget gets no line')
})

test('a list points at reading one before revealing it', async () => {
  const { stdout } = await run(['vacancy', 'search', 'go'], answer(200, {
    data: [VACANCY],
    meta: { page: 1, per_page: 20, total: 1, last_page: 1 },
  }))

  assert.match(stdout, /^senior-go-engineer\n {2}Senior Go Engineer · Acme$/m)
  assert.match(stdout, /^Read one: hirify vacancy read <slug>$/m)
  assert.match(stdout, /^Where to apply: hirify vacancy reveal <slug> \(uses 1 reveal\)$/m)
})

// ── search as a conduit ────────────────────────────────────────────────────
// The endpoint takes the same criteria the site's filter form produces. The CLI must not
// be the thing that decides which of them are expressible.
test('any option is passed on to the API under the name it was given', async () => {
  const { seen } = await run(
    ['vacancy', 'search', 'senior', 'go', '--grade', 'senior', '--work_format', 'remote', '--excluded_countries', 'ru'],
    answer(200, { data: [], meta: {} }),
  )

  const q = new URLSearchParams(seen[0].split('?')[1])
  assert.equal(q.get('search'), 'senior go')
  assert.equal(q.get('grade'), 'senior')
  assert.equal(q.get('work_format'), 'remote')
  assert.equal(q.get('excluded_countries'), 'ru')
})

test('an option nobody has ever written a flag for still reaches the API', async () => {
  const { seen } = await run(
    ['vacancy', 'search', '--a_filter_invented_after_this_test', 'yes', '--another=42'],
    answer(200, { data: [], meta: {} }),
  )

  const q = new URLSearchParams(seen[0].split('?')[1])
  assert.equal(q.get('a_filter_invented_after_this_test'), 'yes')
  assert.equal(q.get('another'), '42')
})

test('the same option twice is joined the way the site sends a multi-value filter', async () => {
  const { seen } = await run(
    ['vacancy', 'search', '--grade', 'senior', '--grade', 'middle'],
    answer(200, { data: [], meta: {} }),
  )

  assert.equal(new URLSearchParams(seen[0].split('?')[1]).get('grade'), 'senior,middle')
})

test('--limit still works and arrives under the name the server publishes', async () => {
  const { seen } = await run(['vacancy', 'search', 'go', '--limit', '5'], answer(200, { data: [], meta: {} }))

  const q = new URLSearchParams(seen[0].split('?')[1])
  assert.equal(q.get('per_page'), '5')
  assert.equal(q.get('limit'), null, 'the CLI name does not leak into the request')
})

test('--json steers the CLI and is never sent as a filter', async () => {
  const { seen, stdout } = await run(['vacancy', 'search', 'go', '--json'], answer(200, { data: [], meta: {} }))

  assert.equal(new URLSearchParams(seen[0].split('?')[1]).get('json'), null)
  assert.equal(new URLSearchParams(seen[0].split('?')[1]).get('search'), 'go')
  assert.deepEqual(JSON.parse(stdout), { data: [], meta: {} })
})

test('a flag before the words does not eat one of them', async () => {
  const { seen } = await run(['vacancy', 'search', '--json', 'senior', 'go'], answer(200, { data: [], meta: {} }))

  assert.equal(new URLSearchParams(seen[0].split('?')[1]).get('search'), 'senior go')
})

// ── paging ─────────────────────────────────────────────────────────────────
test('search takes a page', async () => {
  const { seen } = await run(['vacancy', 'search', 'go', '--page', '3'], answer(200, { data: [], meta: {} }))

  assert.equal(new URLSearchParams(seen[0].split('?')[1]).get('page'), '3')
})

test('feed takes a page and a limit', async () => {
  const { seen } = await run(['feed', 'show', '31', '--page', '2', '--limit', '5'], answer(200, { data: [], meta: {} }))

  assert.equal(seen[0].split('?')[0], '/api/agent/feeds/31/vacancies')
  const q = new URLSearchParams(seen[0].split('?')[1])
  assert.equal(q.get('page'), '2')
  assert.equal(q.get('per_page'), '5')
})

test('feed with no options asks for the feed and nothing else', async () => {
  const { seen } = await run(['feed', 'show', '31'], answer(200, { data: [], meta: {} }))

  assert.deepEqual(seen, ['/api/agent/feeds/31/vacancies'])
})

test('the page and the next one are named, and a full page offers the next', async () => {
  const { stdout } = await run(['vacancy', 'search', 'go'], answer(200, {
    data: [VACANCY, { ...VACANCY, slug: 'b' }],
    meta: { page: 2, per_page: 2, total: 2, last_page: 1 },
  }))

  assert.match(stdout, /^Showing 2, page 2\.$/m)
  assert.match(stdout, /^More: add --page 3$/m)
})

test('a total is printed only when it is a total and not the size of the page', async () => {
  // What the agent search endpoint answers today: total equal to what it just returned.
  // "Showing 2 of 2" would read as "that is the whole board" and it is not.
  const clamped = await run(['vacancy', 'search', 'go'], answer(200, {
    data: [VACANCY, { ...VACANCY, slug: 'b' }],
    meta: { page: 1, per_page: 2, total: 2, last_page: 1 },
  }))
  assert.match(clamped.stdout, /^Showing 2, page 1\.$/m)

  // What it answers once the server counts properly: printed with no change here.
  const real = await run(['vacancy', 'search', 'go'], answer(200, {
    data: [VACANCY, { ...VACANCY, slug: 'b' }],
    meta: { page: 1, per_page: 2, total: 1665, last_page: 833 },
  }))
  assert.match(real.stdout, /^Showing 2 of 1665, page 1 of 833\.$/m)
  assert.match(real.stdout, /^More: add --page 2$/m)
})

test('the last page does not offer another one', async () => {
  const { stdout } = await run(['vacancy', 'search', 'go'], answer(200, {
    data: [VACANCY],
    meta: { page: 4, per_page: 20, total: 61, last_page: 4 },
  }))

  assert.match(stdout, /^Showing 1 of 61, page 4 of 4\.$/m)
  assert.ok(!stdout.includes('More: add --page'), 'there is no page 5 to offer')
})

// ── intro ──────────────────────────────────────────────────────────────────
// The published intro is release-approved text on the public agent well-known, so it can be
// refreshed without a new CLI. When Hirify publishes none, or cannot be reached, the built-in
// text stands in - so intro and the sign-in help it carries work before login and offline.
test('intro falls back to the built-in guide when the well-known publishes none', async () => {
  // The default well-known serves intro: null, so this exercises the fallback.
  const { code, stdout, seen } = await run(['intro'], answer(200, {}))

  assert.equal(code, 0)
  assert.deepEqual(seen, [], 'intro runs before anyone has signed in')
  const topics = [/hirify feed list/, /hirify vacancy search/, /hirify vacancy read/,
    /hirify vacancy reveal/, /hirify vacancy apply/, /hirify login/, /hirify api call/]
  for (const topic of topics) {
    assert.match(stdout, topic)
  }
  assert.match(stdout, /Reading one vacancy in full spends one of the Agent API's daily vacancy opens/)
  assert.ok(!/browser spends|shared with (the )?(site|website|browser)/i.test(stdout),
    'the Agent API allowance is not described as a website or browser allowance')
  assert.match(stdout, /cannot be recalled/)
})

test('intro prints the text Hirify publishes when the well-known carries one', async () => {
  const published = 'Hirify intro, published 2026. This is the release-approved guide.'
  const { code, stdout, seen, bootstrap } = await run(['intro'], answer(200, {}), {
    wellKnown: { schema_version: 1, intro: published },
  })

  assert.equal(code, 0)
  assert.equal(stdout.trim(), published, 'the published intro is printed as it came')
  assert.ok(!stdout.includes('job search for AI agents'), 'not the built-in fallback')
  assert.deepEqual(seen, [], 'no capability is called: intro needs no sign-in')
  const wells = bootstrap.filter((b) => b.url.split('?')[0] === '/.well-known/hirify-agent')
  assert.equal(wells.length, 1, 'the intro is fetched from the public well-known')
  assert.equal(wells[0].headers.authorization, undefined, 'and it is fetched without a token')
})

test('intro still works when Hirify cannot be reached', async () => {
  // The well-known socket is cut, so the fetch throws. intro must not need the network: this is
  // the "sign-in help available offline" requirement.
  const { code, stdout } = await run(['intro'], answer(200, {}), { wellKnownStatus: 'drop' })

  assert.equal(code, 0)
  assert.match(stdout, /hirify login/)
  assert.match(stdout, /Reading one vacancy in full spends one of the Agent API's daily vacancy opens/)
})

test('intro is reachable from the help', async () => {
  const { stdout } = await run(['--help'], answer(200, {}))

  assert.match(stdout, /hirify intro +what this can do, and in what order/)
})

test('everything that ships is English', async () => {
  // The package goes to npm and skills.sh. Russian in it reads as an internal file
  // published by accident, so it is checked rather than remembered.
  const { readFileSync, readdirSync } = await import('node:fs')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const files = ['bin/hirify.js', 'README.md', 'package.json', 'NOTICE',
    ...readdirSync(join(root, 'skills/hirify')).map((f) => `skills/hirify/${f}`)]

  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    const cyrillic = text.match(/[\u0400-\u04FF]+/g)
    assert.equal(cyrillic, null, `${file} carries Russian: ${cyrillic?.slice(0, 3).join(', ')}`)
    const dashes = text.match(/[\u2014\u2013]/g)
    assert.equal(dashes, null, `${file} carries a long dash`)
  }
})

test('the npm package name and install instructions stay aligned', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const cli = readFileSync(CLI, 'utf8')

  assert.equal(pkg.name, 'hirify-cli')
  assert.match(readme, /npm install -g hirify-cli/)
  assert.match(readme, /npx hirify-cli login/)
  assert.match(cli, /npm install -g hirify-cli/)
  assert.ok(!readme.includes('npx hirify login'))
})

test('read is in the help', async () => {
  const { code, stdout } = await run(['--help'], answer(200, {}))

  assert.equal(code, 0)
  assert.match(stdout, /hirify vacancy read <slug> +one vacancy in full, with its text/)
})

// ── the grammar: <noun> <verb> ─────────────────────────────────────────────
// The verb is data in the same sense a slug is, so the two defects pinned above -
// a flag read as data, a flag hiding data - are pinned here for the verb as well.
test('a flag written before the verb does not stand in for it', async () => {
  const { code, seen } = await run(['feed', '--json', 'show', '31'], answer(200, { data: [], meta: {} }))

  assert.equal(code, 0)
  assert.deepEqual(seen, ['/api/agent/feeds/31/vacancies'])
})

test('a noun on its own names the verbs it takes', async () => {
  const { code, stderr, seen } = await run(['vacancy'], answer(200, {}))

  assert.equal(code, 1)
  assert.match(stderr, /hirify vacancy takes a verb: search, read, reveal, apply/)
  assert.deepEqual(seen, [], 'nothing is asked of the server')
})

test('a noun asked for help answers on stdout and succeeds', async () => {
  const { code, stdout } = await run(['feed', '--help'], answer(200, {}))

  assert.equal(code, 0)
  assert.match(stdout, /hirify feed takes a verb: list, show, create, deliver/)
})

test('a verb the noun does not have is named, with the ones it does', async () => {
  const { code, stderr, seen } = await run(['webhook', 'destroy'], answer(200, {}))

  assert.equal(code, 1)
  assert.match(stderr, /hirify webhook has no verb "destroy"/)
  assert.match(stderr, /hirify webhook takes a verb: list, create/)
  assert.deepEqual(seen, [], 'nothing is asked of the server')
})

test('every noun and verb in the help is a command that exists', async () => {
  const { stdout } = await run(['--help'], answer(200, {}))

  // The help is the list an agent works from. A line in it that no router entry answers
  // sends that agent to an "unknown command", which reads as the tool being broken.
  const listed = [...stdout.matchAll(/^ {2}hirify ([a-z]+)(?: ([a-z]+))?/gm)]
    .map(([, noun, verb]) => [noun, verb].filter(Boolean).join(' '))

  assert.ok(listed.length >= 15, `the help lists ${listed.length} commands`)
  for (const command of listed) {
    const { code, stderr } = await run([...command.split(' '), '--help'], answer(200, {}))
    assert.ok(!/unknown command|has no verb/.test(stderr), `${command}: ${stderr.trim()}`)
    assert.notEqual(code, 127, `${command} did not run`)
  }
})

// ── api call: the generic door ─────────────────────────────────────────────
// It takes a capability id, not a path. The manifest says which method and path answer it,
// so a capability the server adds is reachable from here with no change to the CLI.
test('api call resolves a capability id to the method and path the manifest gives', async () => {
  // --json here for the canonical echo: routing is proven by `seen`, and --json is the raw
  // contract, so the body comes back exactly as the server sent it.
  const { code, stdout, seen } = await run(
    ['api', 'call', 'vacancies.search', '--json', '--data', '{"search":"go","per_page":"2"}'],
    answer(200, { data: [], meta: { page: 1 } }),
  )

  assert.equal(code, 0)
  assert.equal(seen[0].split('?')[0], '/api/agent/vacancies')
  const q = new URLSearchParams(seen[0].split('?')[1])
  assert.equal(q.get('search'), 'go')
  assert.equal(q.get('per_page'), '2')
  assert.equal(q.get('json'), null, 'a CLI flag is never sent to the server')
  assert.deepEqual(JSON.parse(stdout), { data: [], meta: { page: 1 } })
})

test('a capability invented only in the manifest is reachable with no change to the CLI', async () => {
  // This is the whole point: nothing in bin/hirify.js names this capability. The manifest
  // alone makes it callable, so a capability the server adds is reachable the day it ships.
  const manifest = manifestDoc([['experiments.ping', 'GET', '/api/agent/experiments/ping']])
  const { code, stdout, seen } = await run(['api', 'call', 'experiments.ping', '--json'], answer(200, { data: { pong: true } }), { manifest })

  assert.equal(code, 0)
  assert.deepEqual(seen, ['/api/agent/experiments/ping'])
  assert.deepEqual(JSON.parse(stdout), { data: { pong: true } })

  const { readFileSync } = await import('node:fs')
  const cli = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin/hirify.js'), 'utf8')
  assert.ok(!cli.includes('experiments.ping'), 'the CLI reaches it through the manifest, not a line of its own')
})

test('api call routes each input where the manifest places it: path, query, and body', async () => {
  const readManifest = manifestDoc([['things.read', 'GET', '/api/agent/things/{id}', { locations: { q: 'query' } }]])
  const read = await run(['api', 'call', 'things.read', '--data', '{"id":"7","q":"hi"}'], answer(200, { data: {} }), { manifest: readManifest })
  assert.equal(read.code, 0)
  assert.equal(read.seen[0], '/api/agent/things/7?q=hi')

  const writeManifest = manifestDoc([['things.make', 'POST', '/api/agent/things', { locations: { name: 'body' } }]])
  let body = ''
  const write = await run(['api', 'call', 'things.make', '--data', '{"name":"Go"}'], (req) => {
    req.on('data', (c) => { body += c })
    return { status: 201, body: { data: { id: 1 } } }
  }, { manifest: writeManifest })
  assert.equal(write.code, 0)
  assert.equal(write.seen[0], '/api/agent/things')
  assert.deepEqual(JSON.parse(body), { name: 'Go' })
})

test('api call names a capability the manifest does not list and sends nothing to it', async () => {
  const { code, stderr, seen } = await run(['api', 'call', 'nope.nope'], answer(200, {}))

  assert.equal(code, 1)
  assert.match(stderr, /this Hirify does not offer "nope\.nope"/)
  assert.deepEqual(seen, [], 'no capability request is made')
})

test('--data that is not JSON is refused before anything is sent', async () => {
  const { code, stderr, seen, bootstrap } = await run(['api', 'call', 'vacancies.search', '--data', 'search=go'], answer(200, {}))

  assert.equal(code, 1)
  assert.match(stderr, /--data expects JSON/)
  assert.deepEqual(seen, [], 'no capability request is made')
  assert.deepEqual(bootstrap, [], 'a typo in --data is caught before the server is reached')
})

test('a refusal keeps the server own words and still exits non-zero', async () => {
  const { code, stdout, stderr } = await run(['api', 'call', 'feeds.create', '--data', '{}'], answer(422, {
    error: true,
    message: 'The name field is required.',
    errors: { name: ['The name field is required.'] },
  }))

  assert.equal(code, 1)
  // Ours would be "that command could not be completed". The point of this door is that
  // the server's own answer arrives instead, and on stdout, where it can be parsed.
  assert.deepEqual(JSON.parse(stdout).errors, { name: ['The name field is required.'] })
  assert.match(stderr, /the server answered 422\. The answer is above\./)
})

test('an answer that is not JSON is printed as it came rather than dropped', async () => {
  const { code, stdout } = await run(['api', 'call', 'account.status'], () => ({
    status: 502,
    text: '<html><body>Bad Gateway</body></html>',
    headers: { 'Content-Type': 'text/html' },
  }))

  assert.equal(code, 1)
  assert.equal(stdout.trim(), '<html><body>Bad Gateway</body></html>')
})

// ── api call: the compact render ───────────────────────────────────────────
// Without --json the answer is rendered compactly, so `api call` reads without a parser and
// stays small in an agent's context. --json is still the raw canonical body (pinned above).
test('api call renders a compact view of the answer without --json', async () => {
  const { code, stdout } = await run(['api', 'call', 'account.status'], answer(200, {
    data: { plan: 'pro', seats: 3, active: true },
  }))

  assert.equal(code, 0)
  assert.match(stdout, /^plan: pro$/m)
  assert.match(stdout, /^seats: 3$/m)
  assert.match(stdout, /^active: true$/m)
  assert.ok(!stdout.includes('{'), 'the compact view is fields, not raw JSON')
})

test('--fields narrows the compact view and never names a field the answer lacks', async () => {
  const { code, stdout } = await run(
    ['api', 'call', 'account.status', '--fields', 'plan,missing'],
    answer(200, { data: { plan: 'pro', seats: 3, active: true } }),
  )

  assert.equal(code, 0)
  assert.match(stdout, /^plan: pro$/m)
  assert.ok(!stdout.includes('seats'), '--fields drops what was not asked for')
  assert.ok(!stdout.includes('missing'), 'a field the answer does not carry is not manufactured (spec §6)')
})

test('api call renders a known card projection as the shortlist, not the whole card', async () => {
  // The capability declares the vacancy card projection, so the compact view is the shortlist
  // selection - the same fields `vacancy search` shows - and not the detail `vacancy read` adds.
  const manifest = manifestDoc([['vacancies.search', 'GET', '/api/agent/vacancies', { projection: 'vacancy.summary' }]])
  const { code, stdout } = await run(['api', 'call', 'vacancies.search'], answer(200, {
    data: [summaryCard(1)],
    meta: { page: 1, per_page: 20, total: 1, last_page: 1 },
  }), { manifest })

  assert.equal(code, 0)
  assert.match(stdout, /^slug: vacancy-1-some-company$/m)
  assert.match(stdout, /^title: /m)
  assert.ok(!stdout.includes('skills:'), 'skills belong to the detail view, not the shortlist')
  assert.ok(!stdout.includes('specializations'), 'the compact card is a shortlist, not the whole card')
})

test('a name every object inherits is not a command', async () => {
  // `PLAIN[noun]` finds `toString` on the prototype and runs it: exit 0, nothing done,
  // which reads as the command having worked. Only own names are commands.
  for (const argv of [['toString'], ['constructor'], ['vacancy', 'toString'], ['feed', 'constructor']]) {
    const { code, stderr } = await run(argv, answer(200, {}))
    assert.equal(code, 1, argv.join(' '))
    assert.match(stderr, /unknown command|has no verb|takes a verb/, argv.join(' '))
  }
})

// ── filter guide: the vocabulary comes from the server ─────────────────────
const GUIDE = '<AVAILABLE FILTERS>\n  - grade:\n      Comma-separated: junior,middle,senior\n</AVAILABLE FILTERS>'

test('filter guide asks the server and prints what it wrote', async () => {
  const { code, stdout, seen } = await run(['filter', 'guide'], answer(200, { guide: GUIDE }))

  assert.equal(code, 0)
  assert.deepEqual(seen, ['/api/agent/filters/guide'])
  // Printed as it came: the text is written for a model, so nothing here reshapes it.
  assert.equal(stdout.trim(), GUIDE)
})

test('filter guide --json hands over the server payload', async () => {
  const { code, stdout } = await run(['filter', 'guide', '--json'], answer(200, { guide: GUIDE }))

  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { guide: GUIDE })
})

test('the installed skill requires guide, preview, refinement, then final search', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const skill = readFileSync(join(root, 'skills/hirify/SKILL.md'), 'utf8')

  const guide = skill.indexOf('Read `hirify filter guide`')
  const preview = skill.indexOf('hirify api call filters.preview', guide)
  const refine = skill.indexOf('refine and preview again', preview)
  const search = skill.indexOf('Run `hirify vacancy search`', refine)

  assert.ok(guide !== -1, 'the search workflow starts from the server guide')
  assert.ok(preview > guide, 'preview follows the guide')
  assert.ok(refine > preview, 'the skill checks and refines the preview')
  assert.ok(search > refine, 'the final search follows a validated preview')
})

test('a server without the guide is told apart from a mistake in the command', async () => {
  // What production answers today. "not found (404)" would read as a bad command and send
  // someone looking for a typo in a command that has no arguments to get wrong.
  const { code, stderr } = await run(['filter', 'guide'], answer(404, {
    message: 'The route api/agent/filters/guide could not be found.',
  }))

  assert.equal(code, 1)
  assert.match(stderr, /this Hirify server does not serve the filter guide yet\./)
  assert.ok(!stderr.includes('404'), 'the status code is not the story here')
})

test('an answer with no guide in it is not printed as an empty success', async () => {
  const { code, stderr } = await run(['filter', 'guide'], answer(200, { guide: '' }))

  assert.equal(code, 1)
  assert.match(stderr, /the server answered without a guide/)
})

// ── nothing in the package states what the server is free to change ────────
test('nothing that ships names a search filter', async () => {
  // The point of `filter guide`: a filter name written into this package is a snapshot,
  // and it goes stale silently. Response fields the CLI prints are not names it asserts,
  // so only the texts a reader acts on are checked here.
  const { readFileSync } = await import('node:fs')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')

  const cli = readFileSync(join(root, 'bin/hirify.js'), 'utf8')
  const texts = [
    cli.slice(cli.indexOf('const HELP ='), cli.indexOf('// ── helpers')),
    cli.slice(cli.indexOf('const INTRO ='), cli.indexOf('function cmdIntro')),
    readFileSync(join(root, 'skills/hirify/SKILL.md'), 'utf8'),
    readFileSync(join(root, 'skills/hirify/reference.md'), 'utf8'),
    readFileSync(join(root, 'README.md'), 'utf8'),
  ]

  // Names the server owns. `--grade senior` and friends lived in these texts for months.
  //
  // `search` and `per_page` are deliberately absent from this list. The CLI binds the phrase
  // to `search` and `--limit` to `per_page`, so it has to know those two; they are how the
  // command is wired, not a snapshot of a vocabulary. Nothing else gets that exemption.
  const filters = /--(grade|work_format|remote_type|excluded_countries|english_level|employee_type|salary_from|salary_to|specializations|skills|excluded_skills|company_title|contact_types|period|macroregion|verified)\b/
  for (const text of texts) {
    const found = text.match(filters)
    assert.equal(found, null, `a filter name is written into a shipped text: ${found?.[0]}`)
  }
})

test('the abilities asked for at sign-in are the ones the server publishes', async () => {
  // A frozen list is how everyone who signed in on 18.08 ended up without agent:feedback.
  const { readFileSync } = await import('node:fs')
  const cli = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin/hirify.js'), 'utf8')

  assert.match(cli, /scopes_supported/, 'the discovery document is what names the abilities')
  assert.match(cli, /scope: endpoints\.scopes/, 'and that is what the sign-in asks for')
})

test('no shipped text states a length the server owns', async () => {
  const { readFileSync } = await import('node:fs')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const files = ['bin/hirify.js', 'skills/hirify/SKILL.md', 'skills/hirify/reference.md', 'README.md']

  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    const stated = text.match(/at most \d+ characters|between \d+ and \d+ characters|\d+ to \d+ characters/)
    assert.equal(stated, null, `${file} states a limit the server owns: ${stated?.[0]}`)
  }
})

test('the package ships the notice the licence obliges it to carry', async () => {
  // npm puts LICENSE in the tarball on its own; NOTICE it does not, and Apache-2.0
  // section 4(d) only reaches a redistributor if the file is actually in the package.
  const { readFileSync } = await import('node:fs')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  assert.equal(pkg.license, 'Apache-2.0')
  assert.ok(pkg.files.includes('NOTICE'), 'NOTICE is not in the published files')
  assert.match(readFileSync(join(root, 'NOTICE'), 'utf8'), /Copyright 2026 Hirify/)
})

// ── 429: the wall that answered is the wall that is named ──────────────────
test('the applications allowance running out is named as itself', async () => {
  // It used to fall through to "you have no reveals left right now": the same defect the
  // vacancy-opens branch was written to fix, one budget later.
  const { code, stderr } = await run(['vacancy', 'apply', 'senior-go-engineer'], answer(429, {
    error: true,
    message: 'Rate limit exceeded.',
    quota: { action: 'apply', limit: 30, used: 30, remaining: 0 },
  }))

  assert.equal(code, 1)
  assert.match(stderr, /you have sent as many applications today as the daily allowance covers/)
  // It may say revealing still works - that is true and useful. What it must never do is
  // report the reveal budget as the one that ran out.
  assert.ok(!/no reveals left/.test(stderr), 'the reveal budget is a different wall')
})

test('a budget with no sentence of its own is still named, not guessed at', async () => {
  const { code, stderr } = await run(['vacancy', 'read', 'senior-go-engineer'], answer(429, {
    error: true,
    quota: { action: 'some_future_budget', limit: 5, used: 5, remaining: 0 },
  }))

  assert.equal(code, 1)
  assert.match(stderr, /today's allowance for some future budget is used up/)
  assert.ok(!stderr.includes('reveal'), 'an unknown budget is not reported as the reveal one')
})

test('nothing that ships calls applying free', async () => {
  // config/agent.php declares a daily ceiling for `apply`, and GET /api/agent/me has
  // reported `quota.apply` all along. Saying it spends nothing is false in the worst
  // direction: an agent told a wall does not exist applies until it hits one.
  const { readFileSync } = await import('node:fs')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const cli = readFileSync(join(root, 'bin/hirify.js'), 'utf8')
  const texts = [
    cli.slice(cli.indexOf('const HELP ='), cli.indexOf('// ── helpers')),
    cli.slice(cli.indexOf('const INTRO ='), cli.indexOf('function cmdIntro')),
    readFileSync(join(root, 'skills/hirify/SKILL.md'), 'utf8'),
    readFileSync(join(root, 'skills/hirify/reference.md'), 'utf8'),
  ]

  for (const text of texts) {
    assert.ok(!/`?vacancy apply`? (is )?(free|spends nothing)/.test(text), 'applying is called free')
    assert.ok(!/\| `vacancy apply` \| free \|/.test(text), 'the cost table calls applying free')
  }
})

test('no shipped text states what a budget is worth in numbers', async () => {
  // The quotas move on the server, and the skill outlives every change to them.
  const { readFileSync } = await import('node:fs')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const files = ['bin/hirify.js', 'skills/hirify/SKILL.md', 'skills/hirify/reference.md', 'README.md']

  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    const stated = text.match(/\d+ (reveals?|applications?|applies|vacancy opens?|opens?) (a|per) day|allowance of \d+|\d+ per day/i)
    assert.equal(stated, null, `${file} puts a number on a budget: ${stated?.[0]}`)
  }
})

test('the CLI knows only Agent API allowances', async () => {
  const { readFileSync } = await import('node:fs')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const files = ['bin/hirify.js', 'skills/hirify/SKILL.md', 'skills/hirify/reference.md', 'README.md']

  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    const sharedLimit = text.match(/(?:site|website|browser)[^\n]{0,80}(?:allowance|budget|quota|daily limit)|(?:allowance|budget|quota|daily limit)[^\n]{0,80}(?:site|website|browser)/i)
    const siteConfig = text.match(/\b(?:SECURITY_|HONEYPOT_|SITE_DAILY_|ORIGINAL_TEXT_DAILY_)[A-Z0-9_]*\b/)

    assert.equal(sharedLimit, null, `${file} ties an Agent API allowance to the site: ${sharedLimit?.[0]}`)
    assert.equal(siteConfig, null, `${file} carries a site security configuration key: ${siteConfig?.[0]}`)
  }
})

// ── the manifest: the CLI learns operations, it does not carry them ─────────
// The CLI holds no agent operation path of its own. It learns the manifest URL from the
// public well-known document, fetches the manifest, and every command finds its capability
// there. These tests pin that transport.
test('a command bootstraps through the well-known and the manifest, then calls its capability', async () => {
  const { code, bootstrap, seen } = await run(['account', 'show'], answer(200, { data: { plan: 'free', quota: {} } }))

  assert.equal(code, 0)
  const paths = bootstrap.map((b) => b.url.split('?')[0])
  assert.deepEqual(paths, ['/.well-known/hirify-agent', '/api/agent/meta'])
  assert.deepEqual(seen, ['/api/agent/me'])
})

test('the manifest is fetched once for a command', async () => {
  const { bootstrap } = await run(['feed', 'list'], answer(200, { data: [] }))

  const metas = bootstrap.filter((b) => b.url.split('?')[0] === '/api/agent/meta')
  assert.equal(metas.length, 1, 'the manifest is downloaded once per process')
})

test('the CLI follows the path the manifest gives, not one of its own', async () => {
  // The manifest moves account status to a different path. A CLI that hardcoded /api/agent/me
  // would ignore this and call the old path; this one follows the manifest.
  const manifest = manifestDoc([['account.status', 'GET', '/api/agent/v2/me']])
  const { code, seen } = await run(['account', 'show'], answer(200, { data: { plan: 'free', quota: {} } }), { manifest })

  assert.equal(code, 0)
  assert.deepEqual(seen, ['/api/agent/v2/me'])
})

test('a curated command reaches its capability by id, whatever the manifest orders them in', async () => {
  // Ordering is the server's; the CLI finds a capability by id, not by position.
  const reversed = [...CAPS].reverse()
  const { code, seen } = await run(['profile', 'list'], answer(200, { data: [] }), { manifest: manifestDoc(reversed) })

  assert.equal(code, 0)
  assert.deepEqual(seen, ['/api/agent/profiles'])
})

test('a manifest whose schema is newer than the CLI is refused with a stable exit code', async () => {
  const manifest = { schema_version: 2, capabilities: [], manifest_revision: 'x' }
  const { code, stderr, seen } = await run(['account', 'show'], answer(200, {}), { manifest })

  assert.equal(code, 2, 'a stable, distinct exit code for "update the CLI"')
  assert.match(stderr, /newer manifest than this CLI can read/)
  assert.deepEqual(seen, [], 'no capability is called against a manifest the CLI cannot read')
})

test('unknown fields in the manifest are ignored, not refused', async () => {
  // The CLI accepts fields it does not know, so the server can add them without a client release.
  const manifest = manifestDoc()
  manifest.a_future_top_level_field = 'ignored'
  manifest.capabilities[0].a_future_capability_field = 'ignored'
  const { code, seen } = await run(['account', 'show'], answer(200, { data: { plan: 'free', quota: {} } }), { manifest })

  assert.equal(code, 0)
  assert.deepEqual(seen, ['/api/agent/me'])
})

test('a second manifest lookup in one process revalidates with the ETag and reuses the cache', async () => {
  // `api call` reads the capability's inputs, then invokes it: two lookups in one process.
  // The first downloads the manifest; the second sends If-None-Match and the server answers
  // 304, so the document is downloaded once and revalidated after.
  const manifest = manifestDoc([['experiments.ping', 'GET', '/api/agent/experiments/ping']])
  const { code, bootstrap } = await run(['api', 'call', 'experiments.ping'], answer(200, { data: {} }), { manifest, etag: '"rev-1"' })

  assert.equal(code, 0)
  const metas = bootstrap.filter((b) => b.url.split('?')[0] === '/api/agent/meta')
  assert.equal(metas.length, 2, 'looked up twice in one process')
  assert.equal(metas[0].headers['if-none-match'], undefined, 'the first lookup downloads the manifest')
  assert.equal(metas[1].headers['if-none-match'], '"rev-1"', 'the second revalidates with the stored ETag')
})

test('the manifest is not persisted: a fresh run downloads it again', async () => {
  // Cached only for the process. Two runs are two processes, and neither reads a manifest the
  // other left behind, so a server change is picked up on the next command.
  const first = await run(['feed', 'list'], answer(200, { data: [] }))
  const second = await run(['feed', 'list'], answer(200, { data: [] }))

  const metas = (r) => r.bootstrap.filter((b) => b.url.split('?')[0] === '/api/agent/meta')
  assert.equal(metas(first).length, 1)
  assert.equal(metas(second).length, 1)
  assert.equal(metas(second)[0].headers['if-none-match'], undefined, 'nothing carried over from the first run')
})

test('a server with no manifest url in its well-known is reported, and nothing is called', async () => {
  const { code, stderr, seen } = await run(['account', 'show'], answer(200, {}), { wellKnown: { schema_version: 1 } })

  assert.equal(code, 1)
  assert.match(stderr, /could not reach Hirify to load what it can do/)
  assert.deepEqual(seen, [])
})

test('a server that cannot serve the manifest is reported, and nothing is called', async () => {
  const { code, stderr, seen } = await run(['account', 'show'], answer(200, {}), { manifest: null })

  assert.equal(code, 1)
  assert.match(stderr, /could not load what Hirify can do/)
  assert.deepEqual(seen, [])
})

test('a missing argument is caught before the manifest is fetched', async () => {
  // The argument check is the caller's, and needs no manifest. Nothing is asked of the server.
  const { code, stderr, seen, bootstrap } = await run(['vacancy', 'read'], answer(200, {}))

  assert.equal(code, 1)
  assert.match(stderr, /a vacancy slug is required/)
  assert.deepEqual(seen, [])
  assert.deepEqual(bootstrap, [], 'the manifest is not fetched to tell someone they forgot the slug')
})

// ── context budgets: a page of results and the skill both stay small ────────
// Spec §10.1. The search budget is measured on the CLI's compact SELECTION of the card - the
// shortlist fields the renderer keeps - not the raw API card, which --json still hands over in
// full. Frozen M4/M5 evidence put twenty real cards at about 3,158 bytes selected against about
// 18,980 raw; this pins the guard with a fixture richer than a median card, so it has no slack it
// should not. The selection is read from the CLI source, so the gate measures the real field list.
test('a default search of twenty vacancies fits the context budget after field selection', async () => {
  const fields = cliCardFields()
  const cards = Array.from({ length: 20 }, (_, i) => summaryCard(i))
  const selected = cards.map((c) => Object.fromEntries(
    fields.filter((f) => Object.hasOwn(c, f)).map((f) => [f, c[f]]),
  ))

  const bytes = Buffer.byteLength(JSON.stringify(selected))
  assert.ok(bytes <= 4096, `twenty selected cards serialize to ${bytes} bytes, over the 4096 budget`)
  // Not a tautology: the raw page is well over budget by design, which is why the CLI selects.
  // --json hands those full cards back when an agent wants them.
  assert.ok(Buffer.byteLength(JSON.stringify(cards)) > 4096, 'the raw page is over budget by design')
})

test('the skill stays within the harness budget', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const bytes = Buffer.byteLength(readFileSync(join(root, 'skills/hirify/SKILL.md')))
  assert.ok(bytes <= 8192, `SKILL.md is ${bytes} bytes, over the 8192 budget`)
})

// ── exit codes are a stable contract ───────────────────────────────────────
// 0 is success, 1 an ordinary error, 2 a manifest newer than this build can read. A caller
// branches on these, so they are pinned together rather than left implicit across the suite.
test('the exit codes are a stable contract: 0 ok, 1 error, 2 manifest too new', async () => {
  const ok = await run(['--help'], answer(200, {}))
  assert.equal(ok.code, 0, 'help succeeds')

  const err = await run(['definitely-not-a-command'], answer(200, {}))
  assert.equal(err.code, 1, 'an unknown command is an ordinary error')

  const tooNew = await run(['account', 'show'], answer(200, {}), {
    manifest: { schema_version: 9, capabilities: [], manifest_revision: 'x' },
  })
  assert.equal(tooNew.code, 2, 'a manifest this build cannot read has its own stable code')
})
