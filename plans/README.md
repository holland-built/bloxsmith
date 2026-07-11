# Plans

Session 1 (`/improve` against commit `a682fa7`): over-engineering, YAGNI, boilerplate.
Session 2 (`/improve` against commit `5058ed6`): correctness bugs, security, a11y, perf — full audit.
Session 3 (`/improve` against commit `6f42354`): medium-priority reliability, a11y, correctness.
Session 4 (`/improve` against commit `61b1e6e`): audit of the unaudited provisioning suite (Phases 1-3) + AI + pivot — RED test baseline, injection, orphaned-state bugs, perf.

## Execution order

| # | Plan | Category | Effort | Priority | Status | Depends on |
|---|---|---|---|---|---|---|
| 001 | [Delete dead prop-types.min.js](001-delete-dead-prop-types.md) | delete | S | P3 | DONE | — |
| 002 | [Extract `_run_async` helper](002-run-async-helper.md) | shrink | S | P3 | DONE | — |
| 003 | [Drop SUGGESTIONS: fallback](003-drop-parse-ai-suggestions-fallback.md) | YAGNI | S | P3 | DONE | — |
| 004 | [Fix loadInFlight.current never reset](004-loadinflight-reset.md) | bug | S | P1 | DONE | — |
| 005 | [Validate Content-Length in do_POST](005-content-length-validation.md) | security | S | P1 | DONE | — |
| 006 | [Guard /api/update/apply with auth](006-update-apply-auth.md) | security | S | P1 | DONE | — |
| 007 | [Paginate PoliciesPanel](007-policies-panel-pagination.md) | perf | S | P1 | DONE | — |
| 008 | [aria-current on nav tabs + OVB keyboard](008-nav-aria-current.md) | a11y | S | P2 | DONE | — |
| 009 | [AbortController for lazyFetch](009-lazyfetch-abortcontroller.md) | bug/memory | S | P2 | DONE | — |
| 010 | [_csp_json type guard](010-csp-json-type-guard.md) | bug | S | P2 | DONE | — |
| 011 | [asyncio timeout on _mcp_search](011-mcp-search-timeout.md) | reliability | S | P2 | DONE | — |
| 012 | [aria-hidden/label on status dots](012-status-dot-aria.md) | a11y | S | P2 | DONE | — |
| 013 | [Fix RED test baseline (structural marker/tab asserts)](013-fix-red-test-baseline.md) | test | S | P0 | DONE | — |
| 014 | [CSP filter-injection escaper (~38 sites)](014-csp-filter-injection-escaper.md) | security | M | P0 | DONE | 013 |
| 015 | [gzip JSON responses (`_json`)](015-gzip-json-responses.md) | perf | S | P0 | DONE | 013 |
| 016 | [Allocate orphan-IP compensation + DNS validation](016-allocate-orphan-ip-compensation.md) | bug | M | P0 | DONE | 013 |
| 017 | [Rollback failed-DELETE status checks](017-rollback-failed-delete-checks.md) | bug | S | P0 | DONE | 013 |

Plans 001-017 DONE. **Session 4 (013-017) implemented in window-b @ 6fe4836** — reviewed hunk-by-hunk, 52-test offline suite green (incl. new ServerSecurityTests). End-to-end HTTP checks (gzip curl, SSE 400) pending a deploy window on the shared container.

## Dependency graph

```
001-012 ── all DONE

013 (green baseline — land FIRST) ──┬── 014  (provision-hardening cluster: 014/016/017
                                    ├── 015   touch the actively-evolving provision code;
                                    ├── 016   re-locate by function name if lines drifted)
                                    └── 017
```
013 must land before the rest so the suite is green (a real regression can be told from the stale baseline). 015 (gzip) is independent and safe to do anytime after 013. 014/016/017 all edit `server.py` provisioning code that a parallel effort is actively growing — coordinate / re-locate by symbol.

## Considered and rejected (session 1)

- **if-elif routing dispatch in Handler** — 35+ branches across do_GET/do_POST. Dict dispatch slightly cleaner but pattern is readable, explicit, not a bug source. Not worth it.
- **`_do_recreate` as inner closure** — 120-line function inside apply_self_update. Module-level move is readability-only; zero behavior change. Self-update system intentionally self-contained. Not worth it.
- **`_parse_ai_response` attempt 2 (JSON scan)** — Legitimate: real LLMs prepend reasoning prose before JSON. Keep.
- **MOCK data in index.html** — Documented intentional fallback for SE demo mode and offline use. Keep.

## Considered and rejected (session 2)

- **Keyboard drag reorder for bento cards** — Requires major refactor of drag system. Too complex; visual reorder via Settings modal is acceptable workaround. Skip.
- **Type scale consolidation** — 5 type sizes per card. Swiss-design ideal is ≤3. Requires touching 100+ call sites with no clear ROI for NOC use case. Skip.
- **Per-card loading skeletons** — Medium effort for marginal UX improvement; existing spinner pattern is sufficient. Skip.
- **`--teal` CSS var rename** — Low impact rename; no bug. Skip.
- **TopBar /api/accounts on every render** — FALSE POSITIVE. `useEffect(()=>{...},[])` at line 4914-4919 has empty dep array, fires once. Rejected.
- **`_apply_active()` globals without mutex (server.py:597-607)** — HIGH risk to fix (refactor entire active-tenant state); skip until proper async migration.
- **Color-only status dots (~27 call-sites)** — Valid a11y finding but M effort with many touch points. Not planned this session.
- **Modal focus traps (7 modals)** — Valid a11y finding, M effort. Not planned this session.
- **`lazyFetch` no AbortController** — MEDIUM priority, not blocking. Not planned.
- **`lazyPanel` stale closure in useEffect** — MEDIUM priority. Not planned.
- **`_csp_json` AttributeError risk (server.py:498-507)** — MEDIUM. Not planned.
- **`_mcp_search` no asyncio timeout (server.py:994-1003)** — MEDIUM. Not planned.
- **TOCTOU vault unlock check (server.py:689-708)** — MEDIUM. Not planned.
- **DHCP threshold constants scattered 15+ locations** — Refactor to constants block, M effort. Not planned.
- **Filter chip disabled state opacity-only** — MEDIUM a11y. Not planned.

## Considered and rejected (session 4)

- **Add a build step / precompile JSX (in-browser Babel)** — "Fixing" it kills the deliberate no-build, single-file, `docker cp`-hotpatch design (the tool's whole point: zero-install SE demo, offline). Cost is a one-time cold-load transpile on an always-on screen. **Document the tradeoff; cap `index.html` growth instead (push logic to server.py).** Skip.
- **Cube-paging perf (`_query_all_rows`, 50 serial round-trips)** — Optimizes an endpoint that returns nothing (stateless-cube bug leaves analytics blank). Polishing a dead path; DIR-01 (REST aggregation) *replaces* it. Skip.
- **`_apply_active` global-tenant-creds race — full contextvar fix** — Real cross-tenant smell, but L effort + HIGH risk on the live write path. Document + schedule; interim = per-request lock. Not planned this session (same call as session 2).
- **Split `index.html`** — Fights the no-build rule; PROVISION region is nested inside ASKGLOBAL (interleaved) so a clean file split is costly. Split `server.py` instead (arch finding, not planned this batch). Skip index split.
- **Dead-code / treemap-residue sweep + style-IIFE dedup** — Tidiness not bugs; `.ovx`/DataTable are healthy live reuse; treemap "residue" is one stale comment. ROI ≈ zero — sweep opportunistically. Skip.
- **SSE token-in-URL (SEC-04)** — Only matters when `DASHBOARD_TOKEN` is set AND LAN-exposed; audit log already strips it; loopback default = no real exposure. Fold the proper fix (HttpOnly cookie / POST+job-id) into the EventSource-reconnect rework if that happens. Not standalone.
- **React 18.2 → 18.3 bump** — No EOL/security driver; 18.3 is the React-19 migration shim. Pure churn. Skip.

### Not planned this session but VALID (candidates for session 5)

- **SEC-03** internal/upstream detail leaked via SSE `emit({"error":str(e)})` + raw ProvisionError bodies — S, HIGH-conf. Funnel through the `_json` sanitizer.
- **BUG-03** EventSource auto-reconnect can re-run a live mutation stream — M. (Fold SEC-04 in here.)
- **BUG-02** non-idempotent allocate/provision (resubmit duplicates) — M.
- **SEC-02** path injection via unvalidated ids into REST write URLs — S.
- **TEST-02** zero tests on the provision write path — M (dry-run characterization tests).
- **PERF (warmer skips cold tabs, 7 sequential dashboard fetches)** — S/M.
- **DOCS** README/DEPLOYMENT frame a read-only tool; no dry-run/token runbook — M.
- **DEP-02** build-time template fetch from third-party repo unpinned — S, supply-chain.
- **ARCH** split `server.py` into stdlib modules (no build constraint) — M.

### Direction (roadmap options, not defects)

DIR-01 un-blank DNS analytics/insights via REST aggregation (strongest grounding, L) · DIR-02 confirm-gated AI write actions (M-L) · DIR-03 RBAC/multi-user for the now write-capable tool (L) · DIR-04 provisioning audit-trail UI (M) · DIR-05 shareable saved views (M) · DIR-06 template gallery (M).
