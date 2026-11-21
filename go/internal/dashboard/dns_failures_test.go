package dashboard

import (
	"net/http"
	"sync"
	"testing"
	"time"
)

// friday is when the panel was checked on the demo tenant: Friday 2026-11-20,
// 23:53 UTC, in a week that began on Monday 2026-11-16.
var friday = time.Date(2026, 11, 20, 23, 53, 0, 0, time.UTC)

func TestDNSFailureSource_EachWindow(t *testing.T) {
	want := map[string]string{
		"today":        srcFailureRecords,
		"yesterday":    srcFailureRecords,
		"this week":    srcQueryLogs,
		"last 30 days": srcQueryLogs,
	}
	for w, src := range want {
		if got := dnsFailureSource(w, friday); got != src {
			t.Errorf("%s on a Friday: source %s, want %s", w, got, src)
		}
	}
}

// "This week" starts Monday 00:00 UTC, so it fits in the failure records'
// 72 hours until Thursday 00:00 exactly, and not a second after.
func TestDNSFailureSource_72HourBoundary(t *testing.T) {
	thursday := time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)
	if got := dnsFailureSource("this week", thursday); got != srcFailureRecords {
		t.Errorf("this week at exactly 72 hours: %s, want failure records", got)
	}
	if got := dnsFailureSource("this week", thursday.Add(time.Second)); got != srcQueryLogs {
		t.Errorf("this week one second past 72 hours: %s, want query logs", got)
	}
	monday := time.Date(2026, 11, 16, 9, 0, 0, 0, time.UTC)
	if got := dnsFailureSource("this week", monday); got != srcFailureRecords {
		t.Errorf("this week on a Monday: %s, want failure records", got)
	}
	sunday := time.Date(2026, 11, 22, 1, 0, 0, 0, time.UTC)
	if s := dnsFailureWindowStart("this week", sunday); !s.Equal(time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("this week on a Sunday starts %v, want the Monday before", s)
	}
	// Yesterday late in the day is still under 48 hours back.
	if got := dnsFailureSource("yesterday", time.Date(2026, 11, 20, 23, 59, 59, 0, time.UTC)); got != srcFailureRecords {
		t.Errorf("yesterday at 23:59: %s, want failure records", got)
	}
}

// failuresServer answers the by-code read with codes and the names read with
// names; a body of "500" fails that read.
func failuresServer(t *testing.T, codes, names string) (*Service, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	seen := []map[string]any{}
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cubejs/v1/query" {
			t.Errorf("unexpected path %s", r.URL.Path)
			return
		}
		q := cubeQueryFromRequest(t, r)
		mu.Lock()
		seen = append(seen, q)
		mu.Unlock()
		body := codes
		if dims := q["dimensions"].([]any); len(dims) == 1 && (dims[0] == cubeFailedDNS+".qname" || dims[0] == cubeQueryLogs+".qname") {
			body = names
		}
		if body == "500" {
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	})
	return s, &seen
}

func atTime(t *testing.T, now time.Time) {
	t.Helper()
	old := dnsFailuresNow
	dnsFailuresNow = func() time.Time { return now }
	t.Cleanup(func() { dnsFailuresNow = old })
}

const rawCodes = `{"result":{"data":[
 {"NetworkInsightsDnsRawLogsV1.rcode":"3","NetworkInsightsDnsRawLogsV1.failedTransactionCount":"532584"},
 {"NetworkInsightsDnsRawLogsV1.rcode":"5","NetworkInsightsDnsRawLogsV1.failedTransactionCount":"6460"},
 {"NetworkInsightsDnsRawLogsV1.rcode":"2","NetworkInsightsDnsRawLogsV1.failedTransactionCount":"315"},
 {"NetworkInsightsDnsRawLogsV1.rcode":"9","NetworkInsightsDnsRawLogsV1.failedTransactionCount":"12"},
 {"NetworkInsightsDnsRawLogsV1.rcode":"1","NetworkInsightsDnsRawLogsV1.failedTransactionCount":"3"}]}}`

const rawNames = `{"result":{"data":[
 {"NetworkInsightsDnsRawLogsV1.qname":"a.example.","NetworkInsightsDnsRawLogsV1.failedTransactionCount":"390793"},
 {"NetworkInsightsDnsRawLogsV1.qname":"b.example.","NetworkInsightsDnsRawLogsV1.failedTransactionCount":"67861"}]}}`

func TestCSPDNSFailures_TodayReadsFailureRecords(t *testing.T) {
	atTime(t, friday)
	s, seen := failuresServer(t, rawCodes, rawNames)
	got := s.CSPDNSFailures("today")
	if got["status"] != "ok" || got["source"] != srcFailureRecords || got["window"] != "today" {
		t.Fatalf("got %v", got)
	}
	// Added up, not averaged: 532584+6460+315+12+3.
	if got["total"] != 539374.0 {
		t.Errorf("total = %v, want 539374", got["total"])
	}
	c := got["codes"].(map[string]any)
	if c["nxdomain"] != 532584.0 || c["refused"] != 6460.0 || c["servfail"] != 315.0 || c["other"] != 15.0 {
		t.Errorf("codes = %v", c)
	}
	names := got["names"].([]map[string]any)
	if len(names) != 2 || names[0]["name"] != "a.example." || names[0]["count"] != 390793.0 {
		t.Errorf("names = %v", names)
	}
	if len(*seen) != 2 {
		t.Fatalf("reads = %d, want 2", len(*seen))
	}
	for _, q := range *seen {
		if q["filters"] != nil {
			t.Errorf("failure records need no filter (they hold failures only): %v", q["filters"])
		}
		td := q["timeDimensions"].([]any)[0].(map[string]any)
		if td["dimension"] != cubeFailedDNS+".timestamp" || td["dateRange"] != "today" {
			t.Errorf("timeDimension = %v", td)
		}
		if q["measures"].([]any)[0] != cubeFailedDNS+".failedTransactionCount" {
			t.Errorf("measures = %v", q["measures"])
		}
		if dims := q["dimensions"].([]any); dims[0] == cubeFailedDNS+".qname" && q["limit"] != 10.0 {
			t.Errorf("names read limit = %v, want 10", q["limit"])
		}
	}
}

func TestCSPDNSFailures_Last30DaysReadsQueryLogs(t *testing.T) {
	atTime(t, friday)
	codes := `{"result":{"data":[{"DnsActivityV1.rcode":"3","DnsActivityV1.total_query_count":"9281203"},{"DnsActivityV1.rcode":"2","DnsActivityV1.total_query_count":"113307"}]}}`
	names := `{"result":{"data":[{"DnsActivityV1.qname":"a.example.","DnsActivityV1.total_query_count":"5560300"}]}}`
	s, seen := failuresServer(t, codes, names)
	got := s.CSPDNSFailures("last 30 days")
	if got["source"] != srcQueryLogs || got["total"] != 9394510.0 {
		t.Fatalf("got source %v total %v", got["source"], got["total"])
	}
	if c := got["codes"].(map[string]any); c["refused"] != 0.0 || c["other"] != 0.0 {
		t.Errorf("a code with no rows in a good read is a real 0: %v", c)
	}
	for _, q := range *seen {
		f := q["filters"].([]any)
		if len(f) != 1 {
			t.Fatalf("filters = %v", f)
		}
		m := f[0].(map[string]any)
		if m["member"] != cubeQueryLogs+".rcode" || m["operator"] != "notEquals" || m["values"].([]any)[0] != "0" {
			t.Errorf("query logs filter = %v, want rcode notEquals 0", m)
		}
		if q["measures"].([]any)[0] != cubeQueryLogs+".total_query_count" {
			t.Errorf("measures = %v", q["measures"])
		}
	}
}

func TestCSPDNSFailures_FailedReadIsNotChecked(t *testing.T) {
	atTime(t, friday)
	s, _ := failuresServer(t, "500", rawNames)
	got := s.CSPDNSFailures("today")
	if got["status"] != "error" || got["total"] != nil || got["codes_status"] != "error" {
		t.Fatalf("got %v, want error with a null total", got)
	}
	for k, v := range got["codes"].(map[string]any) {
		if v != nil {
			t.Errorf("codes[%s] = %v, want null", k, v)
		}
	}
}

func TestCSPDNSFailures_200WithoutResultDataIsNotChecked(t *testing.T) {
	atTime(t, friday)
	s, _ := failuresServer(t, `{"error":"Continue wait"}`, `{"result":{}}`)
	got := s.CSPDNSFailures("yesterday")
	if got["status"] != "error" || got["total"] != nil || got["names"] != nil || got["names_status"] != "error" {
		t.Fatalf("got %v", got)
	}
}

func TestCSPDNSFailures_NamesFailOnlyIsPartial(t *testing.T) {
	atTime(t, friday)
	s, _ := failuresServer(t, rawCodes, "500")
	got := s.CSPDNSFailures("today")
	if got["status"] != "partial" || got["total"] != 539374.0 || got["names"] != nil {
		t.Fatalf("got %v", got)
	}
}

// A row without a count makes its group and the total unknown, never 0.
func TestCSPDNSFailures_MissingMeasureIsUnknown(t *testing.T) {
	atTime(t, friday)
	codes := `{"result":{"data":[{"NetworkInsightsDnsRawLogsV1.rcode":"3","NetworkInsightsDnsRawLogsV1.failedTransactionCount":"10"},{"NetworkInsightsDnsRawLogsV1.rcode":"2","NetworkInsightsDnsRawLogsV1.failedTransactionCount":null}]}}`
	names := `{"result":{"data":[{"NetworkInsightsDnsRawLogsV1.qname":"a.example."}]}}`
	s, _ := failuresServer(t, codes, names)
	got := s.CSPDNSFailures("today")
	c := got["codes"].(map[string]any)
	if got["total"] != nil || c["servfail"] != nil || c["nxdomain"] != 10.0 {
		t.Errorf("total %v codes %v, want null total and null servfail", got["total"], c)
	}
	if n := got["names"].([]map[string]any); n[0]["count"] != nil {
		t.Errorf("name without a count = %v, want null", n[0]["count"])
	}
}

// No rows can mean nothing failed or that DNS logging sent nothing, so the
// total and every group are unknown, never 0.
func TestCSPDNSFailures_NoRowsIsCouldntTell(t *testing.T) {
	atTime(t, friday)
	s, _ := failuresServer(t, `{"result":{"data":[]}}`, `{"result":{"data":[]}}`)
	got := s.CSPDNSFailures("today")
	if got["status"] != "empty" || got["codes_status"] != "ok" || got["total"] != nil {
		t.Fatalf("got %v, want empty with a null total", got)
	}
	for k, v := range got["codes"].(map[string]any) {
		if v != nil {
			t.Errorf("codes[%s] = %v, want null", k, v)
		}
	}
}

// A row whose code cannot be read could belong to any group, so all four
// groups and the total are unknown.
func TestCSPDNSFailures_UnreadableCodeIsCouldntTell(t *testing.T) {
	for name, rcode := range map[string]string{
		"missing": ``,
		"null":    `"NetworkInsightsDnsRawLogsV1.rcode":null,`,
		"blank":   `"NetworkInsightsDnsRawLogsV1.rcode":"",`,
		"words":   `"NetworkInsightsDnsRawLogsV1.rcode":"NXDOMAIN",`,
		"nan":     `"NetworkInsightsDnsRawLogsV1.rcode":"NaN",`,
		"part":    `"NetworkInsightsDnsRawLogsV1.rcode":"2.5",`,
	} {
		t.Run(name, func(t *testing.T) {
			atTime(t, friday)
			codes := `{"result":{"data":[{"NetworkInsightsDnsRawLogsV1.rcode":"3","NetworkInsightsDnsRawLogsV1.failedTransactionCount":"10"},{` + rcode + `"NetworkInsightsDnsRawLogsV1.failedTransactionCount":"4"}]}}`
			s, _ := failuresServer(t, codes, rawNames)
			got := s.CSPDNSFailures("today")
			if got["total"] != nil {
				t.Errorf("total = %v, want null", got["total"])
			}
			for k, v := range got["codes"].(map[string]any) {
				if v != nil {
					t.Errorf("codes[%s] = %v, want null", k, v)
				}
			}
		})
	}
}

// A code that reads fine but is not 2, 3 or 5 is still Other.
func TestCSPDNSFailures_ReadableOtherCodeStaysOther(t *testing.T) {
	atTime(t, friday)
	codes := `{"result":{"data":[{"NetworkInsightsDnsRawLogsV1.rcode":"9","NetworkInsightsDnsRawLogsV1.failedTransactionCount":"7"}]}}`
	s, _ := failuresServer(t, codes, rawNames)
	got := s.CSPDNSFailures("today")
	if c := got["codes"].(map[string]any); c["other"] != 7.0 || got["total"] != 7.0 {
		t.Errorf("total %v codes %v, want Other 7", got["total"], c)
	}
}

func TestValidDNSFailureWindow(t *testing.T) {
	for _, w := range DNSFailureWindows {
		if !ValidDNSFailureWindow(w) {
			t.Errorf("%q refused", w)
		}
	}
	for _, w := range []string{"", "Today", "last 7 days", "this month", "today "} {
		if ValidDNSFailureWindow(w) {
			t.Errorf("%q accepted", w)
		}
	}
}
