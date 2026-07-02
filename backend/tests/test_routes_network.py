"""
FastAPI route tests for backend/routes_network.py's
GET /api/verticals/network, plus a no-regression check on /health.

Per the step-3a plan's success predicate, this environment has no reachable
Infoblox key, so the un-mocked route call is expected to return the
correctly-shaped-but-empty fallback ({"subnets": [], "leases": [], "zones":
[], "views": []}) at HTTP 200 — that is an ACCEPTABLE outcome here, not a
failure. A second test mocks `backend.routes_network.fetch_network` to
prove the route wiring independently of real network reachability.
"""

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)


def test_get_network_returns_200_with_four_list_keys():
    r = client.get("/api/verticals/network")
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {"subnets", "leases", "zones", "views"}
    for key in ("subnets", "leases", "zones", "views"):
        assert isinstance(body[key], list)


def test_get_network_echoes_mocked_fetch_network_data():
    sample = {
        "subnets": [{"id": "1", "name": "sub-a", "util": 92, "severity": "crit"}],
        "leases": [{"addr": "10.0.0.5", "host": "host-a", "state": "active", "severity": "ok"}],
        "zones": [{"id": "z1", "fqdn": "example.com", "severity": "warn"}],
        "views": [{"id": "v1", "name": "default", "severity": "ok"}],
    }
    with patch("backend.routes_network.fetch_network", new=AsyncMock(return_value=sample)):
        r = client.get("/api/verticals/network")
    assert r.status_code == 200
    assert r.json() == sample


def test_health_endpoint_still_returns_200_ok():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
