# Plan 030: Bloxsmith → one self-contained Go binary (phased migration)

> **Executor instructions**: Follow this plan phase by phase, in order. Each phase
> has its own done-criteria — do not start the next phase until the current one's
> criteria all pass. Run every verification command and confirm the expected
> result before moving on. If anything in "STOP conditions" occurs, stop and
> report — do not improvise. When a phase completes, update this plan's status
> row in `plans/README.md` (e.g. `IN PROGRESS (Phase 1c)`).
>
> **Drift check (run first)**:
> `git diff --stat a86524a..HEAD -- server.py scripts/build_ui.js Dockerfile docker-compose.yml`
> If `server.py` changed since this plan was written, the line numbers below may
> have drifted — re-locate every cited symbol **by name** (`grep -n "def <name>"
> server.py`) before porting it. A moved function is fine; a *missing* or
> *restructured* function is a STOP condition.

## Status

- **Priority**: P0 (architecture direction)
- **Effort**: XL total — Phase 0: S/M · Phase 1: L · Phase 2: M · Phase 3: S/M · Phase 4: M (optional)
- **Risk**: MEDIUM overall (Phase 1 provisioning port is the high-risk core)
- **Depends on**: none (supersedes `plans/STACK-EVOLUTION-PLAN.md` Phase 4 ghcr-hardening direction for the laptop distribution path; the container image survives as the *server* path)
- **Category**: architecture / distribution
- **Planned at**: commit `a86524a`, 2026-07-18
- **Decision already made — do not re-litigate**: one Go binary, `go:embed`ded
  unchanged frontend, built-in self-updater, goreleaser → GitHub Releases +
  Homebrew + winget + container image. Reference bar: Tailscale / `gh` / Caddy / k9s.

## Why this matters

Today Bloxsmith is a 6,561-line Python stdlib HTTP server (`server.py`) plus a
no-build React frontend, shipped **only** as a Docker image
(`ghcr.io/holland-built/bloxsmith`). That means every laptop user needs Docker
Desktop, updates are "run this shell script" (`SHIP.md:44`), and there is no
`brew install` / `winget install` story. The professional 2026 pattern for
exactly this kind of tool (local web UI + API proxy) is a single static binary
that embeds its UI, updates itself from GitHub Releases, and cross-compiles to
every OS from one `goreleaser` run. This plan gets there **without changing the
frontend at all** and **without dropping a single `/api/*` endpoint**.

The maintainer is a solo non-expert. Every phase therefore: (a) uses the
smallest possible set of Go concepts (stdlib `net/http`, `go:embed`, four small
well-known libraries), (b) keeps the Python server runnable side-by-side until
parity is proven, and (c) is independently shippable — you can stop after
Phase 0 and still have learned whether the architecture works.

## Current state (read this before writing any Go)

### The Python server surface

`server.py` (6,561 lines) is one file with these regions (locate by symbol name,
not line, if drifted):

| Region | Lines (approx) | LOC | What it is |
|---|---|---|---|
| Config / .env / update-check / TTL cache / warmer / account-switch | 1–353 | ~350 | `API_KEY`, `VAULT_MODE`, `MCP_HEADERS` (41–51), `_do_update_fetch` (89), `update_status` (123), `_cache_*` (193–210), `_warm_loop` (233), `switch_account` (312) |
| REST proxy helpers + DNS/edit write builders | 354–1030 | ~680 | `_rest_get` (354), `_rest_get_ex` (371), `_rest_write` (390), `_dns_rdata` (417), `_dns_record_create/update` (466/516), `_selfservice_allocate` (584), `_edit_*_create/update` ×9 (697–1030) |
| Templates + validation + provisioning engines | 1031–2400 | ~1,370 | `_validate_site/block/dns` (1105/1208/1260), `BlockConfig`/block builder (1391), site builder + `_create_subnet` + `_rollback` (1648–2024), retag (2025–2137), `DecommissionConfig` teardown (2138+), drift check (~2336) |
| Vault + audit chain + incidents + first-seen + snooze + saved views | 2404–3058 | ~650 | `_resolve_vault_file` (2404), audit hash chain (2429–2459), `correlate`/`build_signals`/`stamp_first_seen` (2489–2639), snooze (2657–2674), views (2682–2749), vault crypto (2750–3058): scrypt `_derive_key` (2768), Fernet `_vault_save` (2772), `vault_init/unlock/...` |
| MCP client + fetchers + normalizers + dashboard assembly | 3059–3850 | ~790 | `_mcp_session` (3059, streamable-HTTP), `_query_all_rows` (3085, 100-row paging), `_mcp_get` (3107), `_mcp_query_cube` (3147), `_mcp_search` (3184), `_norm_*` ×~15 (3376–3531), `_fetch_dashboard_async` (3532), `fetch_hub_health/security/domains` (3648–3800) |
| AI query (Groq tool-calling loop) | 3851–4160 | ~310 | `_AI_SYSTEM` (3851), `_TOOLS` (3867), `_run_tool` (3940), `_handle_query_async` (4044) |
| Secondary fetchers + `/api/source/*` passthrough | 4160–4880 | ~720 | `fetch_actions/mcp_events/insights/dns_analytics/host_metrics/assets/dossier/lookalikes` (4160–4526), threat lookup + block/unblock domain (4546–4600), REST passthrough guard (4836) |
| `Handler` — auth, RBAC, all routes, `_json` gzip, `_file` static | 4884–6530 | ~1,650 | `_authed`/`_same_origin`/`_write_ok`/`_is_mutating` (4885–4933), `_actor`/`_write_guard`/RBAC (4936–5001), `do_GET` (5006), `do_POST` (6004), `do_PUT` (~6339), `do_DELETE` (~6395), `_json` gzip>1KB (6464), `_file` traversal-guarded static (6480) |
| Entry point | 6530–6561 | ~30 | loopback warning, vault auto-unlock from env, `ThreadedHTTPServer`, warm thread |

### Complete endpoint inventory — **92 routes**. Feature parity = ALL of them.

This is the parity checklist. Nothing ships from Phase 1 until every row is
ported or explicitly stubbed with a tracked TODO. (Line numbers = the `elif` in
`do_GET`/`do_POST` at commit `a86524a`.)

**GET (58):**
`/` + static fallthrough (5069, 5997) · `/api/logo` (5009) · `/api/brand` (5045) ·
`/api/vault/status` (5050) · `/api/update/check` (5052) · `/api/sources` (5054) ·
`/api/views` (5057) · `/api/data` (5071) · `/api/actions` (5077) ·
`/api/audit/log` (5083) · `/api/audit/export` (5086) · `/api/whoami` (5092) ·
`/api/incidents` (5103) · `/api/incidents/<cat>` (5126) · `/api/csp-audit` (5143,
REST `/api/auditlog/v1/logs`) · `/api/mcp/events` (5197) · `/api/insights` (5203) ·
`/api/dns-analytics` (5209) · `/api/host-metrics` (5215) · `/api/assets` (5221) ·
`/api/dossier` (5227) · `/api/lookalikes` (5236) · `/api/hub/health` (5242) ·
`/api/hub/security` (5245) · `/api/hub/domains` (5248) · `/api/threat-lookup`
(5251) · `/api/cache-bust` (5264) · `/api/accounts` (5267) · `/api/views/<name>`
(5277) · `/api/source/<rest-path>` passthrough (5285) · `/api/ipam/spaces` (5296) ·
`/api/ipam/blocks` (5302) · `/api/dns/zones` (5324) · `/api/dns/records` (5341) ·
`/api/ipam/addresses` (5365) · `/api/ipam/availability` (5383) ·
`/api/ipam/subnets` (5411) · `/api/templates` (5498) · **5 SSE streams**:
`/api/provision/stream` (5431), `/api/provision/site/stream` (5503),
`/api/provision/seed-demo/stream` (5545), `/api/teardown/site/stream` (5617),
`/api/teardown/seed-demo/stream` (5663) · **15 CSP tiles** (5741–5976):
`/api/csp/{host-health, onprem-hosts, jobs, dfp, maintenance, threats,
ctem-exposure, ctem-assets, soc, dns-services, zones, dns-qps, ipam-util,
dhcp-leases, license-alerts}`.

**POST (28):**
`/api/brand` (6018) · **14 vault routes** (6036–6064): `/api/vault/{init, unlock,
tenant, tenant-remove, tenant-update, active, groq, llm, test-key, conn-test,
llm-test, refresh-names, lock, reset}` · `/api/query` (6075, LLM) ·
`/api/switch-account` (6094) · `/api/block-domain` (6110) · `/api/unblock-domain`
(6127) · `/api/selfservice/allocate` (6144) · `/api/dns/records` (6159) ·
`/api/templates/validate` (6174) · `/api/provision/block` (6186) ·
`/api/teardown/block` (6208) · `/api/retag/block` (6234) · `/api/drift/check`
(6264) · `/api/alerts/snooze` (6282) · `/api/edit/{zone,subnet,block,range,host}`
create (6300).

**PUT (3):** `/api/dns/records` (6339) · `/api/edit/*` (6355) · `/api/views/<name>` (6384).
**DELETE (3):** `/api/dns/records/<id>` (6395) · `/api/ipam/addresses/<id>` (6409) · `/api/edit/*` (6423).
**OPTIONS:** CORS preflight (5002).

### Cross-cutting behaviors that must survive (easy to silently drop)

1. **Auth model** (`server.py:4885–5001`): `DASHBOARD_TOKEN` shared secret via
   `X-Auth-Token` header OR `?token=` query (SSE can't set headers), constant-time
   compare; tokenless default = same-origin/loopback gate; `_is_mutating()` path
   set (`MUTATING_PATHS` at 145); every authorized write is audit-logged via
   `_write_guard`; 3-tier resolved RBAC (`viewer/operator/admin`).
2. **Vault crypto** (`server.py:2768–2782`): key = `scrypt(passphrase, salt,
   n=2^15, r=8, p=1, dklen=32)` → urlsafe-base64 → **Fernet** encrypt of a JSON
   payload; file `{"v":1, "salt": ..., "data": ...}` at `$VAULT_DIR/vault.json`.
   The Go port MUST read/write this exact format — existing users' vaults must
   unlock unchanged (Fernet is a portable spec; `github.com/fernet/fernet-go`).
3. **Audit hash chain** (`server.py:2429–2459`): each JSONL entry's `hash` =
   sha256 of the sorted-key JSON of the entry minus `hash`, chained via
   `prev_hash`; genesis `"0"*64`. Go must produce byte-identical hashing
   (canonical JSON: sorted keys, Python `json.dumps` default separators `", "`/
   `": "` — replicate exactly or the chain verification breaks on old files).
4. **TTL cache + warmer** (`server.py:186–237`): 5-min TTL, 256-entry cap, a
   240-s background warm loop over the 4 hub fetchers; cache invalidated on
   tenant/account switch.
5. **Account switch JWT** (`server.py:239–353`): `/v2/session/account_switch`
   mints a ~1h Bearer JWT; `_maybe_refresh_jwt` re-mints after 50 min;
   `MCP_HEADERS["Authorization"]` is the single mutable auth slot everything reads.
6. **gzip `_json`** (6464): gzip only when body >1KB and client accepts it.
7. **`_json` responses on SSE routes stream `text/event-stream`** with
   incremental `emit()` writes — Go needs `http.Flusher`.
8. **`.env` loader** (27–39): strips quotes, `setdefault` semantics (real env
   wins over `.env`).
9. **`update_status`** (123) returns `selfUpdate: False` today — the frontend
   `UpdateBadge` (`src/96.chrome-topbar.jsx:193–201`) only calls GET
   `/api/update/check` and renders a banner + release link. This flag is the
   Phase 3 hook.

### The frontend (embeds AS-IS — never rewrite it)

`node scripts/build_ui.js` concatenates `src/*.jsx` → Babel-lowers →
esbuild-minifies → writes `app.bundle.js` (repo root). `index.html` (915 lines)
loads it as an ES module via `vendor.importmap.json`. The full static asset set
the Go binary must embed and serve (everything `Dockerfile:10–13` copies):

- `index.html`, `app.bundle.js`
- `vendor.*.js` (14 files: React 19.2.7 ESM, react-dom, scheduler, jsx-runtime,
  astryxdesign-core, stylex), `vendor.importmap.json`, `vendor.astryx.css`
- `Geist-*.woff2` ×5 (fonts)
- `templates/` — third-party seed/provision templates fetched at build by
  `scripts/fetch_templates.py` (NOT committed; see `.gitignore` convention).
  Embed them the same way: fetch at build, `go:embed` the result, and keep the
  `TEMPLATES_DIR` env override so customers can mount their own.

Do NOT embed `babel.min.js` (build-time only), `vault.json`, `first_seen.json`,
or any state file. State lives outside the binary (see Phase 1a).

### Current distribution (what Phase 2 replaces/keeps)

- `Dockerfile` — python:3.13-slim, `VAULT_DIR=/vault` volume, `APP_VERSION` arg.
- `docker-compose.yml` — ghcr image, `noc-vault` volume, optional Caddy TLS profile.
- `release-image.sh` — local build+push of `:latest` + `:v1.0.<git-count>`.
- `SHIP.md` — `/release` playbook: push master → `./release-image.sh` →
  `gh release create v1.0.<n>`. The in-app banner keys off the GitHub release tag.
- Versioning: `1.0.<git rev-list --count HEAD>` (`server.py:54–62`) — **keep this
  scheme** so the existing `_ver_n` comparison and released tags stay ordered.

### Python deps and their Go replacements

| Python (`requirements.txt`) | Used for | Go replacement |
|---|---|---|
| `mcp` 1.27.1 (streamable-HTTP client) | `_mcp_session` + 4 tool calls | `github.com/modelcontextprotocol/go-sdk` (official; has streamable-HTTP client). **Fallback**: hand-rolled JSON-RPC-over-HTTP — the server only ever calls `initialize` + `call_tool` on 4 tools |
| `groq` 1.4.0 | `/api/query` tool loop | plain `net/http` POST to the OpenAI-compatible `chat/completions` endpoint (Groq or `LLM_BASE_URL`) — no SDK |
| `cryptography` (Fernet) | vault at-rest encryption | `github.com/fernet/fernet-go` |
| (hashlib scrypt) | vault KDF | `golang.org/x/crypto/scrypt` |
| `PyYAML` | provisioning templates | `gopkg.in/yaml.v3` |
| stdlib `http.server` | everything | stdlib `net/http` (Go ≥1.22 `mux.HandleFunc("GET /api/data", …)` pattern routing) |
| — (new) | self-update | `github.com/creativeprojects/go-selfupdate` (GitHub-release discovery + checksum verify + Windows-safe binary swap; wraps the minio/selfupdate mechanics) |

That is the **entire** dependency budget: 5 Go modules + x/crypto. Anything else
is a STOP-and-justify.

## Repo layout for the Go code

Create alongside the Python (Python stays runnable until Phase 1 parity signs off):

```
go/
  go.mod                     module github.com/holland-built/bloxsmith
  main.go                    flags, env, vault auto-unlock, serve, open browser
  embed.go                   //go:embed ui/* templates/*
  ui/                        build artifact staging (copied by scripts/stage_ui.sh)
  internal/
    config/                  .env loader, all env vars (Phase 1a)
    httpx/                   restGet/restGetEx/restWrite + json/gzip/SSE writers (1b)
    vault/                   scrypt+Fernet vault, brand/logo, state-dir resolution (1a)
    auth/                    token/same-origin/RBAC/write-guard middleware (1b)
    store/                   audit chain, first-seen, snooze, saved views (1c)
    mcpclient/               streamable-HTTP MCP session + 4 tool wrappers + TTL cache + warmer (1d)
    fetch/                   dashboard/hub/tiles fetchers + all _norm_* (1d, 1e)
    dnsedit/                 _dns_rdata, record create/update, _edit_* builders (1f)
    provision/               templates, validators, block/site builders, teardown, retag, drift (1g)
    ai/                      system prompt, tool schema, Groq loop (1h)
    update/                  release check + self-apply (Phase 0 + 3)
    server/                  route table wiring all 92 endpoints (grows 1b→1h)
scripts/stage_ui.sh          copies index.html, app.bundle.js, vendor.*, *.woff2 → go/ui/
```

## Commands you will need (all phases)

| Purpose | Command | Expected on success |
|---|---|---|
| Stage the UI for embedding | `node scripts/build_ui.js && bash scripts/stage_ui.sh` | `go/ui/` contains index.html + app.bundle.js + 16 vendor files + 5 fonts |
| Build the binary (dev) | `cd go && go build -o bloxsmith .` | binary, no CGO, exit 0 |
| Version-stamped build | `go build -ldflags "-X main.version=1.0.$(git rev-list --count HEAD)" -o bloxsmith .` | `./bloxsmith --version` prints it |
| Run side-by-side with Python | `PORT=8090 ./bloxsmith` (Python stays on 8080) | both serve; parity harness can diff |
| Parity diff (Phase 1 gate, write once in 1b) | `bash go/parity.sh <endpoint>` | fetches `:8080<ep>` and `:8090<ep>`, normalizes volatile fields (`ts`, `instance_id`, `checked_at`, cache ages), diffs JSON — empty diff |
| Existing UI gate (unchanged) | `bash check.sh` | `✓ Type-check passed` |
| Cross-compile smoke | `GOOS=windows GOARCH=amd64 go build ./... && GOOS=linux GOARCH=arm64 go build ./...` | exit 0 (proves no accidental CGO/dep) |
| Release (Phase 2+) | `goreleaser release --clean` | archives + checksums + Homebrew/winget artifacts |

---

## Phase 0 — Proof of concept (de-risk before porting 6,500 lines)

**Goal**: prove the four load-bearing claims — embed works, proxy works,
self-update works, cross-compile works — in <500 lines of Go, before any port.

### Steps

1. `mkdir go && cd go && go mod init github.com/holland-built/bloxsmith`.
   Latest-stable gate: use the current stable Go toolchain (`go version` /
   https://go.dev/dl — do not pin from memory) and `go get` the latest stable
   `creativeprojects/go-selfupdate`.
2. Write `scripts/stage_ui.sh`: copy `index.html`, `app.bundle.js`,
   `vendor.*.js`, `vendor.importmap.json`, `vendor.astryx.css`, `*.woff2` from
   repo root into `go/ui/`. Idempotent, fails loudly if `app.bundle.js` missing.
3. `embed.go`: `//go:embed all:ui` → serve with `http.FileServerFS` on
   `localhost:8090`; `index.html` gets `Cache-Control: no-cache, no-store,
   must-revalidate` (mirror `server.py:6518`), other assets `no-cache`.
4. Port the `.env` loader (`server.py:27–39`) + `INFOBLOX_API_KEY`/
   `INFOBLOX_URL` env handling, and implement **one** real proxy endpoint:
   `GET /api/csp/host-health` — the simplest pure-REST tile
   (`server.py:5741–5756` + `_rest_get_ex` at 371 + `_norm_host_health` at
   3376). This exercises token auth, REST GET, normalization, and JSON reply.
5. Wire `internal/update`: `--version` flag (ldflags-injected),
   `GET /api/update/check` re-implemented against go-selfupdate's GitHub
   release detection (same JSON shape as `update_status` at `server.py:123–137`,
   with `"selfUpdate": true`), and a `bloxsmith update` CLI subcommand that
   applies the newest release binary.
6. Cut a **pre-release** test release (`gh release create v0.0.1-poc --prerelease`)
   with a goreleaser-built archive; verify an older local build detects and
   applies it, restarts, and reports the new version. (Use a fork or the
   `-poc` tag namespace so the Python app's banner — which compares
   `1.0.<n>` — never sees these tags: `_ver_n` at `server.py:82–87` parses
   `x.y.z`, and `0.0.1` < current, so it is inert. Verify that before pushing.)
7. On launch, `open http://localhost:8090` (macOS `open`, Windows
   `rundll32 url.dll`, Linux `xdg-open`) unless `--no-browser`.

### Done criteria (Phase 0)

- `go build` on macOS produces one binary; `file bloxsmith` shows a native
  executable; binary runs with **no** Python/Docker/Node on the machine.
- Browser opens, the full dashboard UI renders (most tiles will error —
  expected; only host-health has a backend), and the Host Health tile shows
  **real tenant data** with a real `INFOBLOX_API_KEY` in `.env`.
- `GOOS=windows` and `GOOS=linux` builds exit 0.
- The self-update loop completes: old binary → detects release → applies →
  relaunch shows new version in `/api/update/check`.
- ≤5 Go module dependencies in `go.mod` (excluding x/*).

**STOP**: if go-selfupdate cannot verify/apply from a GitHub release on macOS
within a day of effort, stop and report — evaluate `minio/selfupdate` +
hand-rolled release query before proceeding, but do not silently switch.

---

## Phase 1 — Port the backend by endpoint group (dependency order)

Rules for every sub-phase: (1) Python is the reference implementation — when the
plan and `server.py` disagree, `server.py` wins; port behavior, including quirks;
(2) each sub-phase ends with `parity.sh` green for its endpoints against the
live Python server on `:8080`; (3) commit per sub-phase; (4) no new deps beyond
the table above.

### 1a — Foundation: config, state dir, vault crypto — **M**

- Port: `.env` loader + all env vars (`server.py:27–160` — `INFOBLOX_API_KEY`,
  `INFOBLOX_URL`, `PORT`, `HOST`, `APP_VERSION`, `APP_REPO`,
  `DISABLE_UPDATE_CHECK`, `DASHBOARD_TOKEN`, `BLOCK_LIST_ID`, `GROQ_API_KEY`,
  `LLM_API_KEY`/`LLM_MODEL`/`LLM_BASE_URL`, `VAULT_DIR`, `VAULT_PASSPHRASE`,
  `VAULT_PASSPHRASE_FILE`, `TEMPLATES_DIR`).
- State dir: port `_resolve_vault_file` (2404) — try `$VAULT_DIR` (default
  `/vault`), else fall back. **New for laptops**: when neither is writable,
  default to `os.UserConfigDir()/bloxsmith/` (a binary's cwd is not a state
  dir). Container keeps `/vault` so the `noc-vault` volume carries over.
- Vault: port `_derive_key` (scrypt 2^15/8/1/32 → urlsafe b64), `_vault_save`
  (Fernet, `{"v":1,salt,data}`, chmod 600, tmp+rename), `_apply_active` (2783),
  `vault_init/unlock/lock/reset/tenant*/groq/llm/refresh-names` and the
  auto-unlock-from-env entry-point flow (6540–6556).
- **Round-trip test (mandatory)**: a Go test that decrypts a vault file created
  by the Python code (generate a fixture with a throwaway passphrase — never a
  real key) and re-encrypts one Python can read back.
- Endpoints live here: `/api/vault/status` + all 14 `/api/vault/*` POSTs,
  `/api/brand` GET/POST, `/api/logo` (5009 — note it can proxy a remote logo
  URL; read that block before porting).

### 1b — HTTP chassis: REST helpers, auth middleware, `_json`, static, routes — **M**

- Port `_rest_get` / `_rest_get_ex` / `_rest_write` (354–415): 35-s timeout,
  `Authorization` from the single mutable auth slot (make it a
  `sync.RWMutex`-guarded struct — fixes the long-known `_apply_active` race,
  `plans/README.md` session-2 rejects, without changing behavior),
  results/result unwrapping, error-body capture on HTTP errors.
- Port the auth/RBAC middleware (4885–5001): constant-time compare
  (`crypto/subtle`), `?token=` SSE fallback, same-origin/loopback logic,
  `MUTATING_PATHS`, `_write_guard` audit hook, `_resolve_role`.
- Port `_json` (6464): gzip >1KB when accepted; CORS reflection against the
  loopback allowlist; OPTIONS handler.
- Static serving from the embed FS replaces `_file` (6480) — traversal guard
  comes free with `http.FileServerFS`.
- Write `go/parity.sh` now (see commands table).
- Endpoints: `/`, static, `/api/update/check` (merge Phase 0's), `/api/sources`,
  `/api/cache-bust`, `/api/source/<path>` passthrough (4836 guard: must start
  `/api/`, plus the time-window row filter at 4857–4877).

### 1c — Local state stores: audit, views, first-seen, snooze, incidents — **M**

- Audit chain (2429–2459): **canonical-JSON gotcha** — Go must serialize
  sorted-key JSON with Python's default separators (`", "` and `": "`) before
  sha256, or every pre-migration `audit_log.jsonl` fails `audit_verify_chain`.
  Write the marshaler by hand (~30 lines) + a fixture test against a real
  Python-generated chain.
- Saved views (2682–2749): name sanitizer regex, atomic tmp+rename writes.
  Endpoints: `/api/views`, `/api/views/<name>` GET/PUT(+delete).
- First-seen store + grace/retention/`__meta__` downtime logic (2573–2639) —
  port the comments too; the away-vs-resolved distinction is load-bearing.
- Snooze store (2644–2674). Endpoint: `/api/alerts/snooze`.
- Incidents: `correlate` + `build_signals` (2489–2571) — pure functions, easy.
  Endpoints: `/api/incidents`, `/api/incidents/<cat>`, `/api/audit/log`,
  `/api/audit/export`, `/api/csp-audit` (REST `/api/auditlog/v1/logs` — see
  memory note: MCP AuditLog is broken, this is REST-only by design).

### 1d — MCP client + cache/warmer + `/api/data` + hub — **L** (highest-risk read path)

- `internal/mcpclient`: streamable-HTTP session (3059), `_tool_text`,
  `_columnar_to_dicts` (3068), `_query_all_rows` 100-row paging (3085 — the
  MCP inline cap, see memory), `_mcp_get` (3107), `_mcp_query_cube` (3147),
  `_mcp_search` (3184) with timeouts. Try the official go-sdk first; if its
  streamable-HTTP client can't complete `initialize`+`call_tool` against
  `https://csp.infoblox.com/mcp` in a spike, fall back to hand-rolled (STOP
  and note it, then proceed — the fallback is sanctioned).
- TTL cache (193–210) + warm loop (216–237) + account-switch/JWT refresh
  (239–353). Goroutine + ticker replaces the threads.
- All `_norm_*` (3335–3531) and `_fetch_dashboard_async` (3532) — in Go, fire
  the fetches as goroutines with an errgroup-style wait (stdlib
  `sync.WaitGroup` is fine).
- Endpoints: `/api/data`, `/api/whoami`, `/api/accounts`, `/api/switch-account`,
  `/api/hub/health`, `/api/hub/security`, `/api/hub/domains`, `/api/mcp/events`.
- Parity note: `/api/data` is multi-MB; `parity.sh` should compare row counts +
  sorted keys per section, not byte equality.

### 1e — The 15 CSP tiles + secondary fetchers — **M** (wide but shallow)

- Tiles (5741–5976) are thin: REST or cube fetch → `_norm_*` → `_json`. Port
  the `_cspq`/`_cspq_field` filter escapers (334–353) — these are the
  injection guards from plan 014; do not "simplify" them. Remember the
  `_filter`/`_tfilter` REST param names (memory: bare `filter` = silent 400).
- Secondary fetchers: `/api/actions`, `/api/insights`, `/api/dns-analytics`,
  `/api/host-metrics`, `/api/assets`, `/api/dossier`, `/api/lookalikes`,
  `/api/threat-lookup`, `/api/block-domain`, `/api/unblock-domain` (4160–4600;
  block/unblock require `BLOCK_LIST_ID` + FQDN regex 176).
- Endpoints: all 15 `/api/csp/*` + the 10 above + `/api/templates` list.

### 1f — DNS + edit write paths — **M**

- `_dns_rdata` (417 — the 10-type rdata builder), `_dns_record_create/update`
  (466/516; note the zone-vs-view mutual-exclusion comment), `_selfservice_allocate`
  + `_cidr_to_reverse_zone` (569–696; plan 016's orphan-IP compensation lives
  here — port it), the 9 `_edit_*` builders (697–1030).
- Endpoints: `/api/dns/records` POST/PUT, `/api/dns/records/<id>` DELETE,
  `/api/ipam/addresses/<id>` DELETE, `/api/selfservice/allocate`,
  `/api/edit/*` POST/PUT/DELETE, plus the read-side `/api/ipam/{spaces,blocks,
  subnets,addresses,availability}` and `/api/dns/{zones,records}` GETs (5296–5430).
- **Test against a sandbox tenant only.** Parity for writes = dry-run modes +
  create-then-delete of a throwaway record in a demo zone, never byte-diffing
  live mutations.

### 1g — Provisioning engines + SSE — **L** (highest-risk write path)

- Templates: YAML load, `_validate_site/block/dns` (1105–1319), `_parse_blocks`,
  the bool coercion helpers (1342–1361).
- The three engines: block builder + rollback (1391–1647), site builder +
  `_create_subnet` + rollback (1648–2024), retag (2025–2137), decommission/
  teardown (2138–2335), drift check (~2336–2400). This is ~1,400 lines of
  ordered create/rollback orchestration — port it **mechanically**, function by
  function, preserving rollback ordering and the failed-DELETE status checks
  from plan 017. Resist every refactor urge.
- SSE: Go `http.Flusher` wrapper matching the Python `emit()` event format
  exactly (the frontend EventSource parses it). Endpoints: the 5 `/stream`
  routes + `/api/templates/validate`, `/api/provision/block`,
  `/api/teardown/block`, `/api/retag/block`, `/api/drift/check`.
- Gate: full dry-run parity on every template in `templates/`, then ONE real
  seed-demo provision + teardown cycle on the sandbox tenant, diffing the SSE
  event sequences (minus timestamps) between Python and Go runs.

### 1h — AI query loop — **S/M**

- `_AI_SYSTEM` + `_TOOLS` schema (3851–3939) copied verbatim; `_run_tool`
  (3940); the 6-iteration tool loop (4044–4085) as plain HTTP against
  `LLM_BASE_URL`-or-Groq `chat/completions`; `_parse_ai_response` +
  `_clean_suggestions` (4088–4148). Endpoint: `/api/query`.

### Phase 1 exit gate

- `parity.sh` green on every GET endpoint (the 92-row inventory, checked off
  in this file as you go — edit the inventory to add `[x]` marks).
- The Playwright specs that target `:8080` (see `playwright_two_backends`
  memory: ~15 fail at baseline) run against the Go binary with **no more
  failures than the Python baseline**.
- `grep -c` the route table in `internal/server`: 92 registrations.
- Python `server.py` still untouched and runnable (it is the rollback).

---

## Phase 2 — Distribution: goreleaser, Releases, Homebrew, winget, container — **M**

1. `.goreleaser.yaml`: builds for `darwin/amd64`, `darwin/arm64` (+
   `universal_binaries: [{replace: true}]` for one macOS universal binary),
   `windows/amd64`, `linux/amd64`, `linux/arm64`; `CGO_ENABLED=0`;
   `-ldflags -X main.version=1.0.<git-count>` (keep the existing scheme —
   `SHIP.md` and `_ver_n` depend on `x.y.z` ordering); archives + `checksums.txt`
   (go-selfupdate verifies against it).
2. GitHub Actions release workflow: tag push `v1.0.*` → `node scripts/build_ui.js`
   → `stage_ui.sh` → `goreleaser release`. Note: automatic builds were
   deliberately turned OFF for the Docker path (`SHIP.md:11`) — releases stay
   tag-triggered/manual-intent, which preserves that decision.
3. Homebrew: goreleaser `brews:` block → a new `holland-built/homebrew-tap`
   repo. `brew install holland-built/tap/bloxsmith`.
4. winget: goreleaser `winget:` block → manifest PR to `microsoft/winget-pkgs`
   (unsigned binaries are accepted; SmartScreen warnings are a Phase 4 concern).
5. Container image for enterprise servers: replace `Dockerfile` with a 2-stage
   build (`golang:` builder → `FROM gcr.io/distroless/static` or `scratch` +
   the binary). Same env contract (`HOST=0.0.0.0`, `PORT`, `VAULT_DIR=/vault`,
   volume, `APP_VERSION`), same `docker-compose.yml`, same cosign signing —
   existing compose users update with zero config changes. `release-image.sh`
   shrinks to building this image (or moves into goreleaser `dockers:`).
6. Rewrite `SHIP.md`: `/release` = commit/push → `git tag v1.0.<n> && git push
   --tags` (CI does the rest), or `goreleaser release` locally.

**Done**: one tag produces macOS-universal + Windows + 2×Linux archives with
checksums, a Homebrew formula that installs on a clean Mac, a winget manifest
that validates (`winget validate`), and a ghcr image that boots under the
existing `docker-compose.yml` with a pre-existing `noc-vault` volume.

---

## Phase 3 — Self-update UX — **S/M**

1. Server behavior split by environment:
   - **Laptop (binary)**: `/api/update/check` returns `"selfUpdate": true`;
     new `POST /api/update/apply` (admin role + `_write_guard`, audit-logged,
     honoring the existing `_APPLY_COOLDOWN`=60s startup guard, `server.py:73`)
     runs go-selfupdate: download → checksum verify → swap → re-exec.
   - **Container** (`BLOXSMITH_IN_CONTAINER=1` baked into the image env):
     `"selfUpdate": false` — servers keep the deliberate, pinned,
     `docker compose pull` pipeline path (`SHIP.md:44` policy stands).
2. CLI: `bloxsmith update` (already from Phase 0) and `bloxsmith update --check`.
3. Frontend — **the one sanctioned exception to "frontend does not change"**:
   `UpdateBadge` in `src/96.chrome-topbar.jsx:193+` today only links to the
   release. Add an "Update now" button rendered **only when the payload has
   `selfUpdate: true`** → `POST /api/update/apply` → poll `/api/update/check`
   until `instance_id` changes (proves the restart), then reload. Because it is
   flag-gated, the same bundle stays correct in the container. Rebuild
   `app.bundle.js`, `bash check.sh`, restage.
4. Windows: go-selfupdate handles the rename-the-running-exe dance
   (`.old` + swap). Verify the applied-then-relaunch flow on a real Windows
   machine or VM — this is the platform where self-replace actually bites.

**Done**: on a Mac laptop install, banner → one click → new version running,
audit-log entry written; in the container, the banner still shows link-only.

---

## Phase 4 — Code signing (optional, later) — **M**, honest costs

- **macOS**: Apple Developer Program **$99/yr**. goreleaser `notarize:` block
  (or `quill` for CI-only, no Xcode). Without it: right-click-Open or
  `xattr -d com.apple.quarantine` — Homebrew installs are less affected;
  double-clicked downloads are most affected.
- **Windows**: OV Authenticode cert **~$200–400/yr** (Certum/SSL.com; EV +
  hardware token more, but instantly clears SmartScreen; OV clears it after
  reputation accrues). `signtool`/`osslsigncode` in the release workflow.
- **Linux**: nothing to buy — checksums + (optionally) cosign on the archives.
- Skip entirely until users outside the maintainer's own machines exist; winget
  + Homebrew both work unsigned.

---

## Risk register

| # | Risk | Severity | Escape hatch |
|---|---|---|---|
| R1 | **MCP streamable-HTTP client parity** — the Go SDK's client may handle the CSP `/mcp` endpoint's session/auth/columnar quirks differently than Python `mcp` 1.27.1; every `/api/data`-family endpoint sits on it | HIGH | Hand-roll the client: the app uses only `initialize` + `call_tool` on 4 tools over JSON-RPC/HTTP. Bounded, well-understood. Spike it in 1d before committing |
| R2 | **Provisioning write-path port (1g)** — ~1,400 lines of create/rollback orchestration; a transposed rollback step orphans real tenant objects (the exact bug class plans 016/017 fixed) | HIGH | Mechanical function-by-function port, dry-run parity on all templates first, sandbox tenant only, Python retained as rollback; if the SSE event sequences diverge, STOP |
| R3 | **Windows self-replace while running** — file locks, AV interference, the re-exec dance | MED | go-selfupdate exists precisely for this; verify on real Windows in Phase 3; fallback: `bloxsmith update` CLI (no in-app apply) on Windows only |
| R4 | **Audit-chain canonical JSON** — Go's `encoding/json` ≠ Python's `json.dumps(sort_keys=True)` byte-for-byte; old chains would verify as tampered | MED | Hand-written canonical marshaler + fixture test against a real Python-generated `audit_log.jsonl` (1c gate) |
| R5 | **Vault crypto compat** — a subtle scrypt/Fernet mismatch locks users out of stored tenant keys | MED (low likelihood — Fernet is a portable spec) | Mandatory Python↔Go round-trip fixture test in 1a; migration keeps the Python file format verbatim |
| R6 | **Silent endpoint drop** — 92 routes, if-elif chain, easy to miss one | MED | The inventory in this file IS the checklist; Phase 1 exit gate greps the route count and diffs every GET |
| R7 | **Non-expert maintainer inherits a Go codebase** | MED | Stdlib-first, 5-dep budget, package layout mirrors the Python regions 1:1 so `grep` habits transfer; every ported function keeps its Python name in a doc comment |

## Recommended order & effort summary

| Phase | What | Effort | Ship on its own? |
|---|---|---|---|
| 0 | PoC: embed + one proxy endpoint + self-update | **S/M** | yes (learning) |
| 1a–1c | config, vault, chassis, local stores | **M+M+M** | no |
| 1d–1e | MCP client, `/api/data`, tiles, fetchers | **L+M** | yes (read-only binary is already useful) |
| 1f–1h | DNS/edit writes, provisioning, AI | **M+L+S/M** | yes = full parity |
| 2 | goreleaser, brew, winget, container | **M** | yes |
| 3 | one-click self-update UX | **S/M** | yes |
| 4 | signing | **M** (optional) | later |

Order is strictly 0 → 1a…1h → 2 → 3 → 4. Do not reorder 1d before 1b (needs the
chassis) or 1g before 1f (shares the REST write helpers).

## STOP conditions (all phases)

- `server.py` functions cited here are missing or restructured beyond
  re-location by name (concurrent sessions edit master — see
  `concurrent_sessions` memory; consider doing this migration in a worktree).
- The vault round-trip test (1a) or audit-chain fixture test (1c) cannot be
  made to pass — do NOT ship a migration that bricks existing state.
- go-selfupdate cannot apply on macOS (Phase 0) or Windows (Phase 3) after a
  focused day each.
- Any sub-phase needs a dependency outside the 5-module budget.
- A provisioning dry-run or SSE event sequence diverges from Python (1g).
- Real (non-sandbox) tenant writes would be needed to verify anything.

## Out of scope (do not touch)

- Any file under `src/*.jsx` **except** the flag-gated `UpdateBadge` change in
  Phase 3; no frontend rewrite, no bundler, no framework changes.
- `server.py` itself — it is the reference and the rollback; it is deleted only
  in a later, separate retirement plan after Phase 1 parity has soaked.
- The Caddy TLS profile in `docker-compose.yml` (unchanged, still works in
  front of the Go container).
- LLM prompt/tool-schema content changes (verbatim copy only).
- The `templates/` third-party fetch convention (stays build-time, gitignored).
- Signing (Phase 4) until explicitly green-lit — it costs real money.
