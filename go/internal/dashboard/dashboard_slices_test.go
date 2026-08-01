package dashboard

import (
	"net/http"
	"sort"
	"sync"
	"testing"
)

// This file is the regression suite for ?only= slice selection on /api/data.
//
// The rule it exists to protect: a slice that was NOT requested is absent from
// both the data map and _meta. There is no fourth status word for "not asked
// for" — absence itself is the representation — so these tests pin exactly
// which keys a narrowed response carries, and pin that the no-?only= path is
// untouched.

// recordingHandler counts upstream requests per path while answering every
// /api/data feed the way feedStatusHandler does. buildAggregate fans its tasks
// out concurrently, so the counter is mutex-guarded.
type recordingHandler struct {
	mu    sync.Mutex
	hits  map[string]int
	inner http.HandlerFunc
}

func newRecordingHandler(t *testing.T, overrides map[string]http.HandlerFunc) *recordingHandler {
	t.Helper()
	return &recordingHandler{hits: map[string]int{}, inner: feedStatusHandler(t, overrides)}
}

func (h *recordingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	h.hits[r.URL.Path]++
	h.mu.Unlock()
	h.inner(w, r)
}

func (h *recordingHandler) paths() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.hits))
	for p := range h.hits {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

func (h *recordingHandler) total() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, c := range h.hits {
		n += c
	}
	return n
}

func (h *recordingHandler) reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.hits = map[string]int{}
}

func metaOf(t *testing.T, data map[string]any) map[string]any {
	t.Helper()
	meta, ok := data["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("_meta missing or wrong type: %v", data["_meta"])
	}
	return meta
}

// sortedKeys returns data's keys excluding the two underscore-prefixed
// envelope keys, so a test can assert on the data slices alone.
func sortedKeys(data map[string]any) []string {
	out := []string{}
	for k := range data {
		if k == "_meta" || k == "_totals" {
			continue
		}
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TEST 1 — a narrowed ask must not pay for the slices it did not ask for.
// This is the whole point of the feature: Audit waited ~9s for a bundle whose
// slow calls (the 5,000-row subnet page, the at-risk pager) it never reads.
func TestFetchDashboardData_OnlyAuditLogs_HitsOnlyTheAuditPath(t *testing.T) {
	h := newRecordingHandler(t, nil)
	s := newDashboardTestService(t, h.ServeHTTP)

	s.FetchDashboardData([]string{"auditLogs"})

	want := []string{"/api/auditlog/v1/logs"}
	if got := h.paths(); !equalStrings(got, want) {
		t.Fatalf("only=auditLogs hit %v, want exactly %v — a narrowed ask must not run the slices it did not ask for", got, want)
	}
}

// TEST 2 — the response describes exactly what was read. Stamping keys for
// slices that were never fetched would hand the client a status for a read
// that never happened.
func TestFetchDashboardData_NarrowedResponseCarriesOnlyFetchedKeys(t *testing.T) {
	s := newDashboardTestService(t, feedStatusHandler(t, nil))

	data := s.FetchDashboardData([]string{"auditLogs"})

	if got := sortedKeys(data); !equalStrings(got, []string{"auditLogs"}) {
		t.Fatalf("narrowed data keys = %v, want exactly [auditLogs]", got)
	}
	meta := metaOf(t, data)
	gotMeta := []string{}
	for k := range meta {
		gotMeta = append(gotMeta, k)
	}
	sort.Strings(gotMeta)
	if !equalStrings(gotMeta, []string{"auditLogs"}) {
		t.Fatalf("narrowed _meta keys = %v, want exactly [auditLogs] — a slice nobody asked for gets no status at all", gotMeta)
	}
}

// TEST 3 — narrowing must not blunt the failure word. A dead audit feed still
// reports "error", never "empty": a quiet feed and a dead one must render
// differently or a real outage reads as "all clear".
func TestFetchDashboardData_NarrowedFeedFailureStaysError(t *testing.T) {
	s := newDashboardTestService(t, feedStatusHandler(t, map[string]http.HandlerFunc{
		"/api/auditlog/v1/logs": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		},
	}))

	data := s.FetchDashboardData([]string{"auditLogs"})

	if got := metaOf(t, data)["auditLogs"]; got != "error" {
		t.Fatalf("_meta[auditLogs] = %v, want \"error\" for a 5xx read (never \"empty\")", got)
	}
}

// TEST 4 — dependency closure. Zone rows carry a human-readable view NAME
// resolved from the dns/view rows, so asking for zones must also read
// dnsViews — and must RETURN dnsViews with its own genuine status, because the
// payload contains exactly what was read.
func TestFetchDashboardData_OnlyZonesPullsDnsViewsForNameResolution(t *testing.T) {
	h := newRecordingHandler(t, map[string]http.HandlerFunc{
		"/api/ddi/v1/dns/view": func(w http.ResponseWriter, r *http.Request) {
			writeResults(w, []map[string]any{{"id": "dns/view/abcdef1234567890", "name": "corp-view"}})
		},
		"/api/ddi/v1/dns/auth_zone": func(w http.ResponseWriter, r *http.Request) {
			writeResults(w, []map[string]any{{"id": "z1", "fqdn": "example.com", "view": "dns/view/abcdef1234567890"}})
		},
	})
	s := newDashboardTestService(t, h.ServeHTTP)

	data := s.FetchDashboardData([]string{"zones"})

	want := []string{"/api/ddi/v1/dns/auth_zone", "/api/ddi/v1/dns/view"}
	if got := h.paths(); !equalStrings(got, want) {
		t.Fatalf("only=zones hit %v, want exactly %v (zones cannot be shaped without the view rows)", got, want)
	}
	if got := sortedKeys(data); !equalStrings(got, []string{"dnsViews", "zones"}) {
		t.Fatalf("only=zones data keys = %v, want [dnsViews zones] — a slice that was READ must be reported", got)
	}
	meta := metaOf(t, data)
	if meta["dnsViews"] != "ok" {
		t.Fatalf("_meta[dnsViews] = %v, want \"ok\" — the closure slice carries a genuine status, not a placeholder", meta["dnsViews"])
	}
	zones, ok := data["zones"].([]map[string]any)
	if !ok || len(zones) != 1 {
		t.Fatalf("zones missing or wrong shape: %v", data["zones"])
	}
	if zones[0]["view"] != "corp-view" {
		t.Fatalf("zone view = %v, want the resolved name \"corp-view\" (an unresolved id means dnsViews was not fetched)", zones[0]["view"])
	}
}

// TEST 5 — the projection bridge. The whole aggregate lives under ONE cache
// key, so without this a narrowed ask would MISS the warm full entry and go
// upstream again — slower than the full request it was meant to beat.
func TestFetchDashboardData_WarmFullEntryAnswersNarrowedAskWithZeroCalls(t *testing.T) {
	h := newRecordingHandler(t, map[string]http.HandlerFunc{
		"/api/ddi/v1/dns/view": func(w http.ResponseWriter, r *http.Request) {
			writeResults(w, []map[string]any{{"id": "dns/view/abcdef1234567890", "name": "corp-view"}})
		},
		"/api/ddi/v1/dns/auth_zone": func(w http.ResponseWriter, r *http.Request) {
			writeResults(w, []map[string]any{{"id": "z1", "fqdn": "example.com", "view": "dns/view/abcdef1234567890"}})
		},
	})
	s := newDashboardTestService(t, h.ServeHTTP)

	full := s.FetchDashboardData(nil)
	if h.total() == 0 {
		t.Fatalf("the priming full fetch made no upstream calls at all — the fixture is wrong, not the code")
	}
	h.reset()

	narrowed := s.FetchDashboardData([]string{"zones"})

	if n := h.total(); n != 0 {
		t.Fatalf("narrowed ask against a warm full entry made %d upstream calls (%v), want 0", n, h.paths())
	}
	if got := sortedKeys(narrowed); !equalStrings(got, []string{"dnsViews", "zones"}) {
		t.Fatalf("projected keys = %v, want [dnsViews zones]", got)
	}
	fullZones := full["zones"].([]map[string]any)
	gotZones, ok := narrowed["zones"].([]map[string]any)
	if !ok || len(gotZones) != len(fullZones) || gotZones[0]["view"] != fullZones[0]["view"] || gotZones[0]["fqdn"] != fullZones[0]["fqdn"] {
		t.Fatalf("projected zones %v differ from the full entry's %v", narrowed["zones"], full["zones"])
	}
	if metaOf(t, narrowed)["zones"] != metaOf(t, full)["zones"] {
		t.Fatalf("projected _meta[zones] = %v, want the full entry's %v",
			metaOf(t, narrowed)["zones"], metaOf(t, full)["zones"])
	}
}

// TestFetchDashboardData_WarmProjectionMetaNamesOnlyTheAskedForSlices closes a
// hole found by mutating the code rather than by reading it.
//
// The test above pins the projected DATA keys, and pins that _meta[zones]
// matches — but it never pinned WHICH keys _meta carries. So stamping every
// slice into the projection's _meta left the whole suite GREEN, and the
// projection path is the COMMON one: it serves every narrowed request once the
// full entry is warm, which in normal running is nearly all of them.
//
// A slice nobody asked for, reported as "ok", is the worst shape this codebase
// has: not a missing answer but a confident wrong one. The equivalent
// assertion already existed on the fetch path; it did not exist here.
func TestFetchDashboardData_WarmProjectionMetaNamesOnlyTheAskedForSlices(t *testing.T) {
	h := newRecordingHandler(t, map[string]http.HandlerFunc{
		"/api/ddi/v1/dns/view": func(w http.ResponseWriter, r *http.Request) {
			writeResults(w, []map[string]any{{"id": "dns/view/abcdef1234567890", "name": "corp-view"}})
		},
		"/api/ddi/v1/dns/auth_zone": func(w http.ResponseWriter, r *http.Request) {
			writeResults(w, []map[string]any{{"id": "z1", "fqdn": "example.com", "view": "dns/view/abcdef1234567890"}})
		},
	})
	s := newDashboardTestService(t, h.ServeHTTP)

	if full := s.FetchDashboardData(nil); full == nil {
		t.Fatalf("priming full fetch returned nil — the fixture is wrong, not the code")
	}
	h.reset()

	narrowed := s.FetchDashboardData([]string{"zones"})
	if n := h.total(); n != 0 {
		t.Fatalf("this test only means something if the answer came from the warm entry; it made %d upstream calls", n)
	}

	gotMeta := sortedKeys(metaOf(t, narrowed))
	if !equalStrings(gotMeta, []string{"dnsViews", "zones"}) {
		t.Fatalf("projected _meta names %v, want exactly [dnsViews zones] — a slice that was never "+
			"requested must not appear with a status at all, because every status word this API has "+
			"(ok/empty/error) would be a claim about data nobody fetched", gotMeta)
	}
}

// TEST 6 — the regression net. No ?only= must stay exactly what it was: all 8
// data keys, all 8 _meta keys, and _totals. An absent slice set is NOT the
// empty set.
func TestFetchDashboardData_NoSliceSetIsUnchanged(t *testing.T) {
	s := newDashboardTestService(t, feedStatusHandler(t, nil))

	for _, only := range [][]string{nil, {}} {
		data := s.FetchDashboardData(only)

		want := []string{"auditLogs", "dnsViews", "feeds", "hosts", "leases", "secPolicies", "subnets", "zones"}
		if got := sortedKeys(data); !equalStrings(got, want) {
			t.Fatalf("only=%v data keys = %v, want all 8: %v", only, got, want)
		}
		meta := metaOf(t, data)
		for _, k := range want {
			if _, present := meta[k]; !present {
				t.Fatalf("only=%v _meta[%s] missing — the full payload must keep all 8 statuses", only, k)
			}
		}
		if _, present := data["_totals"]; !present {
			t.Fatalf("only=%v dropped _totals from the full payload", only)
		}
	}
}

// TEST 7 — a narrowed response carries NO _totals. Three of its four numbers
// come from count queries and the fourth (subnetsWarn) from the heavy at-risk
// pager, so a narrowed payload could only report them by running the very
// calls narrowing exists to skip. Omit the block rather than ship a partial one
// that reads like a complete one.
func TestFetchDashboardData_NarrowedResponseHasNoTotals(t *testing.T) {
	s := newDashboardTestService(t, feedStatusHandler(t, nil))

	data := s.FetchDashboardData([]string{"auditLogs"})

	if v, present := data["_totals"]; present {
		t.Fatalf("narrowed response carried _totals = %v; a partial totals block reads like a complete one", v)
	}
}
