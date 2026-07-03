"""Network vertical route: GET /api/verticals/network (subnets/leases/zones/views)."""

import sys
from fastapi import APIRouter

from backend import config
from backend.data.fetch import fetch_network

router = APIRouter()


@router.get("/api/verticals/network")
async def get_network():
    try:
        return await fetch_network()
    except Exception as e:
        subs = getattr(e, 'exceptions', None)
        msgs = [f"{type(s).__name__}: {s}" for s in subs] if subs else [f"{type(e).__name__}: {e}"]
        for m in msgs:
            print(f"  [error] fetch_network: {m}", file=sys.stderr)
        return {"subnets": [], "leases": [], "zones": [], "views": []}


@router.get("/api/mcp-test")
async def mcp_test():
    """Debug: test current MCP token against CSP endpoint directly."""
    import httpx
    auth = config.MCP_HEADERS.get("Authorization", "")
    scheme = auth.split(" ")[0] if auth else "none"
    result = {"auth_scheme": scheme, "api_key_set": bool(config.API_KEY)}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Test 1: POST with proper MCP Accept header (what the SDK should send)
            r1 = await client.post(
                config.MCP_URL,
                headers={
                    "Authorization": auth,
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                },
                content=b'{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}',
            )
            result["post_with_accept"] = {"status": r1.status_code, "body": r1.text[:300]}

            # Test 2: GET to open SSE stream (SDK may do this first)
            r2 = await client.get(
                config.MCP_URL,
                headers={
                    "Authorization": auth,
                    "Accept": "text/event-stream",
                },
            )
            result["get_sse"] = {"status": r2.status_code, "body": r2.text[:200]}
    except Exception as ex:
        result["mcp_error"] = f"{type(ex).__name__}: {ex}"
    return result
