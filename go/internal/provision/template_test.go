package provision

import (
	"strings"
	"testing"
)

// These two used to assert TemplatesInstalled, a bool wrapper that has been
// removed. The state check moved to TemplatesDirState, which is what every
// caller needs anyway — but the LoadTemplate assertion below is the half worth
// keeping and would have gone with it: a missing directory must produce the
// "templates not installed" ADVICE, not a bare file-not-found, because that
// sentence is what tells the operator to get the release archive.
func TestTemplatesDirStateMissingDir(t *testing.T) {
	e := New(nil, t.TempDir()+"/does-not-exist")
	if state, _ := e.TemplatesDirState(); state == DirPresent {
		t.Fatal("expected a missing dir not to report DirPresent")
	}
	if _, err := e.LoadTemplate("blocks/regional_address_blocks.yaml"); err == nil ||
		!strings.Contains(err.Error(), "templates not installed") {
		t.Fatalf("want 'templates not installed' error, got %v", err)
	}
}

func TestTemplatesDirStateExistingDir(t *testing.T) {
	if state, _ := New(nil, t.TempDir()).TemplatesDirState(); state != DirPresent {
		t.Fatalf("state = %v for an existing dir, want DirPresent", state)
	}
}
