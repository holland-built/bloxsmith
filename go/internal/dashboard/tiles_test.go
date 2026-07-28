package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/mcp"
)

func TestNormDNSSEC(t *testing.T) {
	raw := []any{
		map[string]any{"id": "z1", "fqdn": "a.com.", "view": "default",
			"dnssec_status": "signed", "dnssec_signing_policy": "default"},
		map[string]any{"id": "z2", "fqdn": "b.com.", "view": "default",
			"dnssec_status": "signed"},
		map[string]any{"fqdn": "c.com."}, // missing id/status/policy
	}
	rows, summary := normDNSSEC(raw)
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(rows))
	}
	if rows[0]["fqdn"] != "a.com." || rows[0]["dnssec_signing_policy"] != "default" {
		t.Errorf("row0 = %+v", rows[0])
	}
	if rows[2]["fqdn"] != "c.com." || rows[2]["dnssec_status"] != "" || rows[2]["id"] != "" {
		t.Errorf("row2 missing-field shaping = %+v", rows[2])
	}
	if summary["signed"] != 2 {
		t.Errorf("summary[signed] = %d, want 2", summary["signed"])
	}
	if summary[""] != 1 {
		t.Errorf("summary[\"\"] = %d, want 1", summary[""])
	}
}

func TestNormRPZ(t *testing.T) {
	raw := []any{
		map[string]any{"fqdn": "bad.example.", "comment": "malware feed", "disabled": false,
			"view": "default", "policy_override": "block", "severity": "high",
			"priority": "1", "type": "custom_list", "substituted_domain_name": ""},
		map[string]any{"fqdn": "partial.example."}, // missing everything else
	}
	rows := normRPZ(raw)
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if rows[0]["severity"] != "high" || rows[0]["disabled"] != false || rows[0]["policy_override"] != "block" {
		t.Errorf("row0 = %+v", rows[0])
	}
	if rows[1]["fqdn"] != "partial.example." || rows[1]["comment"] != "" || rows[1]["disabled"] != false {
		t.Errorf("row1 missing-field shaping = %+v", rows[1])
	}
}

func TestNormDtcLbdn(t *testing.T) {
	raw := []any{
		map[string]any{"name": "lbdn1", "view": "default", "dtc_policy": "policy1",
			"precedence": float64(10), "comment": "prod", "disabled": true, "ttl": float64(300), "tags": map[string]any{}},
		map[string]any{"name": "lbdn2"}, // missing everything else
	}
	rows := normDtcLbdn(raw)
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if rows[0]["precedence"] != 10 || rows[0]["ttl"] != 300 || rows[0]["disabled"] != true {
		t.Errorf("row0 = %+v", rows[0])
	}
	if rows[1]["name"] != "lbdn2" || rows[1]["precedence"] != 0 || rows[1]["disabled"] != false {
		t.Errorf("row1 missing-field shaping = %+v", rows[1])
	}
}

// --- scalar-count status derivation (drives the real s.scalarCount against a
// fake MCP endpoint, not a hand-copied stand-in) ----------------------------
//
// scalarCubeQueryText builds the wire body infoblox-portal_query_cube returns
// on a successful inline scalar query (see internal/mcp.TestQueryCubeInlineScalar
// for the real shape), carrying one row with the given measure value.
func scalarCubeQueryText(measure, value string) string {
	msg := "Query Result: [{'" + measure + "': '" + value + "'}]. If necessary, use query_stored_data tool for further analysis."
	b, _ := json.Marshal(map[string]string{"message": msg})
	return string(b)
}

// scalarCubeServer fakes the MCP endpoint scalarCount depends on: initialize
// always succeeds, and infoblox-portal_query_cube either returns queryText
// (queryOK) or fails the tool call outright with a transport-level error
// (!queryOK, mirroring the nil-rows QueryCube returns on any transport/parse
// failure — see internal/mcp.Client.QueryCube).
func scalarCubeServer(t *testing.T, queryText string, queryOK bool) *mcp.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
			ID     *int   `json:"id"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		switch req.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "test-session")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
		case "notifications/initialized":
			w.WriteHeader(http.StatusOK)
		case "tools/call":
			if !queryOK {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			resp := map[string]any{
				"jsonrpc": "2.0", "id": *req.ID,
				"result": map[string]any{
					"content": []map[string]any{{"text": queryText}},
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
		}
	}))
	t.Cleanup(srv.Close)
	return mcp.New(srv.URL, func() string { return "Bearer test" })
}

// TestScalarCount_RealTotal: the cube answers a genuine non-zero total ->
// status "ok" and the total is carried through.
func TestScalarCount_RealTotal(t *testing.T) {
	s := &Service{Mcp: scalarCubeServer(t, scalarCubeQueryText("AssetDiscoveryStatus.count", "319397"), true)}
	got := s.scalarCount(context.Background(), "AssetDiscoveryStatus", "AssetDiscoveryStatus.count", "unavailable upstream")
	if got["status"] != "ok" {
		t.Errorf("status = %v, want ok for a non-zero total", got["status"])
	}
	if got["total"] != 319397 {
		t.Errorf("total = %v, want 319397", got["total"])
	}
	if got["breakdown_available"] != false {
		t.Error("breakdown_available = true, want false")
	}
	if _, hasBuckets := got["buckets"]; hasBuckets {
		t.Error("buckets present, want no buckets key in the shape")
	}
}

// TestScalarCount_GenuineZero: the cube answers successfully with a real
// zero count -> status stays "empty", total 0. A genuine zero must remain
// legitimate, not get swept into "error".
func TestScalarCount_GenuineZero(t *testing.T) {
	s := &Service{Mcp: scalarCubeServer(t, scalarCubeQueryText("AssetDiscoveryStatus.count", "0"), true)}
	got := s.scalarCount(context.Background(), "AssetDiscoveryStatus", "AssetDiscoveryStatus.count", "unavailable upstream")
	if got["status"] != "empty" {
		t.Errorf("status = %v, want empty for a genuine zero total", got["status"])
	}
	if got["total"] != 0 {
		t.Errorf("total = %v, want 0", got["total"])
	}
}

// TestScalarCount_QueryFailureIsNotEmpty is the regression this fix closes:
// when the cube query itself fails (transport/parse failure -> QueryCube
// returns nil), scalarCount must report "error", never "empty" — a dead
// lookup is not the same fact as a tenant with zero assets.
func TestScalarCount_QueryFailureIsNotEmpty(t *testing.T) {
	s := &Service{Mcp: scalarCubeServer(t, "", false)}
	got := s.scalarCount(context.Background(), "AssetDiscoveryStatus", "AssetDiscoveryStatus.count", "unavailable upstream")
	if got["status"] != "error" {
		t.Errorf("status = %v, want error for a failed cube query", got["status"])
	}
	if got["status"] == "empty" {
		t.Fatal(`status = "empty": a failed query must not be reported as a genuine zero`)
	}
}

// TestScalarCount_McpInitFailure pins existing behavior: an unusable MCP
// client (nil, matching production's s.Mcp == nil guard) yields "error"
// before any query is attempted.
func TestScalarCount_McpInitFailure(t *testing.T) {
	s := &Service{}
	got := s.scalarCount(context.Background(), "AssetDiscoveryStatus", "AssetDiscoveryStatus.count", "unavailable upstream")
	if got["status"] != "error" {
		t.Errorf("status = %v, want error when Mcp is unset", got["status"])
	}
}
