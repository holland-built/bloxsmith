"""Data normalization for the network vertical (subnets/leases/zones/views).

The field-mapping logic in `norm_subnets`, `norm_leases`, `norm_zones`, and
`norm_views` below is ported verbatim from `server.py` (legacy monolith,
originally around lines 1016-1080).

NEW in this rewrite: every output dict gains a `"severity"` key
(`"ok"` / `"warn"` / `"crit"`). This is NOT part of the legacy port — the
legacy backend has no such field. The subnet thresholds (util >= 90 -> crit,
util >= 75 -> warn) are sourced from the legacy FRONTEND's hardcoded color
scheme (`index.html:1104`, `1139-1147`), not from any backend value.

Open question (explicitly NOT decided here): the legacy UI also exposes a
separate, user-tunable triage threshold defaulting to 95/80
(`index.html:4812-4813`, `3550-3551`), distinct from the hardcoded 90/75
scheme mirrored above. Whether severity should be server-authoritative
(this fixed 90/75 scheme) or client-tunable (mirroring the adjustable
95/80 legacy control) is an open design decision that belongs to the
frontend step (3b), not to this normalization module.
"""


def _subnet_severity(util):
    if util >= 90:
        return "crit"
    if util >= 75:
        return "warn"
    return "ok"


def norm_subnets(raw):
    out = []
    for s in raw:
        u = s.get("utilization") or s.get("dhcp_utilization") or {}
        total = int(u.get("total") or u.get("total_count") or 0)
        used = int(u.get("used") or u.get("used_count") or 0)
        pct = round(used / total * 100) if total else 0
        tags = s.get("tags") or {}
        out.append({
            "id": s.get("id", ""),
            "name": s.get("name") or s.get("address", ""),
            "addr": s.get("address", ""),
            "cidr": s.get("cidr", 0),
            "total": total,
            "used": used,
            "util": pct,
            "site": tags.get("site") or tags.get("location") or "–",
            "owner": tags.get("owner") or tags.get("team") or "–",
            "severity": _subnet_severity(pct),
        })
    return out


def norm_leases(raw):
    out = []
    for l in raw:
        state = l.get("state", "")
        mapped = "active" if state in ("used", "issued", "dynamic") else "expired"
        hostname = l.get("hostname") or l.get("client_id", "")
        hostname = hostname.strip('"')
        out.append({
            "addr": l.get("address", ""),
            "host": hostname,
            "subnet": l.get("subnet_name") or "",
            "subnet_id": "",
            "state": mapped,
            "severity": "warn" if mapped == "expired" else "ok",
        })
    return out


def norm_zones(raw, view_map=None):
    vm = view_map or {}
    out = []
    for z in raw:
        za = z.get("zone_authority") or {}
        ttl = int(za.get("default_ttl") or 3600)
        neg_ttl = int(za.get("negative_ttl") or 3600)
        fqdn = z.get("fqdn") or z.get("name", "")
        view_ref = z.get("view", "")
        view = vm.get(view_ref) or view_ref.split("/")[-1][:12] or "default"
        issues = []
        if ttl < 60:
            issues.append("TTL Too Low")
        if ttl > 86400:
            issues.append("TTL Too High")
        if neg_ttl > 3600:
            issues.append("High Neg-TTL")
        out.append({
            "id": z.get("id", ""),
            "fqdn": fqdn,
            "view": view,
            "ttl": ttl,
            "neg_ttl": neg_ttl,
            "records": 0,
            "issues": issues,
            "anomaly": len(issues) > 0,
            "severity": "warn" if issues else "ok",
        })
    return out


def norm_views(raw):
    return [
        {
            "id": v.get("id", ""),
            "name": v.get("name", ""),
            "comment": v.get("comment", ""),
            "severity": "ok",
        }
        for v in raw
    ]
