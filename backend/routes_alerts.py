"""Alerts vertical routes: incidents, heartbeat health, and snooze control."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from backend.alerts.signals import build_signals
from backend.alerts.correlate import correlate
from backend.alerts.suppression import is_snoozed, snooze
from backend.alerts.heartbeat import freshness
from backend.audit import log as audit_log
from backend.auth.roles import Role, require_role
from backend.data.fetch import fetch_network

router = APIRouter()


class SnoozeRequest(BaseModel):
    category: str
    minutes: int


@router.get("/api/alerts/incidents")
async def get_incidents(session: dict = Depends(require_role(Role.viewer))):
    try:
        data = await fetch_network()
        sigs = build_signals(data)
        incs = correlate(sigs)
        return [i for i in incs if not is_snoozed(i["category"])]
    except Exception:
        return []


@router.get("/api/alerts/health")
def get_health():
    return freshness()


@router.post("/api/alerts/snooze")
def post_snooze(body: SnoozeRequest, session: dict = Depends(require_role(Role.operator))):
    snooze(body.category, body.minutes)
    audit_log.append_event("snooze", sub=session["sub"], email=session["email"], detail={"category": body.category, "minutes": body.minutes})
    return {"ok": True, "category": body.category, "minutes": body.minutes}
