package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// staticSite builds a tiny web root and serves it the way main does, through
// WEB_DIR, so the test exercises staticHandler and not a copy of it.
func staticSite(t *testing.T) (http.Handler, string) {
	t.Helper()
	dir := t.TempDir()
	js := strings.Repeat("export const x = 1;\n", 200)
	for name, body := range map[string]string{
		"index.html":          "<!doctype html><title>x</title>",
		"assets/app-AbC1.js":  js,
		"assets/app-AbC1.css": "body{margin:0}",
		"assets/pic-Zz9.png":  "not really a png",
		"fonts/Inter.woff2":   "font bytes",
	} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("WEB_DIR", dir)
	return staticHandler(), js
}

func get(h http.Handler, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestStatic_HashedAssetIsGzippedAndCachedForever(t *testing.T) {
	h, js := staticSite(t)
	w := get(h, http.MethodGet, "/assets/app-AbC1.js", map[string]string{"Accept-Encoding": "gzip, br"})
	if got := w.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") || !strings.Contains(cc, "max-age=31536000") {
		t.Fatalf("Cache-Control = %q, want a year and immutable", cc)
	}
	if v := w.Header().Get("Vary"); !strings.Contains(v, "Accept-Encoding") {
		t.Fatalf("Vary = %q, want Accept-Encoding", v)
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("Content-Type = %q, want javascript", ct)
	}
	zr, err := gzip.NewReader(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(zr)
	if string(plain) != js {
		t.Fatal("the gzipped body does not decompress to the original file")
	}
	if w.Body.Len() >= len(js) {
		t.Fatalf("gzipped body is %d bytes, not smaller than the %d it came from", w.Body.Len(), len(js))
	}
}

func TestStatic_HashedAssetWithoutGzipRequestIsPlainButStillCached(t *testing.T) {
	h, js := staticSite(t)
	w := get(h, http.MethodGet, "/assets/app-AbC1.js", nil)
	if w.Header().Get("Content-Encoding") != "" {
		t.Fatal("sent gzip to a client that did not ask for it")
	}
	if w.Body.String() != js {
		t.Fatal("plain body differs from the file")
	}
	if !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("Cache-Control = %q", w.Header().Get("Cache-Control"))
	}
}

func TestStatic_IndexAndOtherFilesStayNoStore(t *testing.T) {
	h, _ := staticSite(t)
	for _, target := range []string{"/", "/index.html"} {
		w := get(h, http.MethodGet, target, map[string]string{"Accept-Encoding": "gzip"})
		if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
			t.Errorf("%s: Cache-Control = %q, want no-store (it names the current asset hashes)", target, cc)
		}
	}
}

func TestStatic_MissingHashedAssetIsNotCachedForAYear(t *testing.T) {
	h, _ := staticSite(t)
	w := get(h, http.MethodGet, "/assets/app-OLD.js", map[string]string{"Accept-Encoding": "gzip"})
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	if strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Fatal("a 404 for an old hash was marked immutable; browsers would keep the 404 for a year")
	}
}

func TestStatic_GzipRefusedWithQZeroIsNotGzipped(t *testing.T) {
	h, _ := staticSite(t)
	for _, ae := range []string{"gzip;q=0", "br, gzip; q=0", "identity", ""} {
		w := get(h, http.MethodGet, "/assets/app-AbC1.js", map[string]string{"Accept-Encoding": ae})
		if w.Header().Get("Content-Encoding") != "" {
			t.Errorf("Accept-Encoding %q was answered with gzip", ae)
		}
		if !strings.Contains(w.Header().Get("Vary"), "Accept-Encoding") {
			t.Errorf("Accept-Encoding %q: plain response has no Vary, a shared cache would hand it to gzip clients", ae)
		}
	}
	w := get(h, http.MethodGet, "/assets/app-AbC1.js", map[string]string{"Accept-Encoding": "gzip;q=0.5"})
	if w.Header().Get("Content-Encoding") != "gzip" {
		t.Error("gzip;q=0.5 should still be answered with gzip")
	}
}

func TestStatic_RangeAndAlreadyCompressedTypesAreNotGzipped(t *testing.T) {
	h, _ := staticSite(t)
	w := get(h, http.MethodGet, "/assets/app-AbC1.js", map[string]string{"Accept-Encoding": "gzip", "Range": "bytes=0-9"})
	if w.Header().Get("Content-Encoding") != "" || w.Code != http.StatusPartialContent {
		t.Fatalf("range request: status %d, encoding %q", w.Code, w.Header().Get("Content-Encoding"))
	}
	w = get(h, http.MethodGet, "/assets/pic-Zz9.png", map[string]string{"Accept-Encoding": "gzip"})
	if w.Header().Get("Content-Encoding") != "" {
		t.Fatal("gzipped a png")
	}
}

func TestStatic_HeadSendsHeadersOnly(t *testing.T) {
	h, _ := staticSite(t)
	w := get(h, http.MethodHead, "/assets/app-AbC1.js", map[string]string{"Accept-Encoding": "gzip"})
	if w.Header().Get("Content-Encoding") != "gzip" || w.Body.Len() != 0 {
		t.Fatalf("HEAD: encoding %q, body %d bytes", w.Header().Get("Content-Encoding"), w.Body.Len())
	}
}

func TestStatic_FontGetsADay(t *testing.T) {
	h, _ := staticSite(t)
	w := get(h, http.MethodGet, "/fonts/Inter.woff2", nil)
	if cc := w.Header().Get("Cache-Control"); cc != "public, max-age=86400" {
		t.Fatalf("Cache-Control = %q", cc)
	}
}
