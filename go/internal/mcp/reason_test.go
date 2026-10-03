package mcp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A refused call is named for what it most likely is: the user is missing the
// ib-mcp-server-user group. The words come from the status code, not from the
// gateway's text, so a reworded body does not lose them.
func TestReasonNamesTheMissingGroupOn403(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"message":"some new wording"}}`))
	}))
	defer srv.Close()
	c := New(srv.URL+"/mcp", func() string { return "Token k" })

	err := c.Initialize(t.Context())
	got := Reason(err)
	if !strings.Contains(got, "ib-mcp-server-user") || !strings.Contains(got, "PTCI-4674") {
		t.Fatalf("want the group and the ticket named, got %q (error: %v)", got, err)
	}

	_, qerr := c.QueryCubeErr(t.Context(), "Assets", []string{"Assets.n"}, map[string]any{})
	if Reason(qerr) != got {
		t.Errorf("QueryCubeErr must carry the same refusal, got %q (error: %v)", Reason(qerr), qerr)
	}
	if rows := c.QueryCube(t.Context(), "Assets", []string{"Assets.n"}, map[string]any{}); rows != nil {
		t.Errorf("QueryCube keeps returning nil on failure, got %v", rows)
	}
	if _, serr := c.SearchErr(t.Context(), "x"); Reason(serr) != got {
		t.Errorf("SearchErr must carry the same refusal, got %v", serr)
	}
}

// The 12 second wording is built from the limit the client enforces, so the
// words cannot drift from the real number.
func TestReasonSaysHowLongTheCallWaited(t *testing.T) {
	old := callTimeout
	callTimeout = time.Second
	defer func() { callTimeout = old }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Read the body first: the server only notices a client that hung up
		// once the request has been read.
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
	}))
	defer srv.Close()
	c := New(srv.URL+"/mcp", func() string { return "Token k" })

	err := c.Initialize(t.Context())
	if got := Reason(err); got != "Infoblox did not answer within 1s." {
		t.Fatalf("got %q (error: %v)", got, err)
	}
}

func TestReasonHasNothingToAddForOtherFailures(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()
	err := New(srv.URL+"/mcp", func() string { return "Token k" }).Initialize(t.Context())
	if err == nil || Reason(err) != "" {
		t.Fatalf("a 502 has no better wording than the caller's own, got %q (error: %v)", Reason(err), err)
	}
}
