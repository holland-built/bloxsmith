package server

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/httpx"
)

// nowUnix is Python's _time.time() (float seconds) for the export timestamp.
func nowUnix() float64 { return float64(time.Now().UnixNano()) / 1e9 }

// intOf coerces a JSON body value to an int like Python's int(body.get(k)).
// JSON numbers decode to float64 here (server.body does not UseNumber); a
// numeric string is also accepted. Anything else -> 0 (rejected by the caller).
func intOf(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
			return n
		}
	}
	return 0
}

// registerStateRoutes wires the Phase 1c local-state endpoints: the audit-log
// read/verify + export (server.py:5083/5086), saved views (5057/5277/6085/6384),
// and the alert snooze (6282). first-seen has no route of its own — it is an
// internal store consumed by /api/incidents (a later phase).
func (d *Deps) registerStateRoutes(mux router) {
	mux.HandleFunc("GET /api/audit/log", d.auditLog)
	mux.HandleFunc("GET /api/audit/export", d.auditExport)

	mux.HandleFunc("GET /api/views", d.viewsList)
	mux.HandleFunc("POST /api/views", d.body(d.viewWrite))
	mux.HandleFunc("POST /api/views/import", d.body(d.viewWrite))
	mux.HandleFunc("GET /api/views/{name}", d.viewGet)
	mux.HandleFunc("DELETE /api/views/{name}", d.viewDelete)

	mux.HandleFunc("POST /api/alerts/snooze", d.body(d.snooze))
}

// auditLogReturnCap is the most entries GET /api/audit/log will put in one
// response. A var, not a const, ONLY so audit_log_cap_test.go can lower it to a
// handful and exercise the truncation arm without appending thousands of real
// hash-chained entries; nothing in the binary writes to it.
//
// MEASURED, not assumed (2026-08-21, against the live dev server):
//
//	curl -s http://127.0.0.1:8080/api/audit/log | wc -c   ->  380936
//	                                          entries      ->  838
//
// 380,936 bytes for 838 entries, re-sent in full every 30 seconds — the Audit
// tab polls at `poll: 30000` (ui/src/tabs/Audit.jsx:59) — and that file only
// grows, because it is append-only by construction.
//
// WHAT THE CAP SAVES: encoding those entries to JSON, the bytes on the wire,
// and the browser's parse plus the row objects auditChain.js builds from them.
//
// WHAT IT CANNOT SAVE, and this must not be overclaimed: the file read or the
// verification. Read() still walks every line of the file, and Verify() runs a
// SECOND full Read() of its own (audit.go:528) plus a hash of every entry,
// deliberately — chain_valid is a verdict about the WHOLE log, and computing it
// over a returned slice would turn "this chain is intact" into "the tail we
// happened to send looks fine". So the server-side cost is essentially
// unchanged; what shrinks is everything downstream of it.
//
// WHY 2000: comfortably above today's 838, so the whole log still arrives and
// the tab's browser-side filter box (Audit.jsx:437, the <input> in AuditTable's
// header — the earlier citation of :308 pointed inside ChainVerdict) keeps searching everything
// there is, exactly as it does now. It is the same number as
// dashboard.SignalsCap, and matching it is intentional: two different "this
// response is big enough" limits with two different values is a thing someone
// later has to reconcile.
//
// AT THE BOUNDARY, NEWEST WINS. The oldest entries are the ones dropped; an
// operator opening the Audit tab is looking at what just happened.
//
// THIS IS A PAYLOAD-SIZE MEASURE WITH NO SECURITY MEANING. It is not a
// permission, not a redaction, and not an access-control boundary. See
// auditExport for the other half of that ruling.
var auditLogReturnCap = 2000

// auditLog is GET /api/audit/log (server.py:5083): the whole chain plus its
// verification verdict. chain_valid/broken_index keep their original
// meaning (unchanged for existing consumers); chain_verify_error is the added
// third state — set when the chain could not be checked, so a caller can
// tell "intact" apart from "we could not check". It must never be paired with
// chain_valid: true.
//
// broken_reason is additive and only present on the tampered verdict: it says
// WHICH check failed (a bad signature, a short chain, an altered seal), since
// "broken at entry #7" alone does not tell an operator whether they are looking
// at a forged entry or a truncated tail. Consumers that read only broken_index
// are unaffected. There are still exactly three states.
//
// read_error and skipped_lines are the READ's own honesty, and they are a
// different fact again from both of the two above. Log.Read returns three
// values and this handler discarded two of them, so a log that could not be
// opened returned 200 with `entries: []`, and a log with unparseable lines
// returned 200 with a SHORTER list — in both cases indistinguishable from a
// quiet day. Nothing downstream could tell the difference, because nothing
// downstream was told. The chain verdict does not cover this: Verify answers
// "is what is on disk still what was written", and a file the reader could not
// open has no bearing on that question.
//
// Both are omitted when there is nothing to report, for the same reason
// last_append_failure is: a `"read_error": null` on every healthy response
// trains a reader to skip the field on the one response that sets it.
//
// returned/total/truncated are the newest-N cap's own honesty, in the shape
// /api/incidents already uses for signals_total/signals_truncated (noc.go:167).
// A capped list with no count beside it is the same class of lie this handler's
// read_error fixed: a short array that reads as a short log. Three points the
// reviews of this change insisted on, because each was overclaimed in a draft:
//
//   - WHEN THE READ FAILED, NOTHING IS CAPPED. Read() hands back the prefix it
//     managed plus the error, so every line after the failure point was never
//     seen and the genuinely newest entries may be among them. Slicing that and
//     labelling it "the newest N" would be a fabrication. On that path the whole
//     partial result is returned, truncated is false, and read_error carries the
//     fact instead.
//   - total IS THE NUMBER OF ENTRIES THIS READ DECODED. It is not the number of
//     entries in the file: when skipped_lines > 0 it undercounts, by exactly the
//     lines that would not parse. Read the two fields together or not at all.
//   - THE CHAIN VERDICT DOES NOT DESCRIBE total ENTRIES. Read() and Verify() are
//     two independent passes over the file (the readSkewHook seam at
//     audit.go:520 exists precisely because that gap is real), so an append
//     landing between them leaves the count and the verdict describing two
//     different snapshots of the log. They agree in the ordinary case and are
//     not guaranteed to.
func (d *Deps) auditLog(w http.ResponseWriter, r *http.Request) {
	entries, skipped, readErr := d.Audit.Read()
	chain := d.Audit.Verify()
	state, detail := audit.Classify(chain)

	// Newest-N, oldest-first WITHIN the slice: auditChain.js:112 documents that
	// entries arrive oldest-first and deliberately does not re-sort, so taking a
	// tail slice preserves the contract while reversing here would break it.
	// (The line was cited as :88 until 2026-08-21, which is DETAIL_NOISE's
	// comment — a different rule about which detail keys are dropped from a cell.)
	total := len(entries)
	truncated := readErr == nil && total > auditLogReturnCap
	if truncated {
		entries = entries[total-auditLogReturnCap:]
	}

	out := map[string]any{
		"entries":            entries,
		"returned":           len(entries),
		"total":              total,
		"truncated":          truncated,
		"chain_valid":        chain["valid"],
		"broken_index":       chain["broken_index"],
		"broken_reason":      chain["broken_reason"],
		"chain_verify_error": chain["verify_error"],
		// chain_state is the same tri-state as the four fields above, decided in
		// ONE place (audit.Classify) instead of re-derived by each consumer. The
		// old fields stay: they are what the UI reads today and dropping them
		// would be a breaking change for no gain. What this adds is a single word
		// — intact / tampered / could-not-verify — that agrees by construction
		// with what `bloxsmith audit verify` prints for the same log.
		"chain_state":  string(state),
		"chain_detail": detail,
	}
	if readErr != nil {
		out["read_error"] = readErr.Error()
	}
	if skipped > 0 {
		out["skipped_lines"] = skipped
	}
	mergeAppendHealth(out, d.Audit.AppendHealth())
	d.json(w, r, 200, out)
}

// mergeAppendHealth copies the audit log's append-failure counters alongside the
// chain verdict, without touching it.
//
// These are deliberately SEPARATE facts, and the separation is the whole point.
// chain_state answers "is what is on disk still what was written"; append_failures
// answers "did something never reach disk at all". A dropped entry leaves the
// chain genuinely intact — the entry was never written, so nothing was tampered
// with — and folding the two together would either invent a fourth chain state
// or make "tampered" mean two different things, and an operator reading either
// one would be misled about which failure they are looking at.
//
// last_append_failure is absent, not zeroed, when nothing has failed; see
// audit.AppendHealth for why a placeholder would be its own small lie.
func mergeAppendHealth(out, health map[string]any) {
	for k, v := range health {
		out[k] = v
	}
}

// auditExport is GET /api/audit/export (server.py:5086): the same chain as
// /api/audit/log plus exported_at + app_version, for downloading as a bundle.
// See auditLog for the chain_verify_error contract.
//
// THE ADMIN GATE WAS REMOVED HERE on the user's decision of 2026-08-20 (issue
// #170). It was a port of server.py:5086 and it guarded nothing: GET
// /api/audit/log serves the identical `entries` array, the identical chain
// verdict and the identical append-failure counters to any viewer, ungated. The
// only fields the gate actually withheld were exported_at (a timestamp of the
// moment the caller pressed the button) and app_version (already on the
// dashboard). A viewer who wanted the entries simply called the other route.
// What the gate did buy was a 403 and an rbac_denied row for a request that was
// not, in substance, being denied anything.
//
// rbac_denied IS STILL LIVE at three other sites, verified by grep over
// internal/ before this line was written: server.go:276 (updateApply — replacing
// the running binary), edit.go:37 (requireRole, the shared write-guard every
// mutating edit route funnels through), and state.go's snooze below (muting an
// alert category). Those refuse a caller something they genuinely cannot
// otherwise have. This one did not.
//
// AND THE PART A LATER READER NEEDS MOST: /api/audit/log now caps its response
// at auditLogReturnCap newest entries, which makes THIS route the only one that
// returns older entries in full. That cap is a PAYLOAD-SIZE measure and
// explicitly NOT an access-control boundary — it must never become the thing
// standing between a viewer and half the audit log. The user was asked about
// exactly this on 2026-08-20 and ruled that a performance constant must not be
// load-bearing for access. So: if the export is ever gated again, cap it in the
// same change, or the cap silently becomes a permission nobody wrote down.
//
// httpx is still used here, by the audit row at the foot of this handler: the
// gate went, the identity of the caller did not stop mattering.
func (d *Deps) auditExport(w http.ResponseWriter, r *http.Request) {
	entries, skipped, readErr := d.Audit.Read()
	chain := d.Audit.Verify()
	state, detail := audit.Classify(chain)
	out := map[string]any{
		"entries":            entries,
		"chain_valid":        chain["valid"],
		"broken_index":       chain["broken_index"],
		"broken_reason":      chain["broken_reason"],
		"chain_verify_error": chain["verify_error"],
		// Same single word as /api/audit/log, from the same classifier — an
		// exported bundle that disagreed with the live view about its own
		// integrity would be worse than useless.
		"chain_state":  string(state),
		"chain_detail": detail,
		"exported_at":  nowUnix(),
		"app_version":  d.Version,
	}
	// read_error and skipped_lines, the same two fields /api/audit/log publishes
	// and for the same reason — this route was still doing `entries, _, _ :=
	// d.Audit.Read()`, so an unopenable log exported as `entries: []` with a 200,
	// and a part-decodable one exported short, with nothing in the bundle saying
	// either had happened.
	//
	// It matters MORE here than on the live view. The live view is a screen
	// someone refreshes; a wrong answer is corrected 30 seconds later. A bundle is
	// downloaded, filed, attached to a ticket and read months afterwards by
	// someone who was not there — it is precisely the artefact that gets treated
	// as a complete record of the period it covers. A silently short export is
	// therefore a lie with a very long half-life, and the operator who could have
	// caught it is out of the room by the time it is believed. Omitted when there
	// is nothing to report, per the same rule as last_append_failure.
	if readErr != nil {
		out["read_error"] = readErr.Error()
	}
	if skipped > 0 {
		out["skipped_lines"] = skipped
	}
	// THE EXPORT IS ITSELF AN AUDITED EVENT (2026-08-21). Before this line, a
	// SUCCESSFUL export wrote nothing to the log: this file's only auditAppend
	// calls were the rbac_denied on the gate above and snooze's. That was
	// survivable while the route was admin-only and every refusal was recorded —
	// the set of callers who could reach it was already written down. Removing
	// the gate in #170 turned downloading the entire append-only trail (every
	// actor, every tenant write, every refusal, months of it) into an
	// unauthenticated read that left no trace, and per unaudited_events_test.go's
	// stated rule a security-relevant action nobody can find afterwards is
	// indistinguishable from one nobody made. The gate removal is still right;
	// what it removed was the ONLY record this route produced, and that had to be
	// replaced rather than simply dropped.
	//
	// ORDERING, chosen deliberately: the append happens AFTER d.Audit.Read() has
	// returned, so the row recording this download is NOT inside the bundle it
	// describes. Appending first would put an entry claiming "entries: N" into a
	// bundle carrying N+1 — a record that contradicts its own contents — and
	// would also mean a failed append aborted a read that had already succeeded.
	// The consequence is intended and worth stating: an export is visible in the
	// NEXT export, never in itself.
	//
	// It is also placed BEFORE mergeAppendHealth so that if this very append is
	// refused, the bundle's own append_failures counter says so. Otherwise the one
	// download whose record went missing would be the one download that looked
	// perfectly healthy.
	//
	// DETAIL IS THE COUNT AND NOTHING ELSE. The entries themselves are already in
	// the log — copying them into a row inside that same log would double it on
	// every download, forever, in a file that cannot be amended. The count is what
	// an investigator reconciles against; it is the number of entries THIS read
	// decoded, which read_error and skipped_lines above qualify.
	d.auditAppend("audit-export", httpx.Actor(r), map[string]any{"entries": len(entries)})

	// An export that shows only the entries that made it, with no count of the
	// ones that did not, reads as a complete record of the period it covers.
	// It is not one whenever append_failures > 0, so the bundle carries the
	// same counters as the live view.
	mergeAppendHealth(out, d.Audit.AppendHealth())
	d.json(w, r, 200, out)
}

// viewsList is GET /api/views (server.py:5057): names/timestamps only.
// A views-directory read/decode failure must not be presented as "no saved
// views" — that would tell the caller their views were deleted when really
// the read just failed. Report it as a 500 instead; only a genuinely empty
// (or never-created) views directory renders as {"views": []}.
func (d *Deps) viewsList(w http.ResponseWriter, r *http.Request) {
	out, err := d.Store.ViewsList()
	if err != nil {
		d.logExc("/api/views", err)
		d.json(w, r, 500, map[string]any{"error": "internal error"})
		return
	}
	d.json(w, r, 200, out)
}

// viewWrite is POST /api/views and /api/views/import (server.py:6085).
func (d *Deps) viewWrite(w http.ResponseWriter, r *http.Request, b map[string]any) {
	payload, status := d.Store.ViewWrite(b)
	d.json(w, r, status, payload)
}

// viewGet is GET /api/views/{name} (server.py:5277).
func (d *Deps) viewGet(w http.ResponseWriter, r *http.Request) {
	v := d.Store.ViewRead(r.PathValue("name"))
	if v == nil {
		d.json(w, r, 404, map[string]any{"error": "not found"})
		return
	}
	d.json(w, r, 200, v)
}

// viewDelete is DELETE /api/views/{name} (server.py:6384).
func (d *Deps) viewDelete(w http.ResponseWriter, r *http.Request) {
	if d.Store.ViewDelete(r.PathValue("name")) {
		d.json(w, r, 200, map[string]any{"ok": true})
		return
	}
	d.json(w, r, 404, map[string]any{"error": "not found"})
}

// snooze is POST /api/alerts/snooze (server.py:6282): operator-gated, persists
// the snooze and writes an explicit "snooze" audit entry (in addition to the
// "write-authorized" entry the write-guard already logged for this mutation).
func (d *Deps) snooze(w http.ResponseWriter, r *http.Request, b map[string]any) {
	role := d.Guard.ResolveRole(r)
	if !httpx.RoleAtLeast(role, "operator") {
		d.auditAppend("rbac_denied", role,
			map[string]any{"required": "operator", "path": "/api/alerts/snooze"})
		d.json(w, r, 403, map[string]any{"ok": false, "error": "operator required"})
		return
	}
	category := strings.TrimSpace(str(b, "category"))
	minutes := intOf(b["minutes"])
	if category == "" || minutes <= 0 {
		d.json(w, r, 400, map[string]any{"ok": false, "error": "category and minutes>0 are required"})
		return
	}
	if err := d.Store.Snooze(category, minutes); err != nil {
		d.json(w, r, 500, map[string]any{"ok": false, "error": "internal error"})
		return
	}
	d.auditAppend("snooze", httpx.Actor(r),
		map[string]any{"category": category, "minutes": minutes})
	d.json(w, r, 200, map[string]any{"ok": true, "category": category, "minutes": minutes})
}
