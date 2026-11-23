package dashboard

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/rest"
)

// A refused audit read says so; any other failure does not, and the fields the
// page already reads stay exactly as they were.
func TestCSPAuditMarksOnlyARefusal(t *testing.T) {
	for code, denied := range map[int]bool{401: true, 403: true, 404: false} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(code)
		}))
		out := (&Service{Rest: rest.New(srv.URL, rest.NewAuth("k", nil))}).CSPAudit("", "", "", "")
		srv.Close()
		if out["status"] != "error" || out["count"] != 0 || out["truncated"] != false {
			t.Fatalf("%d: existing fields changed: %v", code, out)
		}
		if rows, ok := out["rows"].([]any); !ok || len(rows) != 0 {
			t.Fatalf("%d: rows changed: %v", code, out["rows"])
		}
		got, present := out["permission_denied"]
		if denied && got != true {
			t.Fatalf("%d: want permission_denied true, got %v", code, out)
		}
		if !denied && present {
			t.Fatalf("%d: must not claim a refusal: %v", code, out)
		}
	}
}
