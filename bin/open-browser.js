/**
 * Commands that ask the operating system to open a URL in the default browser.
 *
 * Windows must not receive the URL through cmd.exe: `&` is command syntax there, so an
 * OAuth URL would be cut off after its first query parameter. Explorer receives the URL
 * as one process argument and leaves every parameter intact.
 */
export function browserCandidates(url, platform = process.platform, browser = process.env.BROWSER) {
  if (browser) return [[browser, [url]]]
  if (platform === 'darwin') return [['open', [url]]]
  if (platform === 'win32') return [['explorer.exe', [url]]]
  return [['xdg-open', [url]], ['gio', ['open', url]], ['sensible-browser', [url]], ['x-www-browser', [url]]]
}
