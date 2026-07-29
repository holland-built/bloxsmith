package vault

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
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

// --- LLMTest: credential exfiltration + SSRF -------------------------------

func strp(s string) *string { return &s }

// TestLLMTest_EmptyKeyForeignBaseURL_Refused_StoredKeyNotSent is the
// regression test for the actual defect: POST /api/vault/llm-test with an
// empty key falls back to the STORED credential, so a caller-supplied
// base_url pointing anywhere it likes used to exfiltrate that stored key to
// an arbitrary host. An empty key + a foreign base_url must now be refused,
// and — the property that actually matters — the foreign host must never
// receive a request at all (so the stored key is never sent to it).
func TestLLMTest_EmptyKeyForeignBaseURL_Refused_StoredKeyNotSent(t *testing.T) {
	calls := 0
	var gotAuth string
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(200)
		w.Write([]byte(`{"choices":[{}]}`))
	}))
	defer attacker.Close()

	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.groq = "stored-secret-key" // the credential this request must never leak

	res := v.LLMTest("", strp(attacker.URL+"/v1"), nil, "some-model", "")

	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("expected ok:false for an empty key + foreign base_url, got %v", res)
	}
	if calls != 0 {
		t.Fatalf("attacker server received %d request(s), want 0 — the stored key must never be sent to a caller-chosen host (Authorization seen: %q)", calls, gotAuth)
	}
}

// TestLLMTest_AnyKeyLinkLocalMetadataTarget_Refused: the cloud metadata
// endpoint (169.254.169.254) must be refused regardless of which key is
// used — this is a server-side fetch primitive either way, not just a
// credential-exfiltration vector.
func TestLLMTest_AnyKeyLinkLocalMetadataTarget_Refused(t *testing.T) {
	cases := []struct {
		name string
		key  string
	}{
		{"stored key (empty request key)", ""},
		{"explicit request key", "caller-supplied-key"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := New(filepath.Join(t.TempDir(), "vault.json"))
			v.groq = "stored-secret-key"

			res := v.LLMTest(tc.key, strp("http://169.254.169.254/latest/meta-data/"), nil, "some-model", "")

			if ok, _ := res["ok"].(bool); ok {
				t.Fatalf("expected ok:false for a link-local metadata target, got %v", res)
			}
			errMsg, _ := res["error"].(string)
			if errMsg == "" {
				t.Fatalf("expected a non-empty refusal reason, got %v", res)
			}
		})
	}
}

// TestLLMTest_AnyKeyPrivateRFC1918Target_Refused pins the RFC1918 leg of the
// same rule (10.0.0.0/8 here), independent of the link-local case above.
func TestLLMTest_AnyKeyPrivateRFC1918Target_Refused(t *testing.T) {
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.groq = "stored-secret-key"

	res := v.LLMTest("caller-supplied-key", strp("https://10.1.2.3/v1"), nil, "some-model", "")

	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("expected ok:false for an RFC1918 target even with an explicit key, got %v", res)
	}
}

// TestLLMTest_AnyKeyNonHTTPS_Refused: the scheme check is independent of the
// host check and independent of which key is used.
func TestLLMTest_AnyKeyNonHTTPS_Refused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("upstream must not be contacted for a plain-http base_url")
	}))
	defer srv.Close()

	v := New(filepath.Join(t.TempDir(), "vault.json"))
	res := v.LLMTest("caller-supplied-key", strp(srv.URL+"/v1"), nil, "some-model", "")
	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("expected ok:false for a non-https base_url, got %v", res)
	}
}

// TestLLMTest_ExplicitKeyForeignHTTPSBase_NotBlockedByAllowlist: supplying an
// explicit key is the "test my own credential against my own endpoint" case
// — the stored-credential allowlist restriction must NOT apply to it. The
// base_url here (an https, non-internal, but unregistered/unreachable host —
// the ".invalid" TLD is reserved by RFC 2606 to never resolve) is chosen so
// the test is fast and network-independent: the request will fail at the
// transport stage, but it must fail for THAT reason, never the
// allowlist-rejection message, proving it got past both the https/internal
// check and the stored-key allowlist.
func TestLLMTest_ExplicitKeyForeignHTTPSBase_NotBlockedByAllowlist(t *testing.T) {
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.groq = "stored-secret-key" // unrelated to this call; must not matter

	res := v.LLMTest("caller-supplied-key", strp("https://llm-test-fixture.invalid/v1"), nil, "some-model", "")

	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("expected ok:false (the host cannot really be reached), got %v", res)
	}
	errMsg, _ := res["error"].(string)
	if strings.Contains(errMsg, "not allowed with the stored credential") {
		t.Fatalf("an explicit key must never be rejected by the stored-credential allowlist: %v", res)
	}
	if strings.Contains(errMsg, "https") || strings.Contains(errMsg, "local/internal") {
		t.Fatalf("an explicit key + a public https base_url must not be rejected by the scheme/internal-target check either: %v", res)
	}
}

// TestLLMTest_StoredBaseURL_NoBodyOverride_UnaffectedByNewChecks pins
// unchanged behavior: when the request supplies neither a key nor a
// base_url, the vault's own already-persisted llm_base is used exactly as
// before — the new checks only apply to a base_url THIS request supplies,
// not to configuration the operator already set through SetLLM.
func TestLLMTest_StoredBaseURL_NoBodyOverride_UnaffectedByNewChecks(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{}]}`))
	}))
	defer srv.Close()

	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.groq = "stored-secret-key"
	v.llmBase = srv.URL // the operator's own prior configuration (plain http, loopback)

	res := v.LLMTest("", nil, nil, "some-model", "")

	if ok, _ := res["ok"].(bool); !ok {
		t.Fatalf("expected ok:true using the stored base_url with no request override, got %v", res)
	}
	if gotAuth != "Bearer stored-secret-key" {
		t.Fatalf("Authorization = %q, want the stored key", gotAuth)
	}
}
