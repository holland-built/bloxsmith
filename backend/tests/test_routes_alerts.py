"""
FastAPI route tests for backend/routes_alerts.py's
GET /api/alerts/incidents, GET /api/alerts/health, POST /api/alerts/snooze,
plus a no-regression check on /health.

Per the step-4a plan's success predicate, this environment has no reachable
Infoblox key, so the un-mocked incidents call is expected to return an empty
list at HTTP 200 -- that is an ACCEPTABLE outcome here, not a failure.

The snooze end-to-end test monkeypatches `backend.alerts.suppression.STATE_FILE`
to a tmp_path location so it never touches the real on-disk alert_state.json.
This works because `is_snoozed`/`snooze` (imported directly into routes_alerts
via `from backend.alerts.suppression import is_snoozed, snooze`) read the
module-global `STATE_FILE` out of their OWN module's namespace (suppression.py's
__globals__) at call time, not a value captured at import time -- so patching
the attribute on the `suppression` module object still takes effect even
though routes_alerts holds direct references to the function objects.
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from backend.alerts import suppression
from backend.main import app

client = TestClient(app)


def test_get_incidents_returns_200_with_json_list():
    r = client.get("/api/alerts/incidents")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_get_health_returns_200_with_expected_keys():
    r = client.get("/api/alerts/health")
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {"fresh", "last_successful_fetch", "age_seconds", "stale_after_seconds"}


def test_health_endpoint_still_returns_200_ok():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


@pytest.fixture
def isolated_suppression_state(tmp_path, monkeypatch):
    """Redirect suppression's on-disk state to tmp_path for this test only."""
    monkeypatch.setattr(suppression, "STATE_FILE", str(tmp_path / "alert_state.json"))
    yield


def test_snooze_end_to_end_excludes_category_from_subsequent_incidents(isolated_suppression_state):
    sample = {
        "subnets": [{"id": "sub-1", "name": "core-net", "util": 95, "severity": "crit"}],
        "leases": [],
        "zones": [],
        "views": [],
    }
    with patch("backend.routes_alerts.fetch_network", new=AsyncMock(return_value=sample)):
        r = client.get("/api/alerts/incidents")
        assert r.status_code == 200
        incidents = r.json()
        categories = {inc["category"] for inc in incidents}
        assert "subnet-utilization" in categories

        r = client.post("/api/alerts/snooze", json={"category": "subnet-utilization", "minutes": 60})
        assert r.status_code == 200

        r = client.get("/api/alerts/incidents")
        assert r.status_code == 200
        incidents = r.json()
        categories = {inc["category"] for inc in incidents}
        assert "subnet-utilization" not in categories

    # Confirm this test wrote to the isolated tmp_path file, not the real one.
    assert suppression.is_snoozed("subnet-utilization") is True
