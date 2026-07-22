// Package config ports Bloxsmith's env/.env configuration surface from
// server.py (lines 26-160, 2404-2416, 2756-2766). It loads the same env vars,
// with the same precedence and defaults, so the Go binary and the Python app
// read identical configuration.
package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// LoadDotEnv parses a simple KEY=VALUE .env file (port of server.py:27-39).
// setdefault semantics: a value already present in the real environment wins
// over the .env file. Matching surrounding quotes are stripped so a value like
// INFOBLOX_API_KEY="Token x" does not keep literal quotes.
func LoadDotEnv(path string) {
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
		v = strings.TrimSpace(v)
		if len(v) >= 2 && v[0] == v[len(v)-1] && (v[0] == '\'' || v[0] == '"') {
			v = v[1 : len(v)-1]
		}
		if _, ok := os.LookupEnv(k); !ok {
			_ = os.Setenv(k, v)
		}
	}
}

// UserDir is the per-OS application config directory Bloxsmith owns:
//
//	macOS   ~/Library/Application Support/bloxsmith
//	Linux   ~/.config/bloxsmith   (or $XDG_CONFIG_HOME/bloxsmith)
//	Windows %AppData%\bloxsmith
//
// This is the same convention vault.ResolveFile already falls back to, so the
// service's config and its vault.json land in one directory. It is the ONLY
// config source a background service can rely on: launchd/systemd/SCM start the
// process with a near-empty environment, so a key exported in the user's shell
// or a .env sourced in Terminal is simply not there.
func UserDir() string {
	ucd, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(ucd, "bloxsmith")
}

// EnvFile is the .env the service reads inside UserDir.
func EnvFile() string {
	d := UserDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, ".env")
}

// LoadServiceEnv loads ONLY <UserDir>/.env. Used on the service code path: a
// service has no shell environment and no meaningful working directory, so the
// stable config-dir file is the single source of truth. Real environment
// variables still win (LoadDotEnv is setdefault), which is what lets a systemd
// unit or container override individual values.
func LoadServiceEnv() {
	if f := EnvFile(); f != "" {
		LoadDotEnv(f)
	}
}

// Config mirrors the module-level config constants server.py computes at import
// (server.py:41-160). Field comments cite the Python source of truth.
type Config struct {
	APIKey    string // INFOBLOX_API_KEY (server.py:41)
	VaultMode bool   // not APIKey (server.py:46)
	BaseURL   string // INFOBLOX_URL (server.py:47)
	MCPURL    string // BASE_URL + "/mcp" (server.py:48)
	Port      string // PORT, default 8080 (server.py:50)
	Host      string // HOST, default "localhost" (server.py:51)

	AppRepo             string // APP_REPO (server.py:68)
	UpdateCheckDisabled bool   // DISABLE_UPDATE_CHECK (server.py:69)

	DashboardToken string // DASHBOARD_TOKEN (server.py:141)
	BlockListID    string // BLOCK_LIST_ID (server.py:153)

	GroqAPIKey string // GROQ_API_KEY (server.py:154)
	LLMAPIKey  string // LLM_API_KEY or GROQ_API_KEY (server.py:157)
	LLMModel   string // LLM_MODEL or "llama-3.3-70b-versatile" (qwen3-32b decommissioned by Groq 2026-07)
	LLMBaseURL string // LLM_BASE_URL (server.py:159)

	VaultDir            string // VAULT_DIR, default "/vault" (server.py:2405)
	VaultPassphrase     string // VAULT_PASSPHRASE (server.py:2766)
	VaultPassphraseFile string // VAULT_PASSPHRASE_FILE (server.py:2759)
	TemplatesDir        string // TEMPLATES_DIR (server.py:1017)

	// Dir is the binary's own directory (analogue of server.py DIR at 160),
	// used as the vault fallback location when VAULT_DIR is not writable.
	Dir string
}

// or returns v when non-empty, else def — matches Python's `x or default`,
// which (unlike os.environ.get default) also treats an empty string as unset.
func or(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// getDefault returns the env value if the var is set (even when empty), else
// def — matches Python's os.environ.get(k, def).
func getDefault(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

// Load reads the full config from the process environment, applying the exact
// precedence server.py uses. dir is the binary's directory.
func Load(dir string) *Config {
	c := &Config{Dir: dir}
	c.APIKey = os.Getenv("INFOBLOX_API_KEY")
	c.VaultMode = c.APIKey == ""
	c.BaseURL = or("INFOBLOX_URL", "https://csp.infoblox.com")
	c.MCPURL = c.BaseURL + "/mcp"
	c.Port = or("PORT", "8080")
	c.Host = or("HOST", "localhost")

	c.AppRepo = or("APP_REPO", "holland-built/bloxsmith")
	c.UpdateCheckDisabled = os.Getenv("DISABLE_UPDATE_CHECK") != ""

	c.DashboardToken = os.Getenv("DASHBOARD_TOKEN")
	c.BlockListID = os.Getenv("BLOCK_LIST_ID")

	c.GroqAPIKey = os.Getenv("GROQ_API_KEY")
	// LLM_API_KEY falls back to GROQ_API_KEY (server.py:157) — `or`, not default:
	// an empty env var must still fall back.
	c.LLMAPIKey = c.GroqAPIKey
	if v := os.Getenv("LLM_API_KEY"); v != "" {
		c.LLMAPIKey = v
	}
	// Default was qwen/qwen3-32b until Groq decommissioned it (404 model_not_found,
	// 2026-07) — every /api/query returned "AI error: request failed".
	c.LLMModel = or("LLM_MODEL", "llama-3.3-70b-versatile")
	c.LLMBaseURL = os.Getenv("LLM_BASE_URL")

	c.VaultDir = getDefault("VAULT_DIR", "/vault")
	c.VaultPassphrase = os.Getenv("VAULT_PASSPHRASE")
	c.VaultPassphraseFile = strings.TrimSpace(os.Getenv("VAULT_PASSPHRASE_FILE"))
	c.TemplatesDir = getDefault("TEMPLATES_DIR", filepath.Join(dir, "templates"))
	return c
}
