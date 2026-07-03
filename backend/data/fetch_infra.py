"""Real host-health + DNS security-event fetch via direct Infoblox REST.

Powers the operator-hub HEALTH and SECURITY panels with real data instead of
values derived from the incident feed. Uses the same direct-httpx pattern as
fetch.py (the MCP make_get_request -> query_stored_data parquet path is broken
server-side, so cube/analytics data is unavailable; raw REST is not).

- fetch_host_health(): /api/infra/v1/detail_services -> per-service-type rollup
- fetch_security_events(): /api/dnsdata/v2/dns_event -> recent threat events + counts
"""

import sys
import time

import httpx

from backend import config
from backend.cache import _cache_get, _cache_set

# service_type buckets -> the hub's service rows. IPAM has no infra service
# (it's config data), so it stays derived from subnet utilization upstream.
_SERVICE_BUCKETS = {
    "DNS": {"dns", "ndns"},
    "DHCP": {"dhcp", "ndhcp"},
    "Security": {"dfp", "orpheus"},  # threat defense / DNS forwarding proxy
}

# composite_status -> severity rank (higher = worse). "stopped" is often
# intentional (disabled service), so it is a warn, not a crit.
_STATUS_RANK = {"online": 0, "stopped": 1, "error": 2}
_RANK_SEVERITY = {0: "ok", 1: "warn", 2: "crit"}
_SEVERITY_LABEL = {"ok": "healthy", "warn": "degraded", "crit": "critical"}


async def _get(client: httpx.AsyncClient, url: str) -> list:
    try:
        r = await client.get(url, headers={"Authorization": config.API_KEY}, timeout=40)
        r.raise_for_status()
        j = r.json()
        return j.get("results", j.get("result", []) if isinstance(j, dict) else [])
    except Exception as e:
        print(f"  [warn] infra get {url.split('/api/')[-1][:40]}: {e}", file=sys.stderr)
        return []


async def fetch_host_health() -> list:
    """Per-service-type health rollup for DNS / DHCP / Security.

    Returns list of {name, status, statusLabel, meta}. IPAM is not included
    here (no infra service backs it) — the caller derives it from subnets.
    """
    ck = "hub_host_health"
    cached = _cache_get(ck)
    if cached is not None:
        return cached
    async with httpx.AsyncClient(follow_redirects=True) as client:
        services = await _get(
            client, f"{config.BASE_URL}/api/infra/v1/detail_services?_limit=500"
        )

    rollup = []
    for svc_name, types in _SERVICE_BUCKETS.items():
        members = [s for s in services if s.get("service_type") in types]
        if not members:
            rollup.append({
                "name": svc_name, "status": "ok",
                "statusLabel": "no services", "meta": "0 deployed",
            })
            continue
        worst = max(_STATUS_RANK.get(s.get("composite_status", "online"), 0) for s in members)
        severity = _RANK_SEVERITY[worst]
        errs = sum(1 for s in members if s.get("composite_status") == "error")
        stopped = sum(1 for s in members if s.get("composite_status") == "stopped")
        online = sum(1 for s in members if s.get("composite_status") == "online")
        if errs:
            meta = f"{errs} error · {online}/{len(members)} up"
        elif stopped:
            meta = f"{stopped} stopped · {online}/{len(members)} up"
        else:
            meta = f"{online}/{len(members)} online"
        rollup.append({
            "name": svc_name,
            "status": severity,
            "statusLabel": _SEVERITY_LABEL[severity],
            "meta": meta,
        })

    _cache_set(ck, rollup)
    return rollup


async def fetch_security_events(window_secs: int = 3600, limit: int = 50) -> dict:
    """Recent DNS security (threat) events + severity/action counts.

    Returns {events: [...], counts: {critical,high,medium,low}, blocked, logged, total}.
    """
    ck = f"hub_security|{window_secs}|{limit}"
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    t1 = int(time.time())
    t0 = t1 - window_secs
    url = (f"{config.BASE_URL}/api/dnsdata/v2/dns_event"
           f"?t0={t0}&t1={t1}&_limit={limit}")
    async with httpx.AsyncClient(follow_redirects=True) as client:
        rows = await _get(client, url)

    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    blocked = logged = 0
    events = []
    for e in rows:
        sev = str(e.get("severity", "")).lower()
        if sev in ("critical", "high", "medium", "low"):
            counts[sev] += 1
        action = str(e.get("policy_action", "")).lower()
        if action in ("block", "redirect"):
            blocked += 1
        elif action == "log":
            logged += 1
        events.append({
            "event_time": e.get("event_time", ""),
            "qname": e.get("qname", ""),
            "severity": e.get("severity", ""),
            "policy_action": e.get("policy_action", ""),
            "feed_name": e.get("feed_name", ""),
            "threat_indicator": e.get("threat_indicator", ""),
            "device": e.get("device", ""),
            "network": e.get("network", ""),
        })

    result = {
        "events": events,
        "counts": counts,
        "blocked": blocked,
        "logged": logged,
        "total": len(rows),
    }
    _cache_set(ck, result)
    return result
