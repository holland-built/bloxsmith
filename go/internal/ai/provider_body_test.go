package ai

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

// THE PROVIDER'S ERROR BODY IS THE ONLY PLACE SOME FACTS EXIST.
//
// chat() used to capture it with ONE `resp.Body.Read(b)` into a 300-byte
// buffer. Read is not ReadFull — it returns what has arrived — so a body
// delivered in two reads was cut at the first, and everything parsed out of that
// string went with it: the daily token cap (which runLoop says is learnable
// nowhere else), whether the limit was daily or per-minute (they need opposite
// advice), and the wait.
//
// SCOPE. ratelimit_test.go pins the PARSERS by handing them a complete string,
// and stayed green through all of this. These tests pin the CAPTURE, which is
// the half that was broken.
//
// The partial reads here are produced by a fake RoundTripper, not by timing a
// real socket: a sleep-and-flush test would be at the mercy of whatever the
// transport happened to buffer on the day it ran.

// chunkedBody hands back its chunks one Read at a time, exactly the way a body
// arriving in several TCP segments does.
type chunkedBody struct {
	chunks [][]byte
	err    error // returned after the last chunk instead of io.EOF, when set
}

func (c *chunkedBody) Read(p []byte) (int, error) {
	if len(c.chunks) == 0 {
		if c.err != nil {
			return 0, c.err
		}
		return 0, io.EOF
	}
	n := copy(p, c.chunks[0])
	if n < len(c.chunks[0]) {
		c.chunks[0] = c.chunks[0][n:]
	} else {
		c.chunks = c.chunks[1:]
	}
	return n, nil
}

func (c *chunkedBody) Close() error { return nil }

type fakeTransport struct {
	status int
	body   io.ReadCloser
}

func (f *fakeTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: f.status,
		Body:       f.body,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
	}, nil
}

func chatAgainst(status int, body io.ReadCloser) error {
	s := New(nil, nil, nil)
	s.http = &http.Client{Transport: &fakeTransport{status: status, body: body}}
	_, err := s.chat(context.Background(), "k", "https://provider.example", "m", nil)
	return err
}

// A verbatim-shaped Groq TPD body, split where a real one plausibly splits.
var tpdChunks = [][]byte{
	[]byte(`{"error":{"message":"Rate limit reached for model ` + "`meta-llama/llama-4-scout-17b-16e-instruct`" +
		` in organization ` + "`org_01j5h"),
	[]byte(`8k9m2n3p4q5r6s7t8v9` + "`" + ` service tier ` + "`on_demand`" +
		` on tokens per day (TPD): Limit 100000, Used 98902, Requested 1779. ` +
		`Please try again in 9m48.384s.","type":"tokens","code":"rate_limit_exceeded"}}`),
}

// THE BUG. Two reads, and every fact survives.
func TestProviderBody_SplitAcrossReadsIsCapturedWhole(t *testing.T) {
	err := chatAgainst(429, &chunkedBody{chunks: tpdChunks})
	if err == nil {
		t.Fatal("chat() error = nil, want the 429")
	}
	msg := err.Error()
	if !strings.Contains(msg, "9m48.384s") {
		t.Fatalf("the wait was lost — the body was cut at the first read:\n%s", msg)
	}

	limit, ok := dailyTokenLimit(msg)
	if !ok || limit != 100000 {
		t.Fatalf("dailyTokenLimit = (%d, %v), want (100000, true) — RecordLimit is the only way this "+
			"server ever learns the account's daily cap, and it is driven entirely by this string", limit, ok)
	}

	sentence := providerFailure(err)
	if !strings.Contains(sentence, "daily token") || !strings.Contains(sentence, "9m48.384s") {
		t.Fatalf("operator sentence = %q, want the daily-cap advice with the wait — a daily cap and a "+
			"per-minute throttle need opposite advice", sentence)
	}
}

// The end-to-end contract: RecordLimit is actually called. The parse test above
// would stay green if the capture were fine but the wiring were not.
func TestProviderBody_SplitAcrossReadsStillPersistsTheLimit(t *testing.T) {
	fb := newFakeBudget(func() string { return "2026-08-15" })
	s := New(fakeCreds{base: "https://provider.example"}, fakeToolRunner{}, fb)
	s.http = &http.Client{Transport: &fakeTransport{status: 429, body: &chunkedBody{chunks: tpdChunks}}}

	out := s.HandleQuery("q", "")
	b := out["budget"].(map[string]any)
	lt, ok := b["limit_tokens"]
	if !ok {
		t.Fatalf("limit_tokens absent after a 429 whose body stated one: %#v", b)
	}
	if lt != 100000 {
		t.Fatalf("limit_tokens = %v, want 100000", lt)
	}
}

// A read that fails partway keeps the prefix that DID arrive and says the read
// failed. The old `n, _ :=` made a failed read look identical to an empty body.
func TestProviderBody_ReadErrorKeepsThePrefixAndSaysSo(t *testing.T) {
	err := chatAgainst(429, &chunkedBody{chunks: tpdChunks[:1], err: io.ErrUnexpectedEOF})
	if err == nil {
		t.Fatal("chat() error = nil")
	}
	msg := err.Error()
	if !strings.Contains(msg, "Rate limit reached for model") {
		t.Fatalf("the prefix that arrived was thrown away:\n%s", msg)
	}
	if !strings.Contains(msg, "could not be fully read") {
		t.Fatalf("a failed read is not distinguishable from a complete one:\n%s", msg)
	}
}

// Over the cap: truncated, MARKED, and never split mid-rune.
func TestProviderBody_OversizedIsMarkedAndStaysValidUTF8(t *testing.T) {
	// A multi-byte rune repeated so the cap lands inside one.
	big := strings.Repeat("é", aiBodyCap)
	err := chatAgainst(500, io.NopCloser(bytes.NewReader([]byte(big))))
	msg := err.Error()
	if !strings.Contains(msg, "…[truncated]") {
		t.Fatalf("an oversized body was cut with no marker — a short body reads as the whole thing")
	}
	if !utf8.ValidString(msg) {
		t.Fatalf("the truncation split a UTF-8 code point")
	}
	if len(msg) > aiBodyCap+200 {
		t.Fatalf("captured %d bytes, want it bounded near aiBodyCap=%d", len(msg), aiBodyCap)
	}
}

// A body under the cap gets no marker — otherwise every log line would claim
// something was cut.
func TestProviderBody_SmallBodyIsNotMarked(t *testing.T) {
	err := chatAgainst(404, io.NopCloser(strings.NewReader(`{"error":{"message":"no such model"}}`)))
	if strings.Contains(err.Error(), "truncated") {
		t.Fatalf("a complete body was marked truncated: %s", err.Error())
	}
}

// Newlines cannot forge a log line: this string is formatted straight into one.
func TestProviderBody_NewlinesCannotForgeALogLine(t *testing.T) {
	err := chatAgainst(400, io.NopCloser(strings.NewReader("bad request\n2026-08-15 12:00:00 all clear\r\ndone")))
	if strings.ContainsAny(err.Error(), "\n\r") {
		t.Fatalf("the body carried a newline into the error string: %q", err.Error())
	}
}

// The status is now carried structurally. A 400 whose BODY happens to contain
// the characters "http 429" must not be routed to the rate-limit advice — which
// is a live risk only because the body is now included in full.
func TestProviderBody_StatusRoutingIgnoresBodyText(t *testing.T) {
	err := chatAgainst(400, io.NopCloser(strings.NewReader(
		`{"error":{"message":"tool schema invalid; see the http 429 section of the docs"}}`)))
	got := providerFailure(err)
	if got != providerFailure400 {
		t.Fatalf("providerFailure = %q, want the 400 sentence — the body mentioning \"http 429\" must "+
			"not decide the routing", got)
	}
}

// And a transport error with no status at all still falls back to the substring
// switch, which is what ratelimit_test.go's bare-string tests exercise.
func TestProviderBody_UntypedErrorStillRoutesBySubstring(t *testing.T) {
	if got := providerFailure(&stringErr{"chat/completions: http 404: nope"}); got != providerFailure404 {
		t.Fatalf("providerFailure = %q, want the 404 sentence", got)
	}
}

type stringErr struct{ s string }

func (e *stringErr) Error() string { return e.s }
