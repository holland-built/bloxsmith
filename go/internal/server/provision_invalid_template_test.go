package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/provision"
)

// --- an invalid template must never start a real build -----------------------
//
// /api/templates/validate runs ValidateTemplate, and the UI labels a template
// "(invalid)" from its answer — but provisionSiteStream never ran it. It went
// LoadTemplate -> TemplateToSiteConfig -> Provision, and TemplateToSiteConfig
// only checks that the five required values are present and that subnet_size
// parses as an integer. Everything else ValidateTemplate catches (out-of-range
// CIDR, duplicate subnet names, DHCP offsets outside 1-254, hosts pointing at
// subnets that do not exist) passed straight through, so a template the UI had
// already marked invalid could allocate real subnets and zones and then fail
// part way through.
//
// badSiteTemplate is deliberately valid to TemplateToSiteConfig and invalid to
// ValidateTemplate — that difference IS the bug, and the test below asserts
// both halves so it cannot be "fixed" by making the two agree by accident.
const badSiteTemplate = `type: site
site:
  name: amer-bad
  region: Americas
  environment: lab
network:
  ip_space: default
  subnet_size: 25
  subnets:
    - name: amer-bad-bench
      purpose: Test bench VLAN
      cidr: 33
dns:
  parent: lab.example.com
  view: default
`

const badTemplateRel = "amer/bad/site-amer-bad.yaml"

// newTempTemplateDeps wires a Deps whose template directory is a scratch dir
// holding exactly one template, plus a counter of every upstream call the run
// makes. The counter is the "no provisioner call happened" assertion: zero is
// the only acceptable number for a refused template.
func newTempTemplateDeps(t *testing.T, body string) (*Deps, *atomic.Int32) {
	t.Helper()
	var upstreamCalls atomic.Int32
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(500)
		fmt.Fprintf(w, `{"error":"the refused template must never reach Infoblox (%s %s)"}`, r.Method, r.URL.Path)
	})
	t.Cleanup(closeSrv)
	d.Guard = &httpx.Guard{Port: "8080"}

	dir := t.TempDir()
	full := filepath.Join(dir, filepath.FromSlash(badTemplateRel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir template dir: %v", err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatalf("write template: %v", err)
	}
	d.Provision = provision.New(d.Rest, dir)
	d.Audit = audit.New(filepath.Join(t.TempDir(), "audit_log.jsonl"), "app-v-test", "test-instance",
		audit.Options{TrustDir: t.TempDir()})
	return d, &upstreamCalls
}

func TestProvisionSiteStreamRefusesInvalidTemplate(t *testing.T) {
	d, upstreamCalls := newTempTemplateDeps(t, badSiteTemplate)

	// The gap this test exists for: the config builder is happy with the file.
	tpl, err := d.Provision.LoadTemplate(badTemplateRel)
	if err != nil {
		t.Fatalf("setup: LoadTemplate(%s): %v", badTemplateRel, err)
	}
	if _, err := provision.TemplateToSiteConfig(tpl, provision.M{}); err != nil {
		t.Fatalf("setup: TemplateToSiteConfig rejected the template (%v) — this fixture no longer demonstrates the gap", err)
	}
	if v := provision.ValidateTemplate(tpl, badTemplateRel); v["valid"] != false {
		t.Fatalf("setup: ValidateTemplate calls the template valid (%v) — the fixture is wrong", v)
	}

	rr := httptest.NewRecorder()
	d.provisionSiteStream(rr, siteStreamRequest("template="+badTemplateRel+"&dry=0"))
	frames := parseSSEFrames(t, rr.Body.String())

	frame := errorFrame(t, frames)
	msg, _ := frame["error"].(string)
	if !strings.Contains(msg, badTemplateRel) {
		t.Fatalf("error frame = %q, want it to name the template file %q", msg, badTemplateRel)
	}
	if !strings.Contains(msg, "cidr") {
		t.Fatalf("error frame = %q, want it to name the offending field (…cidr)", msg)
	}
	if !strings.Contains(msg, "33") {
		t.Fatalf("error frame = %q, want it to say what is wrong with that field (the out-of-range 33)", msg)
	}
	for _, f := range frames {
		if _, ok := f["done"]; ok {
			t.Fatalf("a refused template still emitted a done frame: %v", f)
		}
	}
	if got := upstreamCalls.Load(); got != 0 {
		t.Fatalf("upstream calls = %d, want 0 — a template the UI marks (invalid) must be refused BEFORE anything is created; body=%s",
			got, rr.Body.String())
	}
}

// A preview is refused too. The file is broken either way, and a preview that
// walks a plan which can never be built is a worse answer than the refusal.
func TestProvisionSiteStreamRefusesInvalidTemplateOnDryRun(t *testing.T) {
	d, upstreamCalls := newTempTemplateDeps(t, badSiteTemplate)

	rr := httptest.NewRecorder()
	d.provisionSiteStream(rr, siteStreamRequest("template="+badTemplateRel+"&dry=1"))

	msg, _ := errorFrame(t, parseSSEFrames(t, rr.Body.String()))["error"].(string)
	if !strings.Contains(msg, badTemplateRel) {
		t.Fatalf("dry-run error frame = %q, want it to name the template file", msg)
	}
	if got := upstreamCalls.Load(); got != 0 {
		t.Fatalf("dry-run upstream calls = %d, want 0", got)
	}
}

// The bundled templates must all still build — the gate is a refusal of broken
// files, not a new obstacle in front of the good ones.
func TestProvisionSiteStreamAcceptsBundledTemplates(t *testing.T) {
	e := provision.New(nil, "../../templates")
	if !e.TemplatesInstalled() {
		t.Fatalf("templates not found at ../../templates")
	}
	for _, rel := range e.SiteTemplateRelPaths([]string{"amer", "emea", "apac"}) {
		tpl, err := e.LoadTemplate(rel)
		if err != nil {
			t.Fatalf("LoadTemplate(%s): %v", rel, err)
		}
		if v := provision.ValidateTemplate(tpl, rel); v["valid"] != true {
			t.Fatalf("bundled template %s is invalid and would now be refused: %v", rel, v["errors"])
		}
	}
}
