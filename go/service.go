package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"bloxsmith/internal/config"

	"github.com/kardianos/service"
)

// This file adds `bloxsmith service install|uninstall|start|stop|restart|status`,
// running the exact same HTTP server main() runs, but supervised by the native
// service manager of each OS via github.com/kardianos/service:
//
//	macOS    launchd LaunchAgent  ~/Library/LaunchAgents/bloxsmith.plist   (no sudo)
//	Linux    systemd unit         /etc/systemd/system (root) or
//	                              ~/.config/systemd/user/bloxsmith.service (user)
//	Windows  Windows Service      registered with the Service Control Manager
//
// THE CONFIG PROBLEM. A background service does not inherit the user's shell:
// launchd, systemd and the Windows SCM all start the process with a nearly empty
// environment and no useful working directory. An INFOBLOX_API_KEY exported in
// Terminal, or a .env sourced there, is simply absent. The fix is a stable,
// documented file the service reads directly — <config.UserDir()>/.env — which
// `service install` seeds from the .env in the current directory if one exists.

const (
	serviceName        = "bloxsmith"
	serviceDisplayName = "Bloxsmith"
	serviceDescription = "Bloxsmith Infoblox NOC dashboard HTTP server"
)

// program implements service.Interface. Start must not block, so Serve runs on
// its own goroutine; Stop shuts the listener down gracefully.
type program struct {
	srv    *http.Server
	logger service.Logger
	port   string
}

func (p *program) Start(s service.Service) error {
	// Service path: config comes ONLY from the config dir (plus any real env the
	// unit itself sets). No cwd .env, no developer repo path — a service has
	// neither a shell nor a meaningful working directory.
	config.LoadServiceEnv()

	srv, ln, cfg, err := buildServer()
	if err != nil {
		return err
	}
	p.srv, p.port = srv, cfg.Port
	_ = p.logger.Infof("bloxsmith %s serving on http://localhost:%s (config: %s)",
		version, cfg.Port, config.EnvFile())

	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			_ = p.logger.Error(err)
		}
	}()
	return nil
}

func (p *program) Stop(s service.Service) error {
	if p.srv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return p.srv.Shutdown(ctx)
}

// newService builds the service definition. Arguments is explicitly
// ["service", "run"] so the supervisor re-enters THIS code path rather than the
// foreground main() path — without it launchd would exec the bare binary and
// never call svc.Run().
func newService() (service.Service, *program, error) {
	// The service manager gives the process no useful cwd, so pin it to the
	// binary's own directory: that is what resolves templates/ and the vault
	// fallback exactly as the foreground run does.
	wd := "."
	if exe, err := os.Executable(); err == nil {
		wd = filepath.Dir(exe)
	}

	cfg := &service.Config{
		Name:             serviceName,
		DisplayName:      serviceDisplayName,
		Description:      serviceDescription,
		Arguments:        []string{"service", "run"},
		WorkingDirectory: wd,
		Option: service.KeyValue{
			// User-level everywhere it is possible: a LaunchAgent on macOS and a
			// systemd --user unit on Linux need no sudo and are trivially
			// reversible. On Linux running as root this is ignored and a normal
			// system unit is installed instead. Windows has no equivalent — it
			// always registers with the SCM — so the flag is left off there.
			"UserService": runtime.GOOS != "windows" && os.Geteuid() != 0,
			"KeepAlive":   true,
			"RunAtLoad":   true,
		},
	}
	// Keep launchd's stdout/stderr logs beside the config instead of letting the
	// default drop bloxsmith.out.log / bloxsmith.err.log into the user's home.
	// (Only launchd uses this; journald and the Windows Event Log capture the
	// service logger directly.)
	if d := config.UserDir(); d != "" {
		if err := os.MkdirAll(d, 0o700); err == nil {
			cfg.Option["LogDirectory"] = d
		}
	}
	prg := &program{}
	s, err := service.New(prg, cfg)
	if err != nil {
		return nil, nil, err
	}
	logger, err := s.Logger(nil)
	if err != nil {
		return nil, nil, err
	}
	prg.logger = logger
	return s, prg, nil
}

func serviceUsage() {
	fmt.Println(`usage: bloxsmith service <command>

  install     register bloxsmith with the OS service manager
  uninstall   remove it
  start       start the installed service
  stop        stop it
  restart     stop then start
  status      running/stopped, plus config path, port and URL

The service does NOT inherit your shell environment. It reads configuration from
  ` + configPathLabel() + `
`)
}

func configPathLabel() string {
	if f := config.EnvFile(); f != "" {
		return f
	}
	return "<user config dir>/bloxsmith/.env"
}

// resolvedPort reports the port the service will use, read the same way the
// service itself reads it (config dir .env, then real env, default 8080).
func resolvedPort() string {
	config.LoadServiceEnv()
	dir := "."
	if exe, err := os.Executable(); err == nil {
		dir = filepath.Dir(exe)
	}
	return config.Load(dir).Port
}

// seedConfig creates the config dir and, if the current directory has a .env but
// the config dir does not, copies it across so an existing key carries over to
// the service. It never overwrites an existing config and never prints secrets.
func seedConfig() (copied bool, err error) {
	dir := config.UserDir()
	if dir == "" {
		return false, fmt.Errorf("cannot determine user config dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false, err
	}
	dst := config.EnvFile()
	if _, err := os.Stat(dst); err == nil {
		return false, nil // already configured — leave it alone
	}
	src, err := os.ReadFile(".env")
	if err != nil {
		return false, nil // nothing to seed from; not an error
	}
	// 0600: this file holds INFOBLOX_API_KEY.
	if err := os.WriteFile(dst, src, 0o600); err != nil {
		return false, err
	}
	return true, nil
}

func runServiceCLI(args []string) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		serviceUsage()
		return 0
	}

	s, _, err := newService()
	if err != nil {
		fmt.Fprintln(os.Stderr, "service:", err)
		return 1
	}

	switch args[0] {
	case "run":
		// Invoked by the service manager itself. Blocks until stopped.
		if err := s.Run(); err != nil {
			fmt.Fprintln(os.Stderr, "service run:", err)
			return 1
		}
		return 0

	case "install":
		copied, err := seedConfig()
		if err != nil {
			fmt.Fprintln(os.Stderr, "config:", err)
			return 1
		}
		if err := s.Install(); err != nil {
			fmt.Fprintln(os.Stderr, "install:", err)
			return 1
		}
		port := resolvedPort()
		fmt.Printf("installed %s (%s)\n", serviceName, service.Platform())
		fmt.Printf("config read from: %s\n", configPathLabel())
		if copied {
			fmt.Println("  seeded from ./.env in this directory")
		} else if _, statErr := os.Stat(config.EnvFile()); statErr != nil {
			fmt.Println("  NOTE: this file does not exist yet — the service has no")
			fmt.Println("  INFOBLOX_API_KEY until you create it. A service does not")
			fmt.Println("  inherit your shell environment.")
		}
		fmt.Printf("port: %s (set PORT in that file to change it)\n", port)
		if port == "8080" {
			fmt.Println("  WARNING: 8080 is also the default for the Docker deployment.")
			fmt.Println("  If that stack is running, set PORT=8090 to avoid a clash.")
		}
		fmt.Println("start it with: bloxsmith service start")
		return 0

	case "uninstall":
		if err := s.Uninstall(); err != nil {
			fmt.Fprintln(os.Stderr, "uninstall:", err)
			return 1
		}
		fmt.Printf("uninstalled %s (config left in place at %s)\n", serviceName, configPathLabel())
		return 0

	case "start":
		if err := s.Start(); err != nil {
			fmt.Fprintln(os.Stderr, "start:", err)
			return 1
		}
		fmt.Printf("started %s on http://localhost:%s\n", serviceName, resolvedPort())
		return 0

	case "stop":
		if err := s.Stop(); err != nil {
			fmt.Fprintln(os.Stderr, "stop:", err)
			return 1
		}
		fmt.Println("stopped", serviceName)
		return 0

	case "restart":
		if err := s.Restart(); err != nil {
			fmt.Fprintln(os.Stderr, "restart:", err)
			return 1
		}
		fmt.Println("restarted", serviceName)
		return 0

	case "status":
		st, err := s.Status()
		port := resolvedPort()
		label := "unknown"
		switch {
		case err == service.ErrNotInstalled:
			label = "not installed"
		case err != nil:
			label = "unknown (" + err.Error() + ")"
		case st == service.StatusRunning:
			label = "running"
		case st == service.StatusStopped:
			label = "stopped"
		}
		fmt.Printf("service:  %s (%s)\n", label, service.Platform())
		fmt.Printf("config:   %s\n", configPathLabel())
		fmt.Printf("port:     %s\n", port)
		fmt.Printf("url:      http://localhost:%s\n", port)
		if err != nil && err != service.ErrNotInstalled {
			return 1
		}
		return 0

	default:
		fmt.Fprintf(os.Stderr, "unknown service command %q\n\n", args[0])
		serviceUsage()
		return 2
	}
}
