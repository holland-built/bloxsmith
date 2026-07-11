# Plan 018: Migrate the BloxSmith dashboard from React 18 UMD to React 19 (ESM), no bundler, to enable Meta's Astryx design system

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> "STOP condition" occurs, stop and report — do not improvise, do NOT fall back to a
> live CDN (breaks the offline design principle), and do NOT add a bundler/build step
> (breaks the no-build design principle). When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `python3 -c "d=open('index.html','rb').read(); print(d.count(b'<script src=\"react.min.js\">'), d.count(b'text/babel'))"`
> Expected: `1 1`. If the boot markup has already changed, re-read the boot region
> before proceeding. `index.html` contains NUL bytes — ALWAYS read it NUL-safe:
> `python3 -c "print(open('index.html','rb').read().replace(b'\x00',b' ').decode('utf-8','replace'))"`.
> Never plain-grep it.

## Status

- **Priority**: P2 (on-the-shelf enabler — build only when an Astryx component is wanted)
- **Effort**: M
- **Risk**: MEDIUM (dedupe is the #1 failure mode; see Risks)
- **Depends on**: none
- **Category**: platform / dependency migration
- **Planned at**: commit `b0b1776`, 2026-07-11
- **Spike**: PROVEN working in a browser — React 19.2.7 ESM + Astryx 0.1.4 + `dist/astryx.css` renders themed components no-build.

---

## Goal & hard constraints

Replace the three UMD `<script src>` tags (`react.min.js`, `react-dom.min.js`,
`babel.min.js`) with a React 19 ESM boot using an import map, WITHOUT adding a
bundler/build step and WITHOUT any runtime CDN, so `@astryxdesign/core@0.1.4`
components (Button, Card, Badge, ChatComposer, ChatLayout, ChatMessage,
ChatMessageBubble, Theme, ThemeContext, generateThemeCSS, defineTheme) can be
dropped in later.

Hard constraints (do not violate):
- **Offline at runtime** — zero network to esm.sh/unpkg/jsdelivr/cdnjs after the
  page loads. All modules + CSS are vendored locally.
- **No build step** — in-browser Babel Standalone stays; `babel.min.js` is kept.
- **Single React instance (dedupe)** — Astryx, react-dom, and react/jsx-runtime must
  all consume ONE vendored `react` (19.2.7). This is the proven root cause of
  `TypeError: Cannot read properties of null (reading 'use')`.

React version proven by the spike: **19.2.7**. Astryx: **0.1.4**. Do not re-derive.

---

## Verified current state (commit b0b1776)

- `index.html` — 6016 lines, ~345 KB, 2 NUL bytes. Head loads, in order:
  `<script src="react.min.js">`, `<script src="react-dom.min.js">`,
  `<script src="babel.min.js">`, an inline `<script>` no-flash theme boot, then ONE
  app block: `<script type="text/babel" data-presets="react">`.
- The app block's FIRST line already is:
  `const {useState,useEffect,useRef,useCallback,useMemo}=React;` — exactly ONE such
  destructuring line (do NOT add a second; redeclaration SyntaxError in module mode).
- Mount: `ReactDOM.createRoot(document.getElementById('root')).render(<App/>)` — single createRoot.
- Global API usage that must keep working: `React.Fragment`, `React.createContext` ×4
  (DataCtx, PowerCtx, FilterCtx, AuthCtx), `React.useContext` ×4, `React.memo`,
  `ReactDOM.createRoot` ×1, **`ReactDOM.createPortal` ×1** (overlay/modal).
- **React 19 removed-API scan — ALL CLEAN**: `ReactDOM.render(`=0, `defaultProps`=0,
  string refs=0, `propTypes`=0, `contextTypes`/`childContextTypes`=0. No body rewrites needed.

### Serving constraints in `server.py` (SHOWSTOPPERS — server.py is OUT OF SCOPE)

1. **Static routing is a FLAT top-level allowlist**: `_STATIC_FILES = frozenset(os.listdir(DIR))`
   (top level only). A request for `vendor/react.mjs` (subdir) is NOT in the allowlist →
   answered with `index.html` → module load fails. ⇒ **Vendored files MUST live at the
   app root (flat), not in a `vendor/` subdirectory.**
2. **MIME map lacks `.mjs`**: unknown extensions serve as `application/octet-stream`,
   which browsers REFUSE to execute as ES modules. ⇒ **Vendored ES modules MUST use `.js`.**

Name the flat top-level files with a `vendor.` prefix. `Dockerfile` does `COPY *.js ./`
and `COPY *.woff2 ./` — the `vendor.*.js` modules ride `COPY *.js` automatically; the one
CSS file needs a `COPY *.css ./` line (or inline it).

---

## Vendored file layout (final — all flat at repo root, `.js` extension)

| Import specifier | Vendored file | esm.sh source (fetch at install) |
|---|---|---|
| `react` | `vendor.react.js` | `https://esm.sh/react@19.2.7?target=es2022&bundle` |
| `react/jsx-runtime` | `vendor.react-jsx-runtime.js` | `https://esm.sh/react@19.2.7/jsx-runtime?target=es2022&external=react` |
| `react-dom` | `vendor.react-dom.js` | `https://esm.sh/react-dom@19.2.7?target=es2022&external=react&bundle` |
| `react-dom/client` | `vendor.react-dom-client.js` | `https://esm.sh/react-dom@19.2.7/client?target=es2022&external=react,react-dom&bundle` |
| `@astryxdesign/core` | `vendor.astryx.js` | `https://esm.sh/@astryxdesign/core@0.1.4?target=es2022&external=react,react-dom&bundle` |
| (stylesheet) | `vendor.astryx.css` | `https://esm.sh/@astryxdesign/core@0.1.4/dist/astryx.css` |

**Dedupe rationale (#1 failure mode):** `external=react` on every module ⇒ each keeps a
bare `import … from "react"`/`"react/jsx-runtime"`, all resolved by the import map to the
single `vendor.react.js`. `external=react,react-dom` on the client ⇒ `createRoot` +
`createPortal` share ONE react-dom instance (else context won't cross portals).
`external=react,react-dom` on Astryx ⇒ Astryx uses the page's React (spike's proven fix).

---

## Step 1 — Vendoring (offline preservation)

**Action A** — add `scripts/fetch_vendor.py` (Python stdlib only, mirror
`scripts/fetch_templates.py`: `urllib.request`, timeout, logging, writes to app root).
Downloads the six URLs into the six flat filenames. After each download, assert no
residual absolute-URL imports (offline gate):

```
python3 - <<'PY'
import re,glob,sys
bad=[]
for f in glob.glob('vendor.*.js'):
    t=open(f,encoding='utf-8',errors='replace').read()
    for m in re.finditer(r'''(?:import|from)\s*["']([^"']+)["']''',t):
        s=m.group(1)
        if s.startswith('http') or 'esm.sh' in s: bad.append((f,s))
print('RESIDUAL_CDN_IMPORTS:',bad); sys.exit(1 if bad else 0)
PY
```
Expected: `RESIDUAL_CDN_IMPORTS: []`, exit 0. If a bare specifier other than
`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `scheduler` remains,
extend the import map (vendor `scheduler` too — see Risks).

**Action B** — commit the vendored artifacts. `react.min.js`/`react-dom.min.js`/`babel.min.js`
are all committed today, so commit `vendor.*.js` + `vendor.astryx.css` (no `.gitignore`
entry); `scripts/fetch_vendor.py` exists for reproducible upgrades. Keeps bare-clone
open + `docker build` offline. (Alternative `templates/`-style gitignore+Dockerfile-fetch
rejected: makes docker build need network.)

**Action C** — after Step 4 passes: `git rm react.min.js react-dom.min.js` (KEEP `babel.min.js`).

STOP: any esm.sh URL non-200, or residual-CDN gate non-empty and unresolvable via import-map.

---

## Step 2 — index.html boot rewrite (only the boot region changes)

**2a.** In `<head>`, replace the two react UMD tags; keep Babel; add importmap + Astryx CSS:
```html
<script type="importmap">
{ "imports": {
  "react": "./vendor.react.js",
  "react/jsx-runtime": "./vendor.react-jsx-runtime.js",
  "react-dom": "./vendor.react-dom.js",
  "react-dom/client": "./vendor.react-dom-client.js",
  "@astryxdesign/core": "./vendor.astryx.js"
}}
</script>
<link rel="stylesheet" href="vendor.astryx.css">
<script src="babel.min.js"></script>
```
(importmap MUST appear before any module/Babel executes.)

**2b.** Change the app block open tag to:
`<script type="text/babel" data-type="module" data-presets="react">`
(keep `data-presets="react"` = classic JSX runtime → `React.createElement`, needs React in scope.)

**2c.** Prepend ONE new block at the top of the app block, ABOVE the existing
`const {useState,…}=React;` line (do NOT duplicate that line):
```js
import React from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import * as Astryx from "@astryxdesign/core";
const ReactDOM = { createRoot, createPortal };
const { Button, Card, Badge, ChatComposer, ChatLayout, ChatMessage, ChatMessageBubble,
        Theme, ThemeContext, generateThemeCSS, defineTheme } = Astryx;
window.Astryx = Astryx; // smoke-test hook only
```

**jsx-runtime fallback**: app stays classic runtime; `react/jsx-runtime` is mapped SOLELY
for Astryx's internal automatic-runtime import. If Astryx still errors on `jsx-runtime`,
verify the map path resolves `./` relative to index.html and `vendor.react-jsx-runtime.js`
was fetched `external=react`. If unresolvable offline after a genuine attempt → STOP
(escape hatch); do NOT un-external Astryx (2nd React) or point at a CDN.

STOP: any console error mentioning `jsx-runtime`, `Cannot read properties of null (reading 'use')`, or a bare specifier failing to resolve.

---

## Step 3 — Astryx CSS + theming (respect existing light/dark toggle)

`vendor.astryx.css` (~123 KB pre-compiled StyleX atomic rules — no compiler needed) is
loaded via the `<link>` in 2a. **Ship it** either by a `COPY *.css ./` Dockerfile line
(primary; `.css` already in MIME map + allowlist, no server.py change) OR inline into a
`<style id="astryx-css">` (fallback; +123 KB to index.html, zero Docker change).

**Theme mapping** — the no-flash boot sets `document.documentElement.dataset.theme`.
1. Enumerate Astryx token vars: `grep -oE '\-\-[a-z][a-z0-9-]*' vendor.astryx.css | sort -u | head -80`.
2. Add a `<style>` AFTER the Astryx stylesheet overriding those tokens with app vars,
   scoped `:root,[data-theme="dark"]{…}` + `[data-theme="light"]{…}`; because the app's
   own `--accent/--bg/--text/…` already flip on theme, mapping Astryx tokens to `var(--…)`
   makes Astryx follow the toggle automatically.
3. Fallback if atomic classes bake literal colors: use `defineTheme(...)` + inject
   `generateThemeCSS(theme)` and wrap Astryx subtrees in `<Theme>`/`ThemeContext`.

Verify: mount one Astryx `<Button>` (Step 4), toggle light/dark, confirm bg/text change.

---

## Step 4 — Verification gates (NEVER on shared prod :8080 first)

**4a.** Isolated test container on spare port:
```
docker run -d --name bloxsmith-test -p 127.0.0.1:8090:8080 \
  --volumes-from bloxsmith \
  --env-file <(docker inspect bloxsmith --format '{{range .Config.Env}}{{println .}}{{end}}') \
  ghcr.io/holland-built/bloxsmith:latest
```
**4b.** `docker cp` index.html + the six vendored files into `bloxsmith-test:/app/`, then
`docker restart bloxsmith-test` (refreshes `_STATIC_FILES = frozenset(os.listdir(DIR))`).

**4c. MIME + offline (curl)**: `curl -sI http://127.0.0.1:8090/vendor.react.js | grep -i content-type`
→ expect `application/javascript` for each `vendor.*.js`, `text/css` for the CSS. Any
`text/html` = not in allowlist (wrong location/name) → fix first.

**4d. Browser gate (Playwright — repo has `playwright.config.ts`+`tests/`)** vs `:8090`:
- `React.version` starts `19.`
- ZERO console errors (`page.on('console'…'error')` + `pageerror`)
- ZERO runtime CDN requests (`page.on('request'…)`, none match `esm.sh|unpkg|jsdelivr|cdnjs`)
- ALL 10 tab hashes render (`overview,daily,network,dns,infra,security,audit,provision,drift,selfservice`): `#root` non-empty, no console error per nav
- Astryx `<Button>` renders themed (computed `padding≈8px 12px`, `border-radius≈8px`); toggle theme → bg changes

**4e. Portal smoke**: open the modal/overlay (uses `createPortal`), confirm it renders +
reads app context — proves createRoot/createPortal share one react-dom instance.

STOP: any console error, any runtime CDN request, any empty `#root`, or unstyled Astryx button.
Only after ALL gates pass on `:8090`: promote per `SHIP.md`, then `docker rm -f bloxsmith-test`.

---

## Step 5 — Scope boundaries

- **In scope**: `index.html` (boot region + prepended header + theme-map `<style>`), the
  six flat `vendor.*` assets, `scripts/fetch_vendor.py`, one Dockerfile `COPY *.css ./`
  line IF shipping CSS as a file, `git rm react.min.js react-dom.min.js` after cutover,
  and the `plans/README.md` status row.
- **OUT of scope**: `server.py` (another window edits it — the flat-`.js` layout is designed
  to need zero server.py change). A `vendor/` subdir or `.mjs` would REQUIRE a coordinated
  server.py change — hand to the owner.
- **OUT of scope**: internal logic of the 10 tab components.
- **Escape hatch**: if Babel-module + import-map + jsx-runtime can't work offline after a
  genuine attempt → STOP and report. No live CDN, no bundler.

---

## Risks & maintenance

1. **Dedupe (#1).** One React only; every vendored module `external=react` (client + Astryx
   also `external=react-dom`). Version mismatch/bundled 2nd copy → `null (reading 'use')`.
   Upgrading React = bump the version in ALL six URLs together + re-run the residual gate.
2. **`scheduler` dup.** If the gate shows each react-dom inlined its own scheduler, add
   `scheduler` to `external`, vendor `vendor.scheduler.js`, add a `"scheduler"` map entry.
3. **React 19 removed APIs — already clean** (scanned NUL-safe). Future edits reintroducing
   them must migrate.
4. **Babel Standalone still required** (JSX transformed in-browser, module mode).
5. **Static serving fragility.** Files MUST stay flat root + `.js`/`.css`. Step-4c curl catches regressions.
6. **createPortal / react-dom instance.** Client fetched `external=react,react-dom` so
   portals share the reconciler + context with the root. Step-4e guards this.

## Rollback

Revert `index.html`, restore the two `<script src="react*.min.js">` tags, `git checkout`
the two UMD files, remove vendored files + the Dockerfile CSS line. Artifacts committed →
rollback = single `git revert` of the migration commit.
