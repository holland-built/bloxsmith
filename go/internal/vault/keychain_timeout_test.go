package vault

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// `security find-generic-password` can hang (a locked keychain waiting on a
// prompt nobody can see). The lookup runs while the server starts, so a hang
// there kept the whole app from coming up. It now gives up and says so.
func TestKeychainLookupGivesUpOnAHungSecurityTool(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the keychain is macOS only")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "security"), []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	old := keychainTimeout
	keychainTimeout = 300 * time.Millisecond
	defer func() { keychainTimeout = old }()

	start := time.Now()
	_, err := GetKeychainPassphrase(filepath.Join(t.TempDir(), "vault.json"))
	if err == nil {
		t.Fatal("a hung keychain lookup must be reported as a failure")
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("the lookup waited %v for a hung security tool", took)
	}
}
