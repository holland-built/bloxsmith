package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The regression this file covers (#95): `/Users/sholland/AI/Infoblox MCP/.env`
// was compiled into every release for four weeks. The repo already pays for
// `-trimpath` to keep build-machine paths out of the artifact, and measured on
// that commit it worked perfectly — 896 toolchain paths went to 0 — while the
// one path that mattered survived, because -trimpath rewrites paths the
// COMPILER embeds and has no opinion about a string the SOURCE declares.
//
// So nothing in the toolchain can catch the next one. This is the only
// mechanism that can: read the source and refuse.

// homePathLiteral matches an absolute path into a user's home directory, on
// either family of platform. Windows is included because releases cross-compile
// there (go/.goreleaser.yaml) and `C:\Users\alice\project` would ship exactly
// the same way a POSIX one does.
//
// A UNC prefix (\\server\share) was in the first draft of this pattern and is
// deliberately gone: the synthetic test below caught it matching a bare "\\"
// literal — an escaped path separator — in two files that are entirely
// innocent. A UNC path is not a home directory, and a guard with false
// positives is a guard people switch off.
var homePathLiteral = regexp.MustCompile(`^(?:/(?:Users|home)/[^/]+/|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])`)

// scanForHomePaths parses every non-test .go file under root and returns one
// "file:line: value" finding per STRING LITERAL whose value is an absolute home
// path.
//
// SCOPE, stated rather than implied. This inspects standalone string literals
// only. A path assembled by concatenation ("/Users/" + name) or built at
// runtime is NOT caught, and constant-folding the whole package to close that
// would be a type-checking pass rather than a parse. The defect that prompted
// this was a single literal, every one of the four sibling CLI commands builds
// its paths at runtime, and a guard that catches the shape that actually
// shipped is worth more than none. It is a floor, not a ceiling.
//
// Test files are excluded on purpose: a fixture may legitimately name a home
// path to assert something about one, and those files are not in the binary.
//
// root is a parameter, not a constant, so this function can be pointed at a
// synthetic tree — which is how the guard itself gets watched failing.
func scanForHomePaths(root string) ([]string, error) {
	var findings []string
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// Vendored and generated trees are not ours to police.
			if name := d.Name(); name == "vendor" || name == "node_modules" || name == "web" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			val, err := strconv.Unquote(lit.Value)
			if err != nil {
				return true
			}
			if homePathLiteral.MatchString(val) {
				pos := fset.Position(lit.Pos())
				findings = append(findings, fmt.Sprintf("%s:%d: %q", pos.Filename, pos.Line, val))
			}
			return true
		})
		return nil
	})
	return findings, err
}

// TestNoHardcodedHomePaths is the guard. It scans the whole module, not just
// this package: `internal/**` is compiled into the same binary and a literal
// there ships identically.
func TestNoHardcodedHomePaths(t *testing.T) {
	findings, err := scanForHomePaths(".")
	if err != nil {
		t.Fatalf("scan failed: %v", err)
	}
	if len(findings) > 0 {
		t.Fatalf("%d absolute home-directory path(s) are compiled into this binary. "+
			"-trimpath removes build-machine paths the COMPILER embeds and cannot touch a string "+
			"literal, so every one of these ships to every operator (#95):\n  %s",
			len(findings), strings.Join(findings, "\n  "))
	}
}

// TestScanForHomePaths_FindsWhatItClaimsTo drives the scanner against a
// synthetic tree, so the guard above is not the only thing standing behind it.
// Without this, a scanner that silently found nothing — a bad regex, a walk
// that skipped everything — would pass forever and look like a clean repo.
func TestScanForHomePaths_FindsWhatItClaimsTo(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	write("bad.go", `package p

const macPath = "/Users/someone/project/.env"
const linuxPath = "/home/someone/project/.env"
const windowsPath = "C:\\Users\\someone\\project\\.env"
`)
	// Everything here must be ignored, and each line is a way the guard could
	// go wrong: a relative path, a system path that is not a home directory, a
	// URL that merely contains the word, and a home path in a TEST file.
	write("good.go", `package p

const rel = ".env"
const etc = "/etc/bloxsmith/.env"
const url = "https://example.com/Users/someone"
const varLib = "/var/lib/bloxsmith"
`)
	write("fixture_test.go", `package p

const fixture = "/Users/someone/expected/output"
`)

	findings, err := scanForHomePaths(dir)
	if err != nil {
		t.Fatalf("scan failed: %v", err)
	}
	if len(findings) != 3 {
		t.Fatalf("got %d findings, want 3 (mac, linux, windows):\n  %s",
			len(findings), strings.Join(findings, "\n  "))
	}
	// Compare against the QUOTED form: findings render the value with %q, so a
	// Windows path's separators arrive escaped. Comparing the raw string here
	// failed on formatting while the detection was fine — a way for this test
	// to lie in the safe direction, which is still lying.
	for _, want := range []string{"/Users/someone/project/.env", "/home/someone/project/.env", `C:\Users\someone\project\.env`} {
		found := false
		for _, f := range findings {
			if strings.Contains(f, strconv.Quote(want)) {
				found = true
			}
		}
		if !found {
			t.Errorf("missed %q; findings were:\n  %s", want, strings.Join(findings, "\n  "))
		}
	}
	for _, mustNot := range []string{"/etc/", "example.com", "/var/lib", "expected/output"} {
		for _, f := range findings {
			if strings.Contains(f, mustNot) {
				t.Errorf("false positive on %q: %s", mustNot, f)
			}
		}
	}
}

// TestLoadForegroundEnv_ChainIsCwdThenService pins the composed order the fix
// leaves behind, which is the thing a future edit would break: the working
// directory first, the shared config dir second, and the REAL environment ahead
// of both. It reads the source rather than running the loader, because running
// it would mutate this process's environment for every other test in the
// package — and the ordering is a property of the call sequence, which is
// exactly what is written here.
func TestLoadForegroundEnv_ChainIsCwdThenService(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	start := strings.Index(body, "func loadForegroundEnv() {")
	if start < 0 {
		t.Fatal("loadForegroundEnv is gone; this test needs rewriting, not deleting")
	}
	end := strings.Index(body[start:], "\n}")
	fn := body[start : start+end]

	cwd := strings.Index(fn, `config.LoadDotEnv(".env")`)
	svc := strings.Index(fn, "config.LoadServiceEnv()")
	if cwd < 0 || svc < 0 {
		t.Fatalf("the foreground chain no longer loads the cwd .env then the service env:\n%s", fn)
	}
	if cwd > svc {
		t.Errorf("the service env is loaded before the working directory's .env; "+
			"LoadDotEnv is first-wins, so that silently demotes the operator's own file:\n%s", fn)
	}
	if strings.Count(fn, "config.LoadDotEnv") != 1 {
		t.Errorf("the foreground chain grew another .env entry. That is a precedence change and "+
			"needs its own reasoning — see the comment above the function:\n%s", fn)
	}
}
