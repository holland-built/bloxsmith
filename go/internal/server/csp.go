package server

import (
	"net/http"

	"bloxsmith/internal/dashboard"
)

// registerCSPRoutes wires the 19 /api/csp/* tile endpoints plus the
// /api/csp-audit search (server.py 5741-5994 / 5143). Each tile is a read-only
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
}
