package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"sync/atomic"
	"testing"
)

// roundTrip marshals v and reads it back, so assertions see what the wire
// sees ([]any and float64) rather than the Go types that built it.
func roundTrip(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// --- BuildChartQuery ----------------------------------------------------

// TestBuildChartQuery_EveryAllowedCombination walks the whole allow-list and
// checks each pick builds the query its cube needs. The expectations are
// written out here rather than derived from chartCatalog, so a catalog typo
// fails a test instead of being copied into it.
func TestBuildChartQuery_EveryAllowedCombination(t *testing.T) {
	measures := map[string]string{
		"dns":       "NetworkNstarDnsActivity.total_query_count",
		"threats":   "PortunusAggThreat_ch.requests",
		"qps":       "HostMetrics.avg_value",
		"dhcp":      "NetworkNstarDhcpLeaseActivity.total_count",
		"assets":    "AssetDetails_ch_agg.assetsCount",
		"newassets": "AssetDetails_ch_agg.assetsCount",
	}
	times := map[string]string{"dns": "NetworkNstarDnsActivity.timestamp", "threats": "PortunusAggThreat_ch.timestamp",
		"qps": "HostMetrics.timestamp", "dhcp": "NetworkNstarDhcpLeaseActivity.timestamp",
		"newassets": "AssetDetails_ch_agg.first_seen"}
	endpoints := map[string]string{
		"dns":       "/api/cubejs/v1/query",
		"threats":   "/api/cubejs-security/v1/query",
		"qps":       "/api/cubejs/v1/query",
		"dhcp":      "/api/cubejs/v1/query",
		"assets":    "/api/cubejs/v1/query",
		"newassets": "/api/cubejs/v1/query",
	}
	dims := map[string][]any{
		"device":   {"NetworkNstarDnsActivity.device_name", "NetworkNstarDnsActivity.device_ip"},
		"qtype":    {"NetworkNstarDnsActivity.query_type"},
		"domain":   {"NetworkNstarDnsActivity.qname"},
		"rcode":    {"NetworkNstarDnsActivity.rcode"},
		"action":   {"PortunusAggThreat_ch.action"},
		"tclass":   {"PortunusAggThreat_ch.tclass"},
		"policy":   {"PortunusAggThreat_ch.policy_name"},
		"severity": {"PortunusAggThreat_ch.severity"},
		"leaseop":  {"NetworkNstarDhcpLeaseActivity.lease_op"},
		"atype":    {"AssetDetails_ch_agg.taxonomy_type_label"},
		"acat":     {"AssetDetails_ch_agg.taxonomy_super_category_label"},
		"os":       {"AssetDetails_ch_agg.os_type"},
		"source":   {"AssetDetails_ch_agg.provider_label"},
		"where":    {"AssetDetails_ch_agg.deploymentContext"},
		"vendor":   {"AssetDetails_ch_agg.vendor"},
		"region":   {"AssetDetails_ch_agg.region_label"},
	}
	// Bucket splits add a filter per bucket when run, not a dimension.
	buckets := map[string]bool{"problem": true, "missing": true}
	ranges := map[string]string{"today": "today", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days",
		"thismonth": "this month", "lastmonth": "last month", "90d": "last 90 days"}

	combos := ChartCombos()
	if len(combos) == 0 {
		t.Fatal("no allowed combinations")
	}
	for _, p := range combos {
		q, endpoint, err := BuildChartQuery(p)
		if err != nil {
			t.Errorf("%+v: refused an allowed pick: %v", p, err)
			continue
		}
		q = roundTrip(t, q)
		if endpoint != endpoints[p.Count] {
			t.Errorf("%+v: endpoint = %s, want %s", p, endpoint, endpoints[p.Count])
		}
		if ms := asSlice(q["measures"]); len(ms) != 1 || ms[0] != measures[p.Count] {
			t.Errorf("%+v: measures = %v", p, q["measures"])
		}
		if p.Split == "none" || buckets[p.Split] {
			if _, ok := q["dimensions"]; ok {
				t.Errorf("%+v: no split but dimensions = %v", p, q["dimensions"])
			}
		} else if got := asSlice(q["dimensions"]); !reflect.DeepEqual(got, dims[p.Split]) {
			t.Errorf("%+v: dimensions = %v, want %v", p, got, dims[p.Split])
		}
		if p.Count == "assets" {
			// A snapshot has no time to window.
			if _, ok := q["timeDimensions"]; ok || p.Window != "now" {
				t.Errorf("%+v: assets must be now with no timeDimensions, got %v", p, q["timeDimensions"])
			}
			continue
		}
		td := asMap(asSlice(q["timeDimensions"])[0])
		if td["dimension"] != times[p.Count] || td["dateRange"] != ranges[p.Window] {
			t.Errorf("%+v: timeDimensions = %+v", p, td)
		}
		if p.Over == "none" {
			if _, ok := td["granularity"]; ok {
				t.Errorf("%+v: one total but granularity = %v", p, td["granularity"])
			}
		} else if td["granularity"] != p.Over {
			t.Errorf("%+v: granularity = %v, want %s", p, td["granularity"], p.Over)
		}
		if p.Top > 0 {
			if q["limit"] != float64(p.Top) {
				t.Errorf("%+v: limit = %v", p, q["limit"])
			}
			if asMap(q["order"])[measures[p.Count]] != "desc" {
				t.Errorf("%+v: order = %v, want the measure descending", p, q["order"])
			}
		} else if _, ok := q["limit"]; ok {
			t.Errorf("%+v: no top N but limit = %v", p, q["limit"])
		}
		f := asSlice(q["filters"])
		if p.Count == "qps" {
			want := []any{map[string]any{"member": "HostMetrics.metric_name", "operator": "equals", "values": []any{"dns_qps_iq"}}}
			if !reflect.DeepEqual(f, want) {
				t.Errorf("%+v: filters = %v, want the dns_qps_iq filter", p, f)
			}
		} else if len(f) != 0 {
			t.Errorf("%+v: filters = %v, want none", p, f)
		}
	}
}

// TestBuildChartQuery_NewPicksExactly writes out, whole, the query each pick
// added in round two sends, so a field name typo cannot hide behind a map.
func TestBuildChartQuery_NewPicksExactly(t *testing.T) {
	top := func(cube, measure, field, window string, n int) map[string]any {
		return map[string]any{
			"measures":       []any{cube + "." + measure},
			"dimensions":     []any{cube + "." + field},
			"timeDimensions": []any{map[string]any{"dimension": cube + ".timestamp", "dateRange": window}},
			"order":          map[string]any{cube + "." + measure: "desc"},
			"limit":          float64(n),
		}
	}
	const dns, sec, dhcp = "/api/cubejs/v1/query", "/api/cubejs-security/v1/query", "/api/cubejs/v1/query"
	for _, c := range []struct {
		p        ChartPicks
		want     map[string]any
		endpoint string
	}{
		{ChartPicks{Count: "dns", Split: "domain", Window: "7d", Over: "none", Top: 10},
			top("NetworkNstarDnsActivity", "total_query_count", "qname", "last 7 days", 10), dns},
		{ChartPicks{Count: "dns", Split: "rcode", Window: "30d", Over: "none", Top: 5},
			top("NetworkNstarDnsActivity", "total_query_count", "rcode", "last 30 days", 5), dns},
		{ChartPicks{Count: "threats", Split: "tclass", Window: "7d", Over: "none", Top: 5},
			top("PortunusAggThreat_ch", "requests", "tclass", "last 7 days", 5), sec},
		{ChartPicks{Count: "threats", Split: "policy", Window: "today", Over: "none", Top: 5},
			top("PortunusAggThreat_ch", "requests", "policy_name", "today", 5), sec},
		{ChartPicks{Count: "threats", Split: "severity", Window: "7d", Over: "none", Top: 5},
			top("PortunusAggThreat_ch", "requests", "severity", "last 7 days", 5), sec},
		{ChartPicks{Count: "dhcp", Split: "leaseop", Window: "7d", Over: "none", Top: 5},
			top("NetworkNstarDhcpLeaseActivity", "total_count", "lease_op", "last 7 days", 5), dhcp},
		{ChartPicks{Count: "dhcp", Split: "none", Window: "30d", Over: "day"},
			map[string]any{
				"measures": []any{"NetworkNstarDhcpLeaseActivity.total_count"},
				"timeDimensions": []any{map[string]any{"dimension": "NetworkNstarDhcpLeaseActivity.timestamp",
					"dateRange": "last 30 days", "granularity": "day"}},
			}, dhcp},
		{ChartPicks{Count: "dns", Split: "none", Window: "24h", Over: "hour"},
			map[string]any{
				"measures": []any{"NetworkNstarDnsActivity.total_query_count"},
				"timeDimensions": []any{map[string]any{"dimension": "NetworkNstarDnsActivity.timestamp",
					"dateRange": "last 24 hours", "granularity": "hour"}},
			}, dns},
	} {
		q, ep, err := BuildChartQuery(c.p)
		if err != nil {
			t.Errorf("%+v: refused: %v", c.p, err)
			continue
		}
		if got := roundTrip(t, q); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%+v:\n got %v\nwant %v", c.p, got, c.want)
		}
		if ep != c.endpoint {
			t.Errorf("%+v: endpoint = %s, want %s", c.p, ep, c.endpoint)
		}
	}
}

// TestBuildChartQuery_RedrawsTheDNSQueryRatePanel: queries per second over the
// last 24 hours by hour is the DNS tab's query-rate panel (CSPDNSQps), and it
// must send that panel's query exactly, or the two would disagree.
func TestBuildChartQuery_RedrawsTheDNSQueryRatePanel(t *testing.T) {
	var panel, built string
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := json.Marshal(cubeQueryFromRequest(t, r))
		panel = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[]}}`))
	})
	s.CSPDNSQps()
	q, ep, err := BuildChartQuery(ChartPicks{Count: "qps", Split: "none", Window: "24h", Over: "hour"})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(roundTrip(t, q))
	built = string(b)
	if panel == "" || built != panel {
		t.Fatalf("builder query differs from the panel's:\n built %s\n panel %s", built, panel)
	}
	if ep != "/api/cubejs/v1/query" {
		t.Fatalf("endpoint = %s", ep)
	}
}

// TestChartCombos_FollowThePickerRules pins the rules themselves: by hour only
// with today or the last 24 hours, by day only with 7 or 30 days, top N only
// for a split with no time slicing, and each measure split only by its own
// cube's fields.
func TestChartCombos_FollowThePickerRules(t *testing.T) {
	splits := map[string]map[string]bool{
		"dns":     {"device": true, "qtype": true, "domain": true, "rcode": true, "none": true},
		"threats": {"action": true, "tclass": true, "policy": true, "severity": true, "none": true},
		"qps":     {"none": true},
		"dhcp":    {"leaseop": true, "none": true},
	}
	assetSplit := map[string]bool{"atype": true, "acat": true, "os": true, "source": true, "where": true,
		"vendor": true, "region": true, "none": true}
	splits["newassets"] = assetSplit
	splits["assets"] = map[string]bool{"problem": true, "missing": true}
	for k := range assetSplit {
		splits["assets"][k] = true
	}
	seen := map[ChartPicks]bool{}
	for _, p := range ChartCombos() {
		if seen[p] {
			t.Errorf("duplicate combination %+v", p)
		}
		seen[p] = true
		if !splits[p.Count][p.Split] {
			t.Errorf("%+v: %s cannot be split by %s", p, p.Count, p.Split)
		}
		if p.Over == "hour" && p.Window != "today" && p.Window != "24h" {
			t.Errorf("%+v: by hour is only for today or the last 24 hours", p)
		}
		if p.Over == "day" && p.Window != "7d" && p.Window != "30d" && p.Window != "thismonth" && p.Window != "lastmonth" {
			t.Errorf("%+v: by day is only for 7 or 30 days or a calendar month", p)
		}
		if p.Over == "week" && p.Window != "30d" && p.Window != "90d" {
			t.Errorf("%+v: by week is only for 30 or 90 days", p)
		}
		if (p.Count == "assets") != (p.Window == "now") || p.Count == "assets" && p.Over != "none" {
			t.Errorf("%+v: assets are now only, with no over-time, and nothing else is now", p)
		}
		wantTop := p.Split != "none" && p.Over == "none" && p.Split != "problem" && p.Split != "missing"
		if wantTop != (p.Top > 0) {
			t.Errorf("%+v: top N must be set exactly when split and no over-time", p)
		}
		// Measured 2026-10-22: every hourly slice of PortunusAggThreat_ch comes
		// back as one row at midnight, so "by hour" would draw a single bar.
		if p.Count == "threats" && (p.Over == "hour" || p.Window == "24h") {
			t.Errorf("%+v: security hits are kept by day, not by hour or a rolling 24 hours", p)
		}
		if p.Split != "none" && p.Over != "none" && p.Split != "action" {
			t.Errorf("%+v: only blocked vs allowed splits over time", p)
		}
	}
	// The four charts the owner will build by picking must all be reachable.
	for _, p := range []ChartPicks{
		{Count: "dns", Split: "device", Window: "7d", Over: "none", Top: 10},
		{Count: "dns", Split: "none", Window: "today", Over: "hour"},
		{Count: "threats", Split: "action", Window: "30d", Over: "day"},
		{Count: "dns", Split: "qtype", Window: "7d", Over: "none", Top: 10},
		{Count: "qps", Split: "none", Window: "24h", Over: "hour"},
		{Count: "dns", Split: "domain", Window: "24h", Over: "none", Top: 25},
		{Count: "threats", Split: "severity", Window: "30d", Over: "none", Top: 10},
		{Count: "dhcp", Split: "leaseop", Window: "today", Over: "none", Top: 5},
		{Count: "dhcp", Split: "none", Window: "today", Over: "hour"},
		// One total, drawn as a single number.
		{Count: "dns", Split: "none", Window: "7d", Over: "none"},
		{Count: "threats", Split: "none", Window: "today", Over: "none"},
		// Assets, the new windows and by week.
		{Count: "assets", Split: "none", Window: "now", Over: "none"},
		{Count: "assets", Split: "atype", Window: "now", Over: "none", Top: 10},
		{Count: "assets", Split: "where", Window: "now", Over: "none", Top: 5},
		{Count: "assets", Split: "problem", Window: "now", Over: "none"},
		{Count: "assets", Split: "missing", Window: "now", Over: "none"},
		{Count: "newassets", Split: "none", Window: "90d", Over: "week"},
		{Count: "newassets", Split: "atype", Window: "30d", Over: "none", Top: 10},
		{Count: "dns", Split: "none", Window: "90d", Over: "week"},
		{Count: "dns", Split: "none", Window: "thismonth", Over: "day"},
		{Count: "threats", Split: "action", Window: "lastmonth", Over: "day"},
		{Count: "dhcp", Split: "leaseop", Window: "90d", Over: "none", Top: 10},
	} {
		if !seen[p] {
			t.Errorf("%+v: missing from the allow-list", p)
		}
	}
}

func TestBuildChartQuery_RefusesPicksOutsideTheCatalog(t *testing.T) {
	for _, p := range []ChartPicks{
		{Count: "domains", Split: "none", Window: "7d", Over: "day"},              // unknown measure
		{Count: "threats", Split: "qtype", Window: "7d", Over: "none", Top: 10},   // field from another cube
		{Count: "qps", Split: "device", Window: "7d", Over: "none", Top: 10},      // HostMetrics has no split
		{Count: "dns", Split: "none", Window: "7d", Over: "hour"},                 // by hour needs today
		{Count: "dns", Split: "none", Window: "today", Over: "day"},               // by day needs 7/30 days
		{Count: "dns", Split: "device", Window: "7d", Over: "none", Top: 1000},    // top outside 5/10/25
		{Count: "dns", Split: "device", Window: "7d", Over: "none"},               // split with no top
		{Count: "dns", Split: "none", Window: "7d", Over: "day", Top: 10},         // top with no split
		{Count: "dns", Split: "none", Window: "90d", Over: "day"},                 // unknown window
		{Count: "dns", Split: "none", Window: "7d", Over: "none", Top: 10},        // a top N of one total
		{Count: "dns", Split: "device", Window: "7d", Over: "day"},                // device over time
		{Count: "threats", Split: "domain", Window: "7d", Over: "none", Top: 10},  // DNS field on the security cube
		{Count: "dns", Split: "tclass", Window: "7d", Over: "none", Top: 10},      // security field on the DNS cube
		{Count: "dhcp", Split: "device", Window: "7d", Over: "none", Top: 10},     // DNS field on the DHCP cube
		{Count: "dns", Split: "severity", Window: "7d", Over: "none", Top: 5},     // security field on the DNS cube
		{Count: "dns", Split: "none", Window: "24h", Over: "day"},                 // by day needs 7/30 days
		{Count: "dns", Split: "domain", Window: "7d", Over: "day"},                // domains are top N only
		{Count: "threats", Split: "tclass", Window: "30d", Over: "day"},           // threat types are top N only
		{Count: "dhcp", Split: "leaseop", Window: "7d", Over: "day"},              // what changed is top N only
		{Count: "threats", Split: "action", Window: "today", Over: "hour"},        // the security cube keeps days only
		{Count: "threats", Split: "none", Window: "24h", Over: "hour"},            // the security cube keeps days only
		{Count: "threats", Split: "policy", Window: "24h", Over: "none", Top: 5},  // a rolling 24 hours of day rows
		{Count: "assets", Split: "none", Window: "7d", Over: "none"},              // assets are a snapshot: now only
		{Count: "assets", Split: "none", Window: "now", Over: "day"},              // a snapshot has no over-time
		{Count: "dns", Split: "none", Window: "now", Over: "none"},                // DNS activity has no "now"
		{Count: "assets", Split: "problem", Window: "now", Over: "none", Top: 10}, // buckets show every bucket
		{Count: "newassets", Split: "problem", Window: "30d", Over: "none"},       // problems only on the snapshot
		{Count: "dns", Split: "device", Window: "now", Over: "none", Top: 10},     // asset window on DNS
		{Count: "dns", Split: "atype", Window: "7d", Over: "none", Top: 10},       // asset field on the DNS cube
		{Count: "dns", Split: "none", Window: "90d", Over: "day"},                 // 90 days is by week
		{Count: "dns", Split: "none", Window: "7d", Over: "week"},                 // by week needs 30 or 90 days
		{Count: "threats", Split: "none", Window: "thismonth", Over: "hour"},      // by hour needs today
		{Count: "qps", Split: "none", Window: "90d", Over: "week"},                // HostMetrics refuses a week step
	} {
		if q, ep, err := BuildChartQuery(p); err == nil {
			t.Errorf("%+v: accepted, built %v for %s", p, q, ep)
		}
	}
}

// --- RunChart ------------------------------------------------------------

func TestRunChart_SecurityGoesToTheSecurityService(t *testing.T) {
	var path string
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		q := cubeQueryFromRequest(t, r)
		if ms := asSlice(q["measures"]); len(ms) != 1 || ms[0] != "PortunusAggThreat_ch.requests" {
			t.Errorf("measures = %v", q["measures"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[
			{"PortunusAggThreat_ch.action":"block","PortunusAggThreat_ch.timestamp.day":"2026-10-20T00:00:00.000","PortunusAggThreat_ch.requests":"41"}
		]}}`))
	})
	got := s.RunChart(context.Background(), ChartPicks{Count: "threats", Split: "action", Window: "30d", Over: "day"})
	if path != "/api/cubejs-security/v1/query" {
		t.Fatalf("security query went to %s", path)
	}
	if got["status"] != "ok" || got["endpoint"] != "/api/cubejs-security/v1/query" {
		t.Fatalf("status/endpoint = %v/%v", got["status"], got["endpoint"])
	}
	rows, _ := got["rows"].([]map[string]any)
	if len(rows) != 1 || rows[0]["PortunusAggThreat_ch.action"] != "block" {
		t.Fatalf("rows lost their Cube.field keys: %v", got["rows"])
	}
	if got["query"] == nil {
		t.Fatal("response must carry the query it ran")
	}
}

func TestRunChart_DisallowedPickSendsNothingUpstream(t *testing.T) {
	var calls int32
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
	})
	got := s.RunChart(context.Background(), ChartPicks{Count: "threats", Split: "qtype", Window: "7d", Over: "none", Top: 10})
	if got["status"] != "invalid" {
		t.Fatalf("status = %v, want invalid", got["status"])
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("a refused pick reached the tenant %d times", calls)
	}
}

func TestRunChart_UpstreamErrorIsNotEmpty(t *testing.T) {
	var calls int32
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		http.Error(w, "boom", http.StatusBadGateway)
	})
	p := ChartPicks{Count: "dns", Split: "none", Window: "7d", Over: "day"}
	got := s.RunChart(context.Background(), p)
	if got["status"] != "error" {
		t.Fatalf("status = %v, want error", got["status"])
	}
	if got["reason"] == nil || got["reason"] == "" {
		t.Fatal("an error must say why")
	}
	// A failure is not cached, so the next pick tries again.
	s.RunChart(context.Background(), p)
	if atomic.LoadInt32(&calls) != 2 {
		t.Fatalf("upstream calls = %d, want 2 (errors must not be cached)", calls)
	}
}

func TestRunChart_GenuinelyEmptyIsEmptyAndCached(t *testing.T) {
	var calls int32
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":{"data":[]}}`))
	})
	p := ChartPicks{Count: "qps", Split: "none", Window: "today", Over: "hour"}
	got := s.RunChart(context.Background(), p)
	if got["status"] != "empty" {
		t.Fatalf("status = %v, want empty", got["status"])
	}
	if rows, ok := got["rows"].([]map[string]any); !ok || rows == nil || len(rows) != 0 {
		t.Fatalf("rows = %#v, want a non-nil empty list", got["rows"])
	}
	s.RunChart(context.Background(), p)
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("upstream calls = %d, want 1 (a good answer is cached)", calls)
	}
}

// --- ChartOptions ----------------------------------------------------------

// TestChartOptions_EveryFieldHasAPlainName: the screen takes every label from
// this payload, so a field with no plain name would show up raw.
func TestChartOptions_EveryFieldHasAPlainName(t *testing.T) {
	opts := roundTrip(t, ChartOptions())
	names := asMap(opts["names"])
	for _, p := range ChartCombos() {
		q, _, err := BuildChartQuery(p)
		if err != nil {
			t.Fatal(err)
		}
		q = roundTrip(t, q)
		fields := append([]any{}, asSlice(q["measures"])...)
		fields = append(fields, asSlice(q["dimensions"])...)
		if td := asSlice(q["timeDimensions"]); len(td) > 0 {
			fields = append(fields, asMap(td[0])["dimension"])
		}
		for _, f := range fields {
			if n, _ := names[f.(string)].(string); n == "" {
				t.Errorf("%s has no plain name", f)
			}
		}
	}
	vals := asMap(asMap(opts["values"])["PortunusAggThreat_ch.action"])
	// The tenant sends these capitalised (measured live 2026-10-21).
	if vals["Block"] != "Blocked" || vals["Allow"] != "Allowed" {
		t.Errorf("action values = %v, want Block->Blocked, Allow->Allowed", vals)
	}
	vals = asMap(opts["values"])
	// rcode is a number on the wire; the three seen on the tenant have words.
	rc := asMap(vals["NetworkNstarDnsActivity.rcode"])
	if rc["0"] != "Answered" || rc["2"] != "Server failed" || rc["3"] != "No such name" {
		t.Errorf("rcode values = %v", rc)
	}
	if asMap(opts["otherValues"])["NetworkNstarDnsActivity.rcode"] != "Answer code %s" {
		t.Errorf("an unknown rcode must read as \"Answer code N\", got %v", opts["otherValues"])
	}
	// About 2.55M security hits have no severity; they are shown, not dropped.
	if asMap(vals["PortunusAggThreat_ch.severity"])[""] != "Not graded" {
		t.Errorf("blank severity must read as Not graded, got %v", vals["PortunusAggThreat_ch.severity"])
	}
	// Every split with a top N needs a plural for "Top 10 <plural>".
	for _, s := range asSlice(opts["splits"]) {
		m := asMap(s)
		// A bucket split shows every bucket, never a top N.
		if pl, _ := m["plural"].(string); m["id"] != "none" && m["id"] != "action" && len(asSlice(m["buckets"])) == 0 && pl == "" {
			t.Errorf("split %v has no plural", m["id"])
		}
	}
	if len(asSlice(opts["combos"])) != len(ChartCombos()) {
		t.Errorf("options must carry the whole allow-list")
	}
	for _, k := range []string{"counts", "splits", "windows", "overs", "tops"} {
		if len(asSlice(opts[k])) == 0 {
			t.Errorf("options[%s] is empty", k)
		}
	}
}

// TestChartOptions_MatchesTheUIFixture keeps tests/chart-options.json,
// which the UI's node tests and Playwright read, identical to what the server
// sends. UPDATE_CHART_FIXTURE=1 rewrites it.
func TestChartOptions_MatchesTheUIFixture(t *testing.T) {
	const path = "../../../tests/chart-options.json"
	want, err := json.MarshalIndent(ChartOptions(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	if os.Getenv("UPDATE_CHART_FIXTURE") == "1" {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with UPDATE_CHART_FIXTURE=1 to write it)", err)
	}
	if string(got) != string(want) {
		t.Fatalf("%s is out of date; run with UPDATE_CHART_FIXTURE=1", path)
	}
}

// TestRunChart_BucketsCountEachValueOnItsOwn: a field holding several values
// per asset is counted once per value, with a contains filter on the quoted
// value, and comes back as one row per bucket in group-by shape.
func TestRunChart_BucketsCountEachValueOnItsOwn(t *testing.T) {
	counts := map[string]string{`"DNS Forward Record"`: "383", `"DNS Pointer Record"`: "383", `"IPAM"`: "49"}
	var calls atomic.Int32
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		q := cubeQueryFromRequest(t, r)
		if _, ok := q["dimensions"]; ok {
			t.Errorf("a bucket count must not group by, got dimensions %v", q["dimensions"])
		}
		f := asMap(asSlice(q["filters"])[0])
		if f["member"] != "AssetDetails_ch_agg.insight_indicators_label" || f["operator"] != "contains" {
			t.Errorf("filter = %v", f)
		}
		v := asSlice(f["values"])[0].(string)
		_, _ = w.Write([]byte(`{"result":{"data":[{"AssetDetails_ch_agg.assetsCount":"` + counts[v] + `"}]}}`))
	})
	res := s.RunChart(context.Background(), ChartPicks{Count: "assets", Split: "missing", Window: "now", Over: "none"})
	if res["status"] != "ok" || calls.Load() != 3 {
		t.Fatalf("status %v after %d calls, want ok after 3", res["status"], calls.Load())
	}
	want := []map[string]any{
		{"AssetDetails_ch_agg.insight_indicators_label": "DNS Forward Record", "AssetDetails_ch_agg.assetsCount": "383"},
		{"AssetDetails_ch_agg.insight_indicators_label": "DNS Pointer Record", "AssetDetails_ch_agg.assetsCount": "383"},
		{"AssetDetails_ch_agg.insight_indicators_label": "IPAM", "AssetDetails_ch_agg.assetsCount": "49"},
	}
	if !reflect.DeepEqual(res["rows"], want) {
		t.Fatalf("rows = %v", res["rows"])
	}
	if qs, _ := res["query"].([]map[string]any); len(qs) != 3 {
		t.Fatalf("query as sent must list all three counts, got %v", res["query"])
	}
}

// TestRunChart_OneFailedBucketFailsTheChart: a missing bar would read as zero.
func TestRunChart_OneFailedBucketFailsTheChart(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		v := asSlice(asMap(asSlice(cubeQueryFromRequest(t, r)["filters"])[0])["values"])[0].(string)
		if v == `"Zombie"` {
			w.WriteHeader(502)
			return
		}
		_, _ = w.Write([]byte(`{"result":{"data":[{"AssetDetails_ch_agg.assetsCount":"5"}]}}`))
	})
	res := s.RunChart(context.Background(), ChartPicks{Count: "assets", Split: "problem", Window: "now", Over: "none"})
	if res["status"] != "error" {
		t.Fatalf("status = %v, want error", res["status"])
	}
}

// TestBuildChartQuery_AssetsExactly writes out the asset queries whole.
func TestBuildChartQuery_AssetsExactly(t *testing.T) {
	q, _, err := BuildChartQuery(ChartPicks{Count: "assets", Split: "atype", Window: "now", Over: "none", Top: 10})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"dimensions":["AssetDetails_ch_agg.taxonomy_type_label"],"limit":10,"measures":["AssetDetails_ch_agg.assetsCount"],"order":{"AssetDetails_ch_agg.assetsCount":"desc"}}`
	if b, _ := json.Marshal(q); string(b) != want {
		t.Errorf("assets by type:\n got %s\nwant %s", b, want)
	}
	q, _, err = BuildChartQuery(ChartPicks{Count: "newassets", Split: "none", Window: "90d", Over: "week"})
	if err != nil {
		t.Fatal(err)
	}
	want = `{"measures":["AssetDetails_ch_agg.assetsCount"],"timeDimensions":[{"dateRange":"last 90 days","dimension":"AssetDetails_ch_agg.first_seen","granularity":"week"}]}`
	if b, _ := json.Marshal(q); string(b) != want {
		t.Errorf("new assets by week:\n got %s\nwant %s", b, want)
	}
}
