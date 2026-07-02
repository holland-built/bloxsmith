"""Minimal SCIM deprovisioning endpoint -- RFC 7644 section 3.5.2 shape.

Not a full SCIM server: no user list/create/update/groups. One route,
gated by a shared bearer secret, that invalidates a user's live sessions.
"""

import os

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from backend.auth import sessions
from backend.audit import log as audit_log

router = APIRouter()


class ScimOperation(BaseModel):
    op: str
    path: str
    value: bool


class ScimPatchRequest(BaseModel):
    Operations: list[ScimOperation]


def _check_bearer(authorization: str | None) -> None:
    expected = os.environ.get("SCIM_BEARER_TOKEN")
    if not expected:
        raise HTTPException(status_code=401, detail="SCIM not configured")
    if not authorization or authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid bearer token")


@router.patch("/scim/v2/Users/{user_id}")
def deprovision_user(user_id: str, body: ScimPatchRequest, authorization: str | None = Header(default=None)):
    _check_bearer(authorization)

    deactivate = any(
        op.path == "active" and op.value is False
        for op in body.Operations
    )
    if not deactivate:
        raise HTTPException(status_code=400, detail="Only active:false deprovision is supported")

    removed = sessions.delete_by_sub(user_id)
    audit_log.append_event(
        event="scim_deprovision",
        sub=user_id,
        email="",
        detail={"sessions_revoked": removed},
    )
    return {"id": user_id, "active": False}
