package provision

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A template the server cannot READ is not a template that does not EXIST.
// Six sites used to answer both questions with the same silence. #134
//
// Every permission case skips under root, where the bits do not apply. They use
// 0000 rather than 0300 deliberately: the owner execute bit permits traversal,
// so a 0300 directory does not block os.Stat and would prove nothing.

const goodTemplate = "site:\n  name: hq\n  region: emea\n  environment: prod\nnetwork:\n  ip_space: default\n  subnet_size: 24\ndns:\n  parent: example.com\n"

func skipIfRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("running as root — permission bits do not apply")
	}
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// rowsByName indexes a ListTemplates result so a case can assert on one entry
// without depending on the order of the rest.
func rowsByName(list []M) map[string]M {
	out := map[string]M{}
	for _, r := range list {
		out[pyStr(r["name"])] = r
	}
	return out
}

// --- ListTemplates: what it could not read is reported, not dropped ----------

func TestListTemplates_UnparseableTemplateIsListedNotHidden(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "good.yaml"), goodTemplate)
	write(t, filepath.Join(dir, "typo.yaml"), "site:\n  name: [unclosed\n")
	// Valid YAML, but a list at the top level — it parses and still cannot be
	// a template. This one had its own silent `continue`.
	write(t, filepath.Join(dir, "alist.yaml"), "- one\n- two\n")

	list, err := New(nil, dir).ListTemplates()
	if err != nil {
		t.Fatalf("ListTemplates() error = %v", err)
	}
	rows := rowsByName(list)
	if len(rows) != 3 {
		t.Fatalf("listed %d templates, want 3 — every file on disk must appear: %v", len(rows), rows)
	}
	if rows["good.yaml"]["valid"] != true {
		t.Fatalf("good.yaml valid = %v, want true", rows["good.yaml"]["valid"])
	}
	if _, present := rows["good.yaml"]["error"]; present {
		t.Fatalf("good.yaml carries an error key it should not: %v", rows["good.yaml"]["error"])
	}
	for name, want := range map[string]string{
		"typo.yaml":  "not valid YAML",
		"alist.yaml": "not a mapping",
	} {
		row := rows[name]
		if row["valid"] != false {
			t.Errorf("%s valid = %v, want false", name, row["valid"])
		}
		if row["kind"] != "scan-error" {
			t.Errorf("%s kind = %v, want scan-error so a consumer can tell it from a merely invalid template", name, row["kind"])
		}
		if msg := pyStr(row["error"]); !strings.Contains(msg, want) {
			t.Errorf("%s error = %q, want it to contain %q", name, msg, want)
		}
	}
}

// A template that parses but fails schema validation keeps its existing
// treatment — this fix must not reclassify it as a scan error.
func TestListTemplates_SchemaInvalidTemplateIsUnchanged(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "noname.yaml"), "site:\n  name: \"\"\nnetwork:\n  subnet_size: 24\n")

	list, _ := New(nil, dir).ListTemplates()
	row := rowsByName(list)["noname.yaml"]
	if row["valid"] != false {
		t.Fatalf("valid = %v, want false", row["valid"])
	}
	if _, present := row["kind"]; present {
		t.Fatalf("kind = %v, want absent — this template scanned fine, it just failed validation", row["kind"])
	}
}

func TestListTemplates_UnreadableDirectoryIsReportedAndDoesNotHideTheRest(t *testing.T) {
	skipIfRoot(t)
	dir := t.TempDir()
	write(t, filepath.Join(dir, "good.yaml"), goodTemplate)
	locked := filepath.Join(dir, "locked")
	write(t, filepath.Join(locked, "hidden.yaml"), goodTemplate)
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(locked, 0o755)

	list, err := New(nil, dir).ListTemplates()
	if err != nil {
		t.Fatalf("ListTemplates() error = %v, want nil — one bad directory must not hide every good template", err)
	}
	rows := rowsByName(list)
	if rows["good.yaml"] == nil {
		t.Fatalf("the readable template disappeared: %v", rows)
	}
	row := rows["locked"]
	if row == nil {
		t.Fatalf("the unreadable directory is not reported at all: %v", rows)
	}
	if row["valid"] != false || row["kind"] != "scan-error" {
		t.Fatalf("locked row = %v, want valid:false kind:scan-error", row)
	}
	if msg := pyStr(row["error"]); !strings.Contains(msg, "could not be searched") {
		t.Fatalf("locked error = %q, want it to say the directory could not be searched", msg)
	}
}

// --- SiteTemplateRelPaths: unreadable is not empty ---------------------------

func TestSiteTemplateRelPaths_ReadableRegionReturnsItsTemplates(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "emea", "lab", "site-emea-lab.yaml"), goodTemplate)

	paths, unreadable := New(nil, dir).SiteTemplateRelPaths([]string{"emea"})
	if len(unreadable) != 0 {
		t.Fatalf("unreadable = %v, want empty", unreadable)
	}
	if len(paths) != 1 || paths[0] != filepath.Join("emea", "lab", "site-emea-lab.yaml") {
		t.Fatalf("paths = %v, want the one site template", paths)
	}
}

func TestSiteTemplateRelPaths_UnreadableRegionIsNamed(t *testing.T) {
	skipIfRoot(t)
	dir := t.TempDir()
	write(t, filepath.Join(dir, "emea", "lab", "site-emea-lab.yaml"), goodTemplate)
	write(t, filepath.Join(dir, "amer", "lab", "site-amer-lab.yaml"), goodTemplate)
	if err := os.Chmod(filepath.Join(dir, "emea"), 0o000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(filepath.Join(dir, "emea"), 0o755)

	paths, unreadable := New(nil, dir).SiteTemplateRelPaths([]string{"emea", "amer"})
	if len(unreadable) != 1 || unreadable[0] != "emea" {
		t.Fatalf("unreadable = %v, want [emea] — os.Stat succeeds on a 0000 dir and Glob swallows the error, so only os.ReadDir can see this", unreadable)
	}
	if len(paths) != 1 {
		t.Fatalf("paths = %v, want the readable region's template — one bad region must not lose the others", paths)
	}
}

// A region whose SUBdirectory is unreadable is also incomplete. The region
// itself opens fine, so a check that stopped at the top level would miss it.
func TestSiteTemplateRelPaths_UnreadableSubdirectoryMakesTheRegionIncomplete(t *testing.T) {
	skipIfRoot(t)
	dir := t.TempDir()
	inner := filepath.Join(dir, "emea", "lab")
	write(t, filepath.Join(inner, "site-emea-lab.yaml"), goodTemplate)
	if err := os.Chmod(inner, 0o000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(inner, 0o755)

	_, unreadable := New(nil, dir).SiteTemplateRelPaths([]string{"emea"})
	if len(unreadable) != 1 || unreadable[0] != "emea" {
		t.Fatalf("unreadable = %v, want [emea]", unreadable)
	}
}

// THE TWO NEGATIVE CASES, which are the whole point of the distinction. Empty
// and absent are real answers; reporting them as unreadable would replace one
// wrong answer with another.
func TestSiteTemplateRelPaths_EmptyAndAbsentAreNotUnreadable(t *testing.T) {
	dir := t.TempDir()
	// present, readable, holds no site-*.yaml
	if err := os.MkdirAll(filepath.Join(dir, "emea", "lab"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "emea", "lab", "notes.txt"), "nothing")

	paths, unreadable := New(nil, dir).SiteTemplateRelPaths([]string{"emea", "apac"})
	if len(unreadable) != 0 {
		t.Fatalf("unreadable = %v, want empty — 'emea' is readable but empty and 'apac' does not exist", unreadable)
	}
	if len(paths) != 0 {
		t.Fatalf("paths = %v, want empty", paths)
	}
}

// --- the templates directory itself: three answers, not two -----------------

func TestTemplatesDirState_ThreeAnswers(t *testing.T) {
	dir := t.TempDir()
	e := New(nil, dir)
	if state, _ := e.TemplatesDirState(); state != DirPresent {
		t.Fatalf("state = %v, want DirPresent", state)
	}
	if e.TemplatesUnavailable() != "" {
		t.Fatalf("a real directory must read as usable, got %q", e.TemplatesUnavailable())
	}

	absent := New(nil, filepath.Join(dir, "nope"))
	if state, _ := absent.TemplatesDirState(); state != DirAbsent {
		t.Fatalf("state = %v, want DirAbsent", state)
	}
	if msg := absent.TemplatesUnavailable(); !strings.Contains(msg, "release archive") {
		t.Fatalf("absent message = %q, want the re-download advice", msg)
	}

	// A file where a directory should be: something IS there, so telling the
	// operator nothing is installed would send them to create what exists.
	filePath := filepath.Join(dir, "afile")
	write(t, filePath, "x")
	if state, _ := New(nil, filePath).TemplatesDirState(); state != DirUnreadable {
		t.Fatalf("a file in the directory's place must be DirUnreadable")
	}
}

func TestTemplatesUnavailable_UnreadableDoesNotAdviseReDownloading(t *testing.T) {
	skipIfRoot(t)
	outer := t.TempDir()
	inner := filepath.Join(outer, "templates")
	if err := os.MkdirAll(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(outer, 0o000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(outer, 0o755)

	e := New(nil, inner)
	if state, _ := e.TemplatesDirState(); state != DirUnreadable {
		t.Fatalf("state = %v, want DirUnreadable", state)
	}
	msg := e.TemplatesUnavailable()
	if !strings.Contains(msg, "could not be read") {
		t.Fatalf("message = %q, want it to say the directory could not be read", msg)
	}
	// The remedy must not be one that cannot work. Re-pulling the image does
	// nothing about a permission bit, and sending an operator to rebuild a
	// deployment over a chmod is the failure this fix exists to remove.
	for _, forbidden := range []string{"release archive", "container image", "not installed"} {
		if strings.Contains(msg, forbidden) {
			t.Fatalf("message = %q, must not mention %q — that remedy cannot fix a permission bit", msg, forbidden)
		}
	}
	if _, err := e.LoadTemplate("good.yaml"); err == nil || !strings.Contains(err.Error(), "could not be read") {
		t.Fatalf("LoadTemplate error = %v, want the same read diagnosis", err)
	}
}

// An individual template file that exists but cannot be opened was reported as
// "template not found" — absent, when the operator can see it in the listing.
func TestLoadTemplate_UnreadableFileIsNotReportedAsMissing(t *testing.T) {
	skipIfRoot(t)
	dir := t.TempDir()
	p := filepath.Join(dir, "locked.yaml")
	write(t, p, goodTemplate)
	if err := os.Chmod(p, 0o000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(p, 0o644)

	e := New(nil, dir)
	_, err := e.LoadTemplate("locked.yaml")
	if err == nil {
		t.Fatalf("LoadTemplate() error = nil, want a refusal")
	}
	if strings.Contains(err.Error(), "not found") {
		t.Fatalf("error = %q, want it NOT to claim the template is missing — it is right there", err)
	}
	if !strings.Contains(err.Error(), "could not be read") {
		t.Fatalf("error = %q, want it to say the file could not be read", err)
	}

	// A genuinely absent template keeps the old sentence.
	if _, err := e.LoadTemplate("nope.yaml"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("absent template error = %v, want the unchanged 'not found'", err)
	}
}
