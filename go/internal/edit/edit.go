// Package edit ports server.py's non-provisioning DNS + Cloud-Resource-Editor
// write builders: _dns_rdata (417), _dns_record_create/update (466/516),
// _selfservice_allocate (584, incl. plan 016's orphan-IP compensation), and the
// nine _edit_* create/update builders (697-1030). Each function validates its
// input, honours the dry-run preview, then goes through the shared rest.Client
// (the single outbound write path), returning (result, http_status) exactly like
// its Python counterpart. The HTTP routing, RBAC gate, and audit logging live in
// internal/server; this package is pure request→REST→response logic.
package edit

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"bloxsmith/internal/rest"
)

// Client wraps the shared REST proxy. One per process (built in main.go).
type Client struct{ Rest *rest.Client }

// New binds the builders to the shared rest.Client.
func New(r *rest.Client) *Client { return &Client{Rest: r} }

// With rebinds the builders to a request-scoped rest.Client so every write in
// one request goes to the tenant that request started against. See
// rest.Client.Pin.
func (c *Client) With(r *rest.Client) *Client { return &Client{Rest: r} }

// M is the (result, status) response shape every builder returns.
type M = map[string]any

// --- body coercion helpers (server.body decodes JSON with float64 numbers) ---

// strOr is Python `str(body.get(k) or "").strip()`: a falsy value (nil, "", 0,
// false) collapses to "", anything else is stringified and trimmed.
func strOr(b M, k string) string {
	v := b[k]
	if v == nil || isFalsy(v) {
		return ""
	}
	return strings.TrimSpace(pyStr(v))
}

// has is Python `body.get(k) is not None`: the key is present and non-null.
func has(b M, k string) bool { v, ok := b[k]; return ok && v != nil }

// pyStr mirrors Python str() for the scalar types a JSON body yields.
func pyStr(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "True"
		}
		return "False"
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", t)
	}
}

// isFalsy mirrors Python truthiness for the value collapsing in strOr's `or ""`.
func isFalsy(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return t == ""
	case bool:
		return !t
	case float64:
		return t == 0
	case []any:
		return len(t) == 0
	case M:
		return len(t) == 0
	default:
		return false
	}
}

// boolPy is Python bool(x): a real bool passes through; a non-empty string /
// non-zero number / non-empty collection is truthy. Behaviour unchanged; it is
// still used for the `disabled` field on several builders (edit.go:457,
// resources.go:74/204/299) and for `auto_generate_records` (resources.go:327).
// It is NO LONGER used for any `dry` flag: the two DNS-record paths that used to
// read `dry` with it now go through dryMustBeExplicitBool (see below), and every
// other write builder uses truthyDry.
func boolPy(v any) bool { return !isFalsy(v) }

// truthy is _truthy (server.py:_truthy): nil -> default; real bool -> itself;
// otherwise str(v).strip().lower() not in {"0","false","no",""}.
func truthy(v any, def bool) bool {
	if v == nil {
		return def
	}
	if b, ok := v.(bool); ok {
		return b
	}
	s := strings.ToLower(strings.TrimSpace(pyStr(v)))
	switch s {
	case "0", "false", "no", "":
		return false
	}
	return true
}

// truthyDry is _truthy_dry: dry preview unless explicitly disabled (default true).
func truthyDry(v any) bool { return truthy(v, true) }

// errDryNotBool is the single refusal message both DNS-record builders return
// for an ambiguous `dry` flag.
const errDryNotBool = "dry must be true or false"

// dryMustBeExplicitBool is the `dry` gate for the two DNS-record builders ONLY
// (DNSRecordCreate, DNSRecordUpdate). `dry` must be PRESENT and a JSON true or
// false. A string ("false", "0", "no", "true"), a number, an explicit null, or
// an omitted key are all refused — the caller gets a 400 and nothing is sent
// upstream.
//
// WHY. Until now these two builders read `dry` with boolPy while every other
// write builder used truthyDry, and the two helpers disagree about the same
// input: the STRING "false" previewed, the BOOLEAN false wrote live, and an
// OMITTED flag wrote live (every other builder treats omitted as a preview).
// Same operator intent, opposite outcome, on the one builder family whose
// mistakes land as real records in a customer's DNS.
//
// Refusing the ambiguous flag is the only fix where risk moves strictly
// downward: nothing that previews today can become a live write, and a caller
// who relied on omitted-dry-meaning-live now breaks LOUDLY with a 400 instead of
// silently getting the opposite of what they meant. An ambiguous flag is
// refused, not guessed — unknown means unknown.
//
// DELIBERATE DIVERGENCE from the Python reference. The old boolPy behaviour was
// documented as server.py parity, but server.py is NOT in this repo, so that
// parity was only ever ASSUMED and has never been verified by anyone here.
//
// BREAKING CHANGE for direct API callers (curl, scripts, an LLM building JSON)
// of POST/PATCH /api/dns/records who omit `dry` and expect a live write: they
// must now send `dry: false`. The UI is unaffected — ui/src/tabs/SelfService.jsx
// always sends `dry` as an explicit JSON boolean.
//
// Scope, honestly stated: this applies to DNSRecordCreate and DNSRecordUpdate
// only. boolPy and truthyDry are unchanged and every other builder keeps its
// existing default (truthyDry: an omitted `dry` is a preview).
func dryMustBeExplicitBool(body M) (dry bool, ok bool) {
	v, present := body["dry"]
	if !present {
		return false, false
	}
	b, isBool := v.(bool)
	return b, isBool
}

// intCoerce is Python int(x) for JSON scalars: (n, ok). float64/int strings ok;
// a fractional float truncates toward zero, matching int(3.9)==3 is NOT Python —
// Python int(3.9)==3 (truncates) so this matches. A bad string -> ok=false.
func intCoerce(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
			return n, true
		}
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// segRe is the allowed shape of a single path segment (the final component of
// an object id): no slashes, no encoded separators, no traversal dots.
var segRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// ObjectPath builds the /api/ddi/v1 path for a CSP object id. Ids come in two
// forms: full-form ("dns/record/<uuid>", as returned by every list endpoints)
// and bare uuid. Prefixing the type path onto a full-form id yields
// /api/ddi/v1/dns/record/dns/record/<uuid>, which CSP answers with 501.
//
// Hardened against path traversal and type confusion: the id is validated
// before it ever reaches the outgoing request. A full-form id must be exactly
// kind+"/"+seg (anything else — including "..", a different kind prefix, or
// extra segments — is rejected); a bare id must itself be a single valid
// segment. Go's HTTP transport does not clean ".." out of a request path, so
// an unvalidated id here would let a caller reach arbitrary CSP paths under
// the server's own API key.
func ObjectPath(kind, id string) (string, error) {
	const errInvalid = "invalid object id"

	trimmed := strings.Trim(strings.TrimSpace(id), "/")
	if trimmed == "" {
		return "", fmt.Errorf(errInvalid)
	}
	for _, bad := range []string{"..", "%2f", "%2F", "\\"} {
		if strings.Contains(trimmed, bad) {
			return "", fmt.Errorf(errInvalid)
		}
	}
	for _, r := range trimmed {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf(errInvalid)
		}
	}

	if strings.Contains(trimmed, "/") {
		seg := trimmed[strings.LastIndex(trimmed, "/")+1:]
		if !segRe.MatchString(seg) {
			return "", fmt.Errorf(errInvalid)
		}
		if trimmed != kind+"/"+seg {
			return "", fmt.Errorf(errInvalid)
		}
		return "/api/ddi/v1/" + trimmed, nil
	}

	if !segRe.MatchString(trimmed) {
		return "", fmt.Errorf(errInvalid)
	}
	return "/api/ddi/v1/" + kind + "/" + trimmed, nil
}

// asMap type-asserts a REST response to a JSON object, else nil.
func asMap(v any) M {
	if m, ok := v.(M); ok {
		return m
	}
	return nil
}

// resultOrSelf is Python `resp.get("result") or resp`: prefer the "result"
// object, fall back to the whole body.
func resultOrSelf(resp any) any {
	if m := asMap(resp); m != nil {
		if r := m["result"]; !isFalsy(r) {
			return r
		}
	}
	return resp
}

// statusOr is Python `status or 502`: 0 (no HTTP response) -> fallback.
func statusOr(status, fallback int) int {
	if status == 0 {
		return fallback
	}
	return status
}

// statusPhrase renders an upstream status for an OPERATOR-FACING string.
//
// WHY: 0 is not an HTTP status. rest.Client.Write (rest.go:344) and
// rest.Client.GetEx report 0 when the request never got a response at all —
// DNS, dial, TLS or any other transport failure — so the tenant answered
// nothing. Printing "(status 0)" renders "we could not reach the tenant" in the
// exact shape of "the tenant replied", which is the one thing an error string
// here must never do: a call that failed and a call that returned a value must
// not look the same.
//
// SCOPE: presentation only. Every caller still derives its RETURN CODE from
// statusOr(status, 502), so a transport failure is still a 502 — this function
// deliberately changes no status code and introduces no new status word.
func statusPhrase(status int) string {
	if status == 0 {
		return "could not reach the tenant — no request completed"
	}
	return fmt.Sprintf("status %d", status)
}

// --- the third create outcome ------------------------------------------------

// CreatedUnreadableKey is the result field marking the one outcome a create can
// have that is NEITHER a success NOR a failure: upstream ACCEPTED the write
// (200/201) and the object is LIVE on the customer's tenant, but the response
// body cannot be read as the object it created, so we hold no id for it.
//
// WHY IT HAS TO EXIST. rest.Client.Write (rest.go) returns a nil body for an
// empty 2xx response and, because it discards the decode error
// (`_ = json.Unmarshal`), for a non-JSON 2xx response too. Every create builder
// used to fold that nil into its failure arm — `(status != 200 && status != 201)
// || resp == nil` — so a 201 with an unreadable body was reported to the
// operator as "create failed" and, being ok:false, was audited nowhere. The
// object existed on the tenant with the screen saying it did not and the log
// saying nothing at all. Nothing could find it again. This is the same family as
// SubnetCreate's tagging_failed arm (see internal/server/edit.go): an outcome
// that left a live object behind must still be recorded.
//
// WHAT THIS RESULT PROMISES. It claims nothing it cannot prove. There is no
// "ok" key at all — ok:true would hand the caller a success with no id, and
// ok:false is the lie that lost the object. No id, no object body and no other
// field is invented; the only things stated are the resource kind, the upstream
// status, and a message telling the operator plainly that the thing exists and
// must be found by hand. The route layer keys its audit row off this field
// (server/edit.go), so the row exists even though the id does not.
const CreatedUnreadableKey = "created_unreadable"

// writeUnreadable reports whether a write landed in that state: upstream said
// 200/201, and what came back is not a JSON object we can pull the created
// object out of (empty body, non-JSON body — both nil out of rest.Write — or a
// 2xx body that is not an object). A 4xx/5xx is NOT this: upstream answered and
// refused, nothing was created, and the caller's genuine failure arm still runs.
func writeUnreadable(resp any, status int) bool {
	return (status == 200 || status == 201) && asMap(resp) == nil
}

// createdUnreadable builds that result. `what` names the resource in operator
// words ("DNS zone"); `alsoUnknown`, when non-empty, appends the one extra
// consequence this particular call site carries (SubnetCreate cannot tag a
// subnet whose id it never saw).
func createdUnreadable(what string, status int, alsoUnknown string) M {
	msg := fmt.Sprintf("the tenant ACCEPTED this %s (%s) but returned no readable body: the %s EXISTS "+
		"and its id is unknown here. Find it in the tenant before retrying — a retry creates a duplicate",
		what, statusPhrase(status), what)
	if alsoUnknown != "" {
		msg += ". " + alsoUnknown
	}
	return M{
		CreatedUnreadableKey: true,
		"resource":           what,
		"status":             status,
		"error":              msg,
	}
}

// --- the third UPDATE outcome ------------------------------------------------

// UpdatedUnreadableKey is CreatedUnreadableKey's sibling for the five update
// builders, and closes the identical hole one verb over: upstream ACCEPTED the
// PATCH, the customer's object IS changed, and what came back cannot be read as
// the updated object.
//
// WHY IT HAS TO EXIST. Every update builder ended with
// `(status != 200 && status != 201) || resp == nil`, so three ordinary upstream
// answers landed in the failure arm: a 204 No Content, an empty 200, and a
// non-JSON 200 (rest.Client.Write nils all three — and a truncated read too,
// since it discards both the io.ReadAll error and the decode error). The
// operator was told "update failed (status 200)" — a sentence that refutes
// itself — while the change was live on the tenant, and because
// server/edit.go gates its audit row on ok:true, NOTHING was written down. The
// same class as the create side, with one extra edge: a JSON ARRAY body was not
// nil, so it sailed through as a clean success and put an array where the
// updated object should be.
//
// THE THREE ARMS, as a partition rather than a status list. Not-2xx is a
// failure, and nothing else is. A 200 or 201 carrying a JSON object is a clean
// update. Everything else in the 2xx family — 204, 202, and any 200/201 whose
// body is not an object — is this outcome: upstream took the change and we
// cannot show it.
//
// WHAT IT PROMISES. There is no "ok" key: ok:true would claim an updated object
// nobody can produce, ok:false is the lie that loses the change. Unlike the
// create version it CAN name the object — the id is the caller's own input — so
// the operator has something to re-read. The "error" key carries the message on
// purpose: both UI tabs branch on `j.error` (ui/src/tabs/Editor.jsx:171/213,
// SelfService.jsx), so its presence is what keeps the screen from painting an
// unconfirmed change green.
const UpdatedUnreadableKey = "updated_unreadable"

// updateUnreadable reports the third arm above. It deliberately covers the whole
// 2xx family minus the clean-update shape: 202 Accepted and 204 No Content both
// mean upstream took the change, and neither can be shown as a completed update.
func updateUnreadable(resp any, status int) bool {
	if status < 200 || status > 299 {
		return false
	}
	if status == 200 || status == 201 {
		return asMap(resp) == nil
	}
	return true
}

// updateFailed is the failure arm's test, stated once so all five builders
// agree: anything outside 2xx, and nothing else.
func updateFailed(status int) bool { return status < 200 || status > 299 }

// updatedUnreadable builds the result. `what` names the resource in operator
// words ("DNS record"); `id` is the object the caller asked to change.
func updatedUnreadable(what, id, method string, status int) M {
	return M{
		UpdatedUnreadableKey: true,
		"resource":           what,
		"id":                 id,
		"method":             method,
		"status":             status,
		"error": fmt.Sprintf("the tenant ACCEPTED this %s update (%s) but returned no readable object: "+
			"the change is LIVE and cannot be confirmed here. Re-read %s from the tenant to see its "+
			"current values — do not assume the update was lost", what, statusPhrase(status), id),
	}
}

// bodyStatus is the status THIS server answers with for a result that carries a
// body. 204 means "no content", so replying 204 with a JSON body is malformed —
// and the route handlers pass a builder's status straight to d.json. The real
// upstream status is never lost: it stays in the result's "status" field.
func bodyStatus(status int) int {
	if status == 204 {
		return 200
	}
	return status
}

// --- _dns_rdata (server.py:417) ----------------------------------------------

// Rdata is _dns_rdata: presentation-format value -> API rdata dict, covering
// A/AAAA/CNAME/PTR/NS/DNAME/TXT/MX/SRV/CAA with a PRESENTATION fallback. Returns
// an error (mapped to 400 by callers) on a missing/malformed value.
func Rdata(rtype, value string) (M, error) {
	rt := strings.ToUpper(strings.TrimSpace(rtype))
	v := strings.TrimSpace(value)
	if v == "" {
		return nil, fmt.Errorf("rdata is required for %s records", rt)
	}
	switch rt {
	case "A", "AAAA":
		return M{"address": v}, nil
	case "CNAME":
		return M{"cname": v}, nil
	case "PTR", "NS":
		return M{"dname": v}, nil
	case "DNAME":
		return M{"target": v}, nil
	case "TXT":
		if len(v) >= 2 && strings.HasPrefix(v, `"`) && strings.HasSuffix(v, `"`) {
			v = v[1 : len(v)-1]
		}
		return M{"text": v}, nil
	case "MX":
		parts := fields(v, 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf(`MX rdata must be "preference exchange" (e.g. "10 mail.example.com."), got: '%s'`, v)
		}
		pref, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil, fmt.Errorf("MX preference must be an integer, got: '%s'", parts[0])
		}
		return M{"preference": pref, "exchange": parts[1]}, nil
	case "SRV":
		parts := fields(v, 4)
		if len(parts) != 4 {
			return nil, fmt.Errorf(`SRV rdata must be "priority weight port target" (e.g. "10 0 443 host.example.com."), got: '%s'`, v)
		}
		pri, e1 := strconv.Atoi(parts[0])
		wt, e2 := strconv.Atoi(parts[1])
		port, e3 := strconv.Atoi(parts[2])
		if e1 != nil || e2 != nil || e3 != nil {
			return nil, fmt.Errorf("SRV rdata contains non-integer field")
		}
		return M{"priority": pri, "weight": wt, "port": port, "target": parts[3]}, nil
	case "CAA":
		parts := fields(v, 3)
		if len(parts) != 3 {
			return nil, fmt.Errorf(`CAA rdata must be "flags tag value" (e.g. "0 issue letsencrypt.org"), got: '%s'`, v)
		}
		flags, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil, fmt.Errorf("CAA flags must be an integer, got: '%s'", parts[0])
		}
		return M{"flags": flags, "tag": parts[1], "value": parts[2]}, nil
	}
	return M{"subfields": []any{M{"type": "PRESENTATION", "value": v}}}, nil
}

// fields mirrors Python str.split(None, maxsplit): split on runs of whitespace,
// at most maxsplit+1 pieces, no empty leading/trailing tokens.
func fields(s string, max int) []string {
	all := strings.Fields(s)
	if max <= 0 || len(all) <= max {
		return all
	}
	head := all[:max-1]
	// rejoin the remainder as the final field, preserving its internal spacing
	// the way Python's maxsplit does (only relevant for TXT-like tails).
	rest := strings.TrimLeft(s, " \t\n")
	for _, f := range head {
		rest = strings.TrimPrefix(rest, f)
		rest = strings.TrimLeft(rest, " \t\n")
	}
	return append(append([]string{}, head...), rest)
}

// --- _dns_record_create (server.py:466) --------------------------------------

func (c *Client) DNSRecordCreate(body M) (M, int) {
	zoneID := strOr(body, "zone_id")
	rtype := strings.ToUpper(strOr(body, "type"))
	value := strOr(body, "value")

	// Refuse an ambiguous preview/live flag before anything else. This runs
	// ahead of the required-field checks on purpose: "would this request write
	// to the live tenant?" is the one question that must never be guessed, so a
	// caller who is wrong about it hears about that first. Zero upstream calls.
	dry, dryOK := dryMustBeExplicitBool(body)
	if !dryOK {
		return M{"ok": false, "error": errDryNotBool}, 400
	}

	nameRaw, nameSet := body["name_in_zone"]
	if rtype == "" {
		return M{"ok": false, "error": "type is required"}, 400
	}
	if zoneID == "" {
		return M{"ok": false, "error": "zone_id is required"}, 400
	}
	if !nameSet || nameRaw == nil || strings.TrimSpace(pyStr(nameRaw)) == "" {
		return M{"ok": false, "error": `name_in_zone is required (use "@" for the zone apex)`}, 400
	}
	if value == "" {
		return M{"ok": false, "error": fmt.Sprintf("value is required for %s records", rtype)}, 400
	}

	nameInZone := strings.TrimSpace(pyStr(nameRaw))
	if nameInZone == "@" {
		nameInZone = ""
	}

	rdata, err := Rdata(rtype, value)
	if err != nil {
		return M{"ok": false, "error": err.Error()}, 400
	}

	recordBody := M{"name_in_zone": nameInZone, "zone": zoneID, "type": rtype, "rdata": rdata}
	if has(body, "ttl") {
		ttl, ok := intCoerce(body["ttl"])
		if !ok {
			return M{"ok": false, "error": "ttl must be an integer"}, 400
		}
		recordBody["ttl"] = ttl
	}
	if !isFalsy(body["comment"]) {
		recordBody["comment"] = pyStr(body["comment"])
	}

	if dry {
		return M{"ok": true, "dry_run": true, "record": recordBody}, 200
	}

	resp, status, _ := c.Rest.Write("POST", "/api/ddi/v1/dns/record", recordBody, nil)
	if writeUnreadable(resp, status) {
		// The record is LIVE in the customer's DNS. Reporting the old ok:false
		// here told the operator their record did not exist while it answered
		// queries, and wrote no audit row to find it by.
		return createdUnreadable("DNS record", status, ""), status
	}
	if status != 200 && status != 201 {
		return M{"ok": false, "error": fmt.Sprintf("create failed (%s)", statusPhrase(status)), "detail": resp}, statusOr(status, 502)
	}
	return M{"ok": true, "record": resultOrSelf(resp)}, status
}

// --- _dns_record_update (server.py:516) --------------------------------------

func (c *Client) DNSRecordUpdate(body M) (M, int) {
	recordID := strOr(body, "id")
	if recordID == "" {
		return M{"ok": false, "error": "id is required"}, 400
	}
	// Same gate as DNSRecordCreate, and placed before ObjectPath/GetEx so an
	// ambiguous flag costs the tenant nothing — not even the pre-update read.
	dry, dryOK := dryMustBeExplicitBool(body)
	if !dryOK {
		return M{"ok": false, "error": errDryNotBool}, 400
	}

	objPath, err := ObjectPath("dns/record", recordID)
	if err != nil {
		return M{"ok": false, "error": "invalid object id"}, 400
	}

	current, curStatus, getErr := c.Rest.GetEx(objPath, nil)
	curMap := asMap(current)
	if curStatus != 200 || curMap == nil {
		// A non-JSON (or otherwise undecodable) 200 body means the record
		// almost certainly exists — GetEx just couldn't parse the response —
		// so "record not found" would be a lie. Surface the real reason
		// instead of discarding it.
		if getErr != nil {
			return M{"ok": false, "error": fmt.Sprintf("could not read current record before update: %v", getErr)}, statusOr(curStatus, 502)
		}
		// No statusPhrase here on purpose: curStatus cannot be 0 on this line.
		// GetEx only reports 0 together with a non-nil error (rest.go:184/190),
		// which the getErr branch above already returned on. Wrapping it would
		// add a "record not found (could not reach the tenant)" message that
		// contradicts itself and can never fire.
		return M{"ok": false, "error": fmt.Sprintf("record not found (status %d)", curStatus)}, statusOr(curStatus, 502)
	}
	curRecord := asMap(curMap["result"])
	if curRecord == nil {
		curRecord = curMap
	}
	curType := strings.ToUpper(pyStr(curRecord["type"]))

	// Optimistic-concurrency check: if the caller's preview (`expected`) is
	// stale relative to what's on the server right now, refuse the write
	// instead of silently clobbering someone else's edit. This only narrows
	// the read-compare-write race window — it is NOT atomic; another writer
	// can still land between this check and the PATCH below. Runs on the dry
	// path too, since a preview that hides a conflict just moves the surprise
	// to the real write. `expected` is read-only here and must never be
	// copied into updateBody.
	if expected := asMap(body["expected"]); expected != nil {
		if has(expected, "value") {
			wantVal := strings.TrimSpace(pyStr(expected["value"]))
			gotVal := strings.TrimSpace(pyStr(curRecord["dns_rdata"]))
			if wantVal != gotVal {
				return conflictResponse(curRecord), 409
			}
		}
		if has(expected, "ttl") {
			wantTTL, wantOK := intCoerce(expected["ttl"])
			gotTTL, gotOK := intCoerce(curRecord["ttl"])
			if !wantOK || !gotOK || wantTTL != gotTTL {
				return conflictResponse(curRecord), 409
			}
		}
		if has(expected, "comment") {
			wantComment := strings.TrimSpace(pyStr(expected["comment"]))
			gotComment := strings.TrimSpace(pyStr(curRecord["comment"]))
			if wantComment != gotComment {
				return conflictResponse(curRecord), 409
			}
		}
	}

	updateBody := M{}
	if has(body, "value") {
		rdata, err := Rdata(curType, pyStr(body["value"]))
		if err != nil {
			return M{"ok": false, "error": err.Error()}, 400
		}
		updateBody["rdata"] = rdata
	}
	if has(body, "ttl") {
		ttl, ok := intCoerce(body["ttl"])
		if !ok {
			return M{"ok": false, "error": "ttl must be an integer"}, 400
		}
		updateBody["ttl"] = ttl
	}
	if has(body, "comment") {
		updateBody["comment"] = pyStr(body["comment"])
	}
	if has(body, "disabled") {
		updateBody["disabled"] = boolPy(body["disabled"])
	}
	if len(updateBody) == 0 {
		return M{"ok": false, "error": "no fields to update (value/ttl/comment/disabled)"}, 400
	}

	if dry {
		return M{"ok": true, "dry_run": true, "id": recordID, "would_update": updateBody}, 200
	}

	resp, status, method := c.patchThenPut(objPath, updateBody)
	if updateFailed(status) {
		return M{"ok": false, "error": fmt.Sprintf("update failed (%s)", statusPhrase(status)), "detail": resp, "method": method}, statusOr(status, 502)
	}
	if updateUnreadable(resp, status) {
		// The record is LIVE with its new values in the customer's DNS. The old
		// arm called this "update failed (status 200)" and wrote no audit row.
		return updatedUnreadable("DNS record", recordID, method, status), bodyStatus(status)
	}
	return M{"ok": true, "method": method, "record": resultOrSelf(resp)}, 200
}

// conflictResponse builds the 409 body returned when DNSRecordUpdate's
// optimistic-concurrency check finds the caller's `expected` snapshot stale.
func conflictResponse(curRecord M) M {
	return M{
		"ok":    false,
		"error": "record changed since it was read — re-fetch and retry",
		"current": M{
			"value":   curRecord["dns_rdata"],
			"ttl":     curRecord["ttl"],
			"comment": curRecord["comment"],
		},
	}
}

// patchThenPut is the shared PATCH->PUT-on-405 fallback used by every update
// builder (server.py's `if status == 405: retry with PUT`). Returns the final
// (resp, status, method_used).
func (c *Client) patchThenPut(path string, body M) (any, int, string) {
	resp, status, _ := c.Rest.Write("PATCH", path, body, nil)
	method := "PATCH"
	if status == 405 {
		resp, status, _ = c.Rest.Write("PUT", path, body, nil)
		method = "PUT"
	}
	return resp, status, method
}

// --- _selfservice_allocate (server.py:584) -----------------------------------

func (c *Client) SelfserviceAllocate(body M) (M, int) {
	subnetID := strOr(body, "subnet_id")
	tagKey := strOr(body, "tag_key")
	tagValue := strOr(body, "tag_value")
	count := 1
	if n, ok := intCoerce(body["count"]); ok {
		count = n
	}
	name := strOr(body, "name")
	dry := truthyDry(body["dry"])
	dns := asMap(body["dns"])

	if subnetID == "" {
		if tagKey == "" || tagValue == "" {
			return M{"ok": false, "error": "subnet_id or tag_key/tag_value required"}, 400
		}
		field, err := rest.CSPQField(tagKey)
		if err != nil {
			return M{"ok": false, "error": err.Error()}, 400
		}
		esc, err := rest.CSPQ(tagValue)
		if err != nil {
			return M{"ok": false, "error": err.Error()}, 400
		}
		tagFilter := fmt.Sprintf(`%s=="%s"`, field, esc)
		// GetStrict so a failed read 502s instead of masquerading as "no
		// subnet carries this tag" (a false 404 the caller could act on).
		subnets, err := c.Rest.GetStrict("/api/ddi/v1/ipam/subnet", map[string]string{"_tfilter": tagFilter})
		if err != nil {
			ue, _ := err.(*rest.UpstreamError)
			msg := "lookup failed"
			if ue != nil {
				msg = ue.Public()
			}
			return M{"ok": false, "error": fmt.Sprintf("subnet lookup failed: %s", msg)}, 502
		}
		if len(subnets) == 0 {
			return M{"ok": false, "error": fmt.Sprintf("No subnet found with tag %s==%s", tagKey, tagValue)}, 404
		}
		subnetID = pyStr(asMap(subnets[0])["id"])
	}

	// The reservation path used to be built by pasting subnetID behind a
	// hardcoded "ipam/subnet/" prefix. Both of the ways subnetID can arrive give
	// a FULL-FORM CSP id ("ipam/subnet/<uuid>"): the UI's Subnet select posts
	// e.id straight from GET /api/ipam/subnets (a pick() passthrough of CSP's own
	// id), and the tag lookup above reads it off a CSP list endpoint. So the
	// prefix was being added to an id that already carried it, and the request
	// went to /api/ddi/v1/ipam/subnet/ipam/subnet/<uuid>/nextavailableip — the
	// doubled path ObjectPath's doc records CSP answering 501. No live
	// allocation could succeed. It is the same defect already fixed one arm
	// below, in this builder's own compensating release.
	//
	// ObjectPath also stops the id escaping the path it was meant to name: it
	// rejects "..", encoded and literal slashes, control characters and any id
	// whose kind is not ipam/subnet. Nothing is guessed or repaired — an id that
	// does not name a subnet is refused.
	//
	// Placed BEFORE the dry branch, matching every other builder in this package
	// that validates an id (DNSRecordUpdate, ZoneUpdate, SubnetUpdate,
	// RangeUpdate, HostUpdate all ObjectPath-then-400 ahead of their preview).
	// A preview that reports "would allocate" for a request the live path will
	// refuse is the preview/live divergence this package keeps closing.
	objPath, err := ObjectPath("ipam/subnet", subnetID)
	if err != nil {
		return M{"ok": false, "error": "invalid subnet id"}, 400
	}

	if dry {
		result := M{"ok": true, "dry_run": true, "subnet_id": subnetID, "would_allocate": count, "addresses": []any{}}
		if name != "" {
			result["name"] = name
		}
		if dns != nil {
			rec := M{"dry_run": true}
			for k, v := range dns {
				rec[k] = v
			}
			result["record"] = rec
		}
		return result, 200
	}

	// Validate the DNS payload up front so a malformed type/value fails 400
	// BEFORE any IP is reserved (else the reservation is orphaned).
	if dns != nil {
		rtype := strings.ToUpper(pyStrOr(dns, "type", "A"))
		rval := strings.TrimSpace(pyStr(dns["value"]))
		if rval != "" || (rtype != "A" && rtype != "AAAA") {
			if _, err := Rdata(rtype, rval); err != nil {
				return M{"ok": false, "error": fmt.Sprintf("invalid dns payload: %s", err.Error())}, 400
			}
		}
	}

	var bodyExtra any
	if name != "" {
		bodyExtra = M{"name": name}
	}
	resp, status, _ := c.Rest.Write("POST", objPath+"/nextavailableip",
		bodyExtra, map[string]string{"count": strconv.Itoa(count)})
	if (status != 200 && status != 201) || resp == nil {
		return M{"ok": false, "error": fmt.Sprintf("allocation failed (%s)", statusPhrase(status)), "detail": resp}, statusOr(status, 502)
	}

	addresses := respAddresses(resp)
	out := M{"ok": true, "addresses": addressSummaries(addresses)}

	if dns != nil && len(addresses) > 0 {
		zoneID := pyStr(dns["zone_id"])
		rname := pyStr(dns["name"])
		rtype := strings.ToUpper(pyStrOr(dns, "type", "A"))
		rvalue := pyStr(dns["value"])
		if rvalue == "" {
			rvalue = pyStr(asMap(addresses[0])["address"])
		}
		var rresp any
		var rstatus int
		if rdata, err := Rdata(rtype, rvalue); err != nil {
			rresp, rstatus = M{"error": err.Error()}, 400
		} else {
			recordBody := M{"name_in_zone": rname, "zone": zoneID, "type": rtype, "rdata": rdata}
			rresp, rstatus, _ = c.Rest.Write("POST", "/api/ddi/v1/dns/record", recordBody, nil)
		}

		if (rstatus == 200 || rstatus == 201) && asMap(rresp) != nil {
			rm := asMap(rresp)
			rec := asMap(rm["result"])
			if rec == nil {
				if results, ok := rm["results"].([]any); ok && len(results) > 0 {
					rec = asMap(results[0])
				}
			}
			var recID any
			if rec != nil {
				recID = rec["id"]
			}
			out["record"] = M{"ok": true, "id": recID, "status": rstatus}
		} else if writeUnreadable(rresp, rstatus) {
			// Upstream ACCEPTED the record write and we cannot read back what it
			// made. The compensating release below MUST NOT run here: releasing
			// the addresses would strip them out from under a record that exists
			// and answers queries — the reservation is the only thing still
			// holding those addresses for it. So the reservation stays, and the
			// result says so instead of claiming either outcome.
			//
			// "ok" is DELETED rather than set: this is neither the clean
			// allocation ok:true promises nor the rolled-back failure ok:false
			// promises. The addresses stay in the result because they are known
			// and correct; the record carries no id because there is none.
			rec := createdUnreadable("DNS record", rstatus,
				"The address(es) reserved for it are deliberately still reserved — releasing them "+
					"would strip a live record of its addresses")
			delete(out, "ok")
			out[CreatedUnreadableKey] = true
			out["record"] = rec
			out["error"] = rec["error"]
			return out, statusOr(rstatus, 502)
		} else {
			// Compensating release (plan 016): the DNS step failed, so roll back
			// the reservation(s) we just made — otherwise they exhaust the subnet.
			released := []any{}
			orphaned := []any{}
			for _, a := range addresses {
				aid := asMap(a)["id"]
				if isFalsy(aid) {
					continue
				}
				// Build the release path the same way every other delete in this
				// repo does (see internal/server/edit.go's ipamAddressDelete).
				// This used to be raw concatenation, "/api/ddi/v1/ipam/address/"
				// + id. CSP ids are full-form ("ipam/address/<uuid>"), so that
				// produced /api/ddi/v1/ipam/address/ipam/address/<uuid> — the
				// doubled prefix CSP answers 501 (see ObjectPath's doc). Every
				// rollback therefore failed against a real tenant: the addresses
				// landed in `orphaned` and stayed reserved until the subnet was
				// exhausted, which is exactly what this release exists to prevent.
				// ObjectPath accepts both id shapes, so bare ids still work.
				objPath, perr := ObjectPath("ipam/address", pyStr(aid))
				if perr != nil {
					// No path can be built for this id, so no DELETE is sent —
					// the address is still reserved upstream and must be reported
					// as orphaned, never as released.
					orphaned = append(orphaned, aid)
					continue
				}
				_, dstatus, _ := c.Rest.Write("DELETE", objPath, nil, nil)
				if dstatus == 200 || dstatus == 204 || dstatus == 404 {
					released = append(released, aid)
				} else {
					orphaned = append(orphaned, aid)
				}
			}
			out["ok"] = false
			out["record"] = M{"ok": false, "status": rstatus, "detail": rresp}
			out["released"] = released
			if len(orphaned) > 0 {
				out["orphaned"] = orphaned
			}
			out["error"] = "dns record creation failed; reserved address(es) released"
			return out, 502
		}
	}

	return out, 200
}

// pyStrOr is Python `str(d.get(k) or default)`.
func pyStrOr(d M, k, def string) string {
	if isFalsy(d[k]) {
		return def
	}
	return pyStr(d[k])
}

// respAddresses mirrors the allocate result extraction: prefer "results", else
// wrap a single "result", else empty.
func respAddresses(resp any) []any {
	m := asMap(resp)
	if m == nil {
		return nil
	}
	if r, ok := m["results"].([]any); ok && len(r) > 0 {
		return r
	}
	if !isFalsy(m["result"]) {
		return []any{m["result"]}
	}
	return nil
}

func addressSummaries(addresses []any) []any {
	out := make([]any, 0, len(addresses))
	for _, a := range addresses {
		am := asMap(a)
		out = append(out, M{"id": am["id"], "address": am["address"]})
	}
	return out
}
