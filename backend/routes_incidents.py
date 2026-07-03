"""MCP-native routes: /api/mcp/incidents, /api/mcp/events, /api/mcp/incidents/{id}"""
from fastapi import APIRouter, Depends, Query

from backend.auth.roles import Role, require_role
from backend.data.fetch_mcp import fetch_incidents, fetch_events, fetch_incident_detail

router = APIRouter()


@router.get("/api/mcp/incidents")
async def get_mcp_incidents(session: dict = Depends(require_role(Role.viewer))):
    return await fetch_incidents()


@router.get("/api/mcp/events")
async def get_mcp_events(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    session: dict = Depends(require_role(Role.viewer)),
):
    return await fetch_events(limit=limit, offset=offset)


@router.get("/api/mcp/incidents/{incident_id}")
async def get_mcp_incident(
    incident_id: str,
    session: dict = Depends(require_role(Role.viewer)),
):
    return await fetch_incident_detail(incident_id)
