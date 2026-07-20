package server

import "net/http"

// registerDataRoutes wires the Phase 1d read path: /api/data (the dashboard
// aggregation) and the three operator-hub endpoints (server.py:5071/5242-5250).
// Each mirrors Python's handler: on a fetcher panic, log and return a 500 with
// {"error":"internal error"} — the frontend already tolerates that shape.
func (d *Deps) registerDataRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/data", d.apiData)
	mux.HandleFunc("GET /api/hub/health", d.hubHealth)
	mux.HandleFunc("GET /api/hub/security", d.hubSecurity)
	mux.HandleFunc("GET /api/hub/domains", d.hubDomains)
	mux.HandleFunc("GET /api/cache-bust", d.cacheBust)
}

func (d *Deps) apiData(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/data")
	d.json(w, r, 200, d.Dashboard.FetchDashboardData())
}

func (d *Deps) hubHealth(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/hub/health")
	d.json(w, r, 200, d.Dashboard.FetchHubHealth())
}

func (d *Deps) hubSecurity(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/hub/security")
	// server.py:5246 fetch_hub_security() — the route uses the defaults (1h/50).
	d.json(w, r, 200, d.Dashboard.FetchHubSecurity(3600, 50))
}

func (d *Deps) hubDomains(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/hub/domains")
	d.json(w, r, 200, d.Dashboard.FetchHubDomains())
}

// cacheBust is /api/cache-bust (server.py:5265): clear the shared TTL cache.
func (d *Deps) cacheBust(w http.ResponseWriter, r *http.Request) {
	d.Cache.Invalidate()
	d.json(w, r, 200, map[string]any{"ok": true, "message": "Cache cleared"})
}

// recover500 turns a fetcher panic into Python's logged 500 (self._json(...,500)
// inside the except). Used as a deferred guard on each data handler.
func (d *Deps) recover500(w http.ResponseWriter, r *http.Request, label string) {
	if rec := recover(); rec != nil {
		d.logExc(label, rec)
		d.json(w, r, 500, map[string]any{"error": "internal error"})
	}
}
