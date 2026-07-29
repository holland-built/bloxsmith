package vault

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// TestTestKeyRejected401 pins the unchanged "CSP actually answered and said no"
// path: a 401 from /v2/current_user must still report the rejected shape.
func TestTestKeyRejected401(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.BaseURL = srv.URL

	res := v.TestKey("Token bad-key")
	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("expected ok:false for a 401, got %v", res)
	}
	if errMsg, _ := res["error"].(string); errMsg != "key rejected by Infoblox CSP" {
		t.Fatalf("expected the unchanged rejected error message, got %v", res)
	}
	if _, present := res["unverified"]; present {
		t.Fatalf("a real 401 rejection must NOT carry unverified: %v", res)
	}
}

// TestTestKeyValid200 pins the unchanged "CSP actually answered and said yes"
// path.
func TestTestKeyValid200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/current_user/accounts":
			w.Write([]byte(`{"results":[{"id":"a1","name":"Acme","state":"active"}]}`))
		case "/v2/current_user":
			w.Write([]byte(`{"result":{"account_id":"a1"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.BaseURL = srv.URL

	res := v.TestKey("Token good-key")
	if ok, _ := res["ok"].(bool); !ok {
		t.Fatalf("expected ok:true for a healthy 200, got %v", res)
	}
	if _, present := res["unverified"]; present {
		t.Fatalf("a verified-good key must NOT carry unverified: %v", res)
	}
}

// TestTestKeyTransportErrorIsNotRejected is the MAJOR regression: when the
// request never reaches CSP (here: the server is closed, so the connection is
// refused), TestKey must report a distinguishable could-not-verify outcome —
// never the same shape as an actual CSP rejection. Conflating the two is
// exactly the bug: a perfectly good key gets discarded because the network
// hiccuped, not because CSP said no.
func TestTestKeyTransportErrorIsNotRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	closedURL := srv.URL
	srv.Close() // close immediately: any request now hits connection-refused

	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.BaseURL = closedURL

	res := v.TestKey("Token maybe-fine")

	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("a transport failure must not report ok:true: %v", res)
	}
	unverified, _ := res["unverified"].(bool)
	if !unverified {
		t.Fatalf("transport error must set unverified:true so the UI can distinguish it, got %v", res)
	}
	if errMsg, _ := res["error"].(string); errMsg == "key rejected by Infoblox CSP" {
		t.Fatalf("transport failure must NOT reuse the rejected-by-CSP message: %v", res)
	}

	// Cross-check against the real-401 shape from TestTestKeyRejected401: the
	// two outcomes must be distinguishable by the caller.
	rejected := map[string]any{"ok": false, "error": "key rejected by Infoblox CSP"}
	if res["error"] == rejected["error"] {
		t.Fatalf("could-not-verify response is not distinguishable from a rejected response: %v", res)
	}
}

// TestConnTestNoActiveConnection pins the pre-existing empty-key guard, which
// is unaffected by the transport-error fix.
func TestConnTestNoActiveConnection(t *testing.T) {
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	res := v.ConnTest("")
	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("expected ok:false with no active connection: %v", res)
	}
	if _, present := res["unverified"]; present {
		t.Fatalf("the no-active-connection guard is a config error, not a network one: %v", res)
	}
}
