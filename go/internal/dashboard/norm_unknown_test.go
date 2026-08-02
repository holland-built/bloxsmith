package dashboard

import (
	"reflect"
	"testing"
)

// This file locks the "never fabricate a measurement" contract across the five
// places norm.go/signals.go used to invent one. Every case comes in a pair: the
// absent-upstream-field half asserts nil / "unknown", and the present-field
// half asserts the original normalisation byte-for-byte, so tightening the
// unknown path cannot silently regress the measured path.

// TestNormSubnetsUnknownCapacity: no utilization object means unknown capacity,
// not a healthy 0%-utilised subnet.
func TestNormSubnetsUnknownCapacity(t *testing.T) {
	cases := []struct {
		name                    string
		row                     map[string]any
		total, used, util       any
		wantNilTotalUsedAndUtil bool
	}{
		{
			name:                    "neither utilization nor dhcp_utilization",
			row:                     map[string]any{"address": "10.1.0.0", "cidr": float64(24)},
			wantNilTotalUsedAndUtil: true,
		},
		{
			name:                    "utilization present but empty object",
			row:                     map[string]any{"address": "10.2.0.0", "utilization": map[string]any{}},
			wantNilTotalUsedAndUtil: true,
		},
		{
			// An object that arrives with `used` but no `total` at all. Keying
			// "unknown" off the object's mere existence would fabricate a
			// healthy 0% here. Not observed on the live tenant today — every
			// subnet there reports a total — so this pins the guard, not a
			// current symptom.
			name:                    "utilization present but reports no total",
			row:                     map[string]any{"address": "2400:4800:fb19:2000::", "utilization": map[string]any{"used": float64(0)}},
			wantNilTotalUsedAndUtil: true,
		},
		{
			name:  "utilization present",
			row:   map[string]any{"address": "10.3.0.0", "utilization": map[string]any{"total": float64(256), "used": float64(64)}},
			total: 256, used: 64, util: 25,
		},
		{
			name:  "dhcp_utilization fallback with _count field names",
			row:   map[string]any{"address": "10.4.0.0", "dhcp_utilization": map[string]any{"total_count": float64(200), "used_count": float64(1)}},
			total: 200, used: 1, util: 0, // RoundToEven(0.5) == 0, banker's rounding preserved
		},
		{
			name:  "measured zero capacity stays 0%, not nil",
			row:   map[string]any{"address": "10.5.0.0", "utilization": map[string]any{"total": float64(0), "used": float64(0)}},
			total: 0, used: 0, util: 0,
		},
		{
			name:  "half rounds to even upward",
			row:   map[string]any{"address": "10.6.0.0", "utilization": map[string]any{"total": float64(200), "used": float64(3)}},
			total: 200, used: 3, util: 2, // RoundToEven(1.5) == 2
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := normSubnets([]any{tc.row})[0]
			if tc.wantNilTotalUsedAndUtil {
				for _, k := range []string{"total", "used", "util"} {
					if r[k] != nil {
						t.Fatalf("%s: got %v (%T), want nil — unmeasured capacity must not render as a measured value", k, r[k], r[k])
					}
				}
				return
			}
			if r["total"] != tc.total || r["used"] != tc.used || r["util"] != tc.util {
				t.Fatalf("present utilization normalised differently than before: got total=%v used=%v util=%v, want total=%v used=%v util=%v",
					r["total"], r["used"], r["util"], tc.total, tc.used, tc.util)
			}
		})
	}
}

// TestNormZonesUnknownTTL: an absent zone_authority means unknown TTLs, and a
// zone with unknown TTLs must be neither accused of an issue nor cleared of one.
func TestNormZonesUnknownTTL(t *testing.T) {
	cases := []struct {
		name        string
		zone        map[string]any
		wantUnknown bool
		ttl, negTTL any
		wantIssues  []any
		wantAnomaly any
	}{
		{
			name:        "no zone_authority",
			zone:        map[string]any{"fqdn": "a.example.com."},
			wantUnknown: true,
		},
		{
			name: "zone_authority present and healthy",
			zone: map[string]any{"fqdn": "b.example.com.", "zone_authority": map[string]any{
				"default_ttl": float64(3600), "negative_ttl": float64(900)}},
			ttl: 3600, negTTL: 900, wantIssues: []any{}, wantAnomaly: false,
		},
		{
			name: "zone_authority present with a low TTL",
			zone: map[string]any{"fqdn": "c.example.com.", "zone_authority": map[string]any{
				"default_ttl": float64(30), "negative_ttl": float64(300)}},
			ttl: 30, negTTL: 300, wantIssues: []any{"TTL Too Low"}, wantAnomaly: true,
		},
		{
			name: "zone_authority present with a high TTL and high neg-TTL",
			zone: map[string]any{"fqdn": "d.example.com.", "zone_authority": map[string]any{
				"default_ttl": float64(90000), "negative_ttl": float64(7200)}},
			ttl: 90000, negTTL: 7200, wantIssues: []any{"TTL Too High", "High Neg-TTL"}, wantAnomaly: true,
		},
		{
			// zone_authority present, default_ttl simply not in it. Keying
			// "unknown" off the object's existence would fabricate 3600 here,
			// so the test is on the sub-field. Not observed on the live tenant
			// today — every zone there reports a default_ttl, including the 121
			// that genuinely report 3600. negative_ttl WAS reported, so it is
			// kept and judged; the missing default_ttl contributes no issue and
			// no all-clear.
			name: "zone_authority present, default_ttl sub-field missing",
			zone: map[string]any{"fqdn": "e.example.com.", "zone_authority": map[string]any{
				"negative_ttl": float64(300)}},
			ttl: nil, negTTL: 300, wantIssues: []any{}, wantAnomaly: false,
		},
		{
			// The mirror image: a reported TTL of 0 is a MEASUREMENT, not a
			// missing value, and must survive as 0 and be judged Too Low. A
			// truthiness test (orAny) would have called this unknown.
			name: "default_ttl reported as zero is a measurement, not an absence",
			zone: map[string]any{"fqdn": "f.example.com.", "zone_authority": map[string]any{
				"default_ttl": float64(0)}},
			ttl: 0, negTTL: nil, wantIssues: []any{"TTL Too Low"}, wantAnomaly: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := normZones([]any{tc.zone}, nil)[0]
			if tc.wantUnknown {
				if r["ttl"] != nil || r["neg_ttl"] != nil {
					t.Fatalf("absent zone_authority: got ttl=%v neg_ttl=%v, want nil/nil — 3600 is a fabricated TTL", r["ttl"], r["neg_ttl"])
				}
				if r["issues"] != nil {
					t.Fatalf("absent zone_authority: got issues=%#v, want nil — an empty issues list reads as a verified-clean zone", r["issues"])
				}
				if r["anomaly"] != nil {
					t.Fatalf("absent zone_authority: got anomaly=%v, want nil — false claims the zone was checked and passed", r["anomaly"])
				}
				return
			}
			if r["ttl"] != tc.ttl || r["neg_ttl"] != tc.negTTL {
				t.Fatalf("present zone_authority normalised differently: got ttl=%v neg_ttl=%v, want %v/%v", r["ttl"], r["neg_ttl"], tc.ttl, tc.negTTL)
			}
			if !reflect.DeepEqual(r["issues"], tc.wantIssues) {
				t.Fatalf("present zone_authority issues: got %#v, want %#v", r["issues"], tc.wantIssues)
			}
			if r["anomaly"] != tc.wantAnomaly {
				t.Fatalf("present zone_authority anomaly: got %v, want %v", r["anomaly"], tc.wantAnomaly)
			}
		})
	}
}

// TestNormHostsUnknownStatus: both "no status reported" and "status we do not
// recognise" mean unknown, not the real lifecycle state "pending".
func TestNormHostsUnknownStatus(t *testing.T) {
	cases := []struct {
		name string
		host map[string]any
		want string
	}{
		{"no status at all", map[string]any{"name": "h1"}, "unknown"},
		{"unrecognised upstream status", map[string]any{"name": "h2", "composite_status": "quiescing"}, "unknown"},
		{"empty string status", map[string]any{"name": "h3", "composite_status": ""}, "unknown"},
		{"online", map[string]any{"name": "h4", "composite_status": "online"}, "online"},
		{"active maps to online", map[string]any{"name": "h5", "composite_status": "ACTIVE"}, "online"},
		{"degraded", map[string]any{"name": "h6", "composite_status": "degraded"}, "degraded"},
		{"inactive maps to offline", map[string]any{"name": "h7", "composite_status": "inactive"}, "offline"},
		{"error", map[string]any{"name": "h8", "composite_status": "error"}, "error"},
		{"a real pending is still pending", map[string]any{"name": "h9", "composite_status": "pending"}, "pending"},
		{"awaiting_provisioning is still pending", map[string]any{"name": "h10", "composite_status": "awaiting_provisioning"}, "pending"},
		{"connectivity_monitor fallback", map[string]any{"name": "h11",
			"connectivity_monitor": map[string]any{"status": "offline"}}, "offline"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := normHosts([]any{tc.host})[0]["status"]
			if got != tc.want {
				t.Fatalf("status: got %v, want %q (an unknown host state must not be reported as the actionable state \"pending\")", got, tc.want)
			}
		})
	}
}

// TestNormAuditUnknownAction: a record carrying neither action nor http_method
// has no captured operation — it is not a harmless READ.
func TestNormAuditUnknownAction(t *testing.T) {
	cases := []struct {
		name   string
		record map[string]any
		want   string
	}{
		{"neither action nor http_method", map[string]any{"id": "1"}, "unknown"},
		{"both fields empty strings", map[string]any{"id": "2", "action": "", "http_method": ""}, "unknown"},
		{"explicit action", map[string]any{"id": "3", "action": "delete"}, "DELETE"},
		{"http_method fallback", map[string]any{"id": "4", "http_method": "post"}, "POST"},
		{"a real read stays READ", map[string]any{"id": "5", "action": "read"}, "READ"},
		{"action wins over http_method", map[string]any{"id": "6", "action": "update", "http_method": "GET"}, "UPDATE"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := normAudit([]any{tc.record})[0]["action"]
			if got != tc.want {
				t.Fatalf("action: got %v, want %q (an uncaptured operation must not render as a read)", got, tc.want)
			}
		})
	}
}

// TestBuildSignalsSkipsUnknownUtil: a subnet with unknown utilisation must
// produce no signal, rather than being classified "ok" by coercing nil to 0.
//
// Mutation-tested honestly: deleting the nil guard in BuildSignals alone does
// NOT turn this test red, because nil coerces to 0, 0 grades "ok", and "ok"
// emits nothing — the two paths are observationally identical today. The guard
// is load-bearing the moment either threshold moves or an "ok" signal is ever
// emitted; mutating `util >= 70` to `util >= 0` with the guard removed produces
// `unknown-net at 0% utilization / severity:warn`, an alarm invented out of a
// missing measurement, and this test catches it. Keep the guard and this test
// together: the assertion below is what makes the classification of an
// unmeasured subnet a deliberate skip rather than an arithmetic accident.
func TestBuildSignalsSkipsUnknownUtil(t *testing.T) {
	cases := []struct {
		name       string
		subnet     map[string]any
		wantSignal bool
		wantSev    string
	}{
		{"unknown util emits no signal", map[string]any{"id": "s1", "name": "unknown-net", "util": nil}, false, ""},
		{"util below both thresholds emits no signal", map[string]any{"id": "s2", "name": "quiet-net", "util": 12}, false, ""},
		{"util at the warn threshold", map[string]any{"id": "s3", "name": "warm-net", "util": 70}, true, "warn"},
		{"util at the crit threshold", map[string]any{"id": "s4", "name": "hot-net", "util": 90}, true, "crit"},
		{"measured zero util emits no signal", map[string]any{"id": "s5", "name": "empty-net", "util": 0}, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := BuildSignals(map[string]any{"subnets": []map[string]any{tc.subnet}})
			if !tc.wantSignal {
				if len(got) != 0 {
					t.Fatalf("got %d signal(s) %v, want none — an unmeasured subnet must not be alerted on, nor silently graded \"ok\"", len(got), got[0])
				}
				return
			}
			if len(got) != 1 {
				t.Fatalf("got %d signals, want exactly 1", len(got))
			}
			if got[0]["severity"] != tc.wantSev {
				t.Fatalf("severity: got %v, want %q", got[0]["severity"], tc.wantSev)
			}
		})
	}

	// And the unknown subnet must not suppress its measured neighbours either.
	mixed := BuildSignals(map[string]any{"subnets": []map[string]any{
		{"id": "a", "name": "unknown-net", "util": nil},
		{"id": "b", "name": "hot-net", "util": 95},
	}})
	if len(mixed) != 1 || mixed[0]["entity_id"] != "b" {
		t.Fatalf("mixed batch: got %v, want exactly the measured subnet b", mixed)
	}
}
