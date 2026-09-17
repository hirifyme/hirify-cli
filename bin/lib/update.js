import { realpathSync, readFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync, lstatSync } from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import spawn from 'cross-spawn'
import semver from 'semver'
import lockfile from 'proper-lockfile'
import { CliError, aborted } from './errors.js'
import { makePrivate } from './store.js'
import { requireJSON, delay } from './http.js'

export const PACKAGE_NAME = 'hirify-cli'
export function runProcess(command, args, { signal, timeout = 120000, env = process.env, cwd } = {}) {
  aborted(signal)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', expired = false
    let forceTimer
    const stop = () => {
      if (!child.pid) return
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
      else { try { process.kill(-child.pid, 'SIGTERM') } catch {}; forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 800); forceTimer.unref() }
    }
    const timer = setTimeout(() => { expired = true; stop() }, timeout)
    const cancel = stop
    signal?.addEventListener('abort', cancel, { once: true })
    child.stdout?.on('data', v => { if (stdout.length < 1024 * 1024) stdout += v })
    child.stderr?.on('data', v => { if (stderr.length < 1024 * 1024) stderr += v })
    child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new CliError('process_start_failed', 'Could not start the package manager. Check npm on PATH.')) })
    child.once('close', (code, childSignal) => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', cancel); if (signal?.aborted) reject(signal.reason); else if (expired) reject(new CliError('update_timeout', 'The package manager did not finish in time. The active CLI was not replaced.')); else resolve({ code, signal: childSignal, stdout, stderr }) })
  })
}
const real = path => { try { return realpathSync(path) } catch { return resolve(path) } }
export function updateDirectory(configDir, baseRoot) {
  return join(configDir, 'updates', createHash('sha256').update(real(baseRoot)).digest('hex').slice(0, 24))
}
function readJSON(file) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
async function privateDirectory(path, signal) { mkdirSync(path, { recursive: true, mode: 0o700 }); await makePrivate(path, true, signal) }
async function atomicJSON(file, value, signal) {
  await privateDirectory(dirname(file), signal)
  const temp = file + '.' + randomUUID() + '.tmp'
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined
    if (process.platform === 'win32') await makePrivate(temp, false, signal)
    renameSync(temp, file)
    if (process.platform !== 'win32') { const dir = openSync(dirname(file), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } }
  } finally { if (fd !== undefined) closeSync(fd); try { rmSync(temp) } catch {} }
}
export function activeInstallation(configDir, baseRoot, baseVersion, pin = '') {
  const dir = updateDirectory(configDir, baseRoot)
  const state = readJSON(join(dir, 'active.json'))
  if (!state || state.base_version !== baseVersion || !semver.valid(state.version) || (pin && pin !== state.version)) return null
  if (!state.pinned && !semver.gt(state.version, baseVersion)) return null
  // The pointer contains only a validated version, never an arbitrary executable path.
  const root = join(dir, 'versions', state.version, 'node_modules', PACKAGE_NAME)
  const pkg = readJSON(join(root, 'package.json'))
  if (pkg?.name !== PACKAGE_NAME || pkg.version !== state.version || !semver.satisfies(process.version, pkg.engines?.node || '*') || !existsSync(join(root, 'bin', 'lib', 'main.js'))) return null
  // Selection is read-only, including for offline version. ACLs are set during installation.
  for (const directory of [configDir, join(configDir, 'updates'), dir, join(dir, 'versions'), dirname(dirname(root))]) {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o022)))) throw new CliError('unsafe_storage', 'The managed CLI directory must be private and owned by this user.')
  }
  const canonical = real(root)
  if (relative(real(dir), canonical).startsWith('..') || isAbsolute(relative(real(dir), canonical)) || lstatSync(root).isSymbolicLink()) return null
  return { root, version: state.version, pinned: Boolean(state.pinned), previous: state.previous || null }
}
export function createUpdater({ config, http, signal, output, event, packageRoot, baseRoot = packageRoot, baseVersion = config.version, run = runProcess }) {
  const dir = updateDirectory(config.dir, baseRoot)
  const stateFile = join(dir, 'active.json')
  async function installation() {
    // A checkout or a local/npx dependency is never modified or auto-managed.
    const canonical = real(baseRoot)
    if (!canonical.includes('node_modules') || config.env.npm_command === 'exec' || config.env.npm_lifecycle_event === 'npx') return { owner: 'unmanaged', reason: 'checkout_or_ephemeral' }
    try {
      const answer = await run('npm', ['root', '--global'], { signal, timeout: 3000 })
      if (answer.code !== 0) return { owner: 'unknown', reason: 'npm_root_failed' }
      return real(join(answer.stdout.trim(), PACKAGE_NAME)) === canonical ? { owner: 'npm-global', reason: 'verified' } : { owner: 'unmanaged', reason: 'different_prefix' }
    } catch (error) { if (signal?.aborted) throw error; return { owner: 'unknown', reason: error.code || 'npm_unavailable' } }
  }
  async function registry() {
    const answer = await run('npm', ['config', 'get', 'registry'], { signal, timeout: 3000 })
    if (answer.code !== 0) throw new CliError('update_registry', 'Could not determine the npm registry.')
    let url
    try { url = new URL(answer.stdout.trim()) } catch { throw new CliError('update_registry', 'The npm registry URL is invalid.') }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new CliError('update_registry', 'Use an HTTPS npm registry without credentials in its URL.')
    return url.href.replace(/\/$/, '')
  }
  async function check(version = 'latest') {
    if (version !== 'latest' && !semver.valid(version)) throw new CliError('invalid_arguments', 'Use an exact semantic version, such as hirify update 0.5.0.')
    const registryURL = await registry()
    const res = await http.request(`${registryURL}/${PACKAGE_NAME}/${encodeURIComponent(version)}`, { safe: true, timeout: 3000 })
    if (!res.ok) throw new CliError('update_check_failed', 'Could not check the requested CLI version.', { status: res.status })
    const pkg = requireJSON(res)
    if (pkg.name !== PACKAGE_NAME || !semver.valid(pkg.version) || (version !== 'latest' && pkg.version !== version) || !pkg.dist?.integrity || !semver.satisfies(process.version, pkg.engines?.node || '*')) throw new CliError('update_incompatible', 'The requested CLI release is invalid or does not support this Node version.')
    return { version: pkg.version, registry: registryURL, integrity: pkg.dist.integrity, available: semver.gt(pkg.version, config.version) }
  }
  async function install(target, { pin = false } = {}) {
    const owner = await installation()
    if (owner.owner !== 'npm-global') throw new CliError('update_owner_unknown', 'This installation is managed elsewhere. Update it with the package manager that installed it, or run npx hirify-cli@<version>.')
    await privateDirectory(config.dir, signal); await privateDirectory(dir, signal); await privateDirectory(join(dir, 'versions'), signal)
    let release
    while (!release) {
      aborted(signal)
      try { release = await lockfile.lock(stateFile, { realpath: false, stale: 600000, update: 10000 }) }
      catch (error) { if (error.code !== 'ELOCKED') throw new CliError('update_lock_failed', 'Could not lock the update directory.'); await delay(100, signal) }
    }
    let staging
    try {
      const previousState = readJSON(stateFile)
      const destination = join(dir, 'versions', target.version)
      if (!existsSync(destination)) {
        staging = mkdtempSync(join(dir, '.staging-')); await makePrivate(staging, true, signal)
        const result = await run('npm', ['install', '--prefix', staging, '--ignore-scripts', '--no-audit', '--no-fund', '--strict-ssl=true', '--registry', target.registry, `${PACKAGE_NAME}@${target.version}`], { signal, timeout: 180000, env: { ...config.env, HIRIFY_NO_AUTO_UPDATE: '1' } })
        if (result.code !== 0) throw new CliError('update_install_failed', 'The update could not be installed. The active CLI was not replaced.')
        const pkgPath = join(staging, 'node_modules', PACKAGE_NAME)
        const pkg = readJSON(join(pkgPath, 'package.json'))
        const lock = readJSON(join(staging, 'package-lock.json'))
        if (pkg?.name !== PACKAGE_NAME || pkg.version !== target.version || !existsSync(join(pkgPath, 'bin', 'lib', 'main.js')) || lock?.packages?.[`node_modules/${PACKAGE_NAME}`]?.integrity !== target.integrity) throw new CliError('update_verification_failed', 'The installed package did not match the selected release. The active CLI was not replaced.')
        const verify = await run(process.execPath, [join(pkgPath, 'bin', 'hirify.js'), 'version'], { signal, timeout: 10000, env: { ...config.env, HIRIFY_NO_AUTO_UPDATE: '1', HIRIFY_INTERNAL_REEXEC: '1' } })
        if (verify.code !== 0 || verify.stdout.trim() !== target.version) throw new CliError('update_verification_failed', 'The new CLI could not start. The active CLI was not replaced.')
        renameSync(staging, destination); staging = null
      }
      const cachedRoot = join(destination, 'node_modules', PACKAGE_NAME)
      const cachedPackage = readJSON(join(cachedRoot, 'package.json'))
      const cachedLock = readJSON(join(destination, 'package-lock.json'))
      if (cachedPackage?.name !== PACKAGE_NAME || cachedPackage.version !== target.version || !semver.satisfies(process.version, cachedPackage.engines?.node || '*') || !existsSync(join(cachedRoot, 'bin', 'lib', 'main.js')) || cachedLock?.packages?.[`node_modules/${PACKAGE_NAME}`]?.integrity !== target.integrity) throw new CliError('update_verification_failed', 'The cached artifact does not match the selected release. The active CLI was not replaced.')
      aborted(signal)
      const previous = previousState?.base_version === baseVersion ? (previousState.version === target.version ? previousState.previous : previousState.version) : baseVersion
      const pinned = pin || Boolean(previousState?.version === target.version && previousState.pinned)
      await atomicJSON(stateFile, { schema_version: 1, base_version: baseVersion, version: target.version, integrity: target.integrity, pinned, previous: previous || baseVersion }, signal)
      return { version: target.version, previous: previous || baseVersion, pinned }
    } finally { if (staging) rmSync(staging, { recursive: true, force: true }); await release().catch(() => {}) }
  }
  async function rollback() {
    const state = readJSON(stateFile)
    if (!state || state.base_version !== baseVersion || !semver.valid(state.previous)) throw new CliError('update_no_previous', 'No previous managed CLI version is available. Install an exact package version with npm instead.')
    if (state.previous !== baseVersion && !existsSync(join(dir, 'versions', state.previous, 'node_modules', PACKAGE_NAME, 'bin', 'lib', 'main.js'))) throw new CliError('update_no_previous', 'The previous CLI artifact is unavailable. Install its exact package version with npm instead.')
    let release
    while (!release) {
      aborted(signal)
      try { release = await lockfile.lock(stateFile, { realpath: false, stale: 600000, update: 10000 }) }
      catch (error) { if (error.code !== 'ELOCKED') throw new CliError('update_lock_failed', 'Could not lock the update directory.'); await delay(100, signal) }
    }
    try {
      const current = readJSON(stateFile)
      if (current?.version !== state.version) throw new CliError('update_changed', 'Another process changed the active version. Check hirify version before retrying.')
      await atomicJSON(stateFile, { ...state, version: state.previous, previous: state.version, integrity: null, pinned: true }, signal)
      return { version: state.previous, previous: state.version, pinned: true }
    } finally { await release().catch(() => {}) }
  }
  async function automatic() {
    if (config.env.HIRIFY_NO_AUTO_UPDATE === '1' || config.env.HIRIFY_INTERNAL_REEXEC === '1' || config.env.HIRIFY_VERSION_PIN || readJSON(stateFile)?.pinned) return null
    const owner = await installation()
    if (owner.owner !== 'npm-global') { event('update', { code: owner.reason }); return null }
    try {
      const target = await check()
      if (!target.available) { event('update', { code: 'up_to_date' }); return null }
      output.progress(`Installing Hirify CLI ${target.version} in a separate directory...`)
      const result = await install(target)
      output.progress(`Hirify CLI ${result.version} is ready.`)
      return activeInstallation(config.dir, baseRoot, baseVersion)
    } catch (error) {
      if (signal?.aborted) throw error
      event('update', { code: error.code })
      output.progress(`Update check or installation did not complete (${error.code || 'update_failed'}). Continuing with ${config.version}. Run hirify update --check for details.`)
      return null
    }
  }
  return { installation, check, install, rollback, automatic, dir }
}
