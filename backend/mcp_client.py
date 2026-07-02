"""
MCP session context manager + CSP identity/account helpers.

Ported from server.py: `_mcp_session` (asynccontextmanager over
`streamablehttp_client` + `ClientSession`), `_csp_json`, and `list_accounts`.

Out of scope for this step (later steps): `switch_account`, `_maybe_refresh_jwt`,
`_mcp_get`, `_mcp_query_cube`, `_mcp_search`, and the `_fetch_*_async` dashboard
data functions.

CRITICAL: this module reads/writes shared state via the `config` module
attribute (`config.MCP_URL`, `config.MCP_HEADERS`, `config.BASE_URL`,
`config.API_KEY`, `config._HOME_ACCOUNT_ID`, `config._active_account_id`) —
never a bare-name import of those globals, so every module sees one source
of truth (see backend/config.py docstring).
"""

import asyncio
import json
import re
import sys
from contextlib import asynccontextmanager

from mcp.client.streamable_http import streamablehttp_client
from mcp.client.session import ClientSession

from backend import config
from backend.cache import _cache_key, _cache_get, _cache_set


# ── MCP helpers ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def _mcp_session():
    async with streamablehttp_client(config.MCP_URL, headers=config.MCP_HEADERS) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


# ── CSP identity endpoints (direct HTTP, not via MCP) ──────────────────────────

def _csp_json(path: str, body: dict | None = None) -> dict:
    """Small sync helper for CSP identity endpoints. Always authenticates with
    the original long-lived key so an expired account JWT can't lock us out."""
    from urllib.request import urlopen, Request
    data = json.dumps(body).encode() if body is not None else None
    req = Request(f"{config.BASE_URL}{path}", data=data,
                  headers={"Authorization": config.API_KEY,
                           "Content-Type": "application/json"})
    with urlopen(req, timeout=15) as r:
        parsed = json.loads(r.read())
        return parsed if isinstance(parsed, dict) else {}


def list_accounts() -> dict:
    accounts = [{"id": a.get("id", ""), "name": a.get("name", "")}
                for a in _csp_json("/v2/current_user/accounts").get("results", [])
                if a.get("state", "active") == "active"]
    accounts.sort(key=lambda a: a["name"].lower())
    if not config._HOME_ACCOUNT_ID:
        # resolve once: the account the raw API key is bound to
        try:
            home = _csp_json("/v2/current_user").get("result", {}).get("account_id", "")
        except Exception:
            home = ""
        config._HOME_ACCOUNT_ID = home or (accounts[0]["id"] if accounts else "")
        if not config._active_account_id:
            config._active_account_id = config._HOME_ACCOUNT_ID
    return {"accounts": accounts, "active": config._active_account_id}


# ── Generic paginated MCP fetch plumbing ────────────────────────────────────
# Ported verbatim from server.py (_TABLE_RE:445, _tool_text/_columnar_to_dicts/
# _results:880-899, _query_all_rows:900-920, _mcp_get:922-960).

# Allowlist: Parquet table names returned by MCP are alphanumeric + _ - and .
# (the name carries a .parquet extension, e.g. ipamsvc_ipam_subnet_get.parquet)
_TABLE_RE = re.compile(r'^[a-zA-Z0-9_][a-zA-Z0-9_.\-]{0,127}$')


def _tool_text(result) -> str:
    return result.content[0].text if result.content else "{}"


def _columnar_to_dicts(raw: dict) -> list:
    """Convert DuckDB columnar result {columns, data} to list of dicts."""
    inner = raw.get("results", raw)
    cols = inner.get("columns", [])
    rows = inner.get("data", [])
    return [dict(zip(cols, row)) for row in rows]


def _results(data) -> list:
    """Pass-through: _mcp_get now returns a list directly."""
    if isinstance(data, list):
        return data
    for key in ("data", "results", "items"):
        val = data.get(key)
        if isinstance(val, list):
            return val
    return []


async def _query_all_rows(session, table: str, row_count: int, label: str) -> list:
    """Page through stored Parquet 100 rows at a time — MCP caps inline data at 100."""
    PAGE = 100
    rows: list = []
    offset = 0
    while offset < row_count:
        try:
            r = await asyncio.wait_for(
                session.call_tool("infoblox-portal_query_stored_data", {
                    "task_description": f"Read rows {offset}–{offset+PAGE} from {label}",
                    "sql_query": f'SELECT * FROM "{table}" LIMIT {PAGE} OFFSET {offset}',
                }), timeout=30)
        except asyncio.TimeoutError:
            print(f"  [warn] MCP timeout: {label} (step 2 @ offset {offset})", file=sys.stderr)
            break
        batch = _columnar_to_dicts(json.loads(_tool_text(r)))
        if not batch:
            break
        rows.extend(batch)
        offset += PAGE
    return rows


async def _mcp_get(session, service: str, endpoint: str,
                   params: dict | None = None, fetch_all: bool = False) -> list:
    ck = _cache_key(service, endpoint, params, fetch_all)
    cached = _cache_get(ck)
    if cached is not None:
        return cached
    # Step 1: store data as Parquet
    args = {
        "task_description": f"Fetch {service} {endpoint} for NOC dashboard",
        "service_name": service,
        "endpoint": endpoint,
        "fetch_all": fetch_all,
    }
    if params:
        args["query_params"] = params
    try:
        r1 = await asyncio.wait_for(
            session.call_tool("infoblox-portal_make_get_request", args), timeout=30)
    except asyncio.TimeoutError:
        print(f"  [warn] MCP timeout: {service}/{endpoint} (step 1)", file=sys.stderr)
        return []
    try:
        meta = json.loads(_tool_text(r1))
    except json.JSONDecodeError:
        return []
    if not isinstance(meta, dict):
        return []
    table = meta.get("table_name", "")
    if not table or not _TABLE_RE.match(table) or meta.get("row_count", 0) == 0:
        return []
    # Step 2: page through stored Parquet (MCP caps inline rows at 100)
    try:
        result = await _query_all_rows(session, table, meta.get("row_count", 0),
                                       f"{service}/{endpoint}")
        _cache_set(ck, result)
        return result
    except Exception as e:
        print(f"  [warn] _mcp_get {service}/{endpoint}: {e}", file=sys.stderr)
        return []
