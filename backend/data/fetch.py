"""Combined data fetch for the network vertical (subnets/leases/zones/views).

Ports the subnets/leases/views/zones slice of legacy `server.py`'s
`_fetch_dashboard_async` (originally around lines 1162-1191). Deliberately
OUT OF SCOPE: hosts/policies/feeds/audit (other verticals, not ported here).
"""

import asyncio

from backend import mcp_client
from backend.data import normalize


async def fetch_network() -> dict:
    async with mcp_client._mcp_session() as session:
        subnets_d, leases_d, views_d, zones_d = await asyncio.gather(
            mcp_client._mcp_get(session, "Ipamsvc", "/ipam/subnet",
                                 {"_fields": "id,name,address,cidr,utilization,tags"}, fetch_all=True),
            mcp_client._mcp_get(session, "DhcpLeases", "/dhcp/lease",
                                 {"_fields": "address,hostname,state,client_id"}, fetch_all=True),
            mcp_client._mcp_get(session, "DnsConfig", "/dns/view",
                                 {"_fields": "id,name,comment"}, fetch_all=True),
            mcp_client._mcp_get(session, "DnsConfig", "/dns/auth_zone",
                                 {"_fields": "id,fqdn,view,zone_authority,primary_type"}, fetch_all=True),
        )

        view_map = {v.get("id", ""): v.get("name", "") for v in mcp_client._results(views_d)}

        subnets = normalize.norm_subnets(mcp_client._results(subnets_d))
        leases = normalize.norm_leases(mcp_client._results(leases_d))
        views = normalize.norm_views(mcp_client._results(views_d))
        zones = normalize.norm_zones(mcp_client._results(zones_d), view_map)

        return {"subnets": subnets, "leases": leases, "zones": zones, "views": views}
