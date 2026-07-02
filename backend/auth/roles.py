"""RBAC role model -- three ordered roles, no permissions matrix."""

from enum import IntEnum

from fastapi import Cookie, Depends, HTTPException

from backend.audit import log as audit_log
from backend.auth import sessions

SESSION_COOKIE_NAME = "session_id"


class Role(IntEnum):
    viewer = 0
    operator = 1
    admin = 2

    @classmethod
    def from_str(cls, value: str) -> "Role":
        try:
            return cls[value]
        except KeyError:
            return cls.viewer


def get_current_session(session_id: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME)) -> dict:
    if not session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    session = sessions.get_session(session_id)
    if not session:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    return session


def require_role(min_role: Role):
    def _check(session: dict = Depends(get_current_session)) -> dict:
        role = Role.from_str(session["role"])
        if role < min_role:
            audit_log.append_event(
                event="rbac_denied",
                sub=session["sub"],
                email=session["email"],
                detail={"required_role": min_role.name, "actual_role": role.name},
            )
            raise HTTPException(status_code=403, detail="Insufficient role")
        return session
    return _check
