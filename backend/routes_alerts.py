"""Alerts vertical routes: incidents, heartbeat health, and snooze control."""

from fastapi import APIRouter
from pydantic import BaseModel

from backend.alerts.signals import build_signals
from backend.alerts.correlate import correlate
from backend.alerts.suppression import is_snoozed, snooze
from backend.alerts.heartbeat import freshness
from backend.data.fetch import fetch_network

router = APIRouter()


class SnoozeRequest(BaseModel):
    category: str
    minutes: int


@router.get("/api/alerts/incidents")
async def get_incidents():
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
def post_snooze(body: SnoozeRequest):
    snooze(body.category, body.minutes)
    return {"ok": True, "category": body.category, "minutes": body.minutes}
