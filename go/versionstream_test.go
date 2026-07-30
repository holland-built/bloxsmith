package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// WHICH STREAM THE OUTPUT GOES TO IS PART OF THE CONTRACT.
//
// `bloxsmith --version` printed to STDERR for its whole life, because Go's builtin
// println writes there and nothing ever captured the output to notice. Every caller
// ran it for its visible side effect: CI's install steps just invoke it, and the
// Homebrew formula's `system "#{bin}/bloxsmith", "--version"` checks only the exit
// code. So `V=$(bloxsmith --version)` — the one thing a script would actually do —
// returned an empty string.
//
// Found by a CI step that tried to capture it. This test exists so the fix cannot
// quietly regress the next time someone reaches for the builtin, and it is a
// SUBPROCESS test on purpose: the stream is only observable from outside the
// process, so asserting it any other way would not be asserting it at all.

// buildCLI compiles the real binary once for the tests below.
func buildCLI(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "bloxsmith")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

// run returns stdout and stderr separately — the whole point.
func run(t *testing.T, bin string, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	cmd := exec.Command(bin, args...)
	// A bare HOME so the binary cannot read the developer's real config while
	// printing help.
	cmd.Env = append(os.Environ(), "HOME="+t.TempDir())
	var so, se strings.Builder
	cmd.Stdout = &so
	cmd.Stderr = &se
	err := cmd.Run()
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("run %v: %v", args, err)
	}
	return so.String(), se.String(), code
}

func TestVersionGoesToStdoutSoAScriptCanCaptureIt(t *testing.T) {
	bin := buildCLI(t)

	for _, flag := range []string{"--version", "-v"} {
		stdout, stderr, code := run(t, bin, flag)
		if code != 0 {
			t.Fatalf("%s exited %d", flag, code)
		}
		// This is the assertion that failed before the fix.
		if !strings.HasPrefix(stdout, "bloxsmith ") {
			t.Fatalf("%s wrote nothing usable to STDOUT (got %q; stderr was %q) — "+
				"`V=$(bloxsmith %s)` would capture an empty string", flag, stdout, stderr, flag)
		}
		if strings.Contains(stderr, "bloxsmith ") {
			t.Fatalf("%s still writes the version to STDERR: %q", flag, stderr)
		}
	}
}

// Same root cause, and it breaks `bloxsmith --help | less`.
func TestHelpGoesToStdout(t *testing.T) {
	bin := buildCLI(t)

	for _, args := range [][]string{
		{"--help"},
		{"update", "--help"},
		{"vault-passphrase", "--help"},
		{"audit", "--help"},
		{"service", "--help"},
	} {
		stdout, stderr, code := run(t, bin, args...)
		if code != 0 {
			t.Fatalf("%v exited %d (stderr %q)", args, code, stderr)
		}
		if !strings.Contains(stdout, "usage") && !strings.Contains(stdout, "Moves the vault") {
			t.Fatalf("%v printed no usage to STDOUT (stdout %q, stderr %q) — `... --help | less` "+
				"would show nothing", args, stdout, stderr)
		}
	}
}

// The other half of the contract: an ERROR still goes to stderr. Sending everything
// to stdout would be the opposite mistake, and would put a failure message into a
// script's captured output as though it were the answer.
func TestBadUsageStillGoesToStderr(t *testing.T) {
	bin := buildCLI(t)

	for _, tc := range []struct {
		args     []string
		wantCode int
		wantErr  string
	}{
		{[]string{"vault-passphrase", "frobnicate"}, 3, "unknown subcommand"},
		// --vault must come AFTER a subcommand: as args[0] it is read as the
		// subcommand itself, which is a different (also-correct) refusal.
		{[]string{"vault-passphrase", "status", "--vault"}, 3, "requires a value"},
		{[]string{"vault-passphrase", "--vault"}, 3, "unknown subcommand"},
		{[]string{"service", "frobnicate"}, 2, "unknown service command"},
	} {
		stdout, stderr, code := run(t, bin, tc.args...)
		if code != tc.wantCode {
			t.Fatalf("%v exited %d, want %d", tc.args, code, tc.wantCode)
		}
		if !strings.Contains(stderr, tc.wantErr) {
			t.Fatalf("%v: the error is not on STDERR (stderr %q, stdout %q)", tc.args, stderr, stdout)
		}
	}
}
