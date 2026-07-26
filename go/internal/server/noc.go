package server

import (
	"context"
	"net/http"
	"strings"
	"time"

	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/httpx"
)

// registerNOCRoutes wires the NOC-signal / analytics / sources surface
// (server.py do_GET 5054-5295): the incidents engine (/api/incidents +
// drill-down), /api/actions, /api/insights, the source
// registry (/api/sources + /api/source/<id>) and the analytics reads
// (/api/dns-analytics, /api/host-metrics, /api/threat-lookup).
func (d *Deps) registerNOCRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/actions", d.actions)
	mux.HandleFunc("GET /api/actions/{id}", d.actionDetail)
	mux.HandleFunc("POST /api/actions/{id}/status", d.body(d.actionStatus))
	mux.HandleFunc("GET /api/incidents", d.incidents)
	mux.HandleFunc("GET /api/incidents/{cat}", d.incidentsCategory)
	mux.HandleFunc("GET /api/insights", d.insights)
	mux.HandleFunc("GET /api/sources", d.sources)
	mux.HandleFunc("GET /api/source/{sid}", d.sourceRows)
	mux.HandleFunc("GET /api/dns-analytics", d.dnsAnalytics)
	mux.HandleFunc("GET /api/host-metrics", d.hostMetrics)
	mux.HandleFunc("GET /api/threat-lookup", d.threatLookup)
}

// actions is GET /api/actions (server.py:5077): the raw IQ Actions payload.
func (d *Deps) actions(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/actions")
	d.json(w, r, 200, d.Dashboard.FetchActions(r.Context()))
}

// actionDetail is GET /api/actions/{id}: a single IQ Action read.
func (d *Deps) actionDetail(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/actions/{id}")
	id := r.PathValue("id")
	d.json(w, r, 200, d.Dashboard.GetAction(r.Context(), id))
}

// actionStatus is POST /api/actions/{id}/status: the first IQ Actions write
// path (resolve/reopen). Gated to operator+; audits both outcomes.
func (d *Deps) actionStatus(w http.ResponseWriter, r *http.Request, b map[string]any) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "id is required"})
		return
	}
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/actions/{id}/status")
	status, _ := b["status"].(string)
	res, err := d.Dashboard.UpdateAction(r.Context(), id, status)
	if err != nil {
		d.json(w, r, 400, map[string]any{"ok": false, "error": err.Error()})
		_, _ = d.Audit.Append("iq-action-resolve-failed", httpx.Actor(r), map[string]any{
			"id": id, "old_status": "unknown", "new_status": status, "error": err.Error()})
		return
	}
	if ok, _ := res["ok"].(bool); !ok {
		// UpdateAction returned a non-error but unconfirmed outcome (e.g. an
		// unparseable upstream response) — surface it as a failure, not a 200.
		d.json(w, r, 502, res)
		_, _ = d.Audit.Append("iq-action-resolve-failed", httpx.Actor(r), map[string]any{
			"id": id, "old_status": res["old_status"], "new_status": res["new_status"],
			"error": res["error"]})
		return
	}
	d.json(w, r, 200, res)
	_, _ = d.Audit.Append("iq-action-resolve", httpx.Actor(r), map[string]any{
		"id": id, "old_status": res["old_status"], "new_status": res["new_status"]})
}

// incidents is GET /api/incidents (server.py:5103): build signals, stamp ages,
// correlate, drop snoozed categories, order + cap the live signal list. On any
// failure it returns the Python default (empty everything), not a generic 500.
func (d *Deps) incidents(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			d.logExc("/api/incidents", rec)
			d.json(w, r, 200, map[string]any{
				"incidents": []any{}, "snoozes": map[string]any{}, "signals": []any{},
				"signals_total": 0, "signals_truncated": false,
			})
		}
	}()
	data := d.Dashboard.FetchDashboardData()
	signals := d.Store.StampFirstSeen(dashboard.BuildSignals(data))
	snoozed := d.Store.ActiveSnoozes()

	incidents := []map[string]any{}
	for _, i := range dashboard.Correlate(signals) {
		if _, ok := snoozed[getCat(i)]; !ok {
			incidents = append(incidents, i)
		}
	}
	live := []map[string]any{}
	for _, s := range signals {
		if _, ok := snoozed[getCat(s)]; !ok {
			live = append(live, s)
		}
	}
	dashboard.SortSignalsLive(live)
	total := len(live)
	truncated := total > dashboard.SignalsCap
	if truncated {
		live = live[:dashboard.SignalsCap]
	}
	d.json(w, r, 200, map[string]any{
		"incidents": incidents, "snoozes": snoozed, "signals": live,
		"signals_total": total, "signals_truncated": truncated,
	})
}

// incidentsCategory is GET /api/incidents/<cat> (server.py:5126): the full
// signal list for one category (fetched on demand). Deliberately NOT filtered by
// snooze — a snoozed category must still be inspectable.
func (d *Deps) incidentsCategory(w http.ResponseWriter, r *http.Request) {
	category := r.PathValue("cat")
	defer func() {
		if rec := recover(); rec != nil {
			d.logExc("/api/incidents/category", rec)
			d.json(w, r, 200, map[string]any{
				"category": category, "count": 0, "truncated": false, "signals": []any{}})
		}
	}()
	data := d.Dashboard.FetchDashboardData()
	matches := []map[string]any{}
	for _, s := range d.Store.StampFirstSeen(dashboard.BuildSignals(data)) {
		if getCat(s) == category {
			matches = append(matches, s)
		}
	}
	count := len(matches)
	out := matches
	if count > 500 {
		out = matches[:500]
	}
	d.json(w, r, 200, map[string]any{
		"category": category, "count": count, "truncated": count > 500, "signals": out})
}

// insights is GET /api/insights (server.py:5203).
func (d *Deps) insights(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/insights")
	d.json(w, r, 200, d.Dashboard.FetchInsights())
}

// sources is GET /api/sources (server.py:5054): registry META only.
func (d *Deps) sources(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/sources")
	d.json(w, r, 200, d.Dashboard.SourcesMeta())
}

// sourceRows is GET /api/source/<id> (server.py:5285): normalized rows for one
// source; 404 on an unknown id (matching Python's status mapping).
func (d *Deps) sourceRows(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	defer d.recover500(w, r, "/api/source/"+sid)
	result := d.Dashboard.SourceRows(r.Context(), sid, queryMap(r))
	status := 200
	if result["error"] == "unknown source" {
		status = 404
	}
	d.json(w, r, status, result)
}

// dnsAnalytics is GET /api/dns-analytics (server.py:5209).
// Overall 15s deadline: the fetch chains several MCP calls (init + 3 cube
// queries), each individually bounded at 12s (mcp.go post) — without a total
// cap a fully-stalled upstream still cost ~4×12s per request.
func (d *Deps) dnsAnalytics(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/dns-analytics")
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	d.json(w, r, 200, d.Dashboard.FetchDNSAnalytics(ctx))
}

// hostMetrics is GET /api/host-metrics (server.py:5215).
func (d *Deps) hostMetrics(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/host-metrics")
	d.json(w, r, 200, d.Dashboard.FetchHostMetrics(r.Context()))
}

// threatLookup is GET /api/threat-lookup (server.py:5251): entity search over
// ?q=; an empty q short-circuits to {"entities":[],"query":""}.
func (d *Deps) threatLookup(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/threat-lookup")
	q := r.URL.Query().Get("q")
	if q == "" {
		d.json(w, r, 200, map[string]any{"entities": []any{}, "query": ""})
		return
	}
	d.json(w, r, 200, d.Dashboard.ThreatLookup(r.Context(), q))
}

// getCat reads a signal/incident category as a string.
func getCat(m map[string]any) string {
	if s, ok := m["category"].(string); ok {
		return s
	}
	return ""
}

// queryMap flattens the query string to {k: first-value}, matching Python's
// {k: v[0] for k, v in parse_qs(...)}.
func queryMap(r *http.Request) map[string]string {
	out := map[string]string{}
	for k, vs := range r.URL.Query() {
		if len(vs) > 0 {
			out[k] = vs[0]
		}
	}
	return out
}
