package main

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/config"
	"bloxsmith/internal/vault"
)

// COPYING THE STATE DIRECTORY OUT, AND BACK — `bloxsmith vault-backup` /
// `bloxsmith vault-restore`.
//
// WHY. Every tenant API key this product holds lives inside one file,
// vault.json, in one directory, and until now there was no supported way to
// take a copy of it. The Docker install keeps that directory in a named volume
// (`-v noc-vault:/vault`); `docker volume rm` or a lost host takes it with no
// second copy anywhere, and the keys are not recoverable from the Infoblox side
// — they are re-issued, which means a portal visit per tenant. The failure mode
// is total and silent right up until the moment it isn't.
//
// Operators were, of course, copying vault.json out by hand. That is what makes
// this worth writing rather than documenting: by hand they copy vault.json and
// nothing else, so the saved views, the brand, the audit log and the teardown
// exports are lost anyway, and they copy it with whatever permissions their `cp`
// happened to produce.
//
// NO PASSPHRASE IS ASKED FOR, ON EITHER SIDE. vault.json is already a Fernet
// envelope — the tenant keys inside it are ciphertext at rest, and this command
// never decrypts anything, so it is a byte copy of an already-encrypted file.
// Prompting for the passphrase would buy nothing and would put it on a terminal
// during the one operation most likely to be run from a script.
//
// The corollary is the thing to be honest about: the backup is exactly as
// secret as the passphrase that opens it, and no more. Treat the archive as the
// vault, because it is.
//
// TWO THINGS ARE DELIBERATELY NOT IN THE ARCHIVE.
//
//  1. AUDIT_TRUST_DIR. The audit chain's HMAC key lives OUTSIDE the state dir on
//     purpose (see internal/audit/key.go): a key stored beside the log it signs
//     is not a key. Sweeping it into this archive would undo that decision by
//     the back door — anyone holding the backup could re-sign a doctored log and
//     it would verify. So it stays out, and both commands SAY it stays out,
//     because an operator who believes they have a complete backup and discovers
//     at restore time that `bloxsmith audit verify` reports could-not-verify
//     forever has been misled by the tool.
//
//  2. `.env`. In the default laptop install the auto-unlock passphrase sits in a
//     .env in this very directory (docs/DEPLOYMENT.md, "What AES-encrypted vault
//     is worth, exactly"). Including it would put the passphrase in plaintext
//     inside the same tarball as the vault it opens, which is precisely the
//     "travels with a backup" exposure `vault-passphrase set` exists to close.
//     One tar entry would have made the encryption of the other entry
//     decorative.
//
// NAMING. `bloxsmith restore-plan` already exists and is unrelated — it reads a
// teardown export back and prints what to re-create (restorecli.go). It touches
// no files and knows nothing about the vault. These two commands are named
// vault-backup / vault-restore, never plain "restore", so no operator ever has
// to work out which one is which from the verb alone.

// vaultBackupUsage prints `bloxsmith vault-backup --help`.
func vaultBackupUsage() {
	fmt.Println("usage: bloxsmith vault-backup <dest.tar.gz> [--force] [--state-dir DIR]")
	fmt.Println()
	fmt.Println("  Copies the whole state directory into one gzipped tar: vault.json,")
	fmt.Println("  audit_log.jsonl, brand.json, logo.png, alert_state.json, first_seen.json,")
	fmt.Println("  ai_budget.json, views/ and teardown-exports/ — whatever is actually there.")
	fmt.Println()
	fmt.Println("  No passphrase is needed or asked for: vault.json is already encrypted, so")
	fmt.Println("  this is a byte copy. The archive is therefore exactly as secret as the")
	fmt.Println("  passphrase that opens it. Written 0600.")
	fmt.Println()
	fmt.Println("  NOT included: the audit trust directory (AUDIT_TRUST_DIR), which lives")
	fmt.Println("  outside the state dir on purpose, and .env, which usually holds the")
	fmt.Println("  auto-unlock passphrase. Back both up separately and deliberately.")
	fmt.Println()
	fmt.Println("  --force          overwrite an existing destination file")
	fmt.Println("  --state-dir DIR  back up DIR instead of the one this install would use")
	fmt.Println()
	fmt.Println("  Exit codes: 0 written, 1 failed, 3 bad usage.")
}

// vaultRestoreUsage prints `bloxsmith vault-restore --help`.
func vaultRestoreUsage() {
	fmt.Println("usage: bloxsmith vault-restore <src.tar.gz> --confirm restore [--force] [--state-dir DIR]")
	fmt.Println()
	fmt.Println("  Unpacks an archive written by `bloxsmith vault-backup` into the state")
	fmt.Println("  directory. Stop the server first.")
	fmt.Println()
	fmt.Println("  --confirm restore  REQUIRED. Without it nothing is touched. This command")
	fmt.Println("                     overwrites the live vault; a typo must not be enough.")
	fmt.Println("  --force            allow a state directory that already has files in it.")
	fmt.Println("                     Files named in the archive are replaced; anything else")
	fmt.Println("                     already there is LEFT ALONE — this is not a wipe.")
	fmt.Println("  --state-dir DIR    restore into DIR instead of the one this install uses")
	fmt.Println()
	fmt.Println("  The archive is extracted to a temporary directory first and only then")
	fmt.Println("  moved into place, so a truncated or unreadable archive cannot leave a")
	fmt.Println("  half-restored state dir. An archive containing a '..' path, an absolute")
	fmt.Println("  path or a symlink is REJECTED whole, not quietly cleaned up.")
	fmt.Println()
	fmt.Println("  Exit codes: 0 restored, 1 failed, 3 bad usage or missing --confirm.")
}

// backupStateDir resolves the directory to operate on, and the config it came
// from. The resolution is deliberately IDENTICAL to buildServer()'s — config.Load
// against the binary's own directory, then vault.ResolveFile, then the vault
// file's parent — because a backup command that looked somewhere else than the
// server writes would produce an archive of an empty or stale directory and
// report success. It is the same three lines rather than a shared helper for the
// same reason auditcli.go repeats them: the server's own copy must stay the
// definition, and a divergence has to be visible as a diff between the two.
//
// override (--state-dir) exists for two real cases: an operator restoring onto a
// machine whose VAULT_DIR is not yet configured, and the tests, which cannot use
// the default at all — vault.ResolveFile CREATES the directory it probes, so
// "the state dir does not exist" is not a state the default path can ever be in.
func backupStateDir(override string) (string, *config.Config) {
	exeDir := "."
	if exe, err := os.Executable(); err == nil {
		exeDir = filepath.Dir(exe)
	}
	config.LoadDotEnv(filepath.Join(exeDir, ".env"))
	config.LoadDotEnv(".env")
	config.LoadServiceEnv()
	cfg := config.Load(exeDir)
	if strings.TrimSpace(override) != "" {
		return override, cfg
	}
	return filepath.Dir(vault.ResolveFile(cfg.VaultDir, exeDir)), cfg
}

// auditTrustDirFor names the directory that is NOT in the archive, resolved the
// same way buildServer() resolves it. Printed as a path rather than as "the
// audit trust directory" so the operator can act on the message without first
// having to work out where that is on this machine.
func auditTrustDirFor(cfg *config.Config) string {
	if cfg != nil && strings.TrimSpace(cfg.AuditTrustDir) != "" {
		return cfg.AuditTrustDir
	}
	if d, err := audit.DefaultTrustDir(); err == nil {
		return d
	}
	return "(could not be resolved on this machine)"
}

// excludedFromBackup reports whether a state-dir entry is deliberately left out.
// Only .env and its variants: see the file header for why one plaintext tar
// entry would make the encryption of the one beside it decorative.
func excludedFromBackup(name string) bool {
	return name == ".env" || strings.HasPrefix(name, ".env.")
}

func runVaultBackupCLI(args []string) int {
	dest, stateOverride := "", ""
	force := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--help" || a == "-h" || a == "help":
			vaultBackupUsage()
			return 0
		case a == "--force":
			force = true
		case a == "--state-dir":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "vault-backup: --state-dir requires a value")
				return exitUsage
			}
			i++
			stateOverride = args[i]
		case strings.HasPrefix(a, "--state-dir="):
			stateOverride = strings.TrimPrefix(a, "--state-dir=")
		case strings.HasPrefix(a, "-"):
			fmt.Fprintf(os.Stderr, "vault-backup: unknown option %q\n", a)
			vaultBackupUsage()
			return exitUsage
		default:
			if dest != "" {
				fmt.Fprintf(os.Stderr, "vault-backup: unexpected extra argument %q\n", a)
				return exitUsage
			}
			dest = a
		}
	}
	if dest == "" {
		fmt.Fprintln(os.Stderr, "vault-backup: a destination path is required")
		vaultBackupUsage()
		return exitUsage
	}

	stateDir, cfg := backupStateDir(stateOverride)

	// A state dir that is not there is a HARD FAILURE, not an empty archive.
	// The one situation this command exists for is the operator who is about to
	// destroy the original, and handing them a valid, well-formed, empty tarball
	// in that moment is the worst possible answer — it looks exactly like a
	// successful backup and stays wrong forever.
	info, err := os.Stat(stateDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "vault-backup: nothing to back up — the state directory could not be read: %v\n", err)
		fmt.Fprintf(os.Stderr, "  looked in: %s\n", stateDir)
		fmt.Fprintln(os.Stderr, "  If the server keeps its vault somewhere else, pass --state-dir.")
		return 1
	}
	if !info.IsDir() {
		fmt.Fprintf(os.Stderr, "vault-backup: %s is not a directory\n", stateDir)
		return 1
	}

	// Never clobber an existing archive without being told to. The specific
	// accident this stops: backing up, wiping the state dir, then re-running the
	// same command out of habit and overwriting the only good copy with a backup
	// of the emptied directory.
	if _, err := os.Stat(dest); err == nil && !force {
		fmt.Fprintf(os.Stderr, "vault-backup: %s already exists — refusing to overwrite it.\n", dest)
		fmt.Fprintln(os.Stderr, "  Choose another path, or pass --force if you are certain.")
		return 1
	}

	n, bytesIn, skipped, err := writeStateArchive(stateDir, dest)
	if err != nil {
		// Remove the partial archive. A half-written .tar.gz that exists is
		// indistinguishable from a good one in an `ls`, and this command's whole
		// job is to leave behind something that can be trusted later.
		_ = os.Remove(dest)
		fmt.Fprintf(os.Stderr, "vault-backup: %v\n", err)
		fmt.Fprintln(os.Stderr, "  The partial archive was removed.")
		return 1
	}

	fmt.Printf("wrote %s (%d %s from %s)\n", dest, n, plural(n, "file", "files"), stateDir)
	fmt.Printf("  %d bytes of state, mode 0600\n", bytesIn)
	fmt.Println()
	fmt.Println("NOT in this archive:")
	fmt.Printf("  the audit trust directory: %s\n", auditTrustDirFor(cfg))
	fmt.Println("    It holds the audit chain's signing key and lives outside the state")
	fmt.Println("    dir on purpose — a key stored beside the log it signs is not a key.")
	fmt.Println("    Back it up separately, or a restored install can never re-verify its")
	fmt.Println("    own audit history (`bloxsmith audit verify` will say could-not-verify).")
	for _, s := range skipped {
		fmt.Printf("  %s\n", s)
	}
	fmt.Println()
	fmt.Println("This archive is exactly as secret as the passphrase that opens the vault.")
	fmt.Println("Store it like a credential, not like a log file.")
	return 0
}

// writeStateArchive tar+gzips stateDir into dest at 0600 and returns the number
// of files written, their total size, and any human-readable notes about what
// was left out.
//
// Entries are written in filepath.WalkDir order, which is lexical, so two runs
// over an unchanged directory produce the same entry ORDER. That is not a claim
// of byte-identical archives — tar headers carry each file's own mtime — only
// that a diff of two backups is readable.
func writeStateArchive(stateDir, dest string) (files int, total int64, notes []string, err error) {
	// 0600 from the moment it exists, not chmod'd afterwards: between an 0644
	// create and a later chmod there is a window in which every local user can
	// read the vault, and that window is exactly when the file is being filled
	// with it. The explicit Chmod after covers the --force case, where O_CREATE
	// on an existing file leaves the OLD mode in place.
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, 0, nil, fmt.Errorf("could not create %s: %w", dest, err)
	}
	defer f.Close()
	if err := f.Chmod(0o600); err != nil {
		return 0, 0, nil, fmt.Errorf("could not set 0600 on %s: %w", dest, err)
	}

	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)

	// The destination may legitimately sit INSIDE the directory being archived —
	// the documented Docker form writes to /vault/backup.tar.gz, and /vault is
	// the state dir. Without this, the archive would be walked into itself and
	// grow until the disk filled.
	absDest, err := filepath.Abs(dest)
	if err != nil {
		return 0, 0, nil, err
	}

	skippedEnv := false
	walkErr := filepath.WalkDir(stateDir, func(p string, de fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(stateDir, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if excludedFromBackup(de.Name()) {
			skippedEnv = true
			if de.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if abs, err := filepath.Abs(p); err == nil && abs == absDest {
			return nil
		}

		// Regular files and directories only. A symlink, socket or device node in
		// a state dir is not something this tool understands well enough to
		// reproduce faithfully, and a tar that silently dereferenced a symlink
		// would restore a copy where a link used to be. Named, not hidden.
		if !de.IsDir() && !de.Type().IsRegular() {
			notes = append(notes, fmt.Sprintf("%s (not a regular file — %s)", rel, de.Type()))
			return nil
		}

		fi, err := de.Info()
		if err != nil {
			return err
		}
		hdr, err := tar.FileInfoHeader(fi, "")
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		if de.IsDir() {
			hdr.Name += "/"
		}
		// Uid/Gid/Uname/Gname are dropped: the archive is routinely written
		// inside a container and restored on a host (or the reverse), where the
		// numeric owner means something different or nothing at all, and
		// recording it only invites a restore that tries to honour it.
		hdr.Uid, hdr.Gid, hdr.Uname, hdr.Gname = 0, 0, "", ""
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if de.IsDir() {
			return nil
		}

		src, err := os.Open(p)
		if err != nil {
			return err
		}
		defer src.Close()
		n, err := io.Copy(tw, src)
		if err != nil {
			return err
		}
		// A file that grew or shrank mid-walk breaks the tar: the header already
		// promised fi.Size() bytes. tar.Writer catches the short case; the long
		// case is caught here so the archive is rejected rather than silently
		// truncated at the promised length.
		if n != fi.Size() {
			return fmt.Errorf("%s changed size while being read (%d bytes, header said %d) — "+
				"stop the server and try again", rel, n, fi.Size())
		}
		files++
		total += n
		return nil
	})
	if walkErr != nil {
		return 0, 0, nil, fmt.Errorf("could not read %s: %w", stateDir, walkErr)
	}

	if err := tw.Close(); err != nil {
		return 0, 0, nil, fmt.Errorf("could not finish the archive: %w", err)
	}
	if err := gz.Close(); err != nil {
		return 0, 0, nil, fmt.Errorf("could not finish the archive: %w", err)
	}
	// Sync before reporting success. Reporting "wrote" for bytes still in the
	// page cache is the one lie this command cannot afford: the next thing the
	// operator does on the strength of that word is destroy the original.
	if err := f.Sync(); err != nil {
		return 0, 0, nil, fmt.Errorf("could not flush %s to disk: %w", dest, err)
	}

	if skippedEnv {
		notes = append(notes, ".env — it usually holds the auto-unlock passphrase, and a "+
			"plaintext passphrase inside the same archive as the vault it opens would make "+
			"encrypting that vault pointless. Copy it separately if you need it.")
	}
	return files, total, notes, nil
}

func runVaultRestoreCLI(args []string) int {
	src, stateOverride, confirm := "", "", ""
	force := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--help" || a == "-h" || a == "help":
			vaultRestoreUsage()
			return 0
		case a == "--force":
			force = true
		case a == "--confirm":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "vault-restore: --confirm requires a value")
				return exitUsage
			}
			i++
			confirm = args[i]
		case strings.HasPrefix(a, "--confirm="):
			confirm = strings.TrimPrefix(a, "--confirm=")
		case a == "--state-dir":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "vault-restore: --state-dir requires a value")
				return exitUsage
			}
			i++
			stateOverride = args[i]
		case strings.HasPrefix(a, "--state-dir="):
			stateOverride = strings.TrimPrefix(a, "--state-dir=")
		case strings.HasPrefix(a, "-"):
			fmt.Fprintf(os.Stderr, "vault-restore: unknown option %q\n", a)
			vaultRestoreUsage()
			return exitUsage
		default:
			if src != "" {
				fmt.Fprintf(os.Stderr, "vault-restore: unexpected extra argument %q\n", a)
				return exitUsage
			}
			src = a
		}
	}
	if src == "" {
		fmt.Fprintln(os.Stderr, "vault-restore: a source archive is required")
		vaultRestoreUsage()
		return exitUsage
	}

	// THE CONFIRM GATE, CHECKED BEFORE ANYTHING IS READ OR RESOLVED.
	//
	// This command overwrites the live vault. Every other destructive path in
	// this product is behind a browser and a token; this one is a shell line
	// away from a shell history entry, and the closest neighbouring command
	// (`restore-plan`) is entirely harmless. A required literal word — not a
	// y/n prompt, which a script answers with `yes |` — is what makes an
	// accidental invocation impossible rather than merely unlikely.
	if confirm != "restore" {
		fmt.Fprintln(os.Stderr, "vault-restore: refusing — this replaces the live vault and every")
		fmt.Fprintln(os.Stderr, "  tenant key in it. Re-run with the confirmation spelled out:")
		fmt.Fprintf(os.Stderr, "\n    bloxsmith vault-restore %s --confirm restore\n\n", src)
		if confirm != "" {
			fmt.Fprintf(os.Stderr, "  (--confirm was given as %q, which is not \"restore\")\n", confirm)
		}
		return exitUsage
	}

	stateDir, cfg := backupStateDir(stateOverride)

	// A running server is a WARNING, not a refusal, and the reason for the
	// distinction is stated so nobody has to guess: all this knows is that
	// something accepted a TCP connection on the configured host and port. That
	// could be another program entirely, and refusing on it would make the
	// command unusable on a machine where port 8080 happens to be busy. What it
	// cannot do is stay silent — a running server holds the vault open in memory
	// and rewrites vault.json on the next tenant mutation, which would undo this
	// restore minutes later with no error anywhere.
	if serverSeemsUp(cfg) {
		fmt.Fprintf(os.Stderr, "! something is listening on %s:%s — if that is Bloxsmith, STOP IT FIRST.\n", cfg.Host, cfg.Port)
		fmt.Fprintln(os.Stderr, "  A running server holds the vault open and will overwrite the restored")
		fmt.Fprintln(os.Stderr, "  vault.json the next time a tenant changes, silently undoing this.")
		fmt.Fprintln(os.Stderr)
	}

	// Refuse a state dir that already has something in it. Restoring over a live
	// install is a legitimate thing to want (that is what a restore IS), but it
	// is never a thing to do by accident, and the common mistake is pointing a
	// restore at the wrong machine's state dir.
	if entries, err := os.ReadDir(stateDir); err == nil && len(entries) > 0 && !force {
		fmt.Fprintf(os.Stderr, "vault-restore: %s is not empty (%d %s) — refusing.\n",
			stateDir, len(entries), plural(len(entries), "entry", "entries"))
		fmt.Fprintln(os.Stderr, "  Restore into an empty directory with --state-dir, or pass --force to")
		fmt.Fprintln(os.Stderr, "  replace the files this archive contains. --force does NOT wipe the")
		fmt.Fprintln(os.Stderr, "  directory: anything not named in the archive is left where it is.")
		return 1
	}

	_, statErr := os.Stat(stateDir)
	dirIsOurs := statErr != nil // it did not exist until the MkdirAll below

	// 0700, matching what the docs promise of a state dir (docs/DEPLOYMENT.md):
	// the files inside are 0600 and a world-readable parent would make the
	// directory listing of an operator's tenants readable to every local user.
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		fmt.Fprintf(os.Stderr, "vault-restore: could not create %s: %v\n", stateDir, err)
		return 1
	}

	// Staging INSIDE the target directory, not in /tmp. os.Rename cannot cross a
	// filesystem boundary, and the state dir is very often a mounted volume —
	// staging in the system temp dir would work in every test and fail with
	// EXDEV on exactly the Docker install this feature exists for.
	tmpDir, err := os.MkdirTemp(stateDir, ".bloxsmith-restore-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "vault-restore: could not create a staging directory in %s: %v\n", stateDir, err)
		return 1
	}
	defer os.RemoveAll(tmpDir)

	// A refused restore must leave the filesystem as it found it, INCLUDING the
	// directory this command created a moment ago to stage into. Otherwise
	// "nothing was changed" is a sentence contradicted by an empty directory that
	// was not there before — small, but it is the one message an operator reads
	// while deciding whether they still have an install.
	// Only a directory THIS command created is removed again: an operator who had
	// already made an empty state dir must still have it afterwards.
	undoMkdir := func() {
		os.RemoveAll(tmpDir)
		if dirIsOurs {
			_ = os.Remove(stateDir) // only succeeds while it is empty
		}
	}

	names, err := extractArchive(src, tmpDir)
	if err != nil {
		// Nothing has been moved into place at this point, so the existing state
		// dir is exactly as it was. Say so — an operator who has just seen a
		// scary error needs to know whether they still have an install.
		undoMkdir()
		fmt.Fprintf(os.Stderr, "vault-restore: %v\n", err)
		fmt.Fprintf(os.Stderr, "  Nothing was changed: %s is exactly as it was.\n", stateDir)
		return 1
	}
	if len(names) == 0 {
		undoMkdir()
		fmt.Fprintf(os.Stderr, "vault-restore: %s contains no files. Nothing was changed.\n", src)
		return 1
	}

	// Per-entry move, top level only: renaming `views` moves the whole subtree in
	// one atomic operation, which is what makes a partially-restored views/
	// directory impossible.
	staged, err := os.ReadDir(tmpDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "vault-restore: could not read the staging directory: %v\n", err)
		return 1
	}
	moved := 0
	for _, e := range staged {
		target := filepath.Join(stateDir, e.Name())
		if err := os.RemoveAll(target); err != nil {
			fmt.Fprintf(os.Stderr, "vault-restore: could not replace %s: %v\n", target, err)
			fmt.Fprintf(os.Stderr, "  %d of %d entries had already been restored — the state dir is now MIXED.\n", moved, len(staged))
			return 1
		}
		if err := os.Rename(filepath.Join(tmpDir, e.Name()), target); err != nil {
			fmt.Fprintf(os.Stderr, "vault-restore: could not move %s into place: %v\n", e.Name(), err)
			fmt.Fprintf(os.Stderr, "  %d of %d entries had already been restored — the state dir is now MIXED.\n", moved, len(staged))
			return 1
		}
		moved++
	}

	// Force 0600 on the vault regardless of what the archive's header said. The
	// mode in a tar entry is attacker-controlled in the general case and
	// umask-dependent in the ordinary one; either way the file holding every
	// tenant key must not come back group- or world-readable because of how it
	// was packed.
	vaultFile := filepath.Join(stateDir, "vault.json")
	if _, err := os.Stat(vaultFile); err == nil {
		if err := os.Chmod(vaultFile, 0o600); err != nil {
			fmt.Fprintf(os.Stderr, "vault-restore: restored, but could not set 0600 on %s: %v\n", vaultFile, err)
			fmt.Fprintln(os.Stderr, "  Fix the permissions by hand before starting the server.")
			return 1
		}
	} else {
		// Not fatal — a state dir with no vault is a valid thing to restore — but
		// it is almost certainly not what the operator meant, and finding out at
		// the next start is finding out too late.
		fmt.Println("! this archive contained no vault.json. The tenant keys are NOT in it.")
	}

	fmt.Printf("restored %d %s into %s\n", len(names), plural(len(names), "file", "files"), stateDir)
	for _, n := range names {
		fmt.Printf("  %s\n", n)
	}
	fmt.Println()
	fmt.Println("The vault still opens with its ORIGINAL passphrase — this copied ciphertext,")
	fmt.Println("it did not re-encrypt anything. Start the server and unlock as usual.")
	fmt.Println()
	fmt.Printf("The audit trust directory was NOT in this archive. Unless %s\n", auditTrustDirFor(cfg))
	fmt.Println("also holds the original audit.key, `bloxsmith audit verify` will report")
	fmt.Println("could-not-verify against the restored log — the entries are intact, but")
	fmt.Println("this machine has no key to check them with.")
	return 0
}

// serverSeemsUp reports whether something accepts a connection where the server
// would be listening. A short timeout because this is advisory: a slow or
// firewalled port must not stall a restore for seconds.
func serverSeemsUp(cfg *config.Config) bool {
	if cfg == nil || cfg.Port == "" {
		return false
	}
	host := cfg.Host
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, cfg.Port), 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// safeTarName validates one tar entry's name and returns the platform path it
// may be written to, relative to the extraction root.
//
// IT REJECTS RATHER THAN SANITISES, and that choice is the point. The tempting
// implementation is path.Clean("/"+name) — strip the "../" and carry on — which
// turns a malicious archive into a successful restore and tells nobody. An
// archive containing ../../etc/anything was not produced by vault-backup; it is
// either corrupt or hostile, and in both cases the correct outcome is that the
// operator finds out and does not use it.
func safeTarName(name string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("the archive contains an entry with no name")
	}
	// Backslash is a path separator on Windows and an ordinary filename
	// character on Linux, so an entry containing one extracts to two different
	// layouts depending on where it is unpacked — and the Windows layout is the
	// one that can escape. Neither is worth supporting: vault-backup never
	// writes one (it emits forward slashes on every platform).
	if strings.ContainsRune(name, '\\') {
		return "", fmt.Errorf("the archive contains an entry with a backslash in its name: %q", name)
	}
	if strings.HasPrefix(name, "/") || filepath.IsAbs(name) {
		return "", fmt.Errorf("the archive contains an absolute path: %q", name)
	}
	for _, part := range strings.Split(strings.TrimSuffix(name, "/"), "/") {
		if part == ".." {
			return "", fmt.Errorf("the archive contains a path that climbs out of the "+
				"state directory: %q", name)
		}
	}
	clean := path.Clean(name)
	if clean == "." || clean == "/" {
		return "", fmt.Errorf("the archive contains an entry that names no file: %q", name)
	}
	return filepath.FromSlash(clean), nil
}

// extractArchive unpacks src into root and returns the file names it wrote.
// Any rejection aborts the whole archive: a restore is all-or-nothing, and
// "most of your vault" is not a state anybody asked for.
func extractArchive(src, root string) ([]string, error) {
	f, err := os.Open(src)
	if err != nil {
		return nil, fmt.Errorf("could not open %s: %w", src, err)
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, fmt.Errorf("%s is not a gzip archive: %w", src, err)
	}
	defer gz.Close()

	var written []string
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			// Includes the truncated-archive case, which is why extraction happens
			// into staging: a backup that was cut short by a full disk fails here,
			// with the live state dir untouched.
			return nil, fmt.Errorf("%s could not be read: %w", src, err)
		}

		rel, err := safeTarName(hdr.Name)
		if err != nil {
			return nil, fmt.Errorf("%s was REJECTED and nothing from it was used: %w", src, err)
		}
		target := filepath.Join(root, rel)
		// Second, independent check. safeTarName should make this unreachable;
		// it is here because a path-traversal guard that is one clever encoding
		// away from failing open is the exact class of bug this is guarding
		// against, and the cost of proving containment against the resolved
		// string is one comparison.
		if !strings.HasPrefix(target, root+string(os.PathSeparator)) {
			return nil, fmt.Errorf("%s was REJECTED: entry %q resolves outside the target directory",
				src, hdr.Name)
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return nil, err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return nil, err
			}
			// 0600 for every restored file, and the header's mode is IGNORED
			// rather than applied. Everything the server keeps here is 0600 by
			// design (docs/DEPLOYMENT.md), so honouring the archived mode buys
			// nothing real — and it is a mode from a file this process did not
			// write, which would let a crafted archive restore a world-readable
			// vault.json, or a setuid bit, on the strength of its own header.
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			if err != nil {
				return nil, err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return nil, fmt.Errorf("%s could not be read: %w", src, err)
			}
			if err := out.Chmod(0o600); err != nil {
				out.Close()
				return nil, err
			}
			if err := out.Close(); err != nil {
				return nil, err
			}
			written = append(written, filepath.ToSlash(rel))
		default:
			// Symlinks and hard links are the other half of the traversal
			// problem: a link entry pointing at /etc plus a later file entry
			// "inside" it writes outside the root without any ".." appearing
			// anywhere. vault-backup never writes one, so an archive containing
			// one did not come from here.
			return nil, fmt.Errorf("%s was REJECTED: entry %q is a %s, and this archive format "+
				"only contains regular files and directories",
				src, hdr.Name, tarTypeName(hdr.Typeflag))
		}
	}
	return written, nil
}

// tarTypeName names a tar entry type in words, so the rejection message says
// "symlink" rather than a byte an operator has to go and look up.
func tarTypeName(flag byte) string {
	switch flag {
	case tar.TypeSymlink:
		return "symlink"
	case tar.TypeLink:
		return "hard link"
	case tar.TypeChar, tar.TypeBlock:
		return "device node"
	case tar.TypeFifo:
		return "named pipe"
	}
	return fmt.Sprintf("type %q entry", flag)
}
