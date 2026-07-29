package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
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
	fresh := []byte("fresh-logo-bytes")
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
		t.Fatalf("expected the fresh logo to be written.\nwant: %s\ngot:  %s", fresh, got)
	}
}
