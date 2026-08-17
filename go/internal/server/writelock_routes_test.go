package server

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"

	"bloxsmith/internal/edit"
)

// THE POINT OF THIS FILE: a write route that nobody classified must fail the
// build, not silently escape the per-tenant write lock.
//
// The lock in writelock.go works off two lists — tenantWritePaths (changes the
// customer's tenant, gated) and nonTenantWritePaths (does not, with the reason
// recorded for each). Two hand-maintained lists next to a growing route table is exactly the
// shape of every defect found this week: correct on the day it was written and
// quietly wrong three routes later. So this test enumerates what the server
// ACTUALLY registers and requires every state-changing route to be in exactly
// one list.
//
// *http.ServeMux cannot be read back, which is why register*Routes takes the
// `router` interface: this recorder is handed the real registration calls.

type recordingRouter struct{ patterns []string }

func (r *recordingRouter) HandleFunc(pattern string, _ func(http.ResponseWriter, *http.Request)) {
	r.patterns = append(r.patterns, pattern)
}

// allRoutesDeps is the Deps allRoutes enumerates against. Registration only
// stores closures, so almost every field can stay nil — but the OPTIONAL HANDLER
// FIELDS cannot. registerAll declares three routes behind `!= nil` checks
// (/api/update/check, /api/update/apply, /api/update/status), and a nil field
// there does not fail anything: it silently registers nothing, which is exactly
// how a route becomes invisible to this file. They are stubbed here, and
// TestRegisterAllNilChecksAreSatisfied re-derives the list of fields that need to
// be from registerAll's own syntax tree, so a FOURTH optional dependency cannot
// reopen the hole quietly.
func allRoutesDeps() *Deps {
	stub := func(w http.ResponseWriter, r *http.Request) {}
	return &Deps{UpdateCheck: stub, UpdateApply: stub, UpdateProgress: stub}
}

// allRoutes records every route production declares, by handing the recorder to
// the SAME function server.New hands the real mux.
//
// It used to call the fifteen register*Routes functions itself, which meant the
// five routes New registered inline — including the state-changing
// POST /api/update/apply — were invisible to every test in this file. Proven:
// a `mux.HandleFunc("POST /api/proof-unclassified-tenant-write", …)` added to New
// left the whole package green while being ungated by the write lock.
func allRoutes(t *testing.T) []string {
	t.Helper()
	rr := &recordingRouter{}
	allRoutesDeps().registerAll(rr)
	if len(rr.patterns) == 0 {
		t.Fatal("no routes recorded — the recorder is not being handed the real registrations, so this whole file proves nothing")
	}
	return rr.patterns
}

// splitPattern turns "POST /api/vault/init" into ("POST", "/api/vault/init").
// A pattern with no method (none exist today) is treated as every method, which
// is the strict reading.
func splitPattern(p string) (method, path string) {
	parts := strings.Fields(p)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", parts[len(parts)-1]
}

// concretePath turns a ServeMux wildcard pattern into a path the classifier will
// actually see at runtime: "/api/actions/{id}/status" -> "/api/actions/x/status".
func concretePath(path string) string {
	out := []string{}
	for _, seg := range strings.Split(path, "/") {
		if strings.HasPrefix(seg, "{") {
			seg = "x"
		}
		out = append(out, seg)
	}
	return strings.Join(out, "/")
}

func isNonTenantWrite(path string) bool {
	if nonTenantWritePaths[path] {
		return true
	}
	for _, p := range nonTenantWritePrefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

// TestEveryWriteRouteIsClassified is the gate. Every registered route that can
// change state must be in exactly one of the two lists.
//
// "Can change state" is every non-GET verb, PLUS the SSE provision/teardown
// streams, which are GETs because EventSource cannot issue anything else — they
// are the most destructive routes in the program and the reason the classifier
// is keyed by path rather than by verb.
func TestEveryWriteRouteIsClassified(t *testing.T) {
	var unclassified, both []string

	for _, pattern := range allRoutes(t) {
		method, rawPath := splitPattern(pattern)
		path := concretePath(rawPath)

		stateChanging := method != http.MethodGet && method != http.MethodHead
		if !stateChanging {
			// A GET that is nevertheless a write: the five SSE streams. If a new
			// one appears it must be added to tenantWritePaths, and this branch
			// is what notices.
			if strings.Contains(path, "/provision/") || strings.Contains(path, "/teardown/") {
				stateChanging = true
			}
		}
		if !stateChanging {
			continue
		}

		tenant := isTenantWrite(path)
		local := isNonTenantWrite(path)
		switch {
		case tenant && local:
			both = append(both, pattern)
		case !tenant && !local:
			unclassified = append(unclassified, pattern)
		}
	}

	sort.Strings(unclassified)
	sort.Strings(both)

	if len(unclassified) > 0 {
		t.Errorf("these state-changing routes are in NEITHER tenantWritePaths nor nonTenantWritePaths, "+
			"so the per-tenant write lock does not gate them and nothing says that was deliberate:\n  %s\n"+
			"Add each to internal/server/writelock.go: tenantWritePaths if it changes data in the customer's "+
			"tenant, nonTenantWritePaths (with the reason, checked not assumed) if it does not.",
			strings.Join(unclassified, "\n  "))
	}
	if len(both) > 0 {
		t.Errorf("these routes are classified as BOTH tenant-changing and local-only, which cannot be true:\n  %s",
			strings.Join(both, "\n  "))
	}
}

// knownDestructiveRoutes are the routes whose entire reason for existing is to
// change or destroy data in the customer's tenant, each paired with the verb it
// is actually reached by — the five SSE streams are GETs because EventSource
// cannot issue anything else, which is precisely why a verb-based gate would
// miss them.
//
// Two tests consume this list and they are NOT redundant:
// TestKnownDestructiveRoutesClassifiedAsTenantWrites asks the classifier, and
// TestKnownDestructiveRoutesAreGated puts a real request through the real
// server and requires it to come back refused.
var knownDestructiveRoutes = []struct{ method, path string }{
	{"GET", "/api/teardown/site/stream"},
	{"GET", "/api/teardown/seed-demo/stream"},
	{"POST", "/api/teardown/block"},
	{"GET", "/api/provision/stream"},
	{"GET", "/api/provision/site/stream"},
	{"GET", "/api/provision/seed-demo/stream"},
	{"POST", "/api/provision/block"},
	{"POST", "/api/retag/block"},
	{"POST", "/api/selfservice/allocate"},
	{"POST", "/api/dns/records"},
	{"DELETE", "/api/dns/records/some-record-id"},
	{"DELETE", "/api/ipam/addresses/some-address-id"},
	{"DELETE", "/api/edit/dns_zone/some-id"},
	// Empty id: must be gated, not fall through as a route miss.
	{"POST", "/api/edit/"},
	{"POST", "/api/block-domain"},
	{"POST", "/api/unblock-domain"},
	{"POST", "/api/actions/some-action-id/status"},
}

// TestKnownDestructiveRoutesClassifiedAsTenantWrites is the belt to the braces
// above, and it is a PURE CLASSIFIER test — the name says so on purpose. The
// list test proves nothing was FORGOTTEN; this proves isTenantWrite() actually
// says "gate it" for the routes that delete live DNS zones, subnets and address
// blocks. A refactor that made isTenantWrite() return false for everything would
// pass the test above (every route would then be reported as unclassified — but
// a refactor that made isNonTenantWrite return true for everything would pass
// it).
//
// What it CANNOT see, because it calls isTenantWrite() directly and never builds
// a request: the middleware being unwired from server.New's chain. Deleting
// `d.withWriteLock` from server.go leaves every assertion here green, because the
// classifier still classifies — it is simply no longer consulted. That is what
// TestKnownDestructiveRoutesAreGated below exists for, and why this test carries
// a name that claims classification and not gating.
func TestKnownDestructiveRoutesClassifiedAsTenantWrites(t *testing.T) {
	for _, tc := range knownDestructiveRoutes {
		if !isTenantWrite(tc.path) {
			t.Errorf("%s changes data in the customer's tenant but isTenantWrite() says it does not — it would bypass the write lock entirely", tc.path)
		}
	}

	// And the other direction: a read must not be gated, or the lock would break
	// reading a tenant you are only looking at.
	mustNotGate := []string{
		"/api/data",
		"/api/ipam/subnets",
		"/api/dns/zones",
		"/api/audit/log",
		"/api/views",
		"/api/views/my-view",
		"/api/alerts/snooze",
		"/api/vault/unlock",
		"/api/vault/tenant-writable",
		"/api/brand",
		"/api/update/apply",
		"/api/actions/some-action-id",
	}
	for _, p := range mustNotGate {
		if isTenantWrite(p) {
			t.Errorf("%s does not change the customer's tenant but isTenantWrite() says it does — the write lock would refuse a read or a local action", p)
		}
	}
}

// TestKnownDestructiveRoutesAreGated keeps the promise its name makes: each
// route is sent through the REAL handler server.New builds — reqlog, CSRF write
// guard, vault gate, tenant pin and write lock, in the order production runs
// them — and must come back refused BY THE WRITE LOCK, having reached no
// upstream.
//
// Asking the classifier is not the same question. This test was previously
// classifier-only, and removing `d.withWriteLock` from server.New's chain
// entirely left it passing: nothing in it ever constructed a request, so nothing
// in it could notice that the gate was gone. Verified by mutation both ways —
// with the lock unwired, every case here fails with the handler's own answer
// instead of a refusal.
//
// The refusal REASON is asserted, not merely the 403. A 403 from the CSRF guard
// ("forbidden — write not authorized") would otherwise stand in for a write-lock
// refusal and this test would go quietly vacuous a second time.
// gatedRouteServer is lockedTestServer plus the one dependency it leaves nil:
// Deps.Edit.
//
// Why that matters here and not in writelock_test.go. lockedTestServer already
// deliberately supplies a real (empty) provision.Engine rather than nil, so that
// removing the lock to prove these refusals are load-bearing does not simply
// panic — the comment there says so. Deps.Edit was the same hole, unnoticed:
// with the lock unwired, the three delete routes below
//
//	DELETE /api/dns/records/{id}
//	DELETE /api/ipam/addresses/{id}
//	DELETE /api/edit/{type}/{id}
//
// dereferenced a nil *edit.Client and came back 500 from recoverEdit, not from
// their handlers. Those cases therefore could not tell "the lock refused it"
// from "it would have crashed regardless" — a guard test whose negative case is
// a nil panic is not testing the guard. Wiring Edit makes the mutation answer a
// real handler result, so the 403 in the unmutated run is unambiguously the
// lock's doing.
//
// edit.New(d.Rest) reuses the SAME fake upstream lockedTestServer already
// counts, which is what keeps the zero-upstream-hits assertion honest for these
// routes: an Edit client pointed anywhere else would be invisible to the
// counter and the assertion would pass by not looking.
//
// Assigning after New() is intentional and safe: the mux holds method values
// bound to this *Deps, and each handler reads d.Edit when the request arrives.
func gatedRouteServer(t *testing.T) (http.Handler, *Deps, *int) {
	t.Helper()
	h, d, hits := lockedTestServer(t)
	d.Edit = edit.New(d.Rest)
	return h, d, hits
}

func TestKnownDestructiveRoutesAreGated(t *testing.T) {
	h, _, hits := gatedRouteServer(t)

	for _, tc := range knownDestructiveRoutes {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			before := *hits
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, lockReq(tc.method, tc.path))

			if rr.Code != http.StatusForbidden {
				t.Fatalf("%s %s changes data in the customer's tenant, but the server answered %d instead of refusing it — "+
					"the per-tenant write lock is not gating this route: %s",
					tc.method, tc.path, rr.Code, rr.Body.String())
			}
			b := bodyOf(t, rr)
			if reason, _ := b["reason"].(string); reason != "tenant-read-only" {
				t.Fatalf("%s %s was refused, but not by the write lock (reason %q) — "+
					"some other gate answered first, so this case proves nothing about the lock: %s",
					tc.method, tc.path, reason, rr.Body.String())
			}
			// Refusing AFTER acting would be worse than not refusing: the 403
			// would read like the change never happened. This now means
			// something for EVERY route in the table: with Deps.Edit wired by
			// gatedRouteServer, the three delete routes have a live client that
			// would reach the counted upstream if the lock let them through, so
			// a zero here is evidence the lock stopped them rather than evidence
			// they had nothing to call with.
			if *hits != before {
				t.Errorf("%s %s was refused but still reached the upstream (%d -> %d calls)",
					tc.method, tc.path, before, *hits)
			}
		})
	}
}

// --- the mux may only be touched through registerAll -------------------------
//
// This section replaces TestRegistrationFunctionsAllEnumerated, which compared
// the register*Routes NAMES called in New against those called in allRoutes. That
// closed a real gap — a register*Routes function wired into New and forgotten
// here — but it had nothing to say about the gap that actually existed: a bare
// mux.HandleFunc written straight into New. Five routes were registered that way,
// and an unclassified sixth passed the whole package.
//
// allRoutes now calls the same registerAll production calls, so the name
// comparison is vacuous by construction. What still needs guarding is the
// CONVENTION that makes it true: New must route every registration through
// registerAll and must not touch the mux itself. That is what these tests hold.

// funcDeclIn parses a source file in this package and returns one top-level
// function's declaration. Parsing rather than pattern-matching the text is the
// point: brace counting over Go source is defeated by nested blocks, function
// literals, comments and braces inside string literals, and the guards below are
// worth nothing if their idea of "inside New" is approximate.
func funcDeclIn(t *testing.T, file, name string) (*ast.FuncDecl, *token.FileSet) {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	for _, decl := range f.Decls {
		if fd, ok := decl.(*ast.FuncDecl); ok && fd.Name.Name == name {
			return fd, fset
		}
	}
	t.Fatalf("no func %s in %s — this guard is looking at the wrong thing and proves nothing", name, file)
	return nil, nil
}

// muxUse is one place New mentions the mux, with the source line, so a failure
// says where to look.
type muxUse struct {
	desc string
	line int
}

// TestNewRegistersOnlyThroughRegisterAll is the guard for the defect this file
// missed. Inside server.New, the mux may be:
//
//   - created exactly once (mux := http.NewServeMux()),
//   - handed to registerAll exactly once,
//   - given the "/" catch-all exactly once,
//   - passed to the middleware chain.
//
// Any other mention — a mux.HandleFunc, a second mux.Handle, a helper taking the
// mux — fails. The receiver is examined as well as the arguments, because
// `mux.HandleFunc(...)` mentions the mux as the RECEIVER of the call and a guard
// that only walked argument lists would miss the exact mutation it exists to
// catch.
func TestNewRegistersOnlyThroughRegisterAll(t *testing.T) {
	fd, fset := funcDeclIn(t, "server.go", "New")

	const muxName = "mux"
	var creations, registerAllCalls, catchAlls, bad []muxUse
	line := func(p token.Pos) int { return fset.Position(p).Line }

	// Every assignment that binds the name `mux`. More than one means a nested
	// scope could shadow the production mux, leaving the real one empty while
	// every check below still passes against the impostor.
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for _, lhs := range as.Lhs {
			if id, ok := lhs.(*ast.Ident); ok && id.Name == muxName {
				creations = append(creations, muxUse{"binding of " + muxName, line(as.Pos())})
			}
		}
		return true
	})

	// Every call that mentions the mux, as receiver or as argument.
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, isSel := call.Fun.(*ast.SelectorExpr)
		recvIsMux := false
		if isSel {
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == muxName {
				recvIsMux = true
			}
		}
		argIsMux := false
		for _, a := range call.Args {
			if id, ok := a.(*ast.Ident); ok && id.Name == muxName {
				argIsMux = true
			}
		}
		if !recvIsMux && !argIsMux {
			return true
		}
		at := line(call.Pos())
		switch {
		case recvIsMux && sel.Sel.Name == "Handle" && len(call.Args) > 0 && isStringLit(call.Args[0], `"/"`):
			catchAlls = append(catchAlls, muxUse{`mux.Handle("/", …)`, at})
		case recvIsMux:
			bad = append(bad, muxUse{"mux." + sel.Sel.Name + "(…)", at})
		case isSel && sel.Sel.Name == "registerAll":
			registerAllCalls = append(registerAllCalls, muxUse{"registerAll(mux)", at})
		default:
			// The middleware chain takes the mux as an http.Handler
			// (d.Guard.VaultGate(...)(mux)). That is not a registration and is
			// allowed; it is listed here rather than silently skipped so the
			// reasoning is visible.
		}
		return true
	})

	if len(bad) > 0 {
		t.Errorf("server.New registers routes on the mux directly:\n%s\n"+
			"Move them into registerAll. Routes declared in New are invisible to allRoutes() and "+
			"therefore to TestEveryWriteRouteIsClassified, so a tenant-changing route added here "+
			"escapes the per-tenant write lock with nothing failing.", useList(bad))
	}
	if len(registerAllCalls) != 1 {
		t.Errorf("server.New calls registerAll %d time(s), want exactly 1 — %s. Without that call the "+
			"server registers no named routes at all, and every route test in this file still passes "+
			"because they enumerate registerAll rather than New.", len(registerAllCalls), useList(registerAllCalls))
	}
	if len(catchAlls) != 1 {
		t.Errorf("server.New registers the \"/\" catch-all %d time(s), want exactly 1 — %s. Two "+
			"identical patterns make http.ServeMux panic at startup.", len(catchAlls), useList(catchAlls))
	}
	if len(creations) != 1 {
		t.Errorf("the name %q is bound %d time(s) in server.New, want exactly 1 — %s. A second binding "+
			"can shadow the production mux, so the checks above would pass against a different one.",
			muxName, len(creations), useList(creations))
	}
}

func isStringLit(e ast.Expr, want string) bool {
	lit, ok := e.(*ast.BasicLit)
	return ok && lit.Kind == token.STRING && lit.Value == want
}

func useList(uses []muxUse) string {
	if len(uses) == 0 {
		return "(none found)"
	}
	var out []string
	for _, u := range uses {
		out = append(out, fmt.Sprintf("server.go:%d %s", u.line, u.desc))
	}
	return "  " + strings.Join(out, "\n  ")
}

// TestConditionalRoutesAreRecorded pins the three routes registerAll declares
// behind a nil check. A dropped stub in allRoutesDeps does not fail anything on
// its own — the route simply is not registered, and everything downstream keeps
// passing while checking one route fewer.
func TestConditionalRoutesAreRecorded(t *testing.T) {
	got := map[string]bool{}
	for _, p := range allRoutes(t) {
		got[p] = true
	}
	for _, want := range []string{
		"GET /api/update/check",
		"POST /api/update/apply",
		"GET /api/update/status",
	} {
		if !got[want] {
			t.Errorf("%q was not recorded — it is registered behind a nil check in registerAll, so "+
				"allRoutesDeps must supply that dependency or the route is never classified", want)
		}
	}
}

// TestRegisterAllNilChecksAreSatisfied derives the requirement instead of
// restating it: it reads registerAll's syntax tree, collects every Deps field
// named in an `if` condition, and requires allRoutesDeps to leave none of them
// nil. A fourth optional dependency added tomorrow therefore fails HERE, with the
// field name, rather than quietly hiding its routes from the classifier.
//
// The check is on the CONSTRUCTED Deps by reflection, not on the source of the
// composite literal: a field written as `UpdateApply: nil` mentions the name and
// would satisfy any syntactic test while registering nothing.
func TestRegisterAllNilChecksAreSatisfied(t *testing.T) {
	fd, _ := funcDeclIn(t, "server.go", "registerAll")
	recv := "d"
	if len(fd.Recv.List) > 0 && len(fd.Recv.List[0].Names) > 0 {
		recv = fd.Recv.List[0].Names[0].Name
	}

	fields := map[string]bool{}
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		is, ok := n.(*ast.IfStmt)
		if !ok || is.Cond == nil {
			return true
		}
		// Every d.<Field> anywhere in the condition, so `a != nil && b != nil`
		// yields both rather than being missed by a single-shape match.
		ast.Inspect(is.Cond, func(c ast.Node) bool {
			sel, ok := c.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == recv {
				fields[sel.Sel.Name] = true
			}
			return true
		})
		return true
	})

	if len(fields) == 0 {
		t.Fatal("no conditional dependencies found in registerAll — either the nil checks were removed " +
			"(in which case delete this test) or the scan is broken, and a broken scan proves nothing")
	}

	d := reflect.ValueOf(allRoutesDeps()).Elem()
	var missing []string
	for name := range fields {
		f := d.FieldByName(name)
		if !f.IsValid() {
			t.Fatalf("registerAll branches on Deps.%s but that field does not exist — the scan is wrong", name)
		}
		if f.IsZero() {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("registerAll registers routes only when these Deps fields are set, and allRoutesDeps "+
			"leaves them nil:\n  %s\nTheir routes are therefore never seen by "+
			"TestEveryWriteRouteIsClassified. Give each one a stub.", strings.Join(missing, "\n  "))
	}
}

// TestRegisterAllOnRealServeMux runs the registrations against the type
// production uses. The recorder only appends to a slice, so it cannot see the one
// error a real *http.ServeMux does: a duplicate or conflicting pattern, which
// panics — at startup, in front of a user, not in CI.
func TestRegisterAllOnRealServeMux(t *testing.T) {
	defer func() {
		if rec := recover(); rec != nil {
			t.Fatalf("registerAll panicked on a real http.ServeMux: %v", rec)
		}
	}()
	allRoutesDeps().registerAll(http.NewServeMux())
}
