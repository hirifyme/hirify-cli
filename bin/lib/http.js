import http from 'node:http'
import https from 'node:https'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import proxyEnv from 'proxy-from-env'
import { CliError, aborted } from './errors.js'

export function retryDelay(value, now = Date.now()) {
  if (!value) return 0
  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0
}
export function delay(ms, signal) {
  aborted(signal)
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve() }
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(signal.reason) }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
export function createHttp({ signal, version, event = () => {}, timeoutMs = 30000, limit = 8 * 1024 * 1024 }) {
  const active = new Set()
  async function once(input, { method = 'GET', headers = {}, body, timeout = timeoutMs, maxBytes = limit } = {}) {
    aborted(signal)
    const url = new URL(input)
    const started = Date.now()
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new CliError('untrusted_url', 'Unsupported request address.')
    let agent
    const proxy = proxyEnv.getProxyForUrl(url.href)
    if (proxy) {
      let p
      try { p = new URL(proxy) } catch { throw new CliError('proxy_config', 'The proxy address is invalid.') }
      if (!['http:', 'https:'].includes(p.protocol)) throw new CliError('proxy_config', 'Use an HTTP or HTTPS proxy.')
      agent = url.protocol === 'https:' ? new HttpsProxyAgent(p, { rejectUnauthorized: true }) : new HttpProxyAgent(p, { rejectUnauthorized: true })
    }
    return new Promise((resolve, reject) => {
      let settled = false
      let req
      const finish = (error, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        if (req) active.delete(req)
        agent?.destroy()
        event('http', { code: error?.code || 'response', status: result?.status, duration_ms: Date.now() - started })
        if (error) reject(error); else resolve(result)
      }
      const cancel = () => { req?.destroy(); finish(signal.reason || new CliError('cancelled', 'The command was cancelled.', { exitCode: 130 })) }
      const timer = setTimeout(() => { req?.destroy(); finish(new CliError('network_timeout', 'The server did not answer in time.', { retryable: method === 'GET' })) }, timeout)
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        req = (url.protocol === 'https:' ? https : http).request(url, {
          method, agent, rejectUnauthorized: true,
          headers: { Accept: 'application/json', 'User-Agent': `hirify-cli/${version}`, 'Accept-Encoding': 'identity', ...headers },
        }, res => {
          const chunks = []; let size = 0
          res.on('data', chunk => {
            size += chunk.length
            if (size > maxBytes) { req.destroy(); finish(new CliError('response_too_large', 'The server response exceeded the supported size.')) }
            else chunks.push(chunk)
          })
          res.on('error', () => finish(new CliError('response_incomplete', 'The connection ended before the response was complete.')))
          res.on('end', () => {
            const status = res.statusCode
            const headers = new Headers()
            for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
            if (status >= 300 && status < 400) return finish(new CliError('redirect_refused', 'The server redirected this request. No credentials were forwarded.', { status }))
            const text = Buffer.concat(chunks).toString('utf8')
            let body = null
            try { body = JSON.parse(text) } catch {}
            finish(null, { status, ok: status >= 200 && status < 300, headers, text, body })
          })
        })
        active.add(req)
        req.on('error', error => {
          const c = error.code || error.cause?.code
          const code = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(c || '') ? 'tls_error' : proxy ? 'proxy_error' : c === 'ENOTFOUND' || c === 'EAI_AGAIN' ? 'dns_error' : 'network_error'
          finish(new CliError(code, code === 'tls_error' ? 'The TLS certificate could not be verified. Check your trusted CA configuration.' : 'Could not reach the server. Check your connection and proxy settings.', { retryable: method === 'GET' }))
        })
        if (signal?.aborted) return cancel()
        req.end(body)
      } catch { finish(new CliError('network_error', 'Could not start the request. Check your server and proxy settings.')) }
    })
  }
  async function request(url, options = {}) {
    const attempts = options.safe ? 3 : 1
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await once(url, options)
        if (i + 1 < attempts && [429, 502, 503, 504].includes(res.status)) {
          const wait = retryDelay(res.headers.get('retry-after')) || (100 * 2 ** i + Math.random() * 100)
          if (wait <= 2000) { await delay(wait, signal); continue }
        }
        return res
      } catch (error) {
        if (i + 1 >= attempts || !['network_error', 'dns_error'].includes(error.code)) throw error
        await delay(100 * 2 ** i + Math.random() * 100, signal)
      }
    }
  }
  return { request, close: () => { for (const req of active) req.destroy(); active.clear() } }
}
export function requireJSON(response, { mutation = false } = {}) {
  const type = response.headers.get('content-type') || ''
  if (!/\b(?:application\/json|application\/[\w.+-]+\+json)\b/i.test(type) || response.body === null || typeof response.body !== 'object') {
    throw new CliError(mutation ? 'outcome_unknown' : 'protocol_error', mutation
      ? 'The server did not return a readable confirmation. The action may have completed. Check its result before trying again.'
      : 'The server returned an unreadable response.', { status: response.status })
  }
  return response.body
}
