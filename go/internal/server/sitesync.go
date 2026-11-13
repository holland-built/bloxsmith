package server

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/runs"
	"bloxsmith/internal/sitelists"
)

// The daily proposal for Site lists (owner, 2026-11-13): each day, propose the
// sites to add to a list from the top sites, and the sites to drop, shown on
// Overview; nothing changes until the owner approves it. There is no timer: a
// proposal is worked out when Overview or Site lists asks and the last one is
// over syncEvery old, so it runs whenever the app is in use. It only reads
// Infoblox. It proposes dropping only sites the sync itself added.

const syncEvery = 20 * time.Hour

var syncUses = map[string]bool{"inforank": true, "network": true, "both": true, "either": true}

func (d *Deps) registerSyncRoutes(mux router) {
	mux.HandleFunc("GET /api/lists/watches", d.listsWatches)
	mux.HandleFunc("POST /api/lists/watch", d.body(d.listsWatchSet))
	mux.HandleFunc("GET /api/lists/proposals", d.listsProposals)
	mux.HandleFunc("POST /api/lists/proposal/apply", d.body(d.listsProposalApply))
}

// listsWatches is GET /api/lists/watches: the lists with a daily proposal.
func (d *Deps) listsWatches(w http.ResponseWriter, r *http.Request) {
	st := d.siteState()
	if st == nil {
		d.json(w, r, 200, map[string]any{"ok": true, "watches": map[string]any{}})
		return
	}
	tenant, _ := d.writeIdentity()
	ws, err := st.Watches(tenant)
	if err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "could not read the daily proposal settings"})
		return
	}
	if ws == nil {
		ws = map[string]sitelists.Watch{}
	}
	d.json(w, r, 200, map[string]any{"ok": true, "watches": ws})
}

// listsWatchSet is POST /api/lists/watch: turn the daily proposal for one
// list on (with what fills it) or off. Bloxsmith's own file, so it works on
// read-only tenants; approving a proposal is the gated part.
func (d *Deps) listsWatchSet(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	st := d.siteState()
	if st == nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "there is nowhere to keep the setting"})
		return
	}
	listID, ok := intArg(b["list_id"])
	if !ok || listID <= 0 {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "pick a list"})
		return
	}
	on := b["on"] != false
	next := sitelists.Watch{ListID: listID, ListName: strings.TrimSpace(anyStr(b["list_name"])), Use: anyStr(b["use"]),
		Action: anyStr(b["action"]), RedirectName: strings.TrimSpace(anyStr(b["redirect_name"]))}
	next.Top, _ = intArg(b["top"])
	next.PolicyID, _ = intArg(b["policy_id"])
	if on {
		_, okAction := dashboard.ListActions[next.Action]
		switch {
		case !syncUses[next.Use]:
			d.json(w, r, 400, map[string]any{"ok": false, "error": "pick which top sites fill the list"})
			return
		case next.Top < 1 || next.Top > dashboard.MaxListDomains:
			d.json(w, r, 400, map[string]any{"ok": false, "error": fmt.Sprintf("how many must be from 1 to %d", dashboard.MaxListDomains)})
			return
		case next.PolicyID <= 0 || !okAction:
			d.json(w, r, 400, map[string]any{"ok": false, "error": "pick the policy and what it does with the list"})
			return
		}
	}
	tenant, _ := d.writeIdentity()
	err := st.UpdateWatch(tenant, strconv.Itoa(listID), func(cur sitelists.Watch, had bool) (sitelists.Watch, bool, error) {
		if !on {
			return cur, false, nil
		}
		if had {
			// What the sync added stays its own to drop later; a changed
			// setting is worked out again on the next look.
			next.Added = cur.Added
		}
		return next, true, nil
	})
	if err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "could not save the setting"})
		return
	}
	d.json(w, r, 200, map[string]any{"ok": true, "on": on})
}

// listsProposals is GET /api/lists/proposals: the waiting proposals, each
// worked out again first when it is over syncEvery old.
func (d *Deps) listsProposals(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/lists/proposals")
	st := d.siteState()
	if st == nil {
		d.json(w, r, 200, map[string]any{"ok": true, "proposals": []any{}})
		return
	}
	tenant, unknown := d.writeIdentity()
	if unknown != "" {
		d.json(w, r, 200, map[string]any{"ok": true, "proposals": []any{}})
		return
	}
	// One look at a time, so two pages opening together do not both work it out.
	d.syncMu.Lock()
	defer d.syncMu.Unlock()
	ws, err := st.Watches(tenant)
	if err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "could not read the daily proposal settings"})
		return
	}
	never, err := d.neverAdd()
	if err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "could not read the never-add list"})
		return
	}
	now := time.Now().UTC()
	out := []any{}
	ids := make([]string, 0, len(ws))
	for id := range ws {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		wt := ws[id]
		if last, err := time.Parse(time.RFC3339, wt.Checked); err != nil || now.Sub(last) >= syncEvery {
			p := d.workOutProposal(r, wt, never, now)
			_ = st.UpdateWatch(tenant, id, func(cur sitelists.Watch, had bool) (sitelists.Watch, bool, error) {
				if !had {
					return cur, false, nil
				}
				cur.Checked, cur.Proposal = p.At, p
				return cur, true, nil
			})
			wt.Checked, wt.Proposal = p.At, p
		}
		if p := wt.Proposal; p != nil && (len(p.Add) > 0 || len(p.Drop) > 0 || p.Error != "") {
			out = append(out, map[string]any{"list_id": wt.ListID, "list_name": wt.ListName, "proposal": p})
		}
	}
	d.json(w, r, 200, map[string]any{"ok": true, "proposals": out})
}

// workOutProposal reads the top sites and the list and says what would change.
// It only reads. A site flagged by the threat check, or one the check could
// not look up, is left out of the proposal and named in it.
func (d *Deps) workOutProposal(r *http.Request, wt sitelists.Watch, never []string, now time.Time) *sitelists.Proposal {
	p := &sitelists.Proposal{At: now.Format(time.RFC3339), Since: wt.Checked, Add: []string{}, Drop: []string{}}
	svc := d.dash(r)
	var ir, nw []string
	if wt.Use != "network" {
		res, err := svc.InfoRankTop(wt.Top)
		if err != nil {
			p.Error = "could not get the InfoRank list: " + err.Error()
			return p
		}
		ir, _ = res["domains"].([]string)
	}
	if wt.Use != "inforank" {
		res, err := svc.BusiestSites(wt.Top)
		if err != nil {
			p.Error = "could not get your network's busiest sites: " + err.Error()
			return p
		}
		nw, _ = res["domains"].([]string)
	}
	top, _ := dashboard.NeverAdd(pickTop(wt.Use, ir, nw), never)
	list, _, err := svc.ListItems(wt.ListID)
	if err != nil {
		p.Error = "could not read the list " + wt.ListName + ": " + err.Error()
		return p
	}
	have := map[string]bool{}
	for _, s := range list["items"].([]string) {
		have[s] = true
	}
	inTop := map[string]bool{}
	var add []string
	for _, s := range top {
		inTop[s] = true
		if !have[s] {
			add = append(add, s)
		}
	}
	for _, s := range wt.Added {
		if have[s] && !inTop[s] {
			p.Drop = append(p.Drop, s)
		}
	}
	risky, unchecked, reason := svc.CheckSites(add)
	out := map[string]bool{}
	for _, t := range risky {
		out[t.Domain] = true
		p.Risky = append(p.Risky, map[string]any{"domain": t.Domain, "class": t.Class, "level": t.Level})
	}
	for _, s := range unchecked {
		out[s] = true
	}
	p.Unchecked, p.Reason = len(unchecked), reason
	for _, s := range add {
		if !out[s] {
			p.Add = append(p.Add, s)
		}
	}
	return p
}

// pickTop is the Site lists "which go in" choice, the same as the page's.
func pickTop(use string, ir, nw []string) []string {
	inIR, inNW := map[string]bool{}, map[string]bool{}
	for _, s := range ir {
		inIR[s] = true
	}
	for _, s := range nw {
		inNW[s] = true
	}
	switch use {
	case "inforank":
		return ir
	case "network":
		return nw
	case "both":
		var out []string
		for _, s := range ir {
			if inNW[s] {
				out = append(out, s)
			}
		}
		return out
	}
	out := append([]string{}, ir...)
	for _, s := range nw {
		if !inIR[s] {
			out = append(out, s)
		}
	}
	return out
}

// listsProposalApply is POST /api/lists/proposal/apply {list_id, at, dry,
// fingerprint}: preview, then make, the waiting proposal for one list. The
// adds go through Site lists' own preview and fingerprint (never-add list and
// threat check included); the drops are the proposal's, bound by its time.
func (d *Deps) listsProposalApply(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/lists/proposal/apply")
	st := d.siteState()
	listID, ok := intArg(b["list_id"])
	if st == nil || !ok {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "pick a proposal"})
		return
	}
	tenant, _ := d.writeIdentity()
	ws, err := st.Watches(tenant)
	if err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "could not read the daily proposal settings"})
		return
	}
	wt, ok := ws[strconv.Itoa(listID)]
	if !ok || wt.Proposal == nil || wt.Proposal.Error != "" || wt.Proposal.At != anyStr(b["at"]) {
		d.json(w, r, 409, map[string]any{"ok": false, "error": "this proposal is no longer the latest. Look at it again"})
		return
	}
	prop := wt.Proposal
	dry := b["dry"] != false
	never, err := d.neverAdd()
	if err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "could not read the never-add list, so nothing was sent"})
		return
	}
	adds, _ := dashboard.NeverAdd(prop.Add, never)
	out := map[string]any{"ok": true, "list": map[string]any{"id": wt.ListID, "name": wt.ListName}, "drop": prop.Drop, "dry_run": dry}
	if !dry && len(adds) > 0 && anyStr(b["fingerprint"]) == "" {
		d.json(w, r, 409, map[string]any{"ok": false, "error": "preview first"})
		return
	}
	added := []string{}
	if len(adds) > 0 {
		plan := dashboard.ListPlan{Domains: adds, ListID: wt.ListID, PolicyID: wt.PolicyID, Action: wt.Action,
			RedirectName: wt.RedirectName, Dry: dry, Fingerprint: anyStr(b["fingerprint"]), WantSites: true}
		res, status := d.dash(r).ApplyList(plan)
		if pol, _ := res["policy"].(map[string]any); dry && res["ok"] == true && pol["adds_rule"] == true {
			d.json(w, r, 409, map[string]any{"ok": false, "error": "the policy no longer uses " + wt.ListName + " in the same way. Set the list up again on Site lists"})
			return
		}
		out["add"] = res
		added, _ = res["to_add"].([]string)
		if res["ok"] != true {
			out["ok"], out["error"] = false, res["error"]
			if !dry && len(added) > 0 {
				// Some may have gone in before it stopped: the ones now in the
				// list are the sync's own, or a later drop would never find them.
				have, _ := d.listNow(r, wt.ListID)
				d.finishSync(r, tenant, wt, keepIf(added, have), nil, false, out)
			}
			d.json(w, r, status, out)
			return
		}
		out["fingerprint"] = res["fingerprint"]
	}
	if dry {
		d.json(w, r, 200, out)
		return
	}
	dropped := []string{}
	if len(prop.Drop) > 0 {
		res, status := d.dash(r).RemoveListItems(wt.ListID, prop.Drop)
		out["drop_result"] = res
		if res["ok"] != true {
			out["ok"], out["error"] = false, res["error"]
			// The ones no longer in the list did go.
			if have, ok := d.listNow(r, wt.ListID); ok {
				dropped = keepIf(prop.Drop, func(s string) bool { return !have(s) })
			}
			d.finishSync(r, tenant, wt, added, dropped, false, out)
			d.json(w, r, status, out)
			return
		}
		dropped = prop.Drop
	}
	d.finishSync(r, tenant, wt, added, dropped, true, out)
	d.json(w, r, 200, out)
}

// listNow reads the list's sites; ok is false when it cannot be read, and then
// nothing counts as present.
func (d *Deps) listNow(r *http.Request, id int) (func(string) bool, bool) {
	l, _, err := d.dash(r).ListItems(id)
	if err != nil {
		return func(string) bool { return false }, false
	}
	have := map[string]bool{}
	for _, s := range l["items"].([]string) {
		have[s] = true
	}
	return func(s string) bool { return have[s] }, true
}

func keepIf(xs []string, ok func(string) bool) []string {
	out := []string{}
	for _, x := range xs {
		if ok(x) {
			out = append(out, x)
		}
	}
	return out
}

// finishSync records what an approved proposal did: the sites it added become
// the sync's own and the dropped ones stop being. done clears the proposal; a
// run that stopped part way leaves it, so approving again finishes the rest.
// A failure to save that is said in out, because the change itself happened.
func (d *Deps) finishSync(r *http.Request, tenant string, wt sitelists.Watch, added, dropped []string, done bool, out map[string]any) {
	gone := map[string]bool{}
	for _, s := range dropped {
		gone[s] = true
	}
	err := d.siteState().UpdateWatch(tenant, strconv.Itoa(wt.ListID), func(cur sitelists.Watch, had bool) (sitelists.Watch, bool, error) {
		if !had {
			return cur, false, nil
		}
		keep := []string{}
		seen := map[string]bool{}
		for _, s := range append(cur.Added, added...) {
			if !gone[s] && !seen[s] {
				seen[s] = true
				keep = append(keep, s)
			}
		}
		cur.Added = keep
		if done {
			cur.Proposal = nil
		}
		return cur, true, nil
	})
	if err != nil {
		out["warning"] = "the list was changed, but Bloxsmith could not note which sites it added, so a later proposal may not offer to drop them"
	}
	objs := make([]runs.Object, 0, len(added))
	for _, s := range added {
		objs = append(objs, runs.Object{ID: strconv.Itoa(wt.ListID) + "/" + s, Kind: "list_item", Label: s + ", in list " + wt.ListName, State: runs.Created})
	}
	note := fmt.Sprintf("%d added, %d dropped", len(added), len(dropped))
	if len(added) > 0 || len(dropped) > 0 {
		d.recordMade(r, "lists", "Daily proposal for "+wt.ListName, objs, note, true)
	}
	d.auditAppend("site-list-sync", httpx.Actor(r), map[string]any{
		"list_id": wt.ListID, "list": wt.ListName, "added": len(added), "dropped": len(dropped)})
}

func intArg(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		if n == float64(int(n)) {
			return int(n), true
		}
	case string:
		i, err := strconv.Atoi(strings.TrimSpace(n))
		return i, err == nil
	}
	return 0, false
}
