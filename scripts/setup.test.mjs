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
import { join, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { installSkill, installGlobally, agentDirectories } from '../bin/lib/setup.js'
import { CliError } from '../bin/lib/errors.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = process.env.HIRIFY_TEST_CLI || join(ROOT, 'bin', 'hirify.js')
const SKILL = readFileSync(join(ROOT, 'skills', 'hirify', 'SKILL.md'), 'utf8')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
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

function npm({ version, fail = false, unreadable = false } = {}) {
  const dir = home(); const calls = []
  if (version || unreadable) { mkdirSync(join(dir, 'hirify-cli'), { recursive: true }); writeFileSync(join(dir, 'hirify-cli', 'package.json'), unreadable ? 'not a package' : JSON.stringify({ name: 'hirify-cli', version })) }
  const run = async (command, args, options) => { calls.push({ command, args, env: options.env }); if (args[0] === 'root') return { code: 0, stdout: dir + '\n' }; return { code: fail ? 1 : 0, stdout: '', stderr: 'synthetic-private-error' } }
  return { run, calls, root: join(dir, 'hirify-cli') }
}
const latest = version => async () => ({ version })
const installs = f => f.calls.filter(call => call.args[0] === 'install')

test('the newest release is installed, without scripts, with the npm settings of the person', async () => {
  const f = npm({ version: '0.5.4' })
  // A prefix of one's own is how people install global packages without administrator rights.
  const env = { PATH: '/bin', NPM_CONFIG_PREFIX: '/home/person/.npm-global', npm_config_userconfig: '/home/person/custom.npmrc', npm_command: 'exec' }
  // The package that started the command is older than the newest release.
  const result = await installGlobally({ version: '0.6.0', latest: latest('0.7.0'), env, run: f.run })
  assert.deepEqual(result, { installed: true, version: '0.7.0', changed: true, root: f.root })
  assert.deepEqual(installs(f).map(call => call.args), [['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', 'hirify-cli@0.7.0']])
  for (const call of f.calls) assert.deepEqual(call.env, env, 'npm looks for the global directory and installs with the same settings')
})

test('an installation at the newest release or past it is kept', async () => {
  for (const version of ['0.7.0', '0.8.0']) {
    const f = npm({ version })
    assert.deepEqual(await installGlobally({ version: '0.6.0', latest: latest('0.7.0'), env: {}, run: f.run }), { installed: true, version, changed: false, root: f.root })
    assert.equal(installs(f).length, 0)
  }
})

test('a pinned version and switched-off updates keep the running release', async () => {
  for (const env of [{ HIRIFY_VERSION_PIN: '0.6.0' }, { HIRIFY_NO_AUTO_UPDATE: '1' }]) {
    const f = npm({ version: '0.5.4' })
    const result = await installGlobally({ version: '0.6.0', latest: async () => { throw new Error('the registry is not asked') }, env, run: f.run })
    assert.deepEqual(result, { installed: true, version: '0.6.0', changed: true, root: f.root })
    assert.equal(installs(f)[0].args.at(-1), 'hirify-cli@0.6.0')
  }
})

test('a failure is a result that names its reason, so the other setup steps still run', async () => {
  const unknown = async () => { throw new CliError('update_check_failed', 'Could not check the requested CLI version.') }
  assert.deepEqual(await installGlobally({ version: '0.6.0', latest: unknown, env: {}, run: npm().run }), { installed: false, reason: 'update_check_failed' })
  assert.deepEqual(await installGlobally({ version: '0.6.0', latest: latest('0.6.0'), env: {}, run: npm({ fail: true }).run }), { installed: false, reason: 'install_failed' })
  assert.deepEqual(await installGlobally({ version: '0.6.0', latest: latest('0.6.0'), env: {}, run: async () => { throw new Error('no npm') } }), { installed: false, reason: 'npm_unavailable' })
  // A package that is there and cannot be read is not the same as no package.
  const broken = npm({ unreadable: true })
  assert.deepEqual(await installGlobally({ version: '0.6.0', latest: latest('0.6.0'), env: {}, run: broken.run }), { installed: false, reason: 'global_package_unreadable' })
  assert.equal(installs(broken).length, 0)
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

// From here npm is a script on PATH: it names the global directory and accepts an installation,
// or refuses it. The suite runs with updates switched off, so the running release is the one asked for.
function scripted(dir, { fail = false } = {}) {
  const root = join(dir, 'global'), bin = join(dir, 'bin')
  mkdirSync(root); mkdirSync(bin)
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nif [ "$1" = root ]; then echo "${root}"; exit 0; fi\nexit ${fail ? 1 : 0}\n`, { mode: 0o755 })
  // The arguments reach a command file in quotes; %~1 is the first one without them.
  writeFileSync(join(bin, 'npm.cmd'), `@echo off\r\nif "%~1"=="root" (echo ${root}& exit /b 0)\r\nexit /b ${fail ? 1 : 0}\r\n`)
  const key = Object.keys(process.env).find(name => name.toUpperCase() === 'PATH') || 'PATH'
  return { root: join(root, 'hirify-cli'), env: { [key]: bin + delimiter + process.env[key] } }
}

test('hirify init installs the CLI and the skill, and a configured key is a finished sign-in', async () => {
  const dir = home('.claude'); const npm = scripted(dir)
  const r = await cli(['init', '--json'], { dir, env: { ...npm.env, HIRIFY_KEY: 'synthetic-key' } })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), {
    cli: { installed: true, version: VERSION, changed: true },
    skill: { skill: 'hirify', path: join(dir, '.agents', 'skills', 'hirify'), agents: [{ agent: 'Claude Code', installed: true }] },
    sign_in: { signed_in: true, already_signed_in: true, source: 'environment' },
  })
  // The CLI under test may be the packed artifact, whose line endings differ from a Windows checkout.
  const lines = text => text.replace(/\r\n/g, '\n')
  assert.equal(lines(readFileSync(join(dir, '.claude', 'skills', 'hirify', 'SKILL.md'), 'utf8')), lines(SKILL))
})

test('hirify init takes the skill from the installed CLI when that is not the running one', async () => {
  const dir = home('.claude'); const npm = scripted(dir)
  mkdirSync(join(npm.root, 'skills', 'hirify'), { recursive: true })
  writeFileSync(join(npm.root, 'package.json'), JSON.stringify({ name: 'hirify-cli', version: '99.0.0' }))
  writeFileSync(join(npm.root, 'skills', 'hirify', 'SKILL.md'), 'the skill of the installed CLI')
  const r = await cli(['init', '--json'], { dir, env: { ...npm.env, HIRIFY_KEY: 'synthetic-key' } })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).cli, { installed: true, version: '99.0.0', changed: false })
  assert.equal(readFileSync(join(dir, '.claude', 'skills', 'hirify', 'SKILL.md'), 'utf8'), 'the skill of the installed CLI')
})

test('hirify init says which step failed and still does the others', async () => {
  const dir = home('.claude')
  // No terminal and nobody to confirm: sign-in refuses at once, the CLI and the skill are in place.
  const unsigned = JSON.parse((await cli(['init', '--json'], { dir, env: scripted(dir).env })).stdout)
  assert.equal(unsigned.sign_in.error, 'interaction_required')
  assert.equal(unsigned.cli.installed, true)
  assert.deepEqual(unsigned.skill.agents, [{ agent: 'Claude Code', installed: true }])
  const other = home('.claude')
  const r = await cli(['init', '--json'], { dir: other, env: { ...scripted(other, { fail: true }).env, HIRIFY_KEY: 'synthetic-key' } })
  assert.equal(r.code, 1)
  const result = JSON.parse(r.stdout)
  assert.deepEqual(result.cli, { installed: false, reason: 'install_failed' })
  assert.deepEqual(result.skill.agents, [{ agent: 'Claude Code', installed: true }])
  assert.equal(result.sign_in.signed_in, true)
})
