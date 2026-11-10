package dashboard

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

const threatRows = `{"result":{"data":[{"PortunusAggThreat_ch.action":"Block","PortunusAggThreat_ch.requests":"74960","PortunusAggThreat_ch.timestamp.day":"2026-11-01T00:00:00.000"}]}}`

// cubeServers answers the security and main Cube.js endpoints with the given
// statuses and counts how often each was asked.
func cubeServers(t *testing.T, secStatus, mainStatus int) (*Service, *int32, *int32) {
	t.Helper()
	var sec, main int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		st := http.StatusNotFound
		switch r.URL.Path {
		case cubeSecurityEndpoint:
			atomic.AddInt32(&sec, 1)
			st = secStatus
		case cubeEndpoint:
			atomic.AddInt32(&main, 1)
			st = mainStatus
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(st)
		if st == http.StatusOK {
			_, _ = w.Write([]byte(threatRows))
		} else {
			_, _ = w.Write([]byte(`{"error":[{"message":"unable to process query (bad request)"}]}`))
		}
	}))
	t.Cleanup(srv.Close)
	return &Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil)), Cache: cache.New()}, &sec, &main
}

func TestCSPThreats_SecurityServiceRefuses_MainServiceAnswers(t *testing.T) {
	s, sec, main := cubeServers(t, http.StatusBadRequest, http.StatusOK)
	got := s.CSPThreats()
	if got["status"] == "error" {
		t.Fatalf("the main service answered, but threats report an error: %v", got)
	}
	if *sec != 1 || *main != 1 {
		t.Errorf("want one ask of each service, got security=%d main=%d", *sec, *main)
	}
}

func TestCSPThreats_BothServicesFail_StillAnError(t *testing.T) {
	s, _, _ := cubeServers(t, http.StatusBadRequest, http.StatusInternalServerError)
	if got := s.CSPThreats(); got["status"] != "error" {
		t.Errorf("both services failed, but threats say %v", got["status"])
	}
}

func TestCubeGet_SecurityServiceAnswers_MainNotAsked(t *testing.T) {
	s, sec, main := cubeServers(t, http.StatusOK, http.StatusOK)
	if _, st, err := s.cubeGet(cubeSecurityEndpoint, []byte(`{}`)); errored(st, err) {
		t.Fatalf("security service answered 200, got %d %v", st, err)
	}
	if *sec != 1 || *main != 0 {
		t.Errorf("want security=1 main=0, got security=%d main=%d", *sec, *main)
	}
}

func TestCubeGet_MainServiceFailure_IsNotRetried(t *testing.T) {
	s, sec, main := cubeServers(t, http.StatusOK, http.StatusBadRequest)
	if _, st, err := s.cubeGet(cubeEndpoint, []byte(`{}`)); !errored(st, err) {
		t.Fatalf("main service answered 400, want an error, got %d", st)
	}
	if *sec != 0 || *main != 1 {
		t.Errorf("want security=0 main=1, got security=%d main=%d", *sec, *main)
	}
}
