// Kept out of api.js, which every page downloads: only pages that write need it.
import { failureText, isNoPermission } from './api.js'

// A write was sent and no clear answer came back, so it may have landed.
// go/internal/edit OutcomeUnknown holds the same sentence.
export const WRITE_UNKNOWN = 'Bloxsmith did not get an answer, so this may or may not have happened. Refresh and check before trying again.'
export const WRITE_NO_PERMISSION = "You don't have permission to do this. Nothing was changed."
// A 5xx does not say whether a write landed, so its message is kept only when
// the server knows: a read that failed before anything was sent, a refusal
// passed on, or a sentence naming the part that did happen. Anything else, new
// messages included, reads as unknown.
const KNOWN_5XX = /nothing was sent|so it was not made|^could not (?:read|list|check)\b|^Couldn't read|^subnet lookup failed|^no free subnet|could not be read$|^record not found|will not save over it|Infoblox refused the call|MAY EXIST|may already have applied|\bbut\b|address\(es\) released|not confirmed as removed|^Bloxsmith could not save what Remove did|\blocked\b|^\d+ item\(s\) /
const GENERIC_REFUSAL = /^(?:create|update|allocation|delete) failed \(status 40[13]\)/

/**
 * A failed real write in words. `data` is the parsed reply, or null when it
 * could not be read. A clear refusal keeps its message; no clear answer is
 * WRITE_UNKNOWN, because the change may have happened.
 */
export function writeFailureText(status, data, what) {
  const said = typeof data?.error === 'string' ? data.error : ''
  // The server says outright that it was refused or never sent.
  if (said && (data.refused === true || data.outcome === 'refused' || data.outcome === 'not-sent')) return said
  const unreadable = status >= 200 && status < 300 && data == null
  if (status === 0 || unreadable || (status >= 500 && !KNOWN_5XX.test(said))) return WRITE_UNKNOWN
  if ((!said || GENERIC_REFUSAL.test(said)) && isNoPermission({ status })) return WRITE_NO_PERMISSION
  return said || failureText(status, what)
}
