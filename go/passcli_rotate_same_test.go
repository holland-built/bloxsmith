package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bloxsmith/internal/vault"
)

// ROTATING TO THE PASSPHRASE YOU ARE ROTATING AWAY FROM (#97).
//
// `rotate` is the only command that can actually invalidate an exposed
// passphrase. Before this guard existed, re-entering the current one ran the
// whole rotation honestly — Unlock succeeded, Rotate re-derived against a fresh
// salt and wrote, the fresh-instance verification opened the result and counted
// the same tenants — and then printed "the vault now opens ONLY with the new
// passphrase". The exposed passphrase went on opening it.
//
// These tests are about that one sentence being true whenever it is printed.
// The helpers (newSealedVault, digest) come from passcli_test.go.

func TestRotateRefusesTheSamePassphrase(t *testing.T) {
	const pass = "exposed-passphrase-1"
	path := newSealedVault(t, pass, "Alpha", "Beta")
	before := digest(t, path)

	result := rotateVault(path, pass, pass, realVerify)

	if result.ok {
		t.Fatalf("rotate reported success for an unchanged passphrase: %s", result.msg)
	}
	// The message has to name the actual reason. Without this the test would also
	// pass on an unrelated early refusal — a missing vault, a short passphrase —
	// and report a guard that is not there.
	if !strings.Contains(result.msg, "same as the current one") {
		t.Fatalf("refusal does not say the passphrase was unchanged: %q", result.msg)
	}
	if strings.Contains(result.msg, "rotated") {
		t.Fatalf("refusal still claims a rotation happened: %q", result.msg)
	}
	if result.backupPath != "" {
		t.Fatalf("a backup path was reported for a rotation that never ran: %s", result.backupPath)
	}

	// Nothing was written anywhere. backupPath == "" is what the code SAYS; this
	// is the directory listing, which is what an operator would see.
	if n := countBackups(t, path); n != 0 {
		t.Fatalf("%d backup file(s) left behind by a refused rotation", n)
	}
	// A current-version vault is byte-identical afterwards. (The legacy case is
	// deliberately not asserted this way — see the v1 test below.)
	if after := digest(t, path); after != before {
		t.Fatalf("vault.json changed on a refused rotation: %s -> %s", before, after)
	}

	v := vault.New(path)
	if err := v.Unlock(pass); err != nil {
		t.Fatalf("the vault no longer opens after a refused rotation: %v", err)
	}
	if n := v.TenantCount(); n != 2 {
		t.Fatalf("tenant count = %d, want 2", n)
	}
	v.Lock()
}

// The same refusal against a REAL legacy v1 vault — the fixture the Python
// server wrote, copied out of internal/vault/testdata so the checked-in evidence
// is never the thing under test.
//
// IT DELIBERATELY MAKES NO BYTE-IDENTITY CLAIM. rotateVault must verify the
// current passphrase before it can tell a wrong one from an unchanged one, and
// Unlock migrates a v1 vault to the current scrypt parameters in place
// (vault.go, migrateLocked). So the file legitimately may have changed by the
// time the guard runs. What must hold is what the refusal actually says: the
// rotation did not run, no backup was written, and the vault still opens — with
// everything that was in it.
func TestRotateRefusesTheSamePassphraseOnALegacyVault(t *testing.T) {
	const fixturePass = "test-passphrase-123"
	path := copyV1Fixture(t)

	result := rotateVault(path, fixturePass, fixturePass, realVerify)

	if result.ok {
		t.Fatalf("rotate reported success for an unchanged passphrase: %s", result.msg)
	}
	if !strings.Contains(result.msg, "same as the current one") {
		t.Fatalf("refusal does not say the passphrase was unchanged: %q", result.msg)
	}
	if n := countBackups(t, path); n != 0 {
		t.Fatalf("%d backup file(s) left behind by a refused rotation", n)
	}

	v := vault.New(path)
	if err := v.Unlock(fixturePass); err != nil {
		t.Fatalf("the legacy vault no longer opens after a refused rotation: %v", err)
	}
	if n := v.TenantCount(); n != 2 {
		t.Fatalf("tenant count = %d, want 2 — the fixture's contents did not survive", n)
	}
	v.Lock()
}

// WHICH QUESTION EACH SUBCOMMAND ASKS.
//
// The defect had two halves: rotate accepted the unchanged passphrase, and its
// prompt invited one. `set` and `rotate` asked in identical words ("Vault
// passphrase:"), and rotate printed that one line under "the current passphrase
// came from: ...".
//
// Asserting the two constants differ would not catch the call sites being
// swapped, so this substitutes readPassphrase and checks the label rotate
// actually asks with. `set` is not driven the same way on purpose: passSet
// refuses before prompting on any machine without a keychain, and on one with a
// keychain it would write to it.
func TestRotatePromptsForTheNewPassphraseNotTheCurrentOne(t *testing.T) {
	if promptSetPassphrase == promptNewPassphrase {
		t.Fatalf("set and rotate ask in identical words (%q) — that is the wording that "+
			"invited #97", promptSetPassphrase)
	}

	const pass = "exposed-passphrase-2"
	path := newSealedVault(t, pass, "Alpha")

	asked := ""
	orig := readPassphrase
	readPassphrase = func(label string) (string, error) {
		asked = label
		return pass, nil // the operator confirms what they were shown
	}
	t.Cleanup(func() { readPassphrase = orig })

	if code := passRotate(path, pass, ""); code != 1 {
		t.Fatalf("passRotate exit code = %d, want 1 for a refused rotation", code)
	}
	if asked != promptNewPassphrase {
		t.Fatalf("rotate prompted with %q, want %q", asked, promptNewPassphrase)
	}
	if !strings.Contains(asked, "New") {
		t.Fatalf("rotate's prompt does not say the passphrase is a new one: %q", asked)
	}
	if n := countBackups(t, path); n != 0 {
		t.Fatalf("%d backup file(s) left behind by a refused rotation", n)
	}
}

// countBackups counts the .bak-before-rotate-* files sitting beside a vault.
// The directory listing, not the reported backupPath: a rotation that wrote one
// and forgot to report it is the same failure as one that reported a path it
// never wrote.
func countBackups(t *testing.T, vaultPath string) int {
	t.Helper()
	matches, err := filepath.Glob(vaultPath + ".bak-before-rotate-*")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	return len(matches)
}

// copyV1Fixture copies the Python server's real v1 vault into a temp dir and
// returns the copy. Copied, never opened in place: Unlock migrates a v1 vault,
// so testing against the checked-in file would rewrite the evidence and every
// later run would be testing a v2 vault while claiming to test a v1 one.
func copyV1Fixture(t *testing.T) string {
	t.Helper()
	src, err := os.ReadFile(filepath.Join("internal", "vault", "testdata", "python-vault-fixture.json"))
	if err != nil {
		t.Fatalf("read the v1 fixture: %v", err)
	}
	path := filepath.Join(t.TempDir(), "vault.json")
	if err := os.WriteFile(path, src, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
