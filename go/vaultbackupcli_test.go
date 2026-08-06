package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

// BACKUP AND RESTORE — the tests that matter are the refusals.
//
// A round trip that works is the easy half and it is tested first. The half that
// actually decides whether this feature is safe is what happens when it is
// pointed at the wrong thing: a state dir that is not there, a target that
// already holds a live install, a command line with the confirmation missing,
// and an archive that is not what it claims to be. Every one of those, done
// wrong, destroys the tenant keys this whole product exists to hold — so each
// gets a test that fails if the guard is removed, not merely a comment saying
// the guard is there.

// fakeStateDir builds a state directory shaped like a real one: the encrypted
// vault, the audit log, a saved view in its subdirectory, and a binary file
// (the brand logo) so a text-only round trip cannot pass by accident.
func fakeStateDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	write := func(rel string, b []byte) {
		t.Helper()
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// Real-shaped: the {v, salt, data} envelope vault.go writes, not a
	// placeholder — so a change that started parsing the file instead of copying
	// its bytes would still be exercised against something it could parse.
	write("vault.json", []byte(`{"v":2,"salt":"YWJjZGVmZ2hpamtsbW5vcA==",`+
		`"data":"gAAAAABn0000000000000000000000000000000000000000000000000000"}`))
	write("audit_log.jsonl", []byte("{\"event\":\"boot\",\"seq\":1}\n{\"event\":\"unlock\",\"seq\":2}\n"))
	write("brand.json", []byte(`{"title":"Acme NOC"}`))
	write("alert_state.json", []byte(`{"snoozed":{}}`))
	write("views/by-site.json", []byte(`{"name":"by-site","filters":[]}`))
	write("teardown-exports/ams-2026.json", []byte(`{"objects":[]}`))
	// Bytes that are not valid UTF-8 and include a NUL: a gzip/tar path that
	// mangled binary content would show up here and nowhere else.
	write("logo.png", []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x42})
	return dir
}

// snapshot reads every file under dir into a path -> content map, for a
// byte-level comparison of two directories.
func snapshot(t *testing.T, dir string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	err := filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err != nil || fi.IsDir() {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = b
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestVaultBackupRestoreRoundTripIsByteIdentical(t *testing.T) {
	src := fakeStateDir(t)
	want := snapshot(t, src)
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")

	if code := runVaultBackupCLI([]string{archive, "--state-dir", src}); code != 0 {
		t.Fatalf("vault-backup exit %d, want 0", code)
	}

	// The archive itself must not be readable by anyone but its owner: it is the
	// vault, in a directory an operator is far more likely to leave lying around.
	fi, err := os.Stat(archive)
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Errorf("archive mode %04o, want 0600", got)
	}

	dst := filepath.Join(t.TempDir(), "restored")
	if code := runVaultRestoreCLI([]string{archive, "--confirm", "restore", "--state-dir", dst}); code != 0 {
		t.Fatalf("vault-restore exit %d, want 0", code)
	}

	got := snapshot(t, dst)
	if len(got) != len(want) {
		t.Fatalf("restored %d files, backed up %d\n  got:  %v\n  want: %v",
			len(got), len(want), keys(got), keys(want))
	}
	for name, wantBytes := range want {
		gotBytes, ok := got[name]
		if !ok {
			t.Errorf("%s is missing after restore", name)
			continue
		}
		if !bytes.Equal(gotBytes, wantBytes) {
			t.Errorf("%s differs after the round trip:\n  got  %q\n  want %q", name, gotBytes, wantBytes)
		}
	}

	// The one file whose permissions are forced rather than copied.
	vfi, err := os.Stat(filepath.Join(dst, "vault.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got := vfi.Mode().Perm(); got != 0o600 {
		t.Errorf("restored vault.json mode %04o, want 0600", got)
	}
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// A .env in the state dir usually holds the auto-unlock passphrase. Putting it
// in the archive next to the vault it opens would make encrypting that vault
// decorative — the single most valuable line in this file if it ever regresses.
func TestVaultBackupLeavesEnvBehind(t *testing.T) {
	src := fakeStateDir(t)
	if err := os.WriteFile(filepath.Join(src, ".env"), []byte("VAULT_PASSPHRASE=hunter2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	if code := runVaultBackupCLI([]string{archive, "--state-dir", src}); code != 0 {
		t.Fatalf("vault-backup exit %d, want 0", code)
	}
	for _, name := range archiveNames(t, archive) {
		if name == ".env" {
			t.Fatal(".env was included in the backup — the auto-unlock passphrase is now " +
				"sitting in plaintext inside the same archive as the vault it opens")
		}
	}
	// And the passphrase must not be anywhere in the decompressed stream either,
	// under any name.
	if bytes.Contains(archiveBody(t, archive), []byte("hunter2")) {
		t.Fatal("the passphrase from .env appears in the archive body")
	}
}

func TestVaultBackupOnMissingStateDirFailsCleanly(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-such-state-dir")
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")

	if code := runVaultBackupCLI([]string{archive, "--state-dir", missing}); code == 0 {
		t.Fatal("vault-backup succeeded against a state dir that does not exist")
	}
	// It must not leave an empty-but-valid archive behind. That file would look
	// exactly like a good backup to the operator about to destroy the original.
	if _, err := os.Stat(archive); err == nil {
		t.Fatal("a backup file was created for a state dir that does not exist")
	}
}

func TestVaultBackupRefusesToOverwriteWithoutForce(t *testing.T) {
	src := fakeStateDir(t)
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	existing := []byte("an older, good backup")
	if err := os.WriteFile(archive, existing, 0o600); err != nil {
		t.Fatal(err)
	}

	if code := runVaultBackupCLI([]string{archive, "--state-dir", src}); code == 0 {
		t.Fatal("vault-backup overwrote an existing archive without --force")
	}
	if b, err := os.ReadFile(archive); err != nil || !bytes.Equal(b, existing) {
		t.Fatal("the existing archive was modified by a refused backup")
	}
	if code := runVaultBackupCLI([]string{archive, "--state-dir", src, "--force"}); code != 0 {
		t.Fatalf("vault-backup --force exit %d, want 0", code)
	}
	if b, _ := os.ReadFile(archive); bytes.Equal(b, existing) {
		t.Fatal("--force did not overwrite the archive")
	}
}

func TestVaultRestoreRefusesWithoutConfirm(t *testing.T) {
	archive := goodArchive(t)
	dst := filepath.Join(t.TempDir(), "restored")

	for _, args := range [][]string{
		{archive, "--state-dir", dst},                         // no --confirm at all
		{archive, "--confirm", "yes", "--state-dir", dst},     // the wrong word
		{archive, "--confirm", "RESTORE", "--state-dir", dst}, // right word, wrong case
	} {
		if code := runVaultRestoreCLI(args); code == 0 {
			t.Fatalf("vault-restore ran with args %v — the confirmation gate did nothing", args)
		}
		if _, err := os.Stat(dst); err == nil {
			t.Fatalf("args %v: a refused restore created %s", args, dst)
		}
	}
}

func TestVaultRestoreRefusesNonEmptyDirWithoutForce(t *testing.T) {
	archive := goodArchive(t)
	dst := t.TempDir()
	live := filepath.Join(dst, "vault.json")
	original := []byte(`{"v":2,"salt":"THE-LIVE-ONE","data":"do-not-lose-me"}`)
	if err := os.WriteFile(live, original, 0o600); err != nil {
		t.Fatal(err)
	}

	if code := runVaultRestoreCLI([]string{archive, "--confirm", "restore", "--state-dir", dst}); code == 0 {
		t.Fatal("vault-restore overwrote a non-empty state dir without --force")
	}
	if b, err := os.ReadFile(live); err != nil || !bytes.Equal(b, original) {
		t.Fatal("the live vault.json was replaced by a restore that was supposed to refuse")
	}

	if code := runVaultRestoreCLI([]string{archive, "--confirm", "restore", "--state-dir", dst, "--force"}); code != 0 {
		t.Fatalf("vault-restore --force exit %d, want 0", code)
	}
	if b, _ := os.ReadFile(live); bytes.Equal(b, original) {
		t.Fatal("--force did not replace the live vault.json")
	}
}

// A restore is all-or-nothing. --force replaces what the archive names and
// leaves everything else alone, which is a real limitation the help text
// promises; if that ever silently became a wipe, an operator would lose the
// files they were relying on it to keep.
func TestVaultRestoreForceLeavesUnrelatedFilesAlone(t *testing.T) {
	archive := goodArchive(t)
	dst := t.TempDir()
	unrelated := filepath.Join(dst, "operator-notes.txt")
	if err := os.WriteFile(unrelated, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := runVaultRestoreCLI([]string{archive, "--confirm", "restore", "--state-dir", dst, "--force"}); code != 0 {
		t.Fatalf("vault-restore --force exit %d, want 0", code)
	}
	if b, err := os.ReadFile(unrelated); err != nil || string(b) != "keep me" {
		t.Fatalf("--force removed a file the archive did not name: %v", err)
	}
}

// PATH TRAVERSAL. The archive is rejected whole — not sanitised, not partially
// applied. Both halves are asserted: nothing lands outside the target, and
// nothing from the archive lands inside it either.
func TestVaultRestoreRejectsPathTraversal(t *testing.T) {
	for _, entry := range []string{
		"../escaped.json",
		"views/../../escaped.json",
		"/etc/escaped.json",
	} {
		t.Run(entry, func(t *testing.T) {
			outside := t.TempDir()
			archive := filepath.Join(outside, "evil.tar.gz")
			writeTarGz(t, archive, []tarEntry{
				{name: "vault.json", body: []byte(`{"v":2}`)},
				{name: entry, body: []byte("owned")},
			})

			dst := filepath.Join(outside, "state")
			if code := runVaultRestoreCLI([]string{archive, "--confirm", "restore", "--state-dir", dst}); code == 0 {
				t.Fatalf("vault-restore accepted an archive containing %q", entry)
			}
			// The benign entry that came BEFORE the malicious one must not have
			// survived: a rejection that still applied the first half would leave
			// a state dir the operator believes was restored.
			if _, err := os.Stat(filepath.Join(dst, "vault.json")); err == nil {
				t.Error("the archive was partially applied despite being rejected")
			}
			if _, err := os.Stat(filepath.Join(outside, "escaped.json")); err == nil {
				t.Error("a file was written outside the target directory")
			}
			// And no staging directory was left behind.
			if entries, err := os.ReadDir(dst); err == nil && len(entries) > 0 {
				t.Errorf("the target directory is not empty after a rejected restore: %v", entries)
			}
		})
	}
}

// The other half of the traversal problem: a symlink entry needs no ".." to
// write outside the root.
func TestVaultRestoreRejectsSymlinkEntry(t *testing.T) {
	outside := t.TempDir()
	archive := filepath.Join(outside, "evil.tar.gz")
	writeTarGz(t, archive, []tarEntry{
		{name: "sneaky", link: "/etc", typeflag: tar.TypeSymlink},
	})
	dst := filepath.Join(outside, "state")
	if code := runVaultRestoreCLI([]string{archive, "--confirm", "restore", "--state-dir", dst}); code == 0 {
		t.Fatal("vault-restore accepted an archive containing a symlink entry")
	}
}

func TestVaultRestoreRejectsAnArchiveThatIsNotOne(t *testing.T) {
	dir := t.TempDir()
	notGzip := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(notGzip, []byte("this is not a backup"), 0o600); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "state")
	if code := runVaultRestoreCLI([]string{notGzip, "--confirm", "restore", "--state-dir", dst}); code == 0 {
		t.Fatal("vault-restore accepted a file that is not a gzip archive")
	}
}

// --- helpers -------------------------------------------------------------

// goodArchive produces a real backup of a real fake state dir, via the real
// command. Hand-authoring the tar would only prove the reader agrees with
// whoever typed the fixture, and would keep passing after the writer drifted.
func goodArchive(t *testing.T) string {
	t.Helper()
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	if code := runVaultBackupCLI([]string{archive, "--state-dir", fakeStateDir(t)}); code != 0 {
		t.Fatalf("building the fixture archive failed with exit %d", code)
	}
	return archive
}

type tarEntry struct {
	name     string
	body     []byte
	link     string
	typeflag byte
}

func writeTarGz(t *testing.T, dest string, entries []tarEntry) {
	t.Helper()
	f, err := os.Create(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		flag := e.typeflag
		if flag == 0 {
			flag = tar.TypeReg
		}
		hdr := &tar.Header{
			Name: e.name, Mode: 0o600, Typeflag: flag,
			Size: int64(len(e.body)), Linkname: e.link,
		}
		if flag != tar.TypeReg {
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if flag == tar.TypeReg {
			if _, err := tw.Write(e.body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
}

func archiveNames(t *testing.T, archive string) []string {
	t.Helper()
	f, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	var names []string
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err != nil {
			break
		}
		names = append(names, hdr.Name)
	}
	return names
}

func archiveBody(t *testing.T, archive string) []byte {
	t.Helper()
	f, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(gz); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
