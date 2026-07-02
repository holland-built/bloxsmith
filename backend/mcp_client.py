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

import json
from contextlib import asynccontextmanager

from mcp.client.streamable_http import streamablehttp_client
from mcp.client.session import ClientSession

from backend import config


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
