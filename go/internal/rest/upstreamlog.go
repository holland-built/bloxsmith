package rest

import (
	"encoding/json"
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

// --- the allowlisted upstream message ---------------------------------------
//
// Moved here from internal/server so the dashboard's Axur panel can use the
// same rule. It is the ONLY sanctioned way an upstream's own wording reaches a
// user-facing surface: recognised keys only, bounded length, and a hard refusal
// to fall back to the raw body when nothing matches.

// upstreamMsgKeys are the only upstream error-body fields ever surfaced to a
// client. This IS the security boundary: allowlisting specific fields, never
// regex-scrubbing and forwarding arbitrary upstream text.
var upstreamMsgKeys = []string{"error", "message", "detail"}

// upstreamArrayKeys are the top-level keys whose value, when a JSON array, is
// treated as a list of error objects (CSP's actual shape for a bad filter:
// {"error":[{"message":"Unknown field: subnet"}]}). Only the first element is
// consulted.
var upstreamArrayKeys = []string{"error", "errors"}

// upstreamArrayElemKeys is the field-priority used inside an array element:
// message first (CSP's actual field for this shape), then error, then detail.
var upstreamArrayElemKeys = []string{"message", "error", "detail"}

// upstreamMsgMaxLen bounds the extracted message before it reaches a client.
const upstreamMsgMaxLen = 200

// stringField returns the first of keys present in m with a non-empty string
// value. A non-string value (nested object, number, etc.) is not a match —
// only a plain string is ever considered "recognised".
func stringField(m map[string]any, keys []string) (string, bool) {
	for _, k := range keys {
		if s, ok := m[k].(string); ok && s != "" {
			return s, true
		}
	}
	return "", false
}

// truncateRunes bounds s to at most n runes (not bytes), so a multi-byte
// character is never split.
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// UpstreamMessage pulls an allowlisted, human-readable message out of
// an upstream JSON error body (a bounded rest.UpstreamError.Snippet). It tries
// error/message/detail at the top level, then one level down inside a nested
// "status" or "error" object (CSP sometimes wraps its real message there,
// e.g. {"status":{"message":"..."}}), then — CSP's actual shape for a bad
// filter — an "error"/"errors" key whose value is an ARRAY of objects, e.g.
// {"error":[{"message":"Unknown field: subnet"}]}: only the first element is
// consulted, and only if it is itself an object. Anything else — unparsable
// JSON, a non-object body, an array whose first element isn't an object, none
// of the recognised keys — is reported as not found, and the caller must omit
// the field entirely rather than fall back to dumping the raw snippet. The
// returned message is truncated to upstreamMsgMaxLen characters.
func UpstreamMessage(snippet string) (string, bool) {
	var parsed any
	if err := json.Unmarshal([]byte(snippet), &parsed); err != nil {
		return "", false
	}
	m, ok := parsed.(map[string]any)
	if !ok {
		return "", false
	}
	if msg, found := stringField(m, upstreamMsgKeys); found {
		return truncateRunes(msg, upstreamMsgMaxLen), true
	}
	for _, container := range []string{"status", "error"} {
		nested, ok := m[container].(map[string]any)
		if !ok {
			continue
		}
		if msg, found := stringField(nested, upstreamMsgKeys); found {
			return truncateRunes(msg, upstreamMsgMaxLen), true
		}
	}
	for _, arrKey := range upstreamArrayKeys {
		arr, ok := m[arrKey].([]any)
		if !ok || len(arr) == 0 {
			continue
		}
		first, ok := arr[0].(map[string]any)
		if !ok {
			continue
		}
		if msg, found := stringField(first, upstreamArrayElemKeys); found {
			return truncateRunes(msg, upstreamMsgMaxLen), true
		}
	}
	return "", false
}
