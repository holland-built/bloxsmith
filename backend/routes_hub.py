"""Hub routes: real host-health + DNS security events (direct REST, not cubes)."""
from fastapi import APIRouter, Depends, Query

from backend.auth.roles import Role, require_role
from backend.data.fetch_infra import fetch_host_health, fetch_security_events
from backend.data.fetch_domains import fetch_domains

router = APIRouter()


@router.get("/api/hub/health")
async def get_hub_health(session: dict = Depends(require_role(Role.viewer))):
    return await fetch_host_health()


@router.get("/api/hub/security")
async def get_hub_security(
    window_secs: int = Query(3600, ge=300, le=86400),
    limit: int = Query(50, ge=1, le=200),
    session: dict = Depends(require_role(Role.viewer)),
):
    return await fetch_security_events(window_secs=window_secs, limit=limit)


@router.get("/api/hub/domains")
async def get_hub_domains(session: dict = Depends(require_role(Role.viewer))):
    return await fetch_domains()
