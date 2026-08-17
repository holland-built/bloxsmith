package main

import (
	"errors"
	"fmt"
	"os"
	"time"

	"bloxsmith/internal/vault"
)

// `bloxsmith vault-passphrase rotate` — change the vault's ACTUAL encryption
// passphrase, not just the copy of it sitting in the keychain.
//
// THE GAP THIS CLOSES. `set` only ever stored a passphrase for auto-unlock; it
// never touched vault.json. So an operator whose passphrase was exposed (shared
// over chat, left in shell history, a stolen laptop) had no way to actually
// invalidate it — the old passphrase went on decrypting the tenant keys inside
// forever, keychain entry or not. This is the one command that re-encrypts the
// file itself.
//
// WHAT'S AT STAKE. A vault holds every tenant's API key. Get this wrong — rotate
// from an unverified current passphrase, or lose the file mid-write — and the
// operator loses every credential in it with no recovery but re-adding each
// tenant by hand. Every safeguard below exists because of that, not out of
// caution for its own sake.

// rotateOutcome is what rotateVault decided, kept separate from printing so the
// backup-restore logic can be tested without a terminal.
type rotateOutcome struct {
	ok         bool
	msg        string
	backupPath string // "" only when nothing was ever written
}

// rotateVault does the actual work: verify the CURRENT passphrase opens the
// vault, back up the file, re-encrypt under the NEW passphrase, and verify the
// result with a fresh Vault instance before trusting it. It touches neither the
// keychain nor a terminal, so every branch — including the one that restores a
// backup — runs the same way under `go test` as it does for a real operator.
//
// verify is injected exactly like checkKeychainOpensVault's getPass parameter:
// the real path (realVerify, below) opens a FRESH Vault with the new passphrase
// and reads TenantCount(). Tests substitute one that reports a failure, so the
// restore-the-backup path can be exercised without needing to actually corrupt
// real cryptography to trigger it.
func rotateVault(vaultPath, curPass, newPass string, verify func(path, pass string) (int, error)) rotateOutcome {
	v := vault.New(vaultPath)
	if !v.Exists() {
		return rotateOutcome{msg: "no vault exists at this path yet — nothing to rotate."}
	}

	// Verify the CURRENT passphrase BEFORE anything is touched. Proceeding on an
	// unverified current passphrase — trusting whatever ResolvePassphrase handed
	// back without checking it actually opens the vault — is exactly the mistake
	// this command exists to rule out; a wrong one here re-encrypts nothing (yet
	// costs nothing), a wrong one after the backup is deleted costs the vault.
	if err := v.Unlock(curPass); err != nil {
		if errors.Is(err, vault.ErrWrongPassphrase) {
			return rotateOutcome{msg: "the current passphrase does NOT open this vault — refusing to rotate. " +
				"Nothing was changed. Run `bloxsmith vault-passphrase status` to see what passphrase is " +
				"actually configured, fix it, then try again."}
		}
		return rotateOutcome{msg: "could not open the vault to verify the current passphrase: " + err.Error()}
	}
	defer v.Lock()
	beforeCount := v.TenantCount()

	// THE NEW PASSPHRASE MUST ACTUALLY BE A NEW ONE.
	//
	// Without this, re-entering the current passphrase runs the whole rotation
	// honestly — Unlock succeeds, Rotate re-derives against a fresh salt and
	// writes, the fresh-instance verification opens the result and counts the same
	// tenants — and then reports "the vault now opens ONLY with the new
	// passphrase". Every word of that is false, and the operator's next act, on
	// this command's own advice, is to delete the backup and consider an exposed
	// passphrase invalidated. A new salt is not a rotation.
	//
	// It is the LIKELY mistake, not a far-fetched one: until this change the
	// prompt asked "Vault passphrase:" — the same words `set` uses — one line
	// after printing where the CURRENT passphrase came from.
	//
	// Placed BEFORE the length floor below: a passphrase that is both unchanged
	// and short would otherwise be answered with "must be at least 8 characters",
	// sending the operator to fix the wrong thing.
	//
	// The message does NOT claim the file is byte-identical, because for a legacy
	// v1 vault it may not be: the Unlock above migrates it to the current scrypt
	// parameters in place (vault.go, migrateLocked). That migration is a
	// fix-forward under the same passphrase and is not this rotation; what the
	// message claims — the rotation did not run, no backup was written — is true
	// either way.
	if newPass == curPass {
		return rotateOutcome{msg: "the new passphrase is the same as the current one — the rotation did " +
			"NOT run and no backup was written. A rotation exists to make the old passphrase stop working; " +
			"re-sealing under the same one leaves it opening this vault exactly as before. Run it again with " +
			"a passphrase you have not used for this vault."}
	}

	// Minimum length matches Init's rule exactly — a rotate must not be able to
	// downgrade a vault to a weaker passphrase than a fresh one would ever accept.
	if len(newPass) < 8 {
		return rotateOutcome{msg: "the new passphrase must be at least 8 characters — no change made."}
	}

	// Back up BEFORE writing anything, and never overwrite an existing backup: a
	// second rotate attempt on the same day must not clobber the one safety net a
	// first, failed attempt left behind.
	backupPath := vaultPath + ".bak-before-rotate-" + time.Now().UTC().Format("20060102T150405Z")
	if _, err := os.Stat(backupPath); err == nil {
		return rotateOutcome{msg: "refusing to rotate: a backup already exists at " + backupPath +
			" — move it aside first, or a real failure could be mistaken for this one's leftovers."}
	}
	orig, err := os.ReadFile(vaultPath)
	if err != nil {
		return rotateOutcome{msg: "could not read the vault to back it up: " + err.Error()}
	}
	if err := os.WriteFile(backupPath, orig, 0o600); err != nil {
		return rotateOutcome{msg: "could not create the backup — refusing to rotate without one: " + err.Error()}
	}

	if err := v.Rotate(newPass); err != nil {
		// Vault.Rotate restores its own in-memory key/salt on failure, and save()'s
		// tmp+rename means a failed write never leaves a partial vault.json — so
		// vault.json itself is untouched here. The backup is left in place anyway:
		// "did the failure actually land" is not cheap to prove to yourself under
		// pressure, with the tenant keys on the line.
		return rotateOutcome{msg: "rotation failed, vault.json is unchanged: " + err.Error(), backupPath: backupPath}
	}

	// VERIFY with a FRESH instance, not the one still holding the new key in
	// memory — that one would "succeed" even if what actually landed on disk is
	// wrong — and confirm the tenant count is exactly what it was before.
	afterCount, verr := verify(vaultPath, newPass)
	if verr != nil || afterCount != beforeCount {
		reason := verifyFailReason(verr, beforeCount, afterCount)
		if restoreErr := os.WriteFile(vaultPath, orig, 0o600); restoreErr != nil {
			return rotateOutcome{backupPath: backupPath, msg: fmt.Sprintf(
				"rotation verification FAILED (%s) and restoring the backup ALSO FAILED (%v) — vault.json "+
					"may now be unreadable. NOTHING WAS LOST: the untouched backup is still at %s. Copy it back "+
					"to %s by hand before doing anything else.", reason, restoreErr, backupPath, vaultPath)}
		}
		_ = os.Chmod(vaultPath, 0o600)
		return rotateOutcome{backupPath: backupPath, msg: fmt.Sprintf(
			"rotation verification FAILED (%s) — the ORIGINAL vault.json has been restored from the backup, so "+
				"NOTHING CHANGED. The vault still opens with the OLD passphrase only. Backup kept at %s; safe to "+
				"delete once you've confirmed the vault is fine.", reason, backupPath)}
	}

	return rotateOutcome{ok: true, backupPath: backupPath, msg: fmt.Sprintf(
		"rotated — the vault now opens ONLY with the new passphrase (%d %s inside, unchanged).",
		afterCount, plural(afterCount, "tenant", "tenants"))}
}

func verifyFailReason(err error, before, after int) string {
	if err != nil {
		return err.Error()
	}
	return fmt.Sprintf("tenant count changed: had %d, now %d", before, after)
}

// realVerify is the production verify func: a FRESH Vault, opened from disk with
// the new passphrase — see rotateVault's doc comment for why it must be fresh.
func realVerify(path, pass string) (int, error) {
	v := vault.New(path)
	if err := v.Unlock(pass); err != nil {
		return 0, err
	}
	n := v.TenantCount()
	v.Lock()
	return n, nil
}

// currentPassphraseSourceLine reports where the CURRENT passphrase — the one
// about to be verified and, if it checks out, used to re-encrypt the vault —
// was read from. It reuses envSourceOf so this and `status` can never disagree
// on what counts as "a file" versus "this shell's environment": same defect
// class as the v3.30.1 status bug (see passcli.go's envSourceOf doc comment),
// but it matters more here because rotate is about to ACT on that source, not
// just report it.
//
// envSourceOf returns "" for the keychain (the only case reachable here — an
// empty src has already been refused by the caller before this runs). That
// case is named plainly by src itself, so there is nothing to append and
// nothing blank gets printed.
func currentPassphraseSourceLine(src vault.PassphraseSource) string {
	line := fmt.Sprintf("  the current passphrase came from: %s\n", src)
	if origin := envSourceOf(src); origin != "" {
		line += fmt.Sprintf("    %s was read from: %s\n", src, origin)
	}
	return line
}

// passRotate is the CLI entry point: resolve the configured passphrase, prompt
// for the new one, run rotateVault, then — only once that has fully succeeded —
// bring the keychain (if any) into agreement with the new passphrase.
func passRotate(vaultPath, envPass, envPassFile string) int {
	curPass, src, warn := vault.ResolvePassphrase(vaultPath, envPass, envPassFile)
	if warn != "" {
		fmt.Printf("  ! %s\n", warn)
	}
	if curPass == "" {
		fmt.Fprintln(os.Stderr, "refusing to rotate: no current passphrase is configured for this vault "+
			"(checked VAULT_PASSPHRASE_FILE, VAULT_PASSPHRASE, and the macOS keychain). Rotate has to verify "+
			"the CURRENT passphrase before changing anything, and there is nothing configured to verify against.")
		fmt.Fprintln(os.Stderr, "  Set VAULT_PASSPHRASE for this one run, or unlock from the browser and run "+
			"`vault-passphrase set` first, then try again.")
		return 1
	}

	// Say WHICH passphrase is about to be verified and rotated, before asking for
	// the new one — an operator confirming a rotation needs to see this is the
	// source they expect, not find out after the fact.
	fmt.Print(currentPassphraseSourceLine(src))

	// Asked for with a label that says NEW. The old wording ("Vault passphrase:",
	// the same words `set` uses) sat one line under "the current passphrase came
	// from: ...", which reads as a request to confirm the current one.
	newPass, err := readPassphrase(promptNewPassphrase)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return 1
	}

	// Whether a keychain entry exists is captured BEFORE any change, so whether to
	// touch the keychain afterward never depends on anything the rotation itself
	// did to the vault.
	hadKeychainEntry := false
	if vault.KeychainSupported() {
		if _, err := vault.GetKeychainPassphrase(vaultPath); err == nil {
			hadKeychainEntry = true
		}
	}

	result := rotateVault(vaultPath, curPass, newPass, realVerify)
	if !result.ok {
		fmt.Fprintln(os.Stderr, result.msg)
		return 1
	}

	fmt.Println(result.msg)
	fmt.Printf("  vault: %s\n", vaultPath)
	fmt.Printf("  backup (still opens with the OLD passphrase): %s\n", result.backupPath)
	fmt.Printf("  the current passphrase came from: %s\n", src)

	// Update the keychain ONLY after verification succeeded, and ONLY if it
	// already held something — rotate must not be the command that silently
	// starts auto-unlock for a vault that never had it.
	if hadKeychainEntry {
		if err := vault.SetKeychainPassphrase(vaultPath, newPass); err != nil {
			fmt.Fprintln(os.Stderr)
			fmt.Fprintf(os.Stderr, "! the vault now needs the NEW passphrase, but updating the keychain "+
				"failed: %v\n", err)
			fmt.Fprintln(os.Stderr, "  The keychain still holds the OLD passphrase, which no longer opens this "+
				"vault. Fix this now: run `bloxsmith vault-passphrase set` and enter the NEW passphrase — "+
				"otherwise the server will fail to auto-unlock at the next restart.")
		} else {
			fmt.Println("  keychain entry updated to the new passphrase.")
		}
	}

	fmt.Println()
	fmt.Println("NEXT, or this rotation puts the vault at more risk than it started with:")
	fmt.Println("  1. Save the new passphrase in your password manager NOW — this program keeps no other copy.")
	fmt.Printf("  2. Once you're sure the vault is fine, delete %s — it still opens with the OLD passphrase.\n",
		result.backupPath)
	return 0
}
