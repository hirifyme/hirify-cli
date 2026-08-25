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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hirify.js')

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
 * Run one command against a stub that answers every request with `reply`. Returns what
 * the person would have seen, plus the paths the CLI actually asked for.
 */
async function run(argv, reply) {
  const seen = []
  const server = createServer((req, res) => {
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
    return { code, stdout, stderr, seen }
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

// ── what the rest of the CLI now says ──────────────────────────────────────
test('me shows the opens left next to the reveals left', async () => {
  const { stdout } = await run(['account', 'show'], answer(200, {
    data: {
      plan: 'pro',
      quota: {
        reveal: { action: 'contact_reveals', used: 4, remaining: 26 },
        read: { action: 'vacancy_opens', limit: 1000, used: 2, remaining: 998 },
      },
      usage: { reveal: { today: 4, last_7d: 11 } },
    },
  }))

  assert.match(stdout, /^plan: {4}pro$/m)
  assert.match(stdout, /^reveals: 26 left$/m)
  assert.match(stdout, /^opens: {3}998 left today$/m)
  assert.match(stdout, /^usage: {3}4 today · 11 in 7d$/m)
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
test('intro explains the work and asks nothing of the network', async () => {
  const { code, stdout, seen } = await run(['intro'], answer(200, {}))

  assert.equal(code, 0)
  assert.deepEqual(seen, [], 'intro runs before anyone has signed in')
  const topics = [/hirify feed list/, /hirify vacancy search/, /hirify vacancy read/,
    /hirify vacancy reveal/, /hirify vacancy apply/, /hirify login/, /hirify api call/]
  for (const topic of topics) {
    assert.match(stdout, topic)
  }
  assert.match(stdout, /Reading one vacancy in full spends one of the day's vacancy opens/)
  assert.match(stdout, /cannot be recalled/)
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
  const files = ['bin/hirify.js', 'README.md', 'package.json',
    ...readdirSync(join(root, 'skills/hirify')).map((f) => `skills/hirify/${f}`)]

  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    const cyrillic = text.match(/[\u0400-\u04FF]+/g)
    assert.equal(cyrillic, null, `${file} carries Russian: ${cyrillic?.slice(0, 3).join(', ')}`)
    const dashes = text.match(/[\u2014\u2013]/g)
    assert.equal(dashes, null, `${file} carries a long dash`)
  }
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

// ── api call: the raw door ─────────────────────────────────────────────────
test('api call sends the path as written and prints the answer as it came', async () => {
  const { code, stdout, seen } = await run(
    ['api', 'call', '/agent/vacancies?search=go&per_page=2'],
    answer(200, { data: [], meta: { page: 1 } }),
  )

  assert.equal(code, 0)
  assert.deepEqual(seen, ['/api/agent/vacancies?search=go&per_page=2'])
  assert.deepEqual(JSON.parse(stdout), { data: [], meta: { page: 1 } })
})

test('api call reaches a path this CLI has no command for', async () => {
  const { code, seen } = await run(['api', 'call', '/agent/something-new'], answer(200, { data: {} }))

  assert.equal(code, 0)
  assert.deepEqual(seen, ['/api/agent/something-new'])
})

test('the path is the same one however it is written', async () => {
  for (const written of ['/agent/me', 'agent/me', '/api/agent/me']) {
    const { seen } = await run(['api', 'call', written], answer(200, { data: {} }))
    assert.deepEqual(seen, ['/api/agent/me'], `written as ${written}`)
  }
})

test('--data makes it a POST and travels as the body', async () => {
  let body = ''
  const { code, seen } = await run(['api', 'call', '/agent/feeds', '--data', '{"name":"Go"}'], (req) => {
    req.on('data', (c) => { body += c })
    return { status: 201, body: { data: { id: 7 } } }
  })

  assert.equal(code, 0)
  assert.deepEqual(seen, ['/api/agent/feeds'])
  assert.deepEqual(JSON.parse(body), { name: 'Go' })
})

test('--method sends the method it names', async () => {
  let method = ''
  const { code } = await run(['api', 'call', '/agent/feeds/7/delivery', '--method', 'put', '--data', '{"notify_telegram":true}'],
    (req) => { method = req.method; return { status: 200, body: { data: {} } } })

  assert.equal(code, 0)
  assert.equal(method, 'PUT')
})

test('a method the API does not have is refused before anything is sent', async () => {
  const { code, stderr, seen } = await run(['api', 'call', '/agent/me', '--method', 'fetch'], answer(200, {}))

  assert.equal(code, 1)
  assert.match(stderr, /--method takes one of: GET, POST, PUT, PATCH, DELETE\./)
  assert.deepEqual(seen, [], 'nothing is asked of the server')
})

test('--data that is not JSON is refused before anything is sent', async () => {
  const { code, stderr, seen } = await run(['api', 'call', '/agent/feeds', '--data', 'name=Go'], answer(200, {}))

  assert.equal(code, 1)
  assert.match(stderr, /--data expects JSON/)
  assert.deepEqual(seen, [], 'nothing is asked of the server')
})

test('a refusal keeps the server own words and still exits non-zero', async () => {
  const { code, stdout, stderr } = await run(['api', 'call', '/agent/feeds'], answer(422, {
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
  const { code, stdout } = await run(['api', 'call', '/agent/me'], () => ({
    status: 502,
    text: '<html><body>Bad Gateway</body></html>',
    headers: { 'Content-Type': 'text/html' },
  }))

  assert.equal(code, 1)
  assert.equal(stdout.trim(), '<html><body>Bad Gateway</body></html>')
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
