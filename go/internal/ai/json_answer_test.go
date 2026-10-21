package ai

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// groq400 is the shape of Groq's reply when gpt-oss-120b sends its finished
// answer as a call to a tool named "json" (2026-10-20, "what domains do we
// host"): the answer was right, and the reader got an error instead.
func groq400(name, args string) string {
	gen := `{\"name\": \"` + name + `\", \"arguments\": ` + args + `}`
	return `{"error":{"message":"Tool call validation failed: attempted to call tool '` + name +
		`' which was not in request.tools","type":"invalid_request_error","code":"tool_use_failed",` +
		`"failed_generation":"` + gen + `"}}`
}

func runAgainst400(t *testing.T, body string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	svc := New(fakeCreds{base: srv.URL}, countingTools{calls: map[string]int{}}, newFakeBudget(func() string { return "2026-10-20" }))
	var trace []map[string]any
	return svc.runLoop("what domains do we host", "", &trace)
}

func TestAnswerSentAsAToolCallIsShown(t *testing.T) {
	long := strings.Repeat("• zone.example.\\\\n", 300) // past the 2 KB log cut
	out := runAgainst400(t, groq400("json",
		`{\"answer\":\"We host **1,440** zones.`+long+`\",\"suggestions\":[\"q1\"]}`))
	if !strings.Contains(out, "We host **1,440** zones.") || !strings.Contains(out, `"suggestions":["q1"]`) ||
		strings.Contains(out, "rejected the request") {
		t.Fatalf("want the recovered answer, got %.300s", out)
	}
}

func TestRealBadToolCallIsStillAnError(t *testing.T) {
	// a call to one of our own tools, a call to any other made-up tool, and a
	// "json" call with no answer in it are all genuine failures
	for _, body := range []string{
		groq400("get_dns", `{\"answer\":\"x\"}`),
		groq400("json", `{\"query\":\"zones\"}`),
		groq400("send_email", `{\"answer\":\"Email sent\"}`),
	} {
		if out := runAgainst400(t, body); !strings.Contains(out, "rejected the request") {
			t.Fatalf("want the 400 error, got %.300s", out)
		}
	}
}
