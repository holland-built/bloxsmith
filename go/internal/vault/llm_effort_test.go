package vault

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"testing"
)

// The effort chosen in Settings is saved with the key, address and model, and
// survives the vault being closed and opened again.
func TestSetLLMEffortIsSavedAndReopened(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	v := New(path)
	if err := v.Init("effort-test-pass"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if res := v.SetLLMEffort("k", strp("https://llm.example/v1"), strp("m"), strp("high")); res["ok"] != true {
		t.Fatalf("SetLLMEffort: %v", res)
	}
	reopened := New(path)
	if err := reopened.Unlock("effort-test-pass"); err != nil {
		t.Fatalf("Unlock: %v", err)
	}
	if got := reopened.LLMEffort(); got != "high" {
		t.Fatalf("effort after reopen = %q, want high", got)
	}
	// A save without an effort (the old route shape) keeps the stored one.
	reopened.SetLLM("k2", nil, nil)
	if got := reopened.LLMEffort(); got != "high" {
		t.Fatalf("SetLLM without effort changed it to %q", got)
	}
}

func TestSetLLMEffortRefusesAnUnknownValue(t *testing.T) {
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	if err := v.Init("effort-test-pass"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if res := v.SetLLMEffort("k", nil, nil, strp("turbo")); res["ok"] == true {
		t.Fatalf("an unknown effort was saved: %v", res)
	}
	if v.LLMEffort() != "" || v.groq != "" {
		t.Fatalf("a refused save changed state: effort=%q key=%q", v.LLMEffort(), v.groq)
	}
}

// Test sends the chosen effort, so a provider that refuses it fails Test
// instead of failing the first real question. No effort, no field.
func TestLLMTestEffortSendsReasoningEffortOnlyWhenChosen(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = nil
		json.NewDecoder(r.Body).Decode(&got)
		w.Write([]byte(`{"choices":[{}]}`))
	}))
	defer srv.Close()
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.groq, v.llmBase = "stored-key", srv.URL

	if res := v.LLMTestEffort("", nil, nil, "low", "m", ""); res["ok"] != true {
		t.Fatalf("test failed: %v", res)
	}
	if got["reasoning_effort"] != "low" {
		t.Fatalf("reasoning_effort = %v, want low", got["reasoning_effort"])
	}
	v.LLMTestEffort("", nil, nil, "", "m", "")
	if _, sent := got["reasoning_effort"]; sent {
		t.Fatalf("reasoning_effort sent with no effort chosen: %v", got)
	}
	if res := v.LLMTestEffort("", nil, nil, "turbo", "m", ""); res["ok"] == true {
		t.Fatalf("an unknown effort was sent: %v", res)
	}
}

// The model list: names only, sorted, Gemini's "models/" prefix removed.
func TestLLMModelsReturnsSortedShortNames(t *testing.T) {
	var path, auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, auth = r.URL.Path, r.Header.Get("Authorization")
		w.Write([]byte(`{"data":[{"id":"models/gemini-b","owned_by":"x"},{"id":"a-model"},{"id":""}]}`))
	}))
	defer srv.Close()
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.groq, v.llmBase = "stored-key", srv.URL+"/v1"

	res := v.LLMModels("", nil, "")
	if res["ok"] != true {
		t.Fatalf("LLMModels: %v", res)
	}
	if want := []string{"a-model", "gemini-b"}; !reflect.DeepEqual(res["models"], want) {
		t.Fatalf("models = %v, want %v", res["models"], want)
	}
	if path != "/v1/models" || auth != "Bearer stored-key" {
		t.Fatalf("asked %q with %q", path, auth)
	}
}

// The model list follows the key test's rule: the stored key never goes to
// an address this request supplied.
func TestLLMModelsNeverSendsTheStoredKeyToANewAddress(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer srv.Close()
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.groq = "stored-secret-key"

	if res := v.LLMModels("", strp(srv.URL+"/v1"), ""); res["ok"] == true {
		t.Fatalf("expected a refusal, got %v", res)
	}
	if calls != 0 {
		t.Fatalf("the new address received %d request(s)", calls)
	}
}

func TestLLMModelsProviderErrorIsAFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) }))
	defer srv.Close()
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.groq, v.llmBase = "k", srv.URL
	if res := v.LLMModels("", nil, ""); res["ok"] == true {
		t.Fatalf("a 401 was reported as a list: %v", res)
	}
}

// Saving with the key box empty keeps the saved key, so changing the model
// or effort does not need the key pasted again.
func TestSaveWithEmptyKeyKeepsTheSavedKey(t *testing.T) {
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	if err := v.Init("effort-test-pass"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	v.SetLLMEffort("claude-key", strp("https://api.anthropic.com/v1"), strp("claude-a"), strp(""))
	if res := v.SetLLMEffort("", strp("https://api.anthropic.com/v1"), strp("claude-b"), strp("medium")); res["ok"] != true {
		t.Fatalf("save with the saved key: %v", res)
	}
	if g, b, m := v.LLMCreds(); g != "claude-key" || b != "https://api.anthropic.com/v1" || m != "claude-b" || v.LLMEffort() != "medium" {
		t.Fatalf("after save: key=%q base=%q model=%q effort=%q", g, b, m, v.LLMEffort())
	}
}

// The saved key never moves to a new address without being typed, so a save
// can never send it to another provider.
func TestSaveWithEmptyKeyRefusesANewAddress(t *testing.T) {
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	if err := v.Init("effort-test-pass"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	v.SetLLMEffort("claude-key", strp("https://api.anthropic.com/v1"), strp("claude-a"), nil)
	for _, base := range []string{"https://attacker.example/v1", "", "https://api.groq.com/openai/v1"} {
		if res := v.SetLLMEffort("", strp(base), strp("m"), nil); res["ok"] == true {
			t.Fatalf("saved key moved to %q: %v", base, res)
		}
	}
	if _, b, m := v.LLMCreds(); b != "https://api.anthropic.com/v1" || m != "claude-a" {
		t.Fatalf("a refused save changed settings: base=%q model=%q", b, m)
	}
	// With nothing saved, an empty key is still refused.
	w := New(filepath.Join(t.TempDir(), "vault.json"))
	w.Init("effort-test-pass")
	if res := w.SetLLMEffort("", nil, strp("m"), nil); res["ok"] == true {
		t.Fatalf("saved with no key at all: %v", res)
	}
}

// Test with the key box empty uses the saved key only at the saved address:
// a saved Claude key is never sent to Groq or anywhere else.
func TestTestWithSavedKeyStaysAtTheSavedAddress(t *testing.T) {
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	v.groq, v.llmBase = "claude-key", "https://api.anthropic.com/v1"
	for _, base := range []string{"https://api.groq.com/openai/v1", "https://attacker.example/v1"} {
		if res := v.LLMTestEffort("", strp(base), strp("m"), "", "m", ""); res["ok"] == true || res["error"] == "LLM test failed" {
			t.Fatalf("saved key was sent to %q: %v", base, res)
		}
		if res := v.LLMModels("", strp(base), ""); res["ok"] == true || res["error"] == "could not list models" {
			t.Fatalf("saved key was sent to %q for the model list: %v", base, res)
		}
	}
}
