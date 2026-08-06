package main

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParsePortFlag(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		want    string
		wantErr bool
	}{
		{"absent", []string{}, "", false},
		{"space form", []string{"--port", "9090"}, "9090", false},
		{"equals form", []string{"--port=9090"}, "9090", false},
		{"short space form", []string{"-p", "9090"}, "9090", false},
		{"short equals form", []string{"-p=9090"}, "9090", false},
		{"invalid non-numeric", []string{"--port", "abc"}, "", true},
		{"invalid zero", []string{"--port", "0"}, "", true},
		{"invalid too large", []string{"--port", "70000"}, "", true},
		{"missing value", []string{"--port"}, "", true},
		{"unrelated args ignored", []string{"--foo", "bar"}, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := parsePortFlag(c.args)
			if c.wantErr != (err != nil) {
				t.Fatalf("parsePortFlag(%v) err = %v, wantErr = %v", c.args, err, c.wantErr)
			}
			if got != c.want {
				t.Fatalf("parsePortFlag(%v) = %q, want %q", c.args, got, c.want)
			}
		})
	}
}

func TestIsAddrInUse(t *testing.T) {
	if isAddrInUse(nil) {
		t.Fatal("nil error should not be addr-in-use")
	}
	if !isAddrInUse(errors.New("listen tcp :8080: bind: address already in use")) {
		t.Fatal("expected unix-style message to match")
	}
	if !isAddrInUse(errors.New("Only one usage of each socket address (protocol/network address/port) is normally permitted.")) {
		t.Fatal("expected windows-style message to match")
	}
	if isAddrInUse(errors.New("some unrelated error")) {
		t.Fatal("unrelated error should not match")
	}
}

// --- bloxsmith healthcheck ---------------------------------------------------
//
// The probe is only worth having if BOTH answers are right, and the one that
// matters is the negative: a healthcheck that cannot fail marks a dead server
// healthy forever, which is strictly worse than having no healthcheck at all —
// the supervisor now believes something. So the down case is asserted against a
// port that was bound and then released, i.e. a real "connection refused", not
// a port guessed to be free.

func TestHealthcheckAt_ExitsZeroAgainstALiveServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Errorf("probe requested %q, want /healthz", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","version":"1.2.3-test"}`))
	}))
	defer srv.Close()

	if got := healthcheckAt(srv.URL + "/healthz"); got != 0 {
		t.Fatalf("healthcheckAt(live 200) = %d, want 0", got)
	}
}

// A server that is up but not ready — the 503 /healthz returns when the state
// directory has gone — must fail the probe. Reachability is not health.
func TestHealthcheckAt_ExitsNonZeroOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"status":"unavailable"}`))
	}))
	defer srv.Close()

	if got := healthcheckAt(srv.URL + "/healthz"); got == 0 {
		t.Fatal("healthcheckAt(503) = 0 — a not-ready server would be reported healthy")
	}
}

func TestHealthcheckAt_ExitsNonZeroWhenNothingIsListening(t *testing.T) {
	// Bind, read the port, release it: the port is then known to be free, so
	// the connect below fails for the reason under test rather than by luck.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	url := "http://" + ln.Addr().String() + "/healthz"
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}

	if got := healthcheckAt(url); got == 0 {
		t.Fatalf("healthcheckAt(%s) = 0 with nothing listening, want non-zero", url)
	}
}
