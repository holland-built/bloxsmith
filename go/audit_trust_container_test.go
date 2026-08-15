package main

import (
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// The container's audit trust root has to satisfy two properties at once, and
// losing either one is silent — the app keeps recording, the API keeps
// answering, and the only symptom is a verdict nobody reads until they need it.
//
//	PERSISTED   — or the key dies with the container and every entry written
//	              before the upgrade reports could-not-verify forever.
//	SEPARATE    — or it shares a failure domain with the log it signs, and a
//	              backup, a copied volume or a path-traversal bug hands an
//	              attacker both halves.
//
// Before #58 the first was broken: audit.DefaultTrustDir() resolved to
// /root/.config/bloxsmith-audit inside the image, and four containers over one
// /vault volume produced four different key ids. The obvious one-word fix,
// AUDIT_TRUST_DIR=/vault/audit-trust, breaks the second instead — and does it
// without a warning, because audit.New only warns when the trust dir IS the
// log's directory.
//
// So this asserts BOTH, against the real files, in the one place where they can
// disagree with each other.

// dockerfilePath and composePath are the two files that between them decide
// where the container's key lives.
const (
	dockerfilePath = "Dockerfile.goreleaser"
	composePath    = "../docker-compose.yml"
)

// dockerfileEnv reads one ENV value out of the Dockerfile. It scans tokens
// rather than parsing lines, because the ENV is written as one backslash-
// continued statement and a line-oriented reader would miss every value but the
// first.
func dockerfileEnv(t *testing.T, src, key string) string {
	t.Helper()
	for _, line := range strings.Split(src, "\n") {
		if i := strings.Index(line, "#"); i >= 0 {
			line = line[:i]
		}
		for _, tok := range strings.Fields(line) {
			if v, ok := strings.CutPrefix(tok, key+"="); ok {
				return strings.Trim(v, `"'`)
			}
		}
	}
	t.Fatalf("%s does not set %s. Without it audit.DefaultTrustDir() falls back to the "+
		"per-user config directory, which in this image is inside the container's writable "+
		"layer — so the audit signing key dies with the container. See #58.", dockerfilePath, key)
	return ""
}

// dockerfileDeclaresVolume reports whether the image declares path as a VOLUME.
func dockerfileDeclaresVolume(src, path string) bool {
	for _, line := range strings.Split(src, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && strings.EqualFold(f[0], "VOLUME") {
			for _, p := range f[1:] {
				if strings.Trim(p, `[]",`) == path {
					return true
				}
			}
		}
	}
	return false
}

type composeFile struct {
	Services map[string]struct {
		Volumes []string `yaml:"volumes"`
	} `yaml:"services"`
	Volumes map[string]struct {
		Name string `yaml:"name"`
	} `yaml:"volumes"`
}

func TestContainerAuditTrustDirIsPersistedAndSeparate(t *testing.T) {
	dfb, err := os.ReadFile(dockerfilePath)
	if err != nil {
		t.Fatalf("read %s: %v", dockerfilePath, err)
	}
	df := string(dfb)

	trust := dockerfileEnv(t, df, "AUDIT_TRUST_DIR")
	vault := dockerfileEnv(t, df, "VAULT_DIR")

	// SEPARATE. Equality is not enough: /vault/audit-trust is a different string
	// and the same volume, which is the failure this check exists for.
	if trust == vault || strings.HasPrefix(trust, strings.TrimSuffix(vault, "/")+"/") {
		t.Fatalf("AUDIT_TRUST_DIR=%s sits inside VAULT_DIR=%s. The audit log lives in the "+
			"vault dir, so one backup or one copied volume would carry the log AND the key "+
			"that signs it — and audit.New will not warn, because the two paths are not equal. "+
			"internal/audit/key.go requires a trust root the log's writer cannot reach.", trust, vault)
	}

	// PERSISTED, half one: the image has to say the path is a volume at all,
	// or it is just a directory in the writable layer.
	if !dockerfileDeclaresVolume(df, trust) {
		t.Fatalf("%s sets AUDIT_TRUST_DIR=%s but never declares it as a VOLUME, so the key is "+
			"written into the container's writable layer and is destroyed by the next "+
			"`docker compose pull && up -d`.", dockerfilePath, trust)
	}

	// PERSISTED, half two: an anonymous volume is not persistence. The next
	// `docker run` gets a fresh empty one and mints a new key over the old chain,
	// which is exactly the state #58 reported. compose has to NAME it.
	cfb, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatalf("read %s: %v", composePath, err)
	}
	var cf composeFile
	if err := yaml.Unmarshal(cfb, &cf); err != nil {
		t.Fatalf("parse %s: %v", composePath, err)
	}
	svc, ok := cf.Services["bloxsmith"]
	if !ok {
		t.Fatalf("%s has no `bloxsmith` service; this guard is reading the wrong file or the "+
			"service was renamed", composePath)
	}
	mounted := ""
	for _, m := range svc.Volumes {
		parts := strings.SplitN(m, ":", 3)
		if len(parts) >= 2 && parts[1] == trust {
			mounted = parts[0]
		}
	}
	if mounted == "" {
		t.Fatalf("%s does not mount anything at %s for the bloxsmith service. The image's VOLUME "+
			"line alone gives an ANONYMOUS volume, and the next container gets a fresh empty "+
			"one — the key is lost exactly as before.", composePath, trust)
	}
	if strings.HasPrefix(mounted, ".") || strings.HasPrefix(mounted, "/") {
		t.Fatalf("%s mounts %s at %s, a host path rather than a named volume. That is a "+
			"deployment's choice to make, but the shipped default must be a named volume so it "+
			"survives a container replacement on any machine.", composePath, mounted, trust)
	}
	if _, ok := cf.Volumes[mounted]; !ok {
		t.Fatalf("%s mounts the named volume %q but never declares it under the top-level "+
			"`volumes:` key", composePath, mounted)
	}
}
