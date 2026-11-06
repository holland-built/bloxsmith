package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type effortCreds struct {
	fakeCreds
	effort string
}

func (e effortCreds) LLMEffort() string { return e.effort }

// bodyTransport records each request body and answers with an empty reply.
type bodyTransport struct{ body map[string]any }

func (b *bodyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	b.body = nil
	json.NewDecoder(r.Body).Decode(&b.body)
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"choices":[]}`))}, nil
}

// The effort saved in Settings rides on every AI request; with none saved,
// or creds that cannot say, the field is left out so no provider sees it.
func TestChatSendsTheSavedEffortOnlyWhenOneIsSet(t *testing.T) {
	cases := []struct {
		name  string
		creds Creds
		want  any
	}{
		{"effort set", effortCreds{effort: "medium"}, "medium"},
		{"effort empty", effortCreds{}, nil},
		{"creds without effort", fakeCreds{}, nil},
	}
	for _, c := range cases {
		s := New(c.creds, nil, nil)
		tr := &bodyTransport{}
		s.http = &http.Client{Transport: tr}
		if _, err := s.chat(context.Background(), "k", "https://provider.example", "m", nil, answerTokens); err != nil {
			t.Fatalf("%s: chat: %v", c.name, err)
		}
		got, sent := tr.body["reasoning_effort"]
		if c.want == nil && sent {
			t.Errorf("%s: reasoning_effort sent as %v", c.name, got)
		}
		if c.want != nil && got != c.want {
			t.Errorf("%s: reasoning_effort = %v, want %v", c.name, got, c.want)
		}
	}
}
