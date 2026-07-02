"""
Unit tests for backend/alerts/correlate.py's correlate().

These are the exact cases from brainstorms/noc-dashboard-step4a-plan-2026-07-02.md
section "1. Success predicate": category grouping, severity=max, count vs.
capped sample_entities, and the empty-list edge case.
"""

from backend.alerts.correlate import correlate


def _signal(category, severity, entity_id, detected_at=100.0):
    return {
        "source": "network",
        "entity_type": "subnet",
        "entity_id": entity_id,
        "category": category,
        "severity": severity,
        "message": f"{entity_id} {severity}",
        "detected_at": detected_at,
    }


def test_three_mixed_severity_subnet_signals_collapse_to_one_crit_incident():
    signals = [
        _signal("subnet-utilization", "warn", "sub-1"),
        _signal("subnet-utilization", "crit", "sub-2"),
        _signal("subnet-utilization", "warn", "sub-3"),
    ]
    incidents = correlate(signals)
    assert len(incidents) == 1
    inc = incidents[0]
    assert inc["category"] == "subnet-utilization"
    assert inc["severity"] == "crit"
    assert inc["count"] == 3


def test_two_categories_produce_two_incidents():
    signals = [
        _signal("subnet-utilization", "warn", "sub-1"),
        _signal("subnet-utilization", "crit", "sub-2"),
        _signal("dns-ttl-anomaly", "warn", "zone-1"),
    ]
    incidents = correlate(signals)
    assert len(incidents) == 2
    categories = {inc["category"] for inc in incidents}
    assert categories == {"subnet-utilization", "dns-ttl-anomaly"}


def test_empty_signal_list_returns_empty_list():
    assert correlate([]) == []


def test_sample_entities_capped_at_five_but_count_reflects_true_total():
    signals = [_signal("subnet-utilization", "warn", f"sub-{i}") for i in range(8)]
    incidents = correlate(signals)
    assert len(incidents) == 1
    inc = incidents[0]
    assert len(inc["sample_entities"]) == 5
    assert inc["count"] == 8
