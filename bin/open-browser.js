/**
 * Getting the person into a browser.
 *
 * The command that opens a URL is different on every operating system, and on Windows it
 * is not a program at all but a built-in of the command interpreter, so the address
 * travels through a command line and any mistake in quoting it silently drops half the
 * sign-in parameters. Two attempts at writing that command by hand failed on real
 * machines, so the job belongs to `open`, which reaches the Windows browser through
 * PowerShell with the whole command base64-encoded: there is no command line left for
 * anything to misread.
 *
 * Whether a browser window actually appeared is not something this can know, which is why
 * the sign-in link is printed either way and nothing here promises a window.
 */
import open from 'open'

/**
 * Whether asking for a browser makes sense at all. A machine reached over SSH, a Linux
 * session with no display, and output that is not a terminal all have nobody sitting in
 * front of a browser window; trying anyway spends the person's time and tells them
 * nothing. In those places the link is the sign-in, so it is offered as the first step
 * rather than as a fallback.
 */
export function canOpenBrowser({
  env = process.env,
  platform = process.platform,
  isTTY = Boolean(process.stdout.isTTY),
} = {}) {
  if (!isTTY) return false
  if (env.SSH_CONNECTION || env.SSH_TTY) return false
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false
  return true
}

/**
 * Ask the operating system for a browser. False means the launcher itself refused or never
 * started, which is worth telling the person about, because then the link is their only way
 * in. True means it started and reported nothing wrong, which is as close to "the browser
 * opened" as anything here can get.
 *
 * A launcher still running after a few seconds counts as success: on some systems the
 * command that opens the address is the browser itself and only exits when the browser does.
 */
export async function openBrowser(url, { waitMs = 3000 } = {}) {
  let child
  try {
    child = await open(url)
  } catch {
    return false
  }

  return new Promise((resolve) => {
    const settle = (opened) => { clearTimeout(timer); resolve(opened) }
    const timer = setTimeout(() => settle(true), waitMs)
    child.once('error', () => settle(false))
    child.once('exit', (code) => settle(code === 0))
  })
}
