"""
Unit tests for backend/routes_scim.py.

CRITICAL: every test monkeypatches sessions._SESSIONS to a fresh dict and
audit_log.LOG_FILE to a path inside pytest's per-test tmp_path, matching
test_sessions.py / test_audit_chain.py -- neither the real in-memory store
nor the real on-disk audit_log.jsonl is touched by this file. A standalone
FastAPI() app with only routes_scim.router is used instead of importing
backend.main.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.auth import sessions
from backend.audit import log as audit_log
from backend import routes_scim


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
    app.include_router(routes_scim.router)
    return TestClient(app)


def _deprovision_body():
    return {"Operations": [{"op": "replace", "path": "active", "value": False}]}


def test_scim_deprovision_invalidates_session(client, monkeypatch):
    monkeypatch.setenv("SCIM_BEARER_TOKEN", "test-secret")

    session_id = sessions.create_session(sub="u1", email="u1@x.com", role="viewer")
    assert sessions.get_session(session_id) is not None

    resp = client.patch(
        "/scim/v2/Users/u1",
        json=_deprovision_body(),
        headers={"Authorization": "Bearer test-secret"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"id": "u1", "active": False}
    assert sessions.get_session(session_id) is None


def test_scim_bearer_required(client, monkeypatch):
    monkeypatch.setenv("SCIM_BEARER_TOKEN", "test-secret")
    sessions.create_session(sub="u1", email="u1@x.com", role="viewer")

    resp_missing = client.patch("/scim/v2/Users/u1", json=_deprovision_body())
    assert resp_missing.status_code == 401

    resp_wrong = client.patch(
        "/scim/v2/Users/u1",
        json=_deprovision_body(),
        headers={"Authorization": "Bearer wrong-secret"},
    )
    assert resp_wrong.status_code == 401
