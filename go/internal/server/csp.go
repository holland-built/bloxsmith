package server

import (
	"net/http"
	"strconv"

	"bloxsmith/internal/dashboard"
)

// registerCSPRoutes wires the /api/csp/* tile endpoints plus the
// /api/csp-audit search (server.py 5741-5994 / 5143), the two scalar-count
// tiles, and the three Assets-tab reads at the bottom. (This used to open
// "the 19 tile endpoints"; there were 20 tile() calls even before this
// change. A hand-maintained count in a doc comment is wrong the first time
// anyone adds a route, so it is gone rather than corrected.)
// Each tile is a read-only
// proxy handled by the dashboard.Service (which owns the _norm_* shapers and the
// shared rest.Client); the route layer just returns the body at 200, exactly as
// Python's self._json does. A shaper panic is caught and logged as a 500 via the
// same recover500 guard the /api/data routes use.
func (d *Deps) registerCSPRoutes(mux router) {
	// fn is a METHOD EXPRESSION, not a bound method value: the service it runs
	// against is chosen per request, so each tile reads the tenant that request
	// started against rather than whichever one is active when it fires.
	tile := func(path string, fn func(*dashboard.Service) map[string]any) {
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
			defer d.recover500(w, r, path)
			d.json(w, r, 200, fn(d.dash(r)))
		})
	}
	tile("/api/csp/host-health", (*dashboard.Service).CSPHostHealth)
	tile("/api/csp/onprem-hosts", (*dashboard.Service).CSPOnpremHosts)
	tile("/api/csp/jobs", (*dashboard.Service).CSPJobs)
	tile("/api/csp/dfp", (*dashboard.Service).CSPDFP)
	tile("/api/csp/maintenance", (*dashboard.Service).CSPMaintenance)
	tile("/api/csp/threats", (*dashboard.Service).CSPThreats)
	tile("/api/csp/ctem-exposure", (*dashboard.Service).CSPCtemExposure)
	tile("/api/csp/ctem-assets", (*dashboard.Service).CSPCtemAssets)
	tile("/api/csp/exposures", (*dashboard.Service).CSPExposures)
	tile("/api/csp/asset-risk", (*dashboard.Service).CSPAssetRisk)
	tile("/api/csp/exposed-hostnames", (*dashboard.Service).CSPExposedHostnames)
	tile("/api/csp/exposed-ips", (*dashboard.Service).CSPExposedIPs)
	tile("/api/csp/dns-services", (*dashboard.Service).CSPDNSServices)
	tile("/api/csp/dns-qps", (*dashboard.Service).CSPDNSQps)
	tile("/api/csp/ipam-util", (*dashboard.Service).CSPIpamUtil)
	tile("/api/csp/dhcp-leases", (*dashboard.Service).CSPDHCPLeases)
	tile("/api/csp/license-alerts", (*dashboard.Service).CSPLicenseAlerts)
	tile("/api/csp/dnssec", (*dashboard.Service).CSPDnssec)
	tile("/api/csp/rpz", (*dashboard.Service).CSPRpz)
	tile("/api/csp/dtc-lbdn", (*dashboard.Service).CSPDtcLbdn)

	mux.HandleFunc("GET /api/csp-audit", func(w http.ResponseWriter, r *http.Request) {
		defer d.recover500(w, r, "/api/csp-audit")
		q := r.URL.Query()
		d.json(w, r, 200, d.dash(r).CSPAudit(
			q.Get("q"), q.Get("kind"), q.Get("since"), q.Get("until")))
	})

	mux.HandleFunc("GET /api/csp/discovery-status", func(w http.ResponseWriter, r *http.Request) {
		defer d.recover500(w, r, "/api/csp/discovery-status")
		d.json(w, r, 200, d.dash(r).CSPDiscoveryStatus(r.Context()))
	})
	mux.HandleFunc("GET /api/csp/asset-insights", func(w http.ResponseWriter, r *http.Request) {
		defer d.recover500(w, r, "/api/csp/asset-insights")
		d.json(w, r, 200, d.dash(r).CSPAssetInsights(r.Context()))
	})

	// --- Assets tab ----------------------------------------------------------
	//
	// These three cannot use the tile() helper above: tile() takes a
	// parameterless method, and all three of these read either the request
	// context or the query string. They follow the same shape by hand — same
	// recover500 guard, same d.dash(r) per-request service, same 200-with-a-
	// status-carrying-body contract.
	//
	// WHY EVERY FAILURE IS STILL A 200. Every route in this file answers 200
	// and puts the verdict in the body (availability/status). That is not
	// laziness about status codes: the browser's useApi treats a non-2xx as a
	// transport error with no body, which would collapse "the upstream feed
	// failed, here is why" into the same generic state as "the dashboard
	// itself is unreachable" — and the reason string, which is the whole point
	// of the could-not-look contract, would never reach the screen.

	// Paging/filtering/sorting are ALL server-side. Doing any of it in the
	// browser would mean shipping all 2,620 assets to filter 50 of them, and
	// the cube can already do the work.
	mux.HandleFunc("GET /api/csp/assets", func(w http.ResponseWriter, r *http.Request) {
		defer d.recover500(w, r, "/api/csp/assets")
		q := r.URL.Query()
		// A non-numeric or negative page becomes 0 rather than a 400.
		// normalizeAssetQuery owns every other validation decision, including
		// the sort whitelist — this layer deliberately validates nothing, so
		// there is exactly one place to read to know what is accepted.
		page, err := strconv.Atoi(q.Get("page"))
		if err != nil || page < 0 {
			page = 0
		}
		d.json(w, r, 200, d.dash(r).FetchAssetInventory(
			r.Context(), q.Get("q"), q.Get("type"), q.Get("sort"), q.Get("dir"), page))
	})

	mux.HandleFunc("GET /api/csp/asset-filters", func(w http.ResponseWriter, r *http.Request) {
		defer d.recover500(w, r, "/api/csp/asset-filters")
		d.json(w, r, 200, d.dash(r).FetchAssetFilters(r.Context()))
	})

	mux.HandleFunc("GET /api/csp/asset-detail", func(w http.ResponseWriter, r *http.Request) {
		defer d.recover500(w, r, "/api/csp/asset-detail")
		d.json(w, r, 200, d.dash(r).FetchAssetDetail(r.Context(), r.URL.Query().Get("cqid")))
	})
}
