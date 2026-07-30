package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bloxsmith/internal/vault"
)

// `vault-passphrase check` is the step between "a passphrase is stored" and
// "it is safe to delete the plaintext one". Everything asserted here is about a
// wrong answer at that moment costing the operator their stored tenant keys.
//
// getPass is injected, so all four outcomes run on a machine with no keychain —
// which is every Linux CI runner. The real-keychain path is covered in
// internal/vault/keychain_test.go and skips off darwin; this file must not, or
// the logic below goes unexercised in CI exactly like the dead privacy scan did.

// newSealedVault writes a real encrypted vault with n tenants, via the real
// writer. Hand-authoring the file would only prove the reader agrees with
// whoever wrote the fixture.
func newSealedVault(t *testing.T, pass string, labels ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "vault.json")
	v := vault.New(path)
	if err := v.Init(pass); err != nil {
		t.Fatalf("Init: %v", err)
	}
	for i, l := range labels {
		if r := v.AddTenant(l, "key-"+string(rune('a'+i)), nil); r["ok"] != true {
			t.Fatalf("AddTenant(%q): %v", l, r)
		}
	}
	v.Lock()
	return path
}

func digest(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func staticPass(p string) func(string) (string, error) {
	return func(string) (string, error) { return p, nil }
}

func TestCheckKeychainOpensVaultRightPassphrase(t *testing.T) {
	path := newSealedVault(t, "correct horse", "Alpha", "Beta")

	msg, code := checkKeychainOpensVault(path, staticPass("correct horse"))
	if code != 0 {
		t.Fatalf("code %d, want 0: %s", code, msg)
	}
	// The count is the part that distinguishes the real vault from an empty one
	// this command might itself have created.
	if !strings.Contains(msg, "2 tenants") {
		t.Fatalf("message does not report the 2 tenants it opened: %q", msg)
	}
}

func TestCheckKeychainOpensVaultSingularTenant(t *testing.T) {
	path := newSealedVault(t, "open-sesame-1", "Only")
	msg, code := checkKeychainOpensVault(path, staticPass("open-sesame-1"))
	if code != 0 || !strings.Contains(msg, "1 tenant inside") {
		t.Fatalf("code %d, msg %q — want 0 and %q", code, msg, "1 tenant inside")
	}
}

// The failure that matters: a wrong stored passphrase must exit 1 and must tell
// the operator NOT to delete their plaintext copy. Exiting 2 here would read as
// "could not tell", and an operator who cannot tell is likely to go ahead.
func TestCheckKeychainWrongPassphraseIsExit1AndSaysDoNotRemove(t *testing.T) {
	path := newSealedVault(t, "the real one", "Alpha")

	msg, code := checkKeychainOpensVault(path, staticPass("not the real one"))
	if code != 1 {
		t.Fatalf("code %d, want 1: %s", code, msg)
	}
	if !strings.Contains(msg, "does NOT open") {
		t.Fatalf("message does not say it failed to open: %q", msg)
	}
	if !strings.Contains(msg, "Do not remove your plaintext copy") {
		t.Fatalf("message does not warn against removing the plaintext copy: %q", msg)
	}
}

// Exit 2 is "the check did not run". Each of these claims nothing about the
// passphrase, and none may be reported as a wrong passphrase.
func TestCheckKeychainCouldNotCheckCases(t *testing.T) {
	sealed := newSealedVault(t, "open-sesame-1", "Alpha")

	cases := []struct {
		name    string
		path    string
		get     func(string) (string, error)
		wantSub string
	}{
		{
			name:    "nothing stored",
			path:    sealed,
			get:     func(string) (string, error) { return "", vault.ErrNoKeychainEntry },
			wantSub: "nothing is stored in the keychain",
		},
		{
			name:    "keychain read failed",
			path:    sealed,
			get:     func(string) (string, error) { return "", errors.New("security exited 51") },
			wantSub: "security exited 51",
		},
		{
			name:    "no vault at that path",
			path:    filepath.Join(t.TempDir(), "absent.json"),
			get:     staticPass("open-sesame-1"),
			wantSub: "there is no vault at this path yet",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			msg, code := checkKeychainOpensVault(c.path, c.get)
			if code != 2 {
				t.Fatalf("code %d, want 2: %s", code, msg)
			}
			if !strings.HasPrefix(msg, "could not be checked") {
				t.Fatalf("message must say the check did not run: %q", msg)
			}
			if !strings.Contains(msg, c.wantSub) {
				t.Fatalf("message %q does not contain %q", msg, c.wantSub)
			}
		})
	}
}

// A "check" that CREATED a vault would report that the passphrase opens it,
// truthfully, having just replaced the thing being asked about — and the
// operator's real vault would be the one they then deleted the passphrase for.
// This is the assertion that caught it: vault.AutoUnlock calls Init when no
// vault exists, so reaching for the convenient helper here is a live mistake.
func TestCheckKeychainCreatesNothingWhenVaultAbsent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")

	msg, code := checkKeychainOpensVault(path, staticPass("open-sesame-1"))
	if code != 2 {
		t.Fatalf("code %d, want 2: %s", code, msg)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("check CREATED a vault at %s (stat err %v) — it must never write", path, err)
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 0 {
		t.Fatalf("check wrote %d file(s) into an empty state dir: %v", len(ents), ents)
	}
}

// Byte-for-byte, on the success path too — the path that unlocks is the one with
// a live key in hand and therefore the one that could re-seal the file.
func TestCheckKeychainLeavesVaultByteIdentical(t *testing.T) {
	path := newSealedVault(t, "open-sesame-1", "Alpha", "Beta")
	before := digest(t, path)

	if _, code := checkKeychainOpensVault(path, staticPass("open-sesame-1")); code != 0 {
		t.Fatalf("want 0")
	}
	if after := digest(t, path); after != before {
		t.Fatalf("check rewrote vault.json: %s -> %s", before, after)
	}

	// And on the wrong-passphrase path, which is where a "repair" would be
	// tempting to write.
	if _, code := checkKeychainOpensVault(path, staticPass("wrong")); code != 1 {
		t.Fatalf("want 1")
	}
	if after := digest(t, path); after != before {
		t.Fatalf("failed check rewrote vault.json: %s -> %s", before, after)
	}
}
