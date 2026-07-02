"""
Unit tests for backend/alerts/signals.py's build_signals().

build_signals() derives alert Signals from step-3a's network-data shape
({subnets, leases, zones, views}) at read time -- it does not mutate or
require any real fetch, so these tests just pass synthetic dicts.
"""

from backend.alerts.signals import build_signals


def test_crit_subnet_produces_subnet_utilization_signal():
    data = {
        "subnets": [{"id": "sub-1", "name": "core-net", "util": 95, "severity": "crit"}],
        "leases": [],
        "zones": [],
        "views": [],
    }
    signals = build_signals(data)
    assert len(signals) == 1
    sig = signals[0]
    assert sig["severity"] == "crit"
    assert sig["category"] == "subnet-utilization"
    assert sig["entity_id"] == "sub-1"
    assert sig["message"] == "core-net at 95% utilization"


def test_warn_zone_with_issues_produces_dns_ttl_anomaly_signal():
    data = {
        "subnets": [],
        "leases": [],
        "zones": [{
            "id": "zone-1",
            "fqdn": "example.com",
            "issues": ["TTL Too Low"],
            "severity": "warn",
        }],
        "views": [],
    }
    signals = build_signals(data)
    assert len(signals) == 1
    sig = signals[0]
    assert sig["severity"] == "warn"
    assert sig["category"] == "dns-ttl-anomaly"
    assert sig["entity_id"] == "zone-1"
    assert sig["message"] == "example.com: TTL Too Low"


def test_warn_expired_lease_produces_dhcp_expired_lease_signal():
    data = {
        "subnets": [],
        "leases": [{"addr": "10.0.0.5", "host": "host-a", "state": "expired", "severity": "warn"}],
        "zones": [],
        "views": [],
    }
    signals = build_signals(data)
    assert len(signals) == 1
    sig = signals[0]
    assert sig["severity"] == "warn"
    assert sig["category"] == "dhcp-expired-lease"
    assert sig["entity_id"] == "10.0.0.5"
    assert sig["message"] == "Lease 10.0.0.5 (host-a) expired"


def test_all_ok_input_produces_zero_signals():
    data = {
        "subnets": [{"id": "sub-1", "name": "core-net", "util": 10, "severity": "ok"}],
        "leases": [{"addr": "10.0.0.5", "host": "host-a", "state": "active", "severity": "ok"}],
        "zones": [{"id": "zone-1", "fqdn": "example.com", "issues": [], "severity": "ok"}],
        "views": [{"id": "v1", "name": "default", "severity": "ok"}],
    }
    signals = build_signals(data)
    assert signals == []
