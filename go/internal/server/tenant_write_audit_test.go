package server

import (
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"bloxsmith/internal/audit"
)

// THE POINT OF THIS FILE: a route that changes the customer's tenant and
// records nothing must fail the build, not ship and wait to be noticed.
//
// About twelve missing audit records were fixed one at a time over two days —
// dns-record-delete, ipam-address-delete, teardown-block-error, block/unblock on
// unverified and rejected, retag-block-error, selfservice-allocate-orphaned,
// stream-aborted, three *-unreadable creates, the per-template teardown row.
// Every one was found by a human sweeping the source by hand. Nothing stopped
// the thirteenth.
//
// writelock_routes_test.go already solved the same shape of problem for the
// write LOCK: it enumerates what the server actually registers and requires
// every state-changing route to be classified, so forgetting is a build failure.
// This file is that guard for the AUDIT TRAIL.
//
// It asks two questions, in two different ways, because neither alone is
// enough:
//
//  1. SOURCE (TestEveryTenantWriteRouteAudits). For each tenant-changing route,
//     walk the real call graph out of the handler the router is actually handed
//     and collect every d.auditAppend event name reachable from it. The declared
//     events below must all still be there. This cannot be satisfied by editing
//     a list: adding a route to tenantWriteAuditEvents without an auditAppend
//     call reachable from its handler fails, because the harvest comes from the
//     AST of the production files, not from anything written here.
//
//  2. ON DISK (TestTenantWriteRoutesAreRecordedOnDisk). Every derived route is
//     driven through the REAL handler server.New builds and an entry is read
//     back off audit_log.jsonl. This is the check that notices the audit log
//     being unwired from the chain entirely, which no amount of source-reading
//     can see.
//
// WHAT THIS GUARD DOES NOT CATCH, said plainly: a NEW BRANCH inside an existing
// handler that writes and does not audit. The harvest is per-handler, not
// per-path-through-a-handler, so teardown-block-error going missing from ONE of
// teardownBlock's arms while the other arms still audit would pass here. That
// remains a human job, and the per-event tests (unaudited_events_test.go and the
// *_audit_test.go files) are where it is done. What this file makes impossible
// is the cheaper and more common failure: a whole route that audits nothing, and
// the deletion or rename of a call something depended on.

// =============================================================================
// The declaration
// =============================================================================

// tenantWriteAuditEvents is the claim this file checks: for each route that
// changes the customer's tenant, the audit events that MUST still be reachable
// from the handler the router is handed.
//
// The KEYS are not maintained by hand. They are derived from the write lock's
// own tenantWritePaths / tenantWritePrefixes / the /api/actions/{id}/status
// shape, crossed with what the server actually registers, and a key that is
// missing or stale fails TestEveryTenantWriteRouteAudits with the exact line to
// add or delete.
//
// The VALUES are the assertion, and they are written the way the harvest reports
// them: "edit-*-create" is not a wildcard convenience, it is the literal shape of
// `d.auditAppend("edit-"+resource+"-create", ...)` — the event name is genuinely
// assembled at run time from the resource in the path, and a declaration that
// pretended otherwise would be naming an event that never exists.
var tenantWriteAuditEvents = map[string][]string{
	// --- provisioning and teardown streams (SSE, hence GET) ------------------
	"GET /api/provision/stream":           {"provision-subnet", "provision-subnet-error"},
	"GET /api/provision/site/stream":      {"provision-site", "provision-site-error"},
	"GET /api/provision/seed-demo/stream": {"provision-seed-demo", "provision-site-error"},
	"GET /api/teardown/site/stream":       {"teardown-site", "teardown-site-error"},
	"GET /api/teardown/seed-demo/stream":  {"teardown-seed-demo", "teardown-site-error"},

	// --- address blocks ------------------------------------------------------
	"POST /api/provision/block": {"provision-block", "provision-block-error"},
	"POST /api/teardown/block":  {"teardown-block", "teardown-block-error"},
	"POST /api/retag/block":     {"retag-block", "retag-block-error"},

	// --- DNS and IPAM edits --------------------------------------------------
	"POST /api/selfservice/allocate": {"selfservice-allocate", "selfservice-allocate-orphaned", "selfservice-allocate-record-unreadable"},
	"POST /api/dns/records":          {"dns-record-create", "dns-record-create-unreadable"},
	"PATCH /api/dns/records":         {"dns-record-update", "dns-record-update-unreadable"},
	"DELETE /api/dns/records/":       {"dns-record-delete", "dns-record-delete-error"},
	"DELETE /api/ipam/addresses/":    {"ipam-address-delete", "ipam-address-delete-error"},
	"POST /api/edit/":                {"edit-*-create", "edit-*-create-unreadable"},
	"PATCH /api/edit/":               {"edit-*-update", "edit-*-update-unreadable"},
	"DELETE /api/edit/":              {"edit-*-delete"},

	// --- security policy -----------------------------------------------------
	"POST /api/block-domain":   {"block-domain"},
	"POST /api/unblock-domain": {"unblock-domain"},

	// --- IQ Actions ----------------------------------------------------------
	// Three, not two: "failed" is reserved for a write that never left this
	// process, and a dispatched write whose fate is unknown gets its own name.
	"POST /api/actions/{id}/status": {"iq-action-resolve", "iq-action-resolve-failed", "iq-action-resolve-unknown"},
}

// tenantWriteAuditAllowlist is for a route that changes the customer's tenant
// and genuinely CANNOT record what it did, mapped to the reason.
//
// It is empty, and empty is the goal. An entry here is a standing admission that
// a change can be made to a live tenant with no trace, so each one has to carry
// a reason that survives being read out loud in an incident review — "it is
// awkward" is not one. Nothing in the current route table qualifies.
var tenantWriteAuditAllowlist = map[string]string{}

// twaGenericEvents are the events a handler can emit WITHOUT having recorded a
// change to the tenant. They are excluded when asking "does this route audit at
// all", because a route whose only reachable event is a refusal or a panic
// records every way the write did NOT happen and nothing about the way it did.
var twaGenericEvents = map[string]bool{
	// The request was refused before it acted, by role.
	"rbac_denied": true,
	// The request was refused before it acted, by the per-tenant write lock.
	"write-refused-read-only": true,
	// The run panicked partway. Says a run stopped, never what it applied.
	"stream-aborted": true,
}

// =============================================================================
// Deriving the routes
// =============================================================================

// twaStateChanging is writelock_routes_test.go's rule, applied here for the same
// reason: every non-GET verb changes state, and so do the provision/teardown SSE
// streams, which are GETs only because EventSource cannot issue anything else.
func twaStateChanging(method, path string) bool {
	if method != http.MethodGet && method != http.MethodHead {
		return true
	}
	return strings.Contains(path, "/provision/") || strings.Contains(path, "/teardown/")
}

// twaTenantWriteRoutes returns every REGISTERED route pattern that both changes
// state and lands where the write lock's own classifier says the customer's
// tenant changes.
//
// Derived, not copied. The patterns come from allRoutes() — the real
// register*Routes calls replayed into a recorder — and the filter is
// isTenantWrite() itself, so tenantWritePaths, tenantWritePrefixes and the
// /api/actions/{id}/status shape are all honoured by the same code production
// runs. Adding a path to any of them and registering a handler for it puts the
// route in this list without anyone editing this file.
//
// The verb filter is NOT belt-and-braces, it is load-bearing, and building this
// guard is how that came out. isTenantWrite is keyed by PATH — deliberately, so
// the SSE streams cannot escape it — and "/api/dns/records" carries a GET read
// (ipam.go, dnsRecordsGet) as well as the POST and PATCH writes. Ask the
// classifier alone and that read is a tenant write, and this file would be
// demanding an audit row from a route that only ever reads. (It is also refused
// by the write lock on a read-only tenant, which is a separate question about
// the lock and not this guard's to answer.)
//
// It also checks the other direction: a path declared tenant-changing that no
// registration matches is either dead or a route that moved, and either way the
// lock and this guard are both pointed at nothing.
func twaTenantWriteRoutes(t *testing.T) []string {
	t.Helper()

	var out []string
	var rawPaths []string
	for _, pattern := range allRoutes(t) {
		method, raw := splitPattern(pattern)
		path := concretePath(raw)
		if !isTenantWrite(path) {
			continue
		}
		rawPaths = append(rawPaths, raw)
		if !twaStateChanging(method, path) {
			continue
		}
		out = append(out, pattern)
	}
	sort.Strings(out)

	covered := func(pred func(string) bool) bool {
		for _, p := range rawPaths {
			if pred(p) {
				return true
			}
		}
		return false
	}

	var orphans []string
	for p := range tenantWritePaths {
		if !covered(func(raw string) bool { return raw == p }) {
			orphans = append(orphans, "tenantWritePaths["+p+"]")
		}
	}
	for _, prefix := range tenantWritePrefixes {
		if !covered(func(raw string) bool { return strings.HasPrefix(raw, prefix) }) {
			orphans = append(orphans, "tenantWritePrefixes "+prefix)
		}
	}
	if !covered(func(raw string) bool {
		return strings.HasPrefix(raw, "/api/actions/") && strings.HasSuffix(raw, "/status")
	}) {
		orphans = append(orphans, "the /api/actions/{id}/status shape in isTenantWrite")
	}
	sort.Strings(orphans)
	if len(orphans) > 0 {
		t.Errorf("these tenant-write declarations in writelock.go match no route this server registers:\n  %s\n"+
			"Either the route was renamed and the write lock now gates nothing, or the entry is dead. "+
			"Both mean this audit guard is checking a route that does not exist.",
			strings.Join(orphans, "\n  "))
	}
	if len(out) == 0 {
		t.Fatal("no tenant-write routes derived — the derivation is broken, so this whole file proves nothing")
	}
	return out
}

// =============================================================================
// Harvesting the audit events the production source can actually emit
// =============================================================================

// twaHarvest is the production source of internal/server, parsed. Test files are
// excluded on purpose: an event name that appears only in a test is an event
// nothing emits.
type twaHarvest struct {
	methods map[string]*ast.FuncDecl // methods, by name
	funcs   map[string]*ast.FuncDecl // package-level functions, by name
	regs    []*ast.FuncDecl          // the register*Routes functions
}

var twaRegisterName = regexp.MustCompile(`^register\w*Routes$`)

// twaWildcard stands for a run-time value inside an assembled event name.
const twaWildcard = "*"

func twaParse(t *testing.T) *twaHarvest {
	t.Helper()
	h := &twaHarvest{methods: map[string]*ast.FuncDecl{}, funcs: map[string]*ast.FuncDecl{}}

	ents, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	fset := token.NewFileSet()
	files := 0
	for _, e := range ents {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		files++
		for _, decl := range f.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok {
				continue
			}
			if fd.Recv != nil {
				h.methods[fd.Name.Name] = fd
			} else {
				h.funcs[fd.Name.Name] = fd
			}
			if twaRegisterName.MatchString(fd.Name.Name) {
				h.regs = append(h.regs, fd)
			}
		}
	}
	if files == 0 || len(h.regs) == 0 {
		t.Fatalf("parsed %d production files and found %d register*Routes functions — the source scan is broken, "+
			"so every assertion built on it would pass vacuously", files, len(h.regs))
	}
	return h
}

// handlers maps each registered route pattern to the function bodies the router
// is handed: d.foo, the d.foo inside d.body(d.foo), or an inline func literal.
func (h *twaHarvest) handlers() map[string][]ast.Node {
	out := map[string][]ast.Node{}
	for _, reg := range h.regs {
		ast.Inspect(reg, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "HandleFunc" || len(call.Args) != 2 {
				return true
			}
			lit, ok := call.Args[0].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			pattern, err := strconv.Unquote(lit.Value)
			if err != nil {
				return true
			}
			out[pattern] = append(out[pattern], h.entryNodes(call.Args[1])...)
			return true
		})
	}
	return out
}

// entryNodes turns a handler expression into the bodies to walk.
func (h *twaHarvest) entryNodes(e ast.Expr) []ast.Node {
	var out []ast.Node
	ast.Inspect(e, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.FuncLit:
			out = append(out, v)
		case *ast.SelectorExpr:
			if fd, ok := h.methods[v.Sel.Name]; ok {
				out = append(out, fd)
			}
		case *ast.Ident:
			if fd, ok := h.funcs[v.Name]; ok {
				out = append(out, fd)
			}
		}
		return true
	})
	return out
}

// eventsFor returns every audit event name reachable from a route's handlers,
// following calls to functions declared in THIS package — which is what makes
// the events reached through roleGate, auditOutcome and the deferred
// recoverStream visible, and what makes the ones inside the seed-demo streams'
// per-template func literals visible.
func (h *twaHarvest) eventsFor(entries []ast.Node) []string {
	found := map[string]bool{}
	for _, e := range entries {
		h.walk(e, nil, map[string]bool{}, found)
	}
	out := make([]string, 0, len(found))
	for ev := range found {
		out = append(out, ev)
	}
	sort.Strings(out)
	return out
}

func (h *twaHarvest) walk(node ast.Node, binds map[string][]string, seen map[string]bool, found map[string]bool) {
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		name := twaCallee(call.Fun)
		if name == "" {
			return true
		}
		if name == "auditAppend" {
			if len(call.Args) > 0 {
				for _, ev := range h.strValues(node, call.Args[0], binds) {
					found[ev] = true
				}
			}
			return true
		}
		target, ok := h.methods[name]
		if !ok {
			target, ok = h.funcs[name]
		}
		if !ok || seen[name] {
			return true
		}
		seen[name] = true
		h.walk(target, h.bindParams(node, target.Type.Params, call.Args, binds), seen, found)
		return true
	})
}

// bindParams maps a callee's parameters to the string values of the call's
// arguments. Without it, security.go's `d.auditOutcome("block-domain", ...)`
// would harvest as an unknown value: the auditAppend it reaches is passed the
// PARAMETER, and the literal lives one frame up in the handler.
func (h *twaHarvest) bindParams(caller ast.Node, params *ast.FieldList, args []ast.Expr, binds map[string][]string) map[string][]string {
	out := map[string][]string{}
	if params == nil {
		return out
	}
	i := 0
	for _, f := range params.List {
		if len(f.Names) == 0 {
			i++
			continue
		}
		for _, nm := range f.Names {
			if i < len(args) {
				out[nm.Name] = h.strValues(caller, args[i], binds)
			}
			i++
		}
	}
	return out
}

// strValues resolves an expression to the event name(s) it can be at run time.
// Anything it cannot resolve becomes the wildcard rather than being dropped, so
// an unreadable call site shows up as an event no declaration matches instead of
// silently reducing the harvest.
func (h *twaHarvest) strValues(scope ast.Node, e ast.Expr, binds map[string][]string) []string {
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind == token.STRING {
			if s, err := strconv.Unquote(v.Value); err == nil {
				return []string{s}
			}
		}
	case *ast.ParenExpr:
		return h.strValues(scope, v.X, binds)
	case *ast.Ident:
		if got, ok := binds[v.Name]; ok {
			return got
		}
		if got := twaLocalStrings(scope, v.Name); len(got) > 0 {
			return got
		}
	case *ast.BinaryExpr:
		if v.Op == token.ADD {
			return twaCross(h.strValues(scope, v.X, binds), h.strValues(scope, v.Y, binds))
		}
	}
	return []string{twaWildcard}
}

// twaLocalStrings collects the string literals assigned to one local name in a
// function body — the shape registerWriteLockRoutes uses, where `event` is
// "tenant-write-revoked" or "tenant-write-granted" depending on a branch.
func twaLocalStrings(scope ast.Node, name string) []string {
	var out []string
	ast.Inspect(scope, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for i, lhs := range as.Lhs {
			id, ok := lhs.(*ast.Ident)
			if !ok || id.Name != name || i >= len(as.Rhs) {
				continue
			}
			lit, ok := as.Rhs[i].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				continue
			}
			if s, err := strconv.Unquote(lit.Value); err == nil {
				out = append(out, s)
			}
		}
		return true
	})
	return out
}

func twaCallee(e ast.Expr) string {
	switch v := e.(type) {
	case *ast.SelectorExpr:
		return v.Sel.Name
	case *ast.Ident:
		return v.Name
	}
	return ""
}

func twaCross(a, b []string) []string {
	out := make([]string, 0, len(a)*len(b))
	for _, x := range a {
		for _, y := range b {
			s := x + y
			for strings.Contains(s, twaWildcard+twaWildcard) {
				s = strings.ReplaceAll(s, twaWildcard+twaWildcard, twaWildcard)
			}
			out = append(out, s)
		}
	}
	return out
}

// =============================================================================
// The gate
// =============================================================================

// TestEveryTenantWriteRouteAudits is the guard. For every route the write lock
// says changes the customer's tenant:
//
//   - it must be declared in tenantWriteAuditEvents (or allowlisted, with a
//     reason) — a route nobody has thought about fails;
//   - every declared event must still be reachable from that route's real
//     handler — deleting or renaming an auditAppend call fails;
//   - the reachable set must contain at least one event that is not a refusal —
//     a route that only ever records why it did NOT act fails.
func TestEveryTenantWriteRouteAudits(t *testing.T) {
	h := twaParse(t)
	handlers := h.handlers()
	routes := twaTenantWriteRoutes(t)

	declared := map[string]bool{}
	for _, pattern := range routes {
		declared[pattern] = true

		if reason, allowed := tenantWriteAuditAllowlist[pattern]; allowed {
			if strings.TrimSpace(reason) == "" {
				t.Errorf("%s is in tenantWriteAuditAllowlist with no reason. An unaudited change to a live "+
					"customer tenant needs a justification, not a blank string.", pattern)
			}
			continue
		}

		want, ok := tenantWriteAuditEvents[pattern]
		if !ok {
			t.Errorf("%s changes data in the customer's tenant and NOTHING says it is audited.\n"+
				"  Reachable audit events from its handler: %v\n"+
				"  Add it to tenantWriteAuditEvents in this file with the event(s) its handler appends, "+
				"or to tenantWriteAuditAllowlist with the reason it cannot record what it did.",
				pattern, h.eventsFor(handlers[pattern]))
			continue
		}

		entries := handlers[pattern]
		if len(entries) == 0 {
			t.Errorf("%s is declared here but no register*Routes call hands a handler this scan can read — "+
				"the harvest for it is empty, so its declaration proves nothing", pattern)
			continue
		}

		got := h.eventsFor(entries)
		set := map[string]bool{}
		real := 0
		for _, ev := range got {
			set[ev] = true
			if !twaGenericEvents[ev] {
				real++
			}
		}

		var missing []string
		for _, ev := range want {
			if !set[ev] {
				missing = append(missing, ev)
			}
		}
		if len(missing) > 0 {
			t.Errorf("%s no longer appends %v.\n"+
				"  Still reachable from its handler: %v\n"+
				"  Either the auditAppend call was deleted or renamed — in which case a change to the "+
				"customer's tenant now goes unrecorded — or the declaration in this file is stale.",
				pattern, missing, got)
		}
		if real == 0 {
			t.Errorf("%s changes data in the customer's tenant and appends no audit event that records "+
				"the change. Reachable events: %v — all of which say only that the request was refused "+
				"or aborted, never what it did.", pattern, got)
		}
	}

	// Stale declarations. A route that was renamed leaves its old key here
	// asserting nothing, which reads as coverage that does not exist.
	var stale []string
	for pattern := range tenantWriteAuditEvents {
		if !declared[pattern] {
			stale = append(stale, pattern)
		}
	}
	for pattern := range tenantWriteAuditAllowlist {
		if !declared[pattern] {
			stale = append(stale, pattern+" (allowlist)")
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("these entries name routes the server no longer registers as tenant-changing:\n  %s\n"+
			"Delete them — a declaration for a route that does not exist reads as coverage and is none.",
			strings.Join(stale, "\n  "))
	}
}

// TestTenantWriteAuditEventsDeclarationIsComplete is the other direction: an
// audit event a tenant-write handler CAN emit but that nothing here names.
//
// It exists because the sweep that found the twelve missing records worked by
// reading every auditAppend call and asking what covered it. A new event added
// to a tenant-write handler with no entry here is the same blind spot re-opening
// — the row would exist in production and no test would know its name.
func TestTenantWriteAuditEventsDeclarationIsComplete(t *testing.T) {
	h := twaParse(t)
	handlers := h.handlers()

	var undeclared []string
	for _, pattern := range twaTenantWriteRoutes(t) {
		want := map[string]bool{}
		for _, ev := range tenantWriteAuditEvents[pattern] {
			want[ev] = true
		}
		for _, ev := range h.eventsFor(handlers[pattern]) {
			if want[ev] || twaGenericEvents[ev] {
				continue
			}
			undeclared = append(undeclared, pattern+" -> "+ev)
		}
	}
	sort.Strings(undeclared)
	if len(undeclared) > 0 {
		t.Errorf("these audit events are emitted by tenant-write handlers and named nowhere in "+
			"tenantWriteAuditEvents:\n  %s\n"+
			"Add each to the declaration in this file. An event no test names is an event that can be "+
			"deleted without anything noticing — which is exactly how the last twelve went missing.",
			strings.Join(undeclared, "\n  "))
	}
}

// TestTenantWriteAuditHarvestResolvesTheHardShapes is the watchman's watchman.
// The harvest above fails CLOSED — a broken parser yields no events and every
// route fails — but it can also fail SOFT, resolving a name to the wildcard and
// quietly excusing a whole family of routes. These three shapes are the ones
// that would go wrong silently, so each is pinned by name.
func TestTenantWriteAuditHarvestResolvesTheHardShapes(t *testing.T) {
	h := twaParse(t)
	handlers := h.handlers()

	cases := []struct{ pattern, event, shape string }{
		// Assembled at run time: "edit-" + resource + "-create".
		{"POST /api/edit/", "edit-*-create", "string concatenation around a run-time value"},
		// Passed as a parameter: blockDomain -> auditOutcome(event, ...) -> auditAppend(event, ...).
		{"POST /api/block-domain", "block-domain", "an event name passed through a helper's parameter"},
		// Reached only through a deferred call: recoverStream.
		{"GET /api/provision/site/stream", "stream-aborted", "an event reached only through a deferred call"},
		// Reached through a helper the handler calls for its own reasons.
		{"POST /api/teardown/block", "rbac_denied", "an event reached through roleGate"},
	}
	for _, tc := range cases {
		got := h.eventsFor(handlers[tc.pattern])
		found := false
		for _, ev := range got {
			if ev == tc.event {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("the harvest cannot see %q from %s (%s). Reachable: %v — the source walk has stopped "+
				"resolving this shape, so every route that uses it is now excused rather than checked.",
				tc.event, tc.pattern, tc.shape, got)
		}
	}
}

// =============================================================================
// The on-disk half
// =============================================================================

// TestTenantWriteRoutesAreRecordedOnDisk drives every derived tenant-write route
// through the REAL handler server.New builds and reads the entry back off
// audit_log.jsonl.
//
// It is deliberately the REFUSAL row, not the success row. Driving nineteen
// routes to a successful write means nineteen bespoke fake CSP upstreams, and
// those already exist one route at a time in unaudited_events_test.go and the
// *_audit_test.go files — duplicating them here would add lines and no
// information. What this adds that the source walk cannot is proof that the
// whole pipe is live for EVERY route at once: registration, the middleware
// chain, auditAppend, audit.Append's canonicalJSON, and the file. Unwire
// d.Audit, or let a detail value canonicalJSON refuses reach the log, and the
// source walk stays green while this goes red.
//
// The log is swapped onto the same *Deps lockedTestServer returns, because
// auditAppend reads d.Audit at call time and lockedTestServer keeps its own log
// path to itself.
func TestTenantWriteRoutesAreRecordedOnDisk(t *testing.T) {
	routes := twaTenantWriteRoutes(t)

	h, d, hits := lockedTestServer(t)
	logPath := filepath.Join(t.TempDir(), "audit_log.jsonl")
	d.Audit = audit.New(logPath, "app-v-test", "test-instance", audit.Options{TrustDir: t.TempDir()})

	want := map[string]string{} // concrete path -> the pattern it came from
	for _, pattern := range routes {
		method, raw := splitPattern(pattern)
		path := concretePath(raw)
		want[path] = pattern

		before := *hits
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, lockReq(method, path))

		if rr.Code != http.StatusForbidden {
			t.Fatalf("%s answered %d instead of refusing — this test cannot say anything about the audit "+
				"trail for a route the write lock let through: %s", pattern, rr.Code, rr.Body.String())
		}
		if reason, _ := bodyOf(t, rr)["reason"].(string); reason != "tenant-read-only" {
			t.Fatalf("%s was refused with reason %q, not by the write lock — some other gate answered "+
				"first, so no write-refused-read-only row is expected and this case proves nothing: %s",
				pattern, reason, rr.Body.String())
		}
		if *hits != before {
			t.Errorf("%s was refused but still reached the upstream (%d -> %d calls)", pattern, before, *hits)
		}
	}

	entries := auditEntries(t, logPath, "write-refused-read-only")
	if len(entries) == 0 {
		t.Fatalf("%d refused tenant writes and audit_log.jsonl at %s holds nothing. The audit log is not "+
			"wired into the chain, or every entry was refused by canonicalJSON and only log.Printf'd — "+
			"either way nothing that happens on these routes is being recorded.", len(routes), logPath)
	}
	got := map[string]bool{}
	for _, e := range entries {
		if p, ok := uaDetail(t, e)["path"].(string); ok {
			got[p] = true
		}
	}
	var missing []string
	for path, pattern := range want {
		if !got[path] {
			missing = append(missing, pattern+"  (no row naming "+path+")")
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("these tenant-changing routes were refused and left NO entry on disk:\n  %s\n"+
			"A refusal nobody can find afterwards is indistinguishable from a request nobody made.",
			strings.Join(missing, "\n  "))
	}
}
