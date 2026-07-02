"""In-memory session store for the login gate.

Server-side sessions (not stateless JWT) so SCIM deprovision can revoke a
live session instantly by subject id -- a stateless token can't be revoked
without a blocklist.
"""

import secrets
import time

_SESSIONS: dict = {}
_TTL_SECONDS = 8 * 3600


def create_session(sub: str, email: str, role: str) -> str:
    session_id = secrets.token_urlsafe(32)
    _SESSIONS[session_id] = {
        "sub": sub,
        "email": email,
        "role": role,
        "exp": time.time() + _TTL_SECONDS,
    }
    return session_id


def get_session(session_id: str) -> dict | None:
    s = _SESSIONS.get(session_id)
    if not s:
        return None
    if s["exp"] < time.time():
        _SESSIONS.pop(session_id, None)
        return None
    return s


def delete_session(session_id: str) -> None:
    _SESSIONS.pop(session_id, None)


def delete_by_sub(sub: str) -> int:
    """Invalidate every live session for a subject (SCIM deprovision). Returns count removed."""
    to_remove = [sid for sid, s in _SESSIONS.items() if s["sub"] == sub]
    for sid in to_remove:
        _SESSIONS.pop(sid, None)
    return len(to_remove)
