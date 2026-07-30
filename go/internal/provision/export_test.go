package provision

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"bloxsmith/internal/rest"
)

// EXPORT BEFORE DESTROY.
//
// Every test here is about one of two claims:
//
//  1. the record is on disk BEFORE the first delete leaves this machine, and
//  2. if it could not be written, NOTHING is deleted.
//
// The second is the one that is easy to write and not actually hold: a refusal
// returned after the DELETE has already gone out reads exactly like a refusal
// that held. So the fake upstream below counts deletes and the assertions check
// the count, not just the error — the same discipline v3.27.0's write-lock tests
// use ("each refusal also asserts the fake upstream was never reached").
//
// NO TEST HERE TOUCHES A REAL TENANT. Everything runs against httptest.

// fakeTenant is an Infoblox stand-in holding one site's worth of objects. It
// records every DELETE it receives, in order, and — crucially — what the export
// directory looked like at the moment each one arrived.
type fakeTenant struct {
	mu sync.Mutex

	// deletes is every path DELETEd, in order.
	deletes []string

	// exportsAtFirstDelete is the list of files in watchDir as it stood when the
	// FIRST delete arrived. This is the ordering proof: asserting the file exists
	// after Decommission returns would pass even if it were written last.
	exportsAtFirstDelete []string
	sawDelete            bool

	watchDir string
}

func (f *fakeTenant) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			f.mu.Lock()
			f.deletes = append(f.deletes, r.URL.Path)
			if !f.sawDelete {
				f.sawDelete = true
				ents, _ := os.ReadDir(f.watchDir)
				for _, e := range ents {
					f.exportsAtFirstDelete = append(f.exportsAtFirstDelete, e.Name())
				}
			}
			f.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			w.Write([]byte(`{}`))
			return
		}

		w.Header().Set("Content-Type", "application/json")
		p := r.URL.Path
		switch {
		case strings.HasSuffix(p, "/ipam/ip_space"):
			w.Write([]byte(`{"results":[{"id":"ipam/ip_space/space-1","name":"default","comment":"the space"}]}`))
		case strings.HasSuffix(p, "/dns/view"):
			w.Write([]byte(`{"results":[{"id":"dns/view/view-1","name":"default","comment":"the view"}]}`))
		case strings.HasSuffix(p, "/ipam/subnet"):
			// Two subnets, with the kind of body detail a rebuild needs and a
			// summary would drop.
			w.Write([]byte(`{"results":[
			  {"id":"ipam/subnet/sn-1","address":"10.20.0.0","cidr":24,"name":"ams-general",
			   "comment":"general purpose","tags":{"Site":"ams","Owner":"network-team"},
			   "dhcp_options":[{"option_code":"dhcp/option_code/3","option_value":"10.20.0.1"}]},
			  {"id":"ipam/subnet/sn-2","address":"10.20.1.0","cidr":24,"name":"ams-voice",
			   "comment":"voice vlan","tags":{"Site":"ams","Owner":"voice-team"}}
			]}`))
		case strings.HasSuffix(p, "/dns/auth_zone"):
			w.Write([]byte(`{"results":[{"id":"dns/auth_zone/z-1","fqdn":"site-ams.example.com.",
			  "view":"dns/view/view-1","comment":"the site zone","primary_type":"cloud"}]}`))
		case strings.HasSuffix(p, "/ipam/range"):
			w.Write([]byte(`{"results":[{"id":"ipam/range/r-1","start":"10.20.0.100","end":"10.20.0.200",
			  "name":"ams-pool","tags":{"Site":"ams"}}]}`))
		case strings.HasSuffix(p, "/ipam/host"):
			w.Write([]byte(`{"results":[{"id":"ipam/host/h-1","name":"printer.site-ams.example.com",
			  "addresses":[{"address":"10.20.0.5"}]},{"id":"ipam/host/h-2","name":"other.example.com"}]}`))
		case strings.HasSuffix(p, "/ipam/address_block"):
			w.Write([]byte(`{"results":[
			  {"id":"ipam/address_block/b-1","address":"10.20.0.0","cidr":16,"tags":{"Status":"deployed"}},
			  {"id":"ipam/address_block/b-2","address":"10.20.0.0","cidr":20,"tags":{"Status":"deployed"}}
			]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}
}

func (f *fakeTenant) deleteCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.deletes)
}

// newExportHarness returns an engine wired to a fake tenant, plus the export dir.
// exportDir is created lazily by the writer, matching production.
func newExportHarness(t *testing.T, dir string) (*Engine, *fakeTenant, *httptest.Server) {
	t.Helper()
	ft := &fakeTenant{watchDir: dir}
	srv := httptest.NewServer(ft.handler())
	t.Cleanup(srv.Close)

	auth := rest.NewAuth("test-key", func() string { return "" })
	e := New(rest.New(srv.URL, auth), "")
	e = e.WithExport(&ExportWriter{
		Dir:         dir,
		Tenant:      "conn-abc/-",
		TenantLabel: "Fake Tenant",
		Version:     "3.31.0-test",
		Now:         func() time.Time { return time.Date(2026, 7, 30, 9, 15, 22, 0, time.UTC) },
	})
	return e, ft, srv
}

func teardownCfg(dry bool) *DecommissionConfig {
	return &DecommissionConfig{
		Site: "ams", IPSpace: "default", DNSParent: "example.com",
		DNSView: "default", DryRun: dry,
	}
}

func readExport(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read export %s: %v", path, err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("export is not valid JSON: %v", err)
	}
	return m
}

// THE ORDERING PROOF. The record must be on disk before the first DELETE goes
// out, because after the first delete there is nothing left to make recoverable.
func TestSiteTeardownWritesExportBeforeFirstDelete(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "teardown-exports")
	e, ft, _ := newExportHarness(t, dir)

	result, err := e.NewSiteDecommissioner(teardownCfg(false), func(M) {}).Decommission()
	if err != nil {
		t.Fatalf("Decommission: %v", err)
	}
	if ft.deleteCount() == 0 {
		t.Fatal("the fake tenant received no deletes — this test proves nothing about ordering")
	}

	if len(ft.exportsAtFirstDelete) != 1 {
		t.Fatalf("at the moment of the FIRST delete the export dir held %v — want exactly one export file, "+
			"already written", ft.exportsAtFirstDelete)
	}
	if strings.HasSuffix(ft.exportsAtFirstDelete[0], ".partial") {
		t.Fatalf("at the first delete the export was still a partial file (%s) — a half-written record "+
			"read as complete is the failure this is meant to prevent", ft.exportsAtFirstDelete[0])
	}

	path, _ := result["export_path"].(string)
	if path == "" {
		t.Fatal("result carries no export_path, so nothing tells the operator where the record went")
	}
	if result["export_written"] != true {
		t.Fatalf("export_written = %v, want true on a real run", result["export_written"])
	}
}

// The file must hold enough to rebuild: full API bodies, not summaries.
func TestSiteTeardownExportHoldsFullObjectBodies(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "teardown-exports")
	e, _, _ := newExportHarness(t, dir)

	result, err := e.NewSiteDecommissioner(teardownCfg(false), func(M) {}).Decommission()
	if err != nil {
		t.Fatalf("Decommission: %v", err)
	}
	doc := readExport(t, result["export_path"].(string))

	if doc["bloxsmith_export"] != float64(exportFormat) {
		t.Fatalf("bloxsmith_export = %v, want %d", doc["bloxsmith_export"], exportFormat)
	}
	if doc["kind"] != exportKindSite {
		t.Fatalf("kind = %v, want %q", doc["kind"], exportKindSite)
	}

	// Which tenant. An export that does not say cannot be rebuilt into the right
	// one, which is the v3.23.0 / v3.27.0 lesson.
	ten, _ := doc["tenant"].(map[string]any)
	if ten["id"] != "conn-abc/-" || ten["label"] != "Fake Tenant" {
		t.Fatalf("tenant = %v, want id conn-abc/- and label Fake Tenant", doc["tenant"])
	}

	plan, _ := doc["plan"].(map[string]any)
	if plan == nil {
		t.Fatal("export has no plan")
	}

	subnets, _ := plan["subnets"].([]any)
	if len(subnets) != 2 {
		t.Fatalf("plan holds %d subnets, want 2", len(subnets))
	}
	// The detail a summary drops and a rebuild needs. If the export recorded only
	// address+id (what the run summary carries) this fails.
	first, _ := subnets[0].(map[string]any)
	if first["comment"] != "general purpose" {
		t.Fatalf("subnet comment not recorded: %v", first)
	}
	if first["dhcp_options"] == nil {
		t.Fatalf("subnet dhcp_options not recorded — the export is a summary, not a rebuildable body: %v", first)
	}
	tags, _ := first["tags"].(map[string]any)
	if tags["Owner"] != "network-team" {
		t.Fatalf("subnet tags not recorded: %v", first["tags"])
	}

	// The forward zone, with its body.
	fwd, _ := plan["forward_zone"].(map[string]any)
	if fwd == nil {
		t.Fatal("plan holds no forward_zone")
	}
	fwdObj, _ := fwd["object"].(map[string]any)
	if fwdObj["primary_type"] != "cloud" {
		t.Fatalf("forward zone body not recorded: %v", fwd)
	}

	// Hosts are filtered to this site's suffix, and only the matching one is in
	// the plan — recording other.example.com would claim a host was about to be
	// deleted that was not.
	hosts, _ := plan["hosts"].([]any)
	if len(hosts) != 1 {
		t.Fatalf("plan holds %d hosts, want 1 (only the site's own)", len(hosts))
	}
	if h, _ := hosts[0].(map[string]any); h["name"] != "printer.site-ams.example.com" {
		t.Fatalf("wrong host recorded: %v", hosts[0])
	}

	if len(plan["dhcp_ranges"].([]any)) != 1 {
		t.Fatalf("dhcp_ranges = %v, want 1", plan["dhcp_ranges"])
	}
	// The spaces and views a rebuild has to land back in.
	if sp, _ := plan["ip_space_object"].(map[string]any); sp["comment"] != "the space" {
		t.Fatalf("ip_space_object body not recorded: %v", plan["ip_space_object"])
	}
	if vw, _ := plan["dns_view_object"].(map[string]any); vw["comment"] != "the view" {
		t.Fatalf("dns_view_object body not recorded: %v", plan["dns_view_object"])
	}

	// The file must say what it is, for whoever opens it without this source.
	if note, _ := doc["note"].(string); !strings.Contains(note, "ABOUT TO DELETE") {
		t.Fatalf("export does not state what it is: %q", note)
	}
}

// THE REFUSAL. If the record cannot be written, nothing may be deleted — and the
// delete count is what proves it, not the error.
func TestSiteTeardownRefusesAndDeletesNothingWhenExportCannotBeWritten(t *testing.T) {
	cases := []struct {
		name    string
		setup   func(t *testing.T) (dir string, watch string)
		wantSub string
	}{
		{
			// No directory configured at all — a misconfigured install.
			name: "no directory configured",
			setup: func(t *testing.T) (string, string) {
				return "", t.TempDir()
			},
			wantSub: "no directory is configured",
		},
		{
			// The export dir's parent is a FILE, so MkdirAll cannot succeed.
			name: "directory cannot be created",
			setup: func(t *testing.T) (string, string) {
				base := t.TempDir()
				blocker := filepath.Join(base, "blocked")
				if err := os.WriteFile(blocker, []byte("not a dir"), 0o600); err != nil {
					t.Fatal(err)
				}
				return filepath.Join(blocker, "teardown-exports"), base
			},
			wantSub: "could not create the directory",
		},
		{
			// The dir exists but is read-only, so the file cannot be opened.
			name: "directory not writable",
			setup: func(t *testing.T) (string, string) {
				dir := filepath.Join(t.TempDir(), "ro")
				if err := os.Mkdir(dir, 0o500); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Chmod(dir, 0o700) })
				return dir, dir
			},
			wantSub: "could not open the record",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir, watch := c.setup(t)
			ft := &fakeTenant{watchDir: watch}
			srv := httptest.NewServer(ft.handler())
			defer srv.Close()
			auth := rest.NewAuth("test-key", func() string { return "" })
			e := New(rest.New(srv.URL, auth), "").WithExport(&ExportWriter{Dir: dir, Version: "t"})

			_, err := e.NewSiteDecommissioner(teardownCfg(false), func(M) {}).Decommission()
			if err == nil {
				t.Fatal("teardown proceeded with no record of what it was deleting")
			}
			if !strings.Contains(err.Error(), c.wantSub) {
				t.Fatalf("error %q does not contain %q", err.Error(), c.wantSub)
			}
			// The refusal must say nothing was changed, and be TRUE about it.
			if !strings.Contains(err.Error(), "Nothing was changed") {
				t.Fatalf("refusal does not say nothing was changed: %q", err.Error())
			}
			if n := ft.deleteCount(); n != 0 {
				t.Fatalf("the refusal sent %d DELETE(s) upstream (%v) — a 'nothing was changed' that "+
					"already deleted is worse than no control at all", n, ft.deletes)
			}
		})
	}
}

// A dry run destroys nothing, so it records nothing — but it must say WHERE the
// real run would put the file, which is the whole reason to dry-run first.
func TestDryRunWritesNoExportButReportsWhereItWouldGo(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "teardown-exports")
	e, ft, _ := newExportHarness(t, dir)

	var steps []string
	result, err := e.NewSiteDecommissioner(teardownCfg(true), func(m M) {
		if s, ok := m["step"]; ok {
			steps = append(steps, pyStr(s))
		}
	}).Decommission()
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}

	if ft.deleteCount() != 0 {
		t.Fatalf("a dry run sent %d DELETE(s)", ft.deleteCount())
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("a dry run created the export directory %s (stat err %v) — nothing was being destroyed, "+
			"so there was nothing to record", dir, err)
	}
	if result["export_written"] != false {
		t.Fatalf("export_written = %v, want false on a dry run", result["export_written"])
	}

	// The path is still reported, in the stream and in the result.
	want := filepath.Join(dir, "20260730T091522Z-teardown-site-ams.json")
	if result["export_path"] != want {
		t.Fatalf("export_path = %v, want %v", result["export_path"], want)
	}
	found := false
	for _, s := range steps {
		if strings.Contains(s, want) && strings.Contains(s, "[DRY-RUN]") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the dry run never told the operator where the record would go. steps: %v", steps)
	}
}

// A dry run against an install that could not record must SAY so, or the operator
// dry-runs successfully and then hits a refusal on the real run with no warning.
func TestDryRunSaysARealRunWouldRefuseWhenNoDirConfigured(t *testing.T) {
	ft := &fakeTenant{watchDir: t.TempDir()}
	srv := httptest.NewServer(ft.handler())
	defer srv.Close()
	auth := rest.NewAuth("test-key", func() string { return "" })
	e := New(rest.New(srv.URL, auth), "").WithExport(&ExportWriter{Dir: "", Version: "t"})

	var steps []string
	if _, err := e.NewSiteDecommissioner(teardownCfg(true), func(m M) {
		if s, ok := m["step"]; ok {
			steps = append(steps, pyStr(s))
		}
	}).Decommission(); err != nil {
		t.Fatalf("dry run: %v", err)
	}

	found := false
	for _, s := range steps {
		if strings.Contains(s, "would REFUSE") {
			found = true
		}
	}
	if !found {
		t.Fatalf("a dry run on an install that cannot record said nothing about it. steps: %v", steps)
	}
}

// The address-block teardown is the fifth delete path and reaches a different
// decommissioner, so it gets the same two proofs rather than an assumption that
// one covers both.
func TestBlockTeardownWritesExportBeforeFirstDeleteAndRefusesWithout(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "teardown-exports")
	e, ft, _ := newExportHarness(t, dir)

	result, err := e.NewBlockDecommissioner("regional-pool", "default", false, func(M) {}).Decommission()
	if err != nil {
		t.Fatalf("block Decommission: %v", err)
	}
	if ft.deleteCount() == 0 {
		t.Fatal("no block deletes happened — this proves nothing")
	}
	if len(ft.exportsAtFirstDelete) != 1 {
		t.Fatalf("at the first block delete the export dir held %v — want the record already written",
			ft.exportsAtFirstDelete)
	}

	doc := readExport(t, result["export_path"].(string))
	if doc["kind"] != exportKindBlock {
		t.Fatalf("kind = %v, want %q", doc["kind"], exportKindBlock)
	}
	plan, _ := doc["plan"].(map[string]any)
	blocks, _ := plan["address_blocks"].([]any)
	if len(blocks) != 2 {
		t.Fatalf("plan holds %d address blocks, want 2", len(blocks))
	}
	// Deletion is deepest-child-first; a rebuild has to go the other way. Saying
	// so in the file is the difference between a record and a usable one.
	if s, _ := plan["restore_caution"].(string); !strings.Contains(s, "parent-first") {
		t.Fatalf("block export does not warn about re-create order: %q", s)
	}

	// And the refusal, with the delete count proving it held.
	ft2 := &fakeTenant{watchDir: t.TempDir()}
	srv2 := httptest.NewServer(ft2.handler())
	defer srv2.Close()
	auth := rest.NewAuth("test-key", func() string { return "" })
	e2 := New(rest.New(srv2.URL, auth), "").WithExport(&ExportWriter{Dir: "", Version: "t"})
	if _, err := e2.NewBlockDecommissioner("regional-pool", "default", false, func(M) {}).Decommission(); err == nil {
		t.Fatal("block teardown proceeded with no record of what it was deleting")
	}
	if n := ft2.deleteCount(); n != 0 {
		t.Fatalf("the block refusal sent %d DELETE(s) upstream", n)
	}
}

// An engine with NO recorder at all must refuse, not treat nil as "recording is
// off". A nil-safe no-op here would silently restore the old behaviour for any
// caller that forgot to wire it — which is every caller, by default.
func TestNilExporterRefusesRatherThanSkippingTheRecord(t *testing.T) {
	ft := &fakeTenant{watchDir: t.TempDir()}
	srv := httptest.NewServer(ft.handler())
	defer srv.Close()
	auth := rest.NewAuth("test-key", func() string { return "" })
	e := New(rest.New(srv.URL, auth), "") // Export left nil

	_, err := e.NewSiteDecommissioner(teardownCfg(false), func(M) {}).Decommission()
	if err == nil {
		t.Fatal("a teardown with no recorder wired ran anyway")
	}
	if ft.deleteCount() != 0 {
		t.Fatalf("it sent %d DELETE(s) first", ft.deleteCount())
	}
}

// Permissions, because the file holds zone FQDNs, internal addressing and host
// names in plaintext next to the audit log.
func TestExportFileAndDirAreOwnerOnly(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "teardown-exports")
	e, _, _ := newExportHarness(t, dir)

	result, err := e.NewSiteDecommissioner(teardownCfg(false), func(M) {}).Decommission()
	if err != nil {
		t.Fatalf("Decommission: %v", err)
	}
	fi, err := os.Stat(result["export_path"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("export file mode %o, want 600 — it holds tenant addressing in plaintext", perm)
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := di.Mode().Perm(); perm != 0o700 {
		t.Fatalf("export dir mode %o, want 700", perm)
	}
}

// A site name comes from a YAML template, so it reaches the filename. It must not
// be able to steer the file out of the export directory.
func TestExportFilenameCannotEscapeTheDirectory(t *testing.T) {
	w := &ExportWriter{
		Dir: "/state/teardown-exports",
		Now: func() time.Time { return time.Date(2026, 7, 30, 9, 15, 22, 0, time.UTC) },
	}
	for _, target := range []string{
		"../../etc/passwd",
		"a/b/c",
		"..",
		"",
		strings.Repeat("x", 300),
		"AMS-Prod",
	} {
		got := w.PlannedPath(exportKindSite, target)
		if filepath.Dir(got) != "/state/teardown-exports" {
			t.Fatalf("target %q escaped the export dir: %s", target, got)
		}
		if strings.Contains(filepath.Base(got), "/") || strings.Contains(filepath.Base(got), "..") {
			t.Fatalf("target %q produced an unsafe filename: %s", target, filepath.Base(got))
		}
	}

	// Case is folded and the timestamp leads, so files sort chronologically.
	if got := filepath.Base(w.PlannedPath(exportKindSite, "AMS-Prod")); got != "20260730T091522Z-teardown-site-ams-prod.json" {
		t.Fatalf("filename = %q", got)
	}
}

// Two runs against the same target in the same second must not silently become
// one file, with the second overwriting the first run's record.
func TestExportRefusesToOverwriteAnExistingRecord(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "teardown-exports")
	at := func() time.Time { return time.Date(2026, 7, 30, 9, 15, 22, 0, time.UTC) }
	w := &ExportWriter{Dir: dir, Version: "t", Now: at}

	first, err := w.Write(exportKindSite, "ams", M{"n": 1})
	if err != nil {
		t.Fatalf("first write: %v", err)
	}

	// Same clock, same target: the second write lands on the same name.
	if _, err := w.Write(exportKindSite, "ams", M{"n": 2}); err == nil {
		t.Fatal("the second run overwrote the first run's record without complaint")
	}

	// And the first record is untouched.
	doc := readExport(t, first)
	plan, _ := doc["plan"].(map[string]any)
	if plan["n"] != float64(1) {
		t.Fatalf("the first record was modified: %v", plan)
	}
}
