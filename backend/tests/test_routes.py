"""
FastAPI route/status-code/shape tests for `backend/routes_vault.py` +
the pre-existing `/health` endpoint, per the noc-dashboard step-2 plan
(brainstorms/noc-dashboard-step2-plan-2026-07-02.md, sections (f) and
"1. Success predicate").

Every test relies on the autouse `isolated_vault` fixture in conftest.py,
which points `vault.VAULT_FILE` at a per-test temp path and resets the
in-memory `_vault` dict before and after each test — so tests never touch
a real vault.json and never leak state between each other.
"""

import os

import pytest
from fastapi.testclient import TestClient

from backend import config
from backend.main import app

client = TestClient(app)


def test_unlock_wrong_passphrase_returns_401():
    # No vault_init has been called in this test, so this exercises the
    # "no vault yet" branch of vault_unlock, which is also a failure (ok=False).
    r = client.post("/api/vault/unlock", json={"passphrase": "definitely-wrong"})
    assert r.status_code == 401
    assert r.json().get("ok") is False


def test_init_valid_passphrase_returns_200_ok_true():
    r = client.post("/api/vault/init", json={"passphrase": "correct horse battery staple"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_tenant_while_locked_returns_400():
    # Fresh isolated vault for this test — no init/unlock has happened yet.
    r = client.post("/api/vault/tenant", json={"label": "test", "key": "abc123"})
    assert r.status_code == 400
    assert r.json().get("ok") is False


def test_active_unknown_tenant_after_unlock_returns_400():
    passphrase = "correct horse battery staple"
    init_r = client.post("/api/vault/init", json={"passphrase": passphrase})
    assert init_r.status_code == 200

    r = client.post("/api/vault/active", json={"id": "no-such-tenant-id"})
    assert r.status_code == 400
    assert r.json().get("ok") is False


def test_lock_no_auth_token_and_no_active_key_returns_401():
    assert not config.MCP_HEADERS.get("Authorization")
    r = client.post("/api/vault/lock")
    assert r.status_code == 401
    assert r.json() == {"ok": False, "error": "unauthorized"}


def test_reset_no_auth_returns_401():
    assert not config.MCP_HEADERS.get("Authorization")
    r = client.post("/api/vault/reset")
    assert r.status_code == 401
    assert r.json() == {"ok": False, "error": "unauthorized"}


def test_vault_status_returns_expected_keys():
    r = client.get("/api/vault/status")
    assert r.status_code == 200
    body = r.json()
    for key in ("version", "exists", "unlocked", "tenants"):
        assert key in body
    assert isinstance(body["tenants"], list)


def test_health_endpoint_unaffected():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def _repo_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _find_real_wapi_key():
    """Best-effort discovery of a real, usable Infoblox key reachable from
    this environment, per the plan's real-WAPI smoke-test spec:
    - a direct INFOBLOX_API_KEY env var, OR
    - a VAULT_PASSPHRASE/VAULT_PASSPHRASE_FILE that can unlock an EXISTING
      real vault.json (checked under VAULT_DIR or the repo root).
    Returns True if such a key is reachable, False otherwise. Does not
    mutate any module state — callers are responsible for unlocking.
    """
    if os.environ.get("INFOBLOX_API_KEY", "").strip():
        return True

    passphrase = os.environ.get("VAULT_PASSPHRASE", "").strip()
    passphrase_file = os.environ.get("VAULT_PASSPHRASE_FILE", "").strip()
    if not (passphrase or passphrase_file):
        return False

    candidate_dirs = [os.environ.get("VAULT_DIR", "/vault"), _repo_root()]
    return any(os.path.exists(os.path.join(d, "vault.json")) for d in candidate_dirs)


def test_accounts_real_key_or_documented_fallback_shape():
    """Real-WAPI smoke test.

    Per the plan, this environment is expected to have NEITHER a direct
    INFOBLOX_API_KEY NOR an existing real vault.json (`.env` only sets
    VAULT_PASSPHRASE, and no vault.json exists under VAULT_DIR or the repo
    root). In that documented case we do NOT skip — we still call
    GET /api/accounts and assert it returns the legacy reachable-but-no-key
    fallback shape at HTTP 200. This proves the fallback branch works even
    though full end-to-end real-data proof isn't possible in this
    environment. If a real key IS reachable, we additionally assert a
    non-empty accounts list to prove the real-data path.
    """
    has_real_key = _find_real_wapi_key()

    r = client.get("/api/accounts")
    assert r.status_code == 200
    body = r.json()

    if not has_real_key:
        # Documented environment limitation (see plan section "1. Success
        # predicate"): no INFOBLOX_API_KEY and no vault.json anywhere, so
        # /api/accounts hits the reachable-but-no-key branch, not real data.
        assert body.get("accounts") == []
        assert body.get("active") == ""
        assert isinstance(body.get("error"), str) and body["error"]
        assert "status" in body
    else:
        assert isinstance(body.get("accounts"), list)
        assert len(body["accounts"]) > 0
