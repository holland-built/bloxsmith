package dashboard

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"bloxsmith/internal/rest"
)

// auditTenant answers the audit log the way the live one did when probed: no
// total, at most 1000 rows a page, paged with _offset. It holds rows rows. By
// the cspAuditMachine rule, "someone@example.com" (every tenth) and "admin"
// (every tenth) are people and "test.user@example.com" (every twentieth) is
// not. Every fiftieth failed, every hundredth has no code. A filter carrying
// the people clauses is answered with the people rows only.
func auditTenant(t *testing.T, rows int, filters *[]string) (*httptest.Server, *int32) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		q := r.URL.Query()
		if r.Method != http.MethodGet || r.URL.Path != "/api/auditlog/v1/logs" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if filters != nil && q.Get("_offset") == "0" && !strings.Contains(q.Get("_filter"), "not user_name~") {
			*filters = append(*filters, q.Get("_filter"))
		}
		limit, _ := strconv.Atoi(q.Get("_limit"))
		if limit > 1000 {
			w.WriteHeader(400)
			return
		}
		off, _ := strconv.Atoi(q.Get("_offset"))
		user := func(i int) string {
			switch {
			case i%10 == 0:
				return "someone@example.com"
			case i%10 == 1:
				return "admin"
			case i%20 == 2:
				return "test.user@example.com"
			}
			return "service.dhcp"
		}
		ids := make([]int, 0, rows)
		for i := 0; i < rows; i++ {
			if strings.Contains(q.Get("_filter"), "not user_name~") {
				u, machine := user(i), false
				for _, p := range cspAuditMachine {
					machine = machine || strings.Contains(u, p)
				}
				if machine {
					continue
				}
			}
			ids = append(ids, i)
		}
		var b strings.Builder
		b.WriteString(`{"page":null,"results":[`)
		for n := off; n < len(ids) && n < off+limit; n++ {
			i := ids[n]
			if n > off {
				b.WriteByte(',')
			}
			code := `,"http_code":200`
			if i%50 == 1 {
				code = `,"http_code":500`
			}
			if i%100 == 3 {
				code = ""
			}
			fmt.Fprintf(&b, `{"user_name":%q%s}`, user(i), code)
		}
		b.WriteString(`]}`)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(b.String()))
	}))
	return srv, &calls
}

// More than 500 rows in 24 hours are all counted, not just the newest 500.
func TestCSPAuditCountReadsTheWholeDay(t *testing.T) {
	var filters []string
	srv, _ := auditTenant(t, 3412, &filters)
	defer srv.Close()
	now := time.Date(2026, 11, 25, 15, 23, 0, 0, time.UTC)
	out := (&Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil))}).CSPAuditCount(context.Background(), now)
	want := map[string]any{"status": "ok", "total": 3412, "people": 684, "failed": 69, "no_result": 35, "complete": true}
	for k, v := range want {
		if out[k] != v {
			t.Fatalf("%s = %v, want %v (all: %v)", k, out[k], v, out)
		}
	}
	if len(filters) != 1 || filters[0] != `created_at>="2026-11-24T15:23:00Z" and created_at<="2026-11-25T15:23:00Z"` {
		t.Fatalf("window filter = %q", filters)
	}
}

// A tenant past the ceiling stops there and says the count is incomplete, with
// the whole 24-hour window kept.
func TestCSPAuditCountStopsAtTheCeiling(t *testing.T) {
	srv, calls := auditTenant(t, auditCountCeiling*3, nil)
	defer srv.Close()
	out := (&Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil))}).CSPAuditCount(context.Background(), time.Now())
	if out["status"] != "ok" || out["complete"] != false || out["stopped_by"] != "ceiling" || out["total"] != auditCountCeiling {
		t.Fatalf("got %v", out)
	}
	// Two reads (all rows, and people), each stopping at the ceiling plus one proof row.
	if n := int(atomic.LoadInt32(calls)); n > 2*(auditCountCeiling/auditCountPage+auditCountWorkers+1) {
		t.Fatalf("read %d pages past a ceiling of %d rows", n, auditCountCeiling)
	}
}

// A refused or failed read is not checked, never a 0.
func TestCSPAuditCountFailureIsNotZero(t *testing.T) {
	for code, denied := range map[int]bool{403: true, 500: false} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) }))
		out := (&Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil))}).CSPAuditCount(context.Background(), time.Now())
		srv.Close()
		if out["status"] != "error" || out["total"] != nil {
			t.Fatalf("%d: got %v", code, out)
		}
		if (out["permission_denied"] == true) != denied {
			t.Fatalf("%d: permission_denied wrong: %v", code, out)
		}
	}
}

// Exactly the ceiling, with nothing after it, is the whole count; one row more
// is proven by reading it, and only then is it "more than".
func TestCSPAuditCountCeilingNeedsProof(t *testing.T) {
	for rows, more := range map[int]bool{auditCountCeiling: false, auditCountCeiling + 1: true} {
		srv, _ := auditTenant(t, rows, nil)
		out := (&Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil))}).CSPAuditCount(context.Background(), time.Now())
		srv.Close()
		if out["status"] != "ok" || out["total"] != auditCountCeiling || out["complete"] != !more || out["more"] != more {
			t.Fatalf("%d rows: got %v", rows, out)
		}
	}
}

// A refused page wins over another page running out of time: not checked.
func TestCSPAuditCountRefusalBeatsTimeout(t *testing.T) {
	old := auditCountBudget
	auditCountBudget = 300 * time.Millisecond
	defer func() { auditCountBudget = old }()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("_offset") {
		case "0":
			var b strings.Builder
			b.WriteString(`{"results":[`)
			for i := 0; i < auditCountPage; i++ {
				if i > 0 {
					b.WriteByte(',')
				}
				b.WriteString(`{"user_name":"service.x","http_code":200}`)
			}
			b.WriteString(`]}`)
			_, _ = w.Write([]byte(b.String()))
		case "1000":
			w.WriteHeader(403)
		default:
			select {
			case <-r.Context().Done():
			case <-time.After(2 * time.Second):
			}
			_, _ = w.Write([]byte(`{"results":[]}`))
		}
	}))
	defer srv.Close()
	out := (&Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil))}).CSPAuditCount(context.Background(), time.Now())
	if out["status"] != "error" || out["permission_denied"] != true {
		t.Fatalf("got %v", out)
	}
}

// A 200 whose results are missing or null is not an empty day.
func TestCSPAuditCountBadBodyIsNotZero(t *testing.T) {
	for _, body := range []string{`{}`, `{"results":null}`, `{"results":{}}`, `[]`} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) }))
		out := (&Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil))}).CSPAuditCount(context.Background(), time.Now())
		srv.Close()
		if out["status"] != "error" {
			t.Fatalf("%s: got %v", body, out)
		}
	}
}

// The total read and the people read share one limit: never more than
// auditCountWorkers requests at the audit log at once, ceiling probe included.
func TestCSPAuditCountSharesOneRequestLimit(t *testing.T) {
	var inFlight, most int32
	page := `{"results":[` + strings.TrimSuffix(strings.Repeat(`{"user_name":"a@b.c","http_code":200},`, auditCountPage), ",") + `]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&inFlight, 1)
		defer atomic.AddInt32(&inFlight, -1)
		for {
			m := atomic.LoadInt32(&most)
			if n <= m || atomic.CompareAndSwapInt32(&most, m, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		off, _ := strconv.Atoi(r.URL.Query().Get("_offset"))
		if off >= auditCountCeiling {
			_, _ = w.Write([]byte(`{"results":[]}`))
			return
		}
		_, _ = w.Write([]byte(page))
	}))
	defer srv.Close()
	out := (&Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil))}).CSPAuditCount(context.Background(), time.Now())
	if out["status"] != "ok" || out["total"] != auditCountCeiling {
		t.Fatalf("got %v", out)
	}
	if m := atomic.LoadInt32(&most); m > auditCountWorkers {
		t.Fatalf("%d requests at once, limit %d", m, auditCountWorkers)
	}
}
