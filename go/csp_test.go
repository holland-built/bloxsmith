package main

import (
	"crypto/sha256"
	"encoding/base64"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// servedCSP drives the real securityHeaders middleware over the real embedded
// UI and returns the header a browser would receive. Everything below asserts
// against this rather than against cspPolicyFrom, so a wiring mistake between
// the builder and the middleware cannot pass.
func servedCSP(t *testing.T) string {
	t.Helper()
	// WEB_DIR would redirect uiFS at a directory on disk; unset it so the test
	// is always measuring the embedded copy that ships in the binary.
	t.Setenv("WEB_DIR", "")
	h := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	csp := rec.Header().Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("no Content-Security-Policy header on the response")
	}
	return csp
}

// directive pulls one directive's value out of a policy string.
func directive(t *testing.T, csp, name string) string {
	t.Helper()
	for _, d := range strings.Split(csp, ";") {
		d = strings.TrimSpace(d)
		if strings.HasPrefix(d, name+" ") {
			return d
		}
	}
	t.Fatalf("policy has no %s directive: %s", name, csp)
	return ""
}

// TestScriptSrcIsHashedNotUnsafeInline is the defect this change closes: with
// 'unsafe-inline' in script-src an injected <script> runs, because the browser
// cannot tell it from the app's own.
func TestScriptSrcIsHashedNotUnsafeInline(t *testing.T) {
	scriptSrc := directive(t, servedCSP(t), "script-src")
	if strings.Contains(scriptSrc, "'unsafe-inline'") {
		t.Errorf("script-src still allows any inline script: %s", scriptSrc)
	}
	if !strings.Contains(scriptSrc, "'sha256-") {
		t.Errorf("script-src names no script hash, so the theme bootstrap cannot run: %s", scriptSrc)
	}
	if !strings.Contains(scriptSrc, "'self'") {
		t.Errorf("script-src dropped 'self', which the bundled /assets/*.js needs: %s", scriptSrc)
	}
}

// TestStyleSrcKeepsUnsafeInline guards the half of the old comment that WAS
// real: React writes component style props as inline style="" attributes, which
// style-src governs. Removing it here would blank the UI.
//
// It stays after style-src-elem was added, and that is the point: style-src is
// now the fallback that keeps style="" attributes working on every browser,
// old or new, because style-src-attr is deliberately not emitted. Drop
// 'unsafe-inline' from here and 113 style={{…}} props across ui/src stop
// applying.
func TestStyleSrcKeepsUnsafeInline(t *testing.T) {
	styleSrc := directive(t, servedCSP(t), "style-src")
	if !strings.Contains(styleSrc, "'unsafe-inline'") {
		t.Errorf("style-src lost 'unsafe-inline'; React's inline style props would be blocked: %s", styleSrc)
	}
}

// TestStyleSrcElemRefusesInlineStyleElements is the defect this change closes:
// under style-src alone, 'unsafe-inline' had to cover style="" attributes and
// so also allowed any injected <style> block — the CSS-injection vector for
// exfiltration and UI spoofing.
//
// The two assertions are a pair, and neither is sufficient. A style-src-elem
// without 'self' would refuse the app's own /assets/*.css and leave the UI
// unstyled; a style-src-elem carrying 'unsafe-inline' would parse fine, apply
// fine, and protect nothing — the exact silent failure this test exists to
// catch, since the page looks identical either way.
func TestStyleSrcElemRefusesInlineStyleElements(t *testing.T) {
	styleSrcElem := directive(t, servedCSP(t), "style-src-elem")
	if strings.Contains(styleSrcElem, "'unsafe-inline'") {
		t.Errorf("style-src-elem allows any injected <style> block: %s", styleSrcElem)
	}
	if !strings.Contains(styleSrcElem, "'self'") {
		t.Errorf("style-src-elem dropped 'self'; the bundled /assets/*.css would be refused and the UI would render unstyled: %s", styleSrcElem)
	}
}

// TestStyleSrcAttrIsNotEmitted pins the deliberate absence. style-src-attr is
// left out so it falls back to style-src's 'unsafe-inline' on every browser
// that implements the split — emitting it, in any form, would be a second place
// that has to be kept in agreement with style-src, and getting it wrong blocks
// React's style props on new browsers only, which is precisely the bug class
// that never shows up on the developer's machine.
func TestStyleSrcAttrIsNotEmitted(t *testing.T) {
	for _, d := range strings.Split(servedCSP(t), ";") {
		if strings.HasPrefix(strings.TrimSpace(d), "style-src-attr") {
			t.Errorf("style-src-attr is emitted (%q); it is meant to inherit 'unsafe-inline' from style-src", strings.TrimSpace(d))
		}
	}
}

// inlineScriptRE is a deliberately independent extractor — regexp, not the
// hand-rolled scanner in csp.go — so the test recomputes the digest by a
// different route than the code under test. A shared helper would only prove
// the two agree with themselves.
var inlineScriptRE = regexp.MustCompile(`(?is)<script(\s[^>]*)?>(.*?)</script\s*>`)

// TestEmittedHashMatchesTheEmbeddedIndex recomputes the digest from the real
// embedded index.html and asserts the header carries it. This is the assertion
// that would fail if the extractor trimmed a byte of whitespace — the failure
// mode that costs nothing at build time and silently kills the theme bootstrap
// in every browser.
func TestEmittedHashMatchesTheEmbeddedIndex(t *testing.T) {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		t.Fatal(err)
	}
	index, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		t.Fatal(err)
	}

	var want []string
	for _, m := range inlineScriptRE.FindAllStringSubmatch(string(index), -1) {
		if strings.Contains(strings.ToLower(m[1]), "src=") || m[2] == "" {
			continue
		}
		sum := sha256.Sum256([]byte(m[2]))
		want = append(want, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
	}
	if len(want) == 0 {
		t.Fatal("the embedded index.html has no inline script for this test to hash")
	}

	scriptSrc := directive(t, servedCSP(t), "script-src")
	for _, h := range want {
		if !strings.Contains(scriptSrc, h) {
			t.Errorf("script-src is missing the hash of an inline script.\n got: %s\nwant it to contain: %s", scriptSrc, h)
		}
	}
	if got := strings.Count(scriptSrc, "'sha256-"); got != len(want) {
		t.Errorf("script-src has %d hashes, the document has %d inline scripts: %s", got, len(want), scriptSrc)
	}
}

// TestHashCoversTheExactBytesBetweenTheTags pins the one detail a browser
// checks and no build step does: the digest is over everything between '>' and
// '</script', leading newline and indentation included.
func TestHashCoversTheExactBytesBetweenTheTags(t *testing.T) {
	const body = "\n      var x = 1;\n    "
	got, err := inlineScriptHashes([]byte("<html><head><script>" + body + "</script></head></html>"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(body))
	want := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	if len(got) != 1 || got[0] != want {
		t.Errorf("hash = %v, want [%s] (digest of the untrimmed body)", got, want)
	}
}

// TestInlineScriptHashesRejectsBadInput is the failure path. Every case here
// used to be survivable by falling back to 'unsafe-inline', which would mean
// the protection evaporating on a future UI change with nothing saying so —
// hence an error, which cspPolicy turns into log.Fatal.
func TestInlineScriptHashesRejectsBadInput(t *testing.T) {
	cases := []struct {
		name string
		html string
	}{
		{"no script at all", "<html><head><title>ui</title></head><body></body></html>"},
		{"only an external script", `<html><head><script type="module" crossorigin src="/assets/index.js"></script></head></html>`},
		{"only an empty inline script", "<html><head><script></script></head></html>"},
		{"unterminated script", "<html><head><script>var x = 1;</head></html>"},
		{"opening tag never closes", "<html><head><script src=/a.js"},
		{"empty document", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := inlineScriptHashes([]byte(c.html))
			if err == nil {
				t.Fatalf("no error; got hashes %v — a bad index.html has to stop startup, not be papered over", got)
			}
		})
	}
}

// TestInlineScriptHashesMultiple covers the several-inline-scripts case: each
// gets its own source expression, in document order, and src'd scripts are left
// to 'self'.
func TestInlineScriptHashesMultiple(t *testing.T) {
	html := `<html><head>` +
		`<script>one()</script>` +
		`<script type="module" crossorigin src="/assets/index.js"></script>` +
		`<SCRIPT defer>two()</SCRIPT>` +
		`</head></html>`
	got, err := inlineScriptHashes([]byte(html))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d hashes %v, want 2 (the src'd script is covered by 'self')", len(got), got)
	}
	for i, body := range []string{"one()", "two()"} {
		sum := sha256.Sum256([]byte(body))
		want := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
		if got[i] != want {
			t.Errorf("hash[%d] = %s, want %s (%q)", i, got[i], want, body)
		}
	}
}

// TestHasSrcAttr guards the boundary check that decides whether a script is
// external. A false positive here silently drops a real inline script's hash
// and breaks the page; a false negative adds a pointless hash.
func TestHasSrcAttr(t *testing.T) {
	cases := map[string]bool{
		` src="/a.js"`:                     true,
		` SRC='/a.js'`:                     true,
		` src = "/a.js"`:                   true,
		` type="module" crossorigin src=x`: true,
		``:                                 false,
		` defer`:                           false,
		` data-src="/a.js"`:                false,
		` nosrc="x"`:                       false,
		` srcset="x"`:                      false,
	}
	for attrs, want := range cases {
		if got := hasSrcAttr([]byte(attrs)); got != want {
			t.Errorf("hasSrcAttr(%q) = %v, want %v", attrs, got, want)
		}
	}
}

// TestCSPPolicyFromShape checks the whole assembled value, since a directive
// list is easy to get subtly wrong (a missing separator merges two directives
// and the browser drops the second).
func TestCSPPolicyFromShape(t *testing.T) {
	policy, err := cspPolicyFrom([]byte("<html><head><script>boot()</script></head></html>"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("boot()"))
	want := "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; " +
		"script-src 'self' 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'; " +
		"style-src 'self' 'unsafe-inline'; style-src-elem 'self'; " +
		"img-src 'self' data:; font-src 'self' data:"
	if policy != want {
		t.Errorf("policy =\n  %s\nwant\n  %s", policy, want)
	}
}
