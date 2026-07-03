"""Combined data fetch for the network vertical (subnets/leases/zones/views).

Uses the Infoblox DDI REST API directly rather than the MCP two-step
(make_get_request → query_stored_data) pattern, which is broken when the
agentgateway runs behind a load-balancer: stored Parquet data is in-process
memory so sequential requests can land on different instances.

Deliberately OUT OF SCOPE: hosts/policies/feeds/audit (other verticals).
"""

import asyncio

import httpx

from backend import config
from backend.alerts import heartbeat
from backend.data import normalize

_LIMIT = 5000  # single-page fetch; most tenants well under this


async def _ddi_get(client: httpx.AsyncClient, path: str, fields: str) -> list:
    """GET /api/ddi/v1<path> with field selection; returns results list."""
    url = f"{config.BASE_URL}/api/ddi/v1{path}"
    params = {"_fields": fields, "_limit": str(_LIMIT)}
    try:
        r = await client.get(url, params=params,
                             headers={"Authorization": config.API_KEY},
                             timeout=30)
        r.raise_for_status()
        return r.json().get("results", [])
    except Exception as e:
        import sys
        print(f"  [warn] ddi_get {path}: {e}", file=sys.stderr)
        return []


async def fetch_network() -> dict:
    async with httpx.AsyncClient(follow_redirects=True) as client:
        subnets_r, leases_r, views_r, zones_r = await asyncio.gather(
            _ddi_get(client, "/ipam/subnet",   "id,name,address,cidr,utilization,tags"),
            _ddi_get(client, "/dhcp/lease",    "address,hostname,state,client_id"),
            _ddi_get(client, "/dns/view",      "id,name,comment"),
            _ddi_get(client, "/dns/auth_zone", "id,fqdn,view,zone_authority,primary_type"),
        )

    view_map = {v.get("id", ""): v.get("name", "") for v in views_r}

    subnets = normalize.norm_subnets(subnets_r)
    leases  = normalize.norm_leases(leases_r)
    views   = normalize.norm_views(views_r)
    zones   = normalize.norm_zones(zones_r, view_map)

    heartbeat.mark_fetch_ok()
    return {"subnets": subnets, "leases": leases, "zones": zones, "views": views}
