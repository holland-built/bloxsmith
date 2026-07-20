package server

import "net/http"

// registerCSPRoutes wires the 19 /api/csp/* tile endpoints plus the
// /api/csp-audit search (server.py 5741-5994 / 5143). Each tile is a read-only
// proxy handled by the dashboard.Service (which owns the _norm_* shapers and the
// shared rest.Client); the route layer just returns the body at 200, exactly as
// Python's self._json does. A shaper panic is caught and logged as a 500 via the
// same recover500 guard the /api/data routes use.
func (d *Deps) registerCSPRoutes(mux *http.ServeMux) {
	tile := func(path, label string, fn func() map[string]any) {
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
			defer d.recover500(w, r, label)
			d.json(w, r, 200, fn())
		})
	}
	tile("/api/csp/host-health", "/api/csp/host-health", d.Dashboard.CSPHostHealth)
	tile("/api/csp/onprem-hosts", "/api/csp/onprem-hosts", d.Dashboard.CSPOnpremHosts)
	tile("/api/csp/jobs", "/api/csp/jobs", d.Dashboard.CSPJobs)
	tile("/api/csp/dfp", "/api/csp/dfp", d.Dashboard.CSPDFP)
	tile("/api/csp/maintenance", "/api/csp/maintenance", d.Dashboard.CSPMaintenance)
	tile("/api/csp/threats", "/api/csp/threats", d.Dashboard.CSPThreats)
	tile("/api/csp/ctem-exposure", "/api/csp/ctem-exposure", d.Dashboard.CSPCtemExposure)
	tile("/api/csp/ctem-assets", "/api/csp/ctem-assets", d.Dashboard.CSPCtemAssets)
	tile("/api/csp/exposures", "/api/csp/exposures", d.Dashboard.CSPExposures)
	tile("/api/csp/asset-risk", "/api/csp/asset-risk", d.Dashboard.CSPAssetRisk)
	tile("/api/csp/exposed-hostnames", "/api/csp/exposed-hostnames", d.Dashboard.CSPExposedHostnames)
	tile("/api/csp/exposed-ips", "/api/csp/exposed-ips", d.Dashboard.CSPExposedIPs)
	tile("/api/csp/soc", "/api/csp/soc", d.Dashboard.CSPSoc)
	tile("/api/csp/dns-services", "/api/csp/dns-services", d.Dashboard.CSPDNSServices)
	tile("/api/csp/zones", "/api/csp/zones", d.Dashboard.CSPZones)
	tile("/api/csp/dns-qps", "/api/csp/dns-qps", d.Dashboard.CSPDNSQps)
	tile("/api/csp/ipam-util", "/api/csp/ipam-util", d.Dashboard.CSPIpamUtil)
	tile("/api/csp/dhcp-leases", "/api/csp/dhcp-leases", d.Dashboard.CSPDHCPLeases)
	tile("/api/csp/license-alerts", "/api/csp/license-alerts", d.Dashboard.CSPLicenseAlerts)

	mux.HandleFunc("GET /api/csp-audit", func(w http.ResponseWriter, r *http.Request) {
		defer d.recover500(w, r, "/api/csp-audit")
		q := r.URL.Query()
		d.json(w, r, 200, d.Dashboard.CSPAudit(
			q.Get("q"), q.Get("kind"), q.Get("since"), q.Get("until")))
	})
}
