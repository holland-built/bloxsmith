"""
Unit tests for backend/routes_auth.py and backend/auth/oidc.py.

CRITICAL: every test isolates sessions._SESSIONS (fresh dict) and
audit_log.LOG_FILE (tmp_path) so tests never leak state into each other or
into real on-disk/in-memory state -- see test_sessions.py / test_audit_chain.py.

Builds a standalone FastAPI() app including only routes_auth.router, so this
file never imports backend.main (other agents may be concurrently editing it).

Test 3 (OIDC): mocking authlib's Starlette OAuth2App internals to assert on a
live-looking redirect Location header proved awkward/flaky (it requires
faking server metadata fetch + the Starlette app's authorize_redirect
internals). Per the task's stated fallback, this file instead unit-tests the
two pure-logic surfaces directly: oidc.oidc_configured() and
oidc.role_from_claims() -- these prove the code-path logic without a live
HTTP round-trip, which matches the environment's stated limitation (no real
OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET here).
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import routes_auth
from backend.audit import log as audit_log
from backend.auth import oidc, sessions


@pytest.fixture(autouse=True)
def isolated_sessions(monkeypatch):
    monkeypatch.setattr(sessions, "_SESSIONS", {})
    yield


@pytest.fixture(autouse=True)
def isolated_audit_log(tmp_path, monkeypatch):
    monkeypatch.setattr(audit_log, "LOG_FILE", str(tmp_path / "audit_log.jsonl"))
    yield


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(routes_auth.router)
    return TestClient(app)


def test_dev_login_disabled_by_default(client, monkeypatch):
    monkeypatch.delenv("AUTH_DEV_MODE", raising=False)
    resp = client.post("/auth/dev-login", json={"email": "a@b.com", "role": "operator"})
    assert resp.status_code == 503
    assert resp.json() == {"detail": "Dev mode not enabled"}


def test_dev_login_integration(client, monkeypatch):
    monkeypatch.setenv("AUTH_DEV_MODE", "1")
    resp = client.post("/auth/dev-login", json={"email": "a@b.com", "role": "operator"})
    assert resp.status_code == 200
    assert resp.json() == {"email": "a@b.com", "role": "operator"}
    assert "set-cookie" in resp.headers

    me_resp = client.get("/auth/me")
    assert me_resp.status_code == 200
    assert me_resp.json() == {"email": "a@b.com", "role": "operator"}


def test_oidc_configured_true_when_all_env_vars_set(monkeypatch):
    monkeypatch.setenv("OIDC_ISSUER", "https://idp.example.com")
    monkeypatch.setenv("OIDC_CLIENT_ID", "dummy-client-id")
    monkeypatch.setenv("OIDC_CLIENT_SECRET", "dummy-secret")
    assert oidc.oidc_configured() is True


def test_oidc_configured_false_when_any_env_var_missing(monkeypatch):
    monkeypatch.delenv("OIDC_ISSUER", raising=False)
    monkeypatch.delenv("OIDC_CLIENT_ID", raising=False)
    monkeypatch.delenv("OIDC_CLIENT_SECRET", raising=False)
    assert oidc.oidc_configured() is False

    monkeypatch.setenv("OIDC_ISSUER", "https://idp.example.com")
    monkeypatch.setenv("OIDC_CLIENT_ID", "dummy-client-id")
    assert oidc.oidc_configured() is False


def test_role_from_claims_picks_highest_matching_role():
    assert oidc.role_from_claims({"roles": ["admin", "viewer"]}) == "admin"


def test_role_from_claims_defaults_to_viewer_when_no_match():
    assert oidc.role_from_claims({}) == "viewer"
    assert oidc.role_from_claims({"roles": ["nonexistent-role"]}) == "viewer"


def test_login_returns_503_when_not_configured_and_dev_mode_off(client, monkeypatch):
    monkeypatch.delenv("OIDC_ISSUER", raising=False)
    monkeypatch.delenv("OIDC_CLIENT_ID", raising=False)
    monkeypatch.delenv("OIDC_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("AUTH_DEV_MODE", raising=False)
    resp = client.get("/auth/login", follow_redirects=False)
    assert resp.status_code == 503
    assert resp.json() == {"detail": "No auth configured"}


def test_dev_login_writes_audit_entry(client, monkeypatch):
    monkeypatch.setenv("AUTH_DEV_MODE", "1")
    resp = client.post("/auth/dev-login", json={"email": "a@b.com", "role": "viewer"})
    assert resp.status_code == 200

    entries = audit_log.read_all()
    matching = [e for e in entries if e["event"] == "login_success"]
    assert len(matching) == 1
    assert matching[0]["sub"] == "a@b.com"
    assert matching[0]["email"] == "a@b.com"
    assert matching[0]["detail"] == {"method": "dev"}


def test_logout_clears_session_and_writes_audit_entry(client, monkeypatch):
    monkeypatch.setenv("AUTH_DEV_MODE", "1")
    login_resp = client.post("/auth/dev-login", json={"email": "a@b.com", "role": "viewer"})
    assert login_resp.status_code == 200

    logout_resp = client.post("/auth/logout")
    assert logout_resp.status_code == 200
    assert logout_resp.json() == {"ok": True}

    me_resp = client.get("/auth/me")
    assert me_resp.status_code == 401

    entries = audit_log.read_all()
    logout_events = [e for e in entries if e["event"] == "logout"]
    assert len(logout_events) == 1
    assert logout_events[0]["sub"] == "a@b.com"


def test_me_returns_401_when_not_authenticated(client):
    resp = client.get("/auth/me")
    assert resp.status_code == 401
