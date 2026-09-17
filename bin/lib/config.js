import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CliError } from './errors.js'
export const DEFAULT_API = 'https://api.hirify.me'
export function serverURL(input) {
  let url
  try { url = new URL(input) } catch { throw new CliError('invalid_url', 'The server address is not a valid URL.') }
  if (url.username || url.password || url.hash || url.search) throw new CliError('invalid_url', 'The server address must not contain credentials, a query, or a fragment.')
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new CliError('insecure_url', 'Use an HTTPS server address. HTTP is supported only for local loopback servers.')
  if (url.pathname !== '/') throw new CliError('invalid_url', 'HIRIFY_API must be an origin without a path.')
  return url.origin
}
export function resolveConfig(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  if (!isAbsolute(base)) throw new CliError('config_path', 'XDG_CONFIG_HOME must be an absolute path.')
  const api = serverURL(env.HIRIFY_API || DEFAULT_API)
  return { api, dir: join(base, 'hirify'), envKey: env.HIRIFY_KEY || '', env, version: null }
}
export function trustedURL(input, origin, { path = false } = {}) {
  if (typeof input !== 'string' || !input || /[\s\\]/.test(input)) throw new CliError('untrusted_url', 'Hirify returned an invalid address.')
  if (path && (!input.startsWith('/') || input.startsWith('//'))) throw new CliError('untrusted_url', 'Hirify returned an invalid operation path.')
  let url
  try { url = new URL(input, origin) } catch { throw new CliError('untrusted_url', 'Hirify returned an invalid address.') }
  if (url.origin !== origin || url.username || url.password || url.hash) throw new CliError('untrusted_url', 'Hirify returned an address outside the selected server. No credentials were sent there.')
  return url.href
}
