package server

import (
	"net/http"
	"sort"
	"strings"

	"bloxsmith/internal/dashboard"
)

// registerDataRoutes wires the Phase 1d read path: /api/data (the dashboard
// aggregation) and the three operator-hub endpoints (server.py:5071/5242-5250).
// Each mirrors Python's handler: on a fetcher panic, log and return a 500 with
// {"error":"internal error"} — the frontend already tolerates that shape.
func (d *Deps) registerDataRoutes(mux router) {
	mux.HandleFunc("GET /api/data", d.apiData)
	mux.HandleFunc("GET /api/hub/health", d.hubHealth)
	mux.HandleFunc("GET /api/hub/security", d.hubSecurity)
	mux.HandleFunc("GET /api/hub/domains", d.hubDomains)
	mux.HandleFunc("GET /api/service-inventory", d.serviceInventory)
	mux.HandleFunc("GET /api/cache-bust", d.cacheBust)
}

// apiData is /api/data. ?only=a,b narrows the read to those slices plus their
// dependency closure; the response then contains EXACTLY the slices that were
// read, in both the data map and _meta. A slice nobody asked for is absent —
// the client must treat absence as "not asked for", never as "you have none".
//
// An unknown slice name is a 400, never a 200 that is quietly thinner than
// asked for: a typo'd slice name that returned a success would render as an
// empty panel, which is exactly the impersonation this endpoint must not allow.
func (d *Deps) apiData(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/data")
	only, unknown := parseOnly(r.URL.Query().Get("only"))
	if len(unknown) > 0 {
		d.json(w, r, 400, map[string]any{
			"error":   "unknown slice(s) in ?only=: " + strings.Join(unknown, ", "),
			"unknown": unknown,
			"valid":   dashboard.DataSlices(),
		})
		return
	}
	d.json(w, r, 200, d.dash(r).FetchDashboardData(only))
}

// parseOnly splits the ?only= parameter into a sorted, deduped slice list plus
// the names that are not slices at all. A missing or blank parameter yields a
// nil list, which FetchDashboardData treats as "the whole aggregate" — the
// untouched pre-existing path.
func parseOnly(raw string) (only []string, unknown []string) {
	seen := map[string]bool{}
	for _, name := range strings.Split(raw, ",") {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		if !dashboard.ValidSlice(name) {
			unknown = append(unknown, name)
			continue
		}
		only = append(only, name)
	}
	sort.Strings(only)
	sort.Strings(unknown)
	return only, unknown
}

func (d *Deps) hubHealth(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/hub/health")
	d.json(w, r, 200, d.dash(r).FetchHubHealth())
}

func (d *Deps) hubSecurity(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/hub/security")
	// server.py:5246 fetch_hub_security() — the route uses the defaults (1h/50).
	d.json(w, r, 200, d.dash(r).FetchHubSecurity(3600, 50))
}

func (d *Deps) hubDomains(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/hub/domains")
	d.json(w, r, 200, d.dash(r).FetchHubDomains())
}

// serviceInventory is /api/service-inventory: the raw owned service_type set,
// for deciding which panels a tenant has no services behind. It answers 200
// even when the upstream feed is dead — availability carries that, and the
// caller must fail open on anything other than "ok". A 5xx here would be read
// by a fetch() as "no data", which is the outcome this endpoint exists to
// prevent.
func (d *Deps) serviceInventory(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/service-inventory")
	d.json(w, r, 200, d.dash(r).FetchServiceInventory())
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
