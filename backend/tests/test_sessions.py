"""
Unit tests for backend/auth/sessions.py.

CRITICAL: every test monkeypatches sessions._SESSIONS to a fresh dict so
tests never leak state into each other or into the real module-level store.
"""

import time

import pytest

from backend.auth import sessions


@pytest.fixture(autouse=True)
def isolated_sessions(monkeypatch):
    monkeypatch.setattr(sessions, "_SESSIONS", {})
    yield


def test_create_and_get_returns_the_right_dict():
    session_id = sessions.create_session("user-1", "user1@example.com", "admin")
    s = sessions.get_session(session_id)
    assert s is not None
    assert s["sub"] == "user-1"
    assert s["email"] == "user1@example.com"
    assert s["role"] == "admin"


def test_get_on_unknown_id_returns_none():
    assert sessions.get_session("does-not-exist") is None


def test_delete_session_then_get_returns_none():
    session_id = sessions.create_session("user-1", "user1@example.com", "admin")
    sessions.delete_session(session_id)
    assert sessions.get_session(session_id) is None


def test_delete_by_sub_removes_all_sessions_for_that_sub_and_returns_count():
    sid1 = sessions.create_session("user-1", "user1@example.com", "admin")
    sid2 = sessions.create_session("user-1", "user1@example.com", "admin")
    sid_other = sessions.create_session("user-2", "user2@example.com", "viewer")

    removed = sessions.delete_by_sub("user-1")

    assert removed == 2
    assert sessions.get_session(sid1) is None
    assert sessions.get_session(sid2) is None
    assert sessions.get_session(sid_other) is not None


def test_expired_session_returns_none_and_is_pruned():
    session_id = sessions.create_session("user-1", "user1@example.com", "admin")
    sessions._SESSIONS[session_id]["exp"] = time.time() - 1

    assert sessions.get_session(session_id) is None
    assert session_id not in sessions._SESSIONS
