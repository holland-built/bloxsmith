package server

import "net/http"

// registerThreatIntelRoutes wires the deferred threat-intel reads:
// /api/dossier (server.py:5227), /api/lookalikes (5236), /api/assets (5221),
// plus /api/axur, which has no Python ancestor — Axur is a separate vendor
// added after the port. Each degrades to an {"...":[], "unavailable": "..."}
// shape on 403/error via the ported fetchers; a genuine panic maps to Python's
// 500 {"error":"internal error"} through recover500.
func (d *Deps) registerThreatIntelRoutes(mux router) {
	mux.HandleFunc("GET /api/dossier", d.dossier)
	mux.HandleFunc("GET /api/lookalikes", d.lookalikes)
	mux.HandleFunc("GET /api/assets", d.assets)
	mux.HandleFunc("GET /api/axur", d.axur)
	mux.HandleFunc("GET /api/kentik/traffic", d.kentikTraffic)
}

func (d *Deps) dossier(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/dossier")
	q := r.URL.Query()
	d.json(w, r, 200, d.dash(r).FetchDossier(q.Get("q"), q.Get("type")))
}

func (d *Deps) lookalikes(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/lookalikes")
	d.json(w, r, 200, d.dash(r).FetchLookalikes())
}

func (d *Deps) assets(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/assets")
	d.json(w, r, 200, d.dash(r).FetchAssets(r.Context()))
}

// axur serves Axur's per-supplier security indicators. Unlike its three
// neighbours it may report configured:false — the integration is optional, and
// an unset AXUR_API_KEY is a deployment choice, not a failure.
//
// d.dash(r) hands over the request-pinned service. Its Axur client is the
// process-wide one by design (dashboard.Service.With): the Axur credential
// belongs to this deployment, not to the Infoblox tenant the request pinned.
func (d *Deps) axur(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/axur")
	d.json(w, r, 200, d.dash(r).FetchAxurVendors())
}

// kentikTraffic serves what Kentik sees one IP doing in the last hour, for the
// search result page. Always 200 with an availability body, like the search
// routes, so the page can tell "not set up" and "failed" from "no traffic".
func (d *Deps) kentikTraffic(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/kentik/traffic")
	d.json(w, r, 200, d.dash(r).FetchKentikTraffic(r.URL.Query().Get("q")))
}
