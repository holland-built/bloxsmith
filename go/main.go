package main

import (
	"bufio"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "0.0.0-poc"

// --- env / .env loader (port of server.py:27-39) -----------------------------

// loadDotEnv parses a simple KEY=VALUE .env file. setdefault semantics: a value
// already present in the real environment wins over the .env file.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		k, v, _ := strings.Cut(line, "=")
		k = strings.TrimSpace(k)
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if _, ok := os.LookupEnv(k); !ok {
			os.Setenv(k, v)
		}
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// --- Infoblox REST proxy (port of _rest_get_ex, server.py:371) ---------------

// restGetEx performs a status-surfacing REST GET against the Infoblox base URL,
// authenticating with INFOBLOX_API_KEY. Returns parsed body + HTTP status
// (status 0 on a network error).
func restGetEx(path string, params map[string]string) (any, int, error) {
	base := strings.TrimRight(env("INFOBLOX_URL", "https://csp.infoblox.com"), "/")
	q := url.Values{}
	for k, v := range params {
		q.Set(k, v)
	}
	u := base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("Authorization", os.Getenv("INFOBLOX_API_KEY"))
	req.Header.Set("Accept", "application/json")
	client := &http.Client{Timeout: 35 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, resp.StatusCode, nil
	}
	var parsed any
	json.Unmarshal(body, &parsed)
	return parsed, resp.StatusCode, nil
}

// normHostHealth shapes raw hosts to {name,status,version,ip,nat_ip,location}.
// Port of _norm_host_health (server.py:3376).
func normHostHealth(raw []any) []map[string]any {
	rows := make([]map[string]any, 0, len(raw))
	str := func(m map[string]any, k string) string {
		if v, ok := m[k].(string); ok {
			return v
		}
		return ""
	}
	for _, item := range raw {
		h, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rows = append(rows, map[string]any{
			"name":     str(h, "display_name"),
			"status":   str(h, "composite_status"),
			"version":  str(h, "host_version"),
			"ip":       str(h, "ip_address"),
			"nat_ip":   str(h, "nat_ip"),
			"location": str(h, "location"),
		})
	}
	return rows
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// hostHealth is the one real proxy endpoint. Port of the /api/csp/host-health
// handler (server.py:5741).
func hostHealth(w http.ResponseWriter, r *http.Request) {
	body, status, err := restGetEx("/api/infra/v1/detail_hosts", map[string]string{
		"_limit":  "500",
		"_fields": "display_name,composite_status,host_version,ip_address,nat_ip,location",
	})
	if err != nil || status == 0 || status >= 400 {
		writeJSON(w, map[string]any{"rows": []any{}, "count": 0, "status": "error"})
		return
	}
	var raw []any
	switch b := body.(type) {
	case map[string]any:
		if v, ok := b["results"].([]any); ok {
			raw = v
		} else if v, ok := b["result"].([]any); ok {
			raw = v
		}
	case []any:
		raw = b
	}
	rows := normHostHealth(raw)
	st := "ok"
	if len(rows) == 0 {
		st = "empty"
	}
	writeJSON(w, map[string]any{"rows": rows, "count": len(rows), "status": st})
}

// --- static (embedded frontend) ----------------------------------------------

func staticHandler() http.Handler {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// index.html must never cache (mirror server.py:6518); other assets no-cache too.
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		fileServer.ServeHTTP(w, r)
	})
}

func main() {
	// CLI: `bloxsmith --version`, `bloxsmith update <url>`.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version", "-v":
			println("bloxsmith", version)
			return
		case "update":
			if len(os.Args) < 3 {
				log.Fatal("usage: bloxsmith update <binary-url>")
			}
			if err := applyUpdate(os.Args[2]); err != nil {
				log.Fatal(err)
			}
			println("updated")
			return
		}
	}

	// Load the main repo's .env if present, then any local .env.
	loadDotEnv("/Users/sholland/AI/Infoblox MCP/.env")
	loadDotEnv(".env")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/csp/host-health", hostHealth)
	mux.HandleFunc("GET /api/update/check", func(w http.ResponseWriter, r *http.Request) {
		st, err := checkUpdate()
		if err != nil {
			log.Printf("update check: %v", err)
		}
		writeJSON(w, st)
	})
	mux.Handle("/", staticHandler())

	port := env("PORT", "8080")
	log.Printf("bloxsmith %s serving on http://localhost:%s", version, port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
