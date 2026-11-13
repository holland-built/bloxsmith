package server

import (
	"encoding/json"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/dashboard"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Site lists: a live run that reached Infoblox is always recorded, and a
// preview or a refusal before any write is not.

func listsUpstream(policyPut int) http.HandlerFunc {
	rules := []any{map[string]any{"type": "named_feed", "data": "Base", "action": "action_block"}}
	items := []any{}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		out := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		var body map[string]any
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		switch p := r.URL.Path; {
		case p == "/tide/api/data/threats/state/host": // nothing is a threat here
			out(map[string]any{"threat": []any{}, "record_count": 0})
		case p == "/api/atcfw/v1/security_policies/7" && r.Method == "GET":
			out(map[string]any{"results": map[string]any{"id": 7, "name": "Office", "rules": rules}})
		case p == "/api/atcfw/v1/security_policies/7" && r.Method == "PUT":
			if policyPut != 200 {
				w.WriteHeader(policyPut)
				return
			}
			rules = body["rules"].([]any)
			out(map[string]any{"results": body})
		case p == "/api/atcfw/v1/named_lists" && r.Method == "GET":
			out(map[string]any{"results": []any{}})
		case p == "/api/atcfw/v1/named_lists" && r.Method == "POST":
			for _, x := range body["items_described"].([]any) {
				items = append(items, x.(map[string]any)["item"])
			}
			out(map[string]any{"results": map[string]any{"id": 901, "name": body["name"]}})
		case p == "/api/atcfw/v1/named_lists/901":
			out(map[string]any{"results": map[string]any{"id": 901, "name": "top-sites", "type": "custom_list", "items": items}})
		default:
			w.WriteHeader(500)
		}
	}
}

func newListsDeps(t *testing.T, upstream http.HandlerFunc) (*Deps, string) {
	d, logPath := newDeleteDeps(t, upstream)
	d.Dashboard = &dashboard.Service{Rest: d.Rest, Cache: cache.New()}
	return d, logPath
}

func listsRequest(body map[string]any) *http.Request {
	raw, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", "/api/lists/apply", strings.NewReader(string(raw)))
	r.RemoteAddr = "127.0.0.1:12345"
	return r
}

func runLists(t *testing.T, d *Deps, dry bool, fp any) map[string]any {
	t.Helper()
	rr := httptest.NewRecorder()
	d.body(d.listsApply)(rr, listsRequest(map[string]any{
		"domains": []any{"google.com"}, "list": map[string]any{"name": "top-sites"},
		"policy_id": 7, "action": "action_block_nolog", "position": 0, "dry": dry, "fingerprint": fp}))
	return decodeBody(t, rr)
}

func TestListsApply_LiveRunsAreRecordedPreviewsAreNot(t *testing.T) {
	d, logPath := newListsDeps(t, listsUpstream(200))
	pre := runLists(t, d, true, nil)
	if pre["dry_run"] != true {
		t.Fatalf("preview failed: %v", pre)
	}
	if n := len(auditEntries(t, logPath, "site-list-apply")); n != 0 {
		t.Fatalf("a preview wrote %d audit rows", n)
	}
	if res := runLists(t, d, false, "stale"); res["ok"] != false {
		t.Fatalf("a stale preview must be refused: %v", res)
	}
	if n := len(auditEntries(t, logPath, "site-list-apply")); n != 0 {
		t.Fatalf("a refusal before any write wrote %d audit rows", n)
	}
	res := runLists(t, d, false, pre["fingerprint"])
	if res["outcome"] != "verified" {
		t.Fatalf("want verified: %v", res)
	}
	rows := auditEntries(t, logPath, "site-list-apply")
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	if det := residualAuditDetail(t, rows[0]); det["action"] != "action_block_nolog" || det["outcome"] != "verified" {
		t.Fatalf("the row should carry the action and outcome: %v", det)
	}
}

func TestListsApply_APartialRunIsRecorded(t *testing.T) {
	d, logPath := newListsDeps(t, listsUpstream(400))
	pre := runLists(t, d, true, nil)
	res := runLists(t, d, false, pre["fingerprint"])
	if res["outcome"] != "partial" {
		t.Fatalf("want partial: %v", res)
	}
	if n := len(auditEntries(t, logPath, "site-list-apply")); n != 1 {
		t.Fatalf("a half-done change must be recorded, got %d rows", n)
	}
}
