package rest

import (
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// TestClient_PoolsIdleConnectionsAcrossBursts is the behavioural check on the
// raised MaxIdleConnsPerHost. Every call in this process goes to ONE host, and
// http.DefaultTransport keeps only 2 idle connections per host — so a fan-out
// wider than 2 (the /api/data aggregate now issues up to dashboardFanOut at
// once) closed the surplus connections the moment they went idle and paid a
// fresh TCP+TLS handshake on the next burst.
//
// The test fires two identical concurrent bursts through ONE Client and counts
// how many connections the server ever saw opened. If idle connections are
// pooled, the second burst reuses the first burst's and the total stays at one
// burst's width.
//
// Mutation that must turn this RED: drop the Transport from New (back to
// http.DefaultTransport, MaxIdleConnsPerHost=2) -> the second burst reopens
// most of its connections and the total roughly doubles.
func TestClient_PoolsIdleConnectionsAcrossBursts(t *testing.T) {
	const burstSize = 8

	var mu sync.Mutex
	opened := 0
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Hold each request long enough that the whole burst is genuinely in
		// flight together, forcing burstSize distinct connections on burst 1.
		time.Sleep(40 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			mu.Lock()
			opened++
			mu.Unlock()
		}
	}
	srv.Start()
	defer srv.Close()

	c := New(srv.URL, NewAuth("test-key", nil))

	burst := func() {
		var wg sync.WaitGroup
		gate := make(chan struct{})
		for range burstSize {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-gate
				if _, err := c.GetStrict("/api/thing", nil); err != nil {
					t.Errorf("GetStrict: %v", err)
				}
			}()
		}
		close(gate)
		wg.Wait()
	}

	burst()
	// Give the transport a moment to park the finished connections as idle.
	time.Sleep(50 * time.Millisecond)
	burst()

	mu.Lock()
	got := opened
	mu.Unlock()

	if got > burstSize {
		t.Fatalf("server saw %d connections opened across two bursts of %d, want <= %d — idle connections are not being pooled (MaxIdleConnsPerHost too low)",
			got, burstSize, burstSize)
	}
}
