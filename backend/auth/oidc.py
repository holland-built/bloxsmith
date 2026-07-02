"""OIDC authorization-code-flow client (authlib), config from environment.

OIDC only, no SAML (simpler, more common modern flow; SAML is a stated
fast-follow). Live IdP round-trip is unverifiable in this environment (no
real OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET configured) -- config parsing and
redirect-URL construction are the testable surface here.

Note: this app has no Starlette SessionMiddleware installed (main.py is
off-limits to this change), so authlib's Starlette integration -- which
normally stashes the OAuth `state`/`nonce` in `request.session` for replay
protection -- degrades to session-less mode (`request.session` raises/absent
is tolerated by authlib as `session=None`, see
authlib.integrations.starlette_client.integration.StarletteIntegration).
The authorization-code exchange itself still works; the extra CSRF-via-state
check just isn't persisted server-side across the redirect. Acceptable given
the constraint; wiring SessionMiddleware is a fast-follow for whoever owns
main.py.
"""

import os

from authlib.integrations.starlette_client import OAuth

_ROLE_CLAIM = os.environ.get("OIDC_ROLE_CLAIM", "roles")


def oidc_configured() -> bool:
    return bool(
        os.environ.get("OIDC_ISSUER")
        and os.environ.get("OIDC_CLIENT_ID")
        and os.environ.get("OIDC_CLIENT_SECRET")
    )


def _build_oauth() -> OAuth:
    oauth = OAuth()
    oauth.register(
        name="oidc",
        server_metadata_url=f"{os.environ['OIDC_ISSUER'].rstrip('/')}/.well-known/openid-configuration",
        client_id=os.environ["OIDC_CLIENT_ID"],
        client_secret=os.environ["OIDC_CLIENT_SECRET"],
        client_kwargs={"scope": "openid email profile"},
    )
    return oauth


def role_from_claims(claims: dict) -> str:
    """Map an ID-token claim (configurable via OIDC_ROLE_CLAIM, default 'roles')
    to the highest matching Role name; default 'viewer' if no match."""
    from backend.auth.roles import Role

    raw = claims.get(_ROLE_CLAIM) or []
    if isinstance(raw, str):
        raw = [raw]
    matched = [Role.from_str(r) for r in raw if r in Role.__members__]
    if not matched:
        return Role.viewer.name
    return max(matched).name


async def login_redirect(request):
    """Build the IdP authorize redirect. Requires oidc_configured() == True."""
    oauth = _build_oauth()
    redirect_uri = request.url_for("oidc_callback")
    return await oauth.oidc.authorize_redirect(request, redirect_uri)


async def handle_callback(request) -> dict:
    """Exchange the authorization code for a token and return the ID-token claims.

    Raises whatever authlib.integrations.base_client.OAuthError subclass on
    failure (bad state, exchange failure, etc.) -- caller is responsible for
    audit-logging and turning that into an HTTP error response.
    """
    oauth = _build_oauth()
    token = await oauth.oidc.authorize_access_token(request)
    userinfo = token.get("userinfo") or {}
    return dict(userinfo)
