export function serverMessage(body) {
  const firstLine = (value) => {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (Array.isArray(value)) {
      for (const item of value) {
        const line = firstLine(item)
        if (line) return line
      }
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) {
        const line = firstLine(item)
        if (line) return line
      }
    }
    return null
  }

  return firstLine(body?.error?.details) || firstLine(body?.error?.message) || firstLine(body?.message)
}

/**
 * The one-line report for a policy restriction: a canonical 403 that names itself
 * `access_restricted`. It is kept apart from the quota and rate-limit walls on purpose,
 * because those clear on their own and this one does not. The CLI states what the server
 * sent - the message it wrote, when the restriction lifts, where to ask for a review - and
 * adds no rule of its own about why it was applied.
 */
export function accessRestrictedMessage(body) {
  const err = (body && typeof body.error === 'object' && body.error) || {}
  const line = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const parts = [line(err.message) || line(body?.message) || 'access on this account is restricted (403).']
  const until = line(err.restricted_until)
  if (until) parts.push(`It stays in place until ${until}.`)
  const appeal = line(err.appeal_url)
  if (appeal) parts.push(`To ask us to look at it again: ${appeal}`)
  return parts.join('\n        ')
}

/**
 * The report for a blocking notice: a canonical 409 that names itself `action_required`.
 * Unlike a `meta.notice` on a success, this one stands in place of the answer - the server is
 * holding the result until the person confirms - so the CLI shows the text the server wrote and
 * the one command that clears it, and reads nothing into the policy behind it. That command is
 * the acknowledgement capability the server lists in its manifest, reached the same way as any
 * other, so no route to it is written here. It carries the notice's own id and its first
 * advertised action, both as the server sent them, so the printed line runs as it stands.
 */
export function actionRequiredMessage(body) {
  const notice = (body && typeof body.error === 'object' && body.error && typeof body.error.notice === 'object' && body.error.notice) || {}
  const line = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const parts = [line(notice.message) || 'this needs your confirmation before it can go ahead (409).']

  const id = line(notice.id)
  const action = Array.isArray(notice.actions) ? notice.actions.map(line).find(Boolean) : null
  const call = 'hirify api call security.notices.ack'
  parts.push(id && action
    ? `To continue, save this JSON to a file and run ${call} --data-file <file>:\n${JSON.stringify({ id, action })}`
    : `To continue, acknowledge this notice: ${call}`)
  return parts.join('\n        ')
}

