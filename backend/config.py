"""
Shared mutable state + env loader for the FastAPI backend.

This module is the single source of truth for state shared across the
backend's modules (vault, mcp_client, routes). Other modules do:

    from backend import config
    config.API_KEY = "..."
    config.MCP_HEADERS["Authorization"] = "..."

NEVER `from backend.config import API_KEY` — that binds an independent
copy at import time and silently breaks propagation when this module's
attribute is later reassigned (e.g. after a vault unlock).

Ported from server.py (top-of-file dotenv shim + credential/env globals).
"""

import os

# ── .env loader (load .env if present, never hardcode tokens) ─────────────
_env_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
if os.path.exists(_env_file):
    with open(_env_file) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                _v = _v.strip()
                # strip matching surrounding quotes so values like
                # INFOBLOX_API_KEY="Token x" don't keep literal quotes
                if len(_v) >= 2 and _v[0] == _v[-1] and _v[0] in ("'", '"'):
                    _v = _v[1:-1]
                os.environ.setdefault(_k.strip(), _v)

# ── credentials / MCP target ───────────────────────────────────────────────
API_KEY = os.environ.get("INFOBLOX_API_KEY", "")
# No env key → run in encrypted-vault mode: the dashboard prompts for a
# passphrase and manages one-or-more tenant keys, AES-encrypted at rest on a
# mounted volume. An env key keeps the original single-key behavior (and all
# existing deployments) working unchanged.
VAULT_MODE = (not API_KEY)
BASE_URL = os.environ.get("INFOBLOX_URL", "https://csp.infoblox.com")
MCP_URL = f"{BASE_URL}/mcp"
MCP_HEADERS = {"Authorization": API_KEY}

# Shared-secret for state-changing/destructive endpoints (e.g. vault
# lock/reset). If unset, those writes are disabled (401). Supplied via the
# X-Auth-Token header.
DASHBOARD_TOKEN = os.environ.get("DASHBOARD_TOKEN", "")

# ── LLM config — works with Groq or any OpenAI-compatible provider ────────
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
# LLM_API_KEY falls back to GROQ_API_KEY for back-compat.
LLM_API_KEY = os.environ.get("LLM_API_KEY", GROQ_API_KEY)
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen/qwen3-32b")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "")  # blank = Groq default endpoint

# ── active-account tracking (mutated by mcp_client/vault on switch) ───────
_HOME_ACCOUNT_ID = ""   # account the API key natively belongs to
_active_account_id = ""

# ── app version shown in the UI footer ─────────────────────────────────────
# CI injects "1.0.<git-commit-count>" at build time (bumps every commit);
# falls back to the local git count, else "dev".
def _git_version():
    try:
        import subprocess
        n = subprocess.check_output(
            ["git", "rev-list", "--count", "HEAD"],
            stderr=subprocess.DEVNULL, timeout=2,
        ).decode().strip()
        return f"1.0.{n}" if n else "dev"
    except Exception:
        return "dev"

APP_VERSION = os.environ.get("APP_VERSION") or _git_version()
