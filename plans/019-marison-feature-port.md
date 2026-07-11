# 019 — Port Chris Marison's Deleted-App Features into BloxSmith (Audit / Incidents / Provision)

Stamp: base commit `1164d94`
Status: IN PROGRESS — phased build.
Scope (in-bounds files ONLY): `index.html`, `server.py`, `test_regression.py`, this plan.
Do NOT: add a build step / npm / TypeScript / FastAPI / uvicorn; regress the React 19 ESM
importmap boot; delete existing tabs or features.

Source-of-truth tree (Chris's restored app): `/Users/sholland/AI/marison-review/` (branch
`restore-marison-apps`). Target tree: `/Users/sholland/AI/Infoblox MCP/`.

## Source map (Chris's module → this app)

| Chris module | Behavior | Lands in |
|---|---|---|
| `backend/audit/log.py` | append-only SHA-256 hash-chained log + `verify_chain()` | server.py audit module (Phase 1) |
| `backend/routes_audit.py` | one-endpoint evidence-pack export | `GET /api/audit/export` (Phase 1) |
| `backend/alerts/signals.py` | derive signals from network data | server.py `build_signals()` (Phase 2) |
| `backend/alerts/correlate.py` | group signals→incidents (pure fn) | server.py `correlate()` verbatim (Phase 2) |
| `backend/alerts/suppression.py` | on-disk snooze store | server.py snooze module (Phase 2) |
| `backend/routes_incidents.py` + `data/fetch_mcp.py` | MCP incidents/events | reuse `/api/actions`; add `/api/mcp/events` (Phase 2) |
| `backend/auth/roles.py` | viewer/operator/admin RBAC | lightweight role layer on `_write_ok`/`_authed` (Phase 3) |
| `backend/auth/{oidc,sessions,scim}.py` | OIDC SSO / SCIM | **DEFERRED — scoping note** |
| `src/components/AuditExportButton.tsx` | export button | Audit tab JSX (Phase 1) |
| `src/components/{TriagePanel,McpIncidentQueue,McpEventStream,SnoozeControl,SeverityBadge}.tsx` | incident UI | Incidents tab JSX (Phase 2) |

## Scoping — DEFER OIDC + SCIM (recommended)

Port the high-value core; omit enterprise SSO. Rationale: this app has NO multi-user login —
its only gate is `_write_ok()` (`DASHBOARD_TOKEN` shared secret OR same-origin/loopback,
server.py:~4381). No server-side sessions, no `session_id` cookie, no user store. OIDC
(`auth/oidc.py`) needs authlib + Starlette SessionMiddleware + a configured IdP; this app is
stdlib `http.server`, loopback, single-tenant. SCIM only revokes sessions by `sub` — with no
session store there is nothing to deprovision (dead code). We KEEP: tamper-evident audit log,
automatic mutation audit-logging, incident correlation + snooze, and a three-tier role model
layered on the existing gate. SSO = clean follow-on only if the user asks.

## Persistence (survives restart on `noc-vault` volume)

Reuse the app's already-resolved vault dir — do NOT re-probe:
```python
_STATE_DIR = os.path.dirname(VAULT_FILE)            # = /vault on the mounted noc-vault volume
AUDIT_LOG_FILE   = os.path.join(_STATE_DIR, "audit_log.jsonl")
ALERT_STATE_FILE = os.path.join(_STATE_DIR, "alert_state.json")
```

## Adaptation rules

- FastAPI async `Depends`/`Cookie` → stdlib sync branch in `do_GET`/`do_POST` after
  `_write_guard()`. `require_role(admin)` → inline `if not self._role_at_least('admin'): self._json({...},403); return`.
- `.tsx` → in-browser-Babel JSX in index.html, no imports/types; reuse `DataTable`, `Panel`,
  `SynthBand`, `SectionRule`, `KpiSpark`, `Freshness`, `Skeleton`, `toast`, `useApi`, `vpost`.
  Pattern to copy = existing `AuditTab` + `ProvisionTab`/`SelfServiceTab`.
- Atomic writes: tmp + `os.replace`; `threading.Lock` (server is ThreadingMixIn).
- Never log secrets — `audit_append` records actor/event/detail only.

---

# PHASE 1 — Immutable audit log + Audit tab + wire every mutation

**server.py — audit module** (near vault module, ~line 2365): port `backend/audit/log.py`:
```python
_audit_lock = threading.Lock()
def _audit_entry_hash(entry):
    payload = {k:v for k,v in entry.items() if k != "hash"}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
def audit_read():
    try:
        with open(AUDIT_LOG_FILE) as f: return [json.loads(l) for l in f if l.strip()]
    except FileNotFoundError: return []
def audit_append(event, actor, detail=None):
    with _audit_lock:
        entries = audit_read()
        prev = entries[-1]["hash"] if entries else "0"*64
        e = {"ts": time.time(), "event": event, "actor": actor, "detail": detail or {}, "prev_hash": prev}
        e["hash"] = _audit_entry_hash(e)
        with open(AUDIT_LOG_FILE, "a") as f: f.write(json.dumps(e)+"\n")
        return e
def audit_verify_chain():
    entries = audit_read(); prev = "0"*64
    for i,e in enumerate(entries):
        if e.get("prev_hash")!=prev or _audit_entry_hash(e)!=e.get("hash"):
            return {"valid": False, "broken_index": i}
        prev = e["hash"]
    return {"valid": True, "broken_index": None}
```
(`hashlib`/`json`/`os`/`threading`/`time` already imported.)

**server.py — GET routes** (in `do_GET`, near `/api/actions`):
```python
elif path == "/api/audit/log":
    chain = audit_verify_chain()
    self._json({"entries": audit_read(), "chain_valid": chain["valid"], "broken_index": chain["broken_index"]})
elif path == "/api/audit/export":
    chain = audit_verify_chain()
    self._json({"entries": audit_read(), "chain_valid": chain["valid"], "broken_index": chain["broken_index"],
                "exported_at": time.time(), "app_version": APP_VERSION})
```
(Both pure reads → pass `_write_guard`. `/api/audit/export` becomes admin-gated in Phase 3.)

**server.py — wire mutations**: at the success point of each mutating handler add one
`audit_append(...)`: `/api/block-domain`, `/api/unblock-domain`, `/api/selfservice/allocate`,
`/api/dns/records` POST+PATCH, `/api/provision/block`, `/api/teardown/block`, `/api/retag/block`,
and the SSE streams (`/api/provision/stream`, `/api/provision/site/stream`, `seed-demo`,
teardown streams) — log at the terminal `emit({"done"|"error"})`, `{"result":"success"|"failure"}`,
LIVE runs only (skip dry-run except the central breadcrumb). Central: in `_write_guard` add
`audit_append("write-authorized", who, {"method": self.command, "path": p})`.

**index.html — rebuild `AuditTab`** (replace body ~line 4637): swap mock source for
`useApi('/api/audit/log',{poll:15000})`; add CHAIN VALID/BROKEN `sev-badge`, `AuditExportButton`
(downloads `/api/audit/export` JSON blob), DataTable cols Time/Actor/Event/Detail. Follow existing
AuditTab scaffold (SynthBand/Panel/DataTable). Add `sev-badge` CSS (green ok / red crit) if absent.

**Tests** (test_regression.py): `test_audit_log_shape`, `test_audit_chain_valid`,
`test_audit_export_is_json_pack` (backend); `test_audit_module_wired`,
`test_audit_persists_on_vault_volume` (static server); `test_audit_tab_real_feed` (static index).

**Verify (:8090)**: docker run test container, cp server.py+index.html, restart, curl
`/api/audit/log` + `/api/audit/export` (chain_valid true), browser `#audit` shows CHAIN VALID +
populated table + Export downloads JSON.

---

# PHASE 2 — Incident correlation + Snooze + new Incidents tab

**server.py**: `correlate(signals)` copied verbatim from `alerts/correlate.py`; `build_signals(data)`
ported from `alerts/signals.py` adapted to the app's `/api/data` shape (subnets util/severity,
zones, leases) — reuse the existing assembled dashboard dict, no new upstream call; snooze store
from `alerts/suppression.py` using `ALERT_STATE_FILE` (atomic write + lock): `snooze/is_snoozed/active_snoozes`.

**Routes**: `GET /api/incidents` → `{incidents:[correlate(build_signals(data)) minus snoozed], snoozes}`;
`GET /api/mcp/events` → `fetch_mcp_events()` (mirror `_fetch_actions_async`, tool `iq-actions_get_events`,
degrade to `[]`). `POST /api/alerts/snooze` (add to MUTATING_PATHS): `{category,minutes}` → snooze +
`audit_append("snooze",...)`; operator-gated in Phase 3.

**index.html — new Incidents tab**: add `'incidents'` to TABS (between security+audit), `TAB_LABELS`,
nav icon, route dispatch → `<IncidentsTab/>`. Port `SeverityBadge`, `SnoozeControl`,
`TriagePanel`/`McpIncidentQueue`/`McpEventStream` onto DataTable/Panel: triage table (from
`/api/incidents`), SOC queue (reuse `/api/actions`), event stream (`/api/mcp/events`), snooze
control per category. Map MCP priority→severity client-side.

**Tests**: `test_correlate_groups_by_category` (exec-extract pure fn), `test_incidents_shape`,
`test_mcp_events_no_500`, `test_snooze_roundtrip` (backend); `test_incidents_tab_present`,
`test_no_tab_removed` (static).

**Verify (:8090)**: curl `/api/incidents`, `/api/mcp/events`, POST snooze → category hidden;
browser `#incidents` triage + queue + stream + snooze.

---

# PHASE 3 — Lightweight RBAC + Provision hardening

**server.py — role model** on the existing gate (no sessions):
```python
_ROLE_ORDER = {"viewer":0, "operator":1, "admin":2}
def _resolve_role(self):
    if DASHBOARD_TOKEN and self._authed(): return "admin"
    if self._write_ok(): return "operator"
    return "viewer"
def _role_at_least(self, need):
    have=_resolve_role(self)
    if _ROLE_ORDER[have] < _ROLE_ORDER[need]:
        audit_append("rbac_denied", have, {"required": need, "path": self.path.split('?')[0]}); return False
    return True
```
Gates (403 on fail): `/api/audit/export`→admin; `/api/alerts/snooze`→operator;
`/api/provision/*`,`/api/selfservice/allocate`,`/api/dns/records`,`/api/retag/block`→operator;
`/api/teardown/*`→admin. Passing gates call `audit_append` with resolved role as actor.
Add `GET /api/whoami` → `{role, token_auth}`. Default (no token, loopback)=operator → local
dashboard unchanged; teardown/export now require an admin token.

**index.html — Provision hardening**: `useApi('/api/whoami')`; in `ProvisionTab`+teardown/seed,
disable LIVE teardown/seed + confirm field unless `role==='admin'` (inline note); keep dry-run for
operator; toast server 403 role messages; role chip (`sev-badge`) in header. Reuse VaultGate/DegradedState idioms.

**Tests**: `test_whoami`, `test_teardown_block_requires_admin_without_token` (backend);
`test_rbac_layer_present` (+ assert no `from fastapi`/`import authlib`), `test_provision_role_gated` (static).

**Verify (:8090)**: `/api/whoami`=operator; operator dry-provision ok; admin-only teardown 403
without token; browser `#provision` role chip + disabled live-teardown.

## Sequencing

Phase 1 → 2 → 3. P2 snooze-logging + P3 rbac_denied-logging depend on P1 `audit_append`; P3 gates
reference P2 `/api/alerts/snooze`. Each phase leaves the app fully working (default loopback =
operator until an admin token is set).

## Escape hatch

If a module can't be ported faithfully into stdlib/single-file without a build step, STOP and
record the blocker — do NOT add npm/TS/FastAPI/uvicorn. OIDC/SCIM is a deliberate scoping omission,
not a blocker.
