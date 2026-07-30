package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bloxsmith/internal/config"
	"bloxsmith/internal/vault"
)

// `vault-passphrase rotate` is the one command that can permanently destroy the
// tenant keys inside a vault — a bad write with no way back loses every stored
// API key. Every assertion here is about that specific risk: an unverified old
// passphrase must never be trusted, a failed verification must always come back
// out exactly as it went in, and a backup must always be there to prove it.
//
// newSealedVault, digest and staticPass come from passcli_test.go (same
// package) — reused rather than re-authored so these tests exercise the same
// fixture-writing path the `check` tests already trust.

func TestRotateSucceedsNewOpensOldDoesNot(t *testing.T) {
	path := newSealedVault(t, "old-passphrase-1", "Alpha", "Beta")

	result := rotateVault(path, "old-passphrase-1", "brand-new-passphrase-1", realVerify)
	if !result.ok {
		t.Fatalf("rotate did not succeed: %s", result.msg)
	}

	// The NEW passphrase opens it, with the same tenants.
	v := vault.New(path)
	if err := v.Unlock("brand-new-passphrase-1"); err != nil {
		t.Fatalf("new passphrase does not open the rotated vault: %v", err)
	}
	if n := v.TenantCount(); n != 2 {
		t.Fatalf("tenant count after rotate = %d, want 2", n)
	}
	v.Lock()

	// The OLD passphrase no longer does.
	v2 := vault.New(path)
	err := v2.Unlock("old-passphrase-1")
	if !errors.Is(err, vault.ErrWrongPassphrase) {
		t.Fatalf("old passphrase still opens the vault after rotate (err=%v) — it was not invalidated", err)
	}
}

func TestRotateWrongCurrentPassphraseRefusesByteIdentical(t *testing.T) {
	path := newSealedVault(t, "the-real-one-1", "Alpha")
	before := digest(t, path)

	result := rotateVault(path, "not-the-real-one", "some-new-passphrase-1", realVerify)
	if result.ok {
		t.Fatalf("rotate succeeded with the wrong current passphrase")
	}
	if !strings.Contains(result.msg, "does NOT open") {
		t.Fatalf("message does not say the current passphrase failed: %q", result.msg)
	}
	if result.backupPath != "" {
		t.Fatalf("a backup was created despite refusing before any write: %s", result.backupPath)
	}
	if after := digest(t, path); after != before {
		t.Fatalf("vault.json changed on a refused rotate: %s -> %s", before, after)
	}
}

func TestRotateTooShortNewPassphraseRefusedByteIdentical(t *testing.T) {
	path := newSealedVault(t, "old-passphrase-4", "Alpha")
	before := digest(t, path)

	result := rotateVault(path, "old-passphrase-4", "short", realVerify)
	if result.ok {
		t.Fatalf("rotate accepted a too-short new passphrase")
	}
	if !strings.Contains(result.msg, "at least 8 characters") {
		t.Fatalf("message does not cite the length rule: %q", result.msg)
	}
	if after := digest(t, path); after != before {
		t.Fatalf("vault.json changed on a refused (too-short) rotate: %s -> %s", before, after)
	}
}

func TestRotateNoVaultRefuses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	result := rotateVault(path, "whatever-passphrase", "a-new-passphrase-1", realVerify)
	if result.ok {
		t.Fatalf("rotate succeeded against a vault that does not exist")
	}
	if !strings.Contains(result.msg, "nothing to rotate") {
		t.Fatalf("message does not say there was nothing to rotate: %q", result.msg)
	}
}

// The failure that matters most: verification runs AFTER the new file is
// written, so a failure there must restore the ORIGINAL bytes, not leave a
// vault that only the (unverified) new passphrase might open.
func TestRotateVerifyFailureRestoresBackupByteIdentical(t *testing.T) {
	path := newSealedVault(t, "real-pass-2", "Alpha", "Beta")
	before := digest(t, path)

	failingVerify := func(string, string) (int, error) {
		return 0, errors.New("simulated verification failure")
	}
	result := rotateVault(path, "real-pass-2", "brand-new-passphrase-2", failingVerify)
	if result.ok {
		t.Fatalf("rotate reported success despite a failing verification")
	}
	if !strings.Contains(result.msg, "restored") {
		t.Fatalf("message does not say the backup was restored: %q", result.msg)
	}

	// vault.json is back to exactly what it was before rotate touched it.
	if after := digest(t, path); after != before {
		t.Fatalf("vault.json was not restored byte-identical: %s -> %s", before, after)
	}

	// The OLD passphrase still opens it, with both tenants intact.
	v := vault.New(path)
	if err := v.Unlock("real-pass-2"); err != nil {
		t.Fatalf("old passphrase no longer opens the restored vault: %v", err)
	}
	if n := v.TenantCount(); n != 2 {
		t.Fatalf("tenant count after restore = %d, want 2", n)
	}
	v.Lock()
}

// The backup itself is the safety net every other guarantee here depends on: it
// must exist, and it must still open with the OLD passphrase — proving it is a
// real, independent copy and not just a rename of the live file.
func TestRotateBackupCreatedAndOpensWithOldPassphrase(t *testing.T) {
	path := newSealedVault(t, "old-pass-3", "Solo")

	result := rotateVault(path, "old-pass-3", "brand-new-passphrase-3", realVerify)
	if !result.ok {
		t.Fatalf("rotate did not succeed: %s", result.msg)
	}
	if result.backupPath == "" {
		t.Fatalf("no backup path reported on a successful rotate")
	}
	if _, err := os.Stat(result.backupPath); err != nil {
		t.Fatalf("backup file does not exist at %s: %v", result.backupPath, err)
	}

	bv := vault.New(result.backupPath)
	if err := bv.Unlock("old-pass-3"); err != nil {
		t.Fatalf("backup does not open with the OLD passphrase: %v", err)
	}
	if n := bv.TenantCount(); n != 1 {
		t.Fatalf("backup tenant count = %d, want 1", n)
	}
	bv.Lock()

	// And the backup name says exactly what it is, so an operator scanning the
	// directory a week later does not have to guess.
	if !strings.Contains(filepath.Base(result.backupPath), "bak-before-rotate-") {
		t.Fatalf("backup filename does not self-describe: %s", result.backupPath)
	}
}

// currentPassphraseSourceLine is what `rotate` prints BEFORE prompting for the
// new passphrase — the same gap class as the v3.30.1 status bug, except here it
// is about to ACT on the unverified source rather than merely report it. Both
// shapes must be covered: an env var that came from a file (name the file), and
// the keychain, which envSourceOf reports as "" and which must still be named
// plainly rather than leaving a blank line.
func TestCurrentPassphraseSourceLineNamesTheRightSource(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("VAULT_PASSPHRASE=whatever\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	os.Unsetenv("VAULT_PASSPHRASE")
	t.Cleanup(func() { os.Unsetenv("VAULT_PASSPHRASE") })
	config.LoadDotEnv(envPath)

	got := currentPassphraseSourceLine(vault.FromEnv)
	if !strings.Contains(got, "the current passphrase came from: VAULT_PASSPHRASE") {
		t.Fatalf("does not name VAULT_PASSPHRASE as the source: %q", got)
	}
	absEnvPath, err := filepath.Abs(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "VAULT_PASSPHRASE was read from: "+absEnvPath) {
		t.Fatalf("does not name the .env file it was actually read from: %q", got)
	}

	got = currentPassphraseSourceLine(vault.FromKeychain)
	if strings.TrimSpace(got) != "the current passphrase came from: macOS keychain" {
		t.Fatalf("keychain source is not named plainly (blank or wrong): %q", got)
	}
}
