package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"bloxsmith/internal/config"
	"bloxsmith/internal/vault"
	"golang.org/x/term"
)

// `bloxsmith vault-passphrase set|status|remove`
//
// Moves the auto-unlock passphrase out of a plaintext `.env` sitting next to
// vault.json and into the macOS keychain. The reasoning, and the honest limits of
// what that buys, are in internal/vault/keychain.go — read that, not this.

func passCLIUsage() {
	fmt.Println("usage: bloxsmith vault-passphrase <set|status|check|rotate|remove>")
	fmt.Println()
	fmt.Println("  Moves the vault's auto-unlock passphrase into the macOS keychain, so it")
	fmt.Println("  stops sitting in plaintext next to the vault it unlocks.")
	fmt.Println()
	fmt.Println("  set      read a passphrase (prompted, not echoed) and store it")
	fmt.Println("  status   say where the passphrase would come from at the next start")
	fmt.Println("  check    prove the KEYCHAIN copy actually opens this vault, ignoring")
	fmt.Println("           any .env — run this BEFORE you remove the plaintext copy")
	fmt.Println("           (0 it opens, 1 it does not, 2 could not be checked)")
	fmt.Println("  rotate   change the vault's ACTUAL encryption passphrase — verifies the")
	fmt.Println("           current one first, backs up vault.json, re-encrypts, and only")
	fmt.Println("           then updates the keychain (if it held an entry). This is the")
	fmt.Println("           only way to invalidate an exposed passphrase; `set` alone does not.")
	fmt.Println("  remove   delete the keychain entry")
	fmt.Println()
	fmt.Println("  --vault PATH   the vault.json this passphrase unlocks")
	fmt.Println("                 (default: the one this install would use)")
	fmt.Println()
	fmt.Println("  macOS only. On other platforms every subcommand refuses and says so")
	fmt.Println("  rather than pretending to have moved anything.")
	fmt.Println()
	fmt.Println("  It does NOT make the passphrase secret from this machine: anything")
	fmt.Println("  running as you can read it back, exactly as the server does. What it")
	fmt.Println("  stops is the passphrase travelling with a disk image, a backup or a")
	fmt.Println("  copied state directory.")
}

func runPassCLI(args []string) int {
	if len(args) == 0 {
		passCLIUsage()
		return 3
	}
	cmd := args[0]
	if cmd == "--help" || cmd == "-h" || cmd == "help" {
		passCLIUsage()
		return 0
	}

	vaultPath := ""
	for i := 1; i < len(args); i++ {
		switch {
		case args[i] == "--vault":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "vault-passphrase: --vault requires a value")
				return 3
			}
			i++
			vaultPath = args[i]
		case strings.HasPrefix(args[i], "--vault="):
			vaultPath = strings.TrimPrefix(args[i], "--vault=")
		default:
			fmt.Fprintf(os.Stderr, "vault-passphrase: unknown option %q\n", args[i])
			return 3
		}
	}

	// The env files are loaded ALWAYS, not only when --vault was omitted.
	//
	// They were once loaded inside that branch, and `status` then reported "at next
	// start the passphrase would come from: macOS keychain" on a machine whose
	// service .env sets VAULT_PASSPHRASE_FILE — because with --vault given it never
	// read the .env, so the env passphrase looked absent. A status command that says
	// the opposite of what the server will do is worse than no status command: it is
	// the exact false reassurance this whole feature is trying to remove.
	dir := "."
	if exe, err := os.Executable(); err == nil {
		dir = filepath.Dir(exe)
	}
	config.LoadDotEnv(filepath.Join(dir, ".env"))
	config.LoadDotEnv(".env")
	config.LoadServiceEnv()
	cfg := config.Load(dir)
	if vaultPath == "" {
		vaultPath = vault.ResolveFile(cfg.VaultDir, dir)
	}
	// Resolved to an absolute path because it is the keychain item's account name:
	// the same vault reached as "./vault.json" and as its full path must not become
	// two different entries, one of which silently holds the wrong secret.
	if abs, err := filepath.Abs(vaultPath); err == nil {
		vaultPath = abs
	}

	switch cmd {
	case "status":
		return passStatus(vaultPath, cfg.VaultPassphrase, cfg.VaultPassphraseFile)
	case "set":
		return passSet(vaultPath)
	case "rotate":
		return passRotate(vaultPath, cfg.VaultPassphrase, cfg.VaultPassphraseFile)
	case "check":
		msg, code := checkKeychainOpensVault(vaultPath, vault.GetKeychainPassphrase)
		out := os.Stdout
		if code != 0 {
			out = os.Stderr
		}
		fmt.Fprintln(out, msg)
		fmt.Fprintf(out, "  vault: %s\n", vaultPath)
		return code
	case "remove":
		if err := vault.RemoveKeychainPassphrase(vaultPath); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			return 1
		}
		fmt.Println("removed — no keychain entry for this vault.")
		fmt.Printf("  vault: %s\n", vaultPath)
		fmt.Println("  The server will now auto-unlock only if VAULT_PASSPHRASE or")
		fmt.Println("  VAULT_PASSPHRASE_FILE is set; otherwise unlock it from the browser.")
		return 0
	default:
		fmt.Fprintf(os.Stderr, "vault-passphrase: unknown subcommand %q\n", cmd)
		passCLIUsage()
		return 3
	}
}

func passStatus(vaultPath, envPass, envPassFile string) int {
	if err := vault.KeychainAvailable(); err != nil {
		fmt.Printf("keychain: unavailable — %v\n", err)
	} else {
		switch _, err := vault.GetKeychainPassphrase(vaultPath); {
		case err == nil:
			fmt.Println("keychain: a passphrase IS stored for this vault")
		case errors.Is(err, vault.ErrNoKeychainEntry):
			fmt.Println("keychain: nothing stored for this vault")
		default:
			// A failed read must not read as "nothing stored".
			fmt.Printf("keychain: could not be checked — %v\n", err)
		}
	}

	_, src, warn := vault.ResolvePassphrase(vaultPath, envPass, envPassFile)
	fmt.Printf("at next start the passphrase would come from: %s\n", src)
	fmt.Printf("  vault: %s\n", vaultPath)

	// NAME THE FILE the env value came from.
	//
	// Without this, `status --vault /some/other/vault.json` run from a directory
	// whose own .env sets VAULT_PASSPHRASE reports "would come from:
	// VAULT_PASSPHRASE" — true of this shell, false of the server that opens that
	// vault, and indistinguishable from the case where it is true of both. Same
	// family as the v3.30.1 bug this command already carries a comment about.
	//
	// "came from the real environment" and "came from a file" are printed
	// differently, because only the second one is a file the operator can go and
	// edit.
	if origin := envSourceOf(src); origin != "" {
		fmt.Printf("  %s was read from: %s\n", src, origin)
	}
	if warn != "" {
		fmt.Printf("\n  ! %s\n", warn)
	}
	return 0
}

// envSourceOf describes where the winning env setting was read from, or "" when
// the source is not an env var at all (the keychain, or nothing).
func envSourceOf(src vault.PassphraseSource) string {
	key := ""
	switch src {
	case vault.FromEnv:
		key = "VAULT_PASSPHRASE"
	case vault.FromFile:
		key = "VAULT_PASSPHRASE_FILE"
	default:
		return ""
	}
	if origin := config.OriginOf(key); origin != "" {
		return origin
	}
	// Set in the real process environment rather than any file. Said explicitly:
	// an operator hunting for a file to edit needs to know there isn't one.
	return "this shell's environment (not a .env file)"
}

// checkKeychainOpensVault answers the one question `status` cannot: will the
// vault still open once the plaintext copy is gone?
//
// `status` reports which SOURCE would win. That is not the same question. An
// operator who reads "a passphrase IS stored in the keychain", deletes their
// .env on the strength of it and restarts finds out at that moment whether the
// stored value was the right one — with the vault shut and the tenant keys
// inside it. This runs that experiment first, while the plaintext copy is still
// there to fall back on.
//
// TWO PROPERTIES MAKE IT WORTH TRUSTING.
//
// It reads the KEYCHAIN ONLY. Not VAULT_PASSPHRASE, not VAULT_PASSPHRASE_FILE.
// Consulting the env here would be the whole point inverted: it would report
// success using the very file the operator is about to delete, which is the
// false all-clear this command exists to prevent.
//
// It CANNOT WRITE. It calls Unlock, which only reads vault.json, and it checks
// Exists() first — never AutoUnlock, which INITIALISES a new vault when none is
// there. A "check" that created an empty vault would report that the passphrase
// opens it, truthfully, having just replaced the thing being asked about.
//
// getPass is a parameter so the three outcomes can be tested on a machine with
// no keychain at all (every Linux CI runner), which is where this would
// otherwise go unexercised.
func checkKeychainOpensVault(vaultPath string, getPass func(string) (string, error)) (string, int) {
	// Exit 2 is "the check did not run" — the same distinction `bloxsmith audit
	// verify` draws, and for the same reason: it must never be read as a milder
	// failure. Nothing is claimed about the passphrase in any of these cases.
	pass, err := getPass(vaultPath)
	switch {
	case errors.Is(err, vault.ErrNoKeychainEntry):
		return "could not be checked: nothing is stored in the keychain for this vault. " +
			"Run `bloxsmith vault-passphrase set` first.", 2
	case err != nil:
		return "could not be checked: " + err.Error(), 2
	}

	v := vault.New(vaultPath)
	if !v.Exists() {
		return "could not be checked: there is no vault at this path yet, so there is nothing " +
			"to open. Nothing was created.", 2
	}
	if err := v.Unlock(pass); err != nil {
		if errors.Is(err, vault.ErrWrongPassphrase) {
			return "the keychain passphrase does NOT open this vault. Do not remove your plaintext " +
				"copy — re-run `bloxsmith vault-passphrase set` with the passphrase that does.", 1
		}
		// A vault that could not be READ is not a wrong passphrase, and saying so
		// would send the operator to re-store a passphrase that was never at fault.
		return "could not be checked: the vault could not be read: " + err.Error(), 2
	}
	defer v.Lock()

	n := v.TenantCount()
	return fmt.Sprintf("the keychain passphrase opens this vault (%d %s inside).",
		n, plural(n, "tenant", "tenants")), 0
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func passSet(vaultPath string) int {
	if err := vault.KeychainAvailable(); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return 1
	}

	pass, err := readPassphrase()
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return 1
	}
	if strings.TrimSpace(pass) == "" {
		fmt.Fprintln(os.Stderr, "nothing entered — no change made.")
		return 1
	}

	if err := vault.SetKeychainPassphrase(vaultPath, pass); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return 1
	}

	fmt.Println("stored, and read back to confirm it landed.")
	fmt.Printf("  vault: %s\n", vaultPath)
	fmt.Println()
	// The two things an operator has to do next, or this achieves nothing.
	fmt.Println("NEXT, or this has changed nothing:")
	fmt.Println("  1. Remove VAULT_PASSPHRASE from your .env (and any VAULT_PASSPHRASE_FILE).")
	fmt.Println("     While either is set it WINS over the keychain, and the passphrase is")
	fmt.Println("     still sitting in plaintext on this disk.")
	fmt.Println("  2. Restart the server and check the startup log says the passphrase came")
	fmt.Println("     from the macOS keychain.")
	fmt.Println()
	fmt.Println("Worth knowing: storing it just now put the passphrase on a command line")
	fmt.Println("for a moment, where another process on this machine could have seen it in")
	fmt.Println("`ps` — the macOS `security` tool cannot take a secret any other way. That")
	fmt.Println("is one brief window, against a file that otherwise holds it forever.")
	fmt.Println("It does NOT become secret from this machine: anything running as you can")
	fmt.Println("read it back. What stops now is the passphrase travelling with a backup.")
	return 0
}

// readPassphrase prompts twice with echo off. It reads from the terminal rather
// than taking a flag so the passphrase does not land in shell history — the one
// exposure this side of it can actually avoid.
//
// A non-terminal stdin (a pipe, a script) is read as a single line, so
// `printf '%s' "$p" | bloxsmith vault-passphrase set` works for an automated
// install without a second confirmation it could never answer.
func readPassphrase() (string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		if err != nil && line == "" {
			return "", fmt.Errorf("could not read a passphrase from stdin: %w", err)
		}
		return line, nil
	}

	fmt.Print("Vault passphrase: ")
	first, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		return "", fmt.Errorf("could not read the passphrase: %w", err)
	}
	fmt.Print("Again: ")
	second, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		return "", fmt.Errorf("could not read the confirmation: %w", err)
	}
	if string(first) != string(second) {
		return "", errors.New("the two entries did not match — no change made")
	}
	return string(first), nil
}
