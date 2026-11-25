// Connection health: each discovery connection (AWS, Azure, GCP, Active
// Directory...) and whether its last sync worked, failing ones first.
//
// FACTS MEASURED against the live tenant on 2026-11-17:
//
//   - GET /api/cloud_discovery/v2/providers?_limit=200 returned 26 connections
//     (86 KB): 13 Error, 10 Synced, 2 partiallysynced, 1 Disabled.
//   - status_message can run to several lines ("Asset Discovery and sync
//     completed successfully\nDNS sync has failed partially: ...").
//   - Asking for fewer fields with _fields BREAKS the answer: every status read
//     "Disabled" and last_sync and status_message went missing. So the whole
//     record is read, and only the fields the panel shows are passed on.
//
// Read-only: nothing here changes a connection.
package dashboard

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

const (
	connectorPath = "/api/cloud_discovery/v2/providers"
	// connectorLimit is one page. A full page may mean there are more, and
	// the panel says so.
	connectorLimit = 200
)

// connectorOrder is the order states are listed in: what needs a look first.
var connectorOrder = map[string]int{"failing": 0, "partial": 1, "unknown": 2, "syncing": 3, "ok": 4, "off": 5}

// connectorState turns the API's status into one of six states and the word
// the page shows for it. A status this app has not seen is shown as it came.
func connectorState(status string, disabled bool) (state, word string) {
	if disabled {
		return "off", "Turned off"
	}
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "error", "failed", "failure":
		return "failing", "Failing"
	case "partiallysynced", "partially_synced", "partial":
		return "partial", "Partly working"
	case "inprogress", "in_progress", "pending", "syncing", "running":
		return "syncing", "Syncing"
	case "synced", "success", "completed":
		return "ok", "Working"
	case "disabled":
		return "off", "Turned off"
	case "":
		return "unknown", "Unknown"
	}
	return "unknown", strings.TrimSpace(status)
}

// assembleConnectors is pure: the API rows in, the panel's list out.
func assembleConnectors(rows []any, err error) map[string]any {
	if rows == nil {
		reason := "the connection list could not be read"
		var ue *rest.UpstreamError
		if errors.As(err, &ue) {
			reason = ue.Public()
		}
		return map[string]any{"availability": "error", "reason": reason, "connectors": []map[string]any{}}
	}
	list := make([]map[string]any, 0, len(rows))
	counts := map[string]int{}
	for _, raw := range rows {
		r, _ := raw.(map[string]any)
		if r == nil {
			continue
		}
		disabled, _ := r["is_disabled"].(bool)
		status := getStr(r["status"])
		state, word := connectorState(status, disabled)
		counts[state]++
		list = append(list, map[string]any{
			"name":      getStr(r["name"]),
			"type":      getStr(r["provider_type"]),
			"status":    status,
			"state":     state,
			"word":      word,
			"last_sync": getStr(r["last_sync"]),
			"message":   strings.TrimSpace(getStr(r["status_message"])),
		})
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, b := connectorOrder[list[i]["state"].(string)], connectorOrder[list[j]["state"].(string)]
		if a != b {
			return a < b
		}
		return strings.ToLower(list[i]["name"].(string)) < strings.ToLower(list[j]["name"].(string))
	})
	return map[string]any{
		"availability": "ok",
		"connectors":   list,
		"counts":       counts,
		"truncated":    len(rows) >= connectorLimit,
	}
}

var errConnectorsDegraded = errors.New("assets: connection list read failed — not cached")

// FetchConnectorHealth is the /api/csp/asset-connectors read. A failed read
// is not cached, so the next visit asks again.
func (s *Service) FetchConnectorHealth(ctx context.Context) map[string]any {
	if s.Rest == nil {
		return assembleConnectors(nil, nil)
	}
	v, _ := s.Cache.DoFresh(cache.Key("assets", "connectors", nil, false), func() (any, error) {
		rows, _, err := s.Rest.GetPageStrictCtx(ctx, connectorPath, map[string]string{"_limit": strconv.Itoa(connectorLimit)})
		res := assembleConnectors(rows, err)
		if res["availability"] == "error" {
			return res, errConnectorsDegraded
		}
		return res, nil
	})
	out, ok := v.(map[string]any)
	if !ok {
		return assembleConnectors(nil, nil)
	}
	return out
}
