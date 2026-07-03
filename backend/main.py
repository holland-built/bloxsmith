import os

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from backend import config, routes_vault, routes_network, routes_alerts  # noqa: F401 — importing config triggers its .env load
from backend import routes_auth, routes_scim, routes_audit, routes_incidents, routes_hub

# Run with: uvicorn backend.main:app --port 8000
# Legacy server.py owns port 8080, Vite dev server owns 5173 - no port conflicts.

app = FastAPI()

# API routes MUST be included before the catch-all static mount below — Starlette
# matches routes in registration order, and a Mount("/") registered first would
# shadow every /api/* path with a 404 from StaticFiles instead of reaching them.
app.include_router(routes_vault.router)
app.include_router(routes_network.router)
app.include_router(routes_alerts.router)
app.include_router(routes_auth.router)
app.include_router(routes_scim.router)
app.include_router(routes_audit.router)
app.include_router(routes_incidents.router)
app.include_router(routes_hub.router)

# Best-effort boot auto-unlock, matching legacy's behavior when VAULT_PASSPHRASE
# (or VAULT_PASSPHRASE_FILE) is set — never raises if no vault exists yet.
try:
    from backend import vault as _vault_module

    _boot_passphrase = _vault_module._vault_passphrase_from_env()
    if _boot_passphrase and _vault_module.vault_exists():
        _vault_module.vault_unlock(_boot_passphrase)
except Exception:
    pass


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/")
def root():
    return RedirectResponse(url="/index-vite.html")


if os.path.isdir("dist"):
    app.mount("/", StaticFiles(directory="dist", html=True), name="static")
