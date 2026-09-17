import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse, help, createOutput } from './cli.js'
import { CliError } from './errors.js'
const ownRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export async function main(argv = process.argv.slice(2), { baseRoot = ownRoot, baseVersion, selected = false, skipUpdate = false } = {}) {
  let command
  let output = createOutput({ errorJSON: argv.includes('--error-format=json') || argv.some((x, i) => x === '--error-format' && argv[i + 1] === 'json') })
  let cleanup = async () => {}
  let next
  let exitCode = 0
  try {
    command = parse(argv)
    if (command.help) { output.console.log(help(command.topic)); await output.flush(); return 0 }
    const pkg = JSON.parse(readFileSync(join(ownRoot, 'package.json'), 'utf8'))
    baseVersion ||= pkg.version
    const { resolveConfig } = await import('./config.js')
    // A broken configuration must not make the offline version command unavailable.
    let config
    try { config = resolveConfig() } catch (error) { if (command.name !== 'version') throw error; config = { dir: '', env: process.env, api: '' } }
    config.version = pkg.version
    const { createUpdater, activeInstallation } = await import('./update.js')
    if (!selected && config.dir) {
      const active = activeInstallation(config.dir, baseRoot, baseVersion, config.env.HIRIFY_VERSION_PIN)
      if (active && active.root !== ownRoot) {
        const module = await import(pathToFileURL(join(active.root, 'bin', 'lib', 'main.js')).href)
        return await module.main(argv, { baseRoot, baseVersion, selected: true, skipUpdate })
      }
    }
    if (config.env.HIRIFY_VERSION_PIN && config.env.HIRIFY_VERSION_PIN !== pkg.version && command.name !== 'update') throw new CliError('version_pin_unavailable', 'The pinned CLI version is not active. Run hirify update <exact-version> or install that exact npm version.')
    if (command.name === 'version') { if (command.json) output.json({ version: pkg.version }); else output.console.log(pkg.version); await output.flush(); return 0 }
    const controller = new AbortController()
    const signal = controller.signal
    const interrupt = () => controller.abort(new CliError('cancelled', 'The command was cancelled.', { exitCode: 130 }))
    const terminate = () => controller.abort(new CliError('cancelled', 'The command was terminated.', { exitCode: 143 }))
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
    const timer = setTimeout(() => controller.abort(new CliError('command_timeout', 'The command deadline was reached. Use --timeout <seconds> if more time is needed.')), command.timeout)
    cleanup = async () => { clearTimeout(timer); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
    const secrets = new Set([config.envKey].filter(Boolean))
    output.dispose()
    output = createOutput({ json: command.json, errorJSON: command.errorJSON, secrets })
    const events = []
    const event = (phase, data = {}) => {
      const item = { phase, code: data.code || 'unknown', ...(Number.isInteger(data.status) ? { status: data.status } : {}), ...(Number.isFinite(data.duration_ms) ? { duration_ms: data.duration_ms } : {}) }
      if (events.length < 100) events.push(item)
      if (command.values.debug || config.env.HIRIFY_DEBUG) output.progress(JSON.stringify(item))
    }
    const [{ createHttp }, { createStore }, { createAuth }, { createApi }, { createCommands }, { prepareInput }] = await Promise.all([import('./http.js'), import('./store.js'), import('./auth.js'), import('./api.js'), import('./commands.js'), import('./input.js')])
    const http = createHttp({ signal, version: pkg.version, event })
    cleanup = async () => { clearTimeout(timer); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); http.close() }
    await prepareInput(command, signal)
    const store = createStore(config, { signal })
    const auth = createAuth({ config, store, http, signal, output, event, secrets })
    const api = createApi({ config, http, auth, output })
    const updater = createUpdater({ config, http, signal, output, event, packageRoot: ownRoot, baseRoot, baseVersion })
    const local = ['auth', 'auth status', 'logout', 'doctor', 'skill', 'update'].includes(command.name)
    if (!skipUpdate && !local) next = await updater.automatic()
    if (next) {
      // Dispose every timer and signal handler before handing off, at most once per invocation.
    } else if (command.name === 'login') {
      const result = await auth.login({ force: Boolean(command.values.force), noBrowser: Boolean(command.values['no-browser']), port: Number(command.values['callback-port'] || 0), consentMs: Math.min(command.timeout, 300000) })
      if (command.json) output.json(result)
      else { output.console.log(result.already_signed_in ? 'Already signed in. Use hirify login --force to sign in again.' : 'Signed in. Access saved on this computer.'); if (result.environment_override || result.source === 'environment') output.progress('HIRIFY_KEY is set and takes precedence over the saved sign-in.'); output.console.log('Your plan and allowances: hirify account show') }
    } else if (command.name === 'auth') {
      secrets.add(command.words[0])
      await store.commit({ kind: 'key', access_token: command.words[0] })
      if (command.json) output.json({ signed_in: true, source: 'key', environment_override: Boolean(config.envKey) })
      else output.console.log('Key saved on this computer.')
      if (config.envKey) output.progress('HIRIFY_KEY is set and takes precedence over the saved key.')
    } else if (command.name === 'logout') {
      const had = await store.logout()
      if (command.json) output.json({ signed_out: true, environment_override: Boolean(config.envKey) })
      else output.console.log(had ? 'Signed out on this computer.' : 'Nobody is signed in here.')
      if (config.envKey) output.progress('HIRIFY_KEY is still set. Remove it from the environment to stop using that key.')
    } else if (command.name === 'auth status') {
      const status = auth.status()
      if (command.json) output.json(status); else output.console.log(`Sign-in source: ${status.source}\nServer: ${status.issuer}${status.renewal_uncertain ? '\nRenewal needs a new sign-in: hirify login --force' : ''}`)
    } else if (command.name === 'doctor') {
      const { environment } = await import('./browser.js')
      let status
      try { status = auth.status() } catch (error) { status = { error: error.code } }
      const info = { schema_version: 1, cli_version: pkg.version, node: process.version, platform: process.platform, architecture: process.arch, server: config.api, config_source: config.env.XDG_CONFIG_HOME ? 'XDG_CONFIG_HOME' : 'home', auth: status, environment: environment(), proxy_configured: Boolean(config.env.HTTPS_PROXY || config.env.https_proxy || config.env.HTTP_PROXY || config.env.http_proxy), custom_ca: Boolean(config.env.NODE_EXTRA_CA_CERTS), auto_update_disabled: config.env.HIRIFY_NO_AUTO_UPDATE === '1', managed_version: ownRoot !== baseRoot, installation: await updater.installation() }
      output.json(info)
    } else if (command.name === 'update') {
      if (command.values.rollback) { const result = await updater.rollback(); output.json(result); return 0 }
      const target = await updater.check(command.words[0] || config.env.HIRIFY_VERSION_PIN || 'latest')
      if (command.values.check) output.json({ current: pkg.version, ...target, integrity: undefined, registry: undefined, installation: await updater.installation() })
      else { const result = await updater.install(target, { pin: Boolean(command.words[0] || config.env.HIRIFY_VERSION_PIN) }); if (command.json) output.json(result); else output.console.log(`Hirify CLI ${result.version} is ready for the next command.${result.pinned ? ' This version is pinned.' : ''}`) }
    } else {
      const commands = createCommands({ api, output, config, signal, event, fields: command.values.fields })
      if (command.name === 'skill' && command.json) output.json({ install: 'npx skills add hirifyme/hirify-cli' })
      else await commands[command.name](command.args, command.words)
    }
  } catch (error) { exitCode = output.error(error) }
  finally { await cleanup(); await output.flush().catch(() => { exitCode = 1 }); output.dispose() }
  if (next) {
    const module = await import(pathToFileURL(join(next.root, 'bin', 'lib', 'main.js')).href)
    return module.main(argv, { baseRoot, baseVersion, selected: true, skipUpdate: true })
  }
  return exitCode
}
