"""
Unit tests for backend/alerts/suppression.py.

CRITICAL: every test monkeypatches suppression.STATE_FILE to a path inside
pytest's per-test tmp_path -- the real on-disk alert_state.json is NEVER
touched by this file.
"""

import json

import pytest

from backend.alerts import suppression


@pytest.fixture(autouse=True)
def isolated_state_file(tmp_path, monkeypatch):
    monkeypatch.setattr(suppression, "STATE_FILE", str(tmp_path / "alert_state.json"))
    yield


def test_snooze_category_is_snoozed_true():
    suppression.snooze("subnet-utilization", 30)
    assert suppression.is_snoozed("subnet-utilization") is True


def test_snooze_survives_fresh_reload_from_disk():
    suppression.snooze("subnet-utilization", 30)
    # Simulate a restart: a fresh, direct read from disk via _load().
    reloaded = suppression._load()
    assert "subnet-utilization" in reloaded
    import time
    assert reloaded["subnet-utilization"] > time.time()


def test_snooze_with_zero_minutes_is_already_expired():
    suppression.snooze("subnet-utilization", 0)
    assert suppression.is_snoozed("subnet-utilization") is False


def test_snooze_with_negative_minutes_is_already_expired():
    suppression.snooze("subnet-utilization", -5)
    assert suppression.is_snoozed("subnet-utilization") is False


def test_corrupt_state_file_treated_as_not_snoozed():
    with open(suppression.STATE_FILE, "w") as f:
        f.write("this is not valid json {{{")
    assert suppression.is_snoozed("subnet-utilization") is False


def test_nonexistent_state_file_treated_as_not_snoozed():
    # STATE_FILE points inside tmp_path but the file itself was never created.
    assert not __import__("os").path.exists(suppression.STATE_FILE)
    assert suppression.is_snoozed("subnet-utilization") is False


def test_state_file_persists_valid_json_across_load_save():
    suppression.snooze("dns-ttl-anomaly", 60)
    with open(suppression.STATE_FILE) as f:
        on_disk = json.load(f)
    assert "dns-ttl-anomaly" in on_disk
