"""Network vertical route: GET /api/verticals/network (subnets/leases/zones/views)."""

from fastapi import APIRouter

from backend.data.fetch import fetch_network

router = APIRouter()


@router.get("/api/verticals/network")
async def get_network():
    try:
        return await fetch_network()
    except Exception:
        return {"subnets": [], "leases": [], "zones": [], "views": []}
