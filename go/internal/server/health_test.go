package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"bloxsmith/internal/config"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/vault"
)

// THE HEALTH PROBE, from the router's side.
//
// These go through New() rather than calling d.healthz directly, because the
// thing most likely to break this route is not the handler — it is a gate in
// front of it. /healthz sits outside /api/, so the vault lock, the write guard
// and the per-tenant write lock all have to ignore it; the "locked vault" case
// below is the one that pins that, since a locked vault 503s every /api/ path
// and would 503 this one too if it had been registered under that prefix.

// hzDeps wires a Deps with a real (locked) vault and a state dir, the way a
// fresh install looks: nothing unlocked, nothing configured.
func hzDeps(t *testing.T, stateDir string) *Deps {
	t.Helper()
	v := vault.New(filepath.Join(t.TempDir(), "vault.json"))
	if err := v.Init("correct-horse-battery-staple"); err != nil {
		t.Fatalf("vault init: %v", err)
	}
	v.Lock()
	return &Deps{
		Cfg:      &config.Config{Port: "8080", VaultMode: true},
		Vault:    v,
		Auth:     rest.NewAuth("", v.ActiveKey),
		Guard:    &httpx.Guard{Port: "8080", Host: "localhost", MutatingPaths: httpx.DefaultMutatingPaths()},
		StateDir: stateDir,
		Version:  "1.2.3-test",
		Static:   http.NotFoundHandler(),
	}
}

// getHealthz runs GET /healthz through the full routed handler.
func getHealthz(t *testing.T, d *Deps) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	rr := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/healthz", nil)
	r.RemoteAddr = "127.0.0.1:54321"
	New(d).ServeHTTP(rr, r)

	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode /healthz body %q: %v", rr.Body.String(), err)
	}
	return rr, body
}

func TestHealthz_OKShape(t *testing.T) {
	rr, body := getHealthz(t, hzDeps(t, t.TempDir()))

	if rr.Code != http.StatusOK {
		t.Fatalf("GET /healthz = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
	if got := body["status"]; got != "ok" {
		t.Errorf("status = %v, want \"ok\"", got)
	}
	if got := body["version"]; got != "1.2.3-test" {
		t.Errorf("version = %v, want the server's version", got)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

// A LOCKED VAULT IS HEALTHY. hzDeps builds exactly the fresh-install state —
// VaultMode on, vault locked, no key applied — which 503s every /api/ route via
// the vault gate. If /healthz ever reports that as unhealthy, a supervisor that
// acts on health restarts the container before anyone can type the passphrase,
// and the install can never be completed. TestHealthz_OKShape already runs on a
// locked vault; this asserts the contrast explicitly so the reason is visible.
func TestHealthz_HealthyWhileVaultLocked(t *testing.T) {
	d := hzDeps(t, t.TempDir())

	rr := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/data", nil)
	r.RemoteAddr = "127.0.0.1:54321"
	New(d).ServeHTTP(rr, r)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("precondition: an /api/ route under a locked vault = %d, want 503", rr.Code)
	}

	hrr, body := getHealthz(t, d)
	if hrr.Code != http.StatusOK {
		t.Fatalf("GET /healthz under a locked vault = %d, want 200", hrr.Code)
	}
	if body["status"] != "ok" {
		t.Errorf("status = %v under a locked vault, want \"ok\"", body["status"])
	}
	if _, leaked := body["locked"]; leaked {
		t.Error("/healthz reported vault lock state; that belongs to /api/vault/status")
	}
}

// The readiness check earning its place: the state directory is the mounted
// volume, and a server that lost it keeps serving the UI while being unable to
// persist a single thing.
func TestHealthz_UnavailableWhenStateDirGone(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "vanished")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	d := hzDeps(t, dir)

	if rr, _ := getHealthz(t, d); rr.Code != http.StatusOK {
		t.Fatalf("precondition: /healthz with the state dir present = %d, want 200", rr.Code)
	}
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}

	rr, body := getHealthz(t, d)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /healthz with the state dir gone = %d, want 503", rr.Code)
	}
	if body["status"] == "ok" {
		t.Error("status still reads ok with the state dir gone")
	}
}

// Nothing in the body may name the filesystem. This route is the one exempt
// from the Host allowlist, so a DNS-rebound page can read it when it can read
// nothing else — the failure body says WHAT is wrong, never WHERE.
func TestHealthz_LeaksNoPath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "vanished")
	d := hzDeps(t, dir)

	rr, _ := getHealthz(t, d)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /healthz on a missing state dir = %d, want 503", rr.Code)
	}
	if got := rr.Body.String(); strings.Contains(got, dir) || strings.Contains(got, "vanished") {
		t.Errorf("/healthz body leaked the state dir path: %s", got)
	}
}
