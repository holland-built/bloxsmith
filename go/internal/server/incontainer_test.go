package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInContainerSeesAMarkerFile(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, ".dockerenv")
	if inContainer(marker) {
		t.Fatal("no marker file yet, but inContainer said true")
	}
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if !inContainer(filepath.Join(dir, "missing"), marker) {
		t.Fatal("marker file exists, but inContainer said false")
	}
}
