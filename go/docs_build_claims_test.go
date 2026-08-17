package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// WHAT THE DOCS SAY ABOUT BUILDING THE UI, CHECKED AGAINST THE REPO.
//
// docs/DEPLOYMENT.md's "Build from source" block told a reader to run
// `node scripts/build_ui.js`, which has not existed since the Vite move, and
// described the embedded artifact as `go/web/app.bundle.js`, which does not
// exist either (#119). The failure was silent in the worst way: step 1 errored,
// step 3 (`go build`) succeeded anyway because go/web is COMMITTED, and the
// reader walked away with a binary carrying a stale UI they believed they had
// just rebuilt.
//
// WHY THIS IS NARROW AND NOT "check every path the doc names". A regex that
// harvests every repo-relative path out of 1,000 lines of prose needs an
// exception before it can even go green — DEPLOYMENT.md's cosign commands
// contain `.github/workflows/release.yml@refs/tags/` inside a
// --certificate-identity-regexp, which is a certificate identity and not a
// path. A guard whose first act is to grow an exception list is on the road to
// meaning nothing. So this asserts two things it can settle exactly:
//
//  1. the two obsolete artifact names appear NOWHERE in the docs or CI, and
//  2. the commands the build block tells a reader to run actually exist.
//
// It is not a review of DEPLOYMENT.md, and passing it says nothing about the
// rest of that document.

// obsoleteBuildNames are build artifacts this repo stopped producing at the
// Vite move. Each is listed with what replaced it, because the failure mode is
// someone copying an old sentence forward, and a bare "don't say this" leaves
// them nothing to say instead.
var obsoleteBuildNames = map[string]string{
	"scripts/build_ui.js": "the UI is built by `cd ui && npm run build` (vite), which writes ui/dist",
	"app.bundle.js":       "the embedded tree is go/web: an index.html plus hashed assets/*.js",
}

// docsAndCIFiles are the files a reader or a maintainer takes build
// instructions from. Paths are relative to this package (CI runs `go test` with
// working-directory: go).
var docsAndCIFiles = []string{
	"../docs/DEPLOYMENT.md",
	"../docs/SHIP.md",
	"../README.md",
	"../go/BUILD.md",
	"../.github/workflows/ci.yml",
	"../.github/workflows/release.yml",
}

// scanForObsolete is the assertion, taken as a pure function of the content so
// the tests below can feed it a fixture string instead of editing a tracked
// file to prove it refuses.
func scanForObsolete(name, content string) []string {
	var hits []string
	for _, line := range strings.Split(content, "\n") {
		for bad, instead := range obsoleteBuildNames {
			if strings.Contains(line, bad) {
				hits = append(hits, name+": "+bad+" — "+instead)
			}
		}
	}
	return hits
}

// TestDocsNameNoObsoleteBuildArtifact is the regression guard for #119.
func TestDocsNameNoObsoleteBuildArtifact(t *testing.T) {
	checked := 0
	for _, path := range docsAndCIFiles {
		raw, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				// A file listed here and missing is itself worth knowing about:
				// this guard silently checking four files instead of six is how
				// it would stop meaning anything.
				t.Errorf("%s is listed for this check and is not there — either it moved and this "+
					"list is stale, or something a reader takes build instructions from was deleted", path)
				continue
			}
			t.Fatalf("read %s: %v", path, err)
		}
		checked++
		for _, hit := range scanForObsolete(path, string(raw)) {
			t.Errorf("%s\n  That name does not exist in this repo. A reader following it gets a "+
				"binary built from whatever go/web already held, because go/web is committed and "+
				"`go build` never complains.", hit)
		}
	}
	if checked == 0 {
		t.Fatal("no files were read, so this test proved nothing")
	}
}

// The guard's own negative half: fed a document containing the old sentences it
// must refuse, and fed the corrected ones it must not. Without this, a typo in
// obsoleteBuildNames would leave every assertion above passing on a pattern
// that can never match.
func TestScanForObsoleteRefusesTheOldSentences(t *testing.T) {
	bad := "node scripts/build_ui.js              # compile src/*.jsx → go/web/app.bundle.js\n" +
		"inside it (`go/web/app.bundle.js`) is a minified blob embedded with `go:embed`.\n"
	hits := scanForObsolete("fixture.md", bad)
	if len(hits) != 3 {
		t.Fatalf("hits = %d (%v), want 3 — one for build_ui.js and one for each app.bundle.js", len(hits), hits)
	}

	good := "cd ui && npm ci && npm run build && cd ..\n" +
		"rm -rf go/web/* && cp -R ui/dist/* go/web/\n" +
		"inside it (`go/web/`, an `index.html` plus hashed `assets/*.js`) is the built UI.\n"
	if hits := scanForObsolete("fixture.md", good); len(hits) != 0 {
		t.Fatalf("the corrected wording was rejected: %v — this guard would block the fix it exists "+
			"to protect", hits)
	}
}

// The other half of #119: the doc now names two commands, and a doc is only
// worth as much as whether they run. `npm run build` is only a command because
// ui/package.json declares that script, and the copy step is only correct
// because go/embed.go embeds that tree.
func TestBuildInstructionsPointAtRealCommands(t *testing.T) {
	raw, err := os.ReadFile("../ui/package.json")
	if err != nil {
		t.Fatalf("read ui/package.json: %v", err)
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatalf("parse ui/package.json: %v", err)
	}
	if pkg.Scripts["build"] == "" {
		t.Fatalf("ui/package.json declares no \"build\" script, but docs/DEPLOYMENT.md and "+
			".github/workflows/ci.yml both tell you to run `npm run build`; scripts = %v", pkg.Scripts)
	}

	embed, err := os.ReadFile("embed.go")
	if err != nil {
		t.Fatalf("read go/embed.go: %v", err)
	}
	if !strings.Contains(string(embed), "//go:embed all:web") {
		t.Fatalf("go/embed.go no longer embeds the web tree with `//go:embed all:web`, so the "+
			"documented \"copy ui/dist into go/web\" step no longer puts the UI in the binary:\n%s", embed)
	}

	// And the destination the copy step names is really there, tracked, which
	// is precisely why a skipped rebuild is silent rather than a build error.
	if st, err := os.Stat(filepath.Join("web", "index.html")); err != nil || st.IsDir() {
		t.Fatalf("go/web/index.html is not a file (%v) — the embedded tree the docs describe is "+
			"not what is on disk", err)
	}
}
