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
	"fmt"
	"net"
	"net/http"
	"net/url"
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

func ok() map[string]any             { return map[string]any{"ok": true} }
func fail(msg string) map[string]any { return map[string]any{"ok": false, "error": msg} }

// unverifiable is the third TestKey/ConnTest outcome: the request never
// reached CSP at all (transport error — offline, DNS, TLS/proxy, or timeout),
// so the key was never judged. It must be visibly distinct from fail() —
// "unverified":true is the field the UI reads to tell "could not check" apart
// from "checked and rejected". ok stays false (neither outcome confirms a good
// key), but the UI must not render its "Invalid: key rejected" copy for this case.
func unverifiable(msg string) map[string]any {
	return map[string]any{"ok": false, "unverified": true, "error": msg}
}

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
//
// Two outcomes, deliberately NOT collapsed into a bare "" (finding C-F4):
//   - ("", nil)  the portal answered and has no name for this key
//   - ("", err)  the request never reached the portal, so nothing was learned
//
// Those are different facts and this repo does not render them the same. The
// second one is a could-not-check, and every caller decides for itself what to
// do about it rather than being handed a value that looks like an answer.
func (v *Vault) portalLabelForKey(key string) (string, error) {
	client := &http.Client{Timeout: 12 * time.Second}
	get := func(path string) (map[string]any, error) {
		req, _ := http.NewRequest("GET", v.baseURL()+path, nil)
		req.Header.Set("Authorization", key)
		resp, err := client.Do(req)
		if err != nil {
			return nil, err // offline, DNS, TLS/proxy, or the 12s timeout
		}
		defer resp.Body.Close()
		var m map[string]any
		// A body that will not decode (an error page, an empty 401) still means
		// the portal ANSWERED — it just carries no account list for this key.
		// That is a "no name" outcome, so the decode error is deliberately
		// dropped here instead of being reported as "could not reach". Only a
		// transport failure above is a could-not-check.
		_ = json.NewDecoder(resp.Body).Decode(&m)
		return m, nil
	}
	body, err := get("/v2/current_user/accounts")
	if err != nil {
		return "", err
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
				return n, nil
			}
		}
	}
	if len(active) > 0 {
		if n, _ := active[0]["name"].(string); n != "" {
			return n, nil
		}
	}
	return "", nil
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
	// Unlocking loads a (possibly different) active tenant into memory — coordinate
	// the auth reset + cache rotate so nothing from a prior locked session leaks.
	v.rotateAuth()
	_ = v.RefreshNames() // best-effort, mirrors the try/except at 2828
	return ok()
}

// AddTenant is vault_add_tenant (server.py:2878).
func (v *Vault) AddTenant(label, key string, groq *string) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.unlocked {
		return fail("locked")
	}
	nk := NormKey(key)
	if nk == "" {
		return fail("API key required")
	}
	label = strings.TrimSpace(label)
	if label == "" {
		// Both no-name outcomes land on the same placeholder, but for different
		// reasons and that choice is deliberate, not the old conflation: an
		// unreachable portal must not block the add, and "Tenant N" is exactly
		// the label RefreshNames re-resolves later. The placeholder is honest —
		// it claims no portal name — so nothing invented is presented as real.
		l, err := v.portalLabelForKeyUnlocked(nk)
		if err != nil || l == "" {
			label = "Tenant " + strconv.Itoa(len(v.tenants)+1)
		} else {
			label = l
		}
	}
	tid := tokenHex(6)
	snap := v.snapshot()
	v.tenants = append(v.tenants, Tenant{ID: tid, Label: label, Key: nk})
	if groq != nil {
		v.groq = strings.TrimSpace(*groq)
	}
	becameActive := false
	if v.active == nil {
		v.active = &tid
		becameActive = true
	}
	if err := v.save(); err != nil {
		v.restore(snap)
		return fail(err.Error())
	}
	// The first tenant added to an empty vault becomes active — the active key
	// just changed from nothing to this tenant, so rotate the auth+cache.
	if becameActive {
		v.rotateAuth()
	}
	return map[string]any{"ok": true, "id": tid, "label": label}
}

// RemoveTenant is vault_remove_tenant (server.py:2899).
func (v *Vault) RemoveTenant(tid string) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.unlocked {
		return fail("locked")
	}
	snap := v.snapshot()
	removedActive := v.active != nil && *v.active == tid
	kept := v.tenants[:0:0]
	for _, t := range v.tenants {
		if t.ID != tid {
			kept = append(kept, t)
		}
	}
	v.tenants = kept
	// A write permission must not outlive the tenant it was granted for.
	v.forgetTenantWrites(tid)
	if removedActive {
		if len(v.tenants) > 0 {
			id := v.tenants[0].ID
			v.active = &id
		} else {
			v.active = nil
		}
	}
	if err := v.save(); err != nil {
		v.restore(snap)
		return fail(err.Error())
	}
	// Removing the active tenant re-points active (or clears it) — the active key
	// changed, so rotate the auth+cache.
	if removedActive {
		v.rotateAuth()
	}
	return ok()
}

// UpdateTenant is vault_update_tenant (server.py:2909): replace key, rename, or
// both; a blank key keeps the existing key (rename-only).
func (v *Vault) UpdateTenant(tid, key string, label *string) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.unlocked {
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
	for i := range v.tenants {
		if v.tenants[i].ID == tid {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fail("unknown connection")
	}
	snap := v.snapshot()
	// The active tenant's key changes only when this tenant is active AND a new
	// key was supplied — that's what invalidates cached rows / a portal switch.
	activeKeyChanged := nk != "" && v.active != nil && *v.active == tid
	if nk != "" {
		// A REPLACED KEY REVOKES WRITE PERMISSION. "Delta is writable" was
		// granted for the account behind that key; swap the key and it may now
		// point at a completely different account, so the permission has to be
		// granted again deliberately. A rename alone changes nothing about where
		// a write lands and keeps it.
		v.forgetTenantWrites(tid)
		v.tenants[idx].Key = nk
		if lbl == "" { // new key, no explicit name → auto-resolve
			// As in AddTenant: an unreachable portal and a portal with no name
			// both fall back rather than failing the update, because the key
			// swap itself must still land. Keeping the existing label (or the
			// positional placeholder) claims no portal name either way.
			l, err := v.portalLabelForKeyUnlocked(nk)
			switch {
			case err == nil && l != "":
				lbl = l
			case v.tenants[idx].Label != "":
				lbl = v.tenants[idx].Label
			default:
				lbl = "Tenant " + strconv.Itoa(idx+1)
			}
		}
	}
	if lbl != "" {
		v.tenants[idx].Label = lbl
	}
	if err := v.save(); err != nil {
		v.restore(snap)
		return fail(err.Error())
	}
	if activeKeyChanged {
		v.rotateAuth()
	}
	return map[string]any{"ok": true, "id": tid, "label": v.tenants[idx].Label}
}

// SetActive is vault_set_active (server.py:2933).
func (v *Vault) SetActive(tid string) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.unlocked {
		return fail("locked")
	}
	found := false
	for _, t := range v.tenants {
		if t.ID == tid {
			found = true
			break
		}
	}
	if !found {
		return fail("unknown tenant")
	}
	snap := v.snapshot()
	id := tid
	v.active = &id
	if err := v.save(); err != nil {
		v.restore(snap)
		return fail(err.Error())
	}
	// SetActive is the canonical vault-tenant switch: coordinated reset of the
	// portal override + account.Manager active + JWT ts, plus a cache Rotate.
	v.rotateAuth()
	return map[string]any{"ok": true, "active": tid}
}

// LockR wraps Lock (server.py:2943) in the {ok} shape. Locking drops the active
// key, so coordinate the auth reset + cache rotate.
func (v *Vault) LockR() map[string]any {
	v.Lock()
	v.rotateAuth()
	return ok()
}

// ResetR wraps Reset (server.py:2951). Reset clears all tenants (no active key),
// so coordinate the auth reset + cache rotate.
func (v *Vault) ResetR() map[string]any {
	if err := v.Reset(); err != nil {
		return fail(err.Error())
	}
	v.rotateAuth()
	return ok()
}

// SetLLM is vault_set_llm (server.py:2966): backs both /api/vault/groq (key
// only) and /api/vault/llm (key + base_url + model). nil pointers = unchanged.
func (v *Vault) SetLLM(key string, baseURL, model *string) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.unlocked {
		return fail("locked")
	}
	// Same snapshot/restore every other mutation here uses. Without it a failed
	// save left the new credential live in memory while vault.json still held the
	// old one — this process would then send LLM requests with a key no future
	// process has ever seen, and the next successful save of ANY other mutation
	// would persist it silently (finding C-F5).
	snap := v.snapshot()
	v.groq = strings.TrimSpace(key)
	if baseURL != nil {
		v.llmBase = strings.TrimSpace(*baseURL)
	}
	if model != nil {
		v.llmModel = strings.TrimSpace(*model)
	}
	if err := v.save(); err != nil {
		v.restore(snap)
		return fail(err.Error())
	}
	return ok()
}

// SetAxur stores (or, with an empty key, clears) the Axur credential.
//
// CLEARING IS NOT DISABLING, and the difference is the one thing a caller has
// to understand here. An empty key removes the vault's entry; it does not
// switch Axur off. If AXUR_API_KEY is set in the environment, that value takes
// over again the moment this one is gone, because the vault is an override on
// top of the environment and not a replacement for it (main.go builds the
// resolver in that order, matching LLMCreds). The returned map therefore says
// which source is in effect afterwards, so a caller that meant "turn it off"
// can see that it did not.
//
// Snapshot/restore around save() for the reason SetLLM records: without it a
// failed write leaves the new credential live in memory while vault.json still
// holds the old one, and the next successful save of any other mutation
// persists it silently.
//
// IT DELIBERATELY DOES NOT CALL rotateAuth, and the reason is worth recording
// because the opposite looks correct. A cached Axur response was fetched with
// the PREVIOUS credential, so serving it after a key change would show one
// Axur tenant's incident counts under another's key. rotateAuth would drop
// those rows — but it is the tenant-switch reset, so it ALSO clears the portal
// account-switch override and the account manager's active state. Saving a
// third party's API key would then silently throw the operator out of the
// Infoblox account they had switched into. The staleness is fixed where it
// belongs instead: dashboard.FetchAxurTickets folds a fingerprint of the
// resolved credential into its cache key, so a changed key misses the cache
// and an unchanged one still hits it, with nothing else disturbed.
func (v *Vault) SetAxur(key string) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.unlocked {
		return fail("locked")
	}
	snap := v.snapshot()
	v.axur = strings.TrimSpace(key)
	stored := v.axur != ""
	if err := v.save(); err != nil {
		v.restore(snap)
		return fail(err.Error())
	}
	r := ok()
	r["stored"] = stored
	return r
}

// TestKey is vault_test_key (server.py:2982): verify a key reaches CSP and
// return the resolved account name.
func (v *Vault) TestKey(key string) map[string]any {
	k := NormKey(key)
	if k == "" {
		return fail("API key required")
	}
	name, err := v.portalLabelForKey(k)
	if err != nil {
		// The name lookup never reached CSP. Previously this returned a bare ""
		// and fell through to the probe below, which was about to fail the same
		// way — now the could-not-check is reported straight away instead of
		// costing a second doomed 12s round trip.
		return unverifiable("could not reach Infoblox CSP: " + err.Error())
	}
	if name != "" {
		return map[string]any{"ok": true, "name": name}
	}
	// reachable but no name resolved: probe /v2/current_user
	client := &http.Client{Timeout: 12 * time.Second}
	req, _ := http.NewRequest("GET", v.baseURL()+"/v2/current_user", nil)
	req.Header.Set("Authorization", k)
	resp, err := client.Do(req)
	if err != nil {
		// The request never reached CSP — offline, DNS failure, TLS/proxy error,
		// or the 12s timeout. The key was never judged, so this must not be
		// reported as "rejected"; that conflation is what pushes an operator to
		// discard a perfectly good credential during first-run setup.
		return unverifiable("could not reach Infoblox CSP: " + err.Error())
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

// defaultGroqBase is the hardcoded LLM provider default (matches the process
// fallback below and internal/ai's groq base).
const defaultGroqBase = "https://api.groq.com/openai/v1"

// isPrivateOrLocalHost reports whether host (already stripped of scheme/port)
// is a loopback, link-local, unspecified, or RFC1918/RFC4193 private address —
// the "obvious internal targets" llm-test must never reach regardless of
// which key it sends (cloud metadata endpoints live at a link-local address:
// 169.254.169.254).
func isPrivateOrLocalHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false // a public DNS name — not literally internal
	}
	return ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsPrivate()
}

// validateLLMBase rejects non-HTTPS base URLs and obvious internal/loopback/
// link-local targets. This runs for EVERY llm-test call, regardless of which
// key is used: the server makes the outbound request either way, so a
// body-supplied base_url is an authenticated-request SSRF primitive whether
// or not the caller also supplied their own credential.
func validateLLMBase(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Hostname() == "" {
		return fmt.Errorf("invalid base_url")
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return fmt.Errorf("base_url must use https")
	}
	if isPrivateOrLocalHost(u.Hostname()) {
		return fmt.Errorf("base_url may not target a local/internal host")
	}
	return nil
}

// llmHost extracts the hostname from a base URL, else "".
func llmHost(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// LLMTest is vault_llm_test (server.py:3005): send a tiny completion to the
// OpenAI-compatible provider (plain HTTP, no SDK — per plan). defaultModel is
// the process LLM_MODEL fallback; defaultBase is the process LLM_BASE_URL
// fallback (empty when unconfigured).
//
// Security: when the caller does NOT supply their own key, this test runs
// with the STORED credential — so a body-supplied base_url would otherwise
// let anyone with access to this endpoint exfiltrate the stored LLM key to an
// arbitrary host (an authenticated SSRF primitive: internal services, cloud
// metadata endpoints, etc., bypassing the browser's CSP since the fetch runs
// server-side). A body-supplied base_url is only honoured in that case when
// its host is one already trusted independently of this request — Groq's
// hardcoded default, the operator-configured process default, or whatever is
// already persisted in the vault. Supplying an explicit key is different: the
// caller is testing their OWN credential against their OWN endpoint, so any
// https, non-internal base_url is fine — nothing of the operator's is at risk.
func (v *Vault) LLMTest(key string, baseURL, model *string, defaultModel, defaultBase string) map[string]any {
	v.mu.Lock()
	k := strings.TrimSpace(key)
	usingStoredKey := k == ""
	if usingStoredKey {
		k = v.groq
	}
	base := v.llmBase
	baseSupplied := baseURL != nil && strings.TrimSpace(*baseURL) != ""
	if baseSupplied {
		base = strings.TrimSpace(*baseURL)
	}
	allowedHosts := map[string]bool{llmHost(defaultGroqBase): true}
	if h := llmHost(v.llmBase); h != "" {
		allowedHosts[h] = true
	}
	if h := llmHost(defaultBase); h != "" {
		allowedHosts[h] = true
	}
	mdl := ""
	if model != nil {
		mdl = *model
	}
	if mdl == "" {
		mdl = v.llmModel
	}
	if mdl == "" {
		mdl = defaultModel
	}
	v.mu.Unlock()
	if k == "" {
		return fail("API key required")
	}
	if base == "" {
		base = defaultGroqBase
	}
	// Both checks below only apply to a base_url THIS request supplied — the
	// already-persisted v.llmBase (or the hardcoded Groq default) was set
	// through SetLLM, a separate privileged path, not by whoever is calling
	// llm-test right now, so it is not the caller-controlled SSRF surface
	// this fix closes. An operator who has legitimately pointed the vault at
	// an internal LLM gateway keeps being able to test it with no base_url in
	// the request body; only a base_url this specific call injects is held
	// to the stricter bar.
	if baseSupplied {
		if err := validateLLMBase(base); err != nil {
			return fail(err.Error())
		}
		if usingStoredKey && !allowedHosts[llmHost(base)] {
			return fail("base_url not allowed with the stored credential — supply an explicit key to test a custom endpoint")
		}
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
	if !v.unlocked {
		v.mu.Unlock()
		return fail("locked")
	}
	// snapshot keys+labels to resolve without holding the lock across network I/O
	type slot struct {
		i          int
		key, label string
	}
	var todo []slot
	for i, t := range v.tenants {
		if t.Label == "" || tenantNRe.MatchString(t.Label) {
			todo = append(todo, slot{i, t.Key, t.Label})
		}
	}
	v.mu.Unlock()
	updated := 0
	unverified := 0
	var applied []slot // slots this call rewrote, each holding its PREVIOUS label
	for _, s := range todo {
		nm, err := v.portalLabelForKey(s.key)
		if err != nil {
			// Could not reach the portal for this tenant, so its name is
			// unknown — NOT "the portal has no name for it". Counted separately
			// so a full outage cannot render as the honest "nothing needed
			// renaming" (finding C-F4).
			unverified++
			continue
		}
		if nm != "" && nm != s.label {
			v.mu.Lock()
			if s.i < len(v.tenants) && v.tenants[s.i].Key == s.key {
				v.tenants[s.i].Label = nm
				applied = append(applied, s)
				updated++
			}
			v.mu.Unlock()
		}
	}
	if updated > 0 {
		v.mu.Lock()
		err := v.save()
		if err != nil {
			// Roll back only the labels THIS call wrote. The single-shot
			// mutations use a whole-vault snapshot/restore; that would be wrong
			// here because the lock was released for network I/O, so a snapshot
			// taken before the loop could also undo an unrelated mutation that
			// landed in the meantime.
			for _, s := range applied {
				if s.i < len(v.tenants) && v.tenants[s.i].Key == s.key {
					v.tenants[s.i].Label = s.label
				}
			}
		}
		v.mu.Unlock()
		if err != nil {
			// Previously `_ = v.save()`: the caller was told `updated: N` for
			// labels that never reached disk (finding C-F3).
			return fail(err.Error())
		}
	}
	return map[string]any{"ok": true, "updated": updated, "unverified": unverified}
}

// Status is vault_status (server.py:3040). version, vaultMode, and update come
// from the process (server wires them); the rest is vault state.
func (v *Vault) Status(version string, vaultMode bool, update any) map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	tenants := make([]map[string]any, 0, len(v.tenants))
	for _, t := range v.tenants {
		tenants = append(tenants, map[string]any{"id": t.ID, "label": t.Label})
	}
	var active any
	if v.active != nil {
		active = *v.active
	}
	ready := (!vaultMode) || v.activeKeyLocked() != ""
	return map[string]any{
		"version":   version,
		"vaultMode": vaultMode,
		"exists":    v.Exists(),
		"unlocked":  (!vaultMode) || v.unlocked,
		"ready":     ready,
		"tenants":   tenants,
		"active":    active,
		// Identities explicitly opted in to being written to. Sent so the UI can
		// show the read-only state honestly instead of offering write buttons
		// that will 403 — see writelock.go.
		"writeAllowed": append([]string{}, v.writeAllowed...),
		"hasGroq":      v.groq != "",
		// Whether an Axur key is stored, never the key. Same shape and same
		// reason as hasGroq: Settings needs to offer "Remove" only when there is
		// something to remove, and that is the entire fact it needs. A locked
		// vault reports false here because v.axur is cleared on lock — the UI
		// must not read this as "no key exists", which is why the Settings
		// section is only reachable with the vault open.
		"hasAxur":      v.axur != "",
		"llm": map[string]any{
			"hasKey":   v.groq != "",
			"base_url": v.llmBase,
			"model":    v.llmModel,
		},
		"update": update,
	}
}

// --- small internals kept lock-aware -----------------------------------------

// portalLabelForKeyUnlocked is called while v.mu is already held. The lookup is
// pure network I/O against a passed key, touching no vault state, so it is safe
// to run under the lock (matches Python calling it inside _vault_lock at 2886).
func (v *Vault) portalLabelForKeyUnlocked(key string) (string, error) {
	return v.portalLabelForKey(key)
}

// activeKeyLocked resolves the active tenant key assuming v.mu is held.
func (v *Vault) activeKeyLocked() string {
	if v.active == nil {
		return ""
	}
	for _, t := range v.tenants {
		if t.ID == *v.active {
			return t.Key
		}
	}
	return ""
}
