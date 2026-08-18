package dashboard

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/mcp"
)

// --- UpdateAction's outcome word ---------------------------------------------
//
// The audit row POST /api/actions/{id}/status writes is chosen from this
// function's "outcome" field (server/noc.go actionResolveEvent), so the field is
// a cross-package contract and not an internal detail. What it has to get right
// is the one thing that cannot be recovered afterwards: the difference between
// "the tenant answered" and "we do not know what the tenant did".
//
// The trap these tests exist for is that mcp.ErrRejected READS like a refusal
// and is not one. CallToolChecked returns it for an empty body, an unparseable
// body, and any body SuccessFieldTrue does not affirmatively recognise —
// including a success in a shape nobody has seen. Its own doc comment says so.
// So there is no "refused" outcome to test for here; the second case below is
// the one that would tempt a future author into inventing one.

// aoServer stands up a fake MCP endpoint. updateHandler decides what
// iq-actions_update_action does, so a test can make the tool RUN and only then
// break the reply — the shape a call timeout or a gateway 5xx produces, and the
// only way to exercise "applied upstream, unknown here".
func aoServer(t *testing.T, updateHandler func(w http.ResponseWriter) bool) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		defer r.Body.Close()
		// Answer the question that was actually asked. internal/mcp now rejects a
		// reply carrying a different JSON-RPC id (issue #138), and this fake used
		// to stamp every reply "id":1 — correct for the first call on a client and
		// wrong for every one after it, which is exactly the mis-addressing the
		// client learned to catch.
		w = echoRPCID(w, raw)
		var req struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		_ = json.Unmarshal(raw, &req)
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
		if req.Params.Name == "iq-actions_update_action" && updateHandler != nil {
			if handled := updateHandler(w); handled {
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
	return &Service{Mcp: mcp.New(srv.URL, func() string { return "Bearer test" })}
}

// A confirmed write is the only case entitled to a definite word.
func TestUpdateActionAppliedOutcome(t *testing.T) {
	s := aoServer(t, nil)
	res, err := s.UpdateAction(context.Background(), "act-1", "resolved")
	if err != nil {
		t.Fatalf("UpdateAction returned an error for a confirmed write: %v", err)
	}
	if ok, _ := res["ok"].(bool); !ok {
		t.Fatalf("ok = %v, want true; res=%v", res["ok"], res)
	}
	if res["outcome"] != ActionOutcomeApplied {
		t.Fatalf("outcome = %v, want %q — the audit row's event name is chosen from this field",
			res["outcome"], ActionOutcomeApplied)
	}
}

// The tool RAN and the reply was eaten. This is the case the whole change
// exists for: the action is resolved on the customer's tenant right now, and
// the only honest word is "unknown".
func TestUpdateActionTransportAfterApplyIsUnknown(t *testing.T) {
	applied := false
	s := aoServer(t, func(w http.ResponseWriter) bool {
		applied = true     // the write LANDED upstream
		w.WriteHeader(502) // ...and the gateway ate the reply
		return true
	})

	res, err := s.UpdateAction(context.Background(), "act-1", "resolved")
	if err != nil {
		t.Fatalf("UpdateAction returned an error AFTER dispatch: %v — the error return means "+
			"\"nothing was sent\", and noc.go records it as a definite non-event", err)
	}
	if !applied {
		t.Fatal("the stub never ran the update tool, so this test proves nothing about a dispatched write")
	}
	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("ok = %v, want false — the reply never arrived", res["ok"])
	}
	if res["outcome"] != ActionOutcomeUnknown {
		t.Fatalf("outcome = %v, want %q — the update was applied upstream, so any definite word "+
			"here is a false statement about the customer's tenant", res["outcome"], ActionOutcomeUnknown)
	}
}

// The reply that LOOKS like a refusal. mcp.ErrRejected covers a body the
// predicate does not recognise, which is not the same as upstream saying no —
// and no {"success":false} reply has ever been observed from this tool. It must
// land on the same "unknown" as the transport case, not on a word of its own.
func TestUpdateActionUnrecognisedReplyIsUnknown(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"explicit success false", `{"success":false,"message":"action is closed"}`},
		{"error-shaped payload", `{"status_code":500,"message":"upstream refused"}`},
		{"not json at all", `upstream is down`},
		{"empty object", `{}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := tc.body
			s := aoServer(t, func(w http.ResponseWriter) bool {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"jsonrpc": "2.0", "id": 1,
					"result": map[string]any{"content": []map[string]any{{"type": "text", "text": body}}},
				})
				return true
			})

			res, err := s.UpdateAction(context.Background(), "act-1", "resolved")
			if err != nil {
				t.Fatalf("UpdateAction returned an error AFTER dispatch: %v", err)
			}
			if ok, _ := res["ok"].(bool); ok {
				t.Fatalf("ok = %v, want false for %s", res["ok"], tc.name)
			}
			if res["outcome"] != ActionOutcomeUnknown {
				t.Fatalf("outcome = %v, want %q — this reply does not prove the write missed",
					res["outcome"], ActionOutcomeUnknown)
			}
		})
	}
}

// --- the claim noc.go's "failed" row rests on --------------------------------

// TestUpdateActionErrorsOnlyBeforeDispatch holds the split the audit log
// depends on: server/noc.go records UpdateAction's ERROR return as
// iq-action-resolve-failed, a definite statement that nothing reached the
// customer's tenant. That is only true while every non-nil error is produced
// before CallToolChecked is called.
//
// Checked over the syntax tree rather than by running the function, because the
// failure this guards against is a future edit adding an error return AFTER the
// dispatch — a line no existing test would reach, and one that would silently
// turn the honest "failed" row back into the false one this change removed.
//
// The check is positional: find the CallToolChecked call inside UpdateAction,
// then require every return statement whose last result is not the literal nil
// to sit before it in the file.
func TestUpdateActionErrorsOnlyBeforeDispatch(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "analytics.go", nil, 0)
	if err != nil {
		t.Fatalf("parse analytics.go: %v", err)
	}

	var fn *ast.FuncDecl
	for _, decl := range file.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if ok && fd.Name.Name == "UpdateAction" && fd.Recv != nil {
			fn = fd
			break
		}
	}
	if fn == nil {
		t.Fatal("UpdateAction not found in analytics.go — this guard is now checking nothing")
	}

	dispatch := token.NoPos
	ast.Inspect(fn, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if sel, ok := call.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "CallToolChecked" {
			dispatch = call.Pos()
			return false
		}
		return true
	})
	if dispatch == token.NoPos {
		t.Fatal("no CallToolChecked call in UpdateAction — the dispatch point this guard " +
			"measures against is gone, so it can no longer prove the error return means \"nothing was sent\"")
	}

	found := 0
	ast.Inspect(fn, func(n ast.Node) bool {
		ret, ok := n.(*ast.ReturnStmt)
		if !ok || len(ret.Results) == 0 {
			return true
		}
		last := ret.Results[len(ret.Results)-1]
		if id, ok := last.(*ast.Ident); ok && id.Name == "nil" {
			return true
		}
		found++
		if ret.Pos() > dispatch {
			t.Errorf("UpdateAction returns a non-nil error at %s, AFTER CallToolChecked at %s — "+
				"server/noc.go records that error as iq-action-resolve-failed, which asserts nothing "+
				"reached the customer's tenant. Past the dispatch point that assertion is false: "+
				"report the outcome through the map's %q field instead.",
				fset.Position(ret.Pos()), fset.Position(dispatch), "outcome")
		}
		return true
	})
	if found == 0 {
		t.Fatal("no non-nil error returns found in UpdateAction — either the pre-dispatch " +
			"validation is gone or this guard's return-shape test no longer matches the code")
	}
}
