"""
Integration tests for role-based access control (RBAC) across the real,
fully-wired `backend.main.app` -- not a throwaway FastAPI app -- covering:

  - operator-gated POST /api/alerts/snooze (viewer -> 403, operator -> 200)
  - admin-gated GET /api/audit/export (operator -> 403, admin -> 200)
  - viewer-gated GET /api/alerts/incidents (no session -> 401, viewer -> 200)

Matches the isolation pattern from test_routes_alerts.py / test_routes_audit.py:
monkeypatch `backend.auth.sessions._SESSIONS` to a fresh dict and
`backend.audit.log.LOG_FILE` to a tmp_path file per test, and set
AUTH_DEV_MODE=1 via monkeypatch so POST /auth/dev-login is enabled
(routes_auth.py reads os.environ.get("AUTH_DEV_MODE") directly at call time,
so no settings-module reload is needed).

Each distinct role/session within a test uses its own fresh TestClient(app)
instance, since TestClient persists cookies across calls on the same instance.
"""

import pytest
from fastapi.testclient import TestClient

from backend.audit import log as audit_log
from backend.auth import sessions
from backend.main import app


@pytest.fixture(autouse=True)
def isolated_sessions(monkeypatch):
    """Match test_routes_alerts.py / test_routes_audit.py: fresh in-memory session store per test."""
    monkeypatch.setattr(sessions, "_SESSIONS", {})
    yield


@pytest.fixture(autouse=True)
def isolated_audit_log(tmp_path, monkeypatch):
    """Match test_routes_alerts.py / test_routes_audit.py: redirect the on-disk audit log to tmp_path."""
    monkeypatch.setattr(audit_log, "LOG_FILE", str(tmp_path / "audit_log.jsonl"))
    yield


def _dev_login(monkeypatch, email: str, role: str) -> TestClient:
    """Fresh TestClient + dev-login as the given role, so its cookie jar carries
    only this session (avoids cookie collisions between roles in the same test)."""
    monkeypatch.setenv("AUTH_DEV_MODE", "1")
    client = TestClient(app)
    r = client.post("/auth/dev-login", json={"email": email, "role": role})
    assert r.status_code == 200
    return client


def test_rbac_operator_route(monkeypatch):
    viewer_client = _dev_login(monkeypatch, "viewer@x.com", "viewer")
    r = viewer_client.post("/api/alerts/snooze", json={"category": "test-category", "minutes": 15})
    assert r.status_code == 403

    operator_client = _dev_login(monkeypatch, "operator@x.com", "operator")
    r = operator_client.post("/api/alerts/snooze", json={"category": "test-category", "minutes": 15})
    assert r.status_code == 200


def test_rbac_admin_route(monkeypatch):
    operator_client = _dev_login(monkeypatch, "operator@x.com", "operator")
    r = operator_client.get("/api/audit/export")
    assert r.status_code == 403

    admin_client = _dev_login(monkeypatch, "admin@x.com", "admin")
    r = admin_client.get("/api/audit/export")
    assert r.status_code == 200
    assert "chain_valid" in r.json()


def test_rbac_read_gate(monkeypatch):
    anon_client = TestClient(app)
    r = anon_client.get("/api/alerts/incidents")
    assert r.status_code == 401

    viewer_client = _dev_login(monkeypatch, "viewer@x.com", "viewer")
    r = viewer_client.get("/api/alerts/incidents")
    assert r.status_code == 200
