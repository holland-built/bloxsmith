package server

import (
	"net/http"
	"strconv"

	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/httpx"
)

// registerListRoutes wires Site lists: put domains (from InfoRank, a CSV or
// pasted text) into a custom list, and the list into a security policy.
func (d *Deps) registerListRoutes(mux router) {
	mux.HandleFunc("GET /api/lists/inforank", d.listsInfoRank)
	mux.HandleFunc("GET /api/lists/targets", d.listsTargets)
	mux.HandleFunc("POST /api/lists/apply", d.body(d.listsApply))
}

// listsInfoRank is GET /api/lists/inforank?top=N: the N most popular domains.
func (d *Deps) listsInfoRank(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/lists/inforank")
	n, err := strconv.Atoi(r.URL.Query().Get("top"))
	if err != nil {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "top must be a number"})
		return
	}
	res, err := d.dash(r).InfoRankTop(n)
	if err != nil {
		d.json(w, r, 502, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	res["ok"] = true
	d.json(w, r, 200, res)
}

// listsTargets is GET /api/lists/targets: lists, policies and redirect pages.
func (d *Deps) listsTargets(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/lists/targets")
	res, err := d.dash(r).ListTargets()
	if err != nil {
		d.json(w, r, 502, map[string]any{"ok": false, "error": "could not read the lists and policies from Infoblox"})
		return
	}
	res["ok"] = true
	d.json(w, r, 200, res)
}

// listsApply is POST /api/lists/apply: preview with dry:true, then apply.
// Every live run that sent anything to Infoblox gets an audit row, whatever
// its outcome, because a half-done change is the one most worth finding later.
func (d *Deps) listsApply(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/lists/apply")
	p, err := dashboard.ParseListPlan(b)
	if err != nil {
		d.json(w, r, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	res, status := d.dash(r).ApplyList(p)
	d.json(w, r, status, res)
	if p.Dry || res["outcome"] == nil || res["nothing_to_do"] == true {
		return
	}
	d.auditAppend("site-list-apply", httpx.Actor(r), map[string]any{
		"outcome": res["outcome"], "list": res["list"], "policy_id": p.PolicyID,
		"action": p.Action, "position": p.Position + 1, "domains": len(p.Domains),
		"steps": res["steps"]})
}
