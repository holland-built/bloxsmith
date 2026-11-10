package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bloxsmith/internal/config"
	"bloxsmith/internal/httpx"
)

// Every SSE stream handler opens the same way: role check (403 JSON when the
// caller is below the route's role), then the event stream, then a deferred
// panic guard. These two tests pin that opening for all seven handlers, so a
// shared helper cannot quietly drop a step for one of them.

type streamCase struct {
	name string
	need string
	path string
	h    func(d *Deps) http.HandlerFunc
}

func streamCases() []streamCase {
	return []streamCase{
		{"demoBuild", "operator", "/api/provision/demo/stream?dry=0", func(d *Deps) http.HandlerFunc { return d.demoBuildStream }},
		{"demoTeardown", "operator", "/api/teardown/demo/stream?dry=0&change=c1", func(d *Deps) http.HandlerFunc { return d.demoTeardownStream }},
		{"provisionSubnet", "operator", "/api/provision/stream?block=b1&dry=1", func(d *Deps) http.HandlerFunc { return d.provisionSubnetStream }},
		{"provisionSite", "operator", "/api/provision/site/stream?template=x.yaml", func(d *Deps) http.HandlerFunc { return d.provisionSiteStream }},
		{"provisionSeedDemo", "operator", "/api/provision/seed-demo/stream?dry=1", func(d *Deps) http.HandlerFunc { return d.provisionSeedDemoStream }},
		{"teardownSite", "admin", "/api/teardown/site/stream?template=x.yaml", func(d *Deps) http.HandlerFunc { return d.teardownSiteStream }},
		{"teardownSeedDemo", "admin", "/api/teardown/seed-demo/stream?dry=1", func(d *Deps) http.HandlerFunc { return d.teardownSeedDemoStream }},
	}
}

func TestStreamHandlers_BelowRoleGets403JSON(t *testing.T) {
	for _, c := range streamCases() {
		t.Run(c.name, func(t *testing.T) {
			lg, _ := uaAuditLog(t)
			d := &Deps{
				Cfg:   &config.Config{Port: "8080"},
				Guard: &httpx.Guard{Port: "8080", Token: "s3cr3t-dashboard-token"},
				Audit: lg,
			}
			r := httptest.NewRequest("GET", c.path, nil)
			r.RemoteAddr = "127.0.0.1:12345" // no token -> viewer
			rr := httptest.NewRecorder()
			c.h(d)(rr, r)
			if rr.Code != 403 {
				t.Fatalf("status = %d, want 403; body=%q", rr.Code, rr.Body.String())
			}
			if ct := rr.Header().Get("Content-Type"); strings.Contains(ct, "event-stream") {
				t.Fatalf("a denied caller got an event stream (Content-Type %q)", ct)
			}
			var m map[string]any
			if err := json.Unmarshal(rr.Body.Bytes(), &m); err != nil {
				t.Fatalf("body is not JSON: %q", rr.Body.String())
			}
			if m["ok"] != false || m["error"] != c.need+" required" {
				t.Fatalf("body = %v, want {ok:false, error:%q}", m, c.need+" required")
			}
		})
	}
}

func TestStreamHandlers_PanicIsReportedAsAbortedRun(t *testing.T) {
	for _, c := range streamCases() {
		t.Run(c.name, func(t *testing.T) {
			lg, _ := uaAuditLog(t)
			// Loopback, no token configured -> admin. No Rest client and no
			// provisioning engine, so each handler dereferences nil once it
			// gets going.
			d := &Deps{
				Cfg:   &config.Config{Port: "8080"},
				Guard: &httpx.Guard{Port: "8080"},
				Audit: lg,
			}
			r := httptest.NewRequest("GET", c.path, nil)
			r.RemoteAddr = "127.0.0.1:12345"
			rr := httptest.NewRecorder()
			c.h(d)(rr, r)
			if ct := rr.Header().Get("Content-Type"); !strings.Contains(ct, "event-stream") {
				t.Fatalf("Content-Type = %q, want an event stream", ct)
			}
			if !strings.Contains(rr.Body.String(), `"aborted":true`) {
				t.Fatalf("the panic was not reported as an aborted run; body=%q", rr.Body.String())
			}
		})
	}
}
