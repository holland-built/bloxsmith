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

	return signals
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
		firstDetected := group[0]["detected_at"].(float64)
		for _, s := range group {
			if f, ok := s["detected_at"].(float64); ok && f < firstDetected {
				firstDetected = f
			}
		}
		incidents = append(incidents, map[string]any{
			"key":               category,
			"category":          category,
			"severity":          severity,
			"count":             len(group),
			"sample_entities":   sample,
			"first_detected_at": firstDetected,
			"message":           fmt.Sprintf("%d %s", len(group), strings.ReplaceAll(category, "-", " ")),
			"entity_type":       group[0]["entity_type"],
		})
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
