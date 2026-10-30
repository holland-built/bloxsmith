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

const demoJoinToken = "JOINTOKEN-abcdefghijklmnopqrstuvwxyz.ibjt"

func demoDeps(t *testing.T) *Deps {
	t.Helper()
	v := vault.New(filepath.Join(t.TempDir(), "vault.json"))
	if err := v.Init("correct-horse-battery-staple"); err != nil {
		t.Fatalf("vault init: %v", err)
	}
	return &Deps{
		Cfg:      &config.Config{Port: "8080", VaultMode: true},
		Vault:    v,
		Auth:     rest.NewAuth("", v.ActiveKey),
		Rest:     rest.New("http://127.0.0.1:1", rest.NewAuth("", v.ActiveKey)),
		Guard:    &httpx.Guard{Port: "8080", Host: "localhost", MutatingPaths: httpx.DefaultMutatingPaths()},
		StateDir: t.TempDir(),
		Static:   http.NotFoundHandler(),
		Audit:    audit.New(filepath.Join(t.TempDir(), "audit.jsonl"), "v-test", "test", audit.Options{TrustDir: t.TempDir()}),
	}
}

func demoDo(t *testing.T, d *Deps, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	d.registerAll(mux)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "localhost:8080"
	req.Header.Set("Origin", "http://localhost:8080")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

// The join token is a secret: it is stored, never sent back, and a save that
// leaves it blank keeps the stored one rather than wiping it.
func TestDemoSettingsNeverSendTheJoinTokenBack(t *testing.T) {
	d := demoDeps(t)
	save := `{"pve":"root@10.0.0.2","pveName":"pve1","pveIp":"10.0.0.2","pool":"local-zfs","bridge":"vmbr9",
	  "subnet":"10.99.0.0/24","gateway":"10.99.0.1","image":"/tmp/x.qcow2","owner":"jsmith","joinToken":"` + demoJoinToken + `"}`
	if rr := demoDo(t, d, "POST", "/api/vault/demo", save); rr.Code != 200 || strings.Contains(rr.Body.String(), demoJoinToken) {
		t.Fatalf("save: %d %s", rr.Code, rr.Body.String())
	}
	resave := strings.Replace(save, demoJoinToken, "", 1)
	if rr := demoDo(t, d, "POST", "/api/vault/demo", resave); rr.Code != 200 {
		t.Fatalf("resave: %d %s", rr.Code, rr.Body.String())
	}
	rr := demoDo(t, d, "GET", "/api/demo/status", "")
	if strings.Contains(rr.Body.String(), demoJoinToken) {
		t.Fatal("status sent the join token to the page")
	}
	if !strings.Contains(rr.Body.String(), `"hasJoinToken":true`) {
		t.Fatalf("a blank token on save wiped the stored one: %s", rr.Body.String())
	}
	if d.demoConfig().JoinToken != demoJoinToken {
		t.Fatal("stored token changed")
	}
}

// A run ID that is a path must not reach the store.
func TestDemoTeardownRefusesAPathAsRunID(t *testing.T) {
	d := demoDeps(t)
	rr := demoDo(t, d, "GET", "/api/teardown/demo/stream?dry=1&change=../../etc", "")
	if !strings.Contains(rr.Body.String(), "No demo run") {
		t.Fatalf("expected a refusal, got %s", rr.Body.String())
	}
}
