package provision

import (
	"strings"
	"testing"
)

func TestTemplatesInstalledMissingDir(t *testing.T) {
	e := New(nil, t.TempDir()+"/does-not-exist")
	if e.TemplatesInstalled() {
		t.Fatal("expected TemplatesInstalled=false for a missing dir")
	}
	if _, err := e.LoadTemplate("blocks/regional_address_blocks.yaml"); err == nil ||
		!strings.Contains(err.Error(), "templates not installed") {
		t.Fatalf("want 'templates not installed' error, got %v", err)
	}
}

func TestTemplatesInstalledExistingDir(t *testing.T) {
	if !New(nil, t.TempDir()).TemplatesInstalled() {
		t.Fatal("expected TemplatesInstalled=true for an existing dir")
	}
}
