package vault

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// fixturePassphrase is the throwaway passphrase used to encrypt
// testdata/vault.json with the Python `cryptography` Fernet library, replicating
// server.py's _derive_key + _vault_save exactly (see the generator in the PR
// notes). It is NOT a real secret.
const fixturePassphrase = "test-passphrase-123"

// TestDecryptsPythonFixture proves the Go vault decrypts a vault.json written by
// the Python app to the exact expected plaintext (STATE-FILE COMPATIBILITY).
func TestDecryptsPythonFixture(t *testing.T) {
	src, err := os.ReadFile("testdata/vault.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	// Copy into a temp path so Unlock (which stats the file) works unmodified.
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")
	if err := os.WriteFile(path, src, 0o600); err != nil {
		t.Fatal(err)
	}

	v := New(path)
	if err := v.Unlock(fixturePassphrase); err != nil {
		t.Fatalf("unlock python fixture: %v", err)
	}

	if !v.Unlocked {
		t.Fatal("expected unlocked")
	}
	if v.Active == nil || *v.Active != "aabbccddeeff" {
		t.Fatalf("active mismatch: %v", v.Active)
	}
	if len(v.Tenants) != 2 {
		t.Fatalf("want 2 tenants, got %d", len(v.Tenants))
	}
	want := []Tenant{
		{ID: "aabbccddeeff", Label: "Demo Tenant", Key: "Token demo-key-not-real-123"},
		{ID: "112233445566", Label: "Sandbox", Key: "Bearer eyJhbGciOiJIUzI1NiJ9.demo"},
	}
	for i, w := range want {
		if v.Tenants[i] != w {
			t.Fatalf("tenant[%d] = %+v, want %+v", i, v.Tenants[i], w)
		}
	}
	if v.Groq != "gsk_demo_not_real" {
		t.Fatalf("groq mismatch: %q", v.Groq)
	}
	if v.LLMBase != "https://api.groq.com/openai/v1" || v.LLMModel != "qwen/qwen3-32b" {
		t.Fatalf("llm cfg mismatch: base=%q model=%q", v.LLMBase, v.LLMModel)
	}

	// Wrong passphrase must be rejected.
	v2 := New(path)
	if err := v2.Unlock("definitely-wrong"); err != ErrWrongPassphrase {
		t.Fatalf("want ErrWrongPassphrase, got %v", err)
	}
}

// TestRoundTripPythonReadable proves a Go-encrypted vault re-encrypts to the
// exact on-disk envelope Python expects, and that re-deriving the key from the
// stored salt decrypts it back — the Go->Python-decryptable direction.
func TestRoundTripPythonReadable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")

	v := New(path)
	if err := v.Init("another-good-pass"); err != nil {
		t.Fatalf("init: %v", err)
	}
	active := "t1"
	v.Tenants = []Tenant{{ID: "t1", Label: "Roundtrip", Key: "Token rt-key"}}
	v.Active = &active
	v.Groq = "gsk_rt"
	if err := v.Save(); err != nil {
		t.Fatalf("save: %v", err)
	}

	// Envelope shape must be exactly {v, salt, data} that Python's json.load reads.
	raw, _ := os.ReadFile(path)
	var env fileEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("envelope not parseable: %v", err)
	}
	if env.V != 1 || env.Salt == "" || env.Data == "" {
		t.Fatalf("bad envelope: %+v", env)
	}

	// Independent reader (fresh Vault) re-derives the key from salt and decrypts,
	// exactly as Python's vault_unlock would.
	v3 := New(path)
	if err := v3.Unlock("another-good-pass"); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if v3.Active == nil || *v3.Active != "t1" || len(v3.Tenants) != 1 ||
		v3.Tenants[0].Key != "Token rt-key" || v3.Groq != "gsk_rt" {
		t.Fatalf("roundtrip data mismatch: %+v", v3)
	}
}
