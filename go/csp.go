package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io/fs"
	"log"
	"strings"
)

// cspPolicy builds the Content-Security-Policy header value, ONCE, at startup.
// It exists so script-src can name the exact inline scripts the shipped
// index.html contains instead of blanket-allowing every inline script on the
// page with 'unsafe-inline' — under which an injected <script> is
// indistinguishable from the app's own and runs.
//
// THE HASH IS COMPUTED FROM THE SERVED index.html AT BOOT, NOT HARDCODED, and
// that is the point of doing it this way. A constant in the source is a
// constant someone has to remember to update: the next `npm run build` would
// change one byte of the theme bootstrap, the hash would stop matching, and the
// page would silently load with the wrong theme until someone noticed. Read at
// boot, a UI rebuild self-corrects with zero Go changes.
//
// Failure is fatal, deliberately. The tempting fallback — no inline script
// found, so emit 'unsafe-inline' and keep serving — would mean this protection
// quietly evaporates on some future UI change with nothing anywhere saying so.
// Refusing to start is loud, happens on the developer's machine, and is the
// only failure mode here worth having.
func cspPolicy() string {
	// Read through uiFS, the same filesystem staticHandler serves from, rather
	// than webFS directly: under scripts/dev-serve.sh WEB_DIR points at go/web
	// and the UI is rebuilt into it WITHOUT recompiling the binary, so the
	// embedded copy is stale by design. Hashing the stale one would break the
	// theme bootstrap in precisely the place a developer is looking at it.
	index, err := fs.ReadFile(uiFS(), "index.html")
	if err != nil {
		log.Fatalf("csp: cannot read the UI's index.html to hash its inline scripts: %v", err)
	}
	policy, err := cspPolicyFrom(index)
	if err != nil {
		log.Fatalf("csp: %v", err)
	}
	return policy
}

// cspPolicyFrom is the pure half of cspPolicy: html in, policy string out, an
// error instead of log.Fatal. Split out so the extraction and the failure path
// are both testable without a test being able to kill the test binary.
//
// style-src keeps 'unsafe-inline' and that is not an oversight. React writes
// component style props as inline style="" attributes, which style-src governs;
// there is no bounded set of them to hash and no way to enumerate them from a
// built file. script-src never needed 'unsafe-inline' for that — the two
// directives were relaxed together, and only one of them had a reason.
func cspPolicyFrom(index []byte) (string, error) {
	hashes, err := inlineScriptHashes(index)
	if err != nil {
		return "", err
	}
	return "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; " +
		"script-src 'self' " + strings.Join(hashes, " ") + "; " +
		"style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data:; font-src 'self' data:", nil
}

// inlineScriptHashes returns a CSP source expression — 'sha256-<base64>' — for
// every inline <script> in html, in document order. Scripts carrying a src are
// skipped: those are external, and 'self' already covers them.
//
// The digest covers EXACTLY the bytes between the opening tag's '>' and the
// '<' of </script>, with nothing trimmed. That is what a browser hashes, and
// getting it wrong by one byte of leading whitespace does not error anywhere —
// the browser simply refuses the script, so the page renders with the default
// theme and flashes on every load. Hence no TrimSpace here, ever.
//
// Returning an error on zero inline scripts is intentional rather than
// returning an empty list: an index.html with no inline script is a UI that has
// changed shape underneath this code, and the caller's answer to that is to
// refuse to start rather than to emit a script-src whose contents nobody
// checked.
func inlineScriptHashes(html []byte) ([]string, error) {
	var hashes []string
	rest := html
	for {
		start := indexScriptTag(rest)
		if start < 0 {
			break
		}
		rest = rest[start:]
		gt := bytes.IndexByte(rest, '>')
		if gt < 0 {
			return nil, fmt.Errorf("index.html: a <script tag never closes its '>'")
		}
		attrs := rest[len("<script"):gt]
		body := rest[gt+1:]
		end := indexFold(body, []byte("</script"))
		if end < 0 {
			return nil, fmt.Errorf("index.html: a <script> has no matching </script>")
		}
		if content := body[:end]; len(content) > 0 && !hasSrcAttr(attrs) {
			sum := sha256.Sum256(content)
			hashes = append(hashes, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
		}
		rest = body[end:]
	}
	if len(hashes) == 0 {
		return nil, fmt.Errorf("index.html: no inline <script> found, so script-src would have nothing to allow " +
			"— the UI's shape changed and this policy needs rechecking, not weakening")
	}
	return hashes, nil
}

// indexScriptTag finds the next "<script" that actually opens a script element,
// i.e. one followed by a tag-name delimiter. Without that check "<scripting"
// would be treated as a tag and the parse would run off into the document.
func indexScriptTag(b []byte) int {
	off := 0
	for {
		i := indexFold(b[off:], []byte("<script"))
		if i < 0 {
			return -1
		}
		i += off
		next := i + len("<script")
		if next >= len(b) {
			return -1
		}
		if c := b[next]; c == '>' || c == '/' || isSpaceByte(c) {
			return i
		}
		off = next
	}
}

// hasSrcAttr reports whether the opening tag's attribute text carries a src=
// attribute. It requires a whitespace boundary before the name and an '=' after
// it so that crossorigin, nosrc or a data-src= do not read as one.
func hasSrcAttr(attrs []byte) bool {
	for i := 0; i+3 <= len(attrs); i++ {
		if !equalFold(attrs[i:i+3], []byte("src")) {
			continue
		}
		if i > 0 && !isSpaceByte(attrs[i-1]) {
			continue
		}
		j := i + 3
		for j < len(attrs) && isSpaceByte(attrs[j]) {
			j++
		}
		if j < len(attrs) && attrs[j] == '=' {
			return true
		}
	}
	return false
}

// indexFold is bytes.Index with ASCII case folding. It is written byte-wise
// instead of the shorter bytes.Index(bytes.ToLower(b), ...) because ToLower is
// rune-aware: on non-ASCII input it can return a slice of a different length,
// which would shift every offset this parser then computes against the original.
func indexFold(b, sub []byte) int {
	for i := 0; i+len(sub) <= len(b); i++ {
		if equalFold(b[i:i+len(sub)], sub) {
			return i
		}
	}
	return -1
}

// equalFold compares two equal-length byte slices, ASCII case-insensitively.
func equalFold(a, b []byte) bool {
	for i := range b {
		if lowerByte(a[i]) != lowerByte(b[i]) {
			return false
		}
	}
	return true
}

// lowerByte lowercases one ASCII byte and leaves everything else alone.
func lowerByte(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + ('a' - 'A')
	}
	return c
}

// isSpaceByte reports whether c is one of the five characters HTML treats as
// whitespace between a tag name and its attributes.
func isSpaceByte(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f'
}
