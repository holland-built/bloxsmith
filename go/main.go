package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"bloxsmith/internal/account"
	"bloxsmith/internal/ai"
	"bloxsmith/internal/audit"
	"bloxsmith/internal/cache"
	"bloxsmith/internal/config"
	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/edit"
	"bloxsmith/internal/httpx"
	"bloxsmith/internal/mcp"
	"bloxsmith/internal/provision"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/server"
	"bloxsmith/internal/store"
	"bloxsmith/internal/vault"
)

// instanceID mirrors server.py:72 _INSTANCE_ID = str(uuid4())[:8]: an 8-char
// id unique per process, changes on restart, pinned into every audit entry.
func instanceID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "00000000"
	}
	return hex.EncodeToString(b)
}

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "0.0.0-poc"

// staticHandler serves the embedded frontend (embed.go webFS). index.html and
// assets both send no-store cache headers (mirror server.py:6509-6512).
func staticHandler() http.Handler {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		fileServer.ServeHTTP(w, r)
	})
}

func main() {
	// CLI: `bloxsmith --version`, `bloxsmith update [--check]`.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version", "-v":
			println("bloxsmith", version)
			return
		case "update":
			// Headless self-update for servers with no button: download the
			// newest release archive, verify its checksum, swap this binary and
			// re-exec. `--check` reports availability without applying. `--help`
			// prints usage.
			checkOnly := false
			for _, a := range os.Args[2:] {
				switch a {
				case "--check":
					checkOnly = true
				case "--help", "-h":
					println("usage: bloxsmith update [--check]")
					println("  downloads the latest GitHub release, verifies its checksum,")
					println("  swaps this binary in place and restarts. --check only reports.")
					return
				}
			}
			os.Exit(runUpdateCLI(checkOnly))
		case "service":
			// `bloxsmith service install|uninstall|start|stop|status` — run as a
			// native background service (launchd / systemd / Windows SCM).
			os.Exit(runServiceCLI(os.Args[2:]))
		case "--help", "-h", "help":
			printUsage()
			return
		}
	}

	// Foreground: the interactive path keeps the shell's environment, so the
	// developer .env files still apply. Precedence is first-wins (setdefault),
	// with the real environment always ahead of every file.
	loadForegroundEnv()

	srv, ln, cfg, err := buildServer()
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("bloxsmith %s serving on http://localhost:%s", version, cfg.Port)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// printUsage prints the top-level command summary for `bloxsmith --help`.
func printUsage() {
	println("usage: bloxsmith [command]")
	println("  (no command)              start the server (foreground) on http://localhost:$PORT")
	println("  update [--check]          download+verify+swap the latest release, then restart")
	println("  service <cmd>             install|uninstall|start|stop|restart|status  (run at login)")
	println("  --version, -v             print version")
	println("  --help, -h, help          this help")
}

// loadForegroundEnv loads the .env files that only make sense with a real cwd
// and a real user session: the developer's source repo, the current directory,
// and finally the shared config dir the service also reads.
func loadForegroundEnv() {
	config.LoadDotEnv("/Users/sholland/AI/Infoblox MCP/.env")
	config.LoadDotEnv(".env")
	config.LoadServiceEnv()
}

// buildServer wires the whole application and returns a graceful *http.Server
// bound to a listener, ready to Serve. Both the foreground path (main) and the
// service path (service.go program.Start) call this, so there is exactly one
// place where the app is assembled. Environment loading happens BEFORE this is
// called and differs per path — that is the only difference between the two.
func buildServer() (*http.Server, net.Listener, *config.Config, error) {
	// Binary's own directory — vault fallback + templates default.
	dir := "."
	if exe, err := os.Executable(); err == nil {
		dir = filepath.Dir(exe)
	}
	cfg := config.Load(dir)

	// Vault (Phase 1a) + auto-unlock from env (server.py:6538-6553).
	v := vault.New(vault.ResolveFile(cfg.VaultDir, dir))
	v.BaseURL = cfg.BaseURL
	if pass := vault.PassphraseFromEnv(cfg.VaultPassphrase, cfg.VaultPassphraseFile); pass != "" {
		if _, err := v.AutoUnlock(pass); err != nil {
			log.Printf("vault auto-unlock: %v", err)
		}
	}

	// Single mutable auth slot: active tenant key, else env API_KEY.
	auth := rest.NewAuth(cfg.APIKey, v.ActiveKey)
	restClient := rest.New(cfg.BaseURL, auth)

	// Phase 1d read path: shared TTL cache + the dashboard/hub fetchers on the
	// same rest proxy. The MCP client is built for the later search (1e) / AI
	// (1h) phases; /api/data itself uses REST (the parquet path is broken).
	sharedCache := cache.New()
	dash := dashboard.New(restClient, sharedCache)
	// The MCP client backs the Phase 1h AI tool loop (dashboard.RunAITool);
	// /api/data itself uses REST (the parquet path is broken).
	dash.Mcp = mcp.New(cfg.MCPURL, auth.Value)

	// Phase 1c local state stores, on the same dir as vault.json (server.py:2424
	// _STATE_DIR = dirname(VAULT_FILE)), so they share the mounted volume.
	stateDir := filepath.Dir(v.Path())
	auditLog := audit.New(filepath.Join(stateDir, "audit_log.jsonl"), "app-v"+version, instanceID())
	st := store.New(stateDir)

	guard := &httpx.Guard{
		Token:         cfg.DashboardToken,
		Port:          cfg.Port,
		MutatingPaths: httpx.DefaultMutatingPaths(),
		// _write_guard AUDIT HOOK (server.py:4968): every authorized mutation
		// appends a "write-authorized" entry to the hash chain.
		Audit: func(event, actor, method, path string) {
			_, _ = auditLog.Append(event, actor, map[string]any{"method": method, "path": path})
		},
	}

	handler := server.New(&server.Deps{
		Cfg:            cfg,
		Vault:          v,
		Rest:           restClient,
		Auth:           auth,
		Guard:          guard,
		Audit:          auditLog,
		Store:          st,
		Cache:          sharedCache,
		Dashboard:      dash,
		StateDir:       stateDir,
		Edit:           edit.New(restClient),
		Provision:      provision.New(restClient, cfg.TemplatesDir),
		AI:             ai.New(llmCreds{cfg: cfg, v: v}, dash),
		Account:        account.New(cfg.BaseURL, cfg.APIKey, auth, sharedCache),
		Version:        version,
		Static:         staticHandler(),
		UpdateCheck:    updateCheckHandler,
		UpdateApply:    applyUpdateHandler,
		UpdateProgress: updateProgressHandler,
		UpdateStatus: func() any {
			// Lightweight, non-blocking update object embedded in /api/vault/status
			// (Python embeds update_status(); the network refresh happens on the
			// dedicated /api/update/check route).
			return map[string]any{
				"current":       version,
				"latest":        "",
				"available":     false,
				"url":           "",
				"checkDisabled": cfg.UpdateCheckDisabled,
				"selfUpdate":    true,
			}
		},
	})

	// A graceful *http.Server (not http.ListenAndServe) so the self-updater can
	// Shutdown() the listener and hand the port to its successor cleanly.
	srv := &http.Server{Handler: handler}
	shutdownServer = srv.Shutdown
	ln, err := listenWithRetry(":"+cfg.Port, 5*time.Second)
	if err != nil {
		return nil, nil, nil, err
	}
	return srv, ln, cfg, nil
}

// listenWithRetry binds addr, retrying briefly if the port is momentarily still
// held by a predecessor mid-handoff (self-update restart). Any bind error is
// retried until the deadline, so the successor grabs the socket the instant the
// old process releases it instead of dying on EADDRINUSE.
func listenWithRetry(addr string, within time.Duration) (net.Listener, error) {
	deadline := time.Now().Add(within)
	for {
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return ln, nil
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// llmCreds resolves the LLM api-key/base/model live, with the vault-over-env
// precedence server.py applies on unlock (server.py:2790-2792): a value set in
// the vault overrides the env-derived default.
type llmCreds struct {
	cfg *config.Config
	v   *vault.Vault
}

func (c llmCreds) LLM() (key, base, model string) {
	key, base, model = c.cfg.LLMAPIKey, c.cfg.LLMBaseURL, c.cfg.LLMModel
	if c.v != nil {
		// Read the mutable vault LLM state through the lock-guarded accessor —
		// never the raw fields — so a concurrent unlock/lock/set can't race us.
		g, b, m := c.v.LLMCreds()
		if g != "" {
			key = g
		}
		if b != "" {
			base = b
		}
		if m != "" {
			model = m
		}
	}
	return
}

// updateCheckHandler is the real /api/update/check (Phase 0): reaches GitHub.
func updateCheckHandler(w http.ResponseWriter, r *http.Request) {
	st, err := checkUpdate()
	if err != nil {
		log.Printf("update check: %v", err)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(st)
}
