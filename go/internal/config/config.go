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
			recordOrigin(k, path)
		}
	}
}

// WHERE A SETTING CAME FROM, not just what it is.
//
// Several .env files are loaded in first-wins order — the binary's directory, the
// current directory, and the service config dir — and the value that wins is then
// indistinguishable from any other. That produced a real, confusing defect:
//
//	bloxsmith vault-passphrase status --vault /some/other/vault.json
//
// run from a directory whose own .env sets VAULT_PASSPHRASE reported "at next
// start the passphrase would come from: VAULT_PASSPHRASE" — describing THIS
// shell's environment while naming a DIFFERENT vault, whose server would never
// read that file. It is the same family as the v3.30.1 bug: a status command
// answering a question about one thing with a fact about another.
//
// Not fixed by reading fewer files — that is what v3.30.1 was fixing when it made
// the loading unconditional, and skipping them reintroduces the opposite bug (an
// env passphrase looking absent). Fixed by saying which file, so a mismatch is
// visible instead of silent.
//
// Only the ORIGIN is recorded, never the value: this map is printed.
var envOrigin = map[string]string{}

func recordOrigin(key, path string) {
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	envOrigin[key] = path
}

// OriginOf reports the .env file a setting was loaded from, or "" when it did not
// come from a file — which means either the real process environment or nothing at
// all. Those two are different and the caller must not conflate them: check
// os.LookupEnv to tell "set in the real environment" from "unset".
func OriginOf(key string) string { return envOrigin[key] }

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

	// AllowedHosts is ALLOWED_HOSTS (comma-separated): extra Host header values
	// this deployment legitimately answers to, on top of the loopback names and
	// the bind host. Feeds httpx.Guard's DNS-rebinding gate. Required to re-arm
	// that gate on a wildcard (0.0.0.0) bind, where the real names are unknown.
	AllowedHosts []string

	// TrustedProxies is TRUSTED_PROXIES (comma-separated IPs and/or CIDR
	// ranges): the front ends whose X-Forwarded-For this process will believe.
	// Empty — the default — means the header is ignored entirely and every
	// per-client decision uses the peer address, which is the behaviour before
	// this setting existed. It is read only by the unlock throttle; the entries
	// are validated by httpx.ParseTrustedProxies, which returns a warning for
	// anything unparseable, because an ignored typo silently reverts a
	// proxied deployment to a single shared rate-limit bucket.
	TrustedProxies []string

	// NO AppRepo FIELD. server.py:68 read APP_REPO, but the Go updater targets
	// a compile-time const (update.go's appRepo) because the release assets,
	// the signing identity and the version-file URL are all built for one
	// repo. A field here read APP_REPO and nothing ever consulted it, which is
	// worse than not offering it: an operator could set it and watch the
	// updater keep checking somewhere else.
	UpdateCheckDisabled bool // DISABLE_UPDATE_CHECK (server.py:69)

	DashboardToken string // DASHBOARD_TOKEN (server.py:141)
	BlockListID    string // BLOCK_LIST_ID (server.py:153)

	// AxurAPIKey is AXUR_API_KEY: the Authorization header value for Axur's
	// Platform API, held whole, the same way APIKey holds "Token x" rather than
	// a bare token. Empty means the integration is not configured, and the Axur
	// panel is absent rather than broken.
	//
	// Unlike INFOBLOX_API_KEY this value is normalized by axurAuth below: a
	// value with no scheme word gets "Bearer " prepended. Axur's own material
	// presents the credential as a bare token in some places and as a whole
	// header in others, so a paste of either shape has to work. Without that,
	// the wrong one produces a 401 that reads as "your key is invalid" when the
	// key is fine and only the header was malformed.
	AxurAPIKey string // AXUR_API_KEY
	// AxurBaseURL is AXUR_BASE_URL, defaulting to the production gateway. It
	// exists so a test double, a regional endpoint, or an outbound proxy can be
	// pointed at without a rebuild — the same reason INFOBLOX_URL exists.
	AxurBaseURL string // AXUR_BASE_URL

	LLMAPIKey  string // LLM_API_KEY or GROQ_API_KEY (server.py:157)
	LLMModel   string // LLM_MODEL or "qwen/qwen3.6-27b" (see the decommission note at the default)
	LLMBaseURL string // LLM_BASE_URL (server.py:159)

	VaultDir            string // VAULT_DIR, default "/vault" (server.py:2405)
	VaultPassphrase     string // VAULT_PASSPHRASE (server.py:2766)
	VaultPassphraseFile string // VAULT_PASSPHRASE_FILE (server.py:2759)
	TemplatesDir        string // TEMPLATES_DIR (server.py:1017)

	// The audit chain's trust root. AuditTrustDir holds the HMAC key and the
	// sealed head record, and must NOT be the state directory that holds
	// audit_log.jsonl — a key an attacker can rewrite alongside the log
	// protects nothing. Empty means audit.DefaultTrustDir() (the per-user
	// config directory). AuditKey / AuditKeyFile override the machine-local
	// key with one the host itself need not hold. See internal/audit/key.go.
	AuditTrustDir string // AUDIT_TRUST_DIR
	AuditKey      string // AUDIT_KEY (hex, >= 64 chars)
	AuditKeyFile  string // AUDIT_KEY_FILE

	// Dir is the binary's own directory (analogue of server.py DIR at 160),
	// used as the vault fallback location when VAULT_DIR is not writable.
	Dir string
}

// AxurDefaultBaseURL is the production Axur Platform API gateway, from the
// `servers` block of Axur's OpenAPI document (openapi-axur.yaml v1.0.81). Every
// documented path — /tickets-api/..., /assets-api/... — is appended to it whole,
// so the gateway prefix belongs in the base and never in the request path.
const AxurDefaultBaseURL = "https://api.axur.com/gateway/1.0/api"

// AxurAuth normalizes an Axur credential into a complete Authorization header
// value. Exported because it has TWO callers now — this package for
// AXUR_API_KEY, and main.go for the copy stored in the vault — and the whole
// point is that both sources obey one rule. A second, hand-copied rule beside
// this one is how "it works from the environment but not from Settings" gets
// built.
//
// An empty or blank value stays empty, which is what switches the integration
// off. A value that already carries a scheme word ("Bearer x", and any other
// scheme, so a future token type is not silently rewritten) is passed through
// untouched. A bare token — no whitespace — gets "Bearer " prepended.
//
// The whitespace test is the whole rule: an Authorization header is
// "<scheme> <credentials>", so a value with no space cannot already be one.
// This deliberately does NOT verify that the scheme is Bearer specifically;
// rejecting an unexpected scheme here would turn a working credential into a
// silently disabled panel.
func AxurAuth(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	if strings.ContainsAny(v, " \t") {
		return v
	}
	return "Bearer " + v
}

// or returns v when non-empty, else def — matches Python's `x or default`,
// which (unlike os.environ.get default) also treats an empty string as unset.
func or(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// splitList parses a comma-separated env list, dropping blanks. Returns nil for
// an unset/empty var so callers can test len()==0 for "not configured".
func splitList(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
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
	c.AllowedHosts = splitList(os.Getenv("ALLOWED_HOSTS"))
	c.TrustedProxies = splitList(os.Getenv("TRUSTED_PROXIES"))

	c.UpdateCheckDisabled = os.Getenv("DISABLE_UPDATE_CHECK") != ""

	c.DashboardToken = os.Getenv("DASHBOARD_TOKEN")
	c.BlockListID = os.Getenv("BLOCK_LIST_ID")

	c.AxurAPIKey = AxurAuth(os.Getenv("AXUR_API_KEY"))
	c.AxurBaseURL = or("AXUR_BASE_URL", AxurDefaultBaseURL)

	// LLM_API_KEY falls back to GROQ_API_KEY (server.py:157) — `or`, not default:
	// an empty env var must still fall back. GROQ_API_KEY is a local, not a
	// field: this is the only place it is consulted, and a second copy on the
	// struct is one more thing that can drift out of step with LLMAPIKey.
	c.LLMAPIKey = os.Getenv("GROQ_API_KEY")
	if v := os.Getenv("LLM_API_KEY"); v != "" {
		c.LLMAPIKey = v
	}
	// THE DEFAULT HAS NOW OUTLIVED TWO GROQ DECOMMISSIONS, so it is worth saying
	// what keeps happening. qwen/qwen3-32b went first (404 model_not_found,
	// 2026-07) and every /api/query returned "AI error: request failed" until
	// the default moved. Its replacement, llama-3.3-70b-versatile, is listed on
	// Groq's deprecation page with a shutdown date of 2026-08-16, and
	// openai/gpt-oss-120b is the replacement that page names.
	//
	// MEASURED, not read off a page. GET /openai/v1/models on 2026-08-24 returns
	// 13 ids and llama-3.3-70b-versatile is not among them, while Groq's own
	// models page still listed it that day. The docs are not the check.
	//
	// Groq names two replacements. openai/gpt-oss-120b was tried first and
	// FAILS AGAINST THIS CODE: asked for the JSON contract in aiSystem, it
	// emits a tool call named "json", and Groq rejects the request 400
	// tool_use_failed, "attempted to call tool 'json' which was not in
	// request.tools". The model answers correctly inside that rejected payload,
	// so the fault is the shape, not the reasoning. Supporting it means
	// declaring a json tool in schema.go and treating a call to it as the final
	// answer.
	//
	// qwen/qwen3.6-27b was then run against the live server on the same
	// question and returned {"answer":"4"} with three suggestions and no error,
	// which is the contract this code already expects. It is the default for
	// that reason and no other.
	c.LLMModel = or("LLM_MODEL", "qwen/qwen3.6-27b")
	c.LLMBaseURL = os.Getenv("LLM_BASE_URL")

	c.VaultDir = getDefault("VAULT_DIR", "/vault")
	c.VaultPassphrase = os.Getenv("VAULT_PASSPHRASE")
	c.VaultPassphraseFile = strings.TrimSpace(os.Getenv("VAULT_PASSPHRASE_FILE"))
	c.TemplatesDir = getDefault("TEMPLATES_DIR", filepath.Join(dir, "templates"))

	c.AuditTrustDir = strings.TrimSpace(os.Getenv("AUDIT_TRUST_DIR"))
	c.AuditKey = strings.TrimSpace(os.Getenv("AUDIT_KEY"))
	c.AuditKeyFile = strings.TrimSpace(os.Getenv("AUDIT_KEY_FILE"))
	return c
}
