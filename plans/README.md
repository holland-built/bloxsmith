# Plans

Session 1 (`/improve` against commit `a682fa7`): over-engineering, YAGNI, boilerplate.
Session 2 (`/improve` against commit `5058ed6`): correctness bugs, security, a11y, perf — full audit.
Session 3 (`/improve` against commit `6f42354`): medium-priority reliability, a11y, correctness.

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

All 12 plans DONE. No open work in this list.

## Dependency graph

```
004 ──┐
005 ──┤
006 ──┤ (independent — run P1 first, then P2, then P3)
007 ──┤
008 ──┤
001 ──┤
002 ──┤
003 ──┘
```

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
