import { mkdirSync, lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import lockfile from 'proper-lockfile'
import { CliError, aborted } from './errors.js'
import { DEFAULT_API, serverURL } from './config.js'
import { delay } from './http.js'

function stat(path) { try { return lstatSync(path) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
function check(path, directory = false) {
  const s = stat(path)
  if (!s) return null
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw new CliError('unsafe_storage', 'The credential location must be a regular file in a private directory, not a link.')
  if (process.platform !== 'win32' && s.uid !== process.getuid()) throw new CliError('unsafe_storage', 'The credential location belongs to another user.')
  return s
}
export function makePrivate(path, directory = false) {
  check(path, directory)
  if (process.platform !== 'win32') { chmodSync(path, directory ? 0o700 : 0o600); return }
  // Set an exact DACL for the current SID; POSIX mode bits do not secure Windows files.
  const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $p=$env:HIRIFY_SECURE_PATH; $d=(Get-Item -LiteralPath $p -Force).PSIsContainer; if($d){$acl=New-Object System.Security.AccessControl.DirectorySecurity; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}else{$acl=New-Object System.Security.AccessControl.FileSecurity; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')}; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, HIRIFY_SECURE_PATH: path }, stdio: 'ignore', timeout: 10000, windowsHide: true })
}
export function createStore(config, { signal } = {}) {
  const file = join(config.dir, 'auth.json')
  const legacy = join(config.dir, 'key')
  let compromised = false
  function ensure() {
    try { mkdirSync(config.dir, { recursive: true, mode: 0o700 }); makePrivate(config.dir, true) }
    catch (e) { if (e instanceof CliError) throw e; throw new CliError('storage_unavailable', 'Could not create a private credential directory. Check its permissions.') }
  }
  function readRaw() {
    try {
      const stateStat = check(file)
      if (stateStat) {
        const raw = readFileSync(file, 'utf8')
        let state
        try { state = JSON.parse(raw) } catch { throw new CliError('state_corrupt', 'The saved sign-in is damaged. Run hirify login --force to replace it, or hirify logout to remove it.') }
        if (!state || typeof state !== 'object' || Array.isArray(state) || (state.schema_version !== undefined && state.schema_version !== 1)) throw new CliError('state_unsupported', 'The saved sign-in format is not supported by this version.')
        if (state.kind !== 'signed-out' && (!['key', 'oauth'].includes(state.kind) || typeof state.access_token !== 'string' || !state.access_token.trim())) throw new CliError('state_corrupt', 'The saved sign-in is incomplete. Run hirify login --force.')
        if (state.kind === 'oauth' && ((state.expires_at !== null && state.expires_at !== undefined && (!Number.isFinite(state.expires_at) || state.expires_at < 0)) || (state.refresh_token != null && typeof state.refresh_token !== 'string') || typeof state.client_id !== 'string')) throw new CliError('state_corrupt', 'The saved sign-in is incomplete. Run hirify login --force.')
        return { ...state, generation: state.generation || `legacy:${createHash('sha256').update(raw).digest('hex')}` }
      }
      if (check(legacy)) {
        const key = readFileSync(legacy, 'utf8').trim()
        if (key) return { kind: 'key', issuer: DEFAULT_API, access_token: key, generation: `legacy:${createHash('sha256').update(key).digest('hex')}` }
      }
      return { kind: 'signed-out', generation: 'absent' }
    } catch (e) { if (e instanceof CliError) throw e; throw new CliError('storage_unreadable', 'Could not read the saved sign-in. Check the credential directory permissions.') }
  }
  function read({ allowPending = false } = {}) {
    const state = readRaw()
    if (state.kind === 'signed-out') return null
    const issuer = state.issuer || DEFAULT_API
    if (serverURL(issuer) !== config.api) throw new CliError('issuer_mismatch', 'This sign-in belongs to another server. Use an explicit HIRIFY_KEY or sign in to the selected server with hirify login --force.')
    if (state.refresh_pending && !allowPending) throw new CliError('refresh_uncertain', 'The previous token renewal did not finish safely. Run hirify login --force before continuing.')
    return { ...state, issuer }
  }
  async function write(state) {
    if (compromised) throw new CliError('storage_lock_lost', 'The sign-in lock was lost. No credentials were committed.')
    ensure(); check(file)
    const temp = join(config.dir, `.auth-${randomUUID()}.tmp`)
    let fd
    try {
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify({ ...state, schema_version: 1 }, null, 2) + '\n')
      fsyncSync(fd); closeSync(fd); fd = undefined
      if (process.platform === 'win32') makePrivate(temp)
      for (let attempt = 0; ; attempt++) {
        try { renameSync(temp, file); break }
        catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error; await delay(50 * (attempt + 1), signal) }
      }
      if (process.platform !== 'win32') { const dir = openSync(config.dir, 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } }
      if (check(legacy)) unlinkSync(legacy)
    } catch (e) { if (e instanceof CliError) throw e; throw new CliError('storage_write_failed', 'Could not save the sign-in safely. Check disk space and directory permissions. You may need to sign in again.') }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp) } catch {} }
  }
  async function locked(fn) {
    ensure(); aborted(signal)
    const lockPath = join(config.dir, '.session.lock')
    let release
    compromised = false
    while (!release) {
      aborted(signal)
      try { release = await lockfile.lock(file, { realpath: false, lockfilePath: lockPath, stale: 120000, update: 10000, onCompromised: () => { compromised = true } }) }
      catch (e) { if (e.code !== 'ELOCKED') throw new CliError('storage_lock_failed', 'Could not lock the saved sign-in. Check directory permissions.'); await delay(40 + Math.random() * 80, signal) }
    }
    try { aborted(signal); return await fn() } finally { await release().catch(() => {}) }
  }
  async function commit(state, expected) {
    return locked(async () => {
      const current = readRaw()
      if (expected !== undefined && current.generation !== expected) throw new CliError('session_changed', 'The saved sign-in changed while this command was running. No older credentials were restored.')
      const next = { ...state, issuer: config.api, generation: randomUUID(), refresh_pending: false }
      await write(next); return next
    })
  }
  async function logout() {
    return locked(async () => {
      let had = true
      try { had = readRaw().kind !== 'signed-out' } catch (e) { if (!['state_corrupt', 'state_unsupported'].includes(e.code)) throw e }
      await write({ kind: 'signed-out', generation: randomUUID() }); return had
    })
  }
  async function beginLogin({ force = false } = {}) {
    return locked(async () => {
      let state
      try { state = readRaw() } catch (e) { if (!force || !['state_corrupt', 'state_unsupported'].includes(e.code)) throw e; await write({ kind: 'signed-out', generation: randomUUID() }); state = readRaw() }
      return state.generation
    })
  }
  function secure() { ensure(); for (const path of [file, legacy]) if (check(path)) makePrivate(path) }
  return { file, read, readRaw, write, locked, commit, logout, beginLogin, secure }
}
