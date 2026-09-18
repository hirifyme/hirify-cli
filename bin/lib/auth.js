import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { CliError, aborted } from './errors.js'
import { trustedURL } from './config.js'
import { requireJSON } from './http.js'
import { startCallbackServer } from './loopback.js'
import { environment, openBrowser } from './browser.js'
export const SCOPES = ['agent:read', 'agent:reveal', 'agent:apply', 'agent:manage', 'agent:feedback', 'offline_access']
export function tokenResponse(body, previous = {}) {
  if (!body || typeof body.access_token !== 'string' || !body.access_token.trim() || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer' || (body.refresh_token != null && (typeof body.refresh_token !== 'string' || !body.refresh_token)) || (body.scope !== undefined && typeof body.scope !== 'string')) throw new CliError('oauth_protocol', 'The sign-in server returned an invalid token response. No new credentials were saved.')
  if (body.expires_in !== undefined && !['number', 'string'].includes(typeof body.expires_in)) throw new CliError('oauth_protocol', 'The sign-in server returned an invalid token lifetime.')
  const expiry = body.expires_in === undefined ? null : Number(body.expires_in)
  if (expiry !== null && (!Number.isSafeInteger(expiry) || expiry <= 0 || expiry > 315360000)) throw new CliError('oauth_protocol', 'The sign-in server returned an invalid token lifetime.')
  return { ...previous, access_token: body.access_token, refresh_token: body.refresh_token ?? previous.refresh_token ?? null, scope: body.scope ?? previous.scope ?? '', expires_at: expiry === null ? null : Math.floor(Date.now() / 1000) + expiry }
}
export function createAuth({ config, store, http, signal, output, event, secrets }) {
  const remember = s => { if (s) { secrets.add(s.access_token); secrets.add(s.refresh_token) }; return s }
  async function form(url, data) {
    const res = await http.request(trustedURL(url, config.api), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() })
    return { ...res, body: requireJSON(res) }
  }
  async function refresh(observed, { force = false } = {}) {
    return store.locked(async () => {
      const current = store.read()
      if (!current || current.kind !== 'oauth') throw new CliError('session_changed', 'The sign-in changed. Run the command again.')
      if (current.generation !== observed.generation || current.access_token !== observed.access_token) return remember(current)
      if (!force && (!current.expires_at || current.expires_at > Date.now() / 1000 + 60)) return remember(current)
      if (!current.refresh_token) throw new CliError('auth_required', 'Your sign-in has expired. Run hirify login --force.')
      const endpoint = trustedURL(current.token_endpoint || `${config.api}/oauth/token`, config.api)
      // A lost refresh response cannot safely be retried with a rotating token.
      await store.write({ ...current, refresh_pending: true })
      let response
      try { response = await form(endpoint, { grant_type: 'refresh_token', client_id: current.client_id, refresh_token: current.refresh_token }) }
      catch (error) { if (signal.aborted) throw signal.reason; event('refresh', { code: error.code }); throw new CliError('refresh_uncertain', 'Token renewal did not finish safely. Run hirify login --force; the old refresh token will not be retried.') }
      if (!response.ok) {
        // Explicit OAuth errors are a known failure, but never silently replay the grant.
        throw new CliError(response.body?.error === 'invalid_grant' ? 'auth_required' : 'refresh_failed', 'The saved sign-in could not be renewed. Run hirify login --force.', { status: response.status })
      }
      const next = remember(tokenResponse(response.body, current))
      next.generation = randomUUID(); next.refresh_pending = false
      await store.write(next); return next
    })
  }
  async function access() {
    if (config.envKey) { secrets.add(config.envKey); return config.envKey }
    let current = remember(store.read({ allowPending: true }))
    if (!current) throw new CliError('auth_required', 'You are not signed in. Run hirify login. For CI or servers, set HIRIFY_KEY or use hirify auth --stdin.')
    if (current.kind === 'oauth' && (current.refresh_pending || (current.expires_at && current.expires_at <= Date.now() / 1000 + 60))) current = await refresh(current)
    return current.access_token
  }
  async function retryToken(rejected) {
    if (config.envKey) return null
    const current = remember(store.read({ allowPending: true }))
    if (!current || current.kind !== 'oauth') return null
    if (current.access_token !== rejected) return current.access_token
    return (await refresh(current, { force: true })).access_token
  }
  async function discover() {
    const res = await http.request(`${config.api}/.well-known/oauth-authorization-server`, { safe: true })
    if (!res.ok) throw new CliError('oauth_discovery', 'Could not load the sign-in settings.', { status: res.status })
    const body = requireJSON(res)
    if (body.issuer !== config.api) throw new CliError('issuer_mismatch', 'The sign-in server returned a different issuer.')
    const result = {}
    for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) result[key] = trustedURL(body[key], config.api)
    if (body.code_challenge_methods_supported && (!Array.isArray(body.code_challenge_methods_supported) || !body.code_challenge_methods_supported.includes('S256'))) throw new CliError('oauth_protocol', 'The sign-in server does not support PKCE S256.')
    const scopes = body.scopes_supported
    if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some(x => typeof x !== 'string'))) throw new CliError('oauth_protocol', 'The sign-in server returned invalid permissions.')
    result.scopes = SCOPES.filter(scope => !scopes || scopes.includes(scope)).join(' ')
    return result
  }
  async function login({ force = false, noBrowser = false, port = 0, consentMs = 300000 } = {}) {
    if (!force) {
      const current = store.read()
      if (current?.kind === 'oauth') { await access(); return { signed_in: true, already_signed_in: true, source: config.envKey ? 'environment' : 'oauth' } }
    }
    const info = environment()
    if (!noBrowser && (!info.interactive || info.remote)) throw new CliError('interaction_required', 'This terminal cannot complete browser sign-in automatically. Use HIRIFY_KEY or hirify auth --stdin. For manual sign-in, use hirify login --no-browser; over SSH, also choose --callback-port and forward that port.')
    if (info.remote && noBrowser && !port) throw new CliError('remote_callback_required', 'Browser callbacks must reach this machine. Choose --callback-port and forward that port over SSH, or use HIRIFY_KEY.')
    const generation = await store.beginLogin({ force })
    const endpoints = await discover()
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(16).toString('base64url')
    secrets.add(verifier); secrets.add(state)
    const listener = await startCallbackServer({ state, issuer: config.api, port, signal, timeoutMs: consentMs })
    let reminder, launchTask
    try {
      const registration = await http.request(endpoints.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Hirify CLI', redirect_uris: [listener.redirectUri] }) })
      const client = requireJSON(registration)
      if (!registration.ok || typeof client.client_id !== 'string' || !client.client_id) throw new CliError('oauth_registration', 'Could not start sign-in with this server.', { status: registration.status })
      const url = new URL(endpoints.authorization_endpoint)
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: listener.redirectUri, scope: endpoints.scopes, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value)
      // This intentional sign-in link belongs to the person, never to diagnostic events.
      output.progress('Open this link to confirm access:')
      output.progress(url.href, { secret: true })
      output.progress('The browser must be able to reach the callback on this machine. Waiting for confirmation; press Ctrl+C to cancel.')
      reminder = setInterval(() => output.progress('Still waiting for browser confirmation. Use the sign-in link above, or press Ctrl+C.'), 30000)
      if (!noBrowser && info.canOpen) launchTask = openBrowser(url.href, { signal }).then(result => { event('browser', result); if (['launcher_missing', 'spawn_error', 'nonzero_exit'].includes(result.code)) output.progress('The browser launcher did not complete. Open the link above manually.') })
      const answer = await listener.received
      if (answer.error) throw new CliError(answer.error === 'access_denied' ? 'auth_denied' : 'oauth_error', 'Sign-in was not approved. Nothing was saved. Run hirify login again when ready.')
      secrets.add(answer.code)
      const res = await form(endpoints.token_endpoint, { grant_type: 'authorization_code', client_id: client.client_id, code: answer.code, redirect_uri: listener.redirectUri, code_verifier: verifier })
      if (!res.ok) throw new CliError('oauth_exchange', 'The confirmation could not be exchanged. Run hirify login again.', { status: res.status })
      const session = remember(tokenResponse(res.body, { kind: 'oauth', issuer: config.api, client_id: client.client_id, token_endpoint: endpoints.token_endpoint, scope: endpoints.scopes }))
      aborted(signal)
      await store.commit(session, generation)
      return { signed_in: true, source: 'oauth', environment_override: Boolean(config.envKey) }
    } finally { clearInterval(reminder); await listener.close(); await launchTask }
  }
  return { access, retryToken, login, refresh, discover, status: () => {
    if (config.envKey) return { signed_in: true, source: 'environment', issuer: config.api }
    const state = store.read({ allowPending: true })
    return { signed_in: Boolean(state), source: state?.kind || 'none', issuer: state?.issuer || config.api, expires_at: state?.expires_at ?? null, renewal_uncertain: Boolean(state?.refresh_pending) }
  } }
}
