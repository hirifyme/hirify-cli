import { randomUUID } from 'node:crypto'
import { CliError } from './errors.js'
import { trustedURL } from './config.js'
import { requireJSON, retryDelay } from './http.js'
import { accessRestrictedMessage, actionRequiredMessage } from './messages.js'
const READS = new Set(['account.status', 'vacancies.search', 'feeds.list', 'feeds.vacancies', 'profiles.list', 'webhooks.list', 'filters.guide', 'hidden.list'])
const LISTS = new Set(['vacancies.search', 'feeds.list', 'feeds.vacancies', 'profiles.list', 'webhooks.list'])
const OBJECTS = new Set(['account.status', 'vacancies.read', 'vacancies.reveal', 'applications.apply', 'feeds.create', 'feeds.set_delivery', 'webhooks.create', 'feedback.send', 'filters.guide', 'hidden.list'])
const isObject = value => value && typeof value === 'object' && !Array.isArray(value)
const immutable = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value) }; return value }
export function validateManifest(doc, origin) {
  if (!isObject(doc) || !Number.isInteger(doc.schema_version) || doc.schema_version < 1) throw new CliError('manifest_invalid', 'Hirify sent a manifest without a supported version.')
  if (doc.schema_version > 1) throw new CliError('manifest_unsupported', 'this Hirify speaks a newer manifest than this CLI can read. Please update the CLI.', { exitCode: 2 })
  if (!Array.isArray(doc.capabilities)) throw new CliError('manifest_invalid', 'Hirify sent a manifest with no list of what it can do.')
  const ids = new Set()
  for (const cap of doc.capabilities) {
    if (!isObject(cap) || typeof cap.id !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(cap.id) || ids.has(cap.id) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(cap.method) || typeof cap.path !== 'string' || /[?#]/.test(cap.path)) throw new CliError('manifest_invalid', 'Hirify returned an invalid capability description.')
    ids.add(cap.id); trustedURL(cap.path, origin, { path: true })
    if (cap.inputs !== undefined && !isObject(cap.inputs)) throw new CliError('manifest_invalid', 'Hirify returned invalid input metadata.')
    // Schema v1 servers serialize an empty PHP map as []; nonempty lists are still invalid.
    const locations = cap.inputs?.locations
    const emptyLocations = Array.isArray(locations) && locations.length === 0
    if (locations !== undefined && !emptyLocations && (!isObject(locations) || Object.values(locations).some(where => !['path', 'query', 'body'].includes(where)))) throw new CliError('manifest_invalid', 'Hirify returned invalid input locations.')
    if (cap.inputs?.schema !== undefined && !isObject(cap.inputs.schema)) throw new CliError('manifest_invalid', 'Hirify returned an invalid input schema.')
  }
  return immutable(doc)
}
export function responseError(response, { key = false } = {}) {
  const { status, body, headers } = response
  const options = { status, requestId: headers.get('x-request-id') || headers.get('request-id') || undefined }
  if (status === 401) return new CliError('auth_required', key ? 'the key was not accepted (401). It may have been revoked, or copied incompletely.' : 'your sign-in is no longer valid. Please run hirify login --force.', options)
  if (status === 403 && body?.error?.code === 'access_restricted') return new CliError('access_restricted', accessRestrictedMessage(body), options)
  if (status === 409 && body?.error?.code === 'action_required') return new CliError('action_required', actionRequiredMessage(body), options)
  if (status === 403) return new CliError('access_denied', 'no access (403). This needs an active paid plan, or the sign-in is missing a permission.', options)
  if (status === 404) return new CliError('not_found', 'not found (404).', options)
  if (status === 429) {
    const action = body?.quota?.action
    const messages = {
      vacancy_opens: 'you have opened as many vacancies today as the daily allowance covers.\n        Feeds and search still work, and so does anything already read today.',
      contact_reveals: 'you have no reveals left right now. Reading still works.',
      apply: 'you have sent as many applications today as the daily allowance covers.\n        Reading and revealing still work. What is left: hirify account show',
    }
    const wait = Math.ceil(retryDelay(headers.get('retry-after')) / 1000)
    const message = messages[action] || (body?.quota ? `today's allowance for ${String(action ?? 'that action').replace(/_/g, ' ')} is used up.\n        What is left: hirify account show` : `too many requests in a short time.${wait ? ` Please try again in ${wait} seconds.` : ' Please try again in a minute.'}`)
    return new CliError(body?.quota ? 'quota_exhausted' : 'rate_limited', message, { ...options, retryable: !body?.quota })
  }
  return new CliError(status >= 500 ? 'server_error' : 'request_rejected', status >= 500 ? 'something went wrong on our side. Please try again in a minute.' : 'that command could not be completed. Please check it and try again.', options)
}
export function createApi({ config, http, auth, output }) {
  let discovery, manifest, lastError
  async function agentDiscovery() {
    if (!discovery) discovery = (async () => {
      const res = await http.request(`${config.api}/.well-known/hirify-agent`, { safe: true, timeout: 5000 })
      if (!res.ok) throw new CliError('discovery_unavailable', 'could not reach Hirify to load what it can do. Please check your connection and try again.', { status: res.status })
      const doc = requireJSON(res)
      if (!isObject(doc)) throw new CliError('discovery_invalid', 'Hirify returned invalid discovery metadata.')
      if (doc.manifest_url) trustedURL(doc.manifest_url, config.api)
      return doc
    })()
    return discovery
  }
  async function authenticated(url, options = {}) {
    // Validate even on retries; changing the configured server never retargets saved tokens.
    const target = trustedURL(url, config.api)
    const token = await auth.access()
    const send = value => http.request(target, { ...options, headers: { ...options.headers, Authorization: `Bearer ${value}` } })
    let res = await send(token)
    if (res.status === 401 && options.safe) {
      const replacement = await auth.retryToken(token)
      if (replacement) res = await send(replacement)
    }
    return res
  }
  async function loadManifest() {
    if (!manifest) manifest = (async () => {
      const doc = await agentDiscovery()
      if (!doc.manifest_url) throw new CliError('manifest_unavailable', 'could not reach Hirify to load what it can do. Please check your connection and try again.')
      const res = await authenticated(doc.manifest_url, { safe: true })
      if (!res.ok) { if (res.status === 401) throw responseError(res, { key: Boolean(config.envKey) }); throw new CliError('manifest_unavailable', 'could not load what Hirify can do right now. Please try again in a minute.', { status: res.status }) }
      return validateManifest(requireJSON(res), config.api)
    })()
    return manifest
  }
  async function resolveCapability(id) {
    const cap = (await loadManifest()).capabilities.find(c => c.id === id)
    if (!cap) throw new CliError('capability_unavailable', `this Hirify does not offer "${id}". It may be an older server, or the operation has moved.`)
    return cap
  }
  async function callCapability(id, { params = {}, query, payload = null, allow = [], raw = false } = {}) {
    const cap = await resolveCapability(id)
    const path = cap.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
      const value = params[name]
      if (value === undefined || value === null || typeof value === 'object') throw new CliError('invalid_arguments', `this call needs "${name}", and it was not given.`)
      return encodeURIComponent(String(value))
    })
    if (/[{}]/.test(path)) throw new CliError('manifest_invalid', 'Hirify returned an invalid path template.')
    let target = trustedURL(path, config.api, { path: true })
    if (query?.toString()) target += `?${query}`
    const safe = cap.method === 'GET' && READS.has(id) && (!cap.meter || cap.meter === 'none')
    const mutation = !['GET', 'HEAD'].includes(cap.method)
    let replayKey
    if (mutation && cap.retry_policy === 'caller_keyed' && cap.inputs?.locations?.idempotency_key === 'body') {
      replayKey = payload?.idempotency_key || randomUUID()
      payload = { ...(payload || {}), idempotency_key: replayKey }
      if (typeof replayKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(replayKey)) throw new CliError('invalid_arguments', 'Use an idempotency key of 1 to 128 letters, digits, dots, underscores, colons or hyphens.')
      output?.progress(`Request reference: ${replayKey}. Keep this value if the same request needs to be repeated.`)
    }
    let res
    try { res = await authenticated(target, { method: cap.method, safe, body: payload === null ? undefined : JSON.stringify(payload), headers: payload === null ? {} : { 'Content-Type': 'application/json' } }) }
    catch (error) {
      if (mutation && ['network_error', 'network_timeout', 'response_incomplete', 'response_too_large', 'command_timeout'].includes(error.code)) throw new CliError('outcome_unknown', 'No confirmation was received. The action may have completed. Check its result before trying again.')
      if (mutation && error.code === 'cancelled') error.message += ' The action may have completed; check its result before retrying.'
      throw error
    }
    if (res.ok) {
      requireJSON(res, { mutation })
      const expected = allow.filter(code => code >= 200 && code < 300)
      if (!expected.length && (LISTS.has(id) || (OBJECTS.has(id) && cap.method === 'GET'))) expected.push(200)
      const invalid = res.body.ok === false || (expected.length && !expected.includes(res.status)) || (LISTS.has(id) && !Array.isArray(res.body.data)) || (OBJECTS.has(id) && !isObject(res.body.data)) || (id === 'applications.apply' && !res.body.data?.application_id) || (['feeds.create', 'feeds.set_delivery'].includes(id) && !(res.body.data?.id ?? res.body.data?.feed_id)) || (id === 'webhooks.create' && !(res.body.data?.id ?? res.body.data?.endpoint_id)) || (id === 'feedback.send' && !(res.body.data?.reference || res.body.data?.ticket))
      if (invalid) throw new CliError(mutation ? 'outcome_unknown' : 'protocol_error', mutation ? 'The server did not return a valid confirmation. Check the result before trying again.' : 'The server response did not match this operation.', { status: res.status })
    }
    lastError = res.ok ? null : mutation && res.status >= 500 ? new CliError('outcome_unknown', 'The server did not confirm the result. The action may have completed; check before retrying.', { status: res.status }) : responseError(res, { key: Boolean(config.envKey) })
    if (raw) return { ...res, error: lastError }
    if ([403, 409].includes(res.status) && ['access_restricted', 'action_required'].includes(res.body?.error?.code)) throw responseError(res)
    if (allow.includes(res.status)) return { status: res.status, body: res.body, retryAfter: res.headers.get('retry-after'), error: res.ok ? null : responseError(res) }
    if (!res.ok) throw lastError
    return res.body
  }
  return { agentDiscovery, loadManifest, resolveCapability, callCapability, get lastError() { return lastError } }
}
