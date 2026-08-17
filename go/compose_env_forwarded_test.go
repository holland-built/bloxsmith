package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// EVERY VARIABLE .env.example DOCUMENTS MUST ACTUALLY REACH SOMETHING.
//
// docker compose reads `.env` ONLY to substitute `${NAME}` into the compose file.
// A variable documented in `.env.example` and mentioned nowhere in
// `docker-compose.yml` reaches nothing at all — and because the app reads it with
// a plain `os.Getenv`, an unforwarded variable is indistinguishable from an unset
// one, so nothing can warn. That was TRUSTED_PROXIES (#125): the operator was told
// to set it or "six wrong passphrase guesses from anyone lock out everybody behind"
// their proxy, they set it, and nothing happened.
//
// WHY THE ENUMERATOR IS `.env.example` AND NOT config.go. Keying it on the Go
// config would be the wider net, but it is the wrong net: several variables the app
// reads must NOT be forwarded — VAULT_DIR most of all, since the vault volume
// mounts at a fixed /vault and redirecting the app would put vault.json outside the
// persisted volume. `.env.example` is the CONTRACT WITH THE OPERATOR, and this test
// holds that contract.
//
// The cost of that choice, stated rather than hidden: this guard would go quiet if
// someone deleted a line from `.env.example` instead of fixing the forwarding —
// its enumerator would shrink with the file. requiredForwarded below is the answer,
// a short list of names asserted BY NAME so the enumerator cannot be shrunk to
// silence them.
//
// It also does NOT cover the eight variables config.go reads that appear in
// neither file — ALLOWED_HOSTS, AUDIT_KEY, AUDIT_KEY_FILE, AUDIT_TRUST_DIR,
// BLOCK_LIST_ID, DASHBOARD_TOKEN, DISABLE_UPDATE_CHECK, TEMPLATES_DIR. Those are
// unsupported by the stock compose deploy (an override file or `docker compose run
// -e` can still supply them). Which of them belong in a supported deploy is a
// product decision, not a defect, so it is not asserted here.

// repoRoot is this file's parent directory: the tests run in go/, and both files
// under test sit one level up. Not a package-level identifier, to stay clear of
// docs_compose_claims_test.go and docs_build_claims_test.go, which declare their
// own paths.
func composeRepoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cannot read the working directory: %v", err)
	}
	return filepath.Dir(wd)
}

// assignmentRE matches a real assignment line and nothing else: optional comment
// marker, the NAME, and `=` — anchored at the start of the line. Prose mentioning
// a variable does not match, and neither does an inline `FOO=bar` inside a
// sentence, which is why the anchor is here rather than a bare search.
var assignmentRE = regexp.MustCompile(`(?m)^#?\s*([A-Z][A-Z0-9_]{2,})=`)

// documentedEnvNames is every variable `.env.example` declares, commented or not.
func documentedEnvNames(t *testing.T, root string) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, ".env.example"))
	if err != nil {
		t.Fatalf("cannot read .env.example: %v", err)
	}
	seen := map[string]bool{}
	var out []string
	for _, m := range assignmentRE.FindAllStringSubmatch(string(b), -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	if len(out) < 10 {
		t.Fatalf("only %d variable(s) parsed out of .env.example (%v) — the parser broke, "+
			"and a guard whose enumerator silently emptied would pass every assertion below", len(out), out)
	}
	return out
}

// composeEnvKeys maps each service in docker-compose.yml to the environment keys
// it sets. Parsed by indentation rather than with a YAML library so this test
// pulls in no dependency: services sit at 2 spaces, their keys at 4, and an
// `environment:` block's entries at 6.
func composeEnvKeys(t *testing.T, root string) map[string]map[string]bool {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, "docker-compose.yml"))
	if err != nil {
		t.Fatalf("cannot read docker-compose.yml: %v", err)
	}
	out := map[string]map[string]bool{}
	service, inEnv, inServices := "", false, false
	entryRE := regexp.MustCompile(`^      ([A-Z][A-Z0-9_]*):`)
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "services:") {
			inServices = true
			continue
		}
		if inServices && len(line) > 0 && line[0] != ' ' {
			inServices = false // volumes:, networks:, …
		}
		if !inServices {
			continue
		}
		if m := regexp.MustCompile(`^  ([a-z][a-z0-9_-]*):`).FindStringSubmatch(line); m != nil {
			service, inEnv = m[1], false
			out[service] = map[string]bool{}
			continue
		}
		if regexp.MustCompile(`^    [a-z_]+:`).MatchString(line) {
			inEnv = strings.HasPrefix(line, "    environment:")
			continue
		}
		if inEnv && service != "" {
			if m := entryRE.FindStringSubmatch(line); m != nil {
				out[service][m[1]] = true
			}
		}
	}
	if len(out["bloxsmith"]) < 5 {
		t.Fatalf("parsed only %d environment key(s) for the bloxsmith service — the parser broke, "+
			"and every assertion below would then be vacuous", len(out["bloxsmith"]))
	}
	return out
}

// substitutionOnly is the allowlist: variables `.env.example` documents that are
// read by the compose file itself rather than passed into a container. Each row
// says where it is consumed, so adding one is a decision somebody wrote down.
var substitutionOnly = map[string]string{
	"BIND":       "the bloxsmith `ports:` line — the host interface to publish on",
	"PORT":       "the bloxsmith `ports:` line — the HOST port. The container always listens on 8080, and the healthcheck resolves the same default, so forwarding it would let the two disagree",
	"HTTPS_BIND": "the caddy `ports:` line",
	"HTTPS_PORT": "the caddy `ports:` line",
	"VAULT_DIR":  "NOT forwarded on purpose: the vault volume mounts at a fixed /vault, and redirecting the app would put vault.json outside the persisted volume and lose it on the next container replacement (#125)",
}

// requiredForwarded is asserted BY NAME, so deleting a line from .env.example
// cannot shrink the enumerator until this test goes quiet. One row per variable
// whose absence has actually cost something.
var requiredForwarded = map[string]string{
	"TRUSTED_PROXIES": "bloxsmith",
}

func TestComposeForwardsEveryDocumentedEnvVar(t *testing.T) {
	root := composeRepoRoot(t)
	byService := composeEnvKeys(t, root)

	forwardedBy := func(name string) string {
		for service, keys := range byService {
			if keys[name] {
				return service
			}
		}
		return ""
	}

	for _, name := range documentedEnvNames(t, root) {
		if svc := forwardedBy(name); svc != "" {
			continue
		}
		if why, ok := substitutionOnly[name]; ok {
			if why == "" {
				t.Errorf("%s is in substitutionOnly with no reason — write down why it is not forwarded", name)
			}
			continue
		}
		t.Errorf(".env.example documents %s, but docker-compose.yml neither forwards it to a "+
			"container nor substitutes it. Setting it in .env reaches NOTHING, and the app cannot "+
			"tell that apart from unset. Either add it to a service's environment: block, or add a "+
			"row to substitutionOnly saying where it IS consumed.", name)
	}
}

func TestComposeForwardsTheNamedSecurityVars(t *testing.T) {
	root := composeRepoRoot(t)
	byService := composeEnvKeys(t, root)

	for name, wantService := range requiredForwarded {
		if !byService[wantService][name] {
			t.Errorf("%s must be forwarded to the %s service and is not. Without it the vault unlock "+
				"rate limit counts every client behind a reverse proxy as one, which is a lockout for "+
				"everybody behind it (#125).", name, wantService)
		}
		// On the WRONG service it would still be "present in the compose file",
		// which is why this asserts the service and not just the name.
		for svc, keys := range byService {
			if svc != wantService && keys[name] {
				t.Errorf("%s is set on the %s service, not %s — it configures the app, not the proxy",
					name, svc, wantService)
			}
		}
	}
}

// The claim the docs now make about the secure profile has to stay true: Caddy is
// a separate container talking to the app over the docker network, which is why
// 127.0.0.1 is not the address to trust. If the Caddyfile is ever changed to reach
// the app some other way, the .env.example guidance is wrong again.
func TestCaddyReachesTheAppOverTheDockerNetwork(t *testing.T) {
	root := composeRepoRoot(t)
	b, err := os.ReadFile(filepath.Join(root, "deploy", "Caddyfile"))
	if err != nil {
		t.Fatalf("cannot read deploy/Caddyfile: %v", err)
	}
	if !strings.Contains(string(b), "reverse_proxy bloxsmith:") {
		t.Errorf("deploy/Caddyfile no longer proxies to the bloxsmith SERVICE NAME. .env.example "+
			"tells the operator to trust caddy's address on noc-net specifically because of that "+
			"line; re-check that guidance. Caddyfile:\n%s", string(b))
	}
	ex, err := os.ReadFile(filepath.Join(root, ".env.example"))
	if err != nil {
		t.Fatalf("cannot read .env.example: %v", err)
	}
	// The two values that could never work, kept out by name: loopback is not the
	// source address, and 172.18 was an invented subnet (noc-net has no IPAM block,
	// so compose allocates one at `up` time).
	for _, dead := range []string{"TRUSTED_PROXIES=127.0.0.1", "TRUSTED_PROXIES=172.18."} {
		if strings.Contains(string(ex), dead) {
			t.Errorf("%s is back in .env.example. Caddy reaches the app from its own address on "+
				"noc-net, and noc-net's subnet is allocated at `up` time — neither value can be "+
				"right on any machine.", dead)
		}
	}
}
