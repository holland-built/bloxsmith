package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"bloxsmith/internal/runs"
)

// madeFake is a small Infoblox: DDI objects by id, custom lists and one policy.
// It records every write so a test can say "nothing was deleted".
type madeFake struct {
	mu     sync.Mutex
	objs   map[string]map[string]any // "dns/record/r-1" -> object
	lists  map[string]map[string]any // "42" -> {name, policies}
	policy map[string]any            // policy 7
	writes []string
	ver    int  // the policy's ETag version
	race   bool // someone saves the policy just before Bloxsmith's PUT lands
	noETag bool // the policy read comes back without an ETag
}

func newMadeFake() *madeFake {
	return &madeFake{objs: map[string]map[string]any{}, lists: map[string]map[string]any{},
		policy: map[string]any{"id": 7, "name": "main", "rules": []any{
			map[string]any{"type": "custom_list", "data": "keep-me", "action": "action_block"},
			map[string]any{"type": "custom_list", "data": "bloxsmith-test", "action": "action_log", "description": "Added by Bloxsmith"},
		}}}
}

func (f *madeFake) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	p := r.URL.Path
	out := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	if r.Method != "GET" {
		f.writes = append(f.writes, r.Method+" "+p)
	}
	switch {
	case p == "/api/atcfw/v1/security_policies/7" && r.Method == "GET":
		if !f.noETag {
			w.Header().Set("ETag", "W/"+strconv.Itoa(f.ver))
		}
		out(map[string]any{"results": f.policy})
	case p == "/api/atcfw/v1/security_policies/7" && r.Method == "PUT":
		if f.race {
			f.ver++
			f.policy["rules"] = append(f.policy["rules"].([]any), map[string]any{"type": "custom_list", "data": "raced-in", "action": "action_allow"})
		}
		if m := r.Header.Get("If-Match"); m != "" && m != "W/"+strconv.Itoa(f.ver) {
			w.WriteHeader(412)
			return
		}
		f.ver++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.policy["rules"] = body["rules"]
		out(map[string]any{"results": f.policy})
	case strings.HasPrefix(p, "/api/atcfw/v1/named_lists/"):
		id := strings.TrimPrefix(p, "/api/atcfw/v1/named_lists/")
		l, ok := f.lists[id]
		switch {
		case !ok:
			w.WriteHeader(404)
		case r.Method == "DELETE":
			delete(f.lists, id)
			w.WriteHeader(204)
		default:
			out(map[string]any{"results": l})
		}
	case strings.HasPrefix(p, "/api/ddi/v1/"):
		id := strings.TrimPrefix(p, "/api/ddi/v1/")
		o, ok := f.objs[id]
		switch {
		case r.Method == "GET" && strings.Count(id, "/") == 2 && ok:
			out(map[string]any{"result": o})
		case r.Method == "GET" && strings.Count(id, "/") == 2:
			w.WriteHeader(404)
		case r.Method == "GET":
			out(map[string]any{"results": []any{}}) // leftover checks: nothing inside
		case r.Method == "DELETE" && ok:
			delete(f.objs, id)
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	default:
		w.WriteHeader(500)
		io.WriteString(w, `{"error":"unexpected `+r.Method+` `+p+`"}`)
	}
}

func (f *madeFake) wrote() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.writes...)
}

func newMadeDeps(t *testing.T) (*Deps, *madeFake) {
	t.Helper()
	f := newMadeFake()
	d, _ := newListsDeps(t, f.handler)
	d.StateDir = t.TempDir()
	return d, f
}

func madePost(t *testing.T, d *Deps, body map[string]any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	return deskPost(t, d, d.madeDelete, "/api/made/delete", string(raw))
}

// recordOne puts one object in the ledger as made by Bloxsmith.
func recordOne(t *testing.T, d *Deps, o runs.Object) {
	t.Helper()
	tenant, _ := d.writeIdentity()
	o.State = runs.Created
	if err := d.ledger().Add(runs.Run{ID: runs.NewID(time.Now()), Source: "address", Tenant: tenant,
		Created: "2026-11-13T10:00:00Z", Status: runs.Built, Objects: []runs.Object{o}}); err != nil {
		t.Fatal(err)
	}
}

var recA = map[string]any{"id": "dns/record/r-1", "absolute_name_spec": "web.example.com.", "type": "A",
	"rdata": map[string]any{"address": "10.0.0.5"}}

func TestMadeDelete_MadeHereIsPreviewedThenDeletedAndRecorded(t *testing.T) {
	d, f := newMadeDeps(t)
	f.objs["dns/record/r-1"] = recA
	recordOne(t, d, runs.Object{ID: "dns/record/r-1", Kind: "dns_record", Label: "web", Look: lookOf("dns_record", recA)})

	code, pre := madePost(t, d, map[string]any{"kind": "dns_record", "id": "dns/record/r-1", "dry": true})
	if code != 200 || pre["made"] != true || pre["changed"] != false || pre["made_on"] != "2026-11-13T10:00:00Z" {
		t.Fatalf("preview = %d %v, want made by Bloxsmith with its date", code, pre)
	}
	if len(f.wrote()) != 0 {
		t.Fatalf("a preview wrote to Infoblox: %v", f.wrote())
	}

	code, res := madePost(t, d, map[string]any{"kind": "dns_record", "id": "dns/record/r-1", "dry": false, "confirm": pre["confirm"]})
	if code != 200 || res["ok"] != true {
		t.Fatalf("delete = %d %v", code, res)
	}
	if w := f.wrote(); len(w) != 1 || w[0] != "DELETE /api/ddi/v1/dns/record/r-1" {
		t.Fatalf("writes = %v, want exactly the one DELETE", w)
	}
	rs, _ := d.ledger().List()
	if len(rs) != 2 || rs[0].Source != "delete" || rs[0].Note != "Made by Bloxsmith" || rs[0].Objects[0].State != runs.Deleted {
		t.Fatalf("ledger = %+v, want the delete recorded on top", rs)
	}
	if rs[1].Objects[0].State != runs.Deleted {
		t.Errorf("the made record still says %q", rs[1].Objects[0].State)
	}
}

func TestMadeDelete_NotMadeHereSaysSoAndStillNeedsTheConfirm(t *testing.T) {
	d, f := newMadeDeps(t)
	f.objs["dns/record/r-1"] = recA

	_, pre := madePost(t, d, map[string]any{"kind": "dns_record", "id": "dns/record/r-1", "dry": true})
	if pre["made"] != false || pre["changed"] != false {
		t.Fatalf("preview = %v, want not made by Bloxsmith", pre)
	}
	for _, bad := range []any{nil, "", "0000000000000000"} {
		if code, _ := madePost(t, d, map[string]any{"kind": "dns_record", "id": "dns/record/r-1", "dry": false, "confirm": bad}); code != 409 {
			t.Fatalf("confirm %v: code %d, want 409", bad, code)
		}
	}
	if len(f.wrote()) != 0 {
		t.Fatalf("a delete without the preview's confirm reached Infoblox: %v", f.wrote())
	}
	code, res := madePost(t, d, map[string]any{"kind": "dns_record", "id": "dns/record/r-1", "dry": false, "confirm": pre["confirm"]})
	if code != 200 || res["ok"] != true {
		t.Fatalf("delete = %d %v", code, res)
	}
	rs, _ := d.ledger().List()
	if len(rs) != 1 || rs[0].Note != "Not made by Bloxsmith" {
		t.Fatalf("ledger = %+v, want one recorded delete saying not made by Bloxsmith", rs)
	}
}

func TestMadeDelete_ChangedSinceMadeIsNotCalledSafe(t *testing.T) {
	d, f := newMadeDeps(t)
	recordOne(t, d, runs.Object{ID: "dns/record/r-1", Kind: "dns_record", Look: lookOf("dns_record", recA)})
	changed := map[string]any{"absolute_name_spec": "web.example.com.", "type": "A", "rdata": map[string]any{"address": "10.0.0.99"}}
	f.objs["dns/record/r-1"] = changed

	_, pre := madePost(t, d, map[string]any{"kind": "dns_record", "id": "dns/record/r-1", "dry": true})
	if pre["made"] != false || pre["changed"] != true {
		t.Fatalf("preview = %v, want made:false changed:true", pre)
	}
}

func TestMadeDelete_AConfirmForOneObjectDoesNotDeleteAnother(t *testing.T) {
	d, f := newMadeDeps(t)
	f.objs["dns/record/r-1"] = recA
	f.objs["dns/record/r-2"] = map[string]any{"absolute_name_spec": "db.example.com.", "type": "A", "rdata": map[string]any{"address": "10.0.0.6"}}
	_, pre := madePost(t, d, map[string]any{"kind": "dns_record", "id": "dns/record/r-1", "dry": true})
	if code, _ := madePost(t, d, map[string]any{"kind": "dns_record", "id": "dns/record/r-2", "dry": false, "confirm": pre["confirm"]}); code != 409 {
		t.Fatalf("code %d, want 409", code)
	}
	// Someone changes r-1 after the preview: the old confirm no longer fits.
	f.objs["dns/record/r-1"] = map[string]any{"absolute_name_spec": "web.example.com.", "type": "A", "rdata": map[string]any{"address": "10.0.0.7"}}
	if code, _ := madePost(t, d, map[string]any{"kind": "dns_record", "id": "dns/record/r-1", "dry": false, "confirm": pre["confirm"]}); code != 409 {
		t.Fatalf("changed after preview: code %d, want 409", code)
	}
	if len(f.wrote()) != 0 {
		t.Fatalf("writes = %v, want none", f.wrote())
	}
}

func TestMadeDelete_AListInUseIsRefusedAnUnusedOneIsDeleted(t *testing.T) {
	d, f := newMadeDeps(t)
	f.lists["42"] = map[string]any{"id": 42, "name": "bloxsmith-test", "policies": []any{"main"}}
	_, pre := madePost(t, d, map[string]any{"kind": "custom_list", "id": "42", "dry": true})
	if !strings.Contains(anyStr(pre["blocked"]), "main") {
		t.Fatalf("preview = %v, want blocked naming policy main", pre)
	}
	if code, _ := madePost(t, d, map[string]any{"kind": "custom_list", "id": "42", "dry": false, "confirm": pre["confirm"]}); code != 409 {
		t.Fatalf("code %d, want 409 while the list is in use", code)
	}
	f.lists["42"]["policies"] = []any{}
	_, pre = madePost(t, d, map[string]any{"kind": "custom_list", "id": "42", "dry": true})
	code, res := madePost(t, d, map[string]any{"kind": "custom_list", "id": "42", "dry": false, "confirm": pre["confirm"]})
	if code != 200 || res["ok"] != true {
		t.Fatalf("delete = %d %v", code, res)
	}
	if w := f.wrote(); len(w) != 1 || w[0] != "DELETE /api/atcfw/v1/named_lists/42" {
		t.Fatalf("writes = %v", w)
	}
}

func TestMadeDelete_RuleRemovalKeepsEveryOtherRuleAndRefusesAChangedPolicy(t *testing.T) {
	d, f := newMadeDeps(t)
	id := ruleID(7, "bloxsmith-test", "action_log")
	_, pre := madePost(t, d, map[string]any{"kind": "policy_rule", "id": id, "dry": true})
	if pre["gone"] != false || pre["blocked"] != "" {
		t.Fatalf("preview = %v", pre)
	}
	// Someone adds a rule after the preview: refused, policy untouched.
	f.mu.Lock()
	f.policy["rules"] = append(f.policy["rules"].([]any), map[string]any{"type": "custom_list", "data": "theirs", "action": "action_allow"})
	f.mu.Unlock()
	if code, _ := madePost(t, d, map[string]any{"kind": "policy_rule", "id": id, "dry": false, "confirm": pre["confirm"]}); code != 409 {
		t.Fatalf("code %d, want 409 for a policy changed since the preview", code)
	}
	if len(f.wrote()) != 0 {
		t.Fatalf("writes = %v, want none", f.wrote())
	}
	_, pre = madePost(t, d, map[string]any{"kind": "policy_rule", "id": id, "dry": true})
	code, res := madePost(t, d, map[string]any{"kind": "policy_rule", "id": id, "dry": false, "confirm": pre["confirm"]})
	if code != 200 || res["ok"] != true {
		t.Fatalf("delete = %d %v", code, res)
	}
	got := []string{}
	for _, r := range f.policy["rules"].([]any) {
		got = append(got, anyStr(r.(map[string]any)["data"]))
	}
	if strings.Join(got, ",") != "keep-me,theirs" {
		t.Fatalf("rules after = %v, want keep-me,theirs", got)
	}
}

func TestMadeDelete_WhatItWillNotTouch(t *testing.T) {
	d, f := newMadeDeps(t)
	for _, b := range []map[string]any{
		{"kind": "ip_space", "id": "ipam/ip_space/x", "dry": true},
		{"kind": "address_block", "id": "ipam/address_block/x", "dry": true},
		{"kind": "dns_record", "id": "ipam/subnet/x", "dry": true}, // id of another kind
		{"kind": "policy_rule", "id": "not-a-rule", "dry": true},
	} {
		if code, res := madePost(t, d, b); code != 400 {
			t.Errorf("%v: code %d %v, want 400", b, code, res)
		}
	}
	if len(f.wrote()) != 0 {
		t.Fatalf("writes = %v", f.wrote())
	}
}

func TestAllocateMade_RecordsTheReservationOnceAndTheRecord(t *testing.T) {
	res := map[string]any{"ok": true,
		"addresses":     []any{map[string]any{"id": "dhcp/fixed_address/f-1", "address": "10.99.0.2"}},
		"fixed_address": map[string]any{"ok": true, "id": "dhcp/fixed_address/f-1", "address": "10.99.0.2", "mac": "02:00:5e:10:00:01"},
		"record":        map[string]any{"ok": true, "id": "dns/record/r-7"}}
	objs, _, title := allocateMade(res, map[string]any{"dns": map[string]any{"name": "printer", "type": "A"}})
	if len(objs) != 2 || objs[0].Kind != "fixed_address" || objs[1].Kind != "dns_record" {
		t.Fatalf("objects = %+v, want the reservation then the record", objs)
	}
	if objs[0].Look != "10.99.0.2 02:00:5e:10:00:01" || title != "Reservation for 02:00:5e:10:00:01" {
		t.Errorf("look %q title %q", objs[0].Look, title)
	}
}

func TestListsMade_NewListAndPlacedRuleAreRecordedAnExistingListIsNot(t *testing.T) {
	res := map[string]any{"list": map[string]any{"name": "bloxsmith-test", "new": true, "id": 42},
		"steps": map[string]any{"policy": map[string]any{"ok": true, "position": 3}}}
	objs := listsMade(res, 7, "action_log")
	if len(objs) != 2 || objs[0].ID != "42" || objs[1].ID != "7/bloxsmith-test/action_log" {
		t.Fatalf("objects = %+v", objs)
	}
	res["list"].(map[string]any)["new"] = false
	if objs := listsMade(res, 7, "action_log"); len(objs) != 1 || objs[0].Kind != "policy_rule" {
		t.Fatalf("existing list: objects = %+v, want only the rule", objs)
	}
}

func TestMadeFind_NameContainsAndExactAddress(t *testing.T) {
	var got []string
	d, _ := newListsDeps(t, func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.URL.Path+"?"+r.URL.Query().Get("_filter"))
		io.WriteString(w, `{"results":[]}`)
	})
	for _, q := range []string{"/api/made/find?kind=dns_record&q=web", "/api/made/find?kind=fixed_address&q=10.99.0.2", "/api/made/find?kind=address&q=10.99.0.2"} {
		rr := httptest.NewRecorder()
		d.madeFind(rr, httptest.NewRequest("GET", q, nil))
		if rr.Code != 200 {
			t.Fatalf("%s: %d %s", q, rr.Code, rr.Body.String())
		}
	}
	want := []string{`/api/ddi/v1/dns/record?absolute_name_spec~"web"`, `/api/ddi/v1/dhcp/fixed_address?address=="10.99.0.2"`, `/api/ddi/v1/ipam/address?address=="10.99.0.2"`}
	if strings.Join(got, " | ") != strings.Join(want, " | ") {
		t.Fatalf("searches =\n%v\nwant\n%v", got, want)
	}
	rr := httptest.NewRecorder()
	d.madeFind(rr, httptest.NewRequest("GET", "/api/made/find?kind=address&q=web", nil))
	if rr.Code != 502 || !strings.Contains(rr.Body.String(), "full IP address") {
		t.Fatalf("an address search by name: %d %s", rr.Code, rr.Body.String())
	}
}

func TestMadeDelete_ARuleSavedOverSomeoneElsesChangeIsRefused(t *testing.T) {
	d, f := newMadeDeps(t)
	id := ruleID(7, "bloxsmith-test", "action_log")
	_, pre := madePost(t, d, map[string]any{"kind": "policy_rule", "id": id, "dry": true})
	f.race = true
	code, res := madePost(t, d, map[string]any{"kind": "policy_rule", "id": id, "dry": false, "confirm": pre["confirm"]})
	if code != 409 || !strings.Contains(anyStr(res["error"]), "changed while") {
		t.Fatalf("delete = %d %v, want 409 changed while saving", code, res)
	}
	got := []string{}
	for _, r := range f.policy["rules"].([]any) {
		got = append(got, anyStr(r.(map[string]any)["data"]))
	}
	if strings.Join(got, ",") != "keep-me,bloxsmith-test,raced-in" {
		t.Fatalf("rules = %v, want the other person's rule kept and nothing removed", got)
	}
	rs, _ := d.ledger().List()
	if len(rs) != 0 {
		t.Fatalf("a refused delete was recorded as done: %+v", rs)
	}
}

// A confirm is for the item as the preview saw it. Edited in Infoblox between
// the preview and the click, it is refused, even when the name is the same.
func TestMadeDelete_AnItemEditedAfterThePreviewIsNotDeleted(t *testing.T) {
	d, f := newMadeDeps(t)
	f.lists["42"] = map[string]any{"name": "bloxsmith-test", "items": []any{"a.com"}, "policies": []any{}}
	_, pre := madePost(t, d, map[string]any{"kind": "custom_list", "id": "42", "dry": true})
	f.lists["42"]["items"] = []any{"a.com", "b.com"}
	if code, _ := madePost(t, d, map[string]any{"kind": "custom_list", "id": "42", "dry": false, "confirm": pre["confirm"]}); code != 409 {
		t.Fatalf("list: code %d, want 409 after its items changed", code)
	}
	f.objs["dns/record/r-1"] = map[string]any{"id": "dns/record/r-1", "absolute_name_spec": "web.example.com.", "type": "A",
		"rdata": map[string]any{"address": "10.0.0.5"}, "updated_at": "2026-11-13T10:00:00Z"}
	_, pre = madePost(t, d, map[string]any{"kind": "dns_record", "id": "dns/record/r-1", "dry": true})
	f.objs["dns/record/r-1"]["updated_at"] = "2026-11-13T10:05:00Z"
	if code, _ := madePost(t, d, map[string]any{"kind": "dns_record", "id": "dns/record/r-1", "dry": false, "confirm": pre["confirm"]}); code != 409 {
		t.Fatalf("record: code %d, want 409 after it was edited", code)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("writes = %v, want none", w)
	}
}

// Without an ETag the save could land over someone else's change unseen, so
// the rule is not removed.
func TestMadeDelete_NoPolicyETagMeansNoSave(t *testing.T) {
	d, f := newMadeDeps(t)
	f.noETag = true
	id := ruleID(7, "bloxsmith-test", "action_log")
	_, pre := madePost(t, d, map[string]any{"kind": "policy_rule", "id": id, "dry": true})
	if code, _ := madePost(t, d, map[string]any{"kind": "policy_rule", "id": id, "dry": false, "confirm": pre["confirm"]}); code == 200 {
		t.Fatal("rule removed without an ETag")
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("writes = %v, want none", w)
	}
}
