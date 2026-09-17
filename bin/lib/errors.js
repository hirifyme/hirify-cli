/** Errors carry a stable machine code; only the entrypoint decides how to exit. */
export class CliError extends Error {
  constructor(code, message, { exitCode = 1, status, retryable = false, requestId, action } = {}) {
    super(message)
    this.name = 'CliError'
    Object.assign(this, { code, exitCode, status, retryable, requestId, action })
  }
}
export function fail(message, exitCode = 1) { throw new CliError('command_failed', message, { exitCode }) }
export function aborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof CliError ? signal.reason : new CliError('cancelled', 'The command was cancelled.', { exitCode: 130 })
}
export function safeText(value) {
  return String(value).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}
export function redact(value, secrets = [], terminal = true) {
  let text = terminal ? safeText(value) : String(value)
  for (const secret of secrets) if (typeof secret === 'string' && secret.length) text = text.split(secret).join('[redacted]')
  return text.replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[redacted]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
}
