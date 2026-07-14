# STACK-EVOLUTION-PLAN.md — Bloxsmith

Grounded in the actual tree: `index.html` (9,835 lines; one `<script type="text/babel" data-type="module">` spanning L868→L9833, mounted by `ReactDOM.createRoot(document.getElementById('root')).render(<App/>)` at L9832), `server.py` (6,224 lines, stdlib `BaseHTTPRequestHandler` with `do_GET`/`do_POST` dispatch), and the vendored React-19 ESM bundles + `vendor.importmap.json`. Four phases, each shipping independently, app driveable in-browser after every one.

## Sequencing rationale
1. **Split first (P1)** because every later phase edits code that today lives in one 9k-line blob — the merge-collision tax is paid on P2/P3/P4 work until the file is carved. P1 changes structure only, zero behavior.
2. **Write-path isolation + identity + wizard (P2)** next because it creates the `mutations` module that P3 types and P4 stamps with digests. Wizard/DEMO chrome is bundled here because it gates the write surfaces.
3. **Scoped types (P3)** ride on the P2 module boundary — you can't `// @ts-check` a file that doesn't exist yet.
4. **GHCR hardening (P4)** last because digest-stamped audit (P2) and the typed mutation payload (P3) are prerequisites for "every mutation tagged with the image digest" and out-of-band rollback.

---

## PHASE 1 — ES-MODULE SPLIT (no build tool)

### Goal
Carve the single Babel blob (L868–L9833) into native ES modules loaded via `<script type="module">` + the existing importmap, killing (a) the merge-collision problem (every feature touches the same file) and (b) the Babel-in-browser deopt (2.8 MB `babel.min.js` at L39 recompiling ~9k lines on every cold load).

### The JSX-compilation decision (the core tradeoff)
There are two ways to keep JSX working with "no build tool":

- **Option A — Babel-per-module in the browser.** Keep `babel.min.js`; make each carved file its own `<script type="text/babel" data-type="module">`. **This does not work cleanly and does not meet the goal.** `@babel/standalone`'s `transformScriptTags` (confirmed present in the vendored `babel.min.js`, `data-type` handling in its `runScripts` path) compiles each module to a Blob and dynamic-`import()`s it; relative specifiers like `./components/DataTable.js` resolve against the `blob:` URL, not the document, so cross-module imports break. It also *increases* the deopt (N compiles instead of one). Reject.
- **Option B — precompile at author/CI time (RECOMMENDED).** Author JSX in `src/**/*.jsx`; a ~30-line transform (`scripts/build_ui.py`, reusing the already-vendored `babel.min.js` run under Node, or `@babel/core` invoked only on the dev/CI side) lowers JSX to `react/jsx-runtime` calls — **which are already in `vendor.importmap.json`** (`"react/jsx-runtime"`). Output is committed plain-ESM `components/*.js` / `tabs/*.js`. `index.html` loads them with native `<script type="module">`. **Babel-in-browser is deleted** (drops the 2.8 MB download + the deopt entirely). This is the only path that hits *both* stated goals.

**Why B is still "no build tool":** no Vite, no bundler, no dev-server, and **no `node_modules` in the container**. The transform runs on the dev machine / in the existing `.github/workflows/docker-publish.yml` before `COPY`. The `Dockerfile` and `Caddyfile` are unchanged in spirit — the container keeps serving static `.js` exactly as today.

> If the team hard-vetoes any author-side transform, fall back to Option A **but only for the merge-collision win**, accept the deopt stays, and forbid cross-module relative imports (wire modules through a single `window.Bx` namespace instead). Document this as a known regression against the deopt goal.

### Import graph / what goes where
Carve along the existing region banners (the `─────` comment blocks mapped):
- `lib/ls.js` — `LS` helper (L878).
- `lib/api.js` — `useApi` (L1023), `vpost` (L3265), `DataCtx`/`/api/data` feed (L1074–1083).
- `lib/router.js` — hash router + `TABS` array (L3082–3122).
- `components/DataTable.js` — `DataTable` (L2137), `DTRow` (L1645), diff primitives `diffRows` (L3766), `ActionBar` confirm (L1577).
- `components/Freshness.js`, `components/Toasts.js` (L1085, L1108).
- `components/Vault/*.js` — VaultGate/tenant manager/`BrandEdit` (L3264–3600, L3466).
- `components/UpdateBadge.js` — L9237.
- `tabs/OverviewTab.js` (L4668), `DailyTab.js` (L5075), `NetworkTab.js` (L5412), `DnsTab.js` (L5687), `InfraTab.js` (L5893), `SecurityTab.js` (L6644), `IncidentsTab.js` (L7164), `AuditTab.js` (L7045), `ProvisionTab.js` (L7867), `SelfServiceTab.js` (L7346), `EditorTab.js` (L8440), `DriftTab.js` (L8603), `ProvisionGroupTab.js` (L9015).
- `app/Shell.js` (L9433), `app/App.js` (L9828) — the entry module, imported last.

Shared React handles: keep the `import React from "react"` + `import * as Astryx from "@astryxdesign/core"` (L869–873) in the entry module; other modules `import React from "react"` (resolved by importmap) rather than reading `window.React`. Kill the `window.React = React` globals once nothing depends on them (grep first — several tabs read `window.React`).

### What stays in `index.html`
The `<head>`: importmap (L7–14), `vendor.astryx.css` link, `#astryx-theme-map` style, no-flash theme boot (L40–55), all inline CSS, the `#root` boot-splash (L858–865), and a **single** `<script type="module" src="./app/App.js">`. Remove `<script src="babel.min.js">` (L39) under Option B.

### Dockerfile note (real gotcha)
`Dockerfile` uses `COPY *.js ./` — **flat glob, misses subdirectories.** Either (a) keep all modules flat (`bx.DataTable.js`, `bx.OverviewTab.js`) and serve from root, or (b) add `COPY components ./components` / `COPY tabs ./tabs` lines. Recommend (a) for minimum Dockerfile churn — matches the existing flat `vendor.*.js` convention and `_STATIC_FILES = frozenset(os.listdir(DIR))` (server.py L473) which only lists the top dir. **If you nest, you must also teach the static-file server to serve subpaths** (it currently checks `path.lstrip("/") in _STATIC_FILES`, L5644). Flat is the low-risk choice.

### What could break + browser verification
- Module load order / circular imports → white screen. Verify: load `http://127.0.0.1:8080`, confirm boot-splash is replaced by the Overview bento, no console errors.
- Static server 404s on new files → drive every tab (`#overview`…`#provision`), watch Network tab for 404s.
- `window.React`/`window.Astryx` consumers → grep and drive Security/Provision tabs (heaviest Astryx users).
- Regression harness: run `test_regression.py` / `playwright.config.ts` suite — must stay green.

### Size
Large (mechanical, ~9k lines relocated) but low-complexity. ~2–3 executor sessions. Add the transform script + wire CI: ~½ session.

### Ships-independently checkpoint
✅ App is byte-for-byte behaviorally identical; only the file layout changed. Merge-collision and Babel deopt both resolved. Docker/Caddy unchanged.

---

## PHASE 2 — WRITE-PATH ISOLATION + IDENTITY + WIZARD

### Goal
Every CSP mutation flows through one client module with a single confirm→diff→rollback interface; every write records the real CSP actor + running image digest; first-run users land in a guided connect-or-demo wizard with unmissable persistent DEMO chrome.

### 2a. Mutation module (client)
Create `lib/mutations.js` exposing one interface, e.g. `commit(descriptor) → {ok, receipt}` where `descriptor` = `{ verb, resource, tenantLabel, endpoint, method, body, describeBlastRadius(), rollback() }`. Route **all** existing writes through it — today they're scattered raw `fetch`/`vpost` calls:
- `SelfServiceTab` allocate → `/api/selfservice/allocate` (L7562).
- `DnsTab`/`SelfServiceTab` records → `/api/dns/records` POST/PATCH/DELETE (L7430/7454/7470).
- `EditorTab` → `/api/edit/<resource>` (L8440+; server dispatch dict `server.py` L1284).
- `SecurityTab`/`SecDomainPanels` → `/api/block-domain`/`/api/unblock-domain` (L6223/6333/6571).
- `ProvisionTab` → `/api/provision/*` SSE streams + teardown (L7955–8052).
- `DriftTab` → `/api/drift/check` (L8603).

Server side these are already gated (`MUTATING_PATHS`, `server.py` L457; `_write_guard`, L4953) — the client module wraps them, it does not replace the server gate.

### Write-button UX = ONE decisive step
Replace the scattered confirmations (`ActionBar` confirm L1577, `tenant-confirm` L3210, per-tab typed-`DELETE` at ProvisionTab L7924) with one `<CommitDialog>`:
- **Tenant named in plain English** — resolve the active tenant *label* (from the vault active tenant, `vault_status`, `server.py` L3258; UI already has it via `/api/whoami` + account slot) — "You are about to write to **Acme Production**", never a tenant UUID.
- **Before→after as blast radius, not raw JSON** — reuse the diff vocabulary already in the codebase: `diffRows` (L3766) + the `dt-diff` +/−/~ glyph cells (CSS L349–356). Show "creates 3 subnets, retags 12 hosts, deletes 1 zone", not a JSON blob.
- **Real rollback button that persists at the point of action** — the descriptor's `rollback()` (calls the inverse endpoint; server already has compensation logic — `BlockProvisioner` rollback, `server.py` L1676, plans 016/017 "orphan-ip-compensation"/"failed-delete-checks"). Persist the rollback receipt to `LS` (`bx.` namespace) + surface it in `AuditTab` (L7045) so it survives navigation, not just a transient toast.

### 2b. Identity — ride CSP identity
Today `_actor()` (`server.py` L4949) is `"loopback" | <ip>` — no real identity. Change it to resolve the CSP-authenticated user:
- The backend already mints a CSP JWT (`_csp_json` L574, `_JWT_REFRESH_AFTER` L560). Add a cached `_csp_identity()` that decodes the JWT `sub`/email or calls CSP `current_user`, cached alongside the JWT refresh.
- Make `_actor()` return that identity; keep loopback/IP as fallback when the vault is single-key/unauthenticated.
- Every `audit_append(event, actor, detail)` call site (26 of them, L5395–6011) automatically upgrades — no signature change (`audit_append`, L2748, already takes `actor`).

### 2c. Harden audit — actor + image digest
- Capture the running image digest once at boot: read `container.attrs["Image"]` (the recreate path already inspects this, `server.py` L285) or `RepoDigests`; store in a module global next to `_INSTANCE_ID` (used in `update_status`, L144).
- Extend `audit_append` `detail` to always include `{image_digest, instance_id}`. The hash-chain (`_audit_entry_hash` L2737, `audit_verify_chain` L2758) covers `detail`, so digests become tamper-evident for free.

### 2d. First-run wizard + DEMO chrome
- **Trigger:** reuse the existing first-run signals — `firstRun` (DailyTab L5084), the auto-open-once tour (L9776), and `vault_exists()`/`vault_status` (`server.py` L2971/3258). Show the wizard when no vault + no data.
- **Two doors:** "Connect CSP" (guided into the existing VaultGate/tenant flow, `/api/vault/init`+`/api/vault/tenant`, L3336–3390) OR "Load demo data" (the existing seed path — `ProvisionTab` Seed-demo, `/api/provision/seed-demo/stream` L8025).
- **Persistent DEMO chrome:** when demo-seeded, set `LS.set('mode','demo')` and render an all-session colored rail + badge (new component `components/DemoChrome.js`, mounted in `Shell` L9433). Unmissable, survives every tab, only cleared by connecting a real tenant.

### What could break + browser verification
- A write path missed during the module migration still calls raw `fetch` → bypasses the dialog. Verify by driving **every** write: allocate an IP (SelfService), create+edit+delete a DNS record (Dns), block a domain (Security), run a Provision block, then check `/api/audit/log` (L5082) shows actor + digest for each.
- Rollback inverse endpoint wrong → orphaned objects. Verify: allocate → rollback → confirm the object is gone in the IPAM tab.
- CSP identity resolution failing under single-key mode → audit actor blank. Verify both vault mode and `INFOBLOX_API_KEY` env mode.
- Wizard mis-fires for existing users. Verify: existing vault → no wizard; wiped `bx.` LS + empty vault → wizard.

### Size
Large. Mutation module + dialog ~1.5 sessions; identity+audit ~½ session; wizard+DEMO chrome ~1 session.

### Ships-independently checkpoint
✅ All writes work as before but now flow through one auditable, rollback-backed dialog; audit log shows real actor + digest; new users get wizard + DEMO badge. Read paths untouched.

---

## PHASE 3 — SCOPED TYPES (checkJS on mutations/audit/rollback only)

### Goal
Catch payload-shape bugs where mutations are catastrophic — **only** on the P2 client modules, not the 9k-line UI, not Python.

### Minimal config
`tsconfig.json` at repo root:
```jsonc
{
  "compilerOptions": {
    "checkJs": true, "allowJs": true, "noEmit": true,
    "target": "es2022", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "skipLibCheck": true
  },
  "include": ["lib/mutations.js", "lib/audit.js", "components/CommitDialog.js"]
}
```
Only `include`d files are checked. `noEmit` → types-only, no build output, no runtime change. Run via `npx tsc --noEmit` in CI (dev-side only; still no `node_modules` in the container).

### Example typed payload (JSDoc)
```js
/**
 * @typedef {Object} MutationDescriptor
 * @property {'create'|'update'|'delete'|'allocate'|'block'} verb
 * @property {'subnet'|'dns_zone'|'dhcp_range'|'host'|'address_block'|'domain'} resource
 * @property {string} tenantLabel            // plain-English tenant name
 * @property {string} endpoint               // e.g. '/api/edit/subnet'
 * @property {'POST'|'PATCH'|'DELETE'} method
 * @property {Record<string, unknown>} body
 * @property {() => BlastRadius} describeBlastRadius
 * @property {() => Promise<Receipt>} rollback
 */
// @ts-check
```
`resource` union mirrors the server `_EDIT_DISPATCH` keys (`server.py` L1284) — a typo like `"subnett"` now fails `tsc` instead of a 500 at write time.

### What could break + verification
- Nothing at runtime (types-only). Verify `tsc --noEmit` passes in CI and the app still boots + writes in-browser (drive one allocate + one delete).

### Size
Small. ½ session.

### Ships-independently checkpoint
✅ CI gains a type gate on the dangerous modules; runtime unchanged.

---

## PHASE 4 — GHCR HARDENING

### Goal
Signed, digest-pinned images; admin-approved updates (auto-update OFF for enterprise, opt-in for demo laptops); every mutation stamped with the running digest; out-of-band rollback that works when the app won't boot.

### 4a. cosign-sign in CI
`.github/workflows/docker-publish.yml`: after `Build and push`, add `sigstore/cosign-installer` + `cosign sign --yes ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}` (keyless OIDC — the workflow already has `id-token`-capable `packages: write`; add `id-token: write`). Emit the digest as a build output.

### 4b. Digest-pin
`docker-compose.yml`: change `image: ghcr.io/holland-built/bloxsmith:latest` to `...@sha256:<digest>`, with `latest` kept only as a comment. Document `cosign verify` in `SHIP.md` before pinning a new digest.

### 4c. Admin-approved updates (default auto-update OFF for enterprise)
- Add `AUTO_UPDATE` env (default `off`). The **Watchtower sidecar** in `docker-compose.yml` (`noc-watchtower`, label-triggered) is the current auto path — gate it behind a `--profile autoupdate` so it's **off by default**; demo laptops opt in with `docker compose --profile autoupdate up`.
- The in-app `UpdateBadge` (`index.html` L9237) → `apply_self_update` (`server.py` L229) stays as the **admin-approved manual** path; gate `/api/update/apply` (L5726) behind admin role (`_role_at_least('admin')`, L4980) so only an authorized operator can trigger it.

### 4d. Every mutation tagged with image digest
Already delivered in P2 (2c) — verify the digest recorded is the *signed* digest (`RepoDigests`, not the local image id). This closes the loop: audit entry ↔ signed image provenance.

### 4e. Out-of-band rollback (works when the app won't boot)
The app already preserves the prior image: `apply_self_update`'s `_do_recreate` tags `bloxsmith:previous` and records the version via `_write_prev_version` (`server.py` L282–288, `_PREV_FILE`). But that path runs *inside* the app — useless if the new image won't start. Add:
- **CLI/script `rollback.sh`** (companion to `update.sh`): `docker run` / `docker compose` recreate from `bloxsmith:previous` (or the pinned previous digest) with the same volumes — no app process needed.
- **Env-var revert:** document setting the compose `image:` back to the previous `@sha256` and `docker compose up -d`.
- Keep `_read_prev_version` (L2731) as the source of truth for what "previous" is; persist the previous **digest** (not just version) to `_PREV_FILE` so the CLI can pin exactly.

### Doc/config changes
- **`SHIP.md`:** add cosign-verify + digest-pin steps; note auto-update is opt-in.
- **`update.sh`:** already correctly labeled DEV-ONLY hot-swap — add a pointer to `rollback.sh` for real reverts.
- **`docker-compose.yml`:** digest-pin, `AUTO_UPDATE` profile, keep the `/var/run/docker.sock` mount (required for in-app apply) but document removing it to disable self-update entirely.
- **CI:** cosign step + `id-token: write`.

### What could break + verification
- cosign keyless misconfig → CI red. Verify workflow run + `cosign verify` locally.
- Digest-pin typo → container won't pull. Verify `docker compose pull` on a clean host.
- Rollback script recreates without the `noc-vault` volume → vault lost. Verify: update → break new image deliberately → `rollback.sh` → app boots on prior version with vault intact.
- Admin-gate on `/api/update/apply` locking out legitimate operators. Verify both token and loopback modes drive the UpdateBadge apply.

### Size
Medium. CI+cosign ½ session; compose/scripts ½; admin-gate + digest persistence ½.

### Ships-independently checkpoint
✅ Images signed + pinned, updates admin-gated (enterprise auto-off), mutations carry signed digest, and a boot-failed instance can be reverted from the shell. No dependence on later work.

---

## Deferred (future phases, named trip-wires)
| Item | Trigger to build | Why not now |
|------|------------------|-------------|
| Vite build | Measured cold-load regression after P1 precompile | P1 precompile already removes the Babel deopt; Vite adds bundler upkeep for no current gain |
| Full SSO / RBAC / multi-tenant | A signed enterprise deal that contractually requires it | Speculative identity stack for a solo+AI team; CSP-inherited actor identity (P2) covers audit today |
| Database | State outgrows in-memory + vault | Current TTL cache + cache-warmer + encrypted vault are sufficient |

## Risk register
| # | Risk | Phase | Mitigation |
|---|------|-------|-----------|
| R1 | Babel-per-module blob-URL relative imports silently break | P1 | Recommend precompile (Option B); if Option A, forbid cross-module relative imports |
| R2 | `Dockerfile` `COPY *.js` flat glob misses nested modules; `_STATIC_FILES` won't serve subpaths | P1 | Keep modules flat (matches `vendor.*.js`); only nest if server static handler is taught subpaths |
| R3 | A write path missed in the mutation-module migration bypasses the dialog & audit | P2 | Grep every `fetch(...POST/PATCH/DELETE` + `vpost`; drive all 6 write flows in-browser |
| R4 | CSP identity unresolved in single-key/env mode → blank actor | P2 | Fallback to loopback/IP; verify both vault and `INFOBLOX_API_KEY` modes |
| R5 | Rollback inverse endpoint wrong → orphaned CSP objects | P2 | Lean on existing server compensation (plans 016/017); verify object gone after rollback |
| R6 | Type gate creates false friction / CI flake | P3 | `skipLibCheck`, scoped `include` only, `noEmit` |
| R7 | Digest-pin/cosign misconfig blocks pulls or CI | P4 | Verify on clean host + `cosign verify` before pinning |
| R8 | Out-of-band rollback drops the `noc-vault` volume | P4 | `rollback.sh` reuses named volume; verify vault survives |
| R9 | Regression suite (`test_regression.py`, Playwright) drift across phases | all | Run after each phase; it is the gate |

**Verification method for all phases:** this app is verified by driving it in a real browser (`http://127.0.0.1:8080` via `run.sh`/`dev.sh`), watching the console + Network tab, plus the `test_regression.py` / Playwright suite — reference the existing `verify-*.png` convention for evidence.

### Critical Files for Implementation
- `index.html`
- `server.py`
- `docker-compose.yml`
- `.github/workflows/docker-publish.yml`
- `Dockerfile`
