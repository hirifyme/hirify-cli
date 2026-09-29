import { existsSync, mkdirSync, cpSync, rmSync, symlinkSync, lstatSync, realpathSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import semver from 'semver'
import { CliError } from './errors.js'
import { PACKAGE_NAME, runProcess } from './update.js'

export const SKILL_NAME = 'hirify'

/**
 * Where each agent reads its global skills, and the directory whose presence means the agent is
 * installed on this computer. The paths follow the registry of the `skills` tool, so the skill
 * lands in the same place whether it comes from here or from `npx skills add`.
 */
export function agentDirectories({ env = process.env, home = homedir() } = {}) {
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  const claude = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
  const codex = env.CODEX_HOME?.trim() || join(home, '.codex')
  return [
    { name: 'Claude Code', home: claude, skills: join(claude, 'skills') },
    { name: 'Codex', home: codex, skills: join(codex, 'skills') },
    { name: 'Cursor', home: join(home, '.cursor'), skills: join(home, '.cursor', 'skills') },
    { name: 'OpenCode', home: join(config, 'opencode'), skills: join(config, 'opencode', 'skills') },
    { name: 'Gemini CLI', home: join(home, '.gemini'), skills: join(home, '.gemini', 'skills') },
    { name: 'Antigravity', home: join(home, '.gemini', 'antigravity'), skills: join(home, '.gemini', 'antigravity', 'skills') },
  ]
}

const entry = path => { try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const real = path => { try { return realpathSync(path) } catch { return path } }
// Removing a link removes the link, never the directory it points to.
const remove = path => { if (entry(path)) rmSync(path, { recursive: true, force: true }) }
const readJSON = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
// OS messages may carry private paths, so only the code is reported.
const reason = error => ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'ENOTDIR', 'ENOENT', 'EEXIST', 'ELOOP'].includes(error?.code) ? error.code : 'unknown'

/**
 * Install the skill carried by this package: one shared copy under `~/.agents/skills`, linked into
 * every agent found here. The skill comes from the package of the CLI it is for, so the two match.
 * An agent that cannot be written to is reported and does not stop the others.
 */
export function installSkill({ packageRoot, env = process.env, home = homedir(), platform = process.platform } = {}) {
  const source = join(packageRoot, 'skills', SKILL_NAME)
  if (!existsSync(join(source, 'SKILL.md'))) throw new CliError('skill_missing', 'This installation does not carry the skill. Install it with: npx skills add hirifyme/hirify-cli')
  const shared = join(home, '.agents', 'skills')
  const path = join(shared, SKILL_NAME)
  try {
    mkdirSync(shared, { recursive: true })
    remove(path)
    cpSync(source, path, { recursive: true })
  } catch (error) { throw new CliError('skill_install_failed', `Could not save the skill (${reason(error)}). This command needs write access to the home directory.`) }
  const agents = []
  for (const agent of agentDirectories({ env, home })) {
    if (!existsSync(agent.home)) continue
    try {
      mkdirSync(agent.skills, { recursive: true })
      // An agent whose skills directory already is the shared one needs no link of its own.
      const parent = real(agent.skills)
      if (parent === real(shared)) { agents.push({ agent: agent.name, installed: true }); continue }
      const target = join(parent, SKILL_NAME)
      remove(target)
      try {
        // A junction needs no elevated rights on Windows; elsewhere the link stays relative.
        if (platform === 'win32') symlinkSync(real(path), target, 'junction')
        else symlinkSync(relative(parent, real(path)), target, 'dir')
      } catch { cpSync(source, target, { recursive: true }) }
      agents.push({ agent: agent.name, installed: true })
    } catch (error) { agents.push({ agent: agent.name, installed: false, reason: reason(error) }) }
  }
  return { skill: SKILL_NAME, path, agents }
}

/**
 * Put the CLI on PATH with the person's own npm and its settings: the environment goes to npm as
 * it is, because what npx adds to it is the same configuration, already resolved. A failure is a
 * result, not an error: without a global installation every command still runs as
 * `npx -y hirify-cli <command>`. A newer global installation is kept, never downgraded, and its
 * `root` says where the skill that matches it is.
 */
export async function installGlobally({ version, signal, env = process.env, run = runProcess } = {}) {
  const options = { signal, env }
  let root
  try { root = await run('npm', ['root', '--global'], { ...options, timeout: 10000 }) }
  catch (error) { if (signal?.aborted) throw error; return { installed: false, reason: 'npm_unavailable' } }
  if (root.code !== 0 || !root.stdout.trim()) return { installed: false, reason: 'npm_unavailable' }
  const location = join(root.stdout.trim(), PACKAGE_NAME)
  const current = readJSON(join(location, 'package.json'))
  if (current?.name === PACKAGE_NAME && semver.valid(current.version) && semver.gte(current.version, version)) return { installed: true, version: current.version, changed: false, ...(semver.gt(current.version, version) && { root: location }) }
  let result
  try { result = await run('npm', ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', `${PACKAGE_NAME}@${version}`], { ...options, timeout: 180000 }) }
  catch (error) { if (signal?.aborted) throw error; return { installed: false, reason: 'install_failed' } }
  return result.code === 0 ? { installed: true, version, changed: true } : { installed: false, reason: 'install_failed' }
}

/** Lines a person reads after `hirify skill` or `hirify init`. */
export function describeSkill(result) {
  const done = result.agents.filter(item => item.installed).map(item => item.agent)
  const failed = result.agents.filter(item => !item.installed).map(item => `${item.agent} (${item.reason})`)
  const lines = [done.length ? `The skill is installed for ${done.join(', ')}.` : `The skill is saved in ${result.path}. No supported agent was found on this computer.`]
  if (failed.length) lines.push(`It could not be installed for ${failed.join(', ')}. Check that the agent's skills directory is a folder you can write to, then run hirify skill.`)
  return lines
}
