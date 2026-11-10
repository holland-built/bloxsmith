package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/cache"
	"bloxsmith/internal/config"
	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/edit"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/mcp"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/vault"
)

// countingUpstream is a fake Infoblox: REST paths answer one row, the MCP
// endpoint answers iq-actions_list_actions with one page, and every call is
// counted by path (MCP tool calls as "mcp:<tool>").
type countingUpstream struct {
	mu      sync.Mutex
	calls   map[string]int
	respond func(w http.ResponseWriter, r *http.Request) bool // true = handled
}

func (u *countingUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Path
	if r.URL.Path == "/mcp" {
		var req struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &req)
		w.Header().Set("Content-Type", "application/json")
		if req.Method != "tools/call" {
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
			return
		}
		u.count("mcp:" + req.Params.Name)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{"content": []map[string]any{{"type": "text",
				"text": `{"actions":[{"id":"a1"}],"pagination":{"has_more":false}}`}}},
		})
		return
	}
	u.count(key)
	if u.respond != nil && u.respond(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"results":[{"id":"x1","name":"n"}],"result":{"data":[]}}`)
}

func (u *countingUpstream) count(k string) {
	u.mu.Lock()
	u.calls[k]++
	u.mu.Unlock()
}

func (u *countingUpstream) total(prefix string) int {
	u.mu.Lock()
	defer u.mu.Unlock()
	n := 0
	for k, v := range u.calls {
		if strings.HasPrefix(k, prefix) {
			n += v
		}
	}
	return n
}

// newCachedChassis is newTenantChassis with what production has and that one
// leaves out: a shared cache on the dashboard, and an MCP client.
func newCachedChassis(t *testing.T, up *countingUpstream) (http.Handler, *rest.Auth) {
	t.Helper()
	srv := httptest.NewServer(up)
	t.Cleanup(srv.Close)
	auth := rest.NewAuth("Token tenant-A", nil)
	rc := rest.New(srv.URL, auth)
	vlt := vault.New(filepath.Join(t.TempDir(), "vault.json"))
	if err := vlt.Init("pass-phrase-for-test"); err != nil {
		t.Fatalf("vault init: %v", err)
	}
	if res := vlt.SetWritable(vault.WriteID(vault.EnvTenant, vault.NoSwitch), true); !res["ok"].(bool) {
		t.Fatalf("opt the env tenant in to writes: %v", res)
	}
	svc := dashboard.New(rc, cache.New())
	svc.Mcp = mcp.New(srv.URL+"/mcp", func() string { return "Token tenant-A" })
	d := &Deps{
		Cfg:   &config.Config{Port: "8080"},
		Vault: vlt,
		Rest:  rc,
		Auth:  auth,
		Guard: &httpx.Guard{Port: "8080", Host: "localhost", MutatingPaths: httpx.DefaultMutatingPaths()},
		Audit: audit.New(t.TempDir()+"/audit_log.jsonl", "app-v-test", "test-instance",
			audit.Options{TrustDir: t.TempDir()}),
		Dashboard: svc,
		Edit:      edit.New(rc),
		Static:    http.NotFoundHandler(),
	}
	return New(d), auth
}

func get(h http.Handler, path string) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
	return rr
}

// securityPolled is every /api/csp route the Security page polls every 30s.
var securityPolled = []string{
	"/api/csp/threats", "/api/csp/ctem-exposure", "/api/csp/exposures",
	"/api/csp/asset-risk", "/api/csp/exposed-hostnames", "/api/csp/exposed-ips",
	"/api/csp/ctem-assets",
}

// TestSecurityPollRoundTwoTabsCostsOneTabOfUpstreamCalls: two browser tabs on
// the Security page poll the same seven routes within one TTL. Before the tile
// cache every request went upstream, so two tabs cost twice one tab: 2 x 12.
// Now the second tab is served from the cache: 12. The security Cube.js
// service is failing here, as it was on 2026-11-10, so before the fallback
// memory the threats tile cost 2 calls on every poll; now only the first.
func TestSecurityPollRoundTwoTabsCostsOneTabOfUpstreamCalls(t *testing.T) {
	up := &countingUpstream{calls: map[string]int{}, respond: func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/api/cubejs-security/v1/query" {
			w.WriteHeader(400)
			return true
		}
		return false
	}}
	h, _ := newCachedChassis(t, up)

	for _, p := range securityPolled { // tab 1
		if rr := get(h, p); rr.Code != 200 {
			t.Fatalf("%s: HTTP %d", p, rr.Code)
		}
	}
	tab1 := up.total("/")
	// 1 sec-cube + 1 main-cube for threats, 3 ctem-exposure, 1 exposures POST,
	// 1 asset-risk, 1 hostnames, 1 ips, 4 ctem-assets.
	if tab1 != 13 {
		t.Fatalf("one tab's poll round made %d upstream calls, want 13: %v", tab1, up.calls)
	}
	for _, p := range securityPolled { // tab 2, same 30 seconds
		get(h, p)
	}
	if got := up.total("/"); got != tab1 {
		t.Fatalf("a second tab inside the TTL made %d more upstream calls, want 0: %v", got-tab1, up.calls)
	}
}

// TestSecurityCubeFailureIsRememberedForThreats: with the tile cache out of the
// way (a write drops it), the next threats read skips the failing security
// service and asks the main one only.
func TestSecurityCubeFailureIsRememberedForThreats(t *testing.T) {
	up := &countingUpstream{calls: map[string]int{}, respond: func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/api/cubejs-security/v1/query" {
			w.WriteHeader(400)
			return true
		}
		return false
	}}
	h, auth := newCachedChassis(t, up)
	get(h, "/api/csp/threats")
	auth.SetOverride("Bearer tenant-A-again") // a different pin, so a cache miss
	get(h, "/api/csp/threats")
	if n := up.total("/api/cubejs-security/"); n != 2 {
		// Two tenants: each learns separately. Now the same tenant again.
		t.Fatalf("security service asked %d times for two tenants, want 2", n)
	}
	auth.SetOverride("")
	writeOnce(t, h) // drop cached tiles
	get(h, "/api/csp/threats")
	if n := up.total("/api/cubejs-security/"); n != 2 {
		t.Fatalf("the remembered-failing security service was asked again (%d calls, want 2)", n)
	}
	if n := up.total("/api/cubejs/"); n != 3 {
		t.Fatalf("main cube asked %d times, want 3", n)
	}
}

// TestTileCacheIsPerTenant: a read cached for tenant A is never served to a
// request pinned to tenant B.
func TestTileCacheIsPerTenant(t *testing.T) {
	up := &countingUpstream{calls: map[string]int{}}
	h, auth := newCachedChassis(t, up)
	get(h, "/api/csp/ctem-assets")
	get(h, "/api/csp/ctem-assets")
	if n := up.total("/api/attack-surface/"); n != 4 {
		t.Fatalf("two reads on one tenant made %d calls, want 4", n)
	}
	auth.SetOverride("Bearer tenant-B")
	get(h, "/api/csp/ctem-assets")
	if n := up.total("/api/attack-surface/"); n != 8 {
		t.Fatalf("tenant B was served tenant A's cached read (%d calls, want 8)", n)
	}
}

// TestDNSAnalyticsAndActionsAreCached: the two non-tile routes in finding 1.
func TestDNSAnalyticsAndActionsAreCached(t *testing.T) {
	up := &countingUpstream{calls: map[string]int{}}
	h, _ := newCachedChassis(t, up)
	for range 2 {
		get(h, "/api/dns-analytics")
		get(h, "/api/actions")
	}
	if n := up.total("/api/cubejs/"); n != 3 {
		t.Fatalf("/api/dns-analytics twice made %d cube calls, want 3", n)
	}
	if n := up.total("mcp:iq-actions_list_actions"); n != 1 {
		t.Fatalf("/api/actions twice made %d list calls, want 1", n)
	}
}

func writeOnce(t *testing.T, h http.Handler) {
	t.Helper()
	req := httptest.NewRequest("PATCH", "/api/edit/subnet/ipam%2Fsubnet%2F1",
		strings.NewReader(`{"comment":"renamed","dry":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code == http.StatusForbidden {
		t.Fatalf("the write was refused, so it proves nothing: %s", rr.Body.String())
	}
}

// TestTenantWriteDropsCachedTiles: after a write the next read goes upstream,
// so a tile does not show the pre-write state for the rest of its TTL.
func TestTenantWriteDropsCachedTiles(t *testing.T) {
	up := &countingUpstream{calls: map[string]int{}}
	h, _ := newCachedChassis(t, up)
	get(h, "/api/csp/dns-services")
	get(h, "/api/csp/dns-services")
	before := up.total("/api/")
	if before != 1 {
		t.Fatalf("two reads made %d calls, want 1", before)
	}
	writeOnce(t, h)
	afterWrite := up.total("/api/")
	get(h, "/api/csp/dns-services")
	if n := up.total("/api/") - afterWrite; n != 1 {
		t.Fatalf("the read after a write made %d upstream calls, want 1 (the cache was not dropped)", n)
	}
}

// TestExposure403MemoryStillAnswersLocally: a refused attack-surface feed is
// not cached as a tile (it is an error), and the one-hour 403 memory keeps
// answering it without an upstream call, even after a write drops the tiles.
func TestExposure403MemoryStillAnswersLocally(t *testing.T) {
	up := &countingUpstream{calls: map[string]int{}, respond: func(w http.ResponseWriter, r *http.Request) bool {
		if strings.HasPrefix(r.URL.Path, "/api/attack-surface/v1/exposures/hostnames") {
			w.WriteHeader(403)
			return true
		}
		return false
	}}
	h, _ := newCachedChassis(t, up)
	get(h, "/api/csp/exposed-hostnames")
	writeOnce(t, h)
	get(h, "/api/csp/exposed-hostnames")
	rr := get(h, "/api/csp/exposed-hostnames")
	if n := up.total("/api/attack-surface/v1/exposures/hostnames"); n != 1 {
		t.Fatalf("a remembered 403 went upstream again (%d calls, want 1)", n)
	}
	if !strings.Contains(rr.Body.String(), "not entitled") {
		t.Fatalf("body = %s, want the entitlement reason", rr.Body.String())
	}
}
