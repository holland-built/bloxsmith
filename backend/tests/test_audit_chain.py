"""
Unit tests for backend/audit/log.py.

CRITICAL: every test monkeypatches log.LOG_FILE to a path inside pytest's
per-test tmp_path -- the real on-disk audit_log.jsonl is NEVER touched by
this file.
"""

import json

import pytest

from backend.audit import log as audit_log


@pytest.fixture(autouse=True)
def isolated_audit_log(tmp_path, monkeypatch):
    monkeypatch.setattr(audit_log, "LOG_FILE", str(tmp_path / "audit_log.jsonl"))
    yield


def test_verify_chain_valid_after_appending_events():
    audit_log.append_event("login", "user-1", "a@example.com", {"ip": "10.0.0.1"})
    audit_log.append_event("logout", "user-1", "a@example.com")
    audit_log.append_event("login", "user-2", "b@example.com", {"ip": "10.0.0.2"})

    assert audit_log.verify_chain() == {"valid": True, "broken_index": None}


def test_verify_chain_detects_tampered_entry():
    audit_log.append_event("login", "user-1", "a@example.com", {"ip": "10.0.0.1"})
    audit_log.append_event("logout", "user-1", "a@example.com", {"reason": "timeout"})
    audit_log.append_event("login", "user-2", "b@example.com", {"ip": "10.0.0.2"})

    with open(audit_log.LOG_FILE) as f:
        lines = f.readlines()

    tampered = json.loads(lines[1])
    tampered["detail"] = {"reason": "tampered"}
    lines[1] = json.dumps(tampered) + "\n"

    with open(audit_log.LOG_FILE, "w") as f:
        f.writelines(lines)

    result = audit_log.verify_chain()
    assert result == {"valid": False, "broken_index": 1}


def test_read_all_returns_entries_in_order_with_correct_fields():
    audit_log.append_event("login", "user-1", "a@example.com", {"ip": "10.0.0.1"})
    audit_log.append_event("logout", "user-1", "a@example.com")
    audit_log.append_event("login", "user-2", "b@example.com", {"ip": "10.0.0.2"})

    entries = audit_log.read_all()

    assert len(entries) == 3
    assert [e["event"] for e in entries] == ["login", "logout", "login"]
    assert entries[0]["sub"] == "user-1"
    assert entries[0]["email"] == "a@example.com"
    assert entries[0]["detail"] == {"ip": "10.0.0.1"}
    assert entries[1]["detail"] == {}
    assert entries[2]["sub"] == "user-2"

    # Chain linkage: each entry's prev_hash matches the previous entry's hash.
    assert entries[0]["prev_hash"] == "0" * 64
    assert entries[1]["prev_hash"] == entries[0]["hash"]
    assert entries[2]["prev_hash"] == entries[1]["hash"]
