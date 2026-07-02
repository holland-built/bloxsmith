"""
Unit tests for backend/auth/roles.py.

CRITICAL: the require_role tests monkeypatch sessions._SESSIONS to a fresh
dict (see test_sessions.py) and audit_log.LOG_FILE to a path inside
pytest's tmp_path (see test_audit_chain.py) since a 403 denial now writes
an audit entry.
"""

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from backend.audit import log as audit_log
from backend.auth import sessions
from backend.auth.roles import Role, SESSION_COOKIE_NAME, require_role


@pytest.fixture(autouse=True)
def isolated_sessions(monkeypatch):
    monkeypatch.setattr(sessions, "_SESSIONS", {})
    yield


@pytest.fixture(autouse=True)
def isolated_audit_log(tmp_path, monkeypatch):
    monkeypatch.setattr(audit_log, "LOG_FILE", str(tmp_path / "audit_log.jsonl"))
    yield


def test_role_ordering():
    assert Role.viewer < Role.operator < Role.admin


def test_operator_gte_viewer_is_true():
    assert (Role.operator >= Role.viewer) is True


def test_viewer_gte_operator_is_false():
    assert (Role.viewer >= Role.operator) is False


def test_from_str_admin():
    assert Role.from_str("admin") == Role.admin


def test_from_str_bogus_defaults_to_viewer():
    assert Role.from_str("bogus") == Role.viewer


def _make_app():
    app = FastAPI()

    @app.get("/protected")
    def protected(session: dict = Depends(require_role(Role.operator))):
        return {"ok": True}

    return app


def test_require_role_no_cookie_returns_401():
    client = TestClient(_make_app())
    resp = client.get("/protected")
    assert resp.status_code == 401


def test_require_role_insufficient_role_returns_403():
    session_id = sessions.create_session("user-1", "viewer@example.com", "viewer")
    client = TestClient(_make_app())
    client.cookies.set(SESSION_COOKIE_NAME, session_id)

    resp = client.get("/protected")

    assert resp.status_code == 403


def test_require_role_sufficient_role_returns_200():
    session_id = sessions.create_session("user-2", "operator@example.com", "operator")
    client = TestClient(_make_app())
    client.cookies.set(SESSION_COOKIE_NAME, session_id)

    resp = client.get("/protected")

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
