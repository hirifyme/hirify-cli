// Synthetic HTTPS registry + real npm. Never installs into the user's global prefix.
import { createServer } from 'node:https'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createUpdater, activeInstallation, runProcess } from '../bin/lib/update.js'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json')))
const manifest = JSON.parse(readFileSync(join(root, '.artifacts/release-manifest.json')))
const tgz = readFileSync(join(root, '.artifacts', manifest.filename))
const dir = mkdtempSync(join(tmpdir(), 'hirify real npm '))
const prefix = join(dir, 'global prefix')
const env = { ...process.env, npm_config_prefix: prefix, NODE_EXTRA_CA_CERTS: join(root, 'scripts/fixtures/localhost-cert.pem'), HIRIFY_NO_AUTO_UPDATE: '1', HIRIFY_API: 'http://127.0.0.1:1', HIRIFY_KEY: '', XDG_CONFIG_HOME: join(dir, 'config') }
const server = createServer({ key: readFileSync(join(root, 'scripts/fixtures/localhost-key.pem')), cert: readFileSync(env.NODE_EXTRA_CA_CERTS) }, (req, res) => {
 if (req.url !== '/package.tgz' && req.url !== '/hirify-cli' && req.url !== '/hirify-cli/' + pkg.version) { res.writeHead(307, { Location: 'https://registry.npmjs.org' + req.url }); res.end(); return }
 if (req.url === '/package.tgz') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(tgz); return }
 const release = { ...pkg, dist: { tarball: `https://127.0.0.1:${server.address().port}/package.tgz`, integrity: manifest.integrity } }
 res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url === '/hirify-cli' ? { name: pkg.name, 'dist-tags': { latest: pkg.version }, versions: { [pkg.version]: release } } : release))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
 const run = async (command, args, options = {}) => { const result = await runProcess(command, args, { ...options, env: { ...env, ...options.env, npm_config_prefix: prefix, NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS, NO_PROXY: '*', no_proxy: '*' } }); if (result.code !== 0) console.error(result.stderr); return result }
 const roots = await run('npm', ['root', '--global'])
 const baseRoot = join(roots.stdout.trim(), pkg.name); mkdirSync(baseRoot, { recursive: true })
 writeFileSync(join(baseRoot, 'untouched'), 'bootstrap')
 const config = { dir: join(dir, 'config'), env, version: '0.4.7' }
 const updater = createUpdater({ config, http: {}, signal: new AbortController().signal, output: { progress() {} }, event() {}, packageRoot: baseRoot, run })
 const selected = { version: pkg.version, integrity: manifest.integrity, registry: `https://127.0.0.1:${server.address().port}` }
 await updater.install(selected, { pin: true })
 const active = activeInstallation(config.dir, baseRoot, config.version)
 assert.equal(active.version, pkg.version)
 const executed = await run(process.execPath, [join(active.root, 'bin/hirify.js'), 'version'])
 assert.equal(executed.code, 0); assert.equal(executed.stdout.trim(), pkg.version)
 assert.equal(readFileSync(join(baseRoot, 'untouched'), 'utf8'), 'bootstrap')
 assert.equal((await updater.rollback()).version, '0.4.7')
 assert.equal(activeInstallation(config.dir, baseRoot, config.version), null)
 console.log('Real npm: HTTPS registry, exact artifact, staging, activation, execution and rollback passed.')
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }) }
