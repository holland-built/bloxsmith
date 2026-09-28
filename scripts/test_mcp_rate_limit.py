"""Proves the catalog scripts survive a 429 from the MCP server (#246).

From 2026-09-26 csp.infoblox.com/mcp answered 429 Too Many Requests after
about 28 get_cube_info calls in 8 seconds. The 429 is raised inside the mcp
client's transport task, not by call_tool, so it killed the whole session and
the per-cube try/except never saw it: the nightly drift check died every run.

This starts a local stand-in MCP server that answers ONE tools/call with 429
(Retry-After: 1), then proves two things:

  1. The stand-in reproduces the failure: a plain loop in one session dies.
     If it stops dying, this test proves nothing and says so.
  2. mcp_session.call_each gets through it and returns every item in order.
  3. catalog_cubes.py and catalog_services.py, run as the workflow runs them,
     finish and record every item, whether the 429 lands on their first
     (list) call or part-way through the details.

Needs no API key and no network, so the drift workflow runs it before the
live catalog, and it can be run by hand: python scripts/test_mcp_rate_limit.py
"""
import asyncio
import json
import os
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from mcp.server.fastmcp import FastMCP

from mcp_session import _mcp_session, _tool_text, call_each

TOOL = "infoblox-portal_get_cube_info"
ITEMS = [{"cube_name": f"Cube{i}"} for i in range(10)]
# Named so the catalog scripts' keyword filters pick every one of them.
CUBES = [f"DnsCube{i}" for i in range(8)]
SERVICES = [f"DnsService{i}" for i in range(8)]
HERE = os.path.dirname(os.path.abspath(__file__))
HEADERS = {"Authorization": "Token selftest"}


class RateLimitOnce:
    """ASGI middleware: the Nth tools/call after arm() gets a 429, once."""

    def __init__(self, app, nth):
        self.app = app
        self.arm(nth)

    def arm(self, nth=5):
        self.nth, self.calls, self.fired = nth, 0, False

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        body, more = b"", True
        while more:
            msg = await receive()
            body += msg.get("body", b"")
            more = msg.get("more_body", False)
        if b'"tools/call"' in body:
            self.calls += 1
            if self.calls == self.nth and not self.fired:
                self.fired = True
                await send({"type": "http.response.start", "status": 429,
                            "headers": [(b"retry-after", b"1"), (b"content-type", b"text/plain")]})
                await send({"type": "http.response.body", "body": b"rate limited"})
                return
        replayed = False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def start_server():
    mcp = FastMCP("rate-limit-selftest")

    @mcp.tool(name=TOOL)
    def cube_info(cube_name: str) -> str:
        return json.dumps({"name": cube_name, "measures": [], "dimensions": []})

    @mcp.tool(name="infoblox-portal_list_all_cubes")
    def list_cubes() -> str:
        return json.dumps({"cubes": [{"name": n} for n in CUBES]})

    @mcp.tool(name="infoblox-portal_list_all_available_services")
    def list_services() -> str:
        return json.dumps({"services": [{"service_name": n} for n in SERVICES]})

    @mcp.tool(name="infoblox-portal_get_service_info")
    def service_info(service_name: str) -> str:
        return json.dumps({"endpoints": [{"path": f"/{service_name}", "method": "GET"}]})

    limiter = RateLimitOnce(mcp.streamable_http_app(), nth=5)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(limiter, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    deadline = time.time() + 15
    while not server.started:
        if time.time() > deadline:
            sys.exit("FAIL: the stand-in MCP server did not start")
        time.sleep(0.05)
    return f"http://127.0.0.1:{port}/mcp", limiter


def local_session(url):
    return lambda: _mcp_session(url=url, headers=HEADERS)


async def old_loop(url):
    """The shape catalog_cubes.py had: one session, a try/except per item."""
    out = []
    async with _mcp_session(url=url, headers=HEADERS) as session:
        for args in ITEMS:
            try:
                out.append(await session.call_tool(TOOL, args))
            except Exception as e:
                out.append(e)
    return out


async def main():
    url, limiter = start_server()

    try:
        await asyncio.wait_for(old_loop(url), timeout=30)
        dead = False
    except BaseException:
        dead = True
    if not limiter.fired:
        sys.exit("FAIL: the stand-in never sent its 429, so this test proves nothing")
    if not dead:
        sys.exit("FAIL: a plain loop survived the 429, so the stand-in no longer "
                 "reproduces #246 and this test proves nothing")
    print("ok: a plain loop in one session dies on the 429, as the nightly check did")

    limiter.arm()
    results = await asyncio.wait_for(
        call_each(TOOL, ITEMS, pace=0, waits=(0.1,), session_factory=local_session(url)), timeout=60)
    if not limiter.fired:
        sys.exit("FAIL: the stand-in never sent its 429 to call_each")
    names = []
    for r in results:
        if isinstance(r, BaseException):
            sys.exit(f"FAIL: call_each returned an error for an item: {r!r}")
        names.append(json.loads(_tool_text(r))["name"])
    expected = [a["cube_name"] for a in ITEMS]
    if names != expected:
        sys.exit(f"FAIL: call_each returned {names}, expected {expected}")
    print(f"ok: call_each got all {len(ITEMS)} items through the 429, in order")

    env = {**os.environ, "INFOBLOX_URL": url.removesuffix("/mcp"), "INFOBLOX_API_KEY": "selftest"}
    for script, key, names, nth in (("catalog_cubes.py", "cube_details", CUBES, 1),
                                    ("catalog_cubes.py", "cube_details", CUBES, 4),
                                    ("catalog_services.py", "service_details", SERVICES, 1),
                                    ("catalog_services.py", "service_details", SERVICES, 4)):
        limiter.arm(nth)
        run = await asyncio.to_thread(subprocess.run, [sys.executable, os.path.join(HERE, script)],
                                      env=env, capture_output=True, text=True, timeout=120)
        if run.returncode != 0:
            sys.exit(f"FAIL: {script} exited {run.returncode}:\n{run.stderr[-2000:]}")
        if not limiter.fired:
            sys.exit(f"FAIL: the stand-in never sent its 429 to {script}")
        details = json.loads(run.stdout)[key]
        bad = [n for n in names if n not in details or "error" in details[n]]
        if bad:
            sys.exit(f"FAIL: {script} has no good answer for {bad}")
        print(f"ok: {script} got all {len(names)} items through a 429 on call {nth}")


asyncio.run(main())
