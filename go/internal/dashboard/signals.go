package dashboard

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// This file ports the NOC-signal correlation engine (server.py:2489-2571):
// build_signals (derive alert Signals from the assembled /api/data dict) and
// correlate (group signals by category into Incidents). Both are pure/IO-free,
// exactly as in Python; stamp_first_seen lives in internal/store (Phase 1c) and
// the snooze store is store.ActiveSnoozes.

// SeverityOrder is _SEVERITY_ORDER (server.py:2480).
var SeverityOrder = map[string]int{"ok": 0, "warn": 1, "crit": 2}

// SampleCap is _SAMPLE_CAP (server.py:2481); SignalsCap is _SIGNALS_CAP (2487).
const (
	SampleCap  = 5
	SignalsCap = 2000
)

func signalsNow() float64 { return float64(time.Now().UnixNano()) / 1e9 }

// rowsOf coerces a FetchDashboardData sub-list (typed []map[string]any) to an
// iterable slice, tolerating a []any too.
func rowsOf(v any) []map[string]any {
	switch t := v.(type) {
	case []map[string]any:
		return t
	case []any:
		out := make([]map[string]any, 0, len(t))
		for _, x := range t {
			out = append(out, asMap(x))
		}
		return out
	}
	return nil
}

// BuildSignals is build_signals (server.py:2521): derive alert Signals from the
// assembled dashboard dict. Subnet util thresholds (>=90 crit, >=70 warn), zone
// anomaly (warn), expired lease (warn) — mirrors the Python thresholds exactly.
func BuildSignals(data map[string]any) []map[string]any {
	signals := []map[string]any{}
	now := signalsNow()

	for _, subnet := range rowsOf(data["subnets"]) {
		// A subnet whose utilization was never reported emits util = nil
		// (normSubnets). Falling through would coerce that nil to 0, sail under
		// both thresholds and classify the subnet "ok" by arithmetic accident —
		// an alerting engine quietly asserting a subnet is fine when it has no
		// idea. Skip it: no signal at all. An invented alert is as bad as a
		// missed one, and the honest state — "we do not know" — belongs on the
		// row as an em-dash, not in the incident list as an alarm.
		if subnet["util"] == nil {
			continue
		}
		util := toInt(orAny(subnet["util"], 0))
		severity := "ok"
		if util >= 90 {
			severity = "crit"
		} else if util >= 70 {
			severity = "warn"
		}
		if severity != "ok" {
			signals = append(signals, map[string]any{
				"source":      "network",
				"entity_type": "subnet",
				"entity_id":   orStr(subnet["id"], ""),
				"category":    "subnet-utilization",
				"severity":    severity,
				"message":     fmt.Sprintf("%s at %d%% utilization", orStr(subnet["name"], ""), util),
				"detected_at": now,
			})
		}
	}

	for _, zone := range rowsOf(data["zones"]) {
		if truthy(zone["anomaly"]) {
			issues := []string{}
			for _, is := range asSlice(zone["issues"]) {
				issues = append(issues, getStr(is))
			}
			signals = append(signals, map[string]any{
				"source":      "network",
				"entity_type": "zone",
				"entity_id":   orStr(zone["id"], ""),
				"category":    "dns-ttl-anomaly",
				"severity":    "warn",
				"message":     fmt.Sprintf("%s: %s", orStr(zone["fqdn"], ""), strings.Join(issues, ", ")),
				"detected_at": now,
			})
		}
	}

	for _, lease := range rowsOf(data["leases"]) {
		if getStr(lease["state"]) == "expired" {
			host := orStr(lease["host"], "")
			if host == "" {
				host = "unknown host"
			}
			signals = append(signals, map[string]any{
				"source":      "network",
				"entity_type": "lease",
				"entity_id":   orStr(lease["addr"], ""),
				"category":    "dhcp-expired-lease",
				"severity":    "warn",
				"message":     fmt.Sprintf("Lease %s (%s) expired", orStr(lease["addr"], ""), host),
				"detected_at": now,
			})
		}
	}

	// DNSSEC posture (one aggregate signal, not one per zone): unsigned zones
	// in this estate number in the thousands, and Signal-per-zone would blow
	// SignalsCap and bury the subnet/zone/lease signals above. Missing/empty
	// dnssec_status is UNKNOWN, not unsigned — excluded from both the
	// numerator and denominator so we never manufacture a worse number than
	// the data supports.
	unsignedCount, knownCount := 0, 0
	for _, zone := range rowsOf(data["zones"]) {
		status := getStr(zone["dnssec_status"])
		if status == "" {
			continue
		}
		knownCount++
		if status == "UNSIGNED" {
			unsignedCount++
		}
	}
	if unsignedCount > 0 {
		// crit only when every zone with a known status is unsigned (a
		// tenant-wide posture failure); warn when some zones are signed,
		// since the gap is real but not total.
		severity := "warn"
		if unsignedCount == knownCount {
			severity = "crit"
		}
		signals = append(signals, map[string]any{
			"source":      "dns",
			"entity_type": "posture",
			"entity_id":   "dnssec-posture",
			"category":    "dnssec-unsigned",
			"severity":    severity,
			"message":     fmt.Sprintf("%d of %d DNS zones unsigned (DNSSEC)", unsignedCount, knownCount),
			"detected_at": now,
		})
	}

	return signals
}

// SignalsFeeds are the /api/data feed keys BuildSignals reads to derive
// alert Signals: subnet utilization, zone anomaly/DNSSEC posture, and expired
// leases. Exported so a route that calls BuildSignals can also expose
// whether those specific feeds were actually read — see SignalsMeta.
var SignalsFeeds = []string{"subnets", "zones", "leases"}

// SignalsMeta extracts, from an /api/data-shaped `data` map, the subset of
// its "_meta" status ("ok"/"empty"/"error" — the vocabulary fetch_dashboard_data
// already stamps per feed, dashboard.go:266) for the feeds BuildSignals
// depends on, plus a degraded flag set when any of those feeds errored.
//
// This closes the defect where BuildSignals returning zero signals for a
// failed feed (an empty slice looks identical whether the feed was read and
// found clean, or never read at all) was forwarded by /api/incidents with no
// way to tell the two apart — the response confidently read as "no issues
// detected" even when subnets/zones/leases had all 5xx'd. A missing or
// malformed "_meta" entry is itself treated as "error", never silently
// upgraded to "ok".
func SignalsMeta(data map[string]any) (meta map[string]any, degraded bool) {
	full, _ := data["_meta"].(map[string]any)
	meta = map[string]any{}
	for _, feed := range SignalsFeeds {
		status, _ := full[feed].(string)
		if status == "" {
			status = "error"
		}
		meta[feed] = status
		if status == "error" {
			degraded = true
		}
	}
	return meta, degraded
}

// Correlate is correlate (server.py:2489): one incident per category, keeping
// first-appearance order (Python dict insertion order).
func Correlate(signals []map[string]any) []map[string]any {
	if len(signals) == 0 {
		return []map[string]any{}
	}
	order := []string{}
	groups := map[string][]map[string]any{}
	for _, sig := range signals {
		cat := getStr(sig["category"])
		if _, ok := groups[cat]; !ok {
			order = append(order, cat)
		}
		groups[cat] = append(groups[cat], sig)
	}
	incidents := make([]map[string]any, 0, len(order))
	for _, category := range order {
		group := groups[category]
		severity := "ok"
		for _, s := range group {
			if SeverityOrder[getStr(s["severity"])] > SeverityOrder[severity] {
				severity = getStr(s["severity"])
			}
		}
		sample := []any{}
		for i, s := range group {
			if i >= SampleCap {
				break
			}
			sample = append(sample, s["entity_id"])
		}
		// detected_at is absent, not merely stale, on every signal in a
		// degraded StampFirstSeen call (store.go: first_seen_unknown branch) —
		// a bare type assertion here would panic on the very first such poll.
		// Track "have we seen a real timestamp" explicitly instead of assuming
		// group[0] has one.
		var firstDetected float64
		haveFirst := false
		for _, s := range group {
			if f, ok := s["detected_at"].(float64); ok && (!haveFirst || f < firstDetected) {
				firstDetected = f
				haveFirst = true
			}
		}
		inc := map[string]any{
			"key":             category,
			"category":        category,
			"severity":        severity,
			"count":           len(group),
			"sample_entities": sample,
			"message":         fmt.Sprintf("%d %s", len(group), strings.ReplaceAll(category, "-", " ")),
			"entity_type":     group[0]["entity_type"],
		}
		if haveFirst {
			inc["first_detected_at"] = firstDetected
		} else {
			inc["first_seen_unknown"] = true
		}
		incidents = append(incidents, inc)
	}
	return incidents
}

// SortSignalsLive orders signals crit-first then oldest-first (server.py:5118),
// so a truncated tail only ever drops the least-important signals.
func SortSignalsLive(signals []map[string]any) {
	sort.SliceStable(signals, func(i, j int) bool {
		si := SeverityOrder[getStr(signals[i]["severity"])]
		sj := SeverityOrder[getStr(signals[j]["severity"])]
		if si != sj {
			return si > sj
		}
		fi, _ := signals[i]["detected_at"].(float64)
		fj, _ := signals[j]["detected_at"].(float64)
		return fi < fj
	})
}
