// Run in a native desktop terminal. No production account or token is used.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dir = mkdtempSync(join(tmpdir(), 'hirify browser '))
let authorization, exchanged = false, fault
const server = createServer(async (req, res) => {
 const base = `http://127.0.0.1:${server.address().port}`
 const url = new URL(req.url, base)
 const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
 if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', scopes_supported: ['agent:read','offline_access'], code_challenge_methods_supported: ['S256'] })
 if (url.pathname === '/register') return json({ client_id: 'browser-smoke-client' })
 if (url.pathname === '/authorize') {
  authorization = url.searchParams
  if (!['client_id','redirect_uri','state','scope','code_challenge','code_challenge_method'].every(k => authorization.get(k))) { fault = 'Authorization URL was truncated'; res.writeHead(400); res.end(fault); return }
  const redirect = new URL(authorization.get('redirect_uri'))
  if (!['127.0.0.1','[::1]'].includes(redirect.hostname)) { fault = 'Callback was not loopback'; res.writeHead(400); res.end(fault); return }
  redirect.searchParams.set('state', authorization.get('state')); redirect.searchParams.set('code', 'synthetic-code')
  res.writeHead(302, { Location: redirect.href }); res.end(); return
 }
 if (url.pathname === '/token') {
  let text = ''; for await (const chunk of req) text += chunk
  const form = new URLSearchParams(text)
  if (createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== authorization?.get('code_challenge')) { fault = 'PKCE mismatch'; res.writeHead(400); res.end(); return }
  exchanged = true; return json({ token_type: 'Bearer', access_token: 'synthetic-browser-access', refresh_token: 'synthetic-browser-refresh', expires_in: 3600 })
 }
 res.writeHead(404); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
 const env = { ...process.env, HIRIFY_API: `http://127.0.0.1:${server.address().port}`, XDG_CONFIG_HOME: dir, HIRIFY_KEY: '', HIRIFY_NO_AUTO_UPDATE: '1', HIRIFY_VERSION_PIN: '', NO_PROXY: '*', no_proxy: '*' }
 const child = spawn(process.execPath, [process.env.HIRIFY_TEST_CLI || join(root, 'bin/hirify.js'), 'login', '--timeout', '90', ...process.argv.slice(2)], { env, stdio: 'inherit' })
 const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
 if (code !== 0 || !exchanged || fault || JSON.parse(readFileSync(join(dir, 'hirify/auth.json'))).access_token !== 'synthetic-browser-access') throw Error(fault || 'Browser smoke did not complete')
 console.log('PASS: complete authorization URL, browser callback, PKCE, token save and process exit.')
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }) }
