package dashboard

// Tests for Site lists (lists.go). Upstream is an in-memory fake Infoblox
// that keeps one policy and its custom lists, so a test can check what the
// tenant holds afterwards, not only what was returned.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

type fakeTenant struct {
	mu       sync.Mutex
	policy   map[string]any
	lists    map[int]map[string]any
	nextID   int
	writes   []string
	putCode  int  // answer to the policy PUT (0 => 200)
	editRule bool // someone else edits the policy right after it is read during apply
	dropRule bool // the PUT silently loses the policy's last rule
	reads    int
}

func newFakeTenant() *fakeTenant {
	return &fakeTenant{
		nextID: 900,
		policy: map[string]any{"id": float64(7), "name": "Office", "rules": []any{
			map[string]any{"type": "named_feed", "data": "Base", "action": "action_block"},
			map[string]any{"type": "custom_list", "data": "vip", "action": "action_allow"},
		}},
		lists: map[int]map[string]any{
			5: {"id": float64(5), "name": "vip", "type": "custom_list", "items": []any{"a.com"}, "policies": []any{"Office", "Lab"}},
		},
	}
}

func (f *fakeTenant) serve(t *testing.T) *Service {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var body map[string]any
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		if r.Method != "GET" {
			f.writes = append(f.writes, r.Method+" "+r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		out := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		p := r.URL.Path
		switch {
		case r.Method == "GET" && p == "/api/atcfw/v1/security_policies/7":
			f.reads++
			out(map[string]any{"results": f.policy})
			if f.editRule && f.reads == 2 {
				rules := append([]any{}, f.policy["rules"].([]any)...)
				f.policy["rules"] = append(rules, map[string]any{"type": "custom_list", "data": "other", "action": "action_log"})
			}
		case r.Method == "PUT" && p == "/api/atcfw/v1/security_policies/7":
			if f.putCode != 0 {
				w.WriteHeader(f.putCode)
				return
			}
			rules := body["rules"].([]any)
			if f.dropRule {
				rules = rules[:len(rules)-1] // loses "vip", a rule the policy had before
			}
			f.policy["rules"] = rules
			out(map[string]any{"results": f.policy})
		case r.Method == "GET" && p == "/api/atcfw/v1/named_lists":
			var rows []any
			for _, l := range f.lists {
				if strings.Contains(r.URL.Query().Get("_filter"), fmt.Sprintf("%q", l["name"])) {
					rows = append(rows, l)
				}
			}
			out(map[string]any{"results": rows})
		case r.Method == "POST" && p == "/api/atcfw/v1/named_lists":
			f.nextID++
			l := map[string]any{"id": float64(f.nextID), "name": body["name"], "type": "custom_list", "items": itemsOf(body["items_described"])}
			f.lists[f.nextID] = l
			out(map[string]any{"results": l})
		case strings.HasPrefix(p, "/api/atcfw/v1/named_lists/"):
			var id int
			fmt.Sscanf(strings.TrimPrefix(p, "/api/atcfw/v1/named_lists/"), "%d", &id)
			l := f.lists[id]
			if l == nil {
				w.WriteHeader(404)
				return
			}
			if r.Method == "PATCH" {
				l["items"] = append(l["items"].([]any), itemsOf(body["inserted_items_described"])...)
			}
			out(map[string]any{"results": l})
		default:
			t.Errorf("unexpected upstream call %s %s", r.Method, p)
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(srv.Close)
	return &Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil)), Cache: cache.New()}
}

func itemsOf(v any) []any {
	var out []any
	for _, x := range asSlice(v) {
		out = append(out, asMap(x)["item"])
	}
	return out
}

func plan(t *testing.T, b map[string]any) ListPlan {
	t.Helper()
	p, err := ParseListPlan(b)
	if err != nil {
		t.Fatalf("ParseListPlan: %v", err)
	}
	return p
}

func newListBody(dry bool) map[string]any {
	return map[string]any{"domains": []any{"Google.com.", "zoom.us", "google.com"}, "list": map[string]any{"name": "top-sites"},
		"policy_id": float64(7), "action": "action_allow", "position": float64(0), "dry": dry}
}

func TestParseListPlanRefusesWhatItCannotDo(t *testing.T) {
	cases := map[string]map[string]any{
		"unknown action": {"domains": []any{"a.com"}, "list": map[string]any{"name": "x"}, "policy_id": 7.0, "action": "action_delete", "position": 0.0},
		"not a domain":   {"domains": []any{"a.com", "not a domain"}, "list": map[string]any{"name": "x"}, "policy_id": 7.0, "action": "action_block", "position": 0.0},
		"no list":        {"domains": []any{"a.com"}, "list": map[string]any{}, "policy_id": 7.0, "action": "action_block", "position": 0.0},
		"no policy":      {"domains": []any{"a.com"}, "list": map[string]any{"name": "x"}, "action": "action_block", "position": 0.0},
		"no domains":     {"domains": []any{}, "list": map[string]any{"name": "x"}, "policy_id": 7.0, "action": "action_block", "position": 0.0},
	}
	for name, b := range cases {
		if _, err := ParseListPlan(b); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	p := plan(t, newListBody(false))
	if len(p.Domains) != 2 || p.Domains[0] != "google.com" {
		t.Fatalf("domains should be cleaned and de-duplicated: %v", p.Domains)
	}
	if p.Dry {
		t.Fatal("dry:false must mean a live run")
	}
	if !plan(t, map[string]any{"domains": []any{"a.com"}, "list": map[string]any{"name": "x"}, "policy_id": 7.0, "action": "action_block", "position": 0.0}).Dry {
		t.Fatal("a request that does not say dry:false must be a preview")
	}
}

func TestPreviewShowsTheChangeAndWritesNothing(t *testing.T) {
	f := newFakeTenant()
	res, status := f.serve(t).ApplyList(plan(t, newListBody(true)))
	if status != 200 || res["dry_run"] != true || res["fingerprint"] == "" {
		t.Fatalf("want a 200 preview with a fingerprint, got %d %v", status, res)
	}
	after := asMap(res["policy"])["after"].([]any)
	if len(after) != 3 || asMap(after[0])["data"] != "top-sites" || asMap(after[0])["action"] != "action_allow" {
		t.Fatalf("the new rule should be first, as asked: %v", after)
	}
	if asMap(res["list"])["will_add"] != 2 || asMap(res["list"])["new"] != true {
		t.Fatalf("preview should say a new list with 2 domains: %v", res["list"])
	}
	if len(f.writes) != 0 {
		t.Fatalf("a preview wrote: %v", f.writes)
	}
}

func applyAfterPreview(t *testing.T, s *Service, b map[string]any) (map[string]any, int) {
	t.Helper()
	b["dry"] = true
	pre, status := s.ApplyList(plan(t, b))
	if status != 200 {
		t.Fatalf("preview failed: %d %v", status, pre)
	}
	b["dry"], b["fingerprint"] = false, pre["fingerprint"]
	return s.ApplyList(plan(t, b))
}

func TestApplyMakesTheListAndPutsTheRuleWhereAsked(t *testing.T) {
	f := newFakeTenant()
	res, status := applyAfterPreview(t, f.serve(t), newListBody(false))
	if status != 200 || res["outcome"] != "verified" {
		t.Fatalf("want verified, got %d %v", status, res)
	}
	rules := f.policy["rules"].([]any)
	if len(rules) != 3 || asMap(rules[0])["data"] != "top-sites" || asMap(rules[1])["data"] != "Base" || asMap(rules[2])["data"] != "vip" {
		t.Fatalf("policy should be the new rule then the old two, in order: %v", rules)
	}
	if l := f.lists[901]; l == nil || len(l["items"].([]any)) != 2 {
		t.Fatalf("the new list should hold the 2 domains: %v", f.lists)
	}
}

func TestApplyAddsToAnExistingListWithoutReplacing(t *testing.T) {
	f := newFakeTenant()
	b := map[string]any{"domains": []any{"a.com", "b.com"}, "list": map[string]any{"id": 5.0},
		"policy_id": 7.0, "action": "action_allow", "position": 0.0}
	res, status := applyAfterPreview(t, f.serve(t), b)
	if status != 200 || res["outcome"] != "verified" {
		t.Fatalf("want verified, got %d %v", status, res)
	}
	if got := f.lists[5]["items"].([]any); len(got) != 2 || got[0] != "a.com" || got[1] != "b.com" {
		t.Fatalf("list should keep a.com and gain only b.com: %v", got)
	}
	if len(f.policy["rules"].([]any)) != 2 {
		t.Fatal("the policy already uses this list as Allow, so it must not get a second rule")
	}
	for _, w := range f.writes {
		if strings.HasPrefix(w, "PUT") {
			t.Fatal("the policy must not be written when no rule is added")
		}
	}
}

func TestPreviewNamesOtherPoliciesUsingTheList(t *testing.T) {
	f := newFakeTenant()
	b := map[string]any{"domains": []any{"b.com"}, "list": map[string]any{"id": 5.0}, "policy_id": 7.0,
		"action": "action_allow", "position": 0.0, "dry": true}
	res, _ := f.serve(t).ApplyList(plan(t, b))
	if used := asMap(res["list"])["also_used_by"].([]any); len(used) != 1 || used[0] != "Lab" {
		t.Fatalf("preview should warn that Lab uses this list too: %v", used)
	}
}

func TestADifferentActionOnTheSameListIsRefusedBeforeAnyWrite(t *testing.T) {
	f := newFakeTenant()
	b := map[string]any{"domains": []any{"b.com"}, "list": map[string]any{"id": 5.0}, "policy_id": 7.0,
		"action": "action_block", "position": 0.0, "dry": false, "fingerprint": "x"}
	res, status := f.serve(t).ApplyList(plan(t, b))
	if status != 409 || !strings.Contains(fmt.Sprint(res["error"]), "already uses") {
		t.Fatalf("want 409 'already uses', got %d %v", status, res)
	}
	if len(f.writes) != 0 {
		t.Fatalf("wrote before refusing: %v", f.writes)
	}
}

func TestANameAlreadyTakenIsRefused(t *testing.T) {
	f := newFakeTenant()
	b := newListBody(true)
	b["list"] = map[string]any{"name": "vip"}
	_, status := f.serve(t).ApplyList(plan(t, b))
	if status != 409 {
		t.Fatalf("want 409 for a name already in use, got %d", status)
	}
}

func TestApplyRefusesAStaleOrMissingFingerprint(t *testing.T) {
	for _, fp := range []any{nil, "0000"} {
		f := newFakeTenant()
		b := newListBody(false)
		b["fingerprint"] = fp
		res, status := f.serve(t).ApplyList(plan(t, b))
		if status != 409 || len(f.writes) != 0 {
			t.Fatalf("fingerprint %v: want 409 and no writes, got %d %v %v", fp, status, res, f.writes)
		}
	}
}

func TestAPolicyEditedDuringApplyIsLeftAlone(t *testing.T) {
	f := newFakeTenant()
	f.editRule = true
	res, status := applyAfterPreview(t, f.serve(t), newListBody(false))
	if status != 409 || res["outcome"] != "partial" {
		t.Fatalf("want 409 partial, got %d %v", status, res)
	}
	for _, w := range f.writes {
		if strings.HasPrefix(w, "PUT") {
			t.Fatal("a policy changed by someone else must not be overwritten")
		}
	}
}

func TestALostRuleAfterThePUTIsReported(t *testing.T) {
	f := newFakeTenant()
	f.dropRule = true
	res, _ := applyAfterPreview(t, f.serve(t), newListBody(false))
	if res["ok"] != false || !strings.Contains(fmt.Sprint(res["error"]), "no longer there") {
		t.Fatalf("a rule that vanished must be reported: %v", res)
	}
}

func TestAPolicyWriteFailureKeepsTheListAndSaysSo(t *testing.T) {
	f := newFakeTenant()
	f.putCode = 400
	res, status := applyAfterPreview(t, f.serve(t), newListBody(false))
	if status != 502 || res["outcome"] != "partial" || !strings.Contains(fmt.Sprint(res["error"]), "the list is done") {
		t.Fatalf("want partial saying the list is done, got %d %v", status, res)
	}
}

func TestLostRulesKeepsOrder(t *testing.T) {
	r := func(d string) any { return map[string]any{"type": "custom_list", "data": d, "action": "action_block"} }
	if got := lostRules([]any{r("a"), r("b")}, []any{r("new"), r("a"), r("b")}); len(got) != 0 {
		t.Fatalf("nothing was lost: %v", got)
	}
	if got := lostRules([]any{r("a"), r("b")}, []any{r("b"), r("a")}); len(got) != 1 {
		t.Fatalf("a reordered rule counts as lost: %v", got)
	}
	if got := lostRules([]any{r("a"), r("b"), r("c")}, []any{r("a"), r("c")}); len(got) != 1 || asMap(got[0])["data"] != "b" {
		t.Fatalf("b was lost: %v", got)
	}
}

func TestInfoRankTopReturnsTheFirstNInRankOrder(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/tide/api/data/set/inforank" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"download_date":"2026-11-12T17:34:56Z","site":[{"domain":"gstatic.com","rank":1},{"domain":"cloudfront.net","rank":2},{"domain":"akamai.net","rank":3}]}`)
	}))
	t.Cleanup(srv.Close)
	s := &Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil)), Cache: cache.New()}
	res, err := s.InfoRankTop(2)
	if err != nil {
		t.Fatal(err)
	}
	if d := res["domains"].([]string); len(d) != 2 || d[0] != "gstatic.com" || d[1] != "cloudfront.net" {
		t.Fatalf("want the top 2 in order: %v", d)
	}
	if res["date"] != "2026-11-12T17:34:56Z" || res["total"] != 3 {
		t.Fatalf("want the list date and total: %v", res)
	}
	if _, err := s.InfoRankTop(3); err != nil || calls != 1 {
		t.Fatalf("the daily list should be fetched once and reused, got %d fetches", calls)
	}
	if _, err := s.InfoRankTop(0); err == nil {
		t.Fatal("top 0 must be refused")
	}
}

func TestApplyRefusesDomainsThePreviewDidNotShow(t *testing.T) {
	f := newFakeTenant()
	s := f.serve(t)
	pre, _ := s.ApplyList(plan(t, newListBody(true)))
	b := newListBody(false)
	b["domains"] = []any{"other.com"}
	b["fingerprint"] = pre["fingerprint"]
	res, status := s.ApplyList(plan(t, b))
	if status != 409 || len(f.writes) != 0 {
		t.Fatalf("different domains after the preview must be refused before any write: %d %v %v", status, res, f.writes)
	}
}
