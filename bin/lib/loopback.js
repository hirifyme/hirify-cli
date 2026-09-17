import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { CliError, aborted } from './errors.js'

export async function startCallbackServer({ state, issuer, port = 0, signal, timeoutMs = 300000 }) {
  aborted(signal)
  let settle, reject, settled = false, closePromise
  const sockets = new Set()
  const received = new Promise((resolve, fail) => { settle = resolve; reject = fail })
  // The consumer may still be registering the public client when cancellation arrives.
  received.catch(() => {})
  let address
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const reply = (status, text, html = false) => {
      res.writeHead(status, { 'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer', Connection: 'close' })
      res.end(text)
    }
    let url
    try { url = new URL(req.url, address) } catch { return reply(400, 'Invalid request.') }
    if (req.method !== 'GET') return reply(405, 'Use GET.')
    if (!req.url.startsWith('/') || url.origin !== new URL(address).origin || req.headers.host !== new URL(address).host) return reply(400, 'Invalid callback address.')
    if (url.pathname !== '/callback') return reply(404, 'Not found.')
    const params = url.searchParams
    const value = params.get('state') || ''
    const validState = Buffer.byteLength(value) === Buffer.byteLength(state) && timingSafeEqual(Buffer.from(value), Buffer.from(state))
    const code = params.get('code'), error = params.get('error')
    if (settled || !validState || params.getAll('state').length !== 1 || params.getAll('code').length > 1 || params.getAll('error').length > 1 || Boolean(code) === Boolean(error) || (params.has('iss') && (params.getAll('iss').length !== 1 || params.get('iss') !== issuer))) return reply(400, 'This callback does not match the pending sign-in.')
    settled = true
    reply(200, '<!doctype html><html lang="en"><meta charset="utf-8"><title>Hirify</title><h1>Confirmation received</h1><p>Return to your terminal to see the sign-in result.</p></html>', true)
    settle({ code, error })
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.keepAliveTimeout = 1000
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.setTimeout(5000, () => socket.destroy()) })
  server.on('clientError', (_, socket) => socket.destroy())
  const listen = host => new Promise((resolve, fail) => {
    const error = e => { server.off('listening', ready); fail(e) }
    const ready = () => { server.off('error', error); resolve() }
    server.once('error', error); server.once('listening', ready); server.listen(port, host)
  })
  let host = '127.0.0.1'
  try { await listen(host) } catch (e) {
    if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(e.code)) throw new CliError('callback_bind_failed', 'Could not listen for the browser callback. Choose another --callback-port or use an API key.')
    host = '::1'
    try { await listen(host) } catch { throw new CliError('callback_bind_failed', 'No loopback address is available. Use HIRIFY_KEY instead.') }
  }
  address = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`
  const close = () => {
    if (closePromise) return closePromise
    clearTimeout(timer); signal?.removeEventListener('abort', cancel)
    closePromise = new Promise(resolve => {
      const force = setTimeout(() => { for (const socket of sockets) socket.destroy() }, 200)
      server.close(() => { clearTimeout(force); resolve() })
      server.closeIdleConnections?.()
    })
    return closePromise
  }
  const cancel = () => { if (!settled) { settled = true; reject(signal.reason || new CliError('cancelled', 'Sign-in was cancelled.', { exitCode: 130 })) }; void close() }
  const timer = setTimeout(() => { if (!settled) { settled = true; reject(new CliError('login_timeout', 'No matching browser confirmation arrived in time. Run hirify login again.')) }; void close() }, timeoutMs)
  server.on('error', () => { if (!settled) { settled = true; reject(new CliError('callback_error', 'The local callback server stopped. Run hirify login again.')) }; void close() })
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  return { redirectUri: `${address}/callback`, received, close }
}
