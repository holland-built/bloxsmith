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

// TestIdentityValueNeverReturnsOverride pins the resolver used by CSP identity
// calls (account.Manager.cspJSON). It must answer "who is this user", so it
// resolves fallback -> active tenant key and NEVER the account-switch override.
//
// The override case is the load-bearing one: returning to Auth.Value() here
// would reintroduce the bug this method exists to prevent — an identity call
// signed with a switched-in account's short-lived JWT, which narrows the account
// list to that account and locks the user out of switching back once it expires.
func TestIdentityValueNeverReturnsOverride(t *testing.T) {
	// Env-key mode: the fallback identifies the person, and wins over active().
	env := NewAuth("env-key", func() string { return "vault-active" })
	if got := env.IdentityValue(); got != "env-key" {
		t.Fatalf("env mode: got %q, want env-key", got)
	}

	// Vault mode: no env key at all, so identity is the active tenant's key.
	// This is the case that used to send an EMPTY Authorization header and 401.
	v := NewAuth("", func() string { return "VAULTKEY" })
	if got := v.IdentityValue(); got != "VAULTKEY" {
		t.Fatalf("vault mode: got %q, want VAULTKEY", got)
	}
	if got := v.IdentityValue(); got == "" {
		t.Fatal("vault mode resolved an empty identity credential — this is the 401 bug")
	}

	// An account switch is in force. Value() must follow it; IdentityValue()
	// must ignore it, in BOTH modes.
	v.SetOverride("Bearer SWITCHED-JWT")
	env.SetOverride("Bearer SWITCHED-JWT")
	if got := v.Value(); got != "Bearer SWITCHED-JWT" {
		t.Fatalf("Value must still follow the switch: %q", got)
	}
	if got := v.IdentityValue(); got != "VAULTKEY" {
		t.Fatalf("vault mode leaked the switched-account JWT into an identity call: %q", got)
	}
	if got := env.IdentityValue(); got != "env-key" {
		t.Fatalf("env mode leaked the switched-account JWT into an identity call: %q", got)
	}

	// Nothing configured at all resolves to empty rather than panicking.
	if got := NewAuth("", nil).IdentityValue(); got != "" {
		t.Fatalf("no fallback and no active resolver: got %q, want empty", got)
	}
}
