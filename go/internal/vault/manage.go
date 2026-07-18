// This file ports the tenant/LLM management helpers that back the 14
// /api/vault/* POST routes from server.py (2834-3054): _norm_key (2834),
// _portal_label_for_key (2853), vault_add_tenant (2878), vault_remove_tenant
// (2899), vault_update_tenant (2909), vault_set_active (2933), vault_set_llm
// (2966), vault_test_key (2982), vault_conn_test (2999), vault_llm_test (3005),
// vault_refresh_names (3024), vault_status (3040). Each returns the same
// map[string]any shape the Python JSON responder emits, so the wire response is
// byte-compatible.
//
// Note on _apply_active: Python re-points the global MCP_HEADERS/API_KEY slot on
// every mutation. The Go port has no such global — rest.Auth reads ActiveKey()
// live on each request — so "apply active" is implicit and the mutations here
// only persist state (the fix for the _apply_active race, plans/README.md).
package vault

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var tenantNRe = regexp.MustCompile(`^Tenant \d+$`)

func tokenHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func ok() map[string]any            { return map[string]any{"ok": true} }
func fail(msg string) map[string]any { return map[string]any{"ok": false, "error": msg} }

// baseURL returns the configured Infoblox base, defaulting to the CSP portal.
func (v *Vault) baseURL() string {
	if v.BaseURL != "" {
		return strings.TrimRight(v.BaseURL, "/")
	}
	return "https://csp.infoblox.com"
}

// NormKey is _norm_key (server.py:2834): normalize any pasted Infoblox key to
// the Authorization value the bridge sends (Token/Bearer scheme inference).
func NormKey(k string) string {
	k = strings.TrimSpace(k)
	if len(k) >= 2 && k[0] == k[len(k)-1] && (k[0] == '\'' || k[0] == '"') {
		k = strings.TrimSpace(k[1 : len(k)-1])
	}
	if strings.HasPrefix(strings.ToLower(k), "authorization:") {
		k = strings.TrimSpace(strings.SplitN(k, ":", 2)[1])
	}
	if k == "" {
		return ""
	}
	scheme, rest, sep := k, "", false
	if i := strings.IndexByte(k, ' '); i >= 0 {
		scheme, rest, sep = k[:i], k[i+1:], true
	}
	if sep {
		switch strings.ToLower(scheme) {
		case "token":
			return "Token " + strings.TrimSpace(rest)
		case "bearer":
			return "Bearer " + strings.TrimSpace(rest)
		}
	}
	if strings.HasPrefix(k, "eyJ") { // unprefixed JWT
		return "Bearer " + k
	}
	return "Token " + k
}

// portalLabelForKey is _portal_label_for_key (server.py:2853): resolve the CSP
// account name for a key so a tenant auto-names itself.
func (v *Vault) portalLabelForKey(key string) string {
	client := &http.Client{Timeout: 12 * time.Second}
	get := func(path string) (map[string]any, error) {
		req, _ := http.NewRequest("GET", v.baseURL()+path, nil)
		req.Header.Set("Authorization", key)
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		var m map[string]any
		return m, json.NewDecoder(resp.Body).Decode(&m)
	}
	body, err := get("/v2/current_user/accounts")
	if err != nil {
		return ""
	}
	accts, _ := body["results"].([]any)
	active := make([]map[string]any, 0, len(accts))
	for _, a := range accts {
		if m, ok := a.(map[string]any); ok {
			if s, _ := m["state"].(string); s == "" || s == "active" {
				active = append(active, m)
			}
		}
	}
	if len(active) == 0 {
		for _, a := range accts {
			if m, ok := a.(map[string]any); ok {
				active = append(active, m)
			}
		}
	}
	aid := ""
	if cu, err := get("/v2/current_user"); err == nil {
		if res, ok := cu["result"].(map[string]any); ok {
			aid, _ = res["account_id"].(string)
		}
	}
	for _, a := range active {
		if id, _ := a["id"].(string); id == aid {
			if n, _ := a["name"].(string); n != "" {
				return n
			}
		}
	}
	if len(active) > 0 {
		if n, _ := active[0]["name"].(string); n != "" {
			return n
		}
	}
	return ""
}

// InitR wraps Init in the {ok,error} shape of vault_init (server.py:2798).
func (v *Vault) InitR(passphrase string) map[string]any {
	if err := v.Init(passphrase); err != nil {
		return fail(err.Error())
	}
	return ok()
}

// UnlockR wraps Unlock (server.py:2810), then best-effort refreshes names.
func (v *Vault) UnlockR(passphrase string) map[string]any {
	if err := v.Unlock(passphrase); err != nil {
		return fail(err.Error())
	}
	_ = v.RefreshNames() // best-effort, mirrors the try/except at 2828
	return ok()
}

// AddTenant is vault_add_tenant (server.py:2878).
func (v *Vault) AddTenant(label, key string, groq *string) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.Unlocked {
		return fail("locked")
	}
	nk := NormKey(key)
	if nk == "" {
		return fail("API key required")
	}
	label = strings.TrimSpace(label)
	if label == "" {
		if l := v.portalLabelForKeyUnlocked(nk); l != "" {
			label = l
		} else {
			label = "Tenant " + strconv.Itoa(len(v.Tenants)+1)
		}
	}
	tid := tokenHex(6)
	v.Tenants = append(v.Tenants, Tenant{ID: tid, Label: label, Key: nk})
	if groq != nil {
		v.Groq = strings.TrimSpace(*groq)
	}
	if v.Active == nil {
		v.Active = &tid
	}
	if err := v.save(); err != nil {
		return fail(err.Error())
	}
	return map[string]any{"ok": true, "id": tid, "label": label}
}

// RemoveTenant is vault_remove_tenant (server.py:2899).
func (v *Vault) RemoveTenant(tid string) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.Unlocked {
		return fail("locked")
	}
	kept := v.Tenants[:0:0]
	for _, t := range v.Tenants {
		if t.ID != tid {
			kept = append(kept, t)
		}
	}
	v.Tenants = kept
	if v.Active != nil && *v.Active == tid {
		if len(v.Tenants) > 0 {
			id := v.Tenants[0].ID
			v.Active = &id
		} else {
			v.Active = nil
		}
	}
	if err := v.save(); err != nil {
		return fail(err.Error())
	}
	return ok()
}

// UpdateTenant is vault_update_tenant (server.py:2909): replace key, rename, or
// both; a blank key keeps the existing key (rename-only).
func (v *Vault) UpdateTenant(tid, key string, label *string) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.Unlocked {
		return fail("locked")
	}
	nk := NormKey(key)
	lbl := ""
	if label != nil {
		lbl = strings.TrimSpace(*label)
	}
	if nk == "" && lbl == "" {
		return fail("nothing to update")
	}
	idx := -1
	for i := range v.Tenants {
		if v.Tenants[i].ID == tid {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fail("unknown connection")
	}
	if nk != "" {
		v.Tenants[idx].Key = nk
		if lbl == "" { // new key, no explicit name → auto-resolve
			if l := v.portalLabelForKeyUnlocked(nk); l != "" {
				lbl = l
			} else if v.Tenants[idx].Label != "" {
				lbl = v.Tenants[idx].Label
			} else {
				lbl = "Tenant " + strconv.Itoa(idx+1)
			}
		}
	}
	if lbl != "" {
		v.Tenants[idx].Label = lbl
	}
	if err := v.save(); err != nil {
		return fail(err.Error())
	}
	return map[string]any{"ok": true, "id": tid, "label": v.Tenants[idx].Label}
}

// SetActive is vault_set_active (server.py:2933).
func (v *Vault) SetActive(tid string) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.Unlocked {
		return fail("locked")
	}
	found := false
	for _, t := range v.Tenants {
		if t.ID == tid {
			found = true
			break
		}
	}
	if !found {
		return fail("unknown tenant")
	}
	id := tid
	v.Active = &id
	if err := v.save(); err != nil {
		return fail(err.Error())
	}
	return map[string]any{"ok": true, "active": tid}
}

// LockR wraps Lock (server.py:2943) in the {ok} shape.
func (v *Vault) LockR() map[string]any { v.Lock(); return ok() }

// ResetR wraps Reset (server.py:2951).
func (v *Vault) ResetR() map[string]any {
	if err := v.Reset(); err != nil {
		return fail(err.Error())
	}
	return ok()
}

// SetLLM is vault_set_llm (server.py:2966): backs both /api/vault/groq (key
// only) and /api/vault/llm (key + base_url + model). nil pointers = unchanged.
func (v *Vault) SetLLM(key string, baseURL, model *string) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.Unlocked {
		return fail("locked")
	}
	v.Groq = strings.TrimSpace(key)
	if baseURL != nil {
		v.LLMBase = strings.TrimSpace(*baseURL)
	}
	if model != nil {
		v.LLMModel = strings.TrimSpace(*model)
	}
	if err := v.save(); err != nil {
		return fail(err.Error())
	}
	return ok()
}

// TestKey is vault_test_key (server.py:2982): verify a key reaches CSP and
// return the resolved account name.
func (v *Vault) TestKey(key string) map[string]any {
	k := NormKey(key)
	if k == "" {
		return fail("API key required")
	}
	if name := v.portalLabelForKey(k); name != "" {
		return map[string]any{"ok": true, "name": name}
	}
	// reachable but no name resolved: probe /v2/current_user
	client := &http.Client{Timeout: 12 * time.Second}
	req, _ := http.NewRequest("GET", v.baseURL()+"/v2/current_user", nil)
	req.Header.Set("Authorization", k)
	resp, err := client.Do(req)
	if err != nil {
		return fail("key rejected by Infoblox CSP")
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fail("key rejected by Infoblox CSP")
	}
	return map[string]any{"ok": true, "name": ""}
}

// ConnTest is vault_conn_test (server.py:2999): test the ACTIVE key. activeAuth
// is rest.Auth.Value() (active tenant key, else env fallback).
func (v *Vault) ConnTest(activeAuth string) map[string]any {
	if activeAuth == "" {
		return fail("no active connection")
	}
	return v.TestKey(activeAuth)
}

// LLMTest is vault_llm_test (server.py:3005): send a tiny completion to the
// OpenAI-compatible provider (plain HTTP, no SDK — per plan). defaultModel is
// the process LLM_MODEL fallback.
func (v *Vault) LLMTest(key string, baseURL, model *string, defaultModel string) map[string]any {
	v.mu.Lock()
	k := strings.TrimSpace(key)
	if k == "" {
		k = v.Groq
	}
	base := v.LLMBase
	if baseURL != nil {
		base = strings.TrimSpace(*baseURL)
	}
	mdl := ""
	if model != nil {
		mdl = *model
	}
	if mdl == "" {
		mdl = v.LLMModel
	}
	if mdl == "" {
		mdl = defaultModel
	}
	v.mu.Unlock()
	if k == "" {
		return fail("API key required")
	}
	if base == "" {
		base = "https://api.groq.com/openai/v1"
	}
	reqBody, _ := json.Marshal(map[string]any{
		"model":      mdl,
		"max_tokens": 4,
		"messages":   []map[string]string{{"role": "user", "content": "ping"}},
	})
	req, _ := http.NewRequest("POST", strings.TrimRight(base, "/")+"/chat/completions", strings.NewReader(string(reqBody)))
	req.Header.Set("Authorization", "Bearer "+k)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fail("LLM test failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fail("LLM test failed")
	}
	return map[string]any{"ok": true, "model": mdl}
}

// RefreshNames is vault_refresh_names (server.py:3024): re-resolve the CSP name
// for any tenant still labelled "Tenant N" or blank.
func (v *Vault) RefreshNames() map[string]any {
	v.mu.Lock()
	if !v.Unlocked {
		v.mu.Unlock()
		return fail("locked")
	}
	// snapshot keys+labels to resolve without holding the lock across network I/O
	type slot struct{ i int; key, label string }
	var todo []slot
	for i, t := range v.Tenants {
		if t.Label == "" || tenantNRe.MatchString(t.Label) {
			todo = append(todo, slot{i, t.Key, t.Label})
		}
	}
	v.mu.Unlock()
	updated := 0
	for _, s := range todo {
		nm := v.portalLabelForKey(s.key)
		if nm != "" && nm != s.label {
			v.mu.Lock()
			if s.i < len(v.Tenants) && v.Tenants[s.i].Key == s.key {
				v.Tenants[s.i].Label = nm
				updated++
			}
			v.mu.Unlock()
		}
	}
	if updated > 0 {
		v.mu.Lock()
		_ = v.save()
		v.mu.Unlock()
	}
	return map[string]any{"ok": true, "updated": updated}
}

// Status is vault_status (server.py:3040). version, vaultMode, and update come
// from the process (server wires them); the rest is vault state.
func (v *Vault) Status(version string, vaultMode bool, update any) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	tenants := make([]map[string]any, 0, len(v.Tenants))
	for _, t := range v.Tenants {
		tenants = append(tenants, map[string]any{"id": t.ID, "label": t.Label})
	}
	var active any
	if v.Active != nil {
		active = *v.Active
	}
	ready := (!vaultMode) || v.activeKeyLocked() != ""
	return map[string]any{
		"version":   version,
		"vaultMode": vaultMode,
		"exists":    v.Exists(),
		"unlocked":  (!vaultMode) || v.Unlocked,
		"ready":     ready,
		"tenants":   tenants,
		"active":    active,
		"hasGroq":   v.Groq != "",
		"llm": map[string]any{
			"hasKey":   v.Groq != "",
			"base_url": v.LLMBase,
			"model":    v.LLMModel,
		},
		"update": update,
	}
}

// --- small internals kept lock-aware -----------------------------------------

// portalLabelForKeyUnlocked is called while v.mu is already held. The lookup is
// pure network I/O against a passed key, touching no vault state, so it is safe
// to run under the lock (matches Python calling it inside _vault_lock at 2886).
func (v *Vault) portalLabelForKeyUnlocked(key string) string { return v.portalLabelForKey(key) }

// activeKeyLocked resolves the active tenant key assuming v.mu is held.
func (v *Vault) activeKeyLocked() string {
	if v.Active == nil {
		return ""
	}
	for _, t := range v.Tenants {
		if t.ID == *v.Active {
			return t.Key
		}
	}
	return ""
}
