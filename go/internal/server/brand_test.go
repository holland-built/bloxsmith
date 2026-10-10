package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"bloxsmith/internal/config"
	"bloxsmith/internal/httpx"
)

// This file is the regression suite for the brand-logo data-loss defect:
// brandPost used to write whatever brandHTTP.Do returned straight over
// logo.png whenever the request itself didn't error — including a 404/500
// error-page body, or a zero-byte read — so a transient CDN hiccup silently
// destroyed the user's working logo. cacheLogo now requires a clean read AND
// a 2xx status before it will touch dest at all.

// TestCacheLogo_FailedFetch_LeavesExistingLogoUntouched is the data-loss
// guard: a non-2xx CDN response must not overwrite an existing logo.png —
// the original bytes must survive byte-for-byte — and the failure must be
// reported to the caller instead of being swallowed.
func TestCacheLogo_FailedFetch_LeavesExistingLogoUntouched(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "logo.png")
	original := []byte("original-logo-bytes")
	if err := os.WriteFile(dest, original, 0o644); err != nil {
		t.Fatal(err)
	}

	err := cacheLogo(context.Background(), srv.URL, dest)
	if err == nil {
		t.Fatalf("expected a non-2xx response to be reported as an error")
	}

	got, rerr := os.ReadFile(dest)
	if rerr != nil {
		t.Fatalf("logo.png should still exist: %v", rerr)
	}
	if string(got) != string(original) {
		t.Fatalf("data loss: original logo bytes were not preserved.\nwant: %s\ngot:  %s", original, got)
	}
}

// TestCacheLogo_NetworkError_LeavesExistingLogoUntouched covers the transport
// error path (server unreachable) in addition to the non-2xx path above.
func TestCacheLogo_NetworkError_LeavesExistingLogoUntouched(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	badURL := srv.URL
	srv.Close() // now nothing is listening -> Do() returns a network error

	dest := filepath.Join(t.TempDir(), "logo.png")
	original := []byte("original-logo-bytes")
	if err := os.WriteFile(dest, original, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := cacheLogo(context.Background(), badURL, dest); err == nil {
		t.Fatalf("expected a network error to be reported")
	}

	got, rerr := os.ReadFile(dest)
	if rerr != nil {
		t.Fatalf("logo.png should still exist: %v", rerr)
	}
	if string(got) != string(original) {
		t.Fatalf("data loss: original logo bytes were not preserved.\nwant: %s\ngot:  %s", original, got)
	}
}

// TestCacheLogo_SuccessfulFetch_StillWrites confirms the fix didn't also
// break the happy path: a genuine 2xx response must still update dest.
func TestCacheLogo_SuccessfulFetch_StillWrites(t *testing.T) {
	fresh := pngBytes
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(fresh)
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "logo.png")
	if err := os.WriteFile(dest, []byte("stale-logo-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := cacheLogo(context.Background(), srv.URL, dest); err != nil {
		t.Fatalf("expected a successful fetch to write cleanly, got %v", err)
	}

	got, rerr := os.ReadFile(dest)
	if rerr != nil {
		t.Fatalf("logo.png should exist: %v", rerr)
	}
	if string(got) != string(fresh) {
		t.Fatalf("expected the fresh logo to be written.\nwant: %q\ngot:  %q", fresh, got)
	}
}

// --- GET /api/logo: what comes back from a CDN is not automatically a logo ----
//
// The loop in `logo` used to check nothing but `len(data) < 50`: no status, no
// read error, no size, and it passed the CDN's own Content-Type straight
// through. A 404 HTML error page therefore reached the browser as HTTP 200,
// labelled text/html, from this server's origin, cached for a day — and since a
// >50-byte error page is not a `continue`, the second CDN was never asked.
// cacheLogo above already required a 2xx and a clean read; the same omission
// survived forty lines up, untested.

// pngBytes is a real 1x1 PNG. Its magic number is what http.DetectContentType
// reads, so these tests exercise sniffing rather than asserting on a header the
// production code deliberately ignores.
var pngBytes = append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 80)...)

// cdnReply is one canned CDN response. body/status/ct describe it; readErr
// makes the body fail mid-stream; oversize sends more than maxLogoBytes;
// transport makes the request itself fail.
type cdnReply struct {
	status    int
	ct        string
	body      []byte
	readErr   bool
	oversize  bool
	transport bool
}

type errAfterBody struct {
	data []byte
	n    int
}

func (e *errAfterBody) Read(p []byte) (int, error) {
	if e.n < len(e.data) {
		n := copy(p, e.data[e.n:])
		e.n += n
		return n, nil
	}
	return 0, errors.New("connection reset mid-body")
}
func (e *errAfterBody) Close() error { return nil }

// cdnRouter answers the two hardcoded CDN hosts in order and counts the calls,
// so a test can prove the SECOND CDN was reached — the behaviour the missing
// status check silently removed.
type cdnRouter struct {
	replies []cdnReply
	calls   []string
	urls    []string
}

func (c *cdnRouter) RoundTrip(r *http.Request) (*http.Response, error) {
	// A cancelled context is refused here because that is where http.Transport
	// refuses it in production. Without this the stub would answer a cancelled
	// request happily and the cancellation test would be asserting on the stub.
	if err := r.Context().Err(); err != nil {
		return nil, err
	}
	i := len(c.calls)
	c.calls = append(c.calls, r.URL.Host)
	c.urls = append(c.urls, r.URL.String())
	if i >= len(c.replies) {
		return nil, errors.New("no canned reply for call " + strconv.Itoa(i+1))
	}
	rep := c.replies[i]
	if rep.transport {
		return nil, errors.New("dial failed")
	}
	body := rep.body
	if rep.oversize {
		body = make([]byte, maxLogoBytes+1024)
		copy(body, pngBytes)
	}
	resp := &http.Response{
		StatusCode: rep.status,
		Header:     http.Header{},
		Request:    r,
	}
	if rep.ct != "" {
		resp.Header.Set("Content-Type", rep.ct)
	}
	if rep.readErr {
		resp.Body = &errAfterBody{data: body}
	} else {
		resp.Body = io.NopCloser(bytes.NewReader(body))
	}
	return resp, nil
}

// withCDN installs a stub for the package-global brandHTTP and restores it.
// Not parallel, deliberately: the global is shared.
func withCDN(t *testing.T, replies ...cdnReply) *cdnRouter {
	t.Helper()
	router := &cdnRouter{replies: replies}
	old := brandHTTP
	brandHTTP = &http.Client{Transport: router}
	t.Cleanup(func() { brandHTTP = old })
	return router
}

func logoRequest(t *testing.T, stateDir string) (*httptest.ResponseRecorder, *http.Request, *Deps) {
	t.Helper()
	d := &Deps{Cfg: &config.Config{Port: "8080"}, StateDir: stateDir}
	r := httptest.NewRequest("GET", "/api/logo?domain=example.com", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	return httptest.NewRecorder(), r, d
}

const htmlErrorPage = "<html><body><h1>404 Not Found</h1><p>no logo for that domain at all</p></body></html>"

// The headline case: a CDN error page must not become a logo, and the fallback
// CDN must get its turn.
func TestLogo_CDNErrorPage_FallsThroughToTheSecondCDN(t *testing.T) {
	router := withCDN(t,
		cdnReply{status: 404, ct: "text/html; charset=utf-8", body: []byte(htmlErrorPage)},
		cdnReply{status: 200, ct: "image/png", body: pngBytes},
	)
	rr, r, d := logoRequest(t, t.TempDir())
	d.logo(rr, r)

	if len(router.calls) != 2 {
		t.Fatalf("CDN calls = %d (%v), want 2 — a failed first CDN must fall through to the second",
			len(router.calls), router.calls)
	}
	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200 from the second CDN", rr.Code)
	}
	if !bytes.Equal(rr.Body.Bytes(), pngBytes) {
		t.Fatalf("body is not the PNG the second CDN returned: %q", rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/") {
		t.Fatalf("Content-Type = %q, want an image type", ct)
	}
	if strings.Contains(rr.Body.String(), "404 Not Found") {
		t.Fatalf("the CDN's HTML error page was served to the browser: %q", rr.Body.String())
	}
}

// Both CDNs failing is a 404, not a 200 carrying somebody's error page.
func TestLogo_BothCDNsFail_Is404WithNoBody(t *testing.T) {
	withCDN(t,
		cdnReply{status: 404, ct: "text/html", body: []byte(htmlErrorPage)},
		cdnReply{status: 500, ct: "text/html", body: []byte(htmlErrorPage)},
	)
	rr, r, d := logoRequest(t, t.TempDir())
	d.logo(rr, r)

	if rr.Code != 404 {
		t.Fatalf("status = %d, want 404 — no CDN produced a logo", rr.Code)
	}
	if rr.Body.Len() != 0 {
		t.Fatalf("404 carries a body: %q", rr.Body.String())
	}
}

// Each reason to reject one CDN's answer, proven separately, each by requiring
// the fallback to be reached. Every row here used to be served as a logo.
func TestLogo_RejectsNonLogoResponses(t *testing.T) {
	cases := []struct {
		name  string
		first cdnReply
	}{
		{"200 carrying HTML", cdnReply{status: 200, ct: "text/html", body: []byte(htmlErrorPage)}},
		{"200 with no Content-Type carrying HTML", cdnReply{status: 200, body: []byte(htmlErrorPage)}},
		{"200 labelled image/png but carrying HTML", cdnReply{status: 200, ct: "image/png", body: []byte(htmlErrorPage)}},
		// A REAL PNG signature, deliberately: with anything else the sniff check
		// rejects it and this row proves nothing about the length rule. Caught by
		// mutation — deleting `len(data) < 50` left the old version green.
		{"real PNG bytes but under 50 of them", cdnReply{status: 200, ct: "image/png",
			body: append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 20)...)}},
		{"body that fails mid-read", cdnReply{status: 200, ct: "image/png", body: pngBytes, readErr: true}},
		{"body larger than the cap", cdnReply{status: 200, ct: "image/png", oversize: true}},
		{"transport failure", cdnReply{transport: true}},
		{"redirect status with a body", cdnReply{status: 302, ct: "image/png", body: pngBytes}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			router := withCDN(t, tc.first, cdnReply{status: 200, ct: "image/png", body: pngBytes})
			rr, r, d := logoRequest(t, t.TempDir())
			d.logo(rr, r)

			if len(router.calls) != 2 {
				t.Fatalf("CDN calls = %d, want 2 — the first answer should have been rejected", len(router.calls))
			}
			if !bytes.Equal(rr.Body.Bytes(), pngBytes) {
				t.Fatalf("served the first CDN's answer instead of falling through: %q", rr.Body.String())
			}
		})
	}
}

// A real image with NO Content-Type header is still a real image. The header is
// ignored on purpose, so this must come back with the sniffed type.
func TestLogo_RealImageWithNoContentType_IsServedAsAnImage(t *testing.T) {
	withCDN(t, cdnReply{status: 200, body: pngBytes})
	rr, r, d := logoRequest(t, t.TempDir())
	d.logo(rr, r)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200 — the bytes are a PNG whatever the header said", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png from sniffing the bytes", ct)
	}
}

// SVG can carry script, so serving one from this origin would be same-origin
// script execution. It must never be served, however the CDN labels it.
func TestLogo_SVGIsNeverServed(t *testing.T) {
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><script>alert(1)</script></svg>`)
	router := withCDN(t,
		cdnReply{status: 200, ct: "image/svg+xml", body: svg},
		cdnReply{status: 200, ct: "image/svg+xml", body: svg},
	)
	rr, r, d := logoRequest(t, t.TempDir())
	d.logo(rr, r)

	if rr.Code != 404 {
		t.Fatalf("status = %d, want 404 — an SVG from a third party must not be served from this origin", rr.Code)
	}
	if strings.Contains(rr.Body.String(), "script") {
		t.Fatalf("an SVG carrying script reached the browser: %q", rr.Body.String())
	}
	if len(router.calls) != 2 {
		t.Fatalf("CDN calls = %d, want 2", len(router.calls))
	}
}

// A cancelled request must not produce a logo, and must not keep asking.
func TestLogo_CancelledRequest_ServesNothing(t *testing.T) {
	withCDN(t, cdnReply{status: 200, ct: "image/png", body: pngBytes})
	rr, r, d := logoRequest(t, t.TempDir())
	ctx, cancel := context.WithCancel(r.Context())
	cancel()
	d.logo(rr, r.WithContext(ctx))

	if rr.Code == 200 {
		t.Fatalf("a cancelled request was answered with a logo")
	}
}

// The vault logo wins and costs no outbound call at all.
func TestLogo_OnDiskLogoIsServedWithoutTouchingACDN(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "logo.png"), pngBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	router := withCDN(t)
	rr, r, d := logoRequest(t, dir)
	d.logo(rr, r)

	if rr.Code != 200 || !bytes.Equal(rr.Body.Bytes(), pngBytes) {
		t.Fatalf("the stored logo was not served: %d %q", rr.Code, rr.Body.String())
	}
	if len(router.calls) != 0 {
		t.Fatalf("a stored logo still cost %d CDN call(s): %v", len(router.calls), router.calls)
	}
}

// cacheLogo's read is capped too — the write path against the same third
// parties, and the one that lands on disk.
func TestCacheLogo_OversizeBody_IsRefusedAndLeavesDestUntouched(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write(make([]byte, maxLogoBytes+1024))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "logo.png")
	original := []byte("original-logo-bytes")
	if err := os.WriteFile(dest, original, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := cacheLogo(context.Background(), srv.URL, dest); err == nil {
		t.Fatalf("expected an over-size body to be refused")
	}
	got, _ := os.ReadFile(dest)
	if string(got) != string(original) {
		t.Fatalf("data loss: the stored logo was replaced by a truncated over-size body")
	}
}

// --- A logo service's web page is not a logo ---------------------------------
//
// Found on a running install on 2026-10-04: brand.json said delta.com, logo.png
// held 417121 bytes of HTML titled "Overview - Brandfetch", and GET /api/logo
// sent it out as image/png. cdn.brandfetch.io answers a server with HTTP 200 and
// its own web page, so cacheLogo's status check let it through. The picture never
// loaded, and the header fell back to the built-in Infoblox mark for a company
// that was not Infoblox.

const webPage = `<!DOCTYPE html><html lang="en"><head><title>Overview - Brandfetch</title></head><body>a logo service's own page</body></html>`

// iconBytes carries the signature of a Windows icon, which is what the second
// source sends. It sniffs as image/x-icon.
var iconBytes = append([]byte("\x00\x00\x01\x00"), make([]byte, 80)...)

// pageLogoRequest is the request the page makes: /api/logo with no domain.
func pageLogoRequest(t *testing.T, stateDir string) (*httptest.ResponseRecorder, *http.Request, *Deps) {
	t.Helper()
	d := &Deps{Cfg: &config.Config{Port: "8080"}, StateDir: stateDir, Guard: &httpx.Guard{Port: "8080"}}
	r := httptest.NewRequest("GET", "/api/logo", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	return httptest.NewRecorder(), r, d
}

func writeState(t *testing.T, dir, name string, data []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// saveBrand posts a company domain the way the brand dialog does.
func saveBrand(t *testing.T, d *Deps, domain string) {
	t.Helper()
	r := httptest.NewRequest("POST", "/api/brand", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	r.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	d.brandPost(rr, r, map[string]any{"domain": domain, "name": "Example"})
	if rr.Code != 200 {
		t.Fatalf("saving the brand: status %d %s", rr.Code, rr.Body.String())
	}
}

// A 200 carrying a web page is refused whatever it is labelled, and the logo
// already stored survives it.
func TestCacheLogo_WebPageWith200_IsRefusedAndLeavesDestUntouched(t *testing.T) {
	for _, label := range []string{"text/html; charset=utf-8", "image/png"} {
		t.Run(label, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", label)
				w.WriteHeader(200)
				_, _ = w.Write([]byte(webPage))
			}))
			defer srv.Close()

			dir := t.TempDir()
			writeState(t, dir, "logo.png", pngBytes)
			dest := filepath.Join(dir, "logo.png")
			if err := cacheLogo(context.Background(), srv.URL, dest); err == nil {
				t.Fatalf("a web page was accepted as a logo")
			}
			got, _ := os.ReadFile(dest)
			if !bytes.Equal(got, pngBytes) {
				t.Fatalf("the stored logo was replaced by a web page: %q", got)
			}
		})
	}
}

// An install that already holds a web page in logo.png must stop serving it.
// With no company saved there is nothing to fall back to, so it is a 404.
func TestLogo_StoredWebPage_IsNotServed(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, "logo.png", []byte(webPage))
	router := withCDN(t)
	rr, r, d := pageLogoRequest(t, dir)
	d.logo(rr, r)

	if rr.Code != 404 {
		t.Fatalf("status = %d, want 404: the stored file is not an image", rr.Code)
	}
	if rr.Body.Len() != 0 {
		t.Fatalf("the stored web page reached the browser: %q", rr.Body.String())
	}
	if len(router.calls) != 0 {
		t.Fatalf("no company is saved, yet %d outside call(s) were made: %v", len(router.calls), router.urls)
	}
}

// The page asks for /api/logo with no domain. When there is no stored logo to
// serve, the saved company is the one looked up.
func TestLogo_NothingUsableStored_ServesTheSavedCompanysLogo(t *testing.T) {
	cases := []struct {
		name   string
		stored []byte
	}{
		{"a web page is stored", []byte(webPage)},
		{"nothing is stored", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if tc.stored != nil {
				writeState(t, dir, "logo.png", tc.stored)
			}
			writeState(t, dir, "brand.json", []byte(`{"domain":"example.com","name":"Example"}`))
			router := withCDN(t, cdnReply{status: 200, ct: "image/x-icon", body: iconBytes})
			rr, r, d := pageLogoRequest(t, dir)
			d.logo(rr, r)

			if rr.Code != 200 || !bytes.Equal(rr.Body.Bytes(), iconBytes) {
				t.Fatalf("the saved company's logo was not served: %d %q", rr.Code, rr.Body.String())
			}
			if ct := rr.Header().Get("Content-Type"); ct != "image/x-icon" {
				t.Fatalf("Content-Type = %q, want image/x-icon", ct)
			}
			if len(router.urls) != 1 || !strings.Contains(router.urls[0], "example.com") {
				t.Fatalf("outside calls = %v, want one, for example.com", router.urls)
			}
		})
	}
}

// A stored logo goes out under the type its bytes have. The second source sends
// an icon, and it used to be labelled image/png because the file is logo.png.
func TestLogo_StoredIcon_IsLabelledAsAnIcon(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, "logo.png", iconBytes)
	withCDN(t)
	rr, r, d := pageLogoRequest(t, dir)
	d.logo(rr, r)

	if rr.Code != 200 || !bytes.Equal(rr.Body.Bytes(), iconBytes) {
		t.Fatalf("the stored icon was not served: %d %q", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "image/x-icon" {
		t.Fatalf("Content-Type = %q, want image/x-icon", ct)
	}
}

// The case from the running install: the first source sends its web page, so
// the second one fills the cache, and the page then gets a picture.
func TestBrandPost_FirstSourceSendsAWebPage_TheSecondFillsTheCache(t *testing.T) {
	dir := t.TempDir()
	router := withCDN(t,
		cdnReply{status: 200, ct: "text/html; charset=utf-8", body: []byte(webPage)},
		cdnReply{status: 200, ct: "image/x-icon", body: iconBytes},
	)
	rr, r, d := pageLogoRequest(t, dir)
	saveBrand(t, d, "example.com")

	want := []string{"cdn.brandfetch.io", "icons.duckduckgo.com"}
	if strings.Join(router.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("sources asked = %v, want %v", router.calls, want)
	}
	stored, _ := os.ReadFile(filepath.Join(dir, "logo.png"))
	if !bytes.Equal(stored, iconBytes) {
		t.Fatalf("logo.png does not hold the second source's icon: %q", stored)
	}

	d.logo(rr, r)
	if rr.Code != 200 || !bytes.Equal(rr.Body.Bytes(), iconBytes) {
		t.Fatalf("the page did not get the cached icon: %d %q", rr.Code, rr.Body.String())
	}
	if len(router.calls) != 2 {
		t.Fatalf("serving the cached icon cost another outside call: %v", router.urls)
	}
}

// A stored logo belongs to the company it was fetched for. When the company
// changes and no source has a logo for the new one, the old picture must go, or
// the header shows one company's logo beside another company's name.
func TestBrandPost_NoLogoForANewCompany_RemovesTheOldCompanysLogo(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, "brand.json", []byte(`{"domain":"old.example","name":"Old"}`))
	writeState(t, dir, "logo.png", pngBytes)
	withCDN(t,
		cdnReply{status: 404, ct: "text/html", body: []byte(htmlErrorPage)},
		cdnReply{status: 404, ct: "text/html", body: []byte(htmlErrorPage)},
	)
	_, _, d := pageLogoRequest(t, dir)
	saveBrand(t, d, "new.example")

	if _, err := os.Stat(filepath.Join(dir, "logo.png")); !os.IsNotExist(err) {
		t.Fatalf("the old company's logo is still stored after the company changed (stat err: %v)", err)
	}
}

// Saving the same company again while no source answers must not cost the logo
// already stored for it. The first row passed before this change as well: both
// rows are here to keep the removal rule above from reaching the same company.
func TestBrandPost_NoSourceAnswers_KeepsTheSameCompanysLogo(t *testing.T) {
	for _, again := range []string{"example.com", "EXAMPLE.COM"} {
		t.Run(again, func(t *testing.T) {
			dir := t.TempDir()
			writeState(t, dir, "brand.json", []byte(`{"domain":"example.com","name":"Example"}`))
			writeState(t, dir, "logo.png", pngBytes)
			withCDN(t, cdnReply{transport: true}, cdnReply{transport: true})
			_, _, d := pageLogoRequest(t, dir)
			saveBrand(t, d, again)

			stored, _ := os.ReadFile(filepath.Join(dir, "logo.png"))
			if !bytes.Equal(stored, pngBytes) {
				t.Fatalf("the stored logo was lost on a failed refresh: %q", stored)
			}
		})
	}
}

// Clearing the company leaves no company for the stored logo to belong to.
func TestBrandPost_ClearingTheCompany_RemovesItsLogo(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, "brand.json", []byte(`{"domain":"example.com","name":"Example"}`))
	writeState(t, dir, "logo.png", pngBytes)
	router := withCDN(t)
	_, _, d := pageLogoRequest(t, dir)
	saveBrand(t, d, "")

	if _, err := os.Stat(filepath.Join(dir, "logo.png")); !os.IsNotExist(err) {
		t.Fatalf("the cleared company's logo is still stored (stat err: %v)", err)
	}
	if len(router.calls) != 0 {
		t.Fatalf("clearing the company made %d outside call(s): %v", len(router.calls), router.urls)
	}
}

// Brandfetch sends a logo only to a caller that looks like a browser showing a
// page: a full browser User-Agent and a Referer, both. Measured 2026-10-10 on
// cdn.brandfetch.io/infoblox.com: with either one missing, or with the bare
// "Mozilla/5.0" this file used to send, the reply is HTTP 200 and its web page.
// So every install saved the second source's 32px site icon. This stands in for
// that rule, and the saved file must be the logo.
func TestCacheLogo_SourceThatAnswersOnlyABrowser_GetsTheLogo(t *testing.T) {
	var referer string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		referer = r.Referer()
		if !strings.Contains(r.UserAgent(), "Chrome/") || r.Referer() == "" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(webPage))
			return
		}
		_, _ = w.Write(pngBytes)
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "logo.png")
	if err := cacheLogo(context.Background(), srv.URL, dest); err != nil {
		t.Fatalf("the logo was refused: %v", err)
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, pngBytes) {
		t.Fatalf("logo.png does not hold the logo: %q", got)
	}
	// Brandfetch takes any Referer. This install's own address must never be
	// the one it gets.
	if referer != "https://brandfetch.com/" {
		t.Fatalf("Referer = %q, want Brandfetch's own site and nothing about this install", referer)
	}
}
