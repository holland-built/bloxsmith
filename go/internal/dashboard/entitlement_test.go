package dashboard

// Covers the 403 entitlement backoff on the three attack-surface feeds
// (CSPExposures / CSPExposedHostnames / CSPExposedIPs). An account without the
// Attack Surface licence gets a permanent 403 from upstream; before this
// existed the minute-cycle UI poll re-asked and re-logged it forever —
// 14,529 of the 21,103 lines in a real bloxsmith.err.log were exactly this.
// The contract: first 403 hits upstream and logs, repeats within the window
// answer locally without an upstream call, an account switch (cache.Rotate)
// clears the memory because the next tenant may hold the licence.

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// newCountingService wires a Service to an upstream fake that always answers
// with the given status, counting how many requests actually arrive.
func newCountingService(t *testing.T, status int, body string) (*Service, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return New(rest.New(srv.URL, rest.NewAuth("test-key", nil)), cache.New()), &hits
}

const notAuthBody = `{"error":[{"message":"you are not authorized to use this feature"}]}`

func TestExposures403_SecondCallAnswersLocally(t *testing.T) {
	s, hits := newCountingService(t, http.StatusForbidden, notAuthBody)

	first := s.CSPExposures()
	if first["availability"] != "error" {
		t.Fatalf("first availability = %v, want error", first["availability"])
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("upstream hits after first call = %d, want 1", got)
	}

	second := s.CSPExposures()
	if second["availability"] != "error" {
		t.Fatalf("second availability = %v, want error", second["availability"])
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("upstream hits after second call = %d, want 1 (backoff must answer locally)", got)
	}
	reason, _ := second["reason"].(string)
	if reason == "" {
		t.Fatalf("backoff answer must still carry a reason")
	}
}

func TestExposures403_BackoffIsPerEndpoint(t *testing.T) {
	s, hits := newCountingService(t, http.StatusForbidden, notAuthBody)

	_ = s.CSPExposures()
	_ = s.CSPExposedHostnames()
	_ = s.CSPExposedIPs()
	if got := hits.Load(); got != 3 {
		t.Fatalf("upstream hits = %d, want 3 (each endpoint probes once)", got)
	}
	_ = s.CSPExposures()
	_ = s.CSPExposedHostnames()
	_ = s.CSPExposedIPs()
	if got := hits.Load(); got != 3 {
		t.Fatalf("upstream hits after repeat round = %d, want still 3", got)
	}
}

func TestExposures403_AccountSwitchRetries(t *testing.T) {
	s, hits := newCountingService(t, http.StatusForbidden, notAuthBody)

	_ = s.CSPExposures()
	_ = s.CSPExposures()
	if got := hits.Load(); got != 1 {
		t.Fatalf("upstream hits before switch = %d, want 1", got)
	}

	// An account switch rotates the shared cache (account.go:216); the next
	// tenant may be licensed, so the 403 memory must not outlive it.
	s.Cache.Rotate()

	_ = s.CSPExposures()
	if got := hits.Load(); got != 2 {
		t.Fatalf("upstream hits after Rotate = %d, want 2 (must re-probe for the new tenant)", got)
	}
}

func TestExposuresNon403_NeverBacksOff(t *testing.T) {
	s, hits := newCountingService(t, http.StatusBadGateway, `{}`)

	_ = s.CSPExposures()
	_ = s.CSPExposures()
	if got := hits.Load(); got != 2 {
		t.Fatalf("upstream hits = %d, want 2 (a 502 is transient — every poll must retry)", got)
	}
}

func TestExposedHostnames429_NeverBacksOff(t *testing.T) {
	// The 4 MiB gRPC-cap 429 (see CSPExposedHostnames' comment) is upstream
	// rate/size pressure, not a licence verdict — polls must keep trying.
	s, hits := newCountingService(t, http.StatusTooManyRequests, `{}`)

	_ = s.CSPExposedHostnames()
	_ = s.CSPExposedHostnames()
	if got := hits.Load(); got != 2 {
		t.Fatalf("upstream hits = %d, want 2", got)
	}
}

func TestZeroValueService_SkipsBackoffWithoutPanic(t *testing.T) {
	// Several tests build &Service{} literals without New(); the backoff must
	// degrade to "no backoff" there, never nil-panic.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(notAuthBody))
	}))
	defer srv.Close()
	s := &Service{Rest: rest.New(srv.URL, rest.NewAuth("test-key", nil))}

	got := s.CSPExposures()
	if got["availability"] != "error" {
		t.Fatalf("availability = %v, want error", got["availability"])
	}
	// And a second call must not panic either (it just probes again).
	_ = s.CSPExposures()
}
