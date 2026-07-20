# Plan 031 — Bundle provisioning templates, CI-driven signed releases, PS1 lint

Repo: `/Users/sholland/AI/Infoblox MCP` (github.com/holland-built/bloxsmith), branch `master`.
App: **bloxsmith** — Go single binary (`go/main.go`), frontend `src/*.jsx` compiled by
`scripts/build_ui.js` into `go/web/` and `go:embed`'d. Python is fully retired.
Releases: goreleaser, config `go/.goreleaser.yaml`, always run **from the `go/` directory**.
CI: `.github/workflows/ci.yml`. Nightly: `.github/workflows/mcp-drift.yml` (untouched here).
Docs: `docs/SHIP.md` (release playbook), `docs/DEPLOYMENT.md`.

## How to execute this from a fresh context

1. Read this file top to bottom before touching anything.
2. Work in a **new git worktree off `master`** (other Claude sessions edit master live):
   ```bash
   cd "/Users/sholland/AI/Infoblox MCP"
   git worktree add ../infoblox-mcp-plan031 master
   cd ../infoblox-mcp-plan031
   ```
3. Sequence:
   a. Implement all three deliverables below, in order (1 → 2 → 3).
   b. Run every command in the **Verification** section; all must pass.
   c. Cross-check the finished diff with Codex via `/xcheck` and iterate until agreement.
   d. Commit + push to `master` (these are structural CI/docs/build changes). Then **stop**:
      cutting a real release requires the human's explicit go-ahead. When given, the release
      should be **v2.2.0** (current latest tag is `v2.1.1`) — the templates bundling is a real
      artifact change, and a live tag is the only way to validate archive/image bundling AND
      the new CI release path end to end.

## Decisions locked (do not relitigate)

| Decision | Choice |
|---|---|
| Template distribution | **Bundle at build time** via goreleaser `before.hooks` — templates stay third-party, stay out of git (`.gitignore:96` `templates/`), are NOT `go:embed`'d |
| Release path | New tag-triggered `.github/workflows/release.yml` is **canonical**; local goreleaser stays documented as manual fallback |
| Image signing | **cosign keyless** (OIDC, `id-token: write`, no stored key) via goreleaser `docker_signs:` — signs ghcr images only, not binary tarballs |
| Homebrew in CI | Gated on repo secret `HOMEBREW_TAP_TOKEN` (PAT with repo scope on `holland-built/homebrew-tap`). Secret absent → `goreleaser release --clean --skip=homebrew`, release still succeeds |
| install.ps1 lint | New `windows-latest` CI job, `Invoke-ScriptAnalyzer -Severity Error`, fail on any Error finding |

---

## Current state (verified anchors — re-verify with grep before editing)

- `go/internal/config/config.go:160` — `c.TemplatesDir = getDefault("TEMPLATES_DIR", filepath.Join(dir, "templates"))` (dir = the binary's own directory). **No change needed here.**
- `go/main.go:205` — `Provision: provision.New(restClient, cfg.TemplatesDir),`.
- `scripts/fetch_templates.py` — stdlib-only Python 3; downloads Chris Marrison's
  `ccmarris/uddi_automation_toolkit` tarball, extracts `templates/{amer,emea,apac,blocks,dns}/**/*.ya?ml`
  (~52K / 12 files). Destination: `$TEMPLATES_DIR` if set, else `<repo-root>/templates`
  (line 27-29: `DEST = os.environ.get("TEMPLATES_DIR") or os.path.join(dirname(dirname(abspath(__file__))), "templates")`).
  Exits 1 on download failure or zero files extracted.
- `.gitignore:96` — `templates/` (no leading slash → also matches `go/templates/`, which is where we will fetch to). Verify: `git check-ignore go/templates/x.yaml` after creating a dummy — must be ignored.
- `go/.goreleaser.yaml` — `version: 2`. `before.hooks` currently only `go mod tidy` (lines 20-22). `archives:` block at lines 52-63 has **no `files:` entry**. `dockers:` at lines 118-146 (two entries, amd64 + arm64, `dockerfile: Dockerfile.goreleaser`, `use: buildx`) have **no `extra_files:`**. `release.extra_files` (lines 88-90) already attaches `../scripts/install.sh` + `../scripts/install.ps1` — **do not touch**. `brews:` block at lines 93-112, `repository:` at 97-100 currently has no `token:` key. No `docker_signs:` block exists.
- `go/Dockerfile.goreleaser` — distroless/static; `COPY bloxsmith /app/bloxsmith` only (line 10); `ENV ... TEMPLATES_DIR=/templates ...` (line 15) but **/templates is never populated** — this is the container bug.
- `go/internal/provision/template.go` — `LoadTemplate` (line 23) returns `perr("template not found: %s", name)` on ReadFile failure; `ListTemplates` (line 429) silently returns `[]` when the dir is missing (Walk error ignored); `SiteTemplateRelPaths` (line 481) skips missing region dirs. `Engine` struct is in `go/internal/provision/helpers.go:59-67` (`Rest`, `TemplatesDir` fields). **Nothing panics** when templates are absent — degradation is graceful but the error text is misleading ("template not found" when the whole install is missing).
- `go/internal/server/provision.go` — seed flow `provisionSeedDemoStream` at line 213; after `sse.Start` (line 224) it emits "Seeding blocks…" then `LoadTemplate("blocks/regional_address_blocks.yaml")` (line 235). Templates list endpoint `templatesList` at line 68.
- `.github/workflows/ci.yml` — single `build` job (ubuntu-latest): checkout, node 24, `node scripts/build_ui.js --check`, conditional tsc, Go `1.26.x`, `go build ./... && go test ./...` in `go/`, goreleaser-action@v6 install-only, `goreleaser build --snapshot --clean` in `go/`. Header comment (lines 3-5) says "Releases are cut locally with goreleaser … no image publish, no signing" — becomes stale after this plan; update it.
- `docs/SHIP.md` — Release section (lines 21-39) documents the local goreleaser flow; "Signing status (truth)" blockquote at lines 42-47 says releases are local + unsigned.
- `docs/DEPLOYMENT.md` — line 47 "Signature verification (cosign) is the planned hardening step."; line 73 "the binary is unsigned"; lines 182-186 "Releases are cut **locally** with goreleaser … CI … does not publish or sign images."
- `scripts/install.ps1` exists (PowerShell 5.1+/7 installer). `scripts/install.sh` exists.
- Latest tags: `v2.0.5, v2.1.0, v2.1.1` → next release is **v2.2.0**.
- Stale comment flag: `go/.goreleaser.yaml` lines 9-12 claim tags are `v1.0.<git-commit-count>` — reality is semver `v2.x.y`. Fix this comment while editing the file (one line, low risk).

---

## Deliverable 1 (HIGH) — Package provisioning templates (bundle-at-build)

**Problem.** The binary reads templates from disk at `<binary-dir>/templates` (or `$TEMPLATES_DIR`).
Templates are third-party, gitignored, fetched only by `scripts/fetch_templates.py`. Neither the
goreleaser archive nor the container image ships them (`Dockerfile.goreleaser` sets
`TEMPLATES_DIR=/templates` but never populates it). Template-driven provisioning + "Seed Demo Data"
is therefore broken everywhere except a dev box that ran the fetch script. Core user-param
provisioning is unaffected.

**Strategy.** Fetch templates into `go/templates/` (gitignored) via a goreleaser `before` hook, so
they exist on disk at build time; bundle that dir into (a) every release archive next to the binary
(default `TemplatesDir` = binary-dir/templates then just works) and (b) the docker build context +
image at `/templates` (matching the existing `ENV TEMPLATES_DIR=/templates`).

### 1.1 goreleaser before hook — `go/.goreleaser.yaml`

Replace:
```yaml
before:
  hooks:
    - go mod tidy
```
with:
```yaml
before:
  hooks:
    - go mod tidy
    # Fetch third-party demo/seed templates (ccmarris/uddi_automation_toolkit)
    # into go/templates (gitignored) so archives + images can bundle them.
    # cwd is go/, so the script is at ../scripts/. TEMPLATES_DIR overrides the
    # script's repo-root default.
    - sh -c "TEMPLATES_DIR=templates python3 ../scripts/fetch_templates.py"
```
Notes:
- goreleaser hook strings are shell-words-split, so the `sh -c "..."` form is required to set the
  env var inline. `TEMPLATES_DIR=templates` is relative to the hook's cwd (`go/`) → `go/templates/`.
- This hook now also runs during CI's existing `goreleaser build --snapshot --clean` step — that is
  fine (ubuntu-latest has python3; the script needs network; see Open flags for the flakiness note).
- Local devs running `goreleaser build --snapshot` now need python3 + network. Acceptable.

### 1.2 Archive bundling — `go/.goreleaser.yaml` `archives:` block

Add a `files:` key to the existing single archive entry (after `name_template`/before
`format_overrides` — position within the entry doesn't matter, keep it tidy):
```yaml
archives:
  - id: bloxsmith
    ids:
      - bloxsmith
    name_template: >-
      {{ .ProjectName }}_{{ .Version }}_
      {{- if eq .Os "darwin" }}macOS_universal
      {{- else }}{{ .Os }}{{ .Arch }}{{ end }}
    # Bundle the fetched third-party templates next to the binary: the binary's
    # default TemplatesDir is <binary-dir>/templates, so extracting the archive
    # yields a working template/seed provisioning setup with zero extra steps.
    files:
      - src: templates/**/*
    format_overrides:
      - goos: windows
        formats: [zip]
```
**Careful:** the `name_template` above is illustrative — do NOT retype it; only ADD the `files:` +
comment lines to the existing block (the real template is `{{ .Os }}_{{ .Arch }}` with an
underscore — leave every existing line byte-identical).
- `src: templates/**/*` is relative to `go/` (goreleaser cwd) and preserves the relative path, so
  archive members land at `templates/amer/...` etc., alongside `bloxsmith`.
- Windows zip gets the same `files:` treatment automatically.

### 1.3 Container bundling — `go/.goreleaser.yaml` `dockers:` + `go/Dockerfile.goreleaser`

In BOTH docker entries (`bloxsmith-amd64` at ~line 119 and `bloxsmith-arm64` at ~line 133), add
`extra_files:` (path relative to `go/`):
```yaml
    extra_files:
      - templates
```
Place it as a sibling of `dockerfile:`/`image_templates:` in each entry. goreleaser copies
`go/templates/` into the docker build context, so the Dockerfile can COPY it.

In `go/Dockerfile.goreleaser`, change:
```dockerfile
WORKDIR /app
COPY bloxsmith /app/bloxsmith
```
to:
```dockerfile
WORKDIR /app
COPY bloxsmith /app/bloxsmith
# Third-party demo/seed templates, fetched by goreleaser's before hook and
# injected via dockers[].extra_files. Matches ENV TEMPLATES_DIR=/templates below.
COPY templates /templates
```

### 1.4 Graceful degradation hardening (Go code)

Verified: nothing panics today with a missing templates dir — but the failure surface is confusing
(`ListTemplates` returns `[]` silently; seed emits `template not found: blocks/regional_address_blocks.yaml`).
Make the "templates not installed at all" case explicit:

**(a)** `go/internal/provision/template.go` — add a helper (near the top, after the consts):
```go
// TemplatesInstalled reports whether the templates directory exists on disk.
// Templates are third-party (fetched by scripts/fetch_templates.py, bundled by
// goreleaser); a bare `go build` dev tree legitimately lacks them.
func (e *Engine) TemplatesInstalled() bool {
	info, err := os.Stat(e.TemplatesDir)
	return err == nil && info.IsDir()
}
```
(`os` is already imported in template.go.)

**(b)** Same file, in `LoadTemplate`, replace the ReadFile error branch:
```go
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, perr("template not found: %s", name)
	}
```
with:
```go
	raw, err := os.ReadFile(path)
	if err != nil {
		if !e.TemplatesInstalled() {
			return nil, perr("templates not installed — run scripts/fetch_templates.py, or use the release archive / container image, which bundle them")
		}
		return nil, perr("template not found: %s", name)
	}
```

**(c)** `go/internal/server/provision.go`, in `provisionSeedDemoStream` (line ~213): immediately
after the `summary := map[string]any{...}` line (line 232) and BEFORE
`emit(map[string]any{"step": "Seeding blocks…"})`, add:
```go
	if !d.Provision.TemplatesInstalled() {
		emit(map[string]any{"error": "templates not installed — run scripts/fetch_templates.py, or use the release archive / container image, which bundle them"})
		emit(map[string]any{"done": true, "summary": summary})
		return
	}
```
No new imports needed in this file for that call.

**(d)** New test file `go/internal/provision/template_test.go`:
```go
package provision

import (
	"strings"
	"testing"
)

func TestTemplatesInstalledMissingDir(t *testing.T) {
	e := New(nil, t.TempDir()+"/does-not-exist")
	if e.TemplatesInstalled() {
		t.Fatal("expected TemplatesInstalled=false for a missing dir")
	}
	if _, err := e.LoadTemplate("blocks/regional_address_blocks.yaml"); err == nil ||
		!strings.Contains(err.Error(), "templates not installed") {
		t.Fatalf("want 'templates not installed' error, got %v", err)
	}
}

func TestTemplatesInstalledExistingDir(t *testing.T) {
	if !New(nil, t.TempDir()).TemplatesInstalled() {
		t.Fatal("expected TemplatesInstalled=true for an existing dir")
	}
}
```
(`provision.New(nil, dir)` is safe here — `helpers.go:66` just stores the fields; no REST calls occur.)
If a `template_test.go` (or clashing test names) already exists in that package, merge instead of
overwriting — check first: `ls go/internal/provision/*_test.go`.

### 1.5 Stale version comment fix — `go/.goreleaser.yaml` lines 9-12

While editing the file, correct the header comment that claims tags are `v1.0.<git-commit-count>`:
change that sentence to say tags are semver `vX.Y.Z` (e.g. `v2.2.0`) per SHIP.md. Comment-only.

---

## Deliverable 2 (MED) — Tag-triggered CI release with cosign-signed images

### 2.1 New workflow — `.github/workflows/release.yml`

Create exactly this file (adjust nothing else in it without reason):
```yaml
name: Release

# Canonical release path: push a semver tag and CI runs goreleaser — GitHub
# Release (tarballs + checksums + install scripts), ghcr images (multi-arch,
# cosign keyless-signed), and — when the HOMEBREW_TAP_TOKEN secret is present —
# the Homebrew tap. Local goreleaser (docs/SHIP.md) remains the manual fallback.
on:
  push:
    tags: ['v*.*.*']

permissions:
  contents: write   # create the GitHub Release
  packages: write   # push ghcr images with the built-in GITHUB_TOKEN (no PAT)
  id-token: write   # cosign keyless (OIDC) image signing

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0   # goreleaser needs full history + tags

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '24'

      # go/web/ is committed + go:embed'd; --check proves it matches src/*.jsx.
      - name: UI bundle up to date (build_ui --check)
        run: node scripts/build_ui.js --check

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.26.x'

      # Pre-fetch third-party templates (goreleaser's before hook also does
      # this; running it explicitly fails fast with a clearer log on error).
      - name: Fetch provisioning templates
        run: TEMPLATES_DIR=go/templates python3 scripts/fetch_templates.py

      - name: Set up QEMU (arm64 image build)
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to ghcr.io
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Install cosign
        uses: sigstore/cosign-installer@v3

      - name: Set up goreleaser
        uses: goreleaser/goreleaser-action@v6
        with:
          install-only: true

      # Homebrew gating: the built-in GITHUB_TOKEN cannot push to the
      # holland-built/homebrew-tap repo. If the HOMEBREW_TAP_TOKEN secret (PAT,
      # repo scope on homebrew-tap) is present, release everything; if absent,
      # skip only the brew channel so the release never fails for lack of it.
      - name: goreleaser release
        working-directory: go
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}
        run: |
          if [ -n "$HOMEBREW_TAP_TOKEN" ]; then
            goreleaser release --clean
          else
            echo "HOMEBREW_TAP_TOKEN not set — skipping Homebrew tap publish"
            goreleaser release --clean --skip=homebrew
          fi
```

### 2.2 goreleaser: brews token + docker_signs — `go/.goreleaser.yaml`

**(a) Brews token.** In the `brews:` entry's `repository:` block (lines 97-100), add a `token:` line:
```yaml
    repository:
      owner: holland-built
      name: homebrew-tap
      branch: main
      # CI: HOMEBREW_TAP_TOKEN (PAT with repo scope on homebrew-tap) — the
      # built-in GITHUB_TOKEN can't push cross-repo. Local fallback: falls back
      # to GITHUB_TOKEN (gh auth token has repo scope on personal repos).
      token: "{{ if index .Env \"HOMEBREW_TAP_TOKEN\" }}{{ .Env.HOMEBREW_TAP_TOKEN }}{{ else }}{{ .Env.GITHUB_TOKEN }}{{ end }}"
```
Rationale: in CI-without-secret, the workflow passes `--skip=homebrew` so this template never
publishes; in CI-with-secret the env var is non-empty and wins (`index` on an empty string is falsy
→ but the workflow only takes the non-skip path when it's non-empty, so both branches are safe);
locally it behaves exactly as today (GITHUB_TOKEN).

**(b) Image signing.** Append a top-level `docker_signs:` block at the end of the file (after
`docker_manifests:`):
```yaml
# --- cosign keyless signing of the pushed ghcr images -------------------------
# Runs in CI (release.yml) with id-token: write — the signature's identity is
# the workflow's OIDC identity; no key is stored anywhere. Verify with:
#   cosign verify ghcr.io/holland-built/bloxsmith:<tag> \
#     --certificate-identity-regexp 'github.com/holland-built/bloxsmith' \
#     --certificate-oidc-issuer https://token.actions.githubusercontent.com
docker_signs:
  - cmd: cosign
    artifacts: all
    output: true
    args: ["sign", "--yes", "${artifact}@${digest}"]
```
`artifacts: all` signs the per-arch images and both multi-arch manifests (`:x.y.z`, `:latest`).
Signing runs only on real publish — snapshot/local builds never invoke cosign. A local
`goreleaser release` without cosign installed WILL fail at this stage; the SHIP.md fallback text
(2.3) must tell the local operator to either `brew install cosign` or pass `--skip=sign`.

### 2.3 Docs reconciliation

**`docs/SHIP.md`** — rewrite the `## Release` section (lines 21-39) so:
- Canonical flow: `git tag vX.Y.Z && git push origin vX.Y.Z` → `.github/workflows/release.yml`
  runs goreleaser: GitHub Release (tarballs + `checksums.txt` + both install scripts via
  `release.extra_files`), multi-arch ghcr image (cosign keyless-signed), templates bundled into
  archives + image, and the Homebrew tap **iff** the `HOMEBREW_TAP_TOKEN` repo secret exists
  (absent → CI skips brew only).
- Manual fallback (kept, demoted): `cd go && GITHUB_TOKEN=$(gh auth token) goreleaser release
  --clean` — requires `docker login ghcr.io` (PAT with `write:packages`), python3+network for the
  template fetch hook, and cosign installed (or `--skip=sign`); brew push uses GITHUB_TOKEN unless
  HOMEBREW_TAP_TOKEN is exported.
- Replace the "Signing status (truth)" blockquote (lines 42-47): CI now signs the ghcr images with
  **keyless cosign** (GitHub OIDC identity; verify command as in the docker_signs comment above).
  Binary tarballs remain checksum-verified (`checksums.txt`) but not signature-signed — keep that
  caveat honest.

**`docs/DEPLOYMENT.md`**:
- Line 47: change "Signature verification (cosign) is the planned hardening step." → note that
  ghcr **images** are now cosign keyless-signed in CI (with the verify command); the standalone
  binary remains checksum-only.
- Line 73 ("the binary is unsigned"): keep the binary claim but append that container images are
  signed.
- Lines 182-186: replace "Releases are cut **locally** with goreleaser … CI … does not publish or
  sign images." with: releases are cut by the tag-triggered CI workflow
  (`.github/workflows/release.yml`), which publishes AND cosign-signs the multi-arch ghcr image;
  local goreleaser is the fallback.
- Grep for other stale "cut locally"/"unsigned" phrasing before finishing:
  `grep -rn -i "cut locally\|unsigned\|planned hardening" docs/ .github/`.

**`.github/workflows/ci.yml`** header comment (lines 3-5): update "Releases are cut locally with
goreleaser (see docs/SHIP.md); this workflow only proves the tree builds." → releases are cut by
the tag-triggered `release.yml`; this workflow proves the tree builds on push/PR.

Do NOT change `scripts/install.sh` / `scripts/install.ps1` or `release.extra_files` — the
installer attachment mechanism already works.

---

## Deliverable 3 (LOW) — CI-lint install.ps1

Append a second job to `.github/workflows/ci.yml` (sibling of `build`):
```yaml
  # PSScriptAnalyzer gate for the Windows installer — catches PowerShell errors
  # without a manual Windows run. Error severity only; warnings don't fail CI.
  lint-ps1:
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: PSScriptAnalyzer (Error severity gate)
        shell: pwsh
        run: |
          Install-Module PSScriptAnalyzer -Force -Scope CurrentUser
          $findings = Invoke-ScriptAnalyzer -Path scripts/install.ps1 -Severity Error
          if ($findings) {
            $findings | Format-Table RuleName, Line, Message -AutoSize | Out-String | Write-Host
            exit 1
          }
          Write-Host "PSScriptAnalyzer: no Error-severity findings in scripts/install.ps1"
```
If this job finds pre-existing Error-severity issues in `scripts/install.ps1`, fix them minimally
(they are real bugs — this script has never been machine-linted); do not restyle the script.

---

## Ordered task list

1. `git worktree add ../infoblox-mcp-plan031 master && cd ../infoblox-mcp-plan031`
2. Edit `go/.goreleaser.yaml`: before hook (1.1), archive `files:` (1.2), dockers `extra_files:` ×2 (1.3), header comment (1.5), brews `token:` (2.2a), `docker_signs:` (2.2b).
3. Edit `go/Dockerfile.goreleaser`: `COPY templates /templates` (1.3).
4. Edit `go/internal/provision/template.go`: `TemplatesInstalled()` + LoadTemplate message (1.4a/b).
5. Edit `go/internal/server/provision.go`: seed-stream guard (1.4c).
6. Create `go/internal/provision/template_test.go` (1.4d).
7. Create `.github/workflows/release.yml` (2.1).
8. Edit `.github/workflows/ci.yml`: header comment (2.3) + `lint-ps1` job (3).
9. Edit `docs/SHIP.md` + `docs/DEPLOYMENT.md` (2.3).
10. Run Verification below.
11. `/xcheck` the diff; iterate to agreement.
12. Commit (one commit or logical pair), push `master`. Await human go-ahead before `git tag v2.2.0 && git push origin v2.2.0`.

## Verification

Run all from the worktree root unless noted:

```bash
# 1. UI bundle untouched/fresh
node scripts/build_ui.js --check

# 2. Go compiles + tests green (includes the new template_test.go)
cd go && go build ./... && go test ./... && cd ..

# 3. Template fetch works and lands where goreleaser expects
(cd go && sh -c "TEMPLATES_DIR=templates python3 ../scripts/fetch_templates.py")
ls go/templates/blocks/regional_address_blocks.yaml   # must exist
find go/templates -name '*.yaml' | wc -l              # expect ~12
git status --porcelain | grep templates && echo "FAIL: templates tracked" || echo "OK: gitignored"

# 4. goreleaser config parses + full pipeline dry-run.
#    `build --snapshot` validates config/builds/hooks; it does NOT produce archives.
#    The `release --snapshot` line ALSO exercises archives (proves the files: glob
#    resolves) without publishing; skip docker if no local docker daemon.
cd go
goreleaser build --snapshot --clean
goreleaser release --snapshot --clean --skip=docker,homebrew,sign
tar tzf dist/*macOS_universal*.tar.gz | grep 'templates/blocks/regional_address_blocks.yaml'  # archive bundling proof
cd ..

# 5. Graceful degradation, live: run the binary against an empty templates dir
TEMPLATES_DIR=/nonexistent go run ./go &   # then GET /api/templates → [] (200),
#   and the seed stream / template load endpoints must return the
#   "templates not installed — run scripts/fetch_templates.py..." message, no panic.
#   (Or rely on template_test.go + a code read if running the server is awkward.)

# 6. Workflow YAML parses
python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.github/workflows/ci.yml','.github/workflows/release.yml']]; print('workflows OK')"
```

What CANNOT be verified locally (see Open flags): the real archive/image bundling on a published
release, ghcr push + cosign signing, the Homebrew gate, and the windows-latest PSScriptAnalyzer job
(only runs in CI).

## Open flags / needs-a-human

- **HOMEBREW_TAP_TOKEN secret**: maintainer must create a PAT (repo scope on
  `holland-built/homebrew-tap`) and add it as a repo secret to enable the brew channel in CI.
  Until then every CI release runs `--skip=homebrew` by design — the release still succeeds.
- **Live release required**: archive/image template bundling, ghcr publish via built-in
  GITHUB_TOKEN, cosign keyless signing, and the whole release.yml path only prove out on a real
  tag. That is the v2.2.0 release — human go-ahead required before tagging.
- **PSScriptAnalyzer runs only in CI** (windows-latest); if it flags pre-existing Errors in
  install.ps1 the first run may need a follow-up fix commit.
- **CI now fetches from github.com/ccmarris on every snapshot build** (before hook in ci.yml's
  goreleaser step + release.yml). A GitHub outage or upstream repo rename breaks builds; the
  script fails loudly (exit 1). Acceptable per the bundle-at-build decision; if it flakes, cache
  the tarball in CI later.
- **Binary tarballs remain unsigned** (checksum-only). Only ghcr images get cosign signatures —
  keep docs honest about this split.
- **ghcr package visibility**: if the ghcr package ever recreates as private, the one-time
  "make public" step in docs/DEPLOYMENT.md (~line 208) applies — CI publish with GITHUB_TOKEN
  keeps existing visibility.
