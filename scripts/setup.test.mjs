// Setup tests: `hirify skill`, `hirify init` and the functions behind them. Run with `npm test`.
//
// Every test works in a throwaway home directory, so nothing here can reach the skills or the
// global npm packages of the person running the suite. npm itself is replaced by a stub.
//
// Repo-only tooling: `files` in package.json does not carry this into the npm package.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { installSkill, installGlobally, agentDirectories } from '../bin/lib/setup.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = process.env.HIRIFY_TEST_CLI || join(ROOT, 'bin', 'hirify.js')
const SKILL = readFileSync(join(ROOT, 'skills', 'hirify', 'SKILL.md'), 'utf8')
const temps = []
function home(...agents) { const path = mkdtempSync(join(tmpdir(), 'hirify-setup-')); temps.push(path); for (const agent of agents) mkdirSync(join(path, agent), { recursive: true }); return path }
after(() => { for (const path of temps) rmSync(path, { recursive: true, force: true }) })
const link = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')

function cli(args, { dir, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, '.config'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', HIRIFY_KEY: '', HIRIFY_API: 'http://127.0.0.1:1', HIRIFY_NO_AUTO_UPDATE: '1', HIRIFY_VERSION_PIN: '', CI: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', v => { stdout += v }); child.stderr.on('data', v => { stderr += v })
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

test('the skill is saved once and reaches only the agents found on this computer', () => {
  const dir = home('.claude', '.cursor')
  const result = installSkill({ packageRoot: ROOT, env: {}, home: dir })
  assert.deepEqual(result.agents, [{ agent: 'Claude Code', installed: true }, { agent: 'Cursor', installed: true }])
  assert.equal(result.path, join(dir, '.agents', 'skills', 'hirify'))
  for (const path of [result.path, join(dir, '.claude', 'skills', 'hirify'), join(dir, '.cursor', 'skills', 'hirify')]) assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), SKILL)
  assert.ok(existsSync(join(result.path, 'reference.md')))
  assert.ok(!existsSync(join(dir, '.codex')), 'an agent that is not installed gets no directory')
})

test('without any agent the skill is still saved where agents look for shared skills', () => {
  const dir = home()
  const result = installSkill({ packageRoot: ROOT, env: {}, home: dir })
  assert.deepEqual(result.agents, [])
  assert.equal(readFileSync(join(result.path, 'SKILL.md'), 'utf8'), SKILL)
})

test('an older copy is replaced, and a link is removed without touching what it pointed to', () => {
  const dir = home('.claude')
  mkdirSync(join(dir, '.agents', 'skills', 'hirify'), { recursive: true }); writeFileSync(join(dir, '.agents', 'skills', 'hirify', 'stale.md'), 'old')
  const elsewhere = join(dir, 'elsewhere'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'keep.md'), 'mine')
  mkdirSync(join(dir, '.claude', 'skills')); link(elsewhere, join(dir, '.claude', 'skills', 'hirify'))
  installSkill({ packageRoot: ROOT, env: {}, home: dir })
  assert.ok(!existsSync(join(dir, '.agents', 'skills', 'hirify', 'stale.md')))
  assert.equal(readFileSync(join(dir, '.claude', 'skills', 'hirify', 'SKILL.md'), 'utf8'), SKILL)
  assert.equal(readFileSync(join(elsewhere, 'keep.md'), 'utf8'), 'mine')
})

test('an agent that shares the common skills directory is served by the one copy', () => {
  const dir = home('.claude')
  mkdirSync(join(dir, '.agents', 'skills'), { recursive: true }); link(join(dir, '.agents', 'skills'), join(dir, '.claude', 'skills'))
  const result = installSkill({ packageRoot: ROOT, env: {}, home: dir })
  assert.deepEqual(result.agents, [{ agent: 'Claude Code', installed: true }])
  assert.equal(readFileSync(join(dir, '.claude', 'skills', 'hirify', 'SKILL.md'), 'utf8'), SKILL)
})

test('agent directories follow the variables the agents themselves read', () => {
  const found = Object.fromEntries(agentDirectories({ env: { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x', XDG_CONFIG_HOME: '/cfg' }, home: '/h' }).map(agent => [agent.name, agent.skills]))
  assert.equal(found['Claude Code'], join('/c', 'skills'))
  assert.equal(found.Codex, join('/x', 'skills'))
  assert.equal(found.OpenCode, join('/cfg', 'opencode', 'skills'))
  assert.equal(found.Cursor, join('/h', '.cursor', 'skills'))
})

test('a package without the skill says how to get it instead of writing an empty one', () => {
  const dir = home('.claude')
  assert.throws(() => installSkill({ packageRoot: dir, env: {}, home: dir }), { code: 'skill_missing' })
  assert.ok(!existsSync(join(dir, '.agents')))
})

function npm({ version, fail = false } = {}) {
  const dir = home(); const calls = []
  if (version) { mkdirSync(join(dir, 'hirify-cli'), { recursive: true }); writeFileSync(join(dir, 'hirify-cli', 'package.json'), JSON.stringify({ name: 'hirify-cli', version })) }
  const run = async (command, args, options) => { calls.push({ command, args, env: options.env }); if (args[0] === 'root') return { code: 0, stdout: dir + '\n' }; return { code: fail ? 1 : 0, stdout: '', stderr: 'synthetic-private-error' } }
  return { run, calls }
}

test('a current global installation is left alone', async () => {
  const f = npm({ version: '0.6.0' })
  assert.deepEqual(await installGlobally({ version: '0.6.0', env: {}, run: f.run }), { installed: true, version: '0.6.0', changed: false })
  assert.equal(f.calls.filter(call => call.args[0] === 'install').length, 0)
})

test('the running version is installed exactly, without scripts and without the settings of npx', async () => {
  const f = npm({ version: '0.5.4' })
  const result = await installGlobally({ version: '0.6.0', env: { PATH: '/bin', npm_command: 'exec', npm_config_prefix: '/tmp/npx', INIT_CWD: '/tmp' }, run: f.run })
  assert.deepEqual(result, { installed: true, version: '0.6.0', changed: true })
  const install = f.calls.find(call => call.args[0] === 'install')
  assert.deepEqual(install.args, ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', 'hirify-cli@0.6.0'])
  assert.deepEqual(install.env, { PATH: '/bin' })
})

test('a failed or missing npm is a result, so the other setup steps still run', async () => {
  assert.deepEqual(await installGlobally({ version: '0.6.0', env: {}, run: npm({ fail: true }).run }), { installed: false, reason: 'install_failed' })
  assert.deepEqual(await installGlobally({ version: '0.6.0', env: {}, run: async () => { throw new Error('no npm') } }), { installed: false, reason: 'npm_unavailable' })
})

test('hirify skill installs the skill that came with this CLI', async () => {
  const dir = home('.codex')
  const r = await cli(['skill', '--json'], { dir })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).agents, [{ agent: 'Codex', installed: true }])
  assert.ok(existsSync(join(dir, '.codex', 'skills', 'hirify', 'SKILL.md')))
  const text = await cli(['skill'], { dir })
  assert.match(text.stdout, /^The skill is installed for Codex\.$/m)
})

test('hirify init runs the steps that were not skipped and reports each one', async () => {
  const dir = home('.claude')
  const skipped = await cli(['init', '--no-install', '--no-login', '--json'], { dir })
  assert.equal(skipped.code, 0, skipped.stderr)
  assert.deepEqual(Object.keys(JSON.parse(skipped.stdout)), ['skill'])
  // A configured key is a finished sign-in: no browser, no waiting.
  const keyed = await cli(['init', '--no-install', '--json'], { dir, env: { HIRIFY_KEY: 'synthetic-key' } })
  assert.equal(keyed.code, 0, keyed.stderr)
  assert.deepEqual(JSON.parse(keyed.stdout).sign_in, { signed_in: true, already_signed_in: true, source: 'environment' })
})

test('hirify init keeps the skill when sign-in cannot start, and says so', async () => {
  const dir = home('.claude')
  const r = await cli(['init', '--no-install', '--json'], { dir })
  assert.equal(r.code, 1)
  const result = JSON.parse(r.stdout)
  assert.equal(result.sign_in.error, 'interaction_required')
  assert.deepEqual(result.skill.agents, [{ agent: 'Claude Code', installed: true }])
})
