package vault

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// ResolvePassphrase is the function that decides where the auto-unlock passphrase
// comes from, so it is the one worth pinning. The precedence itself matters less
// than the WARNING: the trap this whole feature can fall into is an operator
// storing the passphrase in the keychain, leaving a stale .env behind, and being
// left strictly worse off than before — same plaintext file, plus a belief that it
// is gone.

func TestResolvePassphrasePrecedenceAndWarnings(t *testing.T) {
	dir := t.TempDir()
	fileWith := func(content string) string {
		p := filepath.Join(dir, "pass-"+content)
		if err := os.WriteFile(p, []byte(content+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}

	t.Run("file beats env", func(t *testing.T) {
		got, src, _ := ResolvePassphrase("/nope/vault.json", "from-env", fileWith("fromfile"))
		if got != "fromfile" || src != FromFile {
			t.Fatalf("got %q from %q, want fromfile from %q", got, src, FromFile)
		}
	})

	t.Run("env alone", func(t *testing.T) {
		got, src, warn := ResolvePassphrase("/nope/vault.json", "from-env", "")
		if got != "from-env" || src != FromEnv {
			t.Fatalf("got %q from %q", got, src)
		}
		// On macOS an env passphrase should carry the nudge; elsewhere there is
		// nowhere to nudge them to, so silence is correct.
		if KeychainSupported() && warn == "" {
			t.Error("an env-supplied passphrase on macOS should say it is in plaintext and name the alternative")
		}
		if !KeychainSupported() && warn != "" {
			t.Errorf("no keychain on %s, so there is nothing to suggest; got %q", runtime.GOOS, warn)
		}
	})

	t.Run("nothing anywhere is not a fault", func(t *testing.T) {
		got, src, warn := ResolvePassphrase("/nope/vault.json", "", "")
		if got != "" || src != FromNowhere {
			t.Fatalf("got %q from %q, want empty from %q", got, src, FromNowhere)
		}
		if warn != "" {
			t.Errorf("running without auto-unlock is a normal choice, not something to warn about: %q", warn)
		}
	})

	t.Run("an unreadable passphrase file falls through to env", func(t *testing.T) {
		// A named-but-missing file must not silently yield an empty passphrase and
		// leave the vault locked with no explanation.
		got, src, _ := ResolvePassphrase("/nope/vault.json", "from-env", filepath.Join(dir, "does-not-exist"))
		if got != "from-env" || src != FromEnv {
			t.Fatalf("got %q from %q, want the env value", got, src)
		}
	})
}

// TestKeychainRoundTrip exercises the real macOS keychain. It writes to a unique
// account name derived from the test's temp dir and removes it afterwards, so it
// cannot collide with a real install's entry.
func TestKeychainRoundTrip(t *testing.T) {
	if !KeychainSupported() {
		t.Skipf("keychain storage is not built for %s — that is the documented behaviour, not a gap", runtime.GOOS)
	}
	if err := KeychainAvailable(); err != nil {
		t.Skipf("the macOS security tool is not usable here: %v", err)
	}

	vaultPath := filepath.Join(t.TempDir(), "vault.json")
	t.Cleanup(func() { _ = RemoveKeychainPassphrase(vaultPath) })

	// Nothing stored yet: that is a real answer, distinct from a failed lookup.
	if _, err := GetKeychainPassphrase(vaultPath); !errors.Is(err, ErrNoKeychainEntry) {
		t.Fatalf("want ErrNoKeychainEntry for an unused vault path, got %v", err)
	}

	const secret = "test-only-passphrase-9f3a"
	if err := SetKeychainPassphrase(vaultPath, secret); err != nil {
		t.Fatalf("SetKeychainPassphrase: %v", err)
	}
	got, err := GetKeychainPassphrase(vaultPath)
	if err != nil {
		t.Fatalf("GetKeychainPassphrase: %v", err)
	}
	if got != secret {
		t.Fatalf("round trip changed the value: got %q", got)
	}

	// A passphrase with the characters most likely to be mangled by a shell or by
	// argument handling. This is the case that would silently store a DIFFERENT
	// secret and lock the operator out of their own vault at the next restart —
	// which is why SetKeychainPassphrase reads back and compares.
	const awkward = `p a$s"w'o\rd	with	tabs and — dash`
	if err := SetKeychainPassphrase(vaultPath, awkward); err != nil {
		t.Fatalf("storing an awkward passphrase: %v", err)
	}
	got, err = GetKeychainPassphrase(vaultPath)
	if err != nil {
		t.Fatalf("reading back an awkward passphrase: %v", err)
	}
	if got != awkward {
		t.Fatalf("an awkward passphrase did not survive the round trip:\n stored %q\n got    %q", awkward, got)
	}

	// The case that made detect-on-read impossible: a passphrase that is ITSELF
	// valid even-length hex. Indistinguishable from `security`'s hex rendering of
	// something else, which is why the encoding is no longer left to `security`.
	const looksLikeHex = "deadbeefcafe1234"
	if err := SetKeychainPassphrase(vaultPath, looksLikeHex); err != nil {
		t.Fatalf("storing an all-hex passphrase: %v", err)
	}
	if got, err := GetKeychainPassphrase(vaultPath); err != nil || got != looksLikeHex {
		t.Fatalf("an all-hex passphrase must round-trip unchanged: got %q err %v", got, err)
	}

	// Restore the awkward one for the precedence checks below.
	if err := SetKeychainPassphrase(vaultPath, awkward); err != nil {
		t.Fatal(err)
	}

	// Now it should win when nothing is set in the environment.
	pass, src, warn := ResolvePassphrase(vaultPath, "", "")
	if pass != awkward || src != FromKeychain {
		t.Fatalf("with only the keychain set, got %q from %q", pass, src)
	}
	if warn != "" {
		t.Errorf("the keychain path is the recommended one and should warn about nothing: %q", warn)
	}

	// THE TRAP. A stale env value still wins, and that MUST be said out loud.
	pass, src, warn = ResolvePassphrase(vaultPath, "stale-env-value", "")
	if pass != "stale-env-value" || src != FromEnv {
		t.Fatalf("explicit config must win: got %q from %q", pass, src)
	}
	if warn == "" {
		t.Fatal("both a keychain entry and an env passphrase exist and nothing was said — " +
			"the operator would believe the secret had moved off disk while it had not")
	}
	for _, want := range []string{"keychain", "being ignored", "VAULT_PASSPHRASE"} {
		if !strings.Contains(warn, want) {
			t.Errorf("the warning does not mention %q, so it does not tell them what to do: %q", want, warn)
		}
	}

	// Removing is idempotent: the requested end state already holding is not an error.
	if err := RemoveKeychainPassphrase(vaultPath); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if err := RemoveKeychainPassphrase(vaultPath); err != nil {
		t.Fatalf("removing twice must not be an error: %v", err)
	}
	if _, err := GetKeychainPassphrase(vaultPath); !errors.Is(err, ErrNoKeychainEntry) {
		t.Fatalf("after removal, want ErrNoKeychainEntry, got %v", err)
	}
}

// TestForeignKeychainEntryIsRefusedNotGuessed: an entry this code did not write
// has an unknown encoding, and guessing produces a wrong-passphrase error that
// points nowhere near the cause. It must refuse and say what to do.
func TestForeignKeychainEntryIsRefusedNotGuessed(t *testing.T) {
	if !KeychainSupported() {
		t.Skipf("not built for %s", runtime.GOOS)
	}
	if err := KeychainAvailable(); err != nil {
		t.Skipf("security tool unusable: %v", err)
	}
	vaultPath := filepath.Join(t.TempDir(), "vault.json")
	t.Cleanup(func() { _ = RemoveKeychainPassphrase(vaultPath) })

	// Written the way a human with Keychain Access would: no marker.
	if err := writeRawKeychainForTest(vaultPath, "hand-written-passphrase"); err != nil {
		t.Skipf("could not stage a foreign entry: %v", err)
	}
	_, err := GetKeychainPassphrase(vaultPath)
	if err == nil {
		t.Fatal("a foreign entry was accepted; its encoding is unknowable and using it risks a silent wrong passphrase")
	}
	if !strings.Contains(err.Error(), "vault-passphrase set") {
		t.Errorf("the refusal should say how to fix it: %v", err)
	}
}

// TestEmptyStoredValueIsNotAPassphrase — an empty entry would unlock nothing and
// surface as "wrong passphrase", which sends the operator looking in the wrong
// place entirely.
func TestRefusesToStoreEmpty(t *testing.T) {
	if !KeychainSupported() {
		t.Skipf("not built for %s", runtime.GOOS)
	}
	err := SetKeychainPassphrase(filepath.Join(t.TempDir(), "vault.json"), "   ")
	if err == nil {
		t.Fatal("storing a blank passphrase was allowed; it would report as a wrong passphrase later")
	}
}

// TestUnsupportedPlatformSaysSo guards the stated default: other platforms are
// explicitly unbuilt, never silently no-op.
func TestUnsupportedPlatformSaysSo(t *testing.T) {
	if KeychainSupported() {
		t.Skip("this build does support the keychain; the unsupported path cannot be exercised here")
	}
	for name, err := range map[string]error{
		"available": KeychainAvailable(),
		"remove":    RemoveKeychainPassphrase("/x/vault.json"),
		"set":       SetKeychainPassphrase("/x/vault.json", "p"),
	} {
		if !errors.Is(err, ErrUnsupported) {
			t.Errorf("%s: want ErrUnsupported on %s, got %v", name, runtime.GOOS, err)
		}
	}
	if !strings.Contains(ErrUnsupported.Error(), runtime.GOOS) {
		t.Error("the refusal should name the platform it is refusing on")
	}
}

// writeRawKeychainForTest stores a value with NO marker, standing in for an entry
// a human created by hand in Keychain Access.
func writeRawKeychainForTest(vaultPath, value string) error {
	return execSecurityForTest("add-generic-password",
		"-a", vaultPath, "-s", keychainService, "-w", value, "-U")
}

func execSecurityForTest(args ...string) error {
	return exec.Command("security", args...).Run()
}
