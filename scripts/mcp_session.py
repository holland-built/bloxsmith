"""Standalone MCP session for the catalog + drift-check scripts.

Reads INFOBLOX_API_KEY / INFOBLOX_URL from the environment and talks to
csp.infoblox.com/mcp directly — no dependency on server.py, so the catalog
scripts and the nightly drift-check workflow can run on their own.

(This replaces the old `backend.mcp_client` import the catalog scripts used
before the repo layout moved backend/ to the root.)
"""
import os
from contextlib import asynccontextmanager

from mcp.client.streamable_http import streamablehttp_client
from mcp.client.session import ClientSession

BASE_URL = os.environ.get("INFOBLOX_URL", "https://csp.infoblox.com").rstrip("/")
MCP_URL = f"{BASE_URL}/mcp"
_KEY = os.environ.get("INFOBLOX_API_KEY", "")
# CSP wants a "Token <key>" Authorization header; accept a bare key too.
if _KEY and not _KEY.lower().startswith("token "):
    _KEY = f"Token {_KEY}"
MCP_HEADERS = {"Authorization": _KEY} if _KEY else {}


@asynccontextmanager
async def _mcp_session():
    if not MCP_HEADERS:
        raise SystemExit("INFOBLOX_API_KEY not set — export it before running.")
    async with streamablehttp_client(MCP_URL, headers=MCP_HEADERS) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


def _tool_text(result) -> str:
    """First text block of a call_tool result, or '{}' when empty."""
    return result.content[0].text if result.content else "{}"
