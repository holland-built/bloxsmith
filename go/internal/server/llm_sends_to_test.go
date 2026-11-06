package server

import "testing"

// The AI page names where questions go. A base URL set only in LLM_BASE_URL
// used to read as api.groq.com, because the page looked at the vault alone.
func TestLLMSendsTo(t *testing.T) {
	cases := []struct {
		vault, env, want string
	}{
		{"", "", "api.groq.com"},
		{"", "http://10.0.0.5:11434/v1", "10.0.0.5:11434"},
		{"https://api.openai.com/v1", "http://10.0.0.5:11434/v1", "api.openai.com"},
	}
	for _, c := range cases {
		st := map[string]any{"llm": map[string]any{"base_url": c.vault}}
		if got := llmSendsTo(st, c.env); got != c.want {
			t.Errorf("vault %q env %q: got %q, want %q", c.vault, c.env, got, c.want)
		}
	}
}
