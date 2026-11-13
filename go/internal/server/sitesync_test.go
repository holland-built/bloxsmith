package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/sitelists"
)

// syncTenant is a tenant with InfoRank, one custom list (901, "top-sites")
// already used by policy 7, and a threat lookup that flags nothing.
type syncTenant struct {
	top     []string
	items   []string
	patches int
	// failPatch makes Infoblox take the change and then answer 500, as a
	// run that stopped part way looks from Bloxsmith.
	failPatch bool
}

func (f *syncTenant) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		out := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		var body map[string]any
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		switch p := r.URL.Path; {
		case p == "/tide/api/data/threats/state/host":
			out(map[string]any{"threat": []any{}, "record_count": 0})
		case p == "/tide/api/data/set/inforank":
			sites := []any{}
			for _, s := range f.top {
				sites = append(sites, map[string]any{"domain": s})
			}
			out(map[string]any{"site": sites, "download_date": "2026-11-13"})
		case p == "/api/atcfw/v1/security_policies/7":
			out(map[string]any{"results": map[string]any{"id": 7, "name": "Office", "rules": []any{
				map[string]any{"type": "custom_list", "data": "top-sites", "action": "action_allow"}}}})
		case p == "/api/atcfw/v1/named_lists/901" && r.Method == "GET":
			items := []any{}
			for _, s := range f.items {
				items = append(items, s)
			}
			out(map[string]any{"results": map[string]any{"id": 901, "name": "top-sites", "type": "custom_list", "items": items}})
		case p == "/api/atcfw/v1/named_lists/901/items" && r.Method == "PATCH":
			f.patches++
			for _, x := range asAnySlice(body["inserted_items_described"]) {
				f.items = append(f.items, x.(map[string]any)["item"].(string))
			}
			gone := map[string]bool{}
			for _, x := range asAnySlice(body["deleted_items_described"]) {
				gone[x.(map[string]any)["item"].(string)] = true
			}
			keep := []string{}
			for _, s := range f.items {
				if !gone[s] {
					keep = append(keep, s)
				}
			}
			f.items = keep
			if f.failPatch {
				w.WriteHeader(500)
				return
			}
			out(map[string]any{})
		default:
			w.WriteHeader(500)
		}
	}
}

func asAnySlice(v any) []any { s, _ := v.([]any); return s }

func syncPost(t *testing.T, d *Deps, h func(http.ResponseWriter, *http.Request, map[string]any), path string, b map[string]any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(b)
	r := httptest.NewRequest("POST", path, strings.NewReader(string(raw)))
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	d.body(h)(rr, r)
	return rr.Code, decodeBody(t, rr)
}

func syncProposals(t *testing.T, d *Deps) []any {
	t.Helper()
	// A fresh cache each look, as a day later would have.
	d.Dashboard = &dashboard.Service{Rest: d.Rest, Cache: cache.New()}
	r := httptest.NewRequest("GET", "/api/lists/proposals", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	d.listsProposals(rr, r)
	res := decodeBody(t, rr)
	ps, _ := res["proposals"].([]any)
	return ps
}

func strs(v any) []string {
	out := []string{}
	for _, x := range asAnySlice(v) {
		out = append(out, x.(string))
	}
	sort.Strings(out)
	return out
}

// The daily proposal adds the new top sites, proposes dropping only the sites
// it added itself, and changes nothing until approved.
func TestDailyProposal_AddsThenDropsOnlyItsOwnSites(t *testing.T) {
	f := &syncTenant{top: []string{"google.com", "zoom.us"}, items: []string{"mine.com"}}
	d, logPath := newListsDeps(t, f.handler())
	d.StateDir = t.TempDir()
	if code, res := syncPost(t, d, d.listsWatchSet, "/api/lists/watch", map[string]any{"list_id": 901, "list_name": "top-sites",
		"use": "inforank", "top": 2, "policy_id": 7, "action": "action_allow"}); code != 200 {
		t.Fatalf("watch = %d %v", code, res)
	}

	// The page reads these field names (SiteLists.jsx DailyProposals).
	rr := httptest.NewRecorder()
	d.listsWatches(rr, httptest.NewRequest("GET", "/api/lists/watches", nil))
	if w := decodeBody(t, rr)["watches"].(map[string]any)["901"].(map[string]any); w["list_id"] != float64(901) || w["list_name"] != "top-sites" || w["top"] != float64(2) || w["use"] != "inforank" {
		t.Fatalf("watches = %v", w)
	}

	ps := syncProposals(t, d)
	if len(ps) != 1 {
		t.Fatalf("proposals = %v", ps)
	}
	p := ps[0].(map[string]any)["proposal"].(map[string]any)
	if got := strs(p["add"]); !reflect.DeepEqual(got, []string{"google.com", "zoom.us"}) || len(strs(p["drop"])) != 0 {
		t.Fatalf("first proposal = %v", p)
	}
	if f.patches != 0 {
		t.Fatal("working out a proposal changed the list")
	}

	// A proposal that is not the latest is refused.
	if code, _ := syncPost(t, d, d.listsProposalApply, "/api/lists/proposal/apply", map[string]any{"list_id": 901, "at": "old", "dry": true}); code != 409 {
		t.Fatalf("stale proposal = %d, want 409", code)
	}
	// Live without a preview is refused.
	if code, _ := syncPost(t, d, d.listsProposalApply, "/api/lists/proposal/apply", map[string]any{"list_id": 901, "at": p["at"], "dry": false}); code != 409 || f.patches != 0 {
		t.Fatalf("live without preview = %d, patches %d", code, f.patches)
	}
	code, pre := syncPost(t, d, d.listsProposalApply, "/api/lists/proposal/apply", map[string]any{"list_id": 901, "at": p["at"], "dry": true})
	if code != 200 || pre["fingerprint"] == nil {
		t.Fatalf("preview = %d %v", code, pre)
	}
	code, res := syncPost(t, d, d.listsProposalApply, "/api/lists/proposal/apply", map[string]any{"list_id": 901, "at": p["at"], "dry": false, "fingerprint": pre["fingerprint"]})
	if code != 200 || res["ok"] != true {
		t.Fatalf("approve = %d %v", code, res)
	}
	sort.Strings(f.items)
	if !reflect.DeepEqual(f.items, []string{"google.com", "mine.com", "zoom.us"}) {
		t.Fatalf("list = %v", f.items)
	}
	if n := len(auditEntries(t, logPath, "site-list-sync")); n != 1 {
		t.Fatalf("audit rows = %d, want 1", n)
	}

	// Next day zoom.us falls out of the top: drop it, never mine.com.
	f.top = []string{"google.com"}
	tenant, _ := d.writeIdentity()
	_ = d.siteState().UpdateWatch(tenant, "901", func(w sitelists.Watch, ok bool) (sitelists.Watch, bool, error) {
		w.Checked = "2000-01-01T00:00:00Z"
		return w, ok, nil
	})
	ps = syncProposals(t, d)
	p = ps[0].(map[string]any)["proposal"].(map[string]any)
	if len(strs(p["add"])) != 0 || !reflect.DeepEqual(strs(p["drop"]), []string{"zoom.us"}) {
		t.Fatalf("second proposal = %v", p)
	}
	code, res = syncPost(t, d, d.listsProposalApply, "/api/lists/proposal/apply", map[string]any{"list_id": 901, "at": p["at"], "dry": false})
	if code != 200 || res["ok"] != true {
		t.Fatalf("drop = %d %v", code, res)
	}
	sort.Strings(f.items)
	if !reflect.DeepEqual(f.items, []string{"google.com", "mine.com"}) {
		t.Fatalf("list after drop = %v", f.items)
	}
	// Approved: nothing waits until the next look.
	if ps := syncProposals(t, d); len(ps) != 0 {
		t.Fatalf("proposals after approve = %v", ps)
	}
}

// A run that stops part way still records the sites that went in as the
// sync's own, and keeps the proposal so approving again finishes it.
func TestDailyProposal_APartRunRecordsWhatWentIn(t *testing.T) {
	f := &syncTenant{top: []string{"google.com"}, items: []string{}}
	d, _ := newListsDeps(t, f.handler())
	d.StateDir = t.TempDir()
	syncPost(t, d, d.listsWatchSet, "/api/lists/watch", map[string]any{"list_id": 901, "list_name": "top-sites",
		"use": "inforank", "top": 1, "policy_id": 7, "action": "action_allow"})
	p := syncProposals(t, d)[0].(map[string]any)["proposal"].(map[string]any)
	_, pre := syncPost(t, d, d.listsProposalApply, "/api/lists/proposal/apply", map[string]any{"list_id": 901, "at": p["at"], "dry": true})
	f.failPatch = true
	if code, res := syncPost(t, d, d.listsProposalApply, "/api/lists/proposal/apply", map[string]any{"list_id": 901, "at": p["at"], "dry": false, "fingerprint": pre["fingerprint"]}); code == 200 {
		t.Fatalf("a failed run answered 200: %v", res)
	}
	tenant, _ := d.writeIdentity()
	ws, _ := d.siteState().Watches(tenant)
	if w := ws["901"]; !reflect.DeepEqual(w.Added, []string{"google.com"}) || w.Proposal == nil {
		t.Fatalf("watch after a part run = %+v", w)
	}
}
