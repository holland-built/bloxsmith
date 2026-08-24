package vault

import (
	"os"
	"path/filepath"
	"testing"
)

// openVault makes an unlocked vault on a throwaway file.
func openVault(t *testing.T) *Vault {
	t.Helper()
	v := New(filepath.Join(t.TempDir(), "vault.json"))
	if err := v.Init("passphrase-for-the-test"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return v
}

func TestSetAxurRoundTrip(t *testing.T) {
	v := openVault(t)
	res := v.SetAxur("axur-token-1")
	if ok, _ := res["ok"].(bool); !ok {
		t.Fatalf("SetAxur: %v", res)
	}
	if stored, _ := res["stored"].(bool); !stored {
		t.Errorf("stored = %v, want true", res["stored"])
	}
	if got := v.AxurKey(); got != "axur-token-1" {
		t.Errorf("AxurKey = %q, want the stored value verbatim", got)
	}
}

// TestAxurSurvivesLockUnlock is the point of putting the key in the vault at
// all: it has to still be there after a restart, which lock/unlock stands in
// for. It also pins that a LOCKED vault reports empty — the state
// dashboard.FetchAxurTickets must render as "locked", never "not configured".
func TestAxurSurvivesLockUnlock(t *testing.T) {
	v := openVault(t)
	v.SetAxur("axur-token-1")

	v.Lock()
	if got := v.AxurKey(); got != "" {
		t.Errorf("a locked vault still answered with the key: %q", got)
	}
	if v.IsUnlocked() {
		t.Fatal("vault reports unlocked after Lock")
	}

	if err := v.Unlock("passphrase-for-the-test"); err != nil {
		t.Fatalf("Unlock: %v", err)
	}
	if got := v.AxurKey(); got != "axur-token-1" {
		t.Errorf("AxurKey after unlock = %q, want the stored value back", got)
	}
}

// TestAxurReadFromDiskByAnotherProcess proves the key is really in the file and
// not merely in memory — a second Vault over the same path is what a restart
// looks like.
func TestAxurReadFromDiskByAnotherProcess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")
	v1 := New(path)
	if err := v1.Init("passphrase-ok"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	v1.SetAxur("persisted-token")

	v2 := New(path)
	if err := v2.Unlock("passphrase-ok"); err != nil {
		t.Fatalf("Unlock in the second vault: %v", err)
	}
	if got := v2.AxurKey(); got != "persisted-token" {
		t.Errorf("second vault read %q, want persisted-token", got)
	}
}

// TestSetAxurRefusedWhenLocked: a locked vault must not accept a write, or the
// key would live in memory with nothing on disk behind it.
func TestSetAxurRefusedWhenLocked(t *testing.T) {
	v := openVault(t)
	v.Lock()
	res := v.SetAxur("nope")
	if ok, _ := res["ok"].(bool); ok {
		t.Fatalf("a locked vault accepted SetAxur: %v", res)
	}
	if res["error"] != "locked" {
		t.Errorf("error = %v, want locked", res["error"])
	}
}

// TestClearAxur: an empty key removes the entry. It does NOT claim to disable
// Axur — the environment may still hold a key — and `stored:false` is how a
// caller sees which happened.
func TestClearAxur(t *testing.T) {
	v := openVault(t)
	v.SetAxur("axur-token-1")
	res := v.SetAxur("")
	if ok, _ := res["ok"].(bool); !ok {
		t.Fatalf("clear failed: %v", res)
	}
	if stored, _ := res["stored"].(bool); stored {
		t.Errorf("stored = true after clearing")
	}
	if got := v.AxurKey(); got != "" {
		t.Errorf("AxurKey = %q after clearing", got)
	}
}

// TestAxurAbsentFromOlderVault is the migration question, answered by the
// format rather than by a migration: a vault written before this field existed
// unlocks cleanly and reports no Axur key. Simulated by writing a vault, then
// confirming a fresh one round-trips with the field simply never set.
func TestAxurAbsentFromOlderVault(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")
	v := New(path)
	if err := v.Init("passphrase-ok"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	// A vault that never saw SetAxur is byte-for-byte the "older file" case for
	// this field: payload.Axur is the zero value on the way out and on the way
	// back in.
	v.AddTenant("label", "Token abc", nil)
	v2 := New(path)
	if err := v2.Unlock("passphrase-ok"); err != nil {
		t.Fatalf("Unlock: %v", err)
	}
	if got := v2.AxurKey(); got != "" {
		t.Errorf("AxurKey = %q, want empty for a vault that never stored one", got)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("vault file missing: %v", err)
	}
}

// TestStatusReportsAxurPresenceNotTheKey: Settings needs to know whether to
// offer "Remove", and nothing more. The key itself must never leave the
// process through this route.
func TestStatusReportsAxurPresenceNotTheKey(t *testing.T) {
	v := openVault(t)
	st := v.Status("v0", true, nil)
	if st["hasAxur"] != false {
		t.Errorf("hasAxur = %v on a fresh vault, want false", st["hasAxur"])
	}
	v.SetAxur("super-secret-token")
	st = v.Status("v0", true, nil)
	if st["hasAxur"] != true {
		t.Errorf("hasAxur = %v after storing, want true", st["hasAxur"])
	}
	for k, val := range st {
		if s, ok := val.(string); ok && s == "super-secret-token" {
			t.Fatalf("Status leaked the Axur key through %q", k)
		}
	}
}
