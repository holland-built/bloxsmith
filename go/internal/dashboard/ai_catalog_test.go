package dashboard

import (
	"context"
	"io"
	"net/http/httptest"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestFindDataRanksZonePathsForAZoneQuestion(t *testing.T) {
	out := findData("how many top level zones do I have")
	var got struct {
		Matches []struct{ Path, Summary string } `json:"matches"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	if len(got.Matches) == 0 || len(got.Matches) > 5 {
		t.Fatalf("want 1..5 matches, got %d: %s", len(got.Matches), out)
	}
	if got.Matches[0].Path != "/api/ddi/v1/dns/auth_zone" {
		t.Fatalf("auth_zone should rank first: %s", out)
	}
}

// No word matched: the model gets every source name, grouped, and picks by
// meaning ("what domains do we host" has no word in common with auth_zone).
func TestFindDataWithNoMatchListsEverySource(t *testing.T) {
	for _, q := range []string{"zzqx", "all"} {
		out := findData(q)
		if !strings.Contains(out, `"/api/ddi/v1"`) || !strings.Contains(out, `"dns/auth_zone"`) {
			t.Fatalf("%q: want the grouped source list, got %.300s", q, out)
		}
		if len(out) > 2900 {
			t.Fatalf("%q: the list must fit the 3000-character tool cap, got %d", q, len(out))
		}
	}
}

func TestCatalogHoldsNoSecretPaths(t *testing.T) {
	for _, e := range aiCatalog {
		if strings.Contains(e.Path, "{") || strings.Contains(e.Path, "token") ||
			strings.Contains(e.Path, "access_codes") || strings.Contains(e.Path, "download") {
			t.Errorf("catalog must not hold %s", e.Path)
		}
	}
	if _, ok := aiCatalogByPath["/api/ddi/v1/dns/global"]; ok {
		t.Error("single-object paths like dns/global must not be in the catalog")
	}
	if len(aiCatalog) < 50 {
		t.Fatalf("catalog looks empty: %d paths", len(aiCatalog))
	}
}

func TestAPIGetRejectsAPathNotInTheCatalog(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, nil)
	})
	for _, p := range []string{"/api/iam/v2/keys", "/api/ddi/v1/dns/auth_zone/../../iam/v2/keys",
		"/api/ddi/v1/dns/auth_zone?x=1", "/host-activation/v1/jointoken", ""} {
		out := s.RunAITool(context.Background(), "api_get", map[string]any{"path": p})
		if !strings.Contains(out, "not a readable data source") {
			t.Errorf("path %q: want refusal, got %s", p, out)
		}
	}
	if len(*paths) != 0 {
		t.Fatalf("refused paths must not reach the tenant, called: %v", *paths)
	}
}

func TestAPIGetReturnsTheExactTotalAndSendsTheFilter(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResultsWithPage(w, []map[string]any{{"fqdn": "com."}, {"fqdn": "net."}},
			map[string]any{"total_size": "1440"})
	})
	out := s.RunAITool(context.Background(), "api_get", map[string]any{
		"path": "/api/ddi/v1/dns/auth_zone", "filter": "fqdn~'^[^.]+\\.$'", "fields": "fqdn,view"})
	var p toolPayload
	if err := json.Unmarshal([]byte(out), &p); err != nil {
		t.Fatalf("not a payload: %v\n%s", err, out)
	}
	if p.TotalCount != 1440 || !p.Truncated || p.Returned != 2 {
		t.Fatalf("want total 1440 from page.total_size, got %+v", p)
	}
	q := (*paths)[0]
	for _, want := range []string{"/api/ddi/v1/dns/auth_zone?", "_filter=fqdn", "_fields=fqdn%2Cview", "_is_total_size_needed=true"} {
		if !strings.Contains(q, want) {
			t.Errorf("request %s lacks %s", q, want)
		}
	}
}

func TestAPIGetWithoutAPageTotalSaysAtLeastAtTheBound(t *testing.T) {
	rows := make([]map[string]any, apiGetLimit)
	for i := range rows {
		rows[i] = map[string]any{"name": "r"}
	}
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, rows)
	})
	out := s.RunAITool(context.Background(), "api_get", map[string]any{"path": "/api/ddi/v1/dns/record"})
	if !strings.Contains(out, fmt.Sprintf("At least %d", apiGetLimit)) {
		t.Fatalf("a full page without a total must not be reported as exact: %s", out)
	}
	if strings.Contains(out, `"total_count":`) {
		t.Fatalf("no exact total_count may be given when the total is unknown: %s", out)
	}
}

func TestAPIGetRejectsOversizedOrOddArguments(t *testing.T) {
	s, paths := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, nil)
	})
	cases := []map[string]any{
		{"path": "/api/ddi/v1/dns/auth_zone", "filter": strings.Repeat("a", 201)},
		{"path": "/api/ddi/v1/dns/auth_zone", "fields": "fqdn;drop"},
	}
	for _, c := range cases {
		if out := s.RunAITool(context.Background(), "api_get", c); !strings.Contains(out, "not accepted") {
			t.Errorf("%v: want refusal, got %s", c, out)
		}
	}
	if len(*paths) != 0 {
		t.Fatalf("refused calls must not reach the tenant: %v", *paths)
	}
}

func TestAPIGetHidesSecretLookingFields(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResults(w, []map[string]any{{"name": "k1", "secret": "s3cr3t", "nested": map[string]any{"password": "p4ss"},
			"deep": []any{[]any{map[string]any{"api_key": "k3y"}}}}})
	})
	out := s.RunAITool(context.Background(), "api_get", map[string]any{"path": "/api/ddi/v1/dns/acl"})
	if strings.Contains(out, "s3cr3t") || strings.Contains(out, "p4ss") || strings.Contains(out, "k3y") || !strings.Contains(out, "k1") {
		t.Fatalf("secret-looking values must be hidden: %s", out)
	}
}

func TestAPIGetUpstreamFailureIsNotReportedAsEmpty(t *testing.T) {
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	out := s.RunAITool(context.Background(), "api_get", map[string]any{"path": "/api/ddi/v1/dns/acl"})
	if !strings.Contains(out, "Could not reach Infoblox") {
		t.Fatalf("got %s", out)
	}
}

// The 2026-10-20 live failure: the model asked auth_zone for "name", which it
// does not have (it is fqdn), and gave up on a result that said nothing.
func TestAPIGetSaysWhenAFilterOrFieldIsWrong(t *testing.T) {
	refused, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	out := refused.RunAITool(context.Background(), "api_get", map[string]any{
		"path": "/api/ddi/v1/dns/auth_zone", "filter": "name=='x'"})
	if !strings.Contains(out, "field name") || strings.Contains(out, "Could not reach") {
		t.Fatalf("a 400 on a filter must point at the field names: %s", out)
	}

	empty, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResultsWithPage(w, []map[string]any{{}, {}}, map[string]any{"total_size": "2"})
	})
	out = empty.RunAITool(context.Background(), "api_get", map[string]any{
		"path": "/api/ddi/v1/dns/auth_zone", "fields": "name"})
	if !strings.Contains(out, "field name") {
		t.Fatalf("rows with none of the asked-for fields must say so: %s", out)
	}
}

func TestAPIGetSendsASmallSample(t *testing.T) {
	rows := make([]map[string]any, 40)
	for i := range rows {
		rows[i] = map[string]any{"fqdn": fmt.Sprintf("z%d.", i)}
	}
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		writeResultsWithPage(w, rows, map[string]any{"total_size": "40"})
	})
	var p toolPayload
	out := s.RunAITool(context.Background(), "api_get", map[string]any{"path": "/api/ddi/v1/dns/auth_zone"})
	if err := json.Unmarshal([]byte(out), &p); err != nil {
		t.Fatalf("not a payload: %v\n%s", err, out)
	}
	if p.Returned != 10 || p.TotalCount != 40 {
		t.Fatalf("want 10 sample rows of 40, got %+v", p)
	}
}

// A reply shaped like Infoblox's search: base paths and endpoints in its own
// ranked order, with a path the app does not allow and a lookalike prefix.
const infobloxSearchReply = `{"services":[{"service_name":"Ipamsvc","base_path":"/api/ddi/v1/",` +
	`"endpoints":[{"path":"/ipam/address_block","methods":["GET"]}]},` +
	`{"service_name":"DnsData","base_path":"/api/ddi/v1/","endpoints":[{"path":"/dns/record","methods":["GET"]}]},` +
	`{"service_name":"Identity","base_path":"/api/iam/v2/","endpoints":[{"path":"/keys","methods":["GET"]}]}]}`

func TestInfobloxSearchKeepsItsOrderAndOnlyAllowedPaths(t *testing.T) {
	got := catalogPathsIn(infobloxSearchReply)
	var paths []string
	for _, e := range got {
		paths = append(paths, e.Path)
	}
	want := "/api/ddi/v1/ipam/address_block /api/ddi/v1/dns/record"
	if strings.Join(paths, " ") != want {
		t.Fatalf("got %v, want %s (not /ipam/address, not /iam/v2/keys)", paths, want)
	}
}

// fakeSearchMCP answers the handshake, then tools/call with reply or status.
func fakeSearchMCP(t *testing.T, status int, reply string, calls *int) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Method string `json:"method"`
			ID     int    `json:"id"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.Unmarshal(raw, &req)
		w.Header().Set("Content-Type", "application/json")
		switch req.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "s1")
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + itoa(req.ID) + `,"result":{}}`))
		case "tools/call":
			*calls++
			if req.Params.Name != "infoblox-portal_search_available_services" {
				t.Errorf("unexpected tool %q", req.Params.Name)
			}
			if status != 200 {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"error":{"code":-32600,"message":"Authorization denied"}}`))
				return
			}
			text, _ := json.Marshal(reply)
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + itoa(req.ID) + `,"result":{"content":[{"type":"text","text":` + string(text) + `}]}}`))
		default:
			w.WriteHeader(http.StatusAccepted)
		}
	}))
	t.Cleanup(srv.Close)
	return &Service{Mcp: mcp.New(srv.URL+"/mcp", func() string { return "Token k" }), Cache: cache.New(), ent: &entitlement{}}
}

func TestFindDataUsesInfobloxSearchWhenAllowed(t *testing.T) {
	calls := 0
	s := fakeSearchMCP(t, 200, infobloxSearchReply, &calls)
	out := s.findDataTool(context.Background(), "what address blocks and records exist")
	if !strings.Contains(out, "/api/ddi/v1/ipam/address_block") || !strings.Contains(out, "Infoblox search") {
		t.Fatalf("want Infoblox's ranked matches, got %s", out)
	}
}

// The Sales account: every tools/call is 403. find_data still answers from the
// built-in list, and the refusal is remembered so later questions do not pay
// for it again.
func TestFindDataFallsBackAndRemembersARefusal(t *testing.T) {
	calls := 0
	s := fakeSearchMCP(t, http.StatusForbidden, "", &calls)
	for i := 0; i < 2; i++ {
		out := s.findDataTool(context.Background(), "how many zones")
		if !strings.Contains(out, "/api/ddi/v1/dns/auth_zone") {
			t.Fatalf("fallback missing: %s", out)
		}
	}
	if calls != 1 {
		t.Fatalf("Infoblox search was asked %d times after a 403, want 1", calls)
	}
}

func TestFindDataWithoutMCPUsesTheBuiltInList(t *testing.T) {
	s := &Service{}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if out := s.findDataTool(ctx, "how many zones"); !strings.Contains(out, "/api/ddi/v1/dns/auth_zone") {
		t.Fatalf("got %s", out)
	}
}
