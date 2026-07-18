// Package server is the HTTP route chassis (server.py do_GET 5006 / do_POST
// 6004 / do_OPTIONS 5002). It mirrors how the Python handler matches paths and
// validates POST bodies, but on a Go http.ServeMux with a single write-guard +
// OPTIONS wrapper. Phase 1b wires host-health, vault status, update check, and
// the 14 /api/vault/* routes; later sub-phases register more routes on the same
// mux.
package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"

	"bloxsmith/internal/audit"
	"bloxsmith/internal/cache"
	"bloxsmith/internal/config"
	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/store"
	"bloxsmith/internal/vault"
)

// maxBody is server.py's MAX_BODY (6002): 64 KB.
const maxBody = 64 * 1024

// Deps are everything the router wires. main.go builds these once.
type Deps struct {
	Cfg          *config.Config
	Vault        *vault.Vault
	Rest         *rest.Client
	Auth         *rest.Auth
	Guard        *httpx.Guard
	Audit        *audit.Log         // hash-chained action log (Phase 1c)
	Store        *store.Store       // views + snooze + first-seen (Phase 1c)
	Cache        *cache.Cache       // shared TTL cache (Phase 1d)
	Dashboard    *dashboard.Service // /api/data + hub fetchers (Phase 1d)
	Version      string
	Static       http.Handler
	UpdateCheck  http.HandlerFunc // real /api/update/check (network); from main
	UpdateStatus func() any       // lightweight update obj embedded in vault status
}

// New builds the routed handler: OPTIONS preflight + write-guard wrap the mux,
// exactly as Python runs do_OPTIONS / _write_guard at the top of each verb.
func New(d *Deps) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/vault/status", d.vaultStatus)
	if d.UpdateCheck != nil {
		mux.HandleFunc("GET /api/update/check", d.UpdateCheck)
	}
	d.registerVaultRoutes(mux)
	d.registerStateRoutes(mux)
	d.registerDataRoutes(mux)
	d.registerCSPRoutes(mux)
	mux.Handle("/", d.Static)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			d.Guard.CORSPreflight(w, r)
			return
		}
		if d.Guard.WriteGuard(w, r) {
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (d *Deps) json(w http.ResponseWriter, r *http.Request, status int, data any) {
	httpx.WriteJSON(w, r, status, d.Cfg.Port, data)
}

// logExc is _log_exc (server.py:4878): log a handler failure with its route
// label without leaking the detail to the client.
func (d *Deps) logExc(label string, rec any) {
	log.Printf("[error] %s: %v", label, rec)
}

// --- vault status ------------------------------------------------------------

func (d *Deps) vaultStatus(w http.ResponseWriter, r *http.Request) {
	var upd any
	if d.UpdateStatus != nil {
		upd = d.UpdateStatus()
	}
	d.json(w, r, http.StatusOK, d.Vault.Status(d.Version, d.Cfg.VaultMode, upd))
}

// --- the 14 /api/vault/* POST routes -----------------------------------------

func (d *Deps) registerVaultRoutes(mux *http.ServeMux) {
	// 1. init
	mux.HandleFunc("POST /api/vault/init", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		d.json(w, r, 200, d.Vault.InitR(str(b, "passphrase")))
	}))
	// 2. unlock — 200 ok / 401
	mux.HandleFunc("POST /api/vault/unlock", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		res := d.Vault.UnlockR(str(b, "passphrase"))
		d.json(w, r, code(res, 401), res)
	}))
	// 3. tenant (add) — 200 / 400
	mux.HandleFunc("POST /api/vault/tenant", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		res := d.Vault.AddTenant(str(b, "label"), str(b, "key"), optStr(b, "groq"))
		d.json(w, r, code(res, 400), res)
	}))
	// 4. tenant-remove — 200 / 400
	mux.HandleFunc("POST /api/vault/tenant-remove", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		res := d.Vault.RemoveTenant(str(b, "id"))
		d.json(w, r, code(res, 400), res)
	}))
	// 5. tenant-update — 200 / 400
	mux.HandleFunc("POST /api/vault/tenant-update", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		res := d.Vault.UpdateTenant(str(b, "id"), str(b, "key"), optStr(b, "label"))
		d.json(w, r, code(res, 400), res)
	}))
	// 6. active — 200 / 400
	mux.HandleFunc("POST /api/vault/active", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		res := d.Vault.SetActive(str(b, "id"))
		d.json(w, r, code(res, 400), res)
	}))
	// 7. groq — set LLM key only
	mux.HandleFunc("POST /api/vault/groq", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		d.json(w, r, 200, d.Vault.SetLLM(str(b, "key"), nil, nil))
	}))
	// 8. llm — key + base_url + model
	mux.HandleFunc("POST /api/vault/llm", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		d.json(w, r, 200, d.Vault.SetLLM(str(b, "key"), optStr(b, "base_url"), optStr(b, "model")))
	}))
	// 9. test-key
	mux.HandleFunc("POST /api/vault/test-key", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		d.json(w, r, 200, d.Vault.TestKey(str(b, "key")))
	}))
	// 10. conn-test
	mux.HandleFunc("POST /api/vault/conn-test", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		d.json(w, r, 200, d.Vault.ConnTest(d.Auth.Value()))
	}))
	// 11. llm-test
	mux.HandleFunc("POST /api/vault/llm-test", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		d.json(w, r, 200, d.Vault.LLMTest(str(b, "key"), optStr(b, "base_url"), optStr(b, "model"), d.Cfg.LLMModel))
	}))
	// 12. refresh-names
	mux.HandleFunc("POST /api/vault/refresh-names", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		d.json(w, r, 200, d.Vault.RefreshNames())
	}))
	// 13. lock — auth-gated (401), then 200
	mux.HandleFunc("POST /api/vault/lock", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		if !d.lockAuthorized(r) {
			d.json(w, r, 401, map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		d.json(w, r, 200, d.Vault.LockR())
	}))
	// 14. reset — auth-gated (401), then 200
	mux.HandleFunc("POST /api/vault/reset", d.body(func(w http.ResponseWriter, r *http.Request, b map[string]any) {
		if !d.lockAuthorized(r) {
			d.json(w, r, 401, map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		d.json(w, r, 200, d.Vault.ResetR())
	}))
}

// lockAuthorized mirrors the lock/reset gate (server.py:6061/6068): an active
// applied key OR a valid DASHBOARD_TOKEN authorizes the destructive op.
func (d *Deps) lockAuthorized(r *http.Request) bool {
	return d.Auth.Value() != "" || d.Guard.Authed(r)
}

// --- POST body handling (server.py:6005-6015) --------------------------------

// body wraps a POST handler with Content-Length validation, the 64 KB cap, and
// JSON parsing — mirroring do_POST's preamble. An empty body parses to {}.
func (d *Deps) body(fn func(http.ResponseWriter, *http.Request, map[string]any)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > maxBody {
			http.Error(w, "Request Too Large", http.StatusRequestEntityTooLarge)
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
		if err != nil {
			d.json(w, r, 400, map[string]any{"error": "invalid Content-Length"})
			return
		}
		if len(raw) > maxBody {
			http.Error(w, "Request Too Large", http.StatusRequestEntityTooLarge)
			return
		}
		b := map[string]any{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &b); err != nil {
				d.json(w, r, 400, map[string]any{"error": "invalid JSON body"})
				return
			}
		}
		fn(w, r, b)
	}
}

// str coerces body[k] to a string (Python str(body.get(k, ""))).
func str(b map[string]any, k string) string {
	switch v := b[k].(type) {
	case string:
		return v
	case nil:
		return ""
	default:
		if raw, err := json.Marshal(v); err == nil {
			return string(raw)
		}
		return ""
	}
}

// optStr returns a *string when the key is present and non-null, else nil —
// mirrors Python passing body.get(k) (None when absent) into an optional arg.
func optStr(b map[string]any, k string) *string {
	v, ok := b[k]
	if !ok || v == nil {
		return nil
	}
	s := str(b, k)
	return &s
}

// code returns 200 when the result is ok, else the given failure status —
// mirrors `self._json(r, 200 if r.get("ok") else <fail>)`.
func code(res map[string]any, fail int) int {
	if ok, _ := res["ok"].(bool); ok {
		return 200
	}
	return fail
}
