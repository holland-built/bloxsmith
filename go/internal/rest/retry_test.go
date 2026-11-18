package rest

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// recordSleeps swaps the retry pause for one that records how long it was
// asked to wait, so the tests neither sleep nor guess.
func recordSleeps(t *testing.T) *[]time.Duration {
	t.Helper()
	var got []time.Duration
	old := retrySleep
	retrySleep = func(d time.Duration) { got = append(got, d) }
	t.Cleanup(func() { retrySleep = old })
	return &got
}

// flaky answers with fail (status, headers, body) for the first n calls, then 200.
func flaky(n int32, status int, hdr map[string]string, body string, calls *int32) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(calls, 1) <= n {
			for k, v := range hdr {
				w.Header().Set(k, v)
			}
			w.WriteHeader(status)
			w.Write([]byte(body))
			return
		}
		w.Write([]byte(`{"results":[{"id":"x"}]}`))
	}))
}

func TestGetRetriesOnceOn503(t *testing.T) {
	sleeps := recordSleeps(t)
	var calls int32
	srv := flaky(1, 503, nil, `{"error":"busy"}`, &calls)
	defer srv.Close()
	c := New(srv.URL, NewAuth("key", nil))

	_, status, err := c.GetEx("/x", nil)
	if err != nil || status != 200 || calls != 2 {
		t.Fatalf("GetEx: status=%d err=%v calls=%d, want 200, nil, 2", status, err, calls)
	}
	if len(*sleeps) != 1 || (*sleeps)[0] != retryPause {
		t.Fatalf("paused %v, want one pause of %v", *sleeps, retryPause)
	}

	calls = 0
	rows, err := c.GetStrict("/x", nil)
	if err != nil || len(rows) != 1 || calls != 2 {
		t.Fatalf("GetStrict: rows=%v err=%v calls=%d, want 1 row, nil, 2", rows, err, calls)
	}
}

func TestGetRetriesOnlyOnce(t *testing.T) {
	recordSleeps(t)
	for _, st := range []int{429, 500, 502, 503, 504} {
		var calls int32
		srv := flaky(99, st, nil, `{}`, &calls)
		c := New(srv.URL, NewAuth("key", nil))
		_, status, _ := c.GetEx("/x", nil)
		srv.Close()
		if status != st || calls != 2 {
			t.Fatalf("status %d: got status=%d calls=%d, want %d after exactly 2 calls", st, status, calls, st)
		}
	}
}

func TestGetNotRetriedOnOtherErrors(t *testing.T) {
	recordSleeps(t)
	for _, st := range []int{400, 401, 403, 404, 501} {
		var calls int32
		srv := flaky(99, st, nil, `{}`, &calls)
		c := New(srv.URL, NewAuth("key", nil))
		c.GetEx("/x", nil)
		srv.Close()
		if calls != 1 {
			t.Fatalf("status %d was asked %d times, want 1", st, calls)
		}
	}
}

func TestWriteNeverRetried(t *testing.T) {
	recordSleeps(t)
	for _, m := range []string{"POST", "PATCH", "PUT", "DELETE"} {
		var calls int32
		srv := flaky(1, 503, nil, `{}`, &calls)
		c := New(srv.URL, NewAuth("key", nil))
		_, status, _ := c.Write(m, "/x", map[string]any{"a": 1}, nil)
		srv.Close()
		if calls != 1 || status != 503 {
			t.Fatalf("%s: calls=%d status=%d, want one call answered 503", m, calls, status)
		}
	}
}

// Infoblox's 4 MiB gRPC cap answers 429 every time for the same request
// (dashboard/csp.go CSPExposedHostnames), so asking again only doubles the wait.
func TestSizeCap429NotRetried(t *testing.T) {
	sleeps := recordSleeps(t)
	const capBody = `{"error":[{"message":"grpc: trying to send message larger than max (6291456 vs. 4194304)"}]}`
	var calls int32
	srv := flaky(99, 429, nil, capBody, &calls)
	defer srv.Close()
	c := New(srv.URL, NewAuth("key", nil))

	_, status, _ := c.GetEx("/x", nil)
	if calls != 1 || status != 429 || len(*sleeps) != 0 {
		t.Fatalf("GetEx: calls=%d status=%d sleeps=%v, want one call, 429, no pause", calls, status, *sleeps)
	}

	calls = 0
	_, err := c.GetStrict("/x", nil)
	ue, _ := err.(*UpstreamError)
	if calls != 1 || ue == nil || ue.Status != 429 || !strings.Contains(ue.Snippet, "larger than max") {
		t.Fatalf("GetStrict: calls=%d err=%#v, want one call and the cap message kept in the snippet", calls, err)
	}
}

func TestRetryAfterHonouredAndCapped(t *testing.T) {
	for _, tc := range []struct {
		header string
		want   time.Duration
	}{
		{"2", 2 * time.Second},
		{"120", retryAfterCap},
		{"nonsense", retryPause},
	} {
		sleeps := recordSleeps(t)
		var calls int32
		srv := flaky(1, 429, map[string]string{"Retry-After": tc.header}, `{"error":"slow down"}`, &calls)
		c := New(srv.URL, NewAuth("key", nil))
		_, status, _ := c.GetEx("/x", nil)
		srv.Close()
		if status != 200 || calls != 2 {
			t.Fatalf("Retry-After %q: status=%d calls=%d, want 200 after 2 calls", tc.header, status, calls)
		}
		if len(*sleeps) != 1 || (*sleeps)[0] != tc.want {
			t.Fatalf("Retry-After %q: paused %v, want %v", tc.header, *sleeps, tc.want)
		}
	}
	if retryAfterCap > 5*time.Second {
		t.Fatalf("retryAfterCap = %v, want a few seconds at most", retryAfterCap)
	}
}

func TestGetRetriesOnceOnTimeout(t *testing.T) {
	recordSleeps(t)
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			time.Sleep(300 * time.Millisecond)
		}
		w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()
	c := New(srv.URL, NewAuth("key", nil))
	c.http = &http.Client{Timeout: 100 * time.Millisecond}

	_, status, err := c.GetEx("/x", nil)
	if err != nil || status != 200 || calls != 2 {
		t.Fatalf("status=%d err=%v calls=%d, want 200, nil, 2", status, err, calls)
	}
}
