package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/provision"
)

// A REGION NOBODY COULD READ IS A FAILURE, NOT AN EMPTY REGION.
//
// SiteTemplateRelPaths silently returned a short list, so a seed run over an
// unreadable region provisioned zero sites for it and streamed a summary saying
// every template it tried had succeeded. An operator ticked three regions, got
// two, and had no failure anywhere to explain the third. #134
//
// The provision and teardown streams are independent implementations of the
// same loop, so both are asserted — one can regress without the other.

const seedRegionTemplate = `type: site
site:
  name: emea-lab
  region: emea
  environment: lab
network:
  ip_space: default
  subnet_size: 24
  subnets:
    - name: emea-lab-net
      purpose: lab
      cidr: 24
dns:
  parent: lab.example.com
  view: default
`

// seedDepsWithUnreadableRegion builds a template tree with two regions and makes
// one of them unreadable, so the run has both a region it can use and a region
// it cannot.
func seedDepsWithUnreadableRegion(t *testing.T) *Deps {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("running as root — permission bits do not apply")
	}
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"upstream is irrelevant to this test"}`))
	})
	t.Cleanup(closeSrv)
	d.Guard = &httpx.Guard{Port: "8080"}

	dir := t.TempDir()
	for _, region := range []string{"emea", "apac"} {
		p := filepath.Join(dir, region, "lab", "site-"+region+"-lab.yaml")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(seedRegionTemplate), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	locked := filepath.Join(dir, "apac")
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(locked, 0o755) })

	d.Provision = provision.New(d.Rest, dir)
	d.Audit = audit.New(filepath.Join(t.TempDir(), "audit_log.jsonl"), "app-v-test", "test-instance",
		audit.Options{TrustDir: t.TempDir()})
	return d
}

// summaryList pulls one bucket out of the stream's terminal frame.
func summaryList(t *testing.T, frames []map[string]any, bucket string) []string {
	t.Helper()
	for i := len(frames) - 1; i >= 0; i-- {
		sum, ok := frames[i]["summary"].(map[string]any)
		if !ok {
			continue
		}
		raw, _ := sum[bucket].([]any)
		out := make([]string, 0, len(raw))
		for _, v := range raw {
			out = append(out, provision.PyStr(v))
		}
		return out
	}
	t.Fatalf("no terminal summary frame among %d frames", len(frames))
	return nil
}

func assertRegionReportedFailed(t *testing.T, body string) {
	t.Helper()
	frames := parseSSEFrames(t, body)
	failed := summaryList(t, frames, "failed")
	var found bool
	for _, f := range failed {
		if f == "apac" {
			found = true
		}
	}
	if !found {
		t.Fatalf("summary failed = %v, want it to name the unreadable region 'apac' — a region nobody read must not pass as a region with nothing in it", failed)
	}
	// And the operator must be told why, not merely that a count moved.
	var explained bool
	for _, f := range frames {
		if msg, _ := f["error"].(string); strings.Contains(msg, "apac") && strings.Contains(msg, "could not be read") {
			explained = true
		}
	}
	if !explained {
		t.Fatalf("no frame explains that apac could not be read; body=%s", body)
	}
}

func TestProvisionSeedDemoStream_UnreadableRegionIsAFailureNotASilence(t *testing.T) {
	d := seedDepsWithUnreadableRegion(t)
	rr := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/provision/seed-demo/stream?dry=1&regions=emea,apac", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	d.provisionSeedDemoStream(rr, r)
	assertRegionReportedFailed(t, rr.Body.String())
}

func TestTeardownSeedDemoStream_UnreadableRegionIsAFailureNotASilence(t *testing.T) {
	d := seedDepsWithUnreadableRegion(t)
	rr := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/teardown/seed-demo/stream?dry=1&regions=emea,apac", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	d.teardownSeedDemoStream(rr, r)
	assertRegionReportedFailed(t, rr.Body.String())
}

// The unreadable templates DIRECTORY gets the diagnosis that matches it. The
// preflight used to emit "templates not installed — use the release archive or
// container image", which cannot fix a permission bit.
func TestProvisionSeedDemoStream_UnreadableTemplatesDirDoesNotSayNotInstalled(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root — permission bits do not apply")
	}
	d, closeSrv := newTestDeps(t, func(w http.ResponseWriter, r *http.Request) {})
	t.Cleanup(closeSrv)
	d.Guard = &httpx.Guard{Port: "8080"}

	outer := t.TempDir()
	inner := filepath.Join(outer, "templates")
	if err := os.MkdirAll(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(outer, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(outer, 0o755) })
	d.Provision = provision.New(d.Rest, inner)
	d.Audit = audit.New(filepath.Join(t.TempDir(), "audit_log.jsonl"), "app-v-test", "test-instance",
		audit.Options{TrustDir: t.TempDir()})

	rr := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/provision/seed-demo/stream?dry=1&regions=emea", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	d.provisionSeedDemoStream(rr, r)

	msg, _ := errorFrame(t, parseSSEFrames(t, rr.Body.String()))["error"].(string)
	if !strings.Contains(msg, "could not be read") {
		t.Fatalf("error = %q, want it to say the directory could not be read", msg)
	}
	if strings.Contains(msg, "not installed") || strings.Contains(msg, "release archive") {
		t.Fatalf("error = %q, must not send the operator to re-download a build they already have", msg)
	}
}
