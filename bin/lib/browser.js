import { spawn } from 'node:child_process'
export function environment({ env = process.env, platform = process.platform, isTTY = Boolean(process.stdout.isTTY) } = {}) {
  const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY)
  const wsl = platform === 'linux' && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP)
  const gui = platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || wsl)
  return { remote, wsl, interactive: isTTY, gui, canOpen: isTTY && !remote && gui }
}
export const canOpenBrowser = options => environment(options).canOpen
/** A launcher acknowledgement is not proof that a browser window appeared. */
export async function openBrowser(url, { waitMs = 1500, env = process.env, signal, launch } = {}) {
  if (signal?.aborted) return { code: 'cancelled' }
  let parsed
  try { parsed = new URL(url) } catch { return { code: 'invalid_url' } }
  if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)))) return { code: 'invalid_url' }
  let child
  try {
    if (launch) child = await launch(url)
    else if (env.BROWSER) child = spawn(env.BROWSER, [url], { stdio: 'ignore', detached: true, windowsHide: true })
    else { const { default: open } = await import('open'); child = await open(url) }
  } catch { return { code: 'spawn_error' } }
  return new Promise(resolve => {
    let done = false
    const finish = result => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); child.off('error', error); child.on('error', () => {}); child.off('exit', exit); child.unref?.(); resolve(result) }
    // Never terminate the user's browser on cancellation; only release our observation.
    const cancel = () => finish({ code: 'cancelled' })
    const error = e => finish({ code: e.code === 'ENOENT' ? 'launcher_missing' : 'spawn_error' })
    const exit = code => finish({ code: code === 0 ? 'launcher_exited' : 'nonzero_exit' })
    const timer = setTimeout(() => finish({ code: 'launcher_unconfirmed' }), waitMs)
    child.once('error', error); child.once('exit', exit)
    signal?.addEventListener('abort', cancel, { once: true })
    if (child.exitCode !== null && child.exitCode !== undefined) exit(child.exitCode)
    else if (signal?.aborted) cancel()
  })
}
