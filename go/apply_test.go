package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestHandleRestartLaunchFailureKeepsServing pins the self-update restart fix:
// when the successor binary CANNOT be launched, handleRestart must NOT signal
// exit and must NOT release the listen socket — the old process keeps serving —
// and it must report phase=error so the frontend sees the failure instead of a
// stale "done".
func TestHandleRestartLaunchFailureKeepsServing(t *testing.T) {
	// Point shutdownServer at a canary; a launch failure must never call it,
	// because releasing the port before the child is up is exactly the bug.
	shutdownCalled := false
	shutdownServer = func(_ context.Context) error { shutdownCalled = true; return nil }
	t.Cleanup(func() { shutdownServer = nil })

	// Reset progress to a clean in-flight state.
	progress = &updateProgress{Phase: "restarting", running: true}

	badExe := filepath.Join(t.TempDir(), "does-not-exist-bloxsmith")
	if exit := handleRestart(badExe); exit {
		t.Fatal("handleRestart returned exit=true on a launch failure; the parent would have exited and taken the service down")
	}
	if shutdownCalled {
		t.Fatal("handleRestart released the listen socket despite the child failing to start")
	}
	if snap := progress.snapshot(); snap["phase"] != "error" {
		t.Fatalf("phase = %v, want error", snap["phase"])
	}
}

// buildTarGz packs name -> content pairs into an in-memory tar.gz archive,
// matching the shape of a goreleaser release asset closely enough for
// extractTemplates to walk it.
func buildTarGz(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, data := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Size: int64(len(data)), Mode: 0o644}); err != nil {
			t.Fatalf("tar header %s: %v", name, err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatalf("tar write %s: %v", name, err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

// TestExtractTemplates pins the self-update templates refresh: a "templates/…"
// entry lands under destDir/templates, a non-templates entry (the binary) is
// ignored, and no templates.new staging dir is left behind on success.
func TestExtractTemplates(t *testing.T) {
	want := []byte("dns_servers:\n  - 10.0.0.1\n")
	archive := buildTarGz(t, map[string][]byte{
		"templates/amer/lab.yaml": want,
		"bloxsmith":               []byte("not-a-template"),
	})
	destDir := t.TempDir()

	if err := extractTemplates(archive, false, destDir); err != nil {
		t.Fatalf("extractTemplates: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(destDir, "templates", "amer", "lab.yaml"))
	if err != nil {
		t.Fatalf("reading extracted template: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("template content = %q, want %q", got, want)
	}
	if _, err := os.Stat(filepath.Join(destDir, "templates", "bloxsmith")); !os.IsNotExist(err) {
		t.Fatalf("non-template archive entry was extracted: err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(destDir, "templates.new")); !os.IsNotExist(err) {
		t.Fatalf("templates.new staging dir left behind: err = %v", err)
	}
}

// TestExtractTemplatesRejectsPathEscape pins the defense-in-depth path check:
// an entry that tries to escape the templates root via ".." must be rejected
// and must not be written outside destDir.
func TestExtractTemplatesRejectsPathEscape(t *testing.T) {
	archive := buildTarGz(t, map[string][]byte{
		"templates/../evil": []byte("owned"),
	})
	destDir := t.TempDir()

	if err := extractTemplates(archive, false, destDir); err == nil {
		t.Fatal("extractTemplates accepted a path-escaping entry")
	}
	if _, err := os.Stat(filepath.Join(destDir, "evil")); !os.IsNotExist(err) {
		t.Fatalf("path-escaping entry was written outside templates root: err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(destDir, "templates.new")); !os.IsNotExist(err) {
		t.Fatalf("templates.new staging dir left behind after failure: err = %v", err)
	}
}
