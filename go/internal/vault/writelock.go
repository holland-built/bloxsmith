package vault

import (
	"sort"
	"strings"
)

// PER-TENANT WRITE LOCK
//
// v3.23.0 made every outbound call in one request use ONE tenant consistently.
// It did not make the dangerous thing impossible: the worst case it fixed was a
// teardown that starts deleting subnets and DNS zones in tenant A and finishes
// in tenant B, and after that fix a teardown pointed at the wrong tenant to
// begin with still deletes everything in it, consistently and correctly.
//
// This is the control for that. Provisioning, teardown and every edit route
// refuse outright unless the tenant they would land in has been explicitly
// marked writable. Marking is per tenant, stored in the encrypted vault
// payload, and there is no global override.
//
// DEFAULT: READ-ONLY. A tenant nobody has opted in is not writable, including a
// tenant added a minute ago and including the one running from an env API key.
// Fail closed, like every other control in this repository. The reason is that
// demos run against real customer accounts, and the property worth having is not
// "I remembered which tab I was on" — it is that a customer's tenant physically
// cannot be modified from here.
//
// WHAT IDENTIFIES "THE TENANT THIS WRITE WOULD LAND IN"
//
// Two things decide it, and BOTH have to be in the identity or the lock has a
// hole in it:
//
//   1. Which stored connection's key is in play (the vault tenant), and
//   2. whether a portal account switch is in force, and to which CSP account.
//
// A switch mints a JWT for a different account under the same key
// (account.SwitchAccount), so keying the permission on the vault tenant alone
// would let "Delta is writable" carry straight over into HERE Technologies the
// moment someone used the account switcher. Keying it on the CSP account alone
// would break the other way round: the account id is only known once CSP has
// answered, so every write would refuse on a fresh boot for a reason that has
// nothing to do with permission.
//
// So the identity is the pair, written "<vault tenant>/<csp account>", with "-"
// for "no switch in force — the key's own home account". It is opaque: nothing
// parses it, it is only ever compared.
//
// HONEST SCOPE. This stops a mistake and it stops the UI. It is not a boundary
// against the operator: anyone who can unlock the vault can mark a tenant
// writable, and anyone with the tenant's API key can write to it without going
// through this program at all. What it buys is that the dangerous routes cannot
// fire against a tenant nobody deliberately opted in — which is exactly the
// failure being guarded against, since the operator here is also the person
// running the demo.

// NoSwitch is the CSP-account half of an identity when no portal account switch
// is in force, i.e. the stored key's own home account.
const NoSwitch = "-"

// EnvTenant is the vault-tenant half of an identity when the process is running
// from an env API_KEY with no vault tenant active. It is a real identity that
// can be marked writable, not a bypass.
const EnvTenant = "env"

// WriteID builds the opaque identity of a write target from its two halves.
// Callers pass NoSwitch / EnvTenant where those apply.
func WriteID(vaultTenant, cspAccount string) string {
	vaultTenant = strings.TrimSpace(vaultTenant)
	cspAccount = strings.TrimSpace(cspAccount)
	if vaultTenant == "" {
		vaultTenant = EnvTenant
	}
	if cspAccount == "" {
		cspAccount = NoSwitch
	}
	return vaultTenant + "/" + cspAccount
}

// ActiveTenantID returns the active vault tenant's id, or "" when none is
// active. Lock-guarded; "" is a real answer (env-key mode), not a failure.
func (v *Vault) ActiveTenantID() string {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.active == nil {
		return ""
	}
	return *v.active
}

// LabelForTenantID returns a stored tenant's label, or "" when the id is
// unknown. Used only to name the tenant in a refusal message.
func (v *Vault) LabelForTenantID(tid string) string {
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, t := range v.tenants {
		if t.ID == tid {
			return t.Label
		}
	}
	return ""
}

// WriteAllowed reports whether this exact identity has been marked writable.
// A malformed or empty id is not writable — the caller could not say where the
// write would land, which is the strongest reason to refuse.
func (v *Vault) WriteAllowed(id string) bool {
	if strings.TrimSpace(id) == "" {
		return false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, a := range v.writeAllowed {
		if a == id {
			return true
		}
	}
	return false
}

// WriteAllowedList returns a sorted copy of every identity currently marked
// writable, for the settings UI and for the audit detail on a refusal.
func (v *Vault) WriteAllowedList() []string {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := make([]string, len(v.writeAllowed))
	copy(out, v.writeAllowed)
	sort.Strings(out)
	return out
}

// SetWritable marks an identity writable (on) or removes it (off), then saves.
//
// Turning it OFF is deliberately allowed while the vault is locked-out of
// nothing and never fails on an unknown id: revoking write permission must
// always be possible and must always succeed, including for an identity that no
// longer resolves to a stored tenant. Turning it ON requires an unlocked vault,
// because it has to be persisted.
func (v *Vault) SetWritable(id string, on bool) map[string]any {
	id = strings.TrimSpace(id)
	if id == "" {
		return fail("tenant id required")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.unlocked {
		return fail("locked")
	}

	has := false
	kept := make([]string, 0, len(v.writeAllowed)+1)
	for _, a := range v.writeAllowed {
		if a == id {
			has = true
			if !on {
				continue // dropping it
			}
		}
		kept = append(kept, a)
	}
	if on && !has {
		kept = append(kept, id)
	}
	if on == has && len(kept) == len(v.writeAllowed) {
		return map[string]any{"ok": true, "id": id, "writable": on, "changed": false}
	}

	snap := v.snapshot()
	v.writeAllowed = kept
	if err := v.save(); err != nil {
		v.restore(snap)
		return fail(err.Error())
	}
	return map[string]any{"ok": true, "id": id, "writable": on, "changed": true}
}

// forgetTenantWrites drops every write permission whose vault-tenant half is
// tid. Caller holds v.mu and is responsible for save().
//
// This runs when a tenant is removed or its key is replaced. Without it, a
// permission would outlive the thing it was granted for: tenant ids are random
// hex, so a collision is not the worry — replacing a key is. "Delta is writable"
// must not silently keep applying after the key behind Delta has been swapped
// for a different account's.
func (v *Vault) forgetTenantWrites(tid string) {
	prefix := tid + "/"
	kept := make([]string, 0, len(v.writeAllowed))
	for _, a := range v.writeAllowed {
		if strings.HasPrefix(a, prefix) {
			continue
		}
		kept = append(kept, a)
	}
	v.writeAllowed = kept
}
