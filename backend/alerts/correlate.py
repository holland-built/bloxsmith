"""Alert correlation — pure function, no I/O, no imports beyond stdlib.

v1 groups signals by `category` only: all firing signals of the same kind
collapse into one Incident. This is NOT topology-aware root-cause analysis —
it only dedups same-kind noise (e.g. N subnet-utilization signals -> 1
incident). See brainstorms/noc-dashboard-step4a-plan-2026-07-02.md section 3.
"""
from typing import TypedDict


class Incident(TypedDict):
    key: str
    category: str
    severity: str
    count: int
    sample_entities: list
    first_detected_at: float
    message: str


_SEVERITY_ORDER = {"ok": 0, "warn": 1, "crit": 2}

_SAMPLE_CAP = 5


def correlate(signals: list) -> list:
    """Group signals by category into a list of Incidents.

    v1: one incident per category (key == category). A future v2 may split
    a category into multiple incidents (e.g. per-site sub-keying) without
    changing the Incident shape, since `key` is kept distinct from `category`.
    """
    if not signals:
        return []

    groups: dict = {}
    for signal in signals:
        groups.setdefault(signal["category"], []).append(signal)

    incidents = []
    for category, group in groups.items():
        severity = max(group, key=lambda s: _SEVERITY_ORDER.get(s["severity"], 0))["severity"]
        count = len(group)
        sample_entities = [s["entity_id"] for s in group[:_SAMPLE_CAP]]
        first_detected_at = min(s["detected_at"] for s in group)
        message = f"{count} {category.replace('-', ' ')}"

        incidents.append(
            Incident(
                key=category,
                category=category,
                severity=severity,
                count=count,
                sample_entities=sample_entities,
                first_detected_at=first_detected_at,
                message=message,
            )
        )

    return incidents
