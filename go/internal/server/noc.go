package server

import (
	"net/http"

	"bloxsmith/internal/dashboard"
)

// registerNOCRoutes wires the NOC-signal / analytics / sources surface
// (server.py do_GET 5054-5295): the incidents engine (/api/incidents +
// drill-down), /api/actions, /api/insights, /api/mcp/events, the source
// registry (/api/sources + /api/source/<id>) and the analytics reads
// (/api/dns-analytics, /api/host-metrics, /api/threat-lookup).
func (d *Deps) registerNOCRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/actions", d.actions)
	mux.HandleFunc("GET /api/incidents", d.incidents)
	mux.HandleFunc("GET /api/incidents/{cat}", d.incidentsCategory)
	mux.HandleFunc("GET /api/insights", d.insights)
	mux.HandleFunc("GET /api/mcp/events", d.mcpEvents)
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

// mcpEvents is GET /api/mcp/events (server.py:5197): a bare list, [] on error.
func (d *Deps) mcpEvents(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			d.logExc("/api/mcp/events", rec)
			d.json(w, r, 200, []any{})
		}
	}()
	d.json(w, r, 200, d.Dashboard.FetchMCPEvents(r.Context(), 50, 0))
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
func (d *Deps) dnsAnalytics(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/dns-analytics")
	d.json(w, r, 200, d.Dashboard.FetchDNSAnalytics(r.Context()))
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
