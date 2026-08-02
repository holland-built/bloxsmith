package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// --- the stream-aborted entry, read back off disk ----------------------------
//
// recoverStream tells the operator "the run stopped unexpectedly and did NOT
// finish — check the audit log for what was already applied". For the
// provisioning and teardown streams that was a promise the system could not
// keep: the panic unwinds past every auditAppend in the handler, so the audit log
// held nothing at all about the run and the operator was sent to an empty page
// mid-incident. A message that overstates a control is worse than no message.
//
// The panic text is deliberately NOT in the entry, for the reason recoverStream
// already withholds it from the operator; the cause lives in the server log. What
// the row has to carry is that a run aborted, on which route, and by whom.

// abortedStreamDeps is a Deps whose provisioning engine is nil — what
// SiteTemplateRelPaths dereferences, the same real panic stream_panic_test.go
// drives. It keeps the real audit.Log so the entry can be read back off disk.
func abortedStreamDeps(t *testing.T) (*Deps, string) {
	t.Helper()
	d, logPath := newResidualDeps(t, allFailedUpstream)
	d.Provision = nil // the panic under test
	return d, logPath
}

func TestTeardownStreamPanic_WritesAbortedAuditEntry(t *testing.T) {
	d, logPath := abortedStreamDeps(t)

	r := httptest.NewRequest("GET", "/api/teardown/seed-demo/stream?confirm=DELETE&dry=0", nil)
	r.RemoteAddr = "127.0.0.1:12345" // loopback -> SameOrigin -> admin role
	rr := httptest.NewRecorder()
	d.teardownSeedDemoStream(rr, r)

	// The frame that makes the promise. If the run did not actually abort, the
	// audit assertion below would be proving nothing.
	if body := rr.Body.String(); !strings.Contains(body, "did NOT finish") {
		t.Fatalf("the stream did not abort, so this test is not exercising recoverStream; body=%q", body)
	}

	entries := auditEntries(t, logPath, "stream-aborted")
	if len(entries) != 1 {
		t.Fatalf("stream-aborted entries on disk = %d, want 1 — the panic unwinds past every "+
			"auditAppend in the handler, so without this row the operator is told to check an audit "+
			"log that says nothing about the run", len(entries))
	}
	if entries[0]["actor"] != "loopback" {
		t.Fatalf("audit actor = %v, want \"loopback\" — recoverStream has the request, so there is "+
			"no excuse for an anonymous row", entries[0]["actor"])
	}
	detail := residualAuditDetail(t, entries[0])
	if detail["route"] != "/api/teardown/seed-demo/stream" {
		t.Fatalf("audit route = %v, want the aborted teardown route — a row that cannot say WHICH "+
			"run died is not a lead", detail["route"])
	}
	// The panic text stays out on purpose: it can carry internal detail, and the
	// server log (logExc) is where the cause belongs.
	for k, v := range detail {
		if s, ok := v.(string); ok && strings.Contains(s, "invalid memory address") {
			t.Fatalf("audit detail %q leaked the panic text: %v", k, s)
		}
	}
}

// The counterpart: a stream that runs to completion did not abort, so it must
// write no stream-aborted row. recoverStream is deferred on every stream, so
// without this half an unconditional append would file every healthy run as a
// crash and make the event meaningless.
func TestStreamCompletesNormally_WritesNoAbortedAuditEntry(t *testing.T) {
	d, logPath := newResidualDeps(t, allFailedUpstream)

	r := httptest.NewRequest("GET", "/api/teardown/seed-demo/stream?regions=amer&dry=1", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	d.teardownSeedDemoStream(rr, r)

	if body := rr.Body.String(); !strings.Contains(body, `"done":true`) {
		t.Fatalf("the stream did not finish, so this is not the completed-run case; body=%q", body)
	}
	if got := auditEntries(t, logPath, "stream-aborted"); len(got) != 0 {
		t.Fatalf("stream-aborted entries = %d, want 0 — this run reached its terminal frame; "+
			"entries=%v", len(got), got)
	}
}
