package dashboard

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"bloxsmith/internal/cache"
)

// kentikReply is the 172.16.0.210 answer from the demo account on 2026-11-10,
// trimmed: a router exporting NetFlow and holding two BGP sessions.
func kentikReply(drop string) string {
	buckets := map[string]string{
		"out_total": `[{"key":"Total","avg_bits_per_sec":6298}]`,
		"in_total":  `[{"key":"Total","avg_bits_per_sec":52.44}]`,
		"out_top": `[{"inet_dst_addr":"10.67.70.10/32","i_protocol_name":"UDP (17)","l4_dst_port":9995,"avg_bits_per_sec":6212},
		             {"inet_dst_addr":"172.16.0.222/32","i_protocol_name":"TCP (6)","l4_dst_port":37939,"avg_bits_per_sec":52.44}]`,
		"in_top": `[{"inet_src_addr":"172.16.0.222/32","i_protocol_name":"TCP (6)","l4_dst_port":179,"avg_bits_per_sec":37.78}]`,
	}
	var parts []string
	for _, b := range kentikBuckets {
		if b == drop {
			continue
		}
		parts = append(parts, `{"bucket":"`+b+`","data":`+buckets[b]+`}`)
	}
	return `{"results":[` + strings.Join(parts, ",") + `]}`
}

func kentikService(t *testing.T, status int, body string, calls *int32) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(calls, 1)
		if r.Header.Get("X-CH-Auth-Email") != "ops@example.com" || r.Header.Get("X-CH-Auth-API-Token") != "tok" {
			t.Errorf("login headers not sent")
		}
		var req struct {
			Queries []map[string]any `json:"queries"`
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &req); err != nil || len(req.Queries) != 4 {
			t.Errorf("want one request with 4 queries, got %d (%v)", len(req.Queries), err)
		}
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return &Service{
		Cache:       cache.New(),
		KentikURL:   srv.URL,
		KentikCreds: func() (string, string) { return "ops@example.com", "tok" },
	}
}

func TestKentikTraffic_Loaded(t *testing.T) {
	var calls int32
	s := kentikService(t, 200, kentikReply(""), &calls)
	got := s.FetchKentikTraffic("172.16.0.210")
	if got["availability"] != "ok" || got["bps_out"] != 6298.0 || got["bps_in"] != 52.44 {
		t.Fatalf("totals wrong: %v", got)
	}
	rows := got["rows"].([]any)
	if len(rows) != 3 {
		t.Fatalf("want 3 conversations, got %d", len(rows))
	}
	first := rows[0].(map[string]any)
	if first["peer"] != "10.67.70.10" || first["direction"] != "out" {
		t.Fatalf("busiest first, without /32: %v", first)
	}
	// Second lookup comes from the cache: one Kentik request in all.
	s.FetchKentikTraffic("172.16.0.210")
	if calls != 1 {
		t.Fatalf("want 1 Kentik request for two lookups, got %d", calls)
	}
}

// A reply missing any of the four answers is a failed read, not zero traffic.
func TestKentikTraffic_PartialReplyIsAnError(t *testing.T) {
	var calls int32
	s := kentikService(t, 200, kentikReply("in_total"), &calls)
	got := s.FetchKentikTraffic("172.16.0.210")
	if got["availability"] != "error" {
		t.Fatalf("want error, got %v", got)
	}
	// Failures are not cached: the next lookup asks again.
	s.FetchKentikTraffic("172.16.0.210")
	if calls != 2 {
		t.Fatalf("a failure was cached: %d requests", calls)
	}
}

func TestKentikTraffic_RefusedLogin(t *testing.T) {
	var calls int32
	s := kentikService(t, 401, `{"error":"Unauthorized"}`, &calls)
	got := s.FetchKentikTraffic("172.16.0.210")
	if got["availability"] != "error" || !strings.Contains(got["reason"].(string), "Settings") {
		t.Fatalf("want error naming Settings, got %v", got)
	}
}

func TestKentikTraffic_NotSetUpAndLocked(t *testing.T) {
	s := &Service{Cache: cache.New()}
	got := s.FetchKentikTraffic("172.16.0.210")
	if got["availability"] != "unsupported" || !strings.Contains(got["reason"].(string), "Settings") {
		t.Fatalf("not set up: %v", got)
	}
	s.KentikCreds = func() (string, string) { return "", "" }
	s.KentikLocked = func() bool { return true }
	got = s.FetchKentikTraffic("172.16.0.210")
	if !strings.Contains(got["reason"].(string), "locked") {
		t.Fatalf("locked: %v", got)
	}
}

// A hostname never reaches Kentik.
func TestKentikTraffic_NotAnIP(t *testing.T) {
	var calls int32
	s := kentikService(t, 200, kentikReply(""), &calls)
	got := s.FetchKentikTraffic("app.example.com")
	if got["availability"] != "unsupported" || calls != 0 {
		t.Fatalf("hostname: %v, %d requests", got, calls)
	}
}
