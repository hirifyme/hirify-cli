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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hirify.js')

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
    const { status = 200, body = {}, headers = {} } = reply(req) ?? {}
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${server.address().port}`

  try {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, HIRIFY_API: api, HIRIFY_KEY: 'test-key', HIRIFY_DEBUG: '' },
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
  const { code, stdout } = await run(['read', 'senior-go-engineer'], answer(200, OK_BODY))

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
  const { stdout } = await run(['read', 'senior-go-engineer'], answer(200, OK_BODY))

  assert.match(stdout, /We build payments\./)
  assert.match(stdout, /- Go & Postgres/)
  assert.match(stdout, /- On call/)
  assert.ok(!stdout.includes('<p>'), 'no tags survive into the output')
  assert.ok(!stdout.includes('&amp;'), 'entities are decoded')
})

test('read says which of the two ways to apply this vacancy takes', async () => {
  const hosted = await run(['read', 'senior-go-engineer'], answer(200, OK_BODY))
  assert.match(hosted.stdout, /Apply on Hirify: hirify apply senior-go-engineer/)

  const elsewhere = await run(['read', 'senior-go-engineer'], answer(200, {
    ...OK_BODY,
    data: { ...VACANCY, can_apply_directly: false },
  }))
  assert.match(elsewhere.stdout, /Where to apply: hirify reveal senior-go-engineer \(uses 1 reveal\)/)
  assert.ok(!elsewhere.stdout.includes('hirify apply'), 'an apply we cannot make is never offered')
})

test('read reports what the open cost and what is left', async () => {
  const first = await run(['read', 'senior-go-engineer'], answer(200, OK_BODY))
  assert.match(first.stdout, /\(1 vacancy open used\)/)
  assert.match(first.stdout, /998 opens left today/)

  const again = await run(['read', 'senior-go-engineer'], answer(200, { ...OK_BODY, charged: false }))
  assert.match(again.stdout, /\(no vacancy open used: this one was already opened today\)/)
})

test('read keeps quiet about a text that is not there', async () => {
  const { stdout } = await run(['read', 'senior-go-engineer'], answer(200, {
    ...OK_BODY,
    data: { ...VACANCY, description: null },
  }))
  assert.match(stdout, /This vacancy has no text on it\./)
  assert.ok(!stdout.includes('undefined'), 'a missing field never reaches the screen as a word')
})

test('read --json hands over the server payload untouched', async () => {
  const { code, stdout } = await run(['read', 'senior-go-engineer', '--json'], answer(200, OK_BODY))

  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), OK_BODY)
})

// ── read: flags and arguments ──────────────────────────────────────────────
// Two defects in this CLI were flags being read as data. Both directions are pinned here.
test('a flag before the slug does not become the slug', async () => {
  const { code, seen } = await run(['read', '--json', 'senior-go-engineer'], answer(200, OK_BODY))

  assert.equal(code, 0)
  assert.deepEqual(seen, ['/api/agent/vacancies/senior-go-engineer'])
})

test('read without a slug asks for one and sends nothing', async () => {
  const { code, stderr, seen } = await run(['read'], answer(200, OK_BODY))

  assert.equal(code, 1)
  assert.match(stderr, /a vacancy slug is required: hirify read <slug>/)
  assert.deepEqual(seen, [], 'nothing is asked of the server')
})

test('a slug with a slash in it is still asked for as one slug', async () => {
  const { seen } = await run(['read', 'a/b'], answer(404, { message: 'Vacancy not found.' }))

  assert.deepEqual(seen, ['/api/agent/vacancies/a%2Fb'])
})

// ── read: refusals ─────────────────────────────────────────────────────────
test('an unknown slug is named as an unknown slug', async () => {
  const { code, stderr } = await run(['read', 'nope'], answer(404, { error: true, message: 'Vacancy not found.' }))

  assert.equal(code, 1)
  assert.match(stderr, /there is no vacancy with that slug\./)
})

test("the day's opens running out is not reported as reveals running out", async () => {
  const { code, stderr } = await run(['read', 'senior-go-engineer'], answer(429, {
    error: true,
    message: 'Rate limit exceeded. You cannot open more than 1000 vacancies per day.',
    quota: { action: 'vacancy_opens', limit: 1000, used: 1000, remaining: 0 },
  }))

  assert.equal(code, 1)
  assert.match(stderr, /opened as many vacancies today as the daily allowance covers/)
  assert.ok(!stderr.includes('reveal'), 'the reveal budget is a different wall and is not named here')
})

test('reveals running out still reads as reveals running out', async () => {
  const { code, stderr } = await run(['reveal', 'senior-go-engineer'], answer(429, {
    error: true,
    message: 'Rate limit exceeded. You have no contact reveals left right now.',
    quota: { action: 'contact_reveals', used: 30, remaining: 0 },
  }))

  assert.equal(code, 1)
  assert.match(stderr, /you have no reveals left right now/)
})

test('going too fast is told apart from running out', async () => {
  const { code, stderr } = await run(['read', 'senior-go-engineer'], () => ({
    status: 429,
    body: { error: true, message: 'Too Many Attempts.' },
    headers: { 'Retry-After': '12' },
  }))

  assert.equal(code, 1)
  assert.match(stderr, /too many requests in a short time\. Please try again in 12 seconds\./)
})

// ── what the rest of the CLI now says ──────────────────────────────────────
test('me shows the opens left next to the reveals left', async () => {
  const { stdout } = await run(['me'], answer(200, {
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
  const { stdout } = await run(['search', 'go'], answer(200, {
    data: [VACANCY],
    meta: { page: 1, per_page: 20, total: 1, last_page: 1 },
  }))

  assert.match(stdout, /^senior-go-engineer\n {2}Senior Go Engineer · Acme$/m)
  assert.match(stdout, /Read one: hirify read <slug>\. Where to apply: hirify reveal <slug> \(uses 1 reveal\)\./)
})

// ── search as a conduit ────────────────────────────────────────────────────
// The endpoint takes the same criteria the site's filter form produces. The CLI must not
// be the thing that decides which of them are expressible.
test('any option is passed on to the API under the name it was given', async () => {
  const { seen } = await run(
    ['search', 'senior', 'go', '--grade', 'senior', '--work_format', 'remote', '--excluded_countries', 'ru'],
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
    ['search', '--a_filter_invented_after_this_test', 'yes', '--another=42'],
    answer(200, { data: [], meta: {} }),
  )

  const q = new URLSearchParams(seen[0].split('?')[1])
  assert.equal(q.get('a_filter_invented_after_this_test'), 'yes')
  assert.equal(q.get('another'), '42')
})

test('the same option twice is joined the way the site sends a multi-value filter', async () => {
  const { seen } = await run(
    ['search', '--grade', 'senior', '--grade', 'middle'],
    answer(200, { data: [], meta: {} }),
  )

  assert.equal(new URLSearchParams(seen[0].split('?')[1]).get('grade'), 'senior,middle')
})

test('--limit still works and arrives under the name the server publishes', async () => {
  const { seen } = await run(['search', 'go', '--limit', '5'], answer(200, { data: [], meta: {} }))

  const q = new URLSearchParams(seen[0].split('?')[1])
  assert.equal(q.get('per_page'), '5')
  assert.equal(q.get('limit'), null, 'the CLI name does not leak into the request')
})

test('--json steers the CLI and is never sent as a filter', async () => {
  const { seen, stdout } = await run(['search', 'go', '--json'], answer(200, { data: [], meta: {} }))

  assert.equal(new URLSearchParams(seen[0].split('?')[1]).get('json'), null)
  assert.equal(new URLSearchParams(seen[0].split('?')[1]).get('search'), 'go')
  assert.deepEqual(JSON.parse(stdout), { data: [], meta: {} })
})

test('a flag before the words does not eat one of them', async () => {
  const { seen } = await run(['search', '--json', 'senior', 'go'], answer(200, { data: [], meta: {} }))

  assert.equal(new URLSearchParams(seen[0].split('?')[1]).get('search'), 'senior go')
})

// ── paging ─────────────────────────────────────────────────────────────────
test('search takes a page', async () => {
  const { seen } = await run(['search', 'go', '--page', '3'], answer(200, { data: [], meta: {} }))

  assert.equal(new URLSearchParams(seen[0].split('?')[1]).get('page'), '3')
})

test('feed takes a page and a limit', async () => {
  const { seen } = await run(['feed', '31', '--page', '2', '--limit', '5'], answer(200, { data: [], meta: {} }))

  assert.equal(seen[0].split('?')[0], '/api/agent/feeds/31/vacancies')
  const q = new URLSearchParams(seen[0].split('?')[1])
  assert.equal(q.get('page'), '2')
  assert.equal(q.get('per_page'), '5')
})

test('feed with no options asks for the feed and nothing else', async () => {
  const { seen } = await run(['feed', '31'], answer(200, { data: [], meta: {} }))

  assert.deepEqual(seen, ['/api/agent/feeds/31/vacancies'])
})

test('the page and the next one are named, and a full page offers the next', async () => {
  const { stdout } = await run(['search', 'go'], answer(200, {
    data: [VACANCY, { ...VACANCY, slug: 'b' }],
    meta: { page: 2, per_page: 2, total: 2, last_page: 1 },
  }))

  assert.match(stdout, /^Showing 2, page 2\.$/m)
  assert.match(stdout, /^More: add --page 3$/m)
})

test('a total is printed only when it is a total and not the size of the page', async () => {
  // What the agent search endpoint answers today: total equal to what it just returned.
  // "Showing 2 of 2" would read as "that is the whole board" and it is not.
  const clamped = await run(['search', 'go'], answer(200, {
    data: [VACANCY, { ...VACANCY, slug: 'b' }],
    meta: { page: 1, per_page: 2, total: 2, last_page: 1 },
  }))
  assert.match(clamped.stdout, /^Showing 2, page 1\.$/m)

  // What it answers once the server counts properly: printed with no change here.
  const real = await run(['search', 'go'], answer(200, {
    data: [VACANCY, { ...VACANCY, slug: 'b' }],
    meta: { page: 1, per_page: 2, total: 1665, last_page: 833 },
  }))
  assert.match(real.stdout, /^Showing 2 of 1665, page 1 of 833\.$/m)
  assert.match(real.stdout, /^More: add --page 2$/m)
})

test('the last page does not offer another one', async () => {
  const { stdout } = await run(['search', 'go'], answer(200, {
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
  for (const topic of [/hirify feeds/, /hirify search/, /hirify read/, /hirify reveal/, /hirify apply/, /hirify login/]) {
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
  assert.match(stdout, /hirify read <slug> +one vacancy in full, with its text/)
})
