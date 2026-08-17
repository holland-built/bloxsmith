package vault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A CONFIGURED VAULT_PASSPHRASE_FILE THAT SUPPLIED NOTHING MUST SAY SO.
//
// `.env.example` tells the operator to PREFER this form — "prefer the *_FILE form
// (Docker/K8s secret) over the raw env var" — and the stock docker-compose file
// mounts nothing at the /run/secrets path it suggests. Before this warning existed,
// following that advice produced pass="", src="none", warn="": byte-identical to
// setting nothing at all. The vault never auto-unlocked and no channel said why —
// not the startup log (main.go:428), not `vault-passphrase status` (passcli.go:154),
// not `vault-passphrase rotate` (passcli_rotate.go:167), not restore
// (restorecli_apply.go:256). All four read the same third return value, so they are
// all fixed by fixing it.
//
// SCOPE: only the "set but supplied nothing" cases. keychain_test.go owns the
// precedence table and the keychain-vs-env warnings, and nothing here re-asserts
// them.
//
// These tests must not depend on this machine's keychain. Every case below either
// asserts on a substring of the warning (so a keychain sentence appended by
// ResolvePassphrase cannot break it) or on the returned passphrase, which the
// keychain cannot change when an env value is present.

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatalf("writing %s: %v", p, err)
	}
	return p
}

// The case #126 was filed for: a path that does not exist.
func TestResolvePassphrase_UnreadableFileIsNotSilent(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "run", "secrets", "vault_pass")
	vaultPath := filepath.Join(t.TempDir(), "vault.json")

	pass, _, warn := ResolvePassphrase(vaultPath, "", missing)
	if pass != "" {
		t.Errorf("pass = %q, want \"\" — the file does not exist", pass)
	}
	if warn == "" {
		t.Fatal("warn is empty: a path that could not be read is reported as though nothing was set")
	}
	if !strings.Contains(warn, missing) {
		t.Errorf("warn does not name the path that failed.\nwant it to contain: %s\ngot: %s", missing, warn)
	}
	if !strings.Contains(warn, "VAULT_PASSPHRASE_FILE") {
		t.Errorf("warn does not name the variable: %s", warn)
	}
}

// Set-and-unreadable must be DISTINGUISHABLE from not set at all. This is the
// assertion the original defect fails: both cases returned the same three values.
func TestResolvePassphrase_UnreadableFileDiffersFromUnset(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope")
	vaultPath := filepath.Join(t.TempDir(), "vault.json")

	_, _, warnSet := ResolvePassphrase(vaultPath, "", missing)
	_, _, warnUnset := ResolvePassphrase(vaultPath, "", "")
	if warnSet == warnUnset {
		t.Errorf("a configured-but-unreadable file and no file at all produce the same warning (%q), "+
			"so the operator cannot tell which happened", warnSet)
	}
}

// A file that reads fine but is EMPTY used to SHADOW VAULT_PASSPHRASE: the empty
// read was taken as the answer, so a working passphrase stopped being used with
// nothing said. It now falls through and explains itself.
func TestResolvePassphrase_EmptyFileFallsBackAndSaysSo(t *testing.T) {
	dir := t.TempDir()
	empty := writeFile(t, dir, "vault_pass", "   \n")
	vaultPath := filepath.Join(dir, "vault.json")

	pass, src, warn := ResolvePassphrase(vaultPath, "from-env", empty)
	if pass != "from-env" {
		t.Errorf("pass = %q, want %q — an empty file must not shadow a set VAULT_PASSPHRASE", pass, "from-env")
	}
	if src != FromEnv {
		t.Errorf("src = %q, want %q", src, FromEnv)
	}
	if !strings.Contains(warn, "empty") {
		t.Errorf("warn does not say the file was empty: %s", warn)
	}
	if !strings.Contains(warn, empty) {
		t.Errorf("warn does not name the file: %s", warn)
	}
}

// A readable, populated file still wins and still warns about nothing of its own.
// Without this the three tests above could all be satisfied by a function that
// warns unconditionally.
func TestResolvePassphrase_ReadableFileWinsWithNoFileWarning(t *testing.T) {
	dir := t.TempDir()
	good := writeFile(t, dir, "vault_pass", "  from-file\n")
	vaultPath := filepath.Join(dir, "vault.json")

	pass, src, warn := ResolvePassphrase(vaultPath, "from-env", good)
	if pass != "from-file" {
		t.Errorf("pass = %q, want %q — the file form takes precedence", pass, "from-file")
	}
	if src != FromFile {
		t.Errorf("src = %q, want %q", src, FromFile)
	}
	// A keychain sentence may legitimately be here; a complaint about THIS file
	// may not.
	for _, bad := range []string{"could not be read", "is empty"} {
		if strings.Contains(warn, bad) {
			t.Errorf("warn complains about a file that read fine (%q): %s", bad, warn)
		}
	}
}

// The unreadable-file warning must survive alongside the source advice, not
// replace it or be replaced by it. An operator who set BOTH needs to know the file
// failed AND that the plaintext env var is what is being used.
func TestResolvePassphrase_UnreadableFileWarningSurvivesTheEnvWarning(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope")
	vaultPath := filepath.Join(t.TempDir(), "vault.json")

	pass, src, warn := ResolvePassphrase(vaultPath, "from-env", missing)
	if pass != "from-env" || src != FromEnv {
		t.Fatalf("pass/src = %q/%q, want %q/%q", pass, src, "from-env", FromEnv)
	}
	if !strings.Contains(warn, "could not be read") {
		t.Errorf("the file failure is missing from the warning: %s", warn)
	}
	if !strings.Contains(warn, "VAULT_PASSPHRASE_FILE") {
		t.Errorf("the variable is not named: %s", warn)
	}
}

// NO PassphraseFromEnv TEST. There was one, asserting that PassphraseFromEnv
// and ResolvePassphrase agreed about an empty file — and its own comment
// admitted PassphraseFromEnv "is not called anywhere in this repo today". Both
// the helper and the test are gone. Nothing was lost: the three things it
// checked are each already pinned above against the function that IS reachable
// — empty file falls back to the env var (EmptyFileFallsBackAndSaysSo), a
// missing one does too (UnreadableFileWarningSurvivesTheEnvWarning), and a
// readable file wins and is trimmed (ReadableFileWinsWithNoFileWarning).
