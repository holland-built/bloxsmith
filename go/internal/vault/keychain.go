package vault

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// THE VAULT PASSPHRASE IN THE OS KEYCHAIN
//
// v3.23.0 documented this and did not fix it: with auto-unlock the passphrase
// lives in a `.env` in the SAME DIRECTORY as vault.json. So the vault's own
// encryption — scrypt (kdfByVersion in vault.go), Fernet, 0600 — protects a
// stolen disk, a backup or a copied volume, and then the file sitting next to it
// hands the passphrase to anyone who took the same copy. The control was
// cancelling itself out. Note that hardening the KDF does nothing about this:
// no scrypt cost matters when the passphrase is readable beside the file.
//
// WHAT THIS BUYS, EXACTLY. On macOS the login keychain is encrypted at rest under
// the user's login password and only unlocked after they log in. Moving the
// passphrase there closes precisely the hole the `.env` opened: a stolen disk, a
// Time Machine backup, a copied state directory or a mounted volume no longer
// carry it, which is the same property the vault encryption was supposed to have
// in the first place.
//
// WHAT IT DOES NOT BUY, stated rather than implied. It does NOT stop a process
// already running as the operator. This binary is not distributed with a stable
// signed identity (installed by curl, Homebrew or a tarball), so the keychain item
// cannot be ACL-scoped to it in a way that would make other apps prompt — anything
// running as that user can read the item back exactly as this program does. That
// is the same limit README.md and DEPLOYMENT.md already state for the vault and
// for the audit key, and it is inherent to unattended unlock: something on the
// machine has to be able to get the secret without a human, so anything with the
// operator's privileges can too.
//
// So the honest summary is: the passphrase stops travelling with the disk. It does
// not become secret from the machine.
//
// MACOS ONLY, AND SAID SO. Windows DPAPI and the Linux Secret Service are NOT
// built. Every entry point below returns ErrUnsupported naming the platform,
// rather than quietly doing nothing and letting an operator believe their
// passphrase moved when it did not.

// keychainService and the account name together identify the item. The account is
// the vault file's own path, so a machine running more than one vault (this repo's
// dev copy and the installed service both do) gets one item each instead of
// silently sharing — and sharing would mean the wrong passphrase, reported as a
// wrong-passphrase error the operator could not explain.
const keychainService = "bloxsmith-vault-passphrase"

// storedPrefix marks a value this code wrote, and the reason it exists is a trap
// in the macOS `security` tool that would otherwise lock an operator out of their
// own vault.
//
// `security find-generic-password -w` returns the secret RAW when it looks
// printable and SILENTLY AS HEX when it does not. A passphrase containing a tab,
// an em-dash, or any non-ASCII byte therefore comes back as a string of hex digits,
// which is then used as the passphrase, fails to decrypt, and surfaces as "wrong
// passphrase" with nothing pointing at the real cause. Observed directly:
// storing `p a$s"w'o\rd<TAB>with<TAB>tabs and — dash` read back as
// "70206124732277276f5c726409777974...".
//
// Detecting that on read is not reliably possible — a passphrase that happens to
// be valid hex of even length ("deadbeef") is indistinguishable from hex output.
// So the encoding is taken out of `security`'s hands: what is stored is always
// this prefix plus lowercase hex, which is always printable, so it always comes
// back raw. Decoding is then unambiguous.
const storedPrefix = "bxv1:"

// ErrUnsupported is returned on every platform where this is not built.
var ErrUnsupported = errors.New("keychain storage for the vault passphrase is not built for " + runtime.GOOS +
	" — only macOS is supported. Use VAULT_PASSPHRASE_FILE with a file the log's writer cannot reach, " +
	"or run without auto-unlock and unlock from the browser after each restart")

// ErrNoKeychainEntry means the lookup ran and found nothing. Distinct from a
// failed lookup: "there is no entry" and "I could not tell whether there is an
// entry" must not be the same answer, because the first is a reason to fall back
// and the second is a reason to say so.
var ErrNoKeychainEntry = errors.New("no keychain entry for this vault")

// KeychainSupported reports whether this build can use the OS keychain.
func KeychainSupported() bool { return runtime.GOOS == "darwin" }

// KeychainAvailable reports whether the `security` tool this uses is actually
// present and runnable, so a caller can tell "not supported here" from "supported
// but broken on this machine".
func KeychainAvailable() error {
	if !KeychainSupported() {
		return ErrUnsupported
	}
	if _, err := exec.LookPath("security"); err != nil {
		return fmt.Errorf("the macOS `security` tool could not be found, so the keychain cannot be reached: %w", err)
	}
	return nil
}

// GetKeychainPassphrase reads the stored passphrase for vaultPath.
//
// It shells out to `security` rather than linking the Security framework because
// releases are built with CGO_ENABLED=0 (see .goreleaser.yaml) and a cgo keychain
// binding would end that. The passphrase comes back on the child's stdout, which
// is captured here — it never appears in a command line, so it is not visible in
// `ps` on this path. Storing it is the exposed one; see SetKeychainPassphrase.
func GetKeychainPassphrase(vaultPath string) (string, error) {
	if err := KeychainAvailable(); err != nil {
		return "", err
	}
	out, err := exec.Command("security", "find-generic-password",
		"-a", vaultPath, "-s", keychainService, "-w").Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			// 44 is SecKeychain's errSecItemNotFound. Treated as "nothing stored",
			// which is a real answer; any other exit status is a failure to read.
			if ee.ExitCode() == 44 {
				return "", ErrNoKeychainEntry
			}
			return "", fmt.Errorf("keychain lookup failed (security exited %d): %s",
				ee.ExitCode(), strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("keychain lookup failed: %w", err)
	}
	// security prints the value with a trailing newline and nothing else.
	raw := strings.TrimRight(string(out), "\r\n")
	if raw == "" {
		// An empty stored value is not a usable passphrase and must not be
		// returned as one — it would unlock nothing and report a wrong passphrase.
		return "", ErrNoKeychainEntry
	}
	if !strings.HasPrefix(raw, storedPrefix) {
		// Not written by this code. Rather than guess whether it is a raw
		// passphrase or `security`'s hex rendering of one — which cannot be told
		// apart — refuse and say so. Guessing wrong yields a wrong-passphrase
		// error that points nowhere near the cause.
		return "", fmt.Errorf("the keychain entry for this vault was not written by "+
			"`bloxsmith vault-passphrase set` (no %q marker), so its encoding is unknown and it will not be "+
			"used. Re-run `bloxsmith vault-passphrase set` to replace it", storedPrefix)
	}
	b, err := hex.DecodeString(strings.TrimPrefix(raw, storedPrefix))
	if err != nil {
		return "", fmt.Errorf("the keychain entry for this vault is corrupt (not valid hex after the marker): %w", err)
	}
	if len(b) == 0 {
		return "", ErrNoKeychainEntry
	}
	return string(b), nil
}

// SetKeychainPassphrase stores (or replaces) the passphrase for vaultPath.
//
// KNOWN, UNAVOIDABLE EXPOSURE, and the caller is told to print it: `security` has
// no way to take the secret on stdin, so it must go on the argument list, where
// another process on this machine can see it in `ps` for as long as the command
// runs. That is a fraction of a second, once, when an operator deliberately runs
// this — against a `.env` file that otherwise holds the same secret in plaintext
// for the life of the install. It is a real hole and it is smaller than the one it
// replaces, which is the only claim being made.
func SetKeychainPassphrase(vaultPath, passphrase string) error {
	if err := KeychainAvailable(); err != nil {
		return err
	}
	if strings.TrimSpace(passphrase) == "" {
		return errors.New("refusing to store an empty passphrase")
	}
	// -U updates an existing item instead of failing with a duplicate error.
	// Hex-encoded, always: see storedPrefix. Note this does NOT reduce the `ps`
	// exposure below in any meaningful way — hex is trivially reversible — so it is
	// not claimed as one.
	cmd := exec.Command("security", "add-generic-password",
		"-a", vaultPath, "-s", keychainService, "-w", storedPrefix+hex.EncodeToString([]byte(passphrase)), "-U",
		"-l", "Bloxsmith vault passphrase",
		"-D", "vault passphrase",
		"-j", "Unlocks "+vaultPath+" at startup. Written by `bloxsmith vault-passphrase set`.")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("could not store the passphrase in the keychain: %w: %s",
			err, strings.TrimSpace(string(out)))
	}
	// Read it back. A store that reported success but did not land would leave the
	// operator believing they can now delete their .env, which would lock them out
	// of their own vault at the next restart.
	got, err := GetKeychainPassphrase(vaultPath)
	if err != nil {
		return fmt.Errorf("the passphrase was stored but could not be read back, so it is not safe to rely on: %w", err)
	}
	if got != passphrase {
		return errors.New("the passphrase read back from the keychain does not match what was stored")
	}
	return nil
}

// RemoveKeychainPassphrase deletes the entry. A missing entry is not an error —
// the requested end state (nothing stored) already holds.
func RemoveKeychainPassphrase(vaultPath string) error {
	if err := KeychainAvailable(); err != nil {
		return err
	}
	cmd := exec.Command("security", "delete-generic-password",
		"-a", vaultPath, "-s", keychainService)
	if out, err := cmd.CombinedOutput(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 44 {
			return nil
		}
		return fmt.Errorf("could not remove the keychain entry: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
