package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

// `bloxsmith restore-plan <export.json>` — read a teardown export back.
//
// WHY. v3.31.0 made teardown write out the full object bodies before deleting
// anything, so a mistake became recoverable rather than merely explained. It
// shipped with nothing that could READ that file: the operator had the bodies and
// a manual rebuild. Half a feature — the record existed and could not be used.
//
// NAMED FOR WHAT IT PRODUCES. It is `restore-plan`, not `restore`, because it
// produces a plan and creates nothing. Calling it `restore` would promise the
// half that is not built, which is the overstatement this codebase keeps refusing
// to make.
//
// WHAT IT DOES NOT DO, and why that is the right split for now.
//
// It does not create anything, and it never contacts the tenant at all — it is
// offline, exactly like `bloxsmith audit verify`, and works with the server
// stopped, on a copied export, on another machine. An untested writer reaching
// into a live customer tenant and half-recreating a site is worse than the
// problem it solves: the operator would then have neither the old state nor a
// clean one, and no record of which. The write lock would refuse it on this
// machine anyway, so an apply path could not even be exercised here.
//
// What it does buy is everything up to the writing: the export is validated, the
// tenant it came from is named, and the objects come out in the order they have
// to be created — which is NOT the reverse of the order they were deleted in, and
// getting that wrong is how a manual rebuild fails halfway.
//
// It also cannot say what still exists upstream, because it makes no calls. Two
// objects in the plan may already be back. That is stated in the output rather
// than guessed at.

// restoreUsage documents the command.
func restoreUsage() {
	fmt.Println(`usage: bloxsmith restore-plan <export.json> [--json]
       bloxsmith restore-plan <export.json> --apply --confirm <target>

  Read a teardown export (written before the deletes by teardown-exports/) and
  print what would have to be re-created to undo it, in dependency order.

  --json   emit the plan as JSON instead of text

  It CREATES NOTHING and makes no network calls by default. It is a plan, not
  a restore: the objects are re-created by you, from the full API bodies the
  export holds.

  --apply             actually re-create the objects, against the live tenant.
                       Requires --confirm and an unlockable vault. See below.
  --confirm <target>  must match the export's own "target" field exactly, the
                       same discipline the teardown routes require. Without it,
                       --apply refuses.

  --apply enforces, itself, every check the running server's write-lock
  middleware would have enforced had this gone through it (a CLI process does
  not pass through HTTP middleware):
    - the export's recorded tenant must match the tenant resolved right now
    - that tenant must be marked writable (Settings, same control as the UI)
    - --confirm must match the export's target
    - a prerequisite (ip_space, dns_view) that is missing upstream refuses —
      it was never deleted, so this tool will not create it
    - an object already found upstream (by the id the export recorded) is
      skipped, not duplicated
    - the first creation failure stops the run; everything created before it
      is reported, in order, and nothing after it is attempted

  UNVERIFIED API SHAPE: the create call bodies below (in particular, a subnet
  re-created at its ORIGINAL address) are verified only against a fake
  upstream in this build's own tests — never against a live Infoblox tenant.
  This codebase has no other exact-address subnet create to check them
  against; real subnet provisioning always allocates via nextavailablesubnet,
  a different operation. Watch the first real run.

  Exit: 0 a plan was produced, or --apply completed with nothing left to do
        1 the export is unusable, or --apply refused or was stopped by a failure
        2 the export is valid but describes nothing to re-create`)
}

// restoreStep is one object to re-create, in order.
type restoreStep struct {
	N       int    `json:"n"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Detail  string `json:"detail,omitempty"`
	Note    string `json:"note,omitempty"`
	Body    any    `json:"body,omitempty"`
	Prereq  bool   `json:"prerequisite,omitempty"`
	Deleted bool   `json:"was_deleted"`
}

func runRestoreCLI(args []string) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		restoreUsage()
		if len(args) == 0 {
			return 1
		}
		return 0
	}

	path := ""
	asJSON := false
	apply := false
	confirm := ""
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
			asJSON = true
		case a == "--apply":
			apply = true
		case a == "--confirm":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "restore-plan: --confirm requires a value")
				return 1
			}
			i++
			confirm = args[i]
		case strings.HasPrefix(a, "--confirm="):
			confirm = strings.TrimPrefix(a, "--confirm=")
		case strings.HasPrefix(a, "-"):
			fmt.Fprintf(os.Stderr, "restore-plan: unknown option %q\n", a)
			return 1
		default:
			if path != "" {
				fmt.Fprintf(os.Stderr, "restore-plan: more than one export given (%q and %q)\n", path, a)
				return 1
			}
			path = a
		}
	}
	if path == "" {
		fmt.Fprintln(os.Stderr, "restore-plan: no export file given")
		restoreUsage()
		return 1
	}

	doc, err := readExport(path)
	if err != nil {
		// Every failure here is "this file is not a usable export". Refusing beats
		// guessing: a partially-understood export would produce a plan that silently
		// omits objects, and the operator would rebuild from it believing it complete.
		fmt.Fprintf(os.Stderr, "restore-plan: %v\n", err)
		return 1
	}

	steps, err := planFromExport(doc)
	if err != nil {
		fmt.Fprintf(os.Stderr, "restore-plan: %v\n", err)
		return 1
	}

	// --apply is a completely different exit from here on: it touches the
	// network and creates things, where everything above it (and everything
	// below, in the --json/text branch) never has. Kept as a hard fork rather
	// than folded into the printing branches below so the plan-only path — the
	// DEFAULT — is untouched by --apply existing at all. See restorecli_apply.go.
	if apply {
		if asJSON {
			fmt.Fprintln(os.Stderr, "restore-plan: --apply does not support --json")
			return 1
		}
		return runRestoreApplyCLI(path, doc, steps, confirm)
	}

	if asJSON {
		out := map[string]any{
			"export":  path,
			"kind":    doc.Kind,
			"target":  doc.Target,
			"tenant":  doc.Tenant,
			"written": doc.WrittenAt,
			"steps":   steps,
		}
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(b))
	} else {
		printRestorePlan(path, doc, steps)
	}

	// Exit 2 when there is nothing to re-create. That is a real, distinct answer —
	// a teardown that deleted nothing still writes an export — and it must not read
	// as a successful plan the operator then acts on.
	created := 0
	for _, s := range steps {
		if !s.Prereq {
			created++
		}
	}
	if created == 0 {
		return 2
	}
	return 0
}

// exportDoc is the subset of the export format this reads. Deliberately a typed
// struct rather than map poking: a field that changes shape fails here, loudly,
// instead of silently yielding a plan with holes in it.
type exportDoc struct {
	Format    int            `json:"bloxsmith_export"`
	Kind      string         `json:"kind"`
	WrittenAt string         `json:"written_at"`
	Version   string         `json:"bloxsmith_version"`
	Target    string         `json:"target"`
	Tenant    map[string]any `json:"tenant"`
	Plan      map[string]any `json:"plan"`
}

func readExport(path string) (*exportDoc, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("could not read %s: %w", path, err)
	}
	var d exportDoc
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	if d.Format == 0 {
		return nil, fmt.Errorf("%s has no bloxsmith_export marker — it is not a teardown export", path)
	}
	// A format this build does not know is refused, not read optimistically. The
	// marker exists precisely so a later shape cannot be misread as this one.
	if d.Format != exportFormatKnown {
		return nil, fmt.Errorf("%s is export format %d; this build understands format %d only. "+
			"Use a bloxsmith new enough to read it", path, d.Format, exportFormatKnown)
	}
	if d.Plan == nil {
		return nil, fmt.Errorf("%s has no plan section — nothing to re-create from", path)
	}
	switch d.Kind {
	case "teardown-site", "teardown-block":
	default:
		return nil, fmt.Errorf("%s is of unknown kind %q", path, d.Kind)
	}
	return &d, nil
}

// exportFormatKnown mirrors provision.exportFormat. Duplicated as a constant here
// rather than imported because the CLI reading a file written by a DIFFERENT
// build must compare against what this build understands — importing the writer's
// current value would make the check tautological the moment the format changes.
const exportFormatKnown = 1

// planFromExport turns an export into the ordered list of things to re-create.
//
// THE ORDER IS NOT THE REVERSE OF THE DELETE ORDER, and assuming it is is how a
// manual rebuild fails halfway. Teardown deletes forward zone, ranges, reverse
// zones, subnets, then hosts — an order chosen so nothing is still in use when it
// goes. Creation is driven by what each object NEEDS to exist first:
//
//	ip space + DNS view   prerequisites; teardown never deleted them
//	subnets               need the ip space
//	DHCP ranges           need their subnet to exist
//	forward + reverse zones need the view
//	hosts                 need both a subnet and a zone, so they go last
//
// Address blocks invert differently again: they are deleted deepest-child-first
// (highest cidr) and must be created parent-first (lowest cidr), or a child has
// no parent to sit inside.
func planFromExport(d *exportDoc) ([]restoreStep, error) {
	if d.Kind == "teardown-block" {
		return blockRestoreSteps(d)
	}
	return siteRestoreSteps(d)
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

func asObj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func str(m map[string]any, k string) string {
	if m == nil {
		return ""
	}
	s, _ := m[k].(string)
	return s
}

func siteRestoreSteps(d *exportDoc) ([]restoreStep, error) {
	p := d.Plan
	var steps []restoreStep
	n := 0
	add := func(kind, name, detail, note string, body any, prereq bool) {
		n++
		steps = append(steps, restoreStep{
			N: n, Kind: kind, Name: name, Detail: detail, Note: note,
			Body: body, Prereq: prereq, Deleted: !prereq,
		})
	}

	// 1-2. Prerequisites. A teardown never deletes the ip space or the view, so
	// these are almost certainly still there — but a rebuild has to land back in
	// the SAME ones, and their names alone do not identify them. Listed as
	// prerequisites, not as things to create.
	if sp := asObj(p["ip_space_object"]); sp != nil {
		add("ip_space", str(sp, "name"), "id "+str(sp, "id"),
			"prerequisite — teardown did not delete this; it must already exist", sp, true)
	}
	if vw := asObj(p["dns_view_object"]); vw != nil {
		add("dns_view", str(vw, "name"), "id "+str(vw, "id"),
			"prerequisite — teardown did not delete this; it must already exist", vw, true)
	}

	// 3. Subnets first: ranges sit inside them and hosts get addresses from them.
	for _, s := range asList(p["subnets"]) {
		sm := asObj(s)
		addr := str(sm, "address")
		cidr := ""
		if c, ok := sm["cidr"]; ok {
			cidr = "/" + strings.TrimSuffix(fmt.Sprintf("%v", c), ".0")
		}
		add("subnet", addr+cidr, str(sm, "name"), "", sm, false)
	}

	// 4. DHCP ranges: each needs its subnet to exist, so they follow.
	for _, r := range asList(p["dhcp_ranges"]) {
		rm := asObj(r)
		add("dhcp_range", str(rm, "start")+"-"+str(rm, "end"), str(rm, "name"),
			"needs its subnet re-created first", rm, false)
	}

	// 5. Forward zone, then reverse zones — both need the view.
	if fz := asObj(p["forward_zone"]); fz != nil {
		add("dns_zone", str(fz, "fqdn"), "forward", "", fz["object"], false)
	}
	for _, z := range asList(p["reverse_zones"]) {
		zm := asObj(z)
		add("dns_zone", str(zm, "fqdn"), "reverse", "", zm["object"], false)
	}

	// 6. Hosts last: they need a subnet for the address and a zone for the name.
	for _, h := range asList(p["hosts"]) {
		hm := asObj(h)
		add("host", str(hm, "name"), "", "needs its subnet and zone re-created first", hm, false)
	}

	return steps, nil
}

func blockRestoreSteps(d *exportDoc) ([]restoreStep, error) {
	blocks := asList(d.Plan["address_blocks"])

	// PARENT-FIRST, the reverse of the delete order. Teardown removes the deepest
	// child first (highest cidr); re-creating in that order would try to make a
	// /24 before the /16 that contains it. Sorted ascending by cidr here so the
	// operator does not have to know that.
	type entry struct {
		cidr int
		m    map[string]any
	}
	var es []entry
	for _, b := range blocks {
		bm := asObj(b)
		c := 0
		switch v := bm["cidr"].(type) {
		case float64:
			c = int(v)
		case int:
			c = v
		}
		es = append(es, entry{cidr: c, m: bm})
	}
	sort.SliceStable(es, func(i, j int) bool { return es[i].cidr < es[j].cidr })

	var steps []restoreStep
	for i, e := range es {
		note := ""
		if i == 0 {
			note = "parent-first — the REVERSE of the order teardown deleted them in"
		}
		add := fmt.Sprintf("%s/%d", str(e.m, "address"), e.cidr)
		steps = append(steps, restoreStep{
			N: i + 1, Kind: "address_block", Name: add,
			Detail: str(asObj(e.m["tags"]), "Status"), Note: note,
			Body: e.m, Deleted: true,
		})
	}
	return steps, nil
}

func printRestorePlan(path string, d *exportDoc, steps []restoreStep) {
	kindLabel := "site teardown"
	if d.Kind == "teardown-block" {
		kindLabel = "address-block teardown"
	}
	fmt.Printf("export:  %s of %q\n", kindLabel, d.Target)
	fmt.Printf("written: %s by bloxsmith %s\n", d.WrittenAt, d.Version)

	// NAME THE TENANT, loudly. Re-creating a site into the wrong tenant is the
	// same mistake as tearing one down in the wrong tenant, and this file is read
	// precisely when someone is already having a bad day.
	label, _ := d.Tenant["label"].(string)
	id, _ := d.Tenant["id"].(string)
	switch {
	case label != "" && id != "":
		fmt.Printf("tenant:  %s (%s)\n", label, id)
	case id != "":
		fmt.Printf("tenant:  %s\n", id)
	default:
		// Never printed as a blank or a guess: an export that does not say which
		// tenant it came from cannot be safely rebuilt from.
		fmt.Printf("tenant:  NOT RECORDED in this export — do not rebuild from it until you\n" +
			"         have established which tenant it came from\n")
	}
	fmt.Println()
	fmt.Println("This is a PLAN. Nothing is created and nothing was contacted.")
	fmt.Println()

	if len(steps) == 0 {
		fmt.Println("Nothing to re-create: the teardown this records deleted no objects.")
		return
	}

	fmt.Println("Re-create in this order (each needs the ones above it):")
	for _, s := range steps {
		line := fmt.Sprintf("  %2d. %-13s %s", s.N, s.Kind, s.Name)
		if s.Detail != "" {
			line += "  " + s.Detail
		}
		fmt.Println(line)
		if s.Note != "" {
			fmt.Printf("      %s\n", s.Note)
		}
	}

	create := 0
	for _, s := range steps {
		if !s.Prereq {
			create++
		}
	}
	fmt.Println()
	fmt.Printf("%d object(s) to re-create. Their full API bodies are in the export under .plan —\n", create)
	fmt.Println("this tool does not create them, and cannot tell you which are already back.")
}
