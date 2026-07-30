// Command auditfixture writes a genuine signed audit chain, for
// scripts/audit-verify-test.sh to run the shipped verifier against.
//
// It is a committed tool rather than a file the test script drops into the
// module and deletes again: a script that writes into its own repository leaves
// the tree dirty when it fails partway, and `go build ./...` would then pick up
// a half-written file. It builds and vets with everything else, which is the
// point — a fixture generator that stopped compiling would otherwise be
// discovered only by a failing test with a confusing message.
//
// It is NOT part of the shipped binary: .goreleaser.yaml builds `main: .` only.
//
// The chain is produced by the real audit.Log writer. A hand-authored fixture
// would only prove the verifier agrees with whoever wrote the fixture.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"bloxsmith/internal/audit"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: auditfixture <state-dir> <trust-dir> [entries]")
		os.Exit(2)
	}
	stateDir, trustDir := os.Args[1], os.Args[2]
	n := 5
	if len(os.Args) > 3 {
		v, err := strconv.Atoi(os.Args[3])
		if err != nil || v < 0 {
			fmt.Fprintf(os.Stderr, "entries must be a non-negative integer, got %q\n", os.Args[3])
			os.Exit(2)
		}
		n = v
	}

	l := audit.New(filepath.Join(stateDir, "audit_log.jsonl"), "app-vtest", "inst-1",
		audit.Options{TrustDir: trustDir})
	if err := l.KeyError(); err != nil {
		fmt.Fprintln(os.Stderr, "could not establish an audit key:", err)
		os.Exit(1)
	}
	for i := 0; i < n; i++ {
		if _, err := l.Append("fixture-event", "tester", map[string]any{"n": i}); err != nil {
			fmt.Fprintf(os.Stderr, "append %d: %v\n", i, err)
			os.Exit(1)
		}
	}
	// Refuse to report success on a chain that does not verify: a fixture that is
	// already broken would make every downstream check meaningless.
	if v, detail := audit.Classify(l.Verify()); v != audit.Intact {
		fmt.Fprintf(os.Stderr, "the generated chain does not verify (%s): %s\n", v, detail)
		os.Exit(1)
	}
	fmt.Printf("wrote %d signed entries\n", n)
}
