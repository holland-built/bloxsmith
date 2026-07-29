package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/config"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/vault"
)

// A panic inside a provisioning or teardown SSE stream used to take the whole
// server process down. Every JSON handler in the package defers recoverEdit;
// none of the five streams did.
//
// This test drives the real routed handler at a teardown stream on a Deps with
// NO provisioning engine, which is what SiteTemplateRelPaths dereferences. It is
// not a contrived panic: it is the exact one that killed the test binary while
// the write lock's refusals were being proved load-bearing.
//
// Watched failing: with the `defer d.recoverStream(...)` lines removed from
// provision.go, this test does not merely fail — the whole `go test` binary dies
// with "panic: runtime error: invalid memory address", which is the point.
func TestStreamPanicDoesNotKillTheServer(t *testing.T) {
	dir := t.TempDir()
	vlt := vault.New(filepath.Join(dir, "vault.json"))
	if err := vlt.Init("pass-phrase-for-test"); err != nil {
		t.Fatalf("vault init: %v", err)
	}
	// Opted in, so the write lock is not what stops this request — the stream has
	// to actually run and panic for the guard to be under test at all.
	if res := vlt.SetWritable(vault.WriteID(vault.EnvTenant, vault.NoSwitch), true); !res["ok"].(bool) {
		t.Fatalf("opt in: %v", res)
	}

	auth := rest.NewAuth("Token test", nil)
	d := &Deps{
		Cfg:   &config.Config{Port: "8080"},
		Vault: vlt,
		Auth:  auth,
		Rest:  rest.New("http://127.0.0.1:1", auth),
		Guard: &httpx.Guard{Port: "8080", MutatingPaths: httpx.DefaultMutatingPaths()},
		Audit: audit.New(filepath.Join(dir, "audit_log.jsonl"), "app-v-test", "test-instance",
			audit.Options{TrustDir: t.TempDir()}),
		// Provision is deliberately nil.
		Static: http.NotFoundHandler(),
	}
	h := New(d)

	req := httptest.NewRequest("GET", "/api/teardown/seed-demo/stream?confirm=DELETE&dry=0", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	rr := httptest.NewRecorder()

	// No recover() here on purpose. If the guard is absent this test process dies,
	// and that is a far louder signal than a caught panic reported as a failure.
	h.ServeHTTP(rr, req)

	body := rr.Body.String()
	if !strings.Contains(body, "did NOT finish") {
		t.Errorf("a stream that died partway must say so; got body %q", body)
	}
	if !strings.Contains(body, `"aborted":true`) {
		t.Errorf("the abort must be machine-readable so the UI cannot render it as a completed run; got %q", body)
	}
	// And it must NOT look like a finished run.
	if strings.Contains(body, `"summary"`) || strings.Contains(body, `"done"`) {
		t.Errorf("an aborted run emitted a completion event, which reads as success: %q", body)
	}
}
