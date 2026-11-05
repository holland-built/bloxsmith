package server

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"bloxsmith/internal/edit"
	"bloxsmith/internal/httpx"
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

// deskJobs are the jobs this route builds. Each one maps its plain input onto
// an existing builder.
var deskJobs = map[string]bool{"ip": true}

func (d *Deps) deskRun(w http.ResponseWriter, r *http.Request, b map[string]any) {
	if !d.roleGate(r, "operator") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	defer d.recoverEdit(w, r, "/api/desk/run")
	job := anyStr(b["job"])
	if !deskJobs[job] {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "unknown job"})
		return
	}
	in, _ := b["input"].(map[string]any)
	subnet := strings.TrimSpace(anyStr(in["subnet_id"]))
	if subnet == "" {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "Pick a network first."})
		return
	}
	name := strings.TrimSpace(anyStr(in["name"]))
	alloc := map[string]any{"subnet_id": subnet, "count": 1, "name": name}

	// Preview: the builder's own dry run. Nothing is recorded.
	if dry, ok := b["dry"].(bool); !ok || dry {
		alloc["dry"] = true
		res, status := d.editFor(r).SelfserviceAllocate(alloc)
		d.json(w, r, status, res)
		return
	}

	l := d.ledger()
	if l == nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "Bloxsmith has nowhere to record this change, so it was not made."})
		return
	}
	title := "IP address"
	if name != "" {
		title = "IP address for " + name
	}
	run := runs.Run{ID: runs.NewID(time.Now()), Job: job, Title: title,
		Created: time.Now().UTC().Format(time.RFC3339), Status: runs.Building, Objects: []runs.Object{}}
	if err := l.Add(run); err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "could not record the change, so it was not made: " + err.Error()})
		return
	}

	alloc["dry"] = false
	res, status := d.editFor(r).SelfserviceAllocate(alloc)
	objs, note := allocatedObjects(res)
	ok := resultOK(res)
	saveErr := l.Change(run.ID, func(x *runs.Run) error {
		x.Objects = objs
		x.Note = note
		if ok {
			x.Status = runs.Built
			if len(objs) == 1 {
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
		"run": run.ID, "job": job, "status": run.Status, "objects": objectIDs(objs), "saved": saveErr == nil})
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

// removeOrder deletes records before the addresses they point at.
var removeOrder = []string{"dns_record", "address"}

var removeKinds = map[string]string{"dns_record": "dns/record", "address": "ipam/address"}

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
			would = append(would, map[string]any{"id": o.ID, "kind": o.Kind, "label": o.Label,
				"exists": st == 200, "gone": st == 404, "status": st})
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

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}
