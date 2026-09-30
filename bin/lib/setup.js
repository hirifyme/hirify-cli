import { existsSync, mkdirSync, cpSync, rmSync, symlinkSync, realpathSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
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

// Removing a link removes the link, never the directory it points to.
const remove = path => rmSync(path, { recursive: true, force: true })
// OS messages may carry private paths, so only the code is reported.
const reason = error => ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'ENOTDIR', 'ENOENT', 'EEXIST', 'ELOOP'].includes(error?.code) ? error.code : 'unknown'

// A junction needs no elevated rights on Windows; elsewhere the link stays relative.
const linkSkill = (path, target, platform) => (platform === 'win32'
  ? symlinkSync(realpathSync(path), target, 'junction')
  : symlinkSync(relative(dirname(target), realpathSync(path)), target, 'dir'))

/**
 * Install the skill carried by this package: one shared copy under `~/.agents/skills`, linked into
 * every agent found here. The skill comes from the package of the CLI it is for, so the two match.
 * An agent that cannot be written to is reported and does not stop the others. An agent that
 * cannot take a link gets a copy, and the result says so: a copy does not follow the shared one
 * when the CLI updates, so the person knows to run `hirify skill` again.
 */
export function installSkill({ packageRoot, env = process.env, home = homedir(), platform = process.platform, link = linkSkill } = {}) {
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
      const parent = realpathSync(agent.skills)
      if (parent === realpathSync(shared)) { agents.push({ agent: agent.name, installed: true }); continue }
      const target = join(parent, SKILL_NAME)
      remove(target)
      let copied = false
      try { link(path, target, platform) } catch { cpSync(source, target, { recursive: true }); copied = true }
      agents.push(copied ? { agent: agent.name, installed: true, copied: true } : { agent: agent.name, installed: true })
    } catch (error) { agents.push({ agent: agent.name, installed: false, reason: reason(error) }) }
  }
  return { skill: SKILL_NAME, path, agents }
}

/**
 * Put the newest release of the CLI on PATH, whichever package started the command, with the
 * person's own npm and its settings: the environment goes to npm as it is, because what npx adds
 * to it is the same configuration, already resolved. A pinned version and switched-off updates
 * keep the running release, as they do for automatic updates. A failure is a result, not an
 * error: without a global installation every command still runs as `npx -y hirify-cli <command>`.
 * An installation that is already at that release or past it is kept. `root` is where the
 * installed package is, and with it the skill that matches it.
 */
export async function installGlobally({ version, latest, signal, env = process.env, run = runProcess } = {}) {
  const options = { signal, env }
  if (!env.HIRIFY_VERSION_PIN && env.HIRIFY_NO_AUTO_UPDATE !== '1') {
    try { version = (await latest()).version }
    catch (error) { if (signal?.aborted || !(error instanceof CliError)) throw error; return { installed: false, reason: error.code } }
  }
  let root
  try { root = await run('npm', ['root', '--global'], { ...options, timeout: 10000 }) }
  catch (error) { if (signal?.aborted) throw error; return { installed: false, reason: 'npm_unavailable' } }
  if (root.code !== 0 || !root.stdout.trim()) return { installed: false, reason: 'npm_unavailable' }
  const location = join(root.stdout.trim(), PACKAGE_NAME)
  let current
  // Only a package that is not there counts as absent; one that cannot be read is reported.
  try { current = JSON.parse(readFileSync(join(location, 'package.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') return { installed: false, reason: 'global_package_unreadable' } }
  if (current?.name === PACKAGE_NAME && semver.valid(current.version) && semver.gte(current.version, version)) return { installed: true, version: current.version, changed: false, root: location }
  let result
  try { result = await run('npm', ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', `${PACKAGE_NAME}@${version}`], { ...options, timeout: 180000 }) }
  catch (error) { if (signal?.aborted) throw error; return { installed: false, reason: 'install_failed' } }
  return result.code === 0 ? { installed: true, version, changed: true, root: location } : { installed: false, reason: 'install_failed' }
}

/** Lines a person reads after `hirify skill` or `hirify init`. */
export function describeSkill(result) {
  const done = result.agents.filter(item => item.installed).map(item => item.agent)
  const failed = result.agents.filter(item => !item.installed).map(item => `${item.agent} (${item.reason})`)
  const lines = [done.length ? `The skill is installed for ${done.join(', ')}.` : `The skill is saved in ${result.path}. No supported agent was found on this computer.`]
  if (failed.length) lines.push(`It could not be installed for ${failed.join(', ')}. Check that the agent's skills directory is a folder you can write to, then run hirify skill.`)
  const copies = result.agents.filter(item => item.copied).map(item => item.agent)
  if (copies.length) lines.push(`For ${copies.join(', ')} the skill is a copy, not a link: after the CLI updates, run hirify skill to refresh it.`)
  return lines
}
