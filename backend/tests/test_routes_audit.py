"""
Unit tests for backend/routes_audit.py.

CRITICAL: every test monkeypatches sessions._SESSIONS to a fresh dict and
audit_log.LOG_FILE to a path inside pytest's per-test tmp_path, matching
test_sessions.py / test_scim.py -- neither the real in-memory store nor the
real on-disk audit_log.jsonl is touched by this file. A standalone FastAPI()
app with only routes_audit.router is used instead of importing backend.main.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.audit import log as audit_log
from backend.auth import sessions
from backend.auth.roles import SESSION_COOKIE_NAME
from backend import routes_audit


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
    app.include_router(routes_audit.router)
    return TestClient(app)


def test_export_no_session_returns_401(client):
    resp = client.get("/api/audit/export")
    assert resp.status_code == 401


def test_export_viewer_or_operator_returns_403(client):
    session_id = sessions.create_session("u1", "viewer@example.com", "viewer")
    client.cookies.set(SESSION_COOKIE_NAME, session_id)

    resp = client.get("/api/audit/export")

    assert resp.status_code == 403


def test_export_admin_returns_200(client):
    session_id = sessions.create_session("u2", "admin@example.com", "admin")
    client.cookies.set(SESSION_COOKIE_NAME, session_id)

    resp = client.get("/api/audit/export")

    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body["entries"], list)
    assert body["chain_valid"] is True
    assert body["broken_index"] is None
