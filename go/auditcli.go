package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/config"
	"bloxsmith/internal/vault"
)

// OFFLINE AUDIT VERIFIER — `bloxsmith audit verify`
//
// WHY. Until now the only thing that said the tamper-evident log was untampered
// was the same running program that writes it, through its own
// /api/audit/log endpoint. An operator asking "has this been edited?" was
// trusting the answer of the process most able to lie about it, and could not
// ask the question at all with the server stopped, on a copied log, or on
// another machine.
//
// This subcommand answers it with nothing running: point it at a log file and a
// key and it reports the same three states, with a distinct exit code for each
// so a monitoring script cannot mistake one for another.
//
// WHAT IT DOES NOT DO, stated rather than implied. It shares the verification
// code with the server, so it is independent of the running PROCESS, not of the
// implementation: a bug in Verify() would be a bug here too. A genuinely
// independent second implementation would guard against that, at the cost of two
// crypto implementations that must agree forever, where any divergence produces
// a false accusation against a good log. What this does buy: verification with
// the server stopped or compromised, against a log and key you carry elsewhere,
// with no ability to alter either.
//
// THE SAFETY PROPERTY THAT MATTERS MOST. It cannot write. It never generates a
// missing key (audit.Options.NoGenerate) and Append/Adopt/writeHead all refuse on
// a read-only Log. A verifier that created a key would mint the very trust root
// it is meant to check against; one that could reseal the head would let the act
// of verifying launder a truncated chain into a clean one. Both are enforced in
// the audit package, not just avoided here.

// Exit codes. Distinct per state on purpose: "could not check" collapsing into
// either "clean" or "forged" is the exact failure this whole feature exists to
// avoid, and a script that only looks at zero-vs-nonzero would otherwise read a
// missing key as tampering.
const (
	exitIntact         = 0
	exitTampered       = 1
	exitCouldNotVerify = 2
	exitUsage          = 3
)

func auditCLIUsage() {
	fmt.Println("usage: bloxsmith audit verify [options]")
	fmt.Println()
	fmt.Println("  Verifies the tamper-evident audit chain with nothing running. Read-only:")
	fmt.Println("  it never creates a key and never reseals the chain.")
	fmt.Println()
	fmt.Println("  --log PATH         the audit_log.jsonl to check")
	fmt.Println("                     (default: alongside the vault this install would use)")
	fmt.Println("  --trust-dir DIR    directory holding audit.key and the sealed head")
	fmt.Println("                     (default: $AUDIT_TRUST_DIR, else the per-user config dir)")
	fmt.Println("  --key HEX          the HMAC key directly, instead of a key file ($AUDIT_KEY)")
	fmt.Println("  --key-file PATH    a file holding the hex key ($AUDIT_KEY_FILE)")
	fmt.Println("  --json             machine-readable result on stdout")
	fmt.Println()
	fmt.Println("  Exit codes: 0 intact, 1 tampered, 2 could-not-verify, 3 bad usage.")
	fmt.Println("  2 is not a milder 1. It means the chain was NOT checked, so nothing")
	fmt.Println("  is claimed about it either way.")
}

// runAuditCLI implements `bloxsmith audit ...`. args is os.Args[2:].
func runAuditCLI(args []string) int {
	if len(args) == 0 {
		auditCLIUsage()
		return exitUsage
	}
	switch args[0] {
	case "verify":
	case "--help", "-h", "help":
		auditCLIUsage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "bloxsmith audit: unknown subcommand %q\n", args[0])
		auditCLIUsage()
		return exitUsage
	}

	var logPath, trustDir, key, keyFile string
	asJSON := false

	rest := args[1:]
	for i := 0; i < len(rest); i++ {
		a := rest[i]
		next := func() (string, bool) {
			if i+1 >= len(rest) {
				fmt.Fprintf(os.Stderr, "bloxsmith audit verify: %s requires a value\n", a)
				return "", false
			}
			i++
			return rest[i], true
		}
		var ok bool
		switch {
		case a == "--json":
			asJSON = true
		case a == "--help" || a == "-h":
			auditCLIUsage()
			return 0
		case a == "--log":
			if logPath, ok = next(); !ok {
				return exitUsage
			}
		case strings.HasPrefix(a, "--log="):
			logPath = strings.TrimPrefix(a, "--log=")
		case a == "--trust-dir":
			if trustDir, ok = next(); !ok {
				return exitUsage
			}
		case strings.HasPrefix(a, "--trust-dir="):
			trustDir = strings.TrimPrefix(a, "--trust-dir=")
		case a == "--key":
			if key, ok = next(); !ok {
				return exitUsage
			}
		case strings.HasPrefix(a, "--key="):
			key = strings.TrimPrefix(a, "--key=")
		case a == "--key-file":
			if keyFile, ok = next(); !ok {
				return exitUsage
			}
		case strings.HasPrefix(a, "--key-file="):
			keyFile = strings.TrimPrefix(a, "--key-file=")
		default:
			fmt.Fprintf(os.Stderr, "bloxsmith audit verify: unknown option %q\n", a)
			auditCLIUsage()
			return exitUsage
		}
	}

	// Defaults mirror what the server itself would use, so the common case is
	// `bloxsmith audit verify` with no arguments on the machine that runs it.
	// The .env beside the binary and the service env file are loaded first, for
	// the same reason the server loads them: AUDIT_TRUST_DIR / AUDIT_KEY usually
	// live there, and a verifier that ignored them would report could-not-verify
	// on a correctly configured install.
	dir := "."
	if exe, err := os.Executable(); err == nil {
		dir = filepath.Dir(exe)
	}
	config.LoadDotEnv(filepath.Join(dir, ".env"))
	config.LoadDotEnv(".env")
	config.LoadServiceEnv()
	cfg := config.Load(dir)
	if logPath == "" {
		logPath = filepath.Join(filepath.Dir(vault.ResolveFile(cfg.VaultDir, dir)), "audit_log.jsonl")
	}
	if trustDir == "" {
		trustDir = cfg.AuditTrustDir
	}
	if trustDir == "" {
		d, err := audit.DefaultTrustDir()
		if err != nil {
			return auditReport(asJSON, logPath, "", audit.CouldNotVerify,
				fmt.Sprintf("no trust directory could be resolved and none was given: %v", err))
		}
		trustDir = d
	}
	if key == "" {
		key = cfg.AuditKey
	}
	if keyFile == "" {
		keyFile = cfg.AuditKeyFile
	}

	// A log that is not there at all is could-not-verify, not intact. An absent
	// file is a legitimately empty chain to the SERVER, which is about to create
	// it — but to someone asking "verify this log" it means the thing they named
	// does not exist, and answering "intact" would be answering a question they
	// did not ask.
	if _, err := os.Stat(logPath); err != nil {
		return auditReport(asJSON, logPath, trustDir, audit.CouldNotVerify,
			fmt.Sprintf("the log file could not be opened: %v", err))
	}

	l, err := audit.OpenReadOnly(logPath, audit.Options{TrustDir: trustDir, Key: key, KeyFile: keyFile})
	if err != nil {
		return auditReport(asJSON, logPath, trustDir, audit.CouldNotVerify, err.Error())
	}

	verdict, detail := audit.Classify(l.Verify())
	entries, skipped, readErr := l.Read()
	n := len(entries)
	extra := ""
	if readErr == nil && skipped == 0 {
		extra = fmt.Sprintf("%d entries", n)
	}
	return auditReport(asJSON, logPath, trustDir, verdict, detail, extra, l.KeyID())
}

// auditReport prints the result and returns the exit code for it. Signature is
// deliberately blunt (trailing optional strings) rather than a struct: there is
// exactly one caller and every early-return path above must be able to report
// without having to construct one.
func auditReport(asJSON bool, logPath, trustDir string, verdict audit.Verdict, detail string, extras ...string) int {
	count, keyID := "", ""
	if len(extras) > 0 {
		count = extras[0]
	}
	if len(extras) > 1 {
		keyID = extras[1]
	}

	code := exitCouldNotVerify
	switch verdict {
	case audit.Intact:
		code = exitIntact
	case audit.Tampered:
		code = exitTampered
	}

	if asJSON {
		out := map[string]any{
			"verdict":   string(verdict),
			"log":       logPath,
			"trust_dir": trustDir,
			"exit_code": code,
		}
		if detail != "" {
			out["detail"] = detail
		}
		if count != "" {
			out["entries"] = count
		}
		if keyID != "" {
			out["key_id"] = keyID
		}
		b, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "could not encode the result: %v\n", err)
			return exitCouldNotVerify
		}
		fmt.Println(string(b))
		return code
	}

	// Plain output. The verdict word is the first thing on the line and is one of
	// exactly three, so it can be grepped for without parsing.
	switch verdict {
	case audit.Intact:
		fmt.Printf("intact — the audit chain verifies")
		if count != "" {
			fmt.Printf(" (%s)", count)
		}
		fmt.Println()
	case audit.Tampered:
		fmt.Printf("tampered — %s\n", detail)
		fmt.Println("  This log has been changed since it was written. Do not discard it;")
		fmt.Println("  the entry number above is where the chain first stops matching.")
	default:
		fmt.Printf("could-not-verify — %s\n", detail)
		fmt.Println("  Nothing is claimed about this log either way. This is NOT a clean bill")
		fmt.Println("  of health and it is NOT an accusation — the check did not run.")
	}
	fmt.Printf("  log:       %s\n", logPath)
	if trustDir != "" {
		fmt.Printf("  trust dir: %s\n", trustDir)
	}
	if keyID != "" {
		fmt.Printf("  key id:    %s\n", keyID)
	}
	return code
}
