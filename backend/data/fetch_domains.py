"""Rich domain panels via direct Infoblox REST — the untapped platform surface.

The hub top is at-a-glance; this powers the domain detail section below it with
real data from across the platform (threat defense, endpoints, anycast, DFP,
hosts). All direct httpx (cubes remain unavailable via the broken parquet path).
"""

import asyncio
import sys

import httpx

from backend import config
from backend.cache import _cache_get, _cache_set

B = config.BASE_URL
_H = {"Authorization": config.API_KEY}


async def _get(client: httpx.AsyncClient, path: str, limit: int = 100) -> list:
    sep = "&" if "?" in path else "?"
    url = f"{B}{path}{sep}_limit={limit}"
    try:
        r = await client.get(url, headers=_H, timeout=35)
        r.raise_for_status()
        j = r.json()
        if isinstance(j, dict):
            return j.get("results", j.get("result", []))
        return j if isinstance(j, list) else []
    except Exception as e:
        print(f"  [warn] domain get {path[:48]}: {e}", file=sys.stderr)
        return []


def _sev_rank(level: str) -> str:
    lv = str(level).upper()
    if lv in ("HIGH", "CRITICAL"):
        return "crit"
    if lv in ("MEDIUM", "MED"):
        return "warn"
    return "ok"


async def fetch_domains() -> dict:
    """Gather all domain panels in parallel. Returns a dict keyed by panel."""
    ck = "hub_domains"
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    async with httpx.AsyncClient(follow_redirects=True) as client:
        (policies, feeds, named, roaming, anycast, dfp, hosts) = await asyncio.gather(
            _get(client, "/api/atcfw/v1/security_policies"),
            _get(client, "/api/atcfw/v1/threat_feeds"),
            _get(client, "/api/atcfw/v1/named_lists"),
            _get(client, "/api/atcep/v1/roaming_devices", limit=200),
            _get(client, "/api/anycast/v1/accm/ac_runtime_statuses"),
            _get(client, "/api/atcdfp/v1/dfp_services"),
            _get(client, "/api/infra/v1/detail_hosts", limit=200),
        )

    # --- Threat feeds ---
    threat_feeds = [{
        "name": f.get("name", ""),
        "source": f.get("source", ""),
        "threat_level": f.get("threat_level", ""),
        "confidence": f.get("confidence_level", ""),
        "severity": _sev_rank(f.get("threat_level", "")),
    } for f in feeds]

    # --- Named (custom block/allow) lists ---
    named_lists = [{
        "name": n.get("name", ""),
        "type": n.get("type", ""),
        "items": n.get("item_count", 0),
        "threat_level": n.get("threat_level", ""),
        "policies": len(n.get("policies", []) or []),
        "severity": _sev_rank(n.get("threat_level", "")),
    } for n in named]

    # --- Security policies ---
    security_policies = [{
        "name": p.get("name", ""),
        "default_action": p.get("default_action", ""),
        "dfps": len(p.get("dfps", []) or []),
        "rules": len(p.get("rules", []) or []),
        "doh": bool(p.get("doh_enabled")),
    } for p in policies]

    # --- Roaming endpoints ---
    from collections import Counter
    status_counts = Counter(
        str(d.get("display_status", d.get("calculated_status", "unknown"))).lower()
        for d in roaming
    )
    countries = Counter(d.get("country_name", "—") for d in roaming if d.get("country_name"))
    roaming_endpoints = {
        "total": len(roaming),
        "by_status": dict(status_counts),
        "top_countries": countries.most_common(5),
    }

    # --- Anycast HA ---
    anycast_ha = []
    for a in anycast:
        rt = a.get("runtime_status", {}) or {}
        state = str(rt.get("state", rt) if isinstance(rt, dict) else rt).lower()
        anycast_ha.append({
            "name": a.get("name", ""),
            "service": a.get("service", ""),
            "ip": a.get("anycast_ip_address", ""),
            "state": state or "unknown",
            "severity": "ok" if "up" in state or "online" in state or "healthy" in state else ("warn" if state and state != "unknown" else "warn"),
        })

    # --- DNS Forwarding Proxy services ---
    def _dfp_host(d):
        h = d.get("host", "")
        if isinstance(h, list):
            return (h[0].get("name", "") if h and isinstance(h[0], dict) else "")
        return str(h)[:40]

    dfp_services = [{
        "name": d.get("name", ""),
        "mode": d.get("forwarding_policy", d.get("mode", "")),
        "host": _dfp_host(d),
        "resolvers": len(d.get("default_resolvers", []) or []),
    } for d in dfp]

    # --- On-prem host inventory ---
    def _qps_num(h):
        # detail_hosts.qps may be a scalar or an object like {"limit": N, ...}
        q = h.get("qps", 0)
        if isinstance(q, dict):
            for k in ("current", "value", "avg", "limit"):
                if isinstance(q.get(k), (int, float)):
                    return q[k]
            return 0
        return q if isinstance(q, (int, float)) else 0

    host_status = Counter(str(h.get("composite_status", "unknown")).lower() for h in hosts)
    host_inventory = {
        "total": len(hosts),
        "by_status": dict(host_status),
        "hosts": [{
            "name": h.get("display_name", ""),
            "ip": h.get("ip_address", ""),
            "version": h.get("host_version", ""),
            "status": str(h.get("composite_status", "")).lower(),
            "qps": _qps_num(h),
        } for h in hosts[:12]],
    }

    result = {
        "threat_feeds": threat_feeds,
        "named_lists": named_lists,
        "security_policies": security_policies,
        "roaming_endpoints": roaming_endpoints,
        "anycast_ha": anycast_ha,
        "dfp_services": dfp_services,
        "host_inventory": host_inventory,
    }
    _cache_set(ck, result)
    return result
