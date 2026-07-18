package server

import "net/http"

// registerThreatIntelRoutes wires the three deferred threat-intel reads:
// /api/dossier (server.py:5227), /api/lookalikes (5236), /api/assets (5221).
// Each degrades to an {"...":[], "unavailable": "..."} shape on 403/error via
// the ported fetchers; a genuine panic maps to Python's 500 {"error":"internal
// error"} through recover500.
func (d *Deps) registerThreatIntelRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/dossier", d.dossier)
	mux.HandleFunc("GET /api/lookalikes", d.lookalikes)
	mux.HandleFunc("GET /api/assets", d.assets)
}

func (d *Deps) dossier(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/dossier")
	q := r.URL.Query()
	d.json(w, r, 200, d.Dashboard.FetchDossier(q.Get("q"), q.Get("type")))
}

func (d *Deps) lookalikes(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/lookalikes")
	d.json(w, r, 200, d.Dashboard.FetchLookalikes())
}

func (d *Deps) assets(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/assets")
	d.json(w, r, 200, d.Dashboard.FetchAssets(r.Context()))
}
