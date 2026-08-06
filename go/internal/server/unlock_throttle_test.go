package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/config"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/vault"
)

// THE ROUTE SIDE of the unlock throttle. internal/httpx/unlock_throttle_test.go
// proves the mechanism; this file proves the wiring — that the throttle is
// actually in front of POST /api/vault/unlock, that a refusal comes back as a
// 429 carrying a usable Retry-After, and that it discriminates by client rather
// than shutting the route.
//
// These tests are deliberately frugal with unlock attempts. Every failed one
// runs a real scrypt derive at N=2^17, and under -race that is seconds, not
// milliseconds — the same cost that makes this route worth throttling in the
// first place.

const utPass = "correct-horse-battery-staple"

// utServer builds the real routed handler over a real, locked vault.
func utServer(t *testing.T) (http.Handler, *vault.Vault) {
	t.Helper()
	dir := t.TempDir()

	v := vault.New(filepath.Join(dir, "vault.json"))
	if err := v.Init(utPass); err != nil {
		t.Fatalf("vault init: %v", err)
	}
	v.Lock() // Init leaves it open; unlocking a locked vault is the case under test.

	auth := rest.NewAuth("", v.ActiveKey)
	d := &Deps{
		Cfg:      &config.Config{Port: "8080"},
		Vault:    v,
		Auth:     auth,
		Guard:    &httpx.Guard{Port: "8080", MutatingPaths: httpx.DefaultMutatingPaths()},
		Audit:    audit.New(filepath.Join(dir, "audit_log.jsonl"), "app-v-test", "test-instance", audit.Options{TrustDir: t.TempDir()}),
		StateDir: dir,
		Version:  "test",
		Static:   http.NotFoundHandler(),
	}
	return New(d), v
}

// utUnlock POSTs one unlock attempt from a named peer.
//
// Sec-Fetch-Site: none is what a curl or a typed URL sends, and it is what gets
// this past the CSRF gate from a non-loopback address. That is not a test
// convenience — it is exactly the request an attacker on the LAN makes, and the
// reason this route needed a throttle rather than an authentication check it
// cannot have.
func utUnlock(t *testing.T, h http.Handler, remoteAddr, passphrase string) *httptest.ResponseRecorder {
	t.Helper()
	body := `{"passphrase":` + strconv.Quote(passphrase) + `}`
	r := httptest.NewRequest("POST", "/api/vault/unlock", strings.NewReader(body))
	r.RemoteAddr = remoteAddr
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Sec-Fetch-Site", "none")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	return rr
}

func utBody(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &m); err != nil {
		t.Fatalf("response body is not JSON (%q): %v", rr.Body.String(), err)
	}
	return m
}

// The whole defect, end to end: one client guessing at the vault gets exactly
// one derive, then a 429 that tells it when to come back — while the operator
// on a different address is unaffected and unlocks at once.
func TestUnlockRoute_LocksOutOneClientWithoutClosingTheRoute(t *testing.T) {
	h, v := utServer(t)

	const guesser = "198.51.100.23:40001"
	const operator = "192.0.2.55:40002"

	// A wrong passphrase that is not yet locked out behaves exactly as it
	// always did. The throttle adds statuses; it must not change this one.
	rr := utUnlock(t, h, guesser, "not-the-passphrase")
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("first wrong passphrase: status = %d, want 401 — the throttle changed the ordinary "+
			"failure, not just the throttled one", rr.Code)
	}
	if rr.Header().Get("Retry-After") != "" {
		t.Fatalf("a plain 401 carried Retry-After: %q — that header means 'you are throttled' and "+
			"must not appear on an attempt that was actually served", rr.Header().Get("Retry-After"))
	}

	// The next guess from the same peer is refused without a derive. Timed,
	// because "refused" and "refused cheaply" are different claims and only the
	// second one closes the memory hole.
	start := time.Now()
	rr = utUnlock(t, h, guesser, "still-not-the-passphrase")
	elapsed := time.Since(start)

	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("second wrong passphrase: status = %d, want 429", rr.Code)
	}
	ra := rr.Header().Get("Retry-After")
	if ra == "" {
		t.Fatal("429 with no Retry-After — the client is told to back off and not told for how long. " +
			"The usual cause is setting the header AFTER d.json has written the status line")
	}
	secs, err := strconv.Atoi(ra)
	if err != nil || secs < 1 {
		t.Fatalf("Retry-After = %q, want a positive whole number of seconds", ra)
	}
	body := utBody(t, rr)
	if ok, _ := body["ok"].(bool); ok {
		t.Fatalf("throttled response says ok:true — the UI reads {ok,error} and would report success: %v", body)
	}
	errMsg, _ := body["error"].(string)
	if !strings.Contains(errMsg, "too many failed unlock attempts") {
		t.Fatalf("error = %q, want the documented throttle message", errMsg)
	}
	if !strings.Contains(errMsg, strconv.Itoa(secs)+"s") {
		t.Fatalf("error %q does not agree with Retry-After %q — two numbers for the same wait is worse "+
			"than one", errMsg, ra)
	}
	// A derive is ~160ms unthrottled and far more under -race; 50ms is a
	// generous ceiling that still cannot be reached by running scrypt.
	if elapsed > 50*time.Millisecond {
		t.Fatalf("the throttled request took %v — that is long enough to have run a derive, which "+
			"means the refusal happened after the expensive part instead of before it", elapsed)
	}

	// The operator, on a different address, is not caught by any of it.
	rr = utUnlock(t, h, operator, utPass)
	if rr.Code != http.StatusOK {
		t.Fatalf("operator unlock from a different peer: status = %d body = %s, want 200 — one "+
			"attacker must not be able to lock the real user out of their own vault",
			rr.Code, rr.Body.String())
	}
	if !v.IsUnlocked() {
		t.Fatal("the route returned 200 but the vault is still locked")
	}
}

// The two callers that unlock WITHOUT an HTTP request — boot-time AutoUnlock in
// main.go's buildServer, and the `bloxsmith vault-passphrase` CLI in passcli.go
// — go straight to the vault and must never be throttled. A server that had
// been hammered by a guesser would otherwise fail to auto-unlock on its next
// restart, or refuse the operator's own CLI.
//
// Pinned by construction rather than by inspection: the throttle lives in the
// route closure, so a locked-out client and a direct call are the same vault
// and different code paths. If a future change pushed the counter down into
// vault.Unlock, this test is what fails.
func TestUnlockRoute_ThrottleDoesNotReachDirectVaultCallers(t *testing.T) {
	h, v := utServer(t)

	const guesser = "198.51.100.99:40003"
	if rr := utUnlock(t, h, guesser, "wrong"); rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
	if rr := utUnlock(t, h, guesser, "wrong-again"); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 — the client under test is not actually locked out, so the "+
			"rest of this test proves nothing", rr.Code)
	}

	// Same process, same vault, no HTTP: this is what AutoUnlock and the CLI do.
	if _, err := v.AutoUnlock(utPass); err != nil {
		t.Fatalf("AutoUnlock while an HTTP client is locked out: %v — boot-time unlock now depends "+
			"on how much a stranger guessed before the last restart", err)
	}
	if !v.IsUnlocked() {
		t.Fatal("AutoUnlock reported success but the vault is locked")
	}
}
