package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/account"
	"bloxsmith/internal/audit"
	cachepkg "bloxsmith/internal/cache"
	"bloxsmith/internal/config"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/provision"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/vault"
)

// THE WIRING, not the format.
//
// internal/provision/export_test.go proves the export writer records the right
// thing before the first delete. It cannot prove the SERVER hands it a real
// directory and the real tenant identity — and that wiring is exactly the kind of
// shipped-but-unexecuted code this repo keeps finding bugs in. Two things go
// wrong silently if nobody drives the actual route:
//
//   - StateDir never reaching the writer, so every teardown refuses in production
//     with a message about configuration and nobody finds out until they try one.
//   - the tenant identity being blank or the wrong tenant, which makes the export
//     unusable for the one thing it exists for: rebuilding into the RIGHT tenant.
//
// So this drives the real SSE route end to end, through the real write lock,
// against a fake upstream. Nothing here touches a live tenant.

// exportRouteServer is lockedTestServer's sibling with two differences that
// matter: StateDir is set (so exports have somewhere to go), and the fake
// upstream returns a real site's objects instead of empty lists, so a teardown
// has something to record and something to delete.
func exportRouteServer(t *testing.T) (http.Handler, *Deps, string, func() []string) {
	t.Helper()

	var mu sync.Mutex
	var deletes []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			mu.Lock()
			deletes = append(deletes, r.URL.Path)
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		p := r.URL.Path
		switch {
		case strings.HasSuffix(p, "/ipam/ip_space"):
			_, _ = w.Write([]byte(`{"results":[{"id":"ipam/ip_space/sp-1","name":"default"}]}`))
		case strings.HasSuffix(p, "/dns/view"):
			_, _ = w.Write([]byte(`{"results":[{"id":"dns/view/v-1","name":"default"}]}`))
		case strings.HasSuffix(p, "/ipam/subnet"):
			_, _ = w.Write([]byte(`{"results":[{"id":"ipam/subnet/sn-9","address":"10.44.0.0","cidr":25,
			  "name":"amer-lab-bench","comment":"Test bench VLAN","tags":{"Site":"amer-lab"}}]}`))
		case strings.HasSuffix(p, "/dns/auth_zone"):
			_, _ = w.Write([]byte(`{"results":[{"id":"dns/auth_zone/z-9","fqdn":"site-amer-lab.example.com.","view":"dns/view/v-1"}]}`))
		default:
			_, _ = w.Write([]byte(`{"results":[]}`))
		}
	}))
	t.Cleanup(upstream.Close)

	csp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/current_user/accounts":
			_, _ = w.Write([]byte(`{"results":[{"id":"acct-home","name":"Delta","state":"active"}]}`))
		case "/v2/current_user":
			_, _ = w.Write([]byte(`{"result":{"account_id":"acct-home"}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(csp.Close)

	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}

	vlt := vault.New(filepath.Join(stateDir, "vault.json"))
	if err := vlt.Init("pass-phrase-for-test"); err != nil {
		t.Fatalf("vault init: %v", err)
	}
	if res := vlt.AddTenant("Delta", "abc123def456", nil); !res["ok"].(bool) {
		t.Fatalf("add tenant: %v", res)
	}

	// A real template on disk, so the route resolves a real site rather than the
	// test asserting against a config it built itself.
	tmplDir := filepath.Join(dir, "templates", "amer", "lab")
	if err := os.MkdirAll(tmplDir, 0o755); err != nil {
		t.Fatal(err)
	}
	tmpl := "type: site\nsite:\n  name: amer-lab\n  region: Americas\n  environment: lab\n" +
		"network:\n  ip_space: default\n  subnet_size: 25\n  subnets:\n    - name: amer-lab-bench\n" +
		"      purpose: Test bench VLAN\n      cidr: 25\ndns:\n  parent: example.com\n  view: default\n"
	if err := os.WriteFile(filepath.Join(tmplDir, "site-amer-lab.yaml"), []byte(tmpl), 0o644); err != nil {
		t.Fatal(err)
	}

	auth := rest.NewAuth("", vlt.ActiveKey)
	cache := cachepkg.New()
	deps := &Deps{
		Cfg:     &config.Config{Port: "8080"},
		Vault:   vlt,
		Auth:    auth,
		Rest:    rest.New(upstream.URL, auth),
		Guard:   &httpx.Guard{Port: "8080", MutatingPaths: httpx.DefaultMutatingPaths()},
		Cache:   cache,
		Account: account.New(csp.URL, "abc123def456", auth, cache),
		Audit: audit.New(filepath.Join(stateDir, "audit_log.jsonl"), "app-v-test", "test-instance",
			audit.Options{TrustDir: t.TempDir()}),
		Provision: provision.New(rest.New(upstream.URL, auth), filepath.Join(dir, "templates")),
		Version:   "3.31.0-test",
		StateDir:  stateDir,
		Static:    http.NotFoundHandler(),
	}

	// The teardown routes refuse unless this exact tenant is opted in. Opting in a
	// FAKE tenant is the only safe way to exercise the path past the lock; the
	// live tenant must never be opted in to make a test pass.
	id := vault.WriteID(vlt.ActiveTenantID(), vault.NoSwitch)
	if res := vlt.SetWritable(id, true); !res["ok"].(bool) {
		t.Fatalf("SetWritable: %v", res)
	}

	return New(deps), deps, stateDir, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string{}, deletes...)
	}
}

func exportFiles(t *testing.T, stateDir string) []string {
	t.Helper()
	ents, err := os.ReadDir(filepath.Join(stateDir, exportDirName))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

// The real route, through the real lock, writes a real export into StateDir.
func TestTeardownRouteWritesExportIntoStateDir(t *testing.T) {
	h, _, stateDir, deletes := exportRouteServer(t)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, lockReq("GET",
		"/api/teardown/site/stream?template=amer/lab/site-amer-lab.yaml&confirm=amer-lab&dry=0"))

	if rr.Code != 200 {
		t.Fatalf("status %d, body %s", rr.Code, rr.Body.String())
	}
	// The stream must not have refused — if it did, this test is asserting the
	// export of a teardown that never ran.
	if strings.Contains(rr.Body.String(), "refusing to tear down") {
		t.Fatalf("the route refused to tear down, so the export path was never exercised: %s", rr.Body.String())
	}
	if len(deletes()) == 0 {
		t.Fatalf("no deletes reached the fake upstream, so nothing was torn down: %s", rr.Body.String())
	}

	files := exportFiles(t, stateDir)
	if len(files) != 1 {
		t.Fatalf("export dir holds %v — want exactly one file, in %s/%s", files, stateDir, exportDirName)
	}

	b, err := os.ReadFile(filepath.Join(stateDir, exportDirName, files[0]))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("export is not valid JSON: %v", err)
	}

	// The identity half of the wiring. A blank tenant here would make the file
	// useless for rebuilding into the right place, which is the whole point.
	ten, _ := doc["tenant"].(map[string]any)
	gotID, _ := ten["id"].(string)
	if gotID == "" || !strings.HasSuffix(gotID, "/"+vault.NoSwitch) {
		t.Fatalf("tenant id = %q — want the write identity the lock approved", gotID)
	}
	if ten["label"] != "Delta" {
		t.Fatalf("tenant label = %v, want Delta", ten["label"])
	}
	if doc["bloxsmith_version"] != "3.31.0-test" {
		t.Fatalf("bloxsmith_version = %v, want the server's version", doc["bloxsmith_version"])
	}

	// And it holds the site's objects, so the wiring passes real bodies through.
	plan, _ := doc["plan"].(map[string]any)
	if plan["site"] != "amer-lab" {
		t.Fatalf("plan site = %v, want amer-lab", plan["site"])
	}
	subnets, _ := plan["subnets"].([]any)
	if len(subnets) != 1 {
		t.Fatalf("plan holds %d subnets, want 1", len(subnets))
	}
	if s, _ := subnets[0].(map[string]any); s["comment"] != "Test bench VLAN" {
		t.Fatalf("subnet body not carried through the wiring: %v", subnets[0])
	}

	// The stream told the operator where it went — an export nobody is pointed at
	// is one they will not find when they need it.
	if !strings.Contains(rr.Body.String(), files[0]) {
		t.Fatalf("the stream never named the export file %s: %s", files[0], rr.Body.String())
	}
}

// A dry run through the real route writes nothing and still names the location.
func TestTeardownRouteDryRunWritesNothingButNamesTheLocation(t *testing.T) {
	h, _, stateDir, deletes := exportRouteServer(t)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, lockReq("GET",
		"/api/teardown/site/stream?template=amer/lab/site-amer-lab.yaml&dry=1"))

	if rr.Code != 200 {
		t.Fatalf("status %d, body %s", rr.Code, rr.Body.String())
	}
	if n := len(deletes()); n != 0 {
		t.Fatalf("a dry run sent %d DELETE(s) upstream", n)
	}
	if files := exportFiles(t, stateDir); len(files) != 0 {
		t.Fatalf("a dry run wrote %v into the export dir", files)
	}
	// It must still say where a real run would put it, including the directory
	// the server actually configured.
	want := filepath.Join(stateDir, exportDirName)
	if !strings.Contains(rr.Body.String(), want) {
		t.Fatalf("the dry run never named %s: %s", want, rr.Body.String())
	}
}

// A server with no StateDir has nowhere to record, so a teardown must REFUSE and
// send nothing upstream. This is the production failure mode of a misconfigured
// install, and it must fail closed.
func TestTeardownRouteRefusesWhenNoStateDir(t *testing.T) {
	h, d, _, deletes := exportRouteServer(t)
	d.StateDir = "" // as a misconfigured install would leave it

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, lockReq("GET",
		"/api/teardown/site/stream?template=amer/lab/site-amer-lab.yaml&confirm=amer-lab&dry=0"))

	if !strings.Contains(rr.Body.String(), "refusing to tear down") {
		t.Fatalf("no refusal in the stream: %s", rr.Body.String())
	}
	if n := len(deletes()); n != 0 {
		t.Fatalf("the refusal sent %d DELETE(s) upstream — 'Nothing was changed' would be false", n)
	}
}
