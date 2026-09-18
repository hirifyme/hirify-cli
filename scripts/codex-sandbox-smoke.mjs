// Exercise the installed Codex sandbox, including a negative write probe.
// Only synthetic credentials and a local API are used. No account or model calls.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'hirify-codex-'))
const workspace = join(root, 'workspace'), config = join(root, 'config')
mkdirSync(workspace); mkdirSync(join(config, 'hirify'), { recursive: true, mode: 0o700 })
const file = join(config, 'hirify', 'auth.json')
const cli = resolve(process.env.HIRIFY_TEST_CLI || 'bin/hirify.js')
const requests = []
const api = createServer((req, res) => {
 requests.push({ method: req.method, path: req.url }); res.setHeader('Content-Type', 'application/json')
 const origin = `http://127.0.0.1:${api.address().port}`
 if (req.url === '/.well-known/hirify-agent') res.end(JSON.stringify({ manifest_url: origin + '/meta' }))
 else if (req.url === '/meta') res.end(JSON.stringify({ schema_version: 1, capabilities: [{ id: 'feeds.list', method: 'GET', path: '/feeds', meter: 'none' }] }))
 else if (req.url === '/feeds') { assert.equal(req.headers.authorization, 'Bearer synthetic-sandbox-access'); res.end(JSON.stringify({ ok: true, data: [] })) }
 else { res.statusCode = 404; res.end('{}') }
})
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${api.address().port}`
const state = { schema_version: 1, kind: 'oauth', issuer: origin, client_id: 'synthetic-client', access_token: 'synthetic-sandbox-access', refresh_token: 'synthetic-sandbox-refresh', expires_at: 9999999999 }
const save = value => writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
const env = { ...process.env, HIRIFY_KEY: '', HIRIFY_API: origin, XDG_CONFIG_HOME: config, HIRIFY_NO_AUTO_UPDATE: '1', HIRIFY_DEBUG: '', HIRIFY_VERSION_PIN: '', NODE_OPTIONS: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' }
function run(args) {
 return new Promise((resolve, reject) => {
  const p = spawn(process.env.HIRIFY_CODEX_BIN || 'codex', ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '--', process.execPath, ...args], { env, cwd: workspace })
  let stdout = '', stderr = ''; p.stdout.on('data', b => stdout += b); p.stderr.on('data', b => stderr += b)
  const timer = setTimeout(() => p.kill('SIGKILL'), 30000)
  p.once('error', e => { clearTimeout(timer); reject(e) }); p.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
 })
}
try {
 save(state)
 const probe = await run(['-e', `const fs=require('fs'); fs.readFileSync(${JSON.stringify(file)});try{fs.writeFileSync(${JSON.stringify(join(config, 'write-probe'))},'test');process.exitCode=9}catch(e){if(!['EACCES','EPERM','EROFS'].includes(e.code))throw e;console.log(e.code)}`])
 assert.equal(probe.code, 0, probe.stderr); assert.match(probe.stdout, /EACCES|EPERM|EROFS/); assert.equal(existsSync(join(config, 'write-probe')), false)
 const before = readFileSync(file, 'utf8')
 const read = await run([cli, 'feed', 'list', '--json', '--error-format=json'])
 assert.equal(read.code, 0, read.stderr); assert.equal(JSON.parse(read.stdout).ok, true); assert.equal(readFileSync(file, 'utf8'), before)
 save({ ...state, expires_at: 1 }); const expired = readFileSync(file, 'utf8')
 const refresh = await run([cli, 'feed', 'list', '--json', '--error-format=json'])
 assert.equal(refresh.code, 1, refresh.stdout + refresh.stderr); assert.equal(JSON.parse(refresh.stderr).error.code, 'storage_unavailable'); assert.match(JSON.parse(refresh.stderr).error.message, /write access/)
 assert.equal(readFileSync(file, 'utf8'), expired); assert.equal(requests.filter(x => x.method === 'POST').length, 0)
 console.log(JSON.stringify({ sandbox: 'codex workspace-write', write_probe: probe.stdout.trim(), saved_oauth_feed_read: 'passed', refresh_without_write: 'refused_before_exchange', credential_unchanged: true }))
} finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); rmSync(root, { recursive: true, force: true }) }
