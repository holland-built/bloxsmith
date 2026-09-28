"""Standalone MCP session for the catalog + drift-check scripts.

Reads INFOBLOX_API_KEY / INFOBLOX_URL from the environment and talks to
csp.infoblox.com/mcp directly — no dependency on server.py, so the catalog
scripts and the nightly drift-check workflow can run on their own.

(This replaces the old `backend.mcp_client` import the catalog scripts used
before the repo layout moved backend/ to the root.)
"""
import asyncio
import email.utils
import os
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
from mcp.client.streamable_http import streamablehttp_client
from mcp.client.session import ClientSession

BASE_URL = os.environ.get("INFOBLOX_URL", "https://csp.infoblox.com").rstrip("/")
MCP_URL = f"{BASE_URL}/mcp"
_KEY = os.environ.get("INFOBLOX_API_KEY", "")
# CSP wants a "Token <key>" Authorization header; accept a bare key too.
if _KEY and not _KEY.lower().startswith("token "):
    _KEY = f"Token {_KEY}"
MCP_HEADERS = {"Authorization": _KEY} if _KEY else {}


# Seconds between calls in call_each. From 2026-09-26 csp.infoblox.com/mcp
# answered 429 after about 28 calls in 8 seconds (#246); spacing them out keeps
# the nightly catalog under whatever the limit is.
PACE = 1.0
# Seconds to wait after each 429 in turn, when the server sends no usable
# Retry-After. Four of them is about 7.5 minutes before giving up.
RATE_LIMIT_WAITS = (30, 60, 120, 240)
# The longest single wait a Retry-After can ask for before we cap it.
MAX_WAIT = 600


@asynccontextmanager
async def _mcp_session(url=None, headers=None):
    # url and headers default to the live tenant; test_mcp_rate_limit.py points
    # them at a local stand-in server instead.
    headers = MCP_HEADERS if headers is None else headers
    if not headers:
        raise SystemExit("INFOBLOX_API_KEY not set — export it before running.")
    async with streamablehttp_client(url or MCP_URL, headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


def _leaves(group):
    for e in group.exceptions:
        if isinstance(e, BaseExceptionGroup):
            yield from _leaves(e)
        else:
            yield e


def _retry_after(response):
    """Seconds the server asked us to wait, from Retry-After as a number or an
    HTTP date; None when it sent neither. Capped at 10 minutes, so a bad date
    cannot hold the nightly job for hours."""
    value = response.headers.get("retry-after", "").strip()
    if value.isdigit():
        return min(float(value), MAX_WAIT)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        return None
    return min(max((when - datetime.now(timezone.utc)).total_seconds(), 0), MAX_WAIT) or None


async def call_each(tool, items, *, pace=PACE, waits=RATE_LIMIT_WAITS, session_factory=_mcp_session):
    """Call `tool` once per argument dict in `items`, in order, and return the
    results in the same order. An ordinary error from one call is returned in
    that item's place, as the catalog loops have always recorded it.

    A 429 is different. The mcp client raises it inside its transport task, not
    from call_tool, so it kills the whole session and escapes as an
    ExceptionGroup when the session closes. That is what stopped the nightly
    drift check (#246). Here a 429 waits (Retry-After when the server sends a
    number, else the next of `waits`), opens a new session, and carries on from
    the first item without a result. Any other failure of the session
    propagates as before.
    """
    results = [None] * len(items)
    done = 0
    for attempt in range(len(waits) + 1):
        limited = None
        try:
            async with session_factory() as session:
                while done < len(items):
                    if done and pace:
                        await asyncio.sleep(pace)
                    try:
                        results[done] = await session.call_tool(tool, items[done])
                    except Exception as e:
                        results[done] = e
                    done += 1
            return results
        except* httpx.HTTPStatusError as group:
            errors = list(_leaves(group))
            if any(e.response.status_code != 429 for e in errors):
                raise
            limited = errors[0].response
        if attempt == len(waits):
            break
        wait = _retry_after(limited) or waits[attempt]
        print(f"  [429] {tool}: rate limited after {done} of {len(items)}; "
              f"waiting {wait:g}s, then resuming", file=sys.stderr)
        await asyncio.sleep(wait)
    raise SystemExit(f"{tool}: still rate limited (429) after {len(waits)} waits; "
                     f"got {done} of {len(items)}")


def _tool_text(result) -> str:
    """First text block of a call_tool result, or '{}' when empty."""
    return result.content[0].text if result.content else "{}"
