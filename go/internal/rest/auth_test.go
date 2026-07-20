package rest

import "testing"

// TestAuthOverrideOrder pins the resolver precedence that fixes the account-switch
// cross-tenant leak: an override (set by a portal account switch) MUST win over
// the active-tenant key even in vault mode, where active() is non-empty. Before
// the fix the switch wrote the fallback slot, which active() shadowed, so REST
// calls kept using the prior tenant's key.
func TestAuthOverrideOrder(t *testing.T) {
	a := NewAuth("env-fallback", func() string { return "vault-active" })

	// No override: vault active key wins over the env fallback.
	if got := a.Value(); got != "vault-active" {
		t.Fatalf("baseline: got %q, want vault-active", got)
	}

	// After a switch to another tenant the override must take effect immediately,
	// NOT be shadowed by the still-non-empty vault active key.
	a.SetOverride("Bearer switched-jwt")
	if got := a.Value(); got != "Bearer switched-jwt" {
		t.Fatalf("after switch: got %q, want the switched JWT (cross-tenant leak!)", got)
	}

	// Switching back to the home account clears the override; resolution falls
	// back through active() again.
	a.SetOverride("")
	if got := a.Value(); got != "vault-active" {
		t.Fatalf("after home switch: got %q, want vault-active", got)
	}

	// With no active key at all, the env fallback is used.
	b := NewAuth("env-fallback", func() string { return "" })
	if got := b.Value(); got != "env-fallback" {
		t.Fatalf("empty active: got %q, want env-fallback", got)
	}
	b.SetOverride("Bearer x")
	if got := b.Value(); got != "Bearer x" {
		t.Fatalf("override over empty active: got %q, want Bearer x", got)
	}
}
