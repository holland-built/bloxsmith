// Kept out of api.js, which every page downloads: only pages that write need it.
import { failureText, isNoPermission } from './api.js'

// A write was sent and no clear answer came back, so it may have landed.
// go/internal/edit OutcomeUnknown holds the same sentence.
export const WRITE_UNKNOWN = 'Bloxsmith did not get an answer, so this may or may not have happened. Refresh and check before trying again.'
export const WRITE_NO_PERMISSION = "You don't have permission to do this. Nothing was changed."
// The server's generic write errors for a missing answer. Any other message on
// a 502 is specific, such as a read that failed before anything was sent.
const NO_ANSWER_ERROR = /^(?:create|update|allocation|delete) failed \((?:could not reach the tenant|status 50[24]\))/

/**
 * A failed real write in words. `data` is the parsed reply, or null when it
 * could not be read. A clear refusal keeps its message; no clear answer is
 * WRITE_UNKNOWN, because the change may have happened.
 */
export function writeFailureText(status, data, what) {
  const said = typeof data?.error === 'string' ? data.error : ''
  const unreadable = status >= 200 && status < 300 && data == null
  const gateway = (status === 502 || status === 504) && (!said || NO_ANSWER_ERROR.test(said))
  if (status === 0 || unreadable || gateway) return WRITE_UNKNOWN
  if (!said && isNoPermission({ status })) return WRITE_NO_PERMISSION
  return said || failureText(status, what)
}
