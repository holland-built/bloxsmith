package server

import (
	"bloxsmith/internal/dashboard"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"

	"bloxsmith/internal/edit"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/runs"
)

// Made with Bloxsmith (ui/src/tabs/Made.jsx): what Bloxsmith made and deleted,
// and one way to delete anything of those kinds, made here or not.
//
// "Made by Bloxsmith" means the exact id is in the runs ledger (see
// internal/runs for why not tags) AND the object still looks the way it did
// when it was made. Something someone has changed since is not called safe.
//
// Every delete is a preview then a confirmed delete. The preview returns a
// confirm code built from the tenant, the object and what it looks like now;
// the delete reads the object again and refuses unless the code still
// matches. So the "are you sure" step cannot be skipped, and a code for one
// object, or for an object that changed, deletes nothing.
func (d *Deps) registerMadeRoutes(mux router) {
	mux.HandleFunc("GET /api/made/find", d.madeFind)
	mux.HandleFunc("POST /api/made/delete", d.body(d.madeDelete))
}

// madeKinds are the kinds this page deletes, with their Infoblox path for the
// DNS and IP ones. Not policies, IP spaces or address blocks (owner's choice,
// 2026-11-13).
var madeKinds = map[string]string{
	"dns_record": "dns/record", "address": "ipam/address", "fixed_address": "dhcp/fixed_address",
	"subnet": "ipam/subnet", "dns_zone": "dns/auth_zone", "host": "ipam/host", "dhcp_range": "ipam/range",
	"custom_list": "", "policy_rule": "", "list_item": "",
}

// parseItemID reads a list_item id, "<list id>/<site>".
func parseItemID(id string) (int, string, bool) {
	i := strings.Index(id, "/")
	if i <= 0 || i == len(id)-1 {
		return 0, "", false
	}
	n, err := strconv.Atoi(id[:i])
	if err != nil || n <= 0 || !dashboard.IsDomain(id[i+1:]) {
		return 0, "", false
	}
	return n, strings.ToLower(id[i+1:]), true
}

// lookOf is a short description of an Infoblox object: what a person would
// recognise, and what changes if someone repurposes it. "" when the object
// does not carry the fields.
func lookOf(kind string, m map[string]any) string {
	s := func(k string) string { return strings.TrimSpace(fmt.Sprint(m[k])) }
	if m == nil {
		return ""
	}
	var out string
	switch kind {
	case "dns_record":
		name := anyStr(m["absolute_name_spec"])
		if name == "" {
			return ""
		}
		rd, _ := json.Marshal(m["rdata"])
		out = name + " " + s("type") + " " + string(rd)
	case "address":
		out = anyStr(m["address"])
	case "fixed_address":
		if a := anyStr(m["address"]); a != "" {
			out = a + " " + anyStr(m["match_value"])
		}
	case "subnet", "address_block":
		if a := anyStr(m["address"]); a != "" {
			out = a + "/" + s("cidr")
		}
	case "dns_zone":
		out = anyStr(m["fqdn"])
	case "host":
		out = anyStr(m["name"])
	case "dhcp_range":
		if a := anyStr(m["start"]); a != "" {
			out = a + "-" + anyStr(m["end"])
		}
	case "custom_list":
		out = anyStr(m["name"])
	}
	return strings.TrimSpace(out)
}

// recordMade writes one run for a change made outside Automate, so it shows on
// Made with Bloxsmith. Nothing is written when nothing was made. A failed save
// is logged; the audit row the caller writes still names what was made.
func (d *Deps) recordMade(r *http.Request, source, title string, objs []runs.Object, note string, ok bool) {
	if len(objs) == 0 {
		return
	}
	l := d.ledger()
	if l == nil {
		return
	}
	tenant, _ := d.writeIdentity()
	status := runs.Built
	if !ok {
		status = runs.Failed
	}
	run := runs.Run{ID: runs.NewID(time.Now()), Job: source, Title: title, Source: source, Tenant: tenant,
		Created: time.Now().UTC().Format(time.RFC3339), Status: status, Note: note, Objects: objs}
	if err := l.Add(run); err != nil {
		log.Printf("[made] could not record %s %q: %v", source, title, err)
	}
}

// allocateMade is what a Get an address result proves was made. A reservation
// comes back with its own id in "addresses" too, so that id is recorded once,
// as the reservation.
func allocateMade(res, b map[string]any) ([]runs.Object, string, string) {
	objs, note := allocatedObjects(res)
	title := "IP address"
	if n := anyStr(b["name"]); n != "" {
		title = "IP address for " + n
	}
	fa, _ := res["fixed_address"].(map[string]any)
	fid := ""
	if fa != nil && fa["ok"] == true {
		fid = anyStr(fa["id"])
	}
	out := []runs.Object{}
	for _, o := range objs {
		if o.ID == fid {
			continue
		}
		if o.Kind == "address" {
			o.Look = o.Label
		}
		if o.Kind == "dns_record" {
			if dns, _ := b["dns"].(map[string]any); dns != nil {
				o.Label = strings.TrimSpace(anyStr(dns["name"]) + " " + strings.ToUpper(anyStr(dns["type"])))
			}
		}
		out = append(out, o)
	}
	if fid != "" {
		mac := anyStr(fa["mac"])
		out = append([]runs.Object{{ID: fid, Kind: "fixed_address", State: runs.Created,
			Label: anyStr(fa["address"]) + " for " + mac,
			Look:  lookOf("fixed_address", map[string]any{"address": fa["address"], "match_value": mac})}}, out...)
		title = "Reservation for " + mac
	}
	return out, note, title
}

// listsMade is what a Site lists apply proves was made: a new list once
// Infoblox gave its id, and the rule once Infoblox took the policy change.
// Sites added to an existing list are not a new object.
func listsMade(res map[string]any, policyID int, action string) []runs.Object {
	out := []runs.Object{}
	lst, _ := res["list"].(map[string]any)
	name := anyStr(lst["name"])
	if lst != nil && lst["new"] == true {
		if id, ok := lst["id"].(int); ok && id > 0 {
			out = append(out, runs.Object{ID: strconv.Itoa(id), Kind: "custom_list", Label: name, Look: name, State: runs.Created})
		}
	}
	steps, _ := res["steps"].(map[string]any)
	// Sites added to a list the owner already had are recorded one by one, as
	// a daily proposal records them. Only when the list step finished, so no
	// site is claimed that may not have gone in.
	if ls, _ := steps["list"].(map[string]any); lst != nil && lst["new"] != true && ls != nil && ls["ok"] == true {
		if id, ok := ls["id"].(int); ok && id > 0 {
			sites, _ := res["to_add"].([]string)
			for _, s := range sites {
				out = append(out, runs.Object{ID: strconv.Itoa(id) + "/" + s, Kind: "list_item", Label: s + ", in list " + name, State: runs.Created})
			}
		}
	}
	if pol, _ := steps["policy"].(map[string]any); pol != nil {
		pos, _ := pol["position"].(int)
		if pos > 0 || pol["checked"] == false {
			out = append(out, runs.Object{ID: ruleID(policyID, name, action), Kind: "policy_rule", State: runs.Created,
				Label: fmt.Sprintf("%s, %s, in policy %d", name, actionWord(action), policyID)})
		}
	}
	return out
}

// ruleID names a policy rule, which has no id of its own: policy/list/action.
func ruleID(policyID int, list, action string) string {
	return fmt.Sprintf("%d/%s/%s", policyID, list, action)
}

func parseRuleID(id string) (int, string, string, bool) {
	i, j := strings.Index(id, "/"), strings.LastIndex(id, "/")
	if i <= 0 || j <= i+1 || j == len(id)-1 {
		return 0, "", "", false
	}
	p, err := strconv.Atoi(id[:i])
	if err != nil || p <= 0 {
		return 0, "", "", false
	}
	return p, id[i+1 : j], id[j+1:], true
}

func actionWord(a string) string {
	return strings.ReplaceAll(strings.TrimPrefix(a, "action_"), "_", " ")
}

// madeState is what a delete preview found.
type madeState struct {
	gone    bool
	label   string
	look    string // what the object looks like now; binds the confirm code
	ver     string // Infoblox's version of it (updated_at, or a hash of a list's items); binds the confirm code too
	blocked string
}

// inspect reads one object for a delete. A read that fails is an error, never
// "gone": nothing is deleted on a guess.
func (d *Deps) inspect(r *http.Request, kind, id string) (madeState, int, error) {
	switch kind {
	case "custom_list":
		n, err := strconv.Atoi(id)
		if err != nil || n <= 0 {
			return madeState{}, 400, fmt.Errorf("not a list id")
		}
		name, usedBy, ver, st, err := d.dash(r).ListState(n)
		if st == 404 {
			return madeState{gone: true, label: "list " + id}, 200, nil
		}
		if err != nil {
			return madeState{}, 502, err
		}
		m := madeState{label: name, look: name, ver: ver}
		if len(usedBy) > 0 {
			m.blocked = "Policy " + strings.Join(usedBy, ", ") + " still uses this list. Delete its rule first."
		}
		return m, 200, nil
	case "list_item":
		n, site, ok := parseItemID(id)
		if !ok {
			return madeState{}, 400, fmt.Errorf("not a site in a list")
		}
		name, present, usedBy, ver, st, err := d.dash(r).ListItemState(n, site)
		if st == 404 {
			return madeState{gone: true, label: site}, 200, nil
		}
		if err != nil {
			return madeState{}, 502, err
		}
		label := site + ", in list " + name
		if len(usedBy) > 0 {
			label += ", used by " + strings.Join(usedBy, ", ")
		}
		return madeState{gone: !present, label: label, look: site, ver: ver}, 200, nil
	case "policy_rule":
		pid, list, action, ok := parseRuleID(id)
		if !ok {
			return madeState{}, 400, fmt.Errorf("not a policy rule")
		}
		pname, n, fp, st, err := d.dash(r).RuleState(pid, list, action)
		if err != nil {
			return madeState{}, statusOr502(st), err
		}
		m := madeState{label: fmt.Sprintf("%s, %s, in policy %s", list, actionWord(action), pname), look: fp}
		switch {
		case n == 0:
			m.gone = true
		case n > 1:
			m.blocked = "The policy has more than one rule for this list and action, so Bloxsmith cannot tell which one. Change it in Infoblox."
		}
		return m, 200, nil
	}
	cli := d.editFor(r)
	p, err := edit.ObjectPath(madeKinds[kind], id)
	if err != nil {
		return madeState{}, 400, fmt.Errorf("not a valid Infoblox ID")
	}
	body, st, _ := cli.Rest.GetEx(p, nil)
	if st == 404 {
		return madeState{gone: true, label: id}, 200, nil
	}
	obj, _ := body.(map[string]any)
	if res, ok := obj["result"].(map[string]any); ok {
		obj = res
	}
	if st != 200 || obj == nil {
		return madeState{}, 502, fmt.Errorf("could not read it from Infoblox (%d)", st)
	}
	look := lookOf(kind, obj)
	m := madeState{label: look, look: look, ver: anyStr(obj["updated_at"])}
	if m.label == "" {
		m.label = id
	}
	m.blocked = blocker(cli, runs.Object{Kind: kind, ID: id})
	return m, 200, nil
}

// numStr writes a JSON number id as digits (fmt would write 1e+06).
func numStr(v any) string {
	if f, ok := v.(float64); ok {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

func statusOr502(st int) int {
	if st == 404 || st == 400 {
		return st
	}
	return 502
}

func confirmCode(tenant, kind, id, look string, made bool) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{tenant, kind, id, look, strconv.FormatBool(made)}, "\x00")))
	return hex.EncodeToString(sum[:8])
}

// madeDelete is POST /api/made/delete {kind, id, dry, confirm}.
func (d *Deps) madeDelete(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/made/delete")
	kind, id := anyStr(b["kind"]), strings.TrimSpace(anyStr(b["id"]))
	if _, ok := madeKinds[kind]; !ok || id == "" {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "pick something to delete"})
		return
	}
	tenant, unknown := d.writeIdentity()
	if unknown != "" {
		d.json(w, r, 409, map[string]any{"ok": false, "error": "cannot tell which tenant this is: " + unknown})
		return
	}
	st, code, err := d.inspect(r, kind, id)
	if err != nil {
		d.json(w, r, code, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	var run runs.Run
	var obj runs.Object
	found := false
	if l := d.ledger(); l != nil {
		run, obj, found = l.Find(kind, id, tenant)
	}
	// A rule's look is its policy's fingerprint, which other rules change, so
	// for a rule the ledger match alone decides.
	made := found && (kind == "policy_rule" || obj.Look == "" || obj.Look == st.look)
	confirm := confirmCode(tenant, kind, id, st.look+"\x00"+st.ver, made)
	out := map[string]any{"kind": kind, "id": id, "label": st.label, "made": made,
		"changed": found && !made, "gone": st.gone, "blocked": st.blocked}
	if found {
		out["made_on"], out["made_page"] = run.Created, run.Source
	}
	// A site is not recorded on its own; one in a list Bloxsmith made counts
	// as made, and the page says it is the list that was made.
	if kind == "list_item" && !found && d.ledger() != nil {
		n, _, _ := parseItemID(id)
		if lrun, _, ok := d.ledger().Find("custom_list", strconv.Itoa(n), tenant); ok {
			made = true
			confirm = confirmCode(tenant, kind, id, st.look+"\x00"+st.ver, made)
			out["made"], out["changed"], out["made_on"], out["made_page"], out["made_why"] = true, false, lrun.Created, lrun.Source, "list"
		}
	}

	if dry, ok := b["dry"].(bool); !ok || dry {
		out["ok"], out["dry_run"], out["confirm"] = true, true, confirm
		d.json(w, r, 200, out)
		return
	}
	switch {
	case st.gone:
		out["ok"], out["already_gone"] = true, true
		if found {
			_ = d.ledger().MarkObject(run.ID, kind, id, runs.Gone)
		}
		d.json(w, r, 200, out)
		return
	case st.blocked != "":
		out["ok"], out["error"] = false, st.blocked
		d.json(w, r, 409, out)
		return
	case anyStr(b["confirm"]) != confirm:
		out["ok"], out["error"] = false, "This changed since the preview, or there was no preview. Nothing was deleted. Preview again."
		d.json(w, r, 409, out)
		return
	}

	res, status := d.deleteOne(r, kind, id, st.look)
	ok := resultOK(res)
	if ok {
		if found {
			_ = d.ledger().MarkObject(run.ID, kind, id, runs.Deleted)
		}
		who := "Not made by Bloxsmith"
		if made {
			who = "Made by Bloxsmith"
		}
		d.recordMade(r, "delete", "Deleted "+st.label, []runs.Object{{ID: id, Kind: kind, Label: st.label, State: runs.Deleted}}, who, true)
	}
	d.auditAppend("made-delete", httpx.Actor(r), map[string]any{
		"kind": kind, "id": id, "label": st.label, "made": made, "ok": ok, "error": res["error"]})
	for k, v := range res {
		out[k] = v
	}
	out["ok"] = ok
	d.json(w, r, status, out)
}

// deleteOne deletes the object the preview showed.
func (d *Deps) deleteOne(r *http.Request, kind, id, look string) (map[string]any, int) {
	switch kind {
	case "custom_list":
		n, _ := strconv.Atoi(id)
		gone, st, err := d.dash(r).DeleteList(n)
		if err != nil {
			return map[string]any{"ok": false, "error": err.Error()}, statusOr502(st)
		}
		return map[string]any{"ok": true, "already_gone": gone}, 200
	case "policy_rule":
		pid, list, action, _ := parseRuleID(id)
		return d.dash(r).RemoveRule(pid, list, action, look)
	case "list_item":
		n, site, _ := parseItemID(id)
		return d.dash(r).RemoveListItem(n, site)
	}
	cli := d.editFor(r)
	p, _ := edit.ObjectPath(madeKinds[kind], id)
	// Checked again right before the delete: someone may have put something in
	// the network or zone since the preview.
	if why := blocker(cli, runs.Object{Kind: kind, ID: id}); why != "" {
		return map[string]any{"ok": false, "error": why}, 409
	}
	res, st := cli.Delete(p)
	return res, st
}

// madeFind is GET /api/made/find?kind=&q=: up to 25 objects of one kind whose
// name contains q, or whose address is q. Each says whether Bloxsmith made it.
func (d *Deps) madeFind(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if _, ok := madeKinds[kind]; !ok || q == "" {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "pick a kind and type a name or address"})
		return
	}
	tenant, _ := d.writeIdentity()
	rows, err := d.findObjects(r, kind, q)
	if err != nil {
		d.json(w, r, 502, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	l := d.ledger()
	for _, row := range rows {
		if l != nil {
			if run, _, ok := l.Find(kind, anyStr(row["id"]), tenant); ok {
				row["made_on"] = run.Created
			}
		}
	}
	d.json(w, r, 200, map[string]any{"ok": true, "results": rows})
}

// findFields: the field a name search uses per kind. Infoblox accepts "~"
// (contains) on names but not on addresses (checked live 2026-11-13), so an
// address is matched exactly on addrField.
var findFields = map[string][2]string{
	"dns_record": {"absolute_name_spec", ""}, "address": {"", "address"},
	"fixed_address": {"name", "address"}, "subnet": {"name", "address"},
	"dns_zone": {"fqdn", ""}, "host": {"name", ""}, "dhcp_range": {"name", "start"},
}

func (d *Deps) findObjects(r *http.Request, kind, q string) ([]map[string]any, error) {
	switch kind {
	case "custom_list", "policy_rule":
		return d.findListsAndRules(r, kind, q)
	}
	esc, err := rest.CSPQ(q)
	if err != nil {
		return nil, err
	}
	f := findFields[kind]
	_, isIP := netip.ParseAddr(q)
	var filter string
	switch {
	case isIP == nil && f[1] != "":
		filter = fmt.Sprintf(`%s=="%s"`, f[1], esc)
	case f[0] != "":
		filter = fmt.Sprintf(`%s~"%s"`, f[0], esc)
	default:
		return nil, fmt.Errorf("type a full IP address to find addresses")
	}
	list, err := d.editFor(r).Rest.GetStrict("/api/ddi/v1/"+madeKinds[kind], map[string]string{"_filter": filter, "_limit": "25"})
	if err != nil {
		return nil, fmt.Errorf("could not search Infoblox")
	}
	out := []map[string]any{}
	for _, x := range list {
		m, _ := x.(map[string]any)
		label := lookOf(kind, m)
		if n := anyStr(m["name"]); n != "" && kind != "host" {
			label += ", " + n
		}
		out = append(out, map[string]any{"id": anyStr(m["id"]), "label": label})
	}
	return out, nil
}

func (d *Deps) findListsAndRules(r *http.Request, kind, q string) ([]map[string]any, error) {
	t, err := d.dash(r).ListTargets()
	if err != nil {
		return nil, fmt.Errorf("could not read lists and policies")
	}
	lq := strings.ToLower(q)
	out := []map[string]any{}
	if kind == "custom_list" {
		for _, x := range asList(t["lists"]) {
			m, _ := x.(map[string]any)
			if strings.Contains(strings.ToLower(anyStr(m["name"])), lq) {
				out = append(out, map[string]any{"id": numStr(m["id"]), "label": anyStr(m["name"])})
			}
		}
	} else {
		for _, x := range asList(t["policies"]) {
			p, _ := x.(map[string]any)
			pid, _ := strconv.Atoi(numStr(p["id"]))
			pname := anyStr(p["name"])
			for _, y := range asList(p["rules"]) {
				rule, _ := y.(map[string]any)
				data, action := fmt.Sprint(rule["data"]), fmt.Sprint(rule["action"])
				if fmt.Sprint(rule["type"]) != "custom_list" {
					continue
				}
				if strings.Contains(strings.ToLower(pname), lq) || strings.Contains(strings.ToLower(data), lq) {
					out = append(out, map[string]any{"id": ruleID(pid, data, action),
						"label": fmt.Sprintf("%s, %s, in policy %s", data, actionWord(action), pname)})
				}
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return anyStr(out[i]["label"]) < anyStr(out[j]["label"]) })
	if len(out) > 25 {
		out = out[:25]
	}
	return out, nil
}
