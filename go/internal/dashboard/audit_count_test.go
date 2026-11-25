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
// total, at most 1000 rows a page, paged with _offset. It holds rows rows; every
// tenth is by a person, every fiftieth failed, every hundredth has no code.
func auditTenant(t *testing.T, rows int, filters *[]string) (*httptest.Server, *int32) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		q := r.URL.Query()
		if r.Method != http.MethodGet || r.URL.Path != "/api/auditlog/v1/logs" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if filters != nil && q.Get("_offset") == "0" {
			*filters = append(*filters, q.Get("_filter"))
		}
		limit, _ := strconv.Atoi(q.Get("_limit"))
		if limit > 1000 {
			w.WriteHeader(400)
			return
		}
		off, _ := strconv.Atoi(q.Get("_offset"))
		var b strings.Builder
		b.WriteString(`{"page":null,"results":[`)
		for i := off; i < rows && i < off+limit; i++ {
			if i > off {
				b.WriteByte(',')
			}
			user, code := "service.dhcp", `,"http_code":200`
			if i%10 == 0 {
				user = "someone@example.com"
			}
			if i%50 == 1 {
				code = `,"http_code":500`
			}
			if i%100 == 3 {
				code = ""
			}
			fmt.Fprintf(&b, `{"user_name":%q%s}`, user, code)
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
	want := map[string]any{"status": "ok", "total": 3412, "people": 342, "failed": 69, "no_result": 35, "complete": true}
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
	if n := int(atomic.LoadInt32(calls)); n > auditCountCeiling/auditCountPage+auditCountWorkers {
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
