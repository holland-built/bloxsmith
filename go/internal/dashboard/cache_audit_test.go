package dashboard

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"
)

// slowCounting answers every request after delay with one generic row, and
// records how many were in flight at once (probe, concurrency_test.go).
func slowCounting(p *probe, delay time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p.enter(r.URL.Path)
		defer p.leave()
		time.Sleep(delay)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[{"id":"x1","display_name":"h"}],"result":{"data":[]},"insightList":[]}`))
	}
}

// TestTileSubCallsRunAtOnce: the five reads that used to make their upstream
// calls one after another now have them all in flight together. Before, the
// peak was 1 for every one of them.
func TestTileSubCallsRunAtOnce(t *testing.T) {
	cases := []struct {
		name string
		want int
		run  func(s *Service)
	}{
		{"CSPCtemAssets", 4, func(s *Service) { s.CSPCtemAssets() }},
		{"CSPCtemExposure", 3, func(s *Service) { s.CSPCtemExposure() }},
		{"CSPLicenseAlerts", 2, func(s *Service) { s.CSPLicenseAlerts() }},
		{"FetchDNSAnalytics", 3, func(s *Service) { s.FetchDNSAnalytics(context.Background()) }},
		{"FetchHostMetrics", 3, func(s *Service) { s.FetchHostMetrics(context.Background()) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := newProbe()
			s, _ := newRestTestService(t, slowCounting(p, 80*time.Millisecond))
			tc.run(s)
			peak, total := p.peakAndTotal()
			if total != tc.want {
				t.Fatalf("%d upstream calls, want %d", total, tc.want)
			}
			if peak != tc.want {
				t.Fatalf("peak in flight = %d, want all %d at once", peak, tc.want)
			}
		})
	}
}

// TestGetSetCachesCollapseColdCallers: four cold callers of a Get/SetGen cache
// (two tabs and two users opening Security together) now make one upstream
// fetch between them. Before, each missed the cache and fetched.
func TestGetSetCachesCollapseColdCallers(t *testing.T) {
	cases := []struct {
		name string
		run  func(s *Service)
	}{
		{"FetchHubHealth", func(s *Service) { s.FetchHubHealth() }},
		{"FetchServiceInventory", func(s *Service) { s.FetchServiceInventory() }},
		{"FetchInsights", func(s *Service) { s.FetchInsights() }},
		{"FetchHubSecurity", func(s *Service) { s.FetchHubSecurity(3600, 50) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := newProbe()
			s, _ := newRestTestService(t, slowCounting(p, 80*time.Millisecond))
			var wg sync.WaitGroup
			for range 4 {
				wg.Add(1)
				go func() { defer wg.Done(); tc.run(s) }()
			}
			wg.Wait()
			if _, total := p.peakAndTotal(); total != 1 {
				t.Fatalf("4 cold callers made %d upstream calls, want 1", total)
			}
		})
	}
}

// TestRunCubeQueryStatuses guards the merge of the two copies of the query
// run (RunChart and RunAnyChart): both must still report an upstream failure as
// "error" (not cached) and a zero-row answer as "empty".
func TestRunCubeQueryStatuses(t *testing.T) {
	failing := true
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if failing {
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[]}}`))
	})
	q := map[string]any{"measures": []string{"X.count"}}
	if got := s.runCubeQuery("k", s.Cache.Gen(), q, cubeEndpoint, []byte(`{}`)); got["status"] != "error" {
		t.Fatalf("failed query: status %v, want error", got["status"])
	}
	if _, ok := s.Cache.Get("k"); ok {
		t.Fatal("a failed query was cached")
	}
	failing = false
	if got := s.runCubeQuery("k", s.Cache.Gen(), q, cubeEndpoint, []byte(`{}`)); got["status"] != "empty" {
		t.Fatalf("zero rows: status %v, want empty", got["status"])
	}
	if _, ok := s.Cache.Get("k"); !ok {
		t.Fatal("an empty answer was not cached")
	}
}

// TestCubeSecurityFallbackIsRemembered: once the security service fails where
// the main one answers, later queries go to the main one only. If the main one
// then fails, the security service is asked after all, and its answer ends the
// window.
func TestCubeSecurityFallbackIsRemembered(t *testing.T) {
	var mu sync.Mutex
	calls := map[string]int{}
	secDown, mainDown := true, false
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls[r.URL.Path]++
		fail := (r.URL.Path == cubeSecurityEndpoint && secDown) || (r.URL.Path == cubeEndpoint && mainDown)
		mu.Unlock()
		if fail {
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[]}}`))
	})
	for range 3 {
		if _, st, err := s.cubeGet(cubeSecurityEndpoint, []byte(`{}`)); errored(st, err) {
			t.Fatalf("query failed: %d %v", st, err)
		}
	}
	if calls[cubeSecurityEndpoint] != 1 || calls[cubeEndpoint] != 3 {
		t.Fatalf("calls = %v, want security 1 then main only (3)", calls)
	}
	mu.Lock()
	secDown, mainDown = false, true
	mu.Unlock()
	if _, st, err := s.cubeGet(cubeSecurityEndpoint, []byte(`{}`)); errored(st, err) {
		t.Fatalf("main down, security back: query failed: %d %v", st, err)
	}
	mu.Lock()
	mainDown = false
	mu.Unlock()
	s.cubeGet(cubeSecurityEndpoint, []byte(`{}`))
	if calls[cubeSecurityEndpoint] != 3 || calls[cubeEndpoint] != 4 {
		t.Fatalf("calls = %v, want the answering security service tried first again (security 3, main 4)", calls)
	}
}

// TestCubeSecurityFallbackIsPerQuery: the security service refusing query A
// must not send query B to the main service, which may answer B with no rows
// where the security service has data.
func TestCubeSecurityFallbackIsPerQuery(t *testing.T) {
	var mu sync.Mutex
	var order []string
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		mu.Lock()
		order = append(order, r.URL.Path+" "+q)
		mu.Unlock()
		if r.URL.Path == cubeSecurityEndpoint && q == `{"q":"A"}` {
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[]}}`))
	})
	s.cubeGet(cubeSecurityEndpoint, []byte(`{"q":"A"}`))
	mu.Lock()
	order = nil
	mu.Unlock()
	s.cubeGet(cubeSecurityEndpoint, []byte(`{"q":"B"}`))
	if len(order) == 0 || order[0] != cubeSecurityEndpoint+` {"q":"B"}` {
		t.Fatalf("query B went %v, want the security service first", order)
	}
}
