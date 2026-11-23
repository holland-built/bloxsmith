package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
	"bloxsmith/internal/rest"
)

func removeRuleAnswering(t *testing.T, put int) (map[string]any, int) {
	t.Helper()
	rules := []any{map[string]any{"type": "custom_list", "data": "vip", "action": "action_allow"}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" {
			w.WriteHeader(put)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		_ = json.NewEncoder(w).Encode(map[string]any{"results": map[string]any{"id": 7, "rules": rules}})
	}))
	t.Cleanup(srv.Close)
	s := &Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil)), Cache: cache.New()}
	return s.RemoveRule(7, "vip", "action_allow", rulesFingerprint(rules))
}

func TestRemoveRule_ARefusalIsMarkedAndNoAnswerIsNot(t *testing.T) {
	res, status := removeRuleAnswering(t, 403)
	if status != 502 || res["outcome"] != "refused" || !strings.Contains(fmt.Sprint(res["error"]), "HTTP 403") {
		t.Fatalf("403: %d %v", status, res)
	}
	res, _ = removeRuleAnswering(t, 503)
	if res["outcome"] == "refused" || res["error"] != rest.OutcomeUnknown {
		t.Fatalf("503 must stay unknown: %v", res)
	}
}

func TestApplyList_ARefusedChunkIsMarkedAndNoAnswerIsNot(t *testing.T) {
	domains := make([]any, listChunk+1)
	for i := range domains {
		domains[i] = fmt.Sprintf("site%d.example.com", i)
	}
	for code, want := range map[int]any{403: "refused", 503: "partial"} {
		f := newFakeTenant()
		f.patchCode = code
		b := newListBody(false)
		b["domains"] = domains
		res, status := applyAfterPreview(t, f.serve(t), b)
		if status != 502 || res["outcome"] != want {
			t.Errorf("%d: want %v, got %d %v", code, want, status, res["outcome"])
		}
	}
}

func TestBlockDomain_ASessionThatNeverOpenedIsNotSent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	t.Cleanup(srv.Close)
	s := &Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil)), Mcp: mcp.New(srv.URL, func() string { return "Bearer t" })}
	got := s.BlockDomain(context.Background(), "evil.example.com", testBlockListID)
	if got["outcome"] != "not-sent" || !strings.Contains(fmt.Sprint(got["error"]), "Nothing was sent") {
		t.Fatalf("%v", got)
	}
}
