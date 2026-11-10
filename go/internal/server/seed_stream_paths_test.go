package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bloxsmith/internal/httpx"
	"bloxsmith/internal/provision"
)

// The seed-demo provision and teardown streams share one per-site loop. These
// tests pin the arms of that loop the other seed tests do not reach: a site
// template that will not load, one that loads but will not convert to a config,
// the "[template] step" prefix on forwarded progress, and the provision-only
// "skipped" phase.

// seedPathsDeps builds a template tree with the real blocks and amer templates
// plus two broken amer site templates, one of each kind.
func seedPathsDeps(t *testing.T, upstream http.HandlerFunc) *Deps {
	t.Helper()
	d, closeSrv := newTestDeps(t, upstream)
	t.Cleanup(closeSrv)
	d.Guard = &httpx.Guard{Port: "8080"}
	dir := t.TempDir()
	write := func(rel string, body []byte) {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, rel := range []string{"blocks/regional_address_blocks.yaml",
		"amer/lab/site-amer-lab.yaml", "amer/production/site-amer-hq.yaml"} {
		b, err := os.ReadFile(filepath.Join("../../templates", rel))
		if err != nil {
			t.Fatal(err)
		}
		write(rel, b)
	}
	write("amer/production/site-zz-broken.yaml", []byte("site: [unclosed\n"))
	write("amer/production/site-zz-incomplete.yaml", []byte("type: site\nnetwork:\n  ip_space: default\n"))
	d.Provision = provision.New(d.Rest, dir)
	return d
}

func seedFrameFor(frames []map[string]any, tpl string) map[string]any {
	for _, f := range frames {
		if f["template"] == tpl {
			return f
		}
	}
	return nil
}

func assertSeedPaths(t *testing.T, body string) []map[string]any {
	t.Helper()
	frames := parseSSEFrames(t, body)
	for _, tpl := range []string{"amer/production/site-zz-broken.yaml", "amer/production/site-zz-incomplete.yaml"} {
		f := seedFrameFor(frames, tpl)
		if f == nil || f["error"] == nil || f["error"] == "" {
			t.Fatalf("no error frame for %s; body=%s", tpl, body)
		}
	}
	failed := summaryList(t, frames, "failed")
	if len(failed) != 2 {
		t.Fatalf("failed = %v, want the two broken templates", failed)
	}
	var prefixed bool
	for _, f := range frames {
		if s, _ := f["step"].(string); strings.HasPrefix(s, "[amer/lab/site-amer-lab.yaml] ") && f["template"] == nil {
			prefixed = true
		}
	}
	if !prefixed {
		t.Fatalf("no progress step was forwarded with its [template] prefix; body=%s", body)
	}
	return frames
}

func TestProvisionSeedDemoStream_BrokenTemplatesAndStepPrefix(t *testing.T) {
	d := seedPathsDeps(t, allSucceededUpstream)
	rr := httptest.NewRecorder()
	d.provisionSeedDemoStream(rr, seedStreamRequest("regions=amer&dry=1"))
	frames := assertSeedPaths(t, rr.Body.String())
	if got := summaryList(t, frames, "succeeded"); len(got) != 3 {
		t.Fatalf("succeeded = %v, want blocks + amer-lab + amer-hq", got)
	}
}

func TestTeardownSeedDemoStream_BrokenTemplatesAndStepPrefix(t *testing.T) {
	d := seedPathsDeps(t, teardownOneSiteFailsUpstream)
	rr := httptest.NewRecorder()
	d.teardownSeedDemoStream(rr, teardownSeedStreamRequest("regions=amer&dry=1"))
	frames := assertSeedPaths(t, rr.Body.String())
	if got := summaryList(t, frames, "succeeded"); len(got) != 3 {
		t.Fatalf("succeeded = %v, want amer-lab + amer-hq + blocks", got)
	}
}

// A site that already exists is skipped on provision, not failed or succeeded.
func TestProvisionSeedDemoStream_ExistingSiteIsSkipped(t *testing.T) {
	d := newSeedStreamDeps(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/ipam/subnet") && strings.Contains(r.URL.Query().Get("_tfilter"), "amer-lab") {
			w.Write([]byte(`{"results":[{"id":"ipam/subnet/s1","address":"10.1.1.0","cidr":24}]}`))
			return
		}
		allSucceededUpstream(w, r)
	})
	rr := httptest.NewRecorder()
	d.provisionSeedDemoStream(rr, seedStreamRequest("regions=amer&dry=1"))
	frames := parseSSEFrames(t, rr.Body.String())
	if got := summaryList(t, frames, "skipped"); len(got) != 1 || got[0] != "amer/lab/site-amer-lab.yaml" {
		t.Fatalf("skipped = %v, want [amer/lab/site-amer-lab.yaml]; body=%s", got, rr.Body.String())
	}
	f := seedFrameFor(frames, "amer/lab/site-amer-lab.yaml")
	if f == nil || f["phase"] != "skipped" || f["step"] != "[amer/lab/site-amer-lab.yaml] skipped" {
		t.Fatalf("skip frame = %v", f)
	}
}
