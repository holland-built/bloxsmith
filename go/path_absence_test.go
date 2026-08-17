package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// "IT IS NOT THERE" AND "I COULD NOT LOOK" MUST NOT SHARE A BRANCH.
//
// Every refuse-to-clobber guard in this binary was `if _, err := os.Stat(x); err ==
// nil`, so any stat failure that was not ErrNotExist counted as a clear target and
// the guard silently did not fire (#129).
//
// Scope: pathAbsent / dirEntries, and the two guards whose skipping is destructive
// — vault-restore's non-empty refusal and rotate's never-overwrite-the-backup
// refusal. The full CLI paths have their own files; nothing here re-asserts a
// successful backup or restore.
//
// INJECTIONS, and why these two and not others. A directory at mode 0300 refuses
// to be LISTED while still allowing files to be created in it — that is the exact
// shape that made vault-restore write over a live install. A parent at mode 0000
// refuses TRAVERSAL, which is what makes os.Stat of a child fail; a 0300 parent
// would not, because the owner execute bit permits traversal, and an earlier draft
// of these tests got that wrong.
//
// Both are skipped under root, where the permission bits do not apply and the
// injection cannot reproduce. A skip is honest; a test that silently passes because
// its injection did nothing is not.

func skipIfRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("running as root: permission bits do not apply, so the injection cannot reproduce")
	}
}

// unlistableDir returns a directory that holds a file and refuses to be listed.
func unlistableDir(t *testing.T) string {
	t.Helper()
	skipIfRoot(t)
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "vault.json"), []byte("live install\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Chmod(dir, 0o300); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) }) // or t.TempDir cannot clean up
	if _, err := os.ReadDir(dir); err == nil {
		t.Skip("this filesystem lists a 0300 directory anyway; the injection did not take")
	}
	return dir
}

// unstattableChild returns a path whose PARENT cannot be traversed, so stat of the
// child fails with something that is not ErrNotExist.
func unstattableChild(t *testing.T) string {
	t.Helper()
	skipIfRoot(t)
	parent := filepath.Join(t.TempDir(), "locked")
	if err := os.MkdirAll(parent, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	child := filepath.Join(parent, "target")
	if err := os.WriteFile(child, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Chmod(parent, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0o700) })
	if _, err := os.Stat(child); err == nil {
		t.Skip("this filesystem stats through a 0000 directory; the injection did not take")
	}
	return child
}

func TestPathAbsent_TellsTheThreeAnswersApart(t *testing.T) {
	dir := t.TempDir()
	present := filepath.Join(dir, "here")
	if err := os.WriteFile(present, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	if absent, err := pathAbsent(present); absent || err != nil {
		t.Errorf("pathAbsent(existing) = %v, %v — want false, nil", absent, err)
	}
	if absent, err := pathAbsent(filepath.Join(dir, "nope")); !absent || err != nil {
		t.Errorf("pathAbsent(missing) = %v, %v — want true, nil", absent, err)
	}

	blocked := unstattableChild(t)
	absent, err := pathAbsent(blocked)
	if err == nil {
		t.Fatalf("pathAbsent(unstattable) returned err = nil, so the failure is invisible to callers")
	}
	if absent {
		t.Errorf("pathAbsent(unstattable) = true — an unknown path reported as ABSENT is the defect: "+
			"every guard here then treats it as a clear target (err was %v)", err)
	}
}

func TestDirEntries_TellsTheThreeAnswersApart(t *testing.T) {
	dir := t.TempDir()
	if entries, absent, err := dirEntries(dir); absent || err != nil || len(entries) != 0 {
		t.Errorf("dirEntries(empty existing) = %d entries, %v, %v — want 0, false, nil", len(entries), absent, err)
	}
	if _, absent, err := dirEntries(filepath.Join(dir, "nope")); !absent || err != nil {
		t.Errorf("dirEntries(missing) = %v, %v — want true, nil", absent, err)
	}

	blocked := unlistableDir(t)
	entries, absent, err := dirEntries(blocked)
	if err == nil {
		t.Fatalf("dirEntries(unlistable) returned err = nil, so the failure is invisible")
	}
	if absent {
		t.Error("dirEntries(unlistable) reported the directory as ABSENT — it is the live install")
	}
	if len(entries) != 0 {
		t.Errorf("dirEntries(unlistable) returned %d entries alongside an error; callers must get nothing "+
			"to iterate", len(entries))
	}
}

// THE ONE THAT MATTERS: vault-restore must refuse a state dir it cannot list, and
// must leave the files that were in it exactly where they were — INCLUDING under
// --force, because --force authorises replacing named files and cannot authorise a
// promise about contents nobody can read.
func TestVaultRestore_RefusesAStateDirItCannotList(t *testing.T) {
	// A REAL archive, made by this binary's own vault-backup from a clean dir, so a
	// refusal cannot be the source being missing or malformed. Without it the test
	// would pass for the wrong reason on a tree where the guard was removed.
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "vault.json"), []byte("archived\n"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	if code := runVaultBackupCLI([]string{archive, "--state-dir", source}); code != 0 {
		t.Fatalf("vault-backup exited %d building the fixture", code)
	}

	dir := unlistableDir(t)

	for _, force := range []bool{false, true} {
		name := "without --force"
		if force {
			name = "with --force"
		}
		t.Run(name, func(t *testing.T) {
			args := []string{archive, "--confirm", "restore", "--state-dir", dir}
			if force {
				args = append(args, "--force")
			}
			if code := runVaultRestoreCLI(args); code == 0 {
				t.Fatalf("vault-restore exited 0 %s — it wrote into a directory it could not inspect", name)
			}
			// The refusal must not have been the archive being missing: prove the
			// live file is still there and untouched.
			if err := os.Chmod(dir, 0o700); err != nil {
				t.Fatalf("chmod: %v", err)
			}
			b, err := os.ReadFile(filepath.Join(dir, "vault.json"))
			if err != nil {
				t.Fatalf("the pre-existing vault.json is gone: %v", err)
			}
			if strings.TrimSpace(string(b)) != "live install" {
				t.Errorf("vault.json content = %q, want it untouched", string(b))
			}
			if err := os.Chmod(dir, 0o300); err != nil {
				t.Fatalf("chmod back: %v", err)
			}
		})
	}
}

// rotate must not write its pre-rotate backup when it cannot tell whether one is
// already there. The backup is the only safety net a failed first attempt leaves.
func TestRotate_RefusesWhenTheBackupPathCannotBeChecked(t *testing.T) {
	blocked := unstattableChild(t)

	absent, err := pathAbsent(blocked)
	if err == nil || absent {
		t.Fatalf("the injection did not take: pathAbsent = %v, %v", absent, err)
	}
	// passRotate's guard is `pathAbsent(backupPath)` with a refusal on a non-nil
	// error. Asserting the helper's contract here rather than driving passRotate,
	// which needs a real vault and its passphrase — the mutation table in the PR is
	// what proves the guard is wired to it.
	if absent {
		t.Error("an unstattable backup path reported as absent would let rotate overwrite it")
	}
}

// NO TEST FOR vault-backup's DESTINATION GUARD, and this is the honest reason.
//
// I wrote one, then watched it PASS with the refusal removed: a destination whose
// parent cannot be traversed also cannot be created, so vault-backup exits
// non-zero either way and the test was green for the wrong reason. A stat failure
// on a path implies the open of that path fails too, so that guard changes the
// MESSAGE (and refuses before reading the state dir at all) rather than the
// outcome. Recording that here instead of shipping a test that looks like a guard
// and is not — see the mutation table in the PR for the four that are.
