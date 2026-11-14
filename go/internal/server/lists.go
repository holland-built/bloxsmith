package server

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/sitelists"
)

// registerListRoutes wires Site lists: put domains (from InfoRank, a CSV or
// pasted text) into a custom list, and the list into a security policy.
func (d *Deps) registerListRoutes(mux router) {
	mux.HandleFunc("GET /api/lists/inforank", d.listsInfoRank)
	mux.HandleFunc("GET /api/lists/busiest", d.listsBusiest)
	mux.HandleFunc("GET /api/lists/never-add", d.listsNeverAddGet)
	mux.HandleFunc("POST /api/lists/never-add", d.body(d.listsNeverAddSet))
	mux.HandleFunc("GET /api/lists/targets", d.listsTargets)
	mux.HandleFunc("GET /api/lists/items", d.listsItems)
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
	// The never-add list is applied here, from the saved list as it is now,
	// so it holds whatever the page sent. The fingerprint covers the sites
	// that are left, so if a change to the list after the preview changes
	// which sites go in, Apply refuses.
	never, err := d.neverAdd()
	if err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "could not read the never-add list, so nothing was sent"})
		return
	}
	var leftOut []string
	p.Domains, leftOut = dashboard.NeverAdd(p.Domains, never)
	if len(p.Domains) == 0 {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "every site is on the never-add list"})
		return
	}
	p.WantSites = !p.Dry // the sites that went in are recorded below
	res, status := d.dash(r).ApplyList(p)
	res["never_add_left_out"] = len(leftOut)
	d.json(w, r, status, res)
	if !p.Dry {
		name := p.ListName
		if lst, _ := res["list"].(map[string]any); lst != nil && anyStr(lst["name"]) != "" {
			name = anyStr(lst["name"])
		}
		d.recordMade(r, "lists", "Site list "+name, listsMade(res, p.PolicyID, p.Action), anyStr(res["error"]), res["ok"] == true)
	}
	if p.Dry || res["outcome"] == nil || res["nothing_to_do"] == true {
		return
	}
	d.auditAppend("site-list-apply", httpx.Actor(r), map[string]any{
		"outcome": res["outcome"], "list": res["list"], "policy_id": p.PolicyID,
		"action": p.Action, "position": p.Position + 1, "domains": len(p.Domains),
		"steps": res["steps"]})
}

// listsBusiest is GET /api/lists/busiest?top=N: the N sites this tenant looked
// up most in the last 7 days.
func (d *Deps) listsBusiest(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/lists/busiest")
	n, err := strconv.Atoi(r.URL.Query().Get("top"))
	if err != nil {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "top must be a number"})
		return
	}
	res, err := d.dash(r).BusiestSites(n)
	if err != nil {
		d.json(w, r, 502, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	res["ok"] = true
	d.json(w, r, 200, res)
}

// siteState opens site_lists.json beside vault.json on first use.
func (d *Deps) siteState() *sitelists.State {
	d.siteListsOnce.Do(func() {
		if d.SiteLists == nil && d.StateDir != "" {
			d.SiteLists = sitelists.Open(d.StateDir)
		}
	})
	return d.SiteLists
}

// neverAdd is the never-add list of the tenant in use.
func (d *Deps) neverAdd() ([]string, error) {
	st := d.siteState()
	if st == nil {
		return nil, nil
	}
	tenant, _ := d.writeIdentity()
	return st.NeverAdd(tenant)
}

// listsNeverAddGet is GET /api/lists/never-add.
func (d *Deps) listsNeverAddGet(w http.ResponseWriter, r *http.Request) {
	never, err := d.neverAdd()
	if err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "could not read the never-add list"})
		return
	}
	if never == nil {
		never = []string{}
	}
	d.json(w, r, 200, map[string]any{"ok": true, "sites": never})
}

// listsNeverAddSet is POST /api/lists/never-add {sites}: replaces the list.
// It is Bloxsmith's own file, so it is allowed on read-only tenants too.
func (d *Deps) listsNeverAddSet(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	st := d.siteState()
	if st == nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "there is nowhere to keep the list"})
		return
	}
	raw, ok := b["sites"].([]any)
	if !ok {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "sites must be a list"})
		return
	}
	if len(raw) > sitelists.MaxNeverAdd {
		d.json(w, r, 400, map[string]any{"ok": false, "error": fmt.Sprintf("at most %d sites", sitelists.MaxNeverAdd)})
		return
	}
	sites := make([]string, 0, len(raw))
	var bad []string
	for _, v := range raw {
		s, _ := v.(string)
		if !dashboard.IsDomain(s) {
			if len(bad) < 10 {
				bad = append(bad, fmt.Sprintf("%q", s))
			}
			continue
		}
		sites = append(sites, s)
	}
	if len(bad) > 0 {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "these are not domain names: " + strings.Join(bad, ", ")})
		return
	}
	tenant, _ := d.writeIdentity()
	saved, err := st.SetNeverAdd(tenant, sites)
	if err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "could not save the never-add list"})
		return
	}
	d.json(w, r, 200, map[string]any{"ok": true, "sites": saved})
}

// listsItems is GET /api/lists/items?id=N: one custom list's sites, for
// removing them one at a time through the Made with Bloxsmith delete check.
func (d *Deps) listsItems(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/lists/items")
	n, err := strconv.Atoi(r.URL.Query().Get("id"))
	if err != nil || n <= 0 {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "pick a list"})
		return
	}
	res, st, err := d.dash(r).ListItems(n)
	if err != nil {
		d.json(w, r, statusOr502(st), map[string]any{"ok": false, "error": err.Error()})
		return
	}
	res["ok"] = true
	d.json(w, r, 200, res)
}
