package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func switchAnswering(t *testing.T, list, sw int) (int, map[string]any) {
	t.Helper()
	csp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/current_user/accounts":
			if list != 200 {
				w.WriteHeader(list)
				return
			}
			_, _ = w.Write([]byte(`{"results":[{"id":"home","name":"Home","state":"active"},{"id":"other","name":"Other","state":"active"}]}`))
		case "/v2/current_user":
			_, _ = w.Write([]byte(`{"result":{"account_id":"home"}}`))
		case "/v2/session/account_switch":
			w.WriteHeader(sw)
		}
	}))
	t.Cleanup(csp.Close)
	r := httptest.NewRequest("POST", "/api/switch-account", strings.NewReader(`{"id":"other"}`))
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	accountsDeps(t, csp.URL, "KEY").ServeHTTP(rr, r)
	return rr.Code, decodeBody(t, rr)
}

func TestSwitchAccount_SaysWhichAnswerItGot(t *testing.T) {
	code, res := switchAnswering(t, 500, 200)
	if code != 502 || res["outcome"] != "not-sent" || !strings.Contains(fmt.Sprint(res["error"]), "not sent") {
		t.Errorf("list read failed: %d %v", code, res)
	}
	code, res = switchAnswering(t, 200, 404)
	if code != 502 || res["outcome"] != "refused" || !strings.Contains(fmt.Sprint(res["error"]), "HTTP 404") {
		t.Errorf("switch refused: %d %v", code, res)
	}
	code, res = switchAnswering(t, 200, 503)
	if code != 502 || res["outcome"] != nil {
		t.Errorf("no clear answer must carry no marker: %d %v", code, res)
	}
}

func TestOutcomeStatus_NotSentKeeps502(t *testing.T) {
	if got := outcomeStatus(map[string]any{"outcome": "not-sent"}); got != 502 {
		t.Fatalf("status = %d", got)
	}
}

func TestLocalSavesWithNowhereToKeepThemAreNotSent(t *testing.T) {
	d, _ := newListsDeps(t, listsUpstream(200))
	code, res := neverAddPost(t, d, "a.example.com")
	if code != 500 || res["outcome"] != "not-sent" || !strings.Contains(fmt.Sprint(res["error"]), "nothing was changed") {
		t.Errorf("never-add: %d %v", code, res)
	}
	code, res = syncPost(t, d, d.listsWatchSet, "/api/lists/watch", map[string]any{"list_id": 901, "on": false})
	if code != 500 || res["outcome"] != "not-sent" || !strings.Contains(fmt.Sprint(res["error"]), "nothing was changed") {
		t.Errorf("watch: %d %v", code, res)
	}
}
