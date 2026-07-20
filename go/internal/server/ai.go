package server

import "net/http"

// registerAIRoutes wires the Phase 1h natural-language assistant: POST
// /api/query (server.py:6075). It is read-only + LLM-backed, so — like Python —
// it carries NO token requirement and is NOT in the mutating-path set (the
// same-origin CORS allowlist already blocks cross-origin reads).
func (d *Deps) registerAIRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/query", d.body(d.apiQuery))
}

// apiQuery is POST /api/query (server.py:6075): run the LLM tool loop over the
// NOC data and return {answer, suggestions, trace?}. On an internal panic it
// mirrors Python's 500 shape — {"answer": "Error: internal error",
// "suggestions": []} — not the generic {"error": ...} the data routes use.
func (d *Deps) apiQuery(w http.ResponseWriter, r *http.Request, b map[string]any) {
	defer func() {
		if rec := recover(); rec != nil {
			d.logExc("/api/query", rec)
			d.json(w, r, 500, map[string]any{"answer": "Error: internal error", "suggestions": []any{}})
		}
	}()
	result := d.AI.HandleQuery(str(b, "question"), str(b, "context"))
	d.json(w, r, 200, result)
}
