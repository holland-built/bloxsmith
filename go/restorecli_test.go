package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bloxsmith/internal/provision"
	"bloxsmith/internal/rest"
)

// READING A TEARDOWN EXPORT BACK.
//
// The export shipped in v3.31.0 with nothing that could read it. These tests are
// about the two ways a reader of a recovery file can be worse than no reader:
//
//  1. producing a plan with HOLES in it — an object silently dropped, from a field
//     that changed shape or a format it half-understood. The operator rebuilds from
//     it believing it complete, and the missing subnet surfaces weeks later.
//  2. producing a plan in the WRONG ORDER. Creation order is not the reverse of
//     deletion order, and a rebuild that follows the wrong one fails halfway with a
//     tenant in a third state.
//
// The fixtures are REAL exports written by the real ExportWriter through the real
// decommissioner (see internal/provision/export_test.go for the same discipline).
// Hand-authoring the JSON would only prove this reader agrees with whoever wrote
// the fixture.

// realSiteExport produces a genuine site-teardown export by running the REAL
// teardown engine against a fake Infoblox, and returns the file it wrote.
//
// Not hand-authored JSON. Hand-authoring would only prove this reader agrees with
// whoever typed the fixture, and would go on passing after the writer's field
// names drifted — which is the exact "two things that must agree" failure this
// repo keeps finding. Driving the real writer means a change on either side fails
// here, loudly.
func realSiteExport(t *testing.T) string {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
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
			_, _ = w.Write([]byte(`{"results":[
			  {"id":"ipam/subnet/sn-1","address":"10.20.0.0","cidr":24,"name":"ams-general","comment":"general purpose"},
			  {"id":"ipam/subnet/sn-2","address":"10.20.1.0","cidr":24,"name":"ams-voice"}]}`))
		case strings.HasSuffix(p, "/dns/auth_zone"):
			_, _ = w.Write([]byte(`{"results":[{"id":"dns/auth_zone/z-1","fqdn":"site-ams.example.com.","primary_type":"cloud"}]}`))
		case strings.HasSuffix(p, "/ipam/range"):
			_, _ = w.Write([]byte(`{"results":[{"id":"ipam/range/r-1","start":"10.20.0.100","end":"10.20.0.200","name":"ams-pool"}]}`))
		case strings.HasSuffix(p, "/ipam/host"):
			_, _ = w.Write([]byte(`{"results":[
			  {"id":"ipam/host/h-1","name":"printer.site-ams.example.com"},
			  {"id":"ipam/host/h-2","name":"other.example.com"}]}`))
		default:
			_, _ = w.Write([]byte(`{"results":[]}`))
		}
	}))
	t.Cleanup(srv.Close)

	dir := filepath.Join(t.TempDir(), "teardown-exports")
	auth := rest.NewAuth("test-key", func() string { return "" })
	e := provision.New(rest.New(srv.URL, auth), "").WithExport(&provision.ExportWriter{
		Dir:         dir,
		Tenant:      "conn-abc/-",
		TenantLabel: "Fake Tenant",
		Version:     "3.31.0",
		Now:         func() time.Time { return time.Date(2026, 7, 30, 9, 15, 22, 0, time.UTC) },
	})

	cfg := &provision.DecommissionConfig{
		Site: "ams", IPSpace: "default", DNSParent: "example.com", DNSView: "default",
	}
	res, err := e.NewSiteDecommissioner(cfg, func(provision.M) {}).Decommission()
	if err != nil {
		t.Fatalf("real teardown could not produce an export: %v", err)
	}
	path, _ := res["export_path"].(string)
	if path == "" {
		t.Fatal("the real teardown reported no export_path")
	}
	return path
}

func planOf(t *testing.T, path string) []restoreStep {
	t.Helper()
	doc, err := readExport(path)
	if err != nil {
		t.Fatalf("readExport: %v", err)
	}
	steps, err := planFromExport(doc)
	if err != nil {
		t.Fatalf("planFromExport: %v", err)
	}
	return steps
}

// NOTHING MAY BE DROPPED. Every object the export records has to appear, or the
// operator rebuilds from a plan that is quietly short.
func TestRestorePlanDropsNothing(t *testing.T) {
	steps := planOf(t, realSiteExport(t))

	got := map[string]int{}
	for _, s := range steps {
		got[s.Kind]++
	}
	want := map[string]int{
		"ip_space": 1, "dns_view": 1, // prerequisites
		// 3 zones: 1 forward + 1 reverse per subnet. The real engine plans a
		// reverse zone per subnet, which a hand-written fixture had wrong.
		"subnet": 2, "dhcp_range": 1, "dns_zone": 3, "host": 1,
	}
	for k, n := range want {
		if got[k] != n {
			t.Fatalf("plan has %d %s, want %d — an object was dropped (full plan: %+v)", got[k], k, n, got)
		}
	}
	if len(steps) != 9 {
		t.Fatalf("plan has %d steps, want 9", len(steps))
	}
	// Every step must name the object. A blank name in a recovery plan is useless
	// and reads as though the export held nothing there.
	for _, s := range steps {
		if strings.TrimSpace(s.Name) == "" {
			t.Fatalf("step %d (%s) has no name", s.N, s.Kind)
		}
	}
}

// THE ORDER. Creation order is dependency-driven and is NOT the reverse of the
// delete order. Getting it wrong is how a manual rebuild fails halfway.
func TestRestorePlanOrdersByDependencyNotReverseOfDeletion(t *testing.T) {
	steps := planOf(t, realSiteExport(t))

	idx := map[string]int{}
	for _, s := range steps {
		if _, seen := idx[s.Kind]; !seen {
			idx[s.Kind] = s.N
		}
	}

	// A subnet must exist before a range inside it.
	if idx["subnet"] >= idx["dhcp_range"] {
		t.Fatalf("dhcp_range (%d) is planned before subnet (%d) — the range has nowhere to live",
			idx["dhcp_range"], idx["subnet"])
	}
	// Hosts last: they need both a subnet and a zone.
	last := steps[len(steps)-1]
	if last.Kind != "host" {
		t.Fatalf("last step is %s, want host — a host needs its subnet and zone first", last.Kind)
	}
	// The prerequisites lead, so the operator checks them before creating anything.
	if steps[0].Kind != "ip_space" || !steps[0].Prereq {
		t.Fatalf("first step is %+v, want the ip_space prerequisite", steps[0])
	}

	// And the delete order really is different: teardown removes the forward zone
	// FIRST and hosts LAST. If creation were the reverse of that, hosts would come
	// first — which is the bug this asserts against.
	if steps[0].Kind == "host" {
		t.Fatal("plan is the reverse of the delete order, not a dependency order")
	}
}

// Address blocks invert the other way: deleted deepest-child-first, created
// parent-first. A plan that echoed the delete order would try to create a /24
// before the /16 that contains it.
func TestBlockRestorePlanIsParentFirst(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "blocks.json")
	body := map[string]any{
		"bloxsmith_export": 1, "kind": "teardown-block",
		"written_at": "2026-07-30T09:15:22Z", "bloxsmith_version": "3.31.0",
		"tenant": map[string]any{"id": "conn-abc/-", "label": "Fake Tenant"},
		"target": "regional-pool",
		"plan": map[string]any{
			// Deliberately in DELETE order (deepest child first), as the export records.
			"address_blocks": []any{
				map[string]any{"id": "b-3", "address": "10.20.0.0", "cidr": float64(24)},
				map[string]any{"id": "b-2", "address": "10.20.0.0", "cidr": float64(20)},
				map[string]any{"id": "b-1", "address": "10.20.0.0", "cidr": float64(16)},
			},
		},
	}
	b, _ := json.MarshalIndent(body, "", "  ")
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}

	steps := planOf(t, p)
	if len(steps) != 3 {
		t.Fatalf("%d steps, want 3", len(steps))
	}
	want := []string{"10.20.0.0/16", "10.20.0.0/20", "10.20.0.0/24"}
	for i, w := range want {
		if steps[i].Name != w {
			t.Fatalf("step %d is %s, want %s — blocks must be created parent-first, the reverse "+
				"of the order they were deleted in", i+1, steps[i].Name, w)
		}
	}
}

// REFUSE WHAT IT DOES NOT UNDERSTAND. A half-read export produces a plan with
// holes, and the operator cannot tell the difference from a complete one.
func TestRestorePlanRefusesUnusableExports(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}

	cases := []struct {
		name    string
		path    string
		wantSub string
	}{
		{"missing file", filepath.Join(dir, "nope.json"), "could not read"},
		{"not JSON", write("bad.json", "this is not json"), "not valid JSON"},
		{"no marker", write("nomark.json", `{"kind":"teardown-site","plan":{}}`), "not a teardown export"},
		{"future format", write("future.json",
			`{"bloxsmith_export":99,"kind":"teardown-site","plan":{}}`), "format 99"},
		{"no plan", write("noplan.json",
			`{"bloxsmith_export":1,"kind":"teardown-site"}`), "no plan section"},
		{"unknown kind", write("weird.json",
			`{"bloxsmith_export":1,"kind":"teardown-galaxy","plan":{}}`), "unknown kind"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := readExport(c.path)
			if err == nil {
				t.Fatalf("accepted an unusable export — it would produce a plan with holes in it")
			}
			if !strings.Contains(err.Error(), c.wantSub) {
				t.Fatalf("error %q does not contain %q", err.Error(), c.wantSub)
			}
		})
	}
}

// A FUTURE FORMAT MUST NOT BE READ OPTIMISTICALLY. The marker exists so a newer
// shape cannot be misread as this one — reading format 2 as format 1 is exactly
// how objects go missing silently.
func TestRestorePlanRefusesANewerFormatRatherThanGuessing(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "v2.json")
	// Valid in every other respect, and full of objects.
	content := `{"bloxsmith_export":2,"kind":"teardown-site","plan":{"subnets":[
	  {"id":"a","address":"10.0.0.0","cidr":24}]}}`
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := readExport(p)
	if err == nil {
		t.Fatal("read a format-2 export as though it were format 1")
	}
	if !strings.Contains(err.Error(), "new enough") {
		t.Fatalf("the refusal does not tell the operator what to do: %q", err.Error())
	}
}

// The tenant must be named, and an export that does not record one must SAY so
// rather than printing a blank — rebuilding into the wrong tenant is the same
// class of mistake as tearing down the wrong one.
func TestRestorePlanNamesTheTenantAndFlagsAMissingOne(t *testing.T) {
	steps := planOf(t, realSiteExport(t))
	if len(steps) == 0 {
		t.Fatal("no steps")
	}

	out := captureStdout(t, func() {
		doc, _ := readExport(realSiteExport(t))
		printRestorePlan("x.json", doc, steps)
	})
	if !strings.Contains(out, "Fake Tenant") || !strings.Contains(out, "conn-abc/-") {
		t.Fatalf("plan does not name the tenant: %q", out)
	}
	if !strings.Contains(out, "PLAN") || !strings.Contains(out, "Nothing is created") {
		t.Fatalf("plan does not state that it creates nothing: %q", out)
	}

	// Now one with no tenant recorded.
	dir := t.TempDir()
	p := filepath.Join(dir, "notenant.json")
	os.WriteFile(p, []byte(`{"bloxsmith_export":1,"kind":"teardown-site","target":"ams",
	  "plan":{"subnets":[{"id":"a","address":"10.0.0.0","cidr":24,"name":"n"}]}}`), 0o600)
	doc, err := readExport(p)
	if err != nil {
		t.Fatal(err)
	}
	st, _ := planFromExport(doc)
	out = captureStdout(t, func() { printRestorePlan(p, doc, st) })
	if !strings.Contains(out, "NOT RECORDED") {
		t.Fatalf("a missing tenant was not flagged: %q", out)
	}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	done := make(chan string)
	go func() {
		var b strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			b.Write(buf[:n])
			if err != nil {
				break
			}
		}
		done <- b.String()
	}()
	fn()
	w.Close()
	os.Stdout = old
	return <-done
}
