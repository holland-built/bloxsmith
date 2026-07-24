package server

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// registerBrandRoutes wires the brand/logo endpoints (server.py GET 5009/5045,
// POST 6018): GET /api/logo (vault logo, else a CDN passthrough), GET /api/brand
// (the saved brand.json, else {}), POST /api/brand (persist brand + cache the
// logo). All three sit ABOVE the vault gate (registry/meta, no tenant data).
func (d *Deps) registerBrandRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/logo", d.logo)
	mux.HandleFunc("GET /api/brand", d.brandGet)
	mux.HandleFunc("POST /api/brand", d.body(d.brandPost))
}

var brandSanitize = regexp.MustCompile(`[^a-zA-Z0-9.\-]`)

// brandHTTP is the outbound client for CDN logo fetches (separate from the
// Infoblox REST proxy; short timeouts mirror Python's urlopen timeouts).
var brandHTTP = &http.Client{Timeout: 8 * time.Second}

func (d *Deps) logoFile() string  { return filepath.Join(d.StateDir, "logo.png") }
func (d *Deps) brandFile() string { return filepath.Join(d.StateDir, "brand.json") }

// logo is GET /api/logo (server.py:5009): serve the vault logo if present, else
// try the CDN sources for ?domain=, else 404.
func (d *Deps) logo(w http.ResponseWriter, r *http.Request) {
	if data, err := os.ReadFile(d.logoFile()); err == nil {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public,max-age=3600")
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(200)
		_, _ = w.Write(data)
		return
	}
	domain := brandSanitize.ReplaceAllString(r.URL.Query().Get("domain"), "")
	if domain == "" {
		w.WriteHeader(404)
		return
	}
	tried := []string{
		"https://icons.duckduckgo.com/ip3/" + domain + ".ico",
		"https://logo.clearbit.com/" + domain,
	}
	for _, logoURL := range tried {
		req, err := http.NewRequestWithContext(r.Context(), "GET", logoURL, nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", "Mozilla/5.0")
		req.Header.Set("Accept", "image/*")
		resp, err := brandHTTP.Do(req)
		if err != nil {
			continue
		}
		data, _ := io.ReadAll(resp.Body)
		ct := resp.Header.Get("Content-Type")
		resp.Body.Close()
		if len(data) < 50 {
			continue
		}
		if ct == "" {
			ct = "image/png"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(200)
		_, _ = w.Write(data)
		return
	}
	w.WriteHeader(404)
}

// brandGet is GET /api/brand (server.py:5045): the saved brand.json, else {}.
func (d *Deps) brandGet(w http.ResponseWriter, r *http.Request) {
	b, err := os.ReadFile(d.brandFile())
	if err != nil {
		d.json(w, r, 200, map[string]any{})
		return
	}
	var v any
	if json.Unmarshal(b, &v) != nil {
		d.json(w, r, 200, map[string]any{})
		return
	}
	d.json(w, r, 200, v)
}

// brandPost is POST /api/brand (server.py:6018): persist {domain,name} and,
// best-effort, cache the logo from the Brandfetch CDN (failure is non-fatal).
func (d *Deps) brandPost(w http.ResponseWriter, r *http.Request, b map[string]any) {
	// CSRF gate: this route sits ABOVE the vault gate and isn't in the central
	// mutating-path set, so the chassis write-guard never runs for it. Without
	// this, a cross-origin page could drive the brand.json write + the outbound
	// cdn.brandfetch.io fetch. Require a same-origin caller (mirrors _same_origin)
	// and a JSON content type — the latter forces a CORS preflight that the
	// same-origin gate then blocks, closing the simple-form-POST vector.
	if !d.Guard.SameOrigin(r) ||
		!strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		d.json(w, r, 403, map[string]any{"ok": false, "error": "forbidden — write not authorized"})
		return
	}
	domain := brandSanitize.ReplaceAllString(str(b, "domain"), "")
	if len(domain) > 253 {
		domain = domain[:253]
	}
	name := str(b, "name")
	if len(name) > 120 {
		name = name[:120]
	}
	blob, _ := json.Marshal(map[string]any{"domain": domain, "name": name})
	if err := os.WriteFile(d.brandFile(), blob, 0o644); err != nil {
		d.logExc("/api/brand", err)
		d.json(w, r, 500, map[string]any{"ok": false, "error": "internal error"})
		return
	}
	if domain != "" {
		if req, err := http.NewRequestWithContext(r.Context(), "GET",
			"https://cdn.brandfetch.io/"+domain+"/w/128/h/128", nil); err == nil {
			req.Header.Set("User-Agent", "Mozilla/5.0")
			if resp, err := brandHTTP.Do(req); err == nil {
				data, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				_ = os.WriteFile(d.logoFile(), data, 0o644)
			}
		}
	}
	d.json(w, r, 200, map[string]any{"ok": true})
}
