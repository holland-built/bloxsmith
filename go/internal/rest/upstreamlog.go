package rest

import (
	"log"
	"regexp"
)

// credentialRe matches the credential shapes that must never reach the server
// log: an Authorization header/value, a bearer or token credential, or an
// api_key/api-key/apikey assignment. Applied to the (already bounded) snippet
// before it is logged.
//
// It lived in internal/server until an Axur probe started failing with a 400
// whose body was the only thing that could explain it, and the dashboard had no
// way to log that body safely. It belongs here, beside UpstreamError, because
// that is what it describes.
var credentialRe = regexp.MustCompile(`(?i)(authorization\s*[:=]\s*"?[^",}\s]+"?|bearer\s+\S+|token\s+\S+|api[-_]?key["']?\s*[:=]\s*"?[^",}\s]+"?)`)

// RedactSnippet replaces any credential-shaped substring with [REDACTED]
// before a snippet is logged. Best-effort on top of the snippet already being
// size-bounded; it is not itself a security boundary.
func RedactSnippet(s string) string {
	return credentialRe.ReplaceAllString(s, "[REDACTED]")
}

// LogUpstreamError writes one structured line per upstream failure: path,
// status, category, whether the kept snippet was itself truncated, and the
// snippet with credentials redacted.
//
// The snippet is written with %q, NOT %s. A third party controls those bytes,
// and a body containing a newline could otherwise close this line and forge a
// second one — a log an operator reads to diagnose a failure is exactly the
// wrong place to accept someone else's line breaks. %q also makes control
// characters visible instead of letting them move the cursor around.
//
// The snippet is already bounded to snippetCap by getStrict; this never logs an
// unbounded body.
func LogUpstreamError(ue *UpstreamError) {
	if ue == nil {
		return
	}
	log.Printf("[upstream] path=%s status=%d category=%s truncated=%t snippet=%q",
		ue.Path, ue.Status, ue.Category, ue.Truncated, RedactSnippet(ue.Snippet))
}
