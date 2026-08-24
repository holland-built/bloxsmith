package config

import "testing"

// TestAxurAuth is Codex FINDING 6, kept as a normalization rather than the
// rename it asked for: the field name stays consistent with APIKey, and the
// double-scheme hazard it flagged ("Bearer Bearer x") is closed here instead.
func TestAxurAuth(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"unset", "", ""},
		{"blank", "   ", ""},
		{"bare token gets a scheme", "abc123", "Bearer abc123"},
		{"whole header passes through", "Bearer abc123", "Bearer abc123"},
		{"never doubles the scheme", "Bearer Bearer abc", "Bearer Bearer abc"},
		{"surrounding space trimmed", "  abc123  ", "Bearer abc123"},
		{"a non-Bearer scheme is left alone", "Token abc123", "Token abc123"},
		{"tab counts as a separator", "Bearer\tabc", "Bearer\tabc"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := AxurAuth(tc.in); got != tc.want {
				t.Errorf("AxurAuth(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestAxurBaseURLDefault is FINDING 7: the production gateway is the default,
// and an operator can point elsewhere without a rebuild.
func TestAxurBaseURLDefault(t *testing.T) {
	t.Setenv("AXUR_API_KEY", "abc")
	c := Load(t.TempDir())
	if c.AxurBaseURL != AxurDefaultBaseURL {
		t.Errorf("AxurBaseURL = %q, want %q", c.AxurBaseURL, AxurDefaultBaseURL)
	}
	if c.AxurAPIKey != "Bearer abc" {
		t.Errorf("AxurAPIKey = %q, want the normalized header", c.AxurAPIKey)
	}

	t.Setenv("AXUR_BASE_URL", "http://127.0.0.1:9999/gateway/1.0/api")
	c = Load(t.TempDir())
	if c.AxurBaseURL != "http://127.0.0.1:9999/gateway/1.0/api" {
		t.Errorf("AxurBaseURL override ignored, got %q", c.AxurBaseURL)
	}
}
