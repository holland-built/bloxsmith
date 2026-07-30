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
	println("usage: bloxsmith vault-passphrase <set|status|remove>")
	println()
	println("  Moves the vault's auto-unlock passphrase into the macOS keychain, so it")
	println("  stops sitting in plaintext next to the vault it unlocks.")
	println()
	println("  set      read a passphrase (prompted, not echoed) and store it")
	println("  status   say where the passphrase would come from at the next start")
	println("  remove   delete the keychain entry")
	println()
	println("  --vault PATH   the vault.json this passphrase unlocks")
	println("                 (default: the one this install would use)")
	println()
	println("  macOS only. On other platforms every subcommand refuses and says so")
	println("  rather than pretending to have moved anything.")
	println()
	println("  It does NOT make the passphrase secret from this machine: anything")
	println("  running as you can read it back, exactly as the server does. What it")
	println("  stops is the passphrase travelling with a disk image, a backup or a")
	println("  copied state directory.")
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

	if vaultPath == "" {
		dir := "."
		if exe, err := os.Executable(); err == nil {
			dir = filepath.Dir(exe)
		}
		config.LoadDotEnv(filepath.Join(dir, ".env"))
		config.LoadDotEnv(".env")
		config.LoadServiceEnv()
		cfg := config.Load(dir)
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
		return passStatus(vaultPath)
	case "set":
		return passSet(vaultPath)
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

func passStatus(vaultPath string) int {
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

	cfg := config.Load(".")
	_, src, warn := vault.ResolvePassphrase(vaultPath, cfg.VaultPassphrase, cfg.VaultPassphraseFile)
	fmt.Printf("at next start the passphrase would come from: %s\n", src)
	fmt.Printf("  vault: %s\n", vaultPath)
	if warn != "" {
		fmt.Printf("\n  ! %s\n", warn)
	}
	return 0
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
