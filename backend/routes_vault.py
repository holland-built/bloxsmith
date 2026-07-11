"""
Legacy `/api/vault/*` + `/api/accounts` route contract, ported 1:1 from
server.py's `do_GET`/`do_POST` dispatch (see server.py lines ~1675-1826).

Every route mirrors the legacy path, method, request-body shape, response
JSON, and status code EXACTLY so the existing frontend contract keeps
working unchanged. This file only wires HTTP <-> the already-ported logic
in `backend.vault` / `backend.mcp_client` — it must not reimplement any
vault/crypto/MCP logic itself.

CRITICAL: shared state lives in `backend.config`. This file imports the
MODULE (`from backend import config`) and reads attributes off it
(`config.MCP_HEADERS`, `config.DASHBOARD_TOKEN`) — never
`from backend.config import X`, which would bind an independent copy at
import time and miss later mutations (e.g. after a vault unlock).
"""

import hmac

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from backend import config, mcp_client, vault

router = APIRouter()


# ── request bodies (defaults mirror legacy `body.get(..., default)`) ──────────

class PassphraseBody(BaseModel):
    passphrase: str = ""


class TenantBody(BaseModel):
    label: str = ""
    key: str = ""
    groq: str | None = None


class TenantRemoveBody(BaseModel):
    id: str = ""


class TenantUpdateBody(BaseModel):
    id: str = ""
    key: str = ""
    label: str | None = None


class ActiveBody(BaseModel):
    id: str = ""


class ResetBody(BaseModel):
    confirm: str = ""


class GroqBody(BaseModel):
    key: str = ""


class LlmBody(BaseModel):
    key: str = ""
    base_url: str | None = None
    model: str | None = None


class TestKeyBody(BaseModel):
    key: str = ""


# ── auth helper for destructive endpoints ──────────────────────────────────────

def _authed(request: Request) -> bool:
    """Constant-time shared-secret check, mirroring server.py's
    Handler._authed(). False whenever DASHBOARD_TOKEN is unset."""
    if not config.DASHBOARD_TOKEN:
        return False
    supplied = request.headers.get("X-Auth-Token", "")
    return hmac.compare_digest(supplied, config.DASHBOARD_TOKEN)


# ── GET routes ──────────────────────────────────────────────────────────────

@router.get("/api/vault/status")
def get_vault_status():
    return vault.vault_status()


@router.get("/api/accounts")
def get_accounts(response: Response):
    try:
        return mcp_client.list_accounts()
    except Exception as e:
        status = getattr(e, "code", None)
        msg = f"CSP rejected this key ({status})" if status else "Infoblox CSP unreachable"
        return {"accounts": [], "active": "", "error": msg, "status": status}


# ── POST routes ─────────────────────────────────────────────────────────────

@router.post("/api/vault/init")
def post_vault_init(body: PassphraseBody):
    return vault.vault_init(body.passphrase)


@router.post("/api/vault/unlock")
def post_vault_unlock(body: PassphraseBody, response: Response):
    r = vault.vault_unlock(body.passphrase)
    response.status_code = 200 if r.get("ok") else 401
    return r


@router.post("/api/vault/tenant")
def post_vault_tenant(body: TenantBody, response: Response):
    # Validate key against CSP before persisting; block on explicit 4xx rejection.
    test = vault.vault_test_key(body.key)
    if test.get("rejected"):
        response.status_code = 400
        return {"ok": False, "error": test["error"]}
    r = vault.vault_add_tenant(body.label, body.key, body.groq)
    response.status_code = 200 if r.get("ok") else 400
    return r


@router.post("/api/vault/tenant-remove")
def post_vault_tenant_remove(body: TenantRemoveBody, response: Response):
    r = vault.vault_remove_tenant(body.id)
    response.status_code = 200 if r.get("ok") else 400
    return r


@router.post("/api/vault/tenant-update")
def post_vault_tenant_update(body: TenantUpdateBody, response: Response):
    r = vault.vault_update_tenant(body.id, body.key, body.label)
    response.status_code = 200 if r.get("ok") else 400
    return r


@router.post("/api/vault/active")
def post_vault_active(body: ActiveBody, response: Response):
    r = vault.vault_set_active(body.id)
    response.status_code = 200 if r.get("ok") else 400
    return r


@router.post("/api/vault/groq")
def post_vault_groq(body: GroqBody):
    return vault.vault_set_llm(body.key)


@router.post("/api/vault/llm")
def post_vault_llm(body: LlmBody):
    return vault.vault_set_llm(body.key, body.base_url, body.model)


@router.post("/api/vault/test-key")
def post_vault_test_key(body: TestKeyBody):
    return vault.vault_test_key(body.key)


@router.post("/api/vault/conn-test")
def post_vault_conn_test():
    return vault.vault_conn_test()


@router.post("/api/vault/llm-test")
async def post_vault_llm_test(body: LlmBody):
    """Not a verbatim port: `vault.vault_llm_test` uses `asyncio.run`
    internally, which raises inside an already-running event loop (this
    route handler is itself async, under uvicorn). Re-implemented inline
    as a direct `await` of the groq call instead (see brainstorms plan
    pre-mortem #6)."""
    import groq as _groq

    key = (body.key or "").strip() or vault._vault.get("groq", "")
    base = (body.base_url if body.base_url is not None else vault._vault.get("llm_base", "")).strip()
    mdl = (body.model if body.model else vault._vault.get("llm_model", "")) or config.LLM_MODEL
    if not key:
        return {"ok": False, "error": "API key required"}
    try:
        kw = {"api_key": key}
        if base:
            kw["base_url"] = base
        async with _groq.AsyncGroq(**kw) as c:
            await c.chat.completions.create(
                model=mdl, max_tokens=4,
                messages=[{"role": "user", "content": "ping"}],
            )
        return {"ok": True, "model": mdl}
    except Exception as e:
        vault._log_exc("vault_llm_test", e)
        return {"ok": False, "error": "LLM test failed"}


@router.post("/api/vault/refresh-names")
def post_vault_refresh_names():
    return vault.vault_refresh_names()


@router.post("/api/vault/lock")
def post_vault_lock(request: Request, response: Response):
    if not config.MCP_HEADERS.get("Authorization") and not _authed(request):
        response.status_code = 401
        return {"ok": False, "error": "unauthorized"}
    return vault.vault_lock()


@router.post("/api/vault/reset")
def post_vault_reset(body: ResetBody, request: Request, response: Response):
    # Allow unauthenticated reset when the caller confirms intent explicitly.
    # Authenticated callers (active key or dashboard token) bypass the confirm check.
    authed = config.MCP_HEADERS.get("Authorization") or _authed(request)
    if not authed and body.confirm != "RESET":
        response.status_code = 403
        return {"ok": False, "error": "Send {\"confirm\":\"RESET\"} to confirm"}
    return vault.vault_reset()
