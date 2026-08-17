package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bloxsmith/internal/config"
	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/mcp"
)

// --- what POST /api/actions/{id}/status writes down --------------------------
//
// Three audit rows, and the whole point of this file is that they stay three:
//
//	iq-action-resolve          upstream answered {"success":true,...}
//	iq-action-resolve-failed   nothing was ever sent
//	iq-action-resolve-unknown  it was sent and nobody knows what happened
//
// The third used to be spelled like the second. An operator asking the log "was
// action X resolved?" was told a definite NO for a request that may be applied
// on the customer's tenant right now, with nothing on the row to tell the two
// apart — only prose inside detail.error.
//
// Every assertion here reads audit_log.jsonl FROM DISK. The HTTP status cannot
// catch this: the two failure shapes both answer 502, and they did before this
// change too, so a status-code test is green straight through the bug.

// asoUpstream is the fake MCP endpoint. update decides what
// iq-actions_update_action does; returning true means it has written the whole
// reply itself, which is how a test makes the tool RUN and only then break the
// response — a call timeout or a gateway 5xx arriving after the write landed.
type asoUpstream struct {
	update  func(w http.ResponseWriter) bool
	applied bool
}

func asoDeps(t *testing.T, up *asoUpstream) (*Deps, string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		defer r.Body.Close()
		var req struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.Unmarshal(raw, &req)
		w.Header().Set("Mcp-Session-Id", "test-session")
		switch req.Method {
		case "initialize":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
			return
		case "tools/call":
		default:
			w.WriteHeader(200)
			return
		}
		if req.Params.Name == "iq-actions_update_action" {
			up.applied = true
			if up.update != nil && up.update(w) {
				return
			}
		}
		text := `{"action":{"status":"active"}}`
		if req.Params.Name == "iq-actions_update_action" {
			text = `{"success":true,"new_status":"resolved"}`
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{"content": []map[string]any{{"type": "text", "text": text}}},
		})
	}))
	t.Cleanup(srv.Close)

	lg, logPath := uaAuditLog(t)
	return &Deps{
		Cfg:       &config.Config{Port: "8080"},
		Guard:     &httpx.Guard{Port: "8080"},
		Dashboard: &dashboard.Service{Mcp: mcp.New(srv.URL, func() string { return "Bearer test" })},
		Audit:     lg,
	}, logPath
}

// asoPost drives the real handler. Loopback -> SameOrigin -> admin clears the
// operator gate, and SetPathValue stands in for the ServeMux match.
func asoPost(t *testing.T, d *Deps, id, status string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", "/api/actions/"+id+"/status", strings.NewReader("{}"))
	r.RemoteAddr = "127.0.0.1:12345"
	r.SetPathValue("id", id)
	rr := httptest.NewRecorder()
	d.actionStatus(rr, r, map[string]any{"status": status})
	return rr
}

// asoBody decodes the JSON the handler answered with.
func asoBody(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &m); err != nil {
		t.Fatalf("response body is not JSON: %v; body=%s", err, rr.Body.String())
	}
	return m
}

// THE CASE THIS CHANGE EXISTS FOR. The stub applies the update and only then
// fails the reply, so the action is resolved on the tenant while this process
// knows nothing. The row must say so.
func TestActionStatus_DispatchedThenUnreachableIsUnknown(t *testing.T) {
	up := &asoUpstream{update: func(w http.ResponseWriter) bool {
		w.WriteHeader(502) // the tool already ran; the gateway ate the reply
		return true
	}}
	d, logPath := asoDeps(t, up)

	rr := asoPost(t, d, "act-1", "resolved")

	if !up.applied {
		t.Fatal("the stub never received the update call, so nothing here is about a dispatched write")
	}
	if rr.Code != 502 {
		t.Fatalf("status = %d, want 502; body=%s", rr.Code, rr.Body.String())
	}
	if got := asoBody(t, rr)["outcome"]; got != dashboard.ActionOutcomeUnknown {
		t.Fatalf("response outcome = %v, want %q", got, dashboard.ActionOutcomeUnknown)
	}
	detail := uaOnly(t, logPath, "iq-action-resolve-unknown",
		"the update reached upstream and the reply did not come back, so the action may be resolved right now")
	if detail["outcome"] != dashboard.ActionOutcomeUnknown {
		t.Fatalf("audit outcome = %v, want %q — the event name alone is not the contract; a row with "+
			"no outcome field cannot be read years later", detail["outcome"], dashboard.ActionOutcomeUnknown)
	}
	if detail["id"] != "act-1" || detail["new_status"] != "resolved" {
		t.Fatalf("audit row does not say what was attempted: %v", detail)
	}
	uaNone(t, logPath, "iq-action-resolve-failed",
		"a definite failure row about a write that may have landed is the exact false claim this removes")
	uaNone(t, logPath, "iq-action-resolve", "upstream never confirmed anything")
}

// The reply that LOOKS like a refusal but proves nothing. mcp.ErrRejected fires
// on any payload SuccessFieldTrue does not recognise, and no {"success":false}
// has ever been observed from this tool — so it lands on unknown too, not on a
// "refused" word invented for the occasion.
func TestActionStatus_UnrecognisedReplyIsUnknown(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"explicit success false", `{"success":false,"message":"action is closed"}`},
		{"error-shaped payload", `{"status_code":500,"message":"upstream refused"}`},
		{"not json at all", `upstream is down`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := tc.body
			up := &asoUpstream{update: func(w http.ResponseWriter) bool {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"jsonrpc": "2.0", "id": 1,
					"result": map[string]any{"content": []map[string]any{{"type": "text", "text": body}}},
				})
				return true
			}}
			d, logPath := asoDeps(t, up)

			rr := asoPost(t, d, "act-2", "resolved")

			if rr.Code != 502 {
				t.Fatalf("status = %d, want 502; body=%s", rr.Code, rr.Body.String())
			}
			detail := uaOnly(t, logPath, "iq-action-resolve-unknown",
				"the request was dispatched and the reply does not prove it missed")
			if detail["outcome"] != dashboard.ActionOutcomeUnknown {
				t.Fatalf("audit outcome = %v, want %q", detail["outcome"], dashboard.ActionOutcomeUnknown)
			}
			uaNone(t, logPath, "iq-action-resolve-failed",
				"this reply does not prove the customer's tenant is unchanged")
		})
	}
}

// The one case entitled to say "failed". UpdateAction refuses a status that is
// neither "active" nor "resolved" before CallToolChecked is reached, so nothing
// left this process — TestUpdateActionErrorsOnlyBeforeDispatch (dashboard) is
// what keeps that true.
func TestActionStatus_NeverSentIsFailedNotUnknown(t *testing.T) {
	up := &asoUpstream{}
	d, logPath := asoDeps(t, up)

	rr := asoPost(t, d, "act-3", "bogus")

	if up.applied {
		t.Fatal("the update tool was called for an invalid status — this case is supposed to be pre-dispatch")
	}
	if rr.Code != 400 {
		t.Fatalf("status = %d, want 400; body=%s", rr.Code, rr.Body.String())
	}
	if got := asoBody(t, rr)["outcome"]; got != "not-sent" {
		t.Fatalf("response outcome = %v, want \"not-sent\"", got)
	}
	detail := uaOnly(t, logPath, "iq-action-resolve-failed",
		"nothing reached the tenant, which is the only condition under which a definite failure row is true")
	if detail["outcome"] != "not-sent" {
		t.Fatalf("audit outcome = %v, want \"not-sent\" — without it this row is indistinguishable "+
			"on disk from the unknown one it was split away from", detail["outcome"])
	}
	uaNone(t, logPath, "iq-action-resolve-unknown", "the request was never dispatched, so its fate is known")
	uaNone(t, logPath, "iq-action-resolve", "nothing was resolved")
}

// The confirmed write still records a plain resolve, and now carries the word
// that earned it.
func TestActionStatus_AppliedCarriesOutcome(t *testing.T) {
	d, logPath := asoDeps(t, &asoUpstream{})

	rr := asoPost(t, d, "act-4", "resolved")

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	detail := uaOnly(t, logPath, "iq-action-resolve", "upstream confirmed the write")
	if detail["outcome"] != dashboard.ActionOutcomeApplied {
		t.Fatalf("audit outcome = %v, want %q", detail["outcome"], dashboard.ActionOutcomeApplied)
	}
	uaNone(t, logPath, "iq-action-resolve-unknown", "upstream confirmed it")
	uaNone(t, logPath, "iq-action-resolve-failed", "upstream confirmed it")
}

// actionApplied's default is the safety property, and no end-to-end test can
// reach it: UpdateAction cannot currently produce a missing or unfamiliar
// outcome word. That is exactly why it is pinned here directly. A future
// classification bug must land on the unknown row, never back on the definite
// failure one.
func TestActionAppliedRecognisesOnlyAConfirmedWrite(t *testing.T) {
	for _, tc := range []struct {
		name string
		res  map[string]any
		want bool
	}{
		{"confirmed", map[string]any{"ok": true, "outcome": dashboard.ActionOutcomeApplied}, true},
		{"unknown", map[string]any{"ok": false, "outcome": dashboard.ActionOutcomeUnknown}, false},
		{"outcome word nobody has defined", map[string]any{"ok": true, "outcome": "refused"}, false},
		{"outcome missing entirely", map[string]any{"ok": true}, false},
		{"outcome is not a string", map[string]any{"ok": true, "outcome": 7}, false},
		{"applied but not ok", map[string]any{"ok": false, "outcome": dashboard.ActionOutcomeApplied}, false},
		{"empty result", map[string]any{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := actionApplied(tc.res); got != tc.want {
				t.Fatalf("actionApplied(%v) = %v, want %v — anything this function does not "+
					"affirmatively recognise has to read as ignorance, not as a claim about the tenant",
					tc.res, got, tc.want)
			}
		})
	}
}
