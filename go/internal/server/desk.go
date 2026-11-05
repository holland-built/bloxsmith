package server

import (
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"bloxsmith/internal/edit"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/runs"
)

// The job desk (ui/src/tabs/Automate.jsx): a Build that records the exact IDs
// it made, and a Remove that deletes only those. See internal/runs for why the
// record is a list of IDs and not tags.
//
// Both POST routes are on the tenant write list (writelock.go), pass the
// central WriteGuard, and need the operator role, the same as the Self-Service
// write they wrap. The desk is a front for the existing builders, never a way
// around their checks.
func (d *Deps) registerDeskRoutes(mux router) {
	mux.HandleFunc("GET /api/desk/runs", d.deskRuns)
	mux.HandleFunc("GET /api/desk/spaces", d.deskSpaces)
	mux.HandleFunc("POST /api/desk/run", d.body(d.deskRun))
	mux.HandleFunc("POST /api/desk/remove", d.body(d.deskRemove))
}

// ledger opens desk_runs.json beside vault.json on first use. nil when there
// is no state directory, and then nothing is built: a Build that cannot be
// recorded cannot be removed.
func (d *Deps) ledger() *runs.Ledger {
	d.runsOnce.Do(func() {
		if d.Runs == nil && d.StateDir != "" {
			d.Runs = runs.Open(d.StateDir)
		}
	})
	return d.Runs
}

func (d *Deps) deskRuns(w http.ResponseWriter, r *http.Request) {
	l := d.ledger()
	if l == nil {
		d.json(w, r, 200, map[string]any{"runs": []runs.Run{}})
		return
	}
	rs, err := l.List()
	if err != nil {
		d.json(w, r, 500, map[string]any{"error": "could not read the list of changes: " + err.Error()})
		return
	}
	d.json(w, r, 200, map[string]any{"runs": rs})
}

// deskJob turns one job's plain answers into a call on an existing builder.
// build runs the builder (dry or live); collect reads the IDs a live result
// proves were made; title names the run in Your recent changes.
type deskJob struct {
	build   func(c *edit.Client, in map[string]any, dry bool) (map[string]any, int)
	collect func(res map[string]any, in map[string]any) ([]runs.Object, string)
	title   func(in map[string]any) string
}

// dnsTypes are the record types the DNS name job offers. Everything else is
// on the DNS page under Advanced.
var dnsTypes = map[string]bool{"A": true, "AAAA": true, "CNAME": true, "TXT": true}

// deskJobs are the jobs this route builds. Each check returns the message for
// a missing or wrong answer, or "".
var deskJobs = map[string]struct {
	check func(in map[string]any) string
	deskJob
}{
	"ip": {
		check: func(in map[string]any) string {
			if inStr(in, "subnet_id") == "" {
				return "Pick a network first."
			}
			return ""
		},
		deskJob: deskJob{
			build: func(c *edit.Client, in map[string]any, dry bool) (map[string]any, int) {
				return c.SelfserviceAllocate(map[string]any{"subnet_id": inStr(in, "subnet_id"), "count": 1,
					"name": inStr(in, "name"), "dry": dry})
			},
			collect: func(res, _ map[string]any) ([]runs.Object, string) { return allocatedObjects(res) },
			title: func(in map[string]any) string {
				if n := inStr(in, "name"); n != "" {
					return "IP address for " + n
				}
				return "IP address"
			},
		},
	},
	"dns": {
		check: func(in map[string]any) string {
			switch {
			case inStr(in, "zone_id") == "":
				return "Pick a zone first."
			case inStr(in, "name_in_zone") == "":
				return "Type the name, or @ for the zone itself."
			case !dnsTypes[strings.ToUpper(inStr(in, "type"))]:
				return "Pick A, AAAA, CNAME or TXT. Other types are on the DNS page."
			case inStr(in, "value") == "":
				return "Type what the name should point to."
			}
			return ""
		},
		deskJob: deskJob{
			build: func(c *edit.Client, in map[string]any, dry bool) (map[string]any, int) {
				return c.DNSRecordCreate(map[string]any{"zone_id": inStr(in, "zone_id"),
					"name_in_zone": inStr(in, "name_in_zone"), "type": strings.ToUpper(inStr(in, "type")),
					"value": inStr(in, "value"), "dry": dry})
			},
			collect: dnsObjects,
			title:   func(in map[string]any) string { return "DNS name " + dnsLabel(in) },
		},
	},
	"network": {
		check: func(in map[string]any) string {
			if inStr(in, "block_id") == "" {
				return "Pick an address block first."
			}
			if n, ok := in["cidr"].(float64); !ok || n < 8 || n > 30 || n != float64(int(n)) {
				return "Pick a network size."
			}
			return ""
		},
		deskJob: deskJob{
			build: func(c *edit.Client, in map[string]any, dry bool) (map[string]any, int) {
				return c.SubnetCreate(map[string]any{"block_id": inStr(in, "block_id"),
					"cidr": in["cidr"], "name": inStr(in, "name"), "dry": dry})
			},
			collect: subnetObjects,
			title: func(in map[string]any) string {
				if n := inStr(in, "name"); n != "" {
					return "Network " + n
				}
				return "Network"
			},
		},
	},
}

func (d *Deps) deskRun(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/desk/run")
	jobID := anyStr(b["job"])
	job, known := deskJobs[jobID]
	if !known {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "unknown job"})
		return
	}
	in, _ := b["input"].(map[string]any)
	if in == nil {
		in = map[string]any{}
	}
	if msg := job.check(in); msg != "" {
		d.json(w, r, 400, map[string]any{"ok": false, "error": msg})
		return
	}

	// Preview: the builder's own dry run. Nothing is recorded.
	if dry, ok := b["dry"].(bool); !ok || dry {
		res, status := job.build(d.editFor(r), in, true)
		d.json(w, r, status, res)
		return
	}

	l := d.ledger()
	if l == nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "Bloxsmith has nowhere to record this change, so it was not made."})
		return
	}
	title := job.title(in)
	run := runs.Run{ID: runs.NewID(time.Now()), Job: jobID, Title: title, Space: inStr(in, "space"),
		Created: time.Now().UTC().Format(time.RFC3339), Status: runs.Building, Objects: []runs.Object{}}
	if err := l.Add(run); err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "could not record the change, so it was not made: " + err.Error()})
		return
	}

	res, status := job.build(d.editFor(r), in, false)
	objs, note := job.collect(res, in)
	ok := resultOK(res)
	saveErr := l.Change(run.ID, func(x *runs.Run) error {
		x.Objects = objs
		x.Note = note
		if ok {
			x.Status = runs.Built
			if len(objs) == 1 && jobID == "ip" {
				x.Title = title + ": " + objs[0].Label
			}
		} else {
			x.Status = runs.Failed
			x.Error = anyStr(res["error"])
		}
		run = *x
		return nil
	})
	d.auditAppend("desk-build", httpx.Actor(r), map[string]any{
		"run": run.ID, "job": jobID, "status": run.Status, "objects": objectIDs(objs), "saved": saveErr == nil})
	if saveErr != nil {
		// The change was made but its record was not saved, so Remove cannot
		// see it. Say exactly what was made; the audit row above names it too.
		labels := []string{}
		for _, o := range objs {
			labels = append(labels, o.Label)
		}
		d.json(w, r, 500, map[string]any{"ok": false, "result": res,
			"error": "The change was made (" + strings.Join(labels, ", ") + ") but Bloxsmith could not save its record, so it cannot be removed from here: " + saveErr.Error()})
		return
	}
	d.json(w, r, status, map[string]any{"ok": ok, "run": run, "result": res, "error": res["error"]})
}

// dnsLabel is how a person recognises the record: "www.example.com A 10.1.2.3".
func dnsLabel(in map[string]any) string {
	name := inStr(in, "name_in_zone")
	if z := strings.TrimSuffix(inStr(in, "zone_name"), "."); z != "" {
		if name == "@" {
			name = z
		} else {
			name += "." + z
		}
	}
	return name + " " + strings.ToUpper(inStr(in, "type")) + " " + inStr(in, "value")
}

// dnsObjects reads the record ID a create result proves was made.
func dnsObjects(res, in map[string]any) ([]runs.Object, string) {
	if rec, _ := res["record"].(map[string]any); resultOK(res) && rec != nil {
		if id := anyStr(rec["id"]); id != "" {
			return []runs.Object{{ID: id, Kind: "dns_record", Label: dnsLabel(in), State: runs.Created}}, ""
		}
		return []runs.Object{}, "Infoblox made the record but did not return its ID, so it cannot be removed from here."
	}
	if createdUnreadable(res) {
		return []runs.Object{}, "The record may have been made but Infoblox did not say which, so check the zone by hand."
	}
	return []runs.Object{}, ""
}

// subnetObjects reads the network ID a create result proves was made. A
// network whose tags failed still exists, so it is recorded and can be removed.
func subnetObjects(res, in map[string]any) ([]runs.Object, string) {
	id := ""
	label := ""
	if sub, _ := res["subnet"].(map[string]any); resultOK(res) && sub != nil {
		id = anyStr(sub["id"])
		if a := anyStr(sub["address"]); a != "" {
			label = a + "/" + fmt.Sprint(sub["cidr"])
		}
	} else if res["tagging_failed"] == true {
		id = anyStr(res["id"])
	}
	if id == "" {
		if createdUnreadable(res) || resultOK(res) {
			return []runs.Object{}, "A network may have been made but Infoblox did not say which, so check the address block by hand."
		}
		return []runs.Object{}, ""
	}
	if label == "" {
		label = "network"
	}
	if n := inStr(in, "name"); n != "" {
		label += ", " + n
	}
	return []runs.Object{{ID: id, Kind: "subnet", Label: label, State: runs.Created}}, ""
}

// allocatedObjects reads the IDs an allocate result proves were made. An
// address with no ID is left out and named in the note, so it is never offered
// for Remove; the same goes for a DNS record Infoblox accepted but did not show.
func allocatedObjects(res map[string]any) ([]runs.Object, string) {
	objs := []runs.Object{}
	var notes []string
	if ok := resultOK(res); ok || createdUnreadable(res) {
		for _, a := range asList(res["addresses"]) {
			m, _ := a.(map[string]any)
			if id := anyStr(m["id"]); id != "" {
				objs = append(objs, runs.Object{ID: id, Kind: "address", Label: anyStr(m["address"]), State: runs.Created})
			} else {
				notes = append(notes, "Infoblox did not return an ID for "+anyStr(m["address"])+", so it cannot be removed from here.")
			}
		}
		if rec, _ := res["record"].(map[string]any); rec != nil {
			if id := anyStr(rec["id"]); id != "" && rec["ok"] == true {
				objs = append(objs, runs.Object{ID: id, Kind: "dns_record", Label: "DNS record", State: runs.Created})
			} else if createdUnreadable(res) {
				notes = append(notes, "A DNS record may have been made but Infoblox did not say which, so check the zone by hand.")
			}
		}
	}
	// A failed build that could not give its addresses back.
	for _, o := range asList(res["orphaned"]) {
		if id := anyStr(o); id != "" {
			objs = append(objs, runs.Object{ID: id, Kind: "address", Label: "reserved address", State: runs.Created})
		}
	}
	return objs, strings.Join(notes, " ")
}

// removeOrder deletes records before the addresses they point at, and
// addresses before the network that holds them.
var removeOrder = []string{"dns_record", "address", "subnet"}

var removeKinds = map[string]string{"dns_record": "dns/record", "address": "ipam/address", "subnet": "ipam/subnet"}

// deskRemove previews (dry) or deletes everything a run made that is still
// there. Running it again retries only what is left.
func (d *Deps) deskRemove(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/desk/remove")
	l := d.ledger()
	if l == nil {
		d.json(w, r, 404, map[string]any{"ok": false, "error": "run not found"})
		return
	}
	id := anyStr(b["run"])
	run, found, err := l.Get(id)
	if err != nil || !found {
		d.json(w, r, 404, map[string]any{"ok": false, "error": "run not found"})
		return
	}
	if run.Status == runs.Building || run.Status == runs.Removing {
		d.json(w, r, 409, map[string]any{"ok": false, "error": "This change is still in progress. Try again in a moment."})
		return
	}
	cli := d.editFor(r)

	if dry, ok := b["dry"].(bool); !ok || dry {
		would := []map[string]any{}
		for _, o := range run.Objects {
			if o.State != runs.Created && o.State != runs.Error {
				continue
			}
			p, perr := edit.ObjectPath(removeKinds[o.Kind], o.ID)
			if perr != nil {
				continue
			}
			_, st, _ := cli.Rest.GetEx(p, nil)
			// Only a 404 means gone. Any other failure means Bloxsmith could not
			// check, which is not the same thing.
			row := map[string]any{"id": o.ID, "kind": o.Kind, "label": o.Label,
				"exists": st == 200, "gone": st == 404, "status": st}
			if o.Kind == "subnet" && st == 200 {
				if why := subnetBlocker(cli, o.ID); why != "" {
					row["blocked"] = why
				}
			}
			would = append(would, row)
		}
		d.json(w, r, 200, map[string]any{"dry_run": true, "run": run, "would_remove": would})
		return
	}

	// The objects to delete are copied inside the same locked step that marks
	// the run removing, so a second Remove that read the run earlier cannot
	// work from a stale copy and delete twice.
	var objs []runs.Object
	if err := l.Change(id, func(x *runs.Run) error {
		if x.Status == runs.Building || x.Status == runs.Removing {
			return fmt.Errorf("in progress")
		}
		x.Status = runs.Removing
		objs = append([]runs.Object(nil), x.Objects...)
		return nil
	}); err != nil {
		d.json(w, r, 409, map[string]any{"ok": false, "error": "This change is still in progress. Try again in a moment."})
		return
	}

	failed := 0
	for _, kind := range removeOrder {
		for i := range objs {
			o := &objs[i]
			if o.Kind != kind || (o.State != runs.Created && o.State != runs.Error) {
				continue
			}
			p, perr := edit.ObjectPath(removeKinds[o.Kind], o.ID)
			if perr != nil {
				o.State, o.Error = runs.Error, "not a valid Infoblox ID"
				failed++
				continue
			}
			// Checked again right before the delete, because someone may have
			// put something in the network since the preview. A small gap
			// remains between this check and the DELETE; Infoblox offers no
			// "delete only if empty".
			if o.Kind == "subnet" {
				if why := subnetBlocker(cli, o.ID); why != "" {
					o.State, o.Error = runs.Error, why
					failed++
					continue
				}
			}
			res, _ := cli.Delete(p)
			switch {
			case resultOK(res) && res["already_gone"] == true:
				o.State, o.Error = runs.Gone, ""
			case resultOK(res):
				o.State, o.Error = runs.Deleted, ""
			default:
				o.State, o.Error = runs.Error, anyStr(res["error"])
				failed++
			}
		}
	}
	saveErr := l.Change(id, func(x *runs.Run) error {
		x.Objects = objs
		if failed > 0 {
			x.Status = runs.RemoveFailed
			x.Error = fmt.Sprintf("%d item(s) could not be removed. Remove again to retry them.", failed)
		} else {
			x.Status = runs.Removed
			x.Error = ""
		}
		run = *x
		return nil
	})
	d.auditAppend("desk-remove", httpx.Actor(r), map[string]any{
		"run": id, "status": run.Status, "objects": objectStates(objs), "saved": saveErr == nil})
	if saveErr != nil {
		d.json(w, r, 500, map[string]any{"ok": false,
			"error": "Bloxsmith could not save what Remove did. Reload and press Remove again; items already deleted count as done: " + saveErr.Error()})
		return
	}
	code := 200
	if failed > 0 {
		code = 502
	}
	d.json(w, r, code, map[string]any{"ok": failed == 0, "run": run, "error": run.Error})
}

func objectIDs(objs []runs.Object) []any {
	out := []any{}
	for _, o := range objs {
		out = append(out, o.ID)
	}
	return out
}

func objectStates(objs []runs.Object) []any {
	out := []any{}
	for _, o := range objs {
		out = append(out, map[string]any{"id": o.ID, "state": o.State})
	}
	return out
}

// anyStr is the string in v, or "" when v is not a string.
func anyStr(v any) string {
	s, _ := v.(string)
	return s
}

// inStr is a trimmed string answer from a job's input.
func inStr(in map[string]any, k string) string { return strings.TrimSpace(anyStr(in[k])) }

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

// subnetBlocker says why a network must not be deleted, or "" when it is safe.
// Deleting a network in Infoblox takes everything inside it too, so the desk
// deletes one only when it holds nothing but its own network and broadcast
// addresses (Infoblox lists those two as addresses in every IPv4 network) and
// no DHCP range. When it cannot check, it does not delete.
func subnetBlocker(cli *edit.Client, id string) string {
	const cantCheck = "Bloxsmith could not check whether this network holds anything else, so it was not deleted. Try again, or delete it on the Subnet page."
	p, err := edit.ObjectPath("ipam/subnet", id)
	if err != nil {
		return "not a valid Infoblox ID"
	}
	body, st, _ := cli.Rest.GetEx(p, nil)
	if st == 404 {
		return "" // already gone; the delete reports that
	}
	sub, _ := body.(map[string]any)
	if r, ok := sub["result"].(map[string]any); ok {
		sub = r
	}
	if st != 200 || sub == nil {
		return cantCheck
	}
	own := subnetOwnAddresses(fmt.Sprintf("%v/%v", sub["address"], sub["cidr"]))
	esc, err := rest.CSPQ(id)
	if err != nil {
		return cantCheck
	}
	filter := map[string]string{"_filter": `parent=="` + esc + `"`, "_limit": "50"}
	addrs, err := cli.Rest.GetStrict("/api/ddi/v1/ipam/address", filter)
	if err != nil {
		return cantCheck
	}
	others := 0
	for _, a := range addrs {
		m, _ := a.(map[string]any)
		if !own[anyStr(m["address"])] {
			others++
		}
	}
	ranges, err := cli.Rest.GetStrict("/api/ddi/v1/ipam/range", filter)
	if err != nil {
		return cantCheck
	}
	switch {
	case others > 0 && len(ranges) > 0:
		return fmt.Sprintf("This network now holds %d address(es) and %d DHCP range(s) this change did not make, so it was not deleted. Remove those first.", others, len(ranges))
	case others > 0:
		return fmt.Sprintf("This network now holds %d address(es) this change did not make, so it was not deleted. Release them first.", others)
	case len(ranges) > 0:
		return fmt.Sprintf("This network now holds %d DHCP range(s) this change did not make, so it was not deleted. Remove them first.", len(ranges))
	}
	return ""
}

// subnetOwnAddresses is the network and broadcast address of an IPv4 prefix
// like "10.7.0.0/29". Empty for anything else, so nothing is skipped.
func subnetOwnAddresses(prefix string) map[string]bool {
	own := map[string]bool{}
	pfx, err := netip.ParsePrefix(prefix)
	if err != nil || !pfx.Addr().Is4() {
		return own
	}
	pfx = pfx.Masked()
	b := pfx.Addr().As4()
	v := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	v |= uint32(1)<<(32-pfx.Bits()) - 1
	own[pfx.Addr().String()] = true
	own[netip.AddrFrom4([4]byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}).String()] = true
	return own
}
