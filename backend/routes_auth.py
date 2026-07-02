"""Auth routes: dev-login (env-gated), OIDC login/callback, logout, and /auth/me.

House style follows backend/routes_alerts.py: a small APIRouter() module,
Pydantic request bodies, thin handlers delegating to backend.auth/backend.audit.
"""

import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from backend.audit import log as audit_log
from backend.auth import oidc, roles, sessions

router = APIRouter()


class DevLoginRequest(BaseModel):
    email: str
    role: str


def _set_session_cookie(response, session_id: str) -> None:
    response.set_cookie(
        key=roles.SESSION_COOKIE_NAME,
        value=session_id,
        httponly=True,
        samesite="lax",
    )


@router.post("/auth/dev-login")
def dev_login(body: DevLoginRequest, response: Response):
    if os.environ.get("AUTH_DEV_MODE") != "1":
        raise HTTPException(status_code=503, detail="Dev mode not enabled")

    session_id = sessions.create_session(sub=body.email, email=body.email, role=body.role)
    _set_session_cookie(response, session_id)
    audit_log.append_event(
        event="login_success",
        sub=body.email,
        email=body.email,
        detail={"method": "dev"},
    )
    return {"email": body.email, "role": body.role}


@router.get("/auth/login")
async def login(request: Request):
    if oidc.oidc_configured():
        return await oidc.login_redirect(request)
    # Dev mode without OIDC configured: point users at /auth/dev-login rather
    # than trying to half-wire a redirect with no IdP to redirect to --
    # simplest correct behavior for this branch.
    raise HTTPException(status_code=503, detail="No auth configured")


@router.get("/auth/callback")
async def oidc_callback(request: Request):
    try:
        claims = await oidc.handle_callback(request)
    except Exception as exc:
        attempted_email = request.query_params.get("email", "")
        audit_log.append_event(
            event="login_failure",
            sub="",
            email=attempted_email,
            detail={"reason": str(exc)},
        )
        raise HTTPException(status_code=401, detail="OIDC login failed") from exc

    email = claims.get("email", "")
    sub = claims.get("sub", email)
    role = oidc.role_from_claims(claims)

    session_id = sessions.create_session(sub=sub, email=email, role=role)
    audit_log.append_event(
        event="login_success",
        sub=sub,
        email=email,
        detail={"method": "oidc"},
    )
    response = RedirectResponse(url="/")
    _set_session_cookie(response, session_id)
    return response


@router.post("/auth/logout")
def logout(request: Request, response: Response):
    session_id = request.cookies.get(roles.SESSION_COOKIE_NAME)
    session = sessions.get_session(session_id) if session_id else None
    if session_id:
        sessions.delete_session(session_id)
    response.delete_cookie(roles.SESSION_COOKIE_NAME)
    audit_log.append_event(
        event="logout",
        sub=session["sub"] if session else "",
        email=session["email"] if session else "",
    )
    return {"ok": True}


@router.get("/auth/me")
def me(session: dict = Depends(roles.get_current_session)):
    return {"email": session["email"], "role": session["role"]}
