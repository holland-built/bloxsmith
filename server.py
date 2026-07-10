#!/usr/bin/env python3
"""
Bloxsmith — local bridge server.
Serves index.html and proxies requests to the Infoblox portal via MCP.

Usage:  python3 server.py
Then open:  http://localhost:8080
"""

import asyncio, base64, hashlib, hmac, json, os, re, secrets, sys, threading
from contextlib import asynccontextmanager

def _run_async(coro):
    """Run a coroutine from a sync context; creates a fresh event loop per call."""
    return asyncio.run(coro)
import groq as _groq
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from mcp.client.streamable_http import streamablehttp_client
from mcp.client.session import ClientSession
from cryptography.fernet import Fernet, InvalidToken
import glob, ipaddress
import yaml
from dataclasses import dataclass, field

# ── credentials (load .env if present, never hardcode tokens) ─────────────────
_env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
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

API_KEY  = os.environ.get("INFOBLOX_API_KEY", "")
# No env key → run in encrypted-vault mode: the dashboard prompts for a
# passphrase and manages one-or-more tenant keys, AES-encrypted at rest on a
# mounted volume. An env key keeps the original single-key behavior (and all
# existing deployments) working unchanged.
VAULT_MODE = not API_KEY
BASE_URL = os.environ.get("INFOBLOX_URL", "https://csp.infoblox.com")
MCP_URL     = f"{BASE_URL}/mcp"
MCP_HEADERS = {"Authorization": API_KEY}
PORT        = int(os.environ.get("PORT", 8080))
HOST        = os.environ.get("HOST", "localhost")  # keep loopback; for Docker publish with -p 127.0.0.1:8080:8080
# App version shown in the UI footer. CI injects "1.0.<git-commit-count>" at build
# time (bumps every commit); falls back to the local git count, else "dev".
def _git_version():
    try:
        import subprocess
        n = subprocess.check_output(["git", "rev-list", "--count", "HEAD"],
                                    stderr=subprocess.DEVNULL, timeout=2).decode().strip()
        return f"1.0.{n}" if n else "dev"
    except Exception:
        return "dev"
APP_VERSION = os.environ.get("APP_VERSION") or _git_version()

# ── GitHub update check ─────────────────────────────────────────────────────
# Server-side, cached, opt-out. The browser never calls GitHub (avoids CORS,
# per-tab rate-limit burn, and leaking viewer IPs). We poll the Releases API at
# most once per day in a background thread; the status endpoint never waits on it.
APP_REPO = os.environ.get("APP_REPO", "holland-built/bloxsmith")
UPDATE_CHECK_DISABLED = bool(os.environ.get("DISABLE_UPDATE_CHECK"))
_UPDATE_TTL = 24 * 3600  # seconds between checks
import uuid as _uuid
_INSTANCE_ID = str(_uuid.uuid4())[:8]  # unique per process; changes on container recreate
_APPLY_COOLDOWN = 60              # seconds after startup before apply is allowed

_update_cache = {"checked_at": 0.0, "latest": None, "available": False, "html_url": None}
_update_lock = threading.Lock()

# Docker SDK self-update. The socket is mounted by run-image.sh unless
# NO_DOCKER_SOCKET=1. If unavailable, DOCKER_OK stays False and the
# "Update now" button is hidden.
def _docker_client():
    try:
        import docker as _docker
        return _docker.from_env(), True
    except Exception:
        return None, False

_pull_lock = threading.Lock()
_pull_state = {
    "phase": "idle",
    "pct": 0,
    "layer_current": 0,
    "layer_total": 0,
    "stalled": False,
    "error": None,
    "rolledback": False,
    "rollback_from": None,
    "rollback_to": None,
}
# Test Docker availability once at startup
_, DOCKER_OK = _docker_client()

def _ver_n(v):
    """Extract the integer <n> from a '1.0.<n>' / 'v1.0.<n>' version; None if unparseable."""
    if not v:
        return None
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", str(v))
    return int(m.group(3)) if m else None

def _do_update_fetch():
    """Hit the GitHub Releases API with retries; update the cache. Never raises."""
    from urllib.request import urlopen, Request
    req = Request(f"https://api.github.com/repos/{APP_REPO}/releases/latest",
                  headers={"User-Agent": "bloxsmith",
                           "Accept": "application/vnd.github+json"})
    for attempt in range(3):
        try:
            with urlopen(req, timeout=10) as r:
                rel = json.loads(r.read().decode())
            latest, url = rel.get("tag_name"), rel.get("html_url")
            cur_n, latest_n = _ver_n(APP_VERSION), _ver_n(latest)
            available = bool(cur_n is not None and latest_n is not None and latest_n > cur_n)
            with _update_lock:
                _update_cache.update(latest=latest, html_url=url, available=available,
                                     checked_at=_time.monotonic())
            return  # success — do not stamp checked_at again below
        except Exception:
            if attempt < 2:
                _time.sleep(2 ** attempt)  # 1s, 2s between retries
    # all attempts failed — leave latest as last-known, do NOT stamp checked_at
    # so _maybe_check_update retries on the next request instead of waiting the full TTL

def _maybe_check_update():
    """Kick a background refresh if disabled is off and the cache is stale. Returns immediately."""
    if UPDATE_CHECK_DISABLED:
        return
    with _update_lock:
        fresh = (_time.monotonic() - _update_cache["checked_at"]) < _UPDATE_TTL
        if fresh and _update_cache["checked_at"]:
            return
        _update_cache["checked_at"] = _time.monotonic()  # debounce concurrent kicks
    threading.Thread(target=_do_update_fetch, daemon=True).start()

def update_status(force=False):
    if force and not UPDATE_CHECK_DISABLED:
        _do_update_fetch()
    else:
        _maybe_check_update()
    with _update_lock:
        elapsed = _time.monotonic() - _START_TIME
        cooling = elapsed < _APPLY_COOLDOWN
        result = {"current": APP_VERSION, "latest": _update_cache["latest"],
                  "available": _update_cache["available"], "url": _update_cache["html_url"],
                  "checkDisabled": UPDATE_CHECK_DISABLED, "selfUpdate": DOCKER_OK,
                  "cooldown": int(max(0, _APPLY_COOLDOWN - elapsed)) if cooling else 0,
                  "instance_id": _INSTANCE_ID}
    # Auto-kick background pre-pull when update is available and idle
    with _update_lock:
        avail = _update_cache["available"]
    if avail and DOCKER_OK:
        with _pull_lock:
            current_phase = _pull_state["phase"]
        if current_phase == "idle":
            with _update_lock:
                img = f"ghcr.io/{APP_REPO}:latest"
            threading.Thread(target=_run_prepull, args=(img,), daemon=True).start()
    return result

def _run_prepull(image_ref):
    """Background thread: pull the new image while the container stays live.
    Updates _pull_state with real layer progress from the Docker events stream."""
    import time as _t
    client, ok = _docker_client()
    if not ok:
        return
    with _pull_lock:
        _pull_state.update(phase="prepulling", pct=0, layer_current=0,
                           layer_total=0, stalled=False, error=None)
    layers_total = {}
    layers_done = {}
    last_event = _t.monotonic()
    try:
        for event in client.api.pull(image_ref, stream=True, decode=True):
            last_event = _t.monotonic()
            layer = event.get("id", "")
            status = event.get("status", "")
            detail = event.get("progressDetail") or {}
            if status in ("Pulling fs layer", "Waiting"):
                layers_total.setdefault(layer, 0)
            elif status == "Pull complete":
                if layer:
                    layers_done[layer] = True
                    layers_total.setdefault(layer, 1)
            elif status == "Downloading" and detail:
                cur = detail.get("current", 0)
                tot = detail.get("total", 0) or 1
                layers_total[layer] = tot
                layers_done[layer] = cur
            stalled = (_t.monotonic() - last_event) > 20
            if stalled:
                with _pull_lock:
                    _pull_state.update(phase="error", error="pull stalled (no progress for 20 s)")
                return
            total_bytes = sum(layers_total.values()) or 1
            done_bytes = sum(v if isinstance(v, int) else 0
                             for v in layers_done.values())
            pct = min(int(done_bytes * 100 / total_bytes), 99)
            nl = len(layers_total)
            nd = sum(1 for v in layers_done.values() if v is True)
            with _pull_lock:
                _pull_state.update(phase="prepulling", pct=pct,
                                   layer_current=nd, layer_total=nl,
                                   stalled=stalled, error=None)
        with _pull_lock:
            _pull_state.update(phase="pulled", pct=100,
                               layer_current=len(layers_total),
                               layer_total=len(layers_total),
                               stalled=False, error=None)
    except Exception as e:
        _log_exc("_run_prepull", e)
        with _pull_lock:
            _pull_state.update(phase="error", error="pull failed")


def apply_self_update():
    """Inspect self, return HTTP response, then recreate in a detached thread."""
    if not DOCKER_OK:
        return {"ok": False, "error": "docker socket not available"}
    elapsed = _time.monotonic() - _START_TIME
    if elapsed < _APPLY_COOLDOWN:
        remaining = int(_APPLY_COOLDOWN - elapsed)
        return {"ok": False, "error": "cooldown", "retry_after": remaining}
    client, _ = _docker_client()
    try:
        container = client.containers.get(os.environ.get("HOSTNAME", ""))
    except Exception as e:
        _log_exc("apply_self_update", e)
        return {"ok": False, "error": "cannot inspect container"}

    def _do_recreate():
        import time as _t, socket as _sock, json as _json, os as _os
        from urllib.request import urlopen as _urlopen
        _t.sleep(0.3)
        with _pull_lock:
            _pull_state.update(phase="recreating", error=None)
        try:
            attrs = container.attrs
            cfg = attrs.get("HostConfig", {})
            ports = cfg.get("PortBindings") or {}
            vols = cfg.get("Binds") or []
            env = [e for e in (attrs.get("Config", {}).get("Env") or [])
                   if not e.startswith(("APP_VERSION=", "PATH=", "PYTHON_VERSION=",
                                        "PYTHON_SHA256=", "GPG_KEY="))]
            name = attrs.get("Name", "").lstrip("/")
            image = attrs.get("Config", {}).get("Image", "")
            # Prefer the pre-pulled GHCR image so updates on locally-tagged
            # containers (e.g. dev builds named 'bloxsmith') actually land
            # on the new version rather than re-running the old local image.
            ghcr_image = f"ghcr.io/{APP_REPO}:latest"
            try:
                client.images.get(ghcr_image)
                image = ghcr_image
            except Exception:
                pass  # No GHCR image locally — use current container's image
            restart = cfg.get("RestartPolicy", {}).get("Name", "unless-stopped")
            labels = attrs.get("Config", {}).get("Labels") or {}
            networks = list((attrs.get("NetworkSettings") or {}).get("Networks", {}).keys())

            rollback_from = APP_VERSION
            with _update_lock:
                rollback_to = _update_cache.get("latest") or ""
            try:
                client.images.get(image).tag("bloxsmith", "rollback")
            except Exception:
                pass

            ports_map = {}
            for _k, _bindings in ports.items():
                if _bindings:
                    ports_map[_k] = [
                        [b.get("HostIp") or "", b["HostPort"]] if b.get("HostIp")
                        else int(b["HostPort"])
                        for b in _bindings
                    ]
            tmp_name = name + "-retiring"
            net = networks[0] if networks else None

            candidate_name = name + "-candidate"
            try:
                client.containers.get(candidate_name).remove(force=True)
            except Exception:
                pass
            with _pull_lock:
                _pull_state.update(phase="checking", error=None)

            # No port mapping — health probe uses docker exec (in-container),
            # so no host port is needed and no conflict is possible.
            candidate = client.containers.run(
                image,
                name=candidate_name,
                environment=env,
                volumes=vols,
                restart_policy={},
                labels=labels,
                detach=True,
            )

            # Health probe via docker exec (in-container, network-agnostic).
            # The server runs inside a container so 127.0.0.1:<host-port> is
            # unreachable from here; exec runs inside the candidate instead.
            def _wait_healthy(deadline=30, interval=2):
                end = _t.monotonic() + deadline
                while _t.monotonic() < end:
                    try:
                        result = candidate.exec_run(
                            ["python3", "-c",
                             "from urllib.request import urlopen;"
                             "r=urlopen('http://127.0.0.1:8080/api/vault/status',timeout=3);"
                             "exit(0 if r.status==200 else 1)"],
                        )
                        if result.exit_code == 0:
                            return True
                    except Exception:
                        pass
                    _t.sleep(interval)
                return False

            healthy = _wait_healthy()

            if healthy:
                try:
                    candidate.stop(timeout=3)
                    candidate.remove(force=True)
                except Exception:
                    pass
                container.rename(tmp_name)
                helper_script = (
                    "import json,sys,time,docker\n"
                    "c=docker.from_env()\n"
                    "cfg=json.loads(sys.argv[1])\n"
                    "time.sleep(3)\n"
                    "try: c.containers.get(cfg['old']).remove(force=True)\n"
                    "except Exception: pass\n"
                    "try: c.images.pull(cfg['img'])\n"
                    "except Exception: pass\n"
                    "p={k:[tuple(b) if isinstance(b,list) else b for b in v]"
                    " for k,v in cfg['ports'].items()}\n"
                    "kw={'network':cfg['net']} if cfg.get('net') else {}\n"
                    "c.containers.run(cfg['img'],detach=True,name=cfg['name'],"
                    "environment=cfg['env'],ports=p,volumes=cfg['vols'],"
                    "restart_policy={'Name':cfg['restart']},labels=cfg['labels'],**kw)\n"
                )
                cfg_json = _json.dumps({
                    'old': tmp_name, 'img': image, 'name': name,
                    'env': env, 'ports': ports_map, 'vols': vols,
                    'restart': restart, 'labels': labels, 'net': net,
                })
                sock_vols = [v for v in vols if '.sock' in v]
                try:
                    client.containers.get(name + "-updater").remove(force=True)
                except Exception:
                    pass
                client.containers.run(
                    image,
                    name=name + "-updater",
                    command=['python3', '-c', helper_script, cfg_json],
                    volumes=sock_vols,
                    detach=True,
                    remove=False,
                )
                with _pull_lock:
                    _pull_state.update(phase="live", error=None)
                _t.sleep(0.5)
                _os.kill(1, 9)

            else:
                try:
                    candidate.stop(timeout=3)
                    candidate.remove(force=True)
                except Exception:
                    pass
                try:
                    orig = client.containers.get(name)
                    if orig.status != "running":
                        orig.start()
                except Exception:
                    pass
                with _pull_lock:
                    _pull_state.update(
                        phase="rolledback",
                        error="new image failed health check after 30 s",
                        rolledback=True,
                        rollback_from=rollback_from,
                        rollback_to=rollback_to,
                    )

        except Exception as e:
            try:
                client.containers.get(name + "-candidate").remove(force=True)
            except Exception:
                pass
            try:
                container.rename(name)
            except Exception:
                pass
            try:
                orig = client.containers.get(name)
                if orig.status != "running":
                    orig.start()
            except Exception:
                pass
            _log_exc("_do_recreate", e)
            with _pull_lock:
                _pull_state.update(
                    phase="rolledback",
                    error="recreate failed",
                    rolledback=True,
                    rollback_from=APP_VERSION,
                    rollback_to="",
                )

    threading.Thread(target=_do_recreate, daemon=True).start()
    return {"ok": True}

# Shared-secret for the state-changing write endpoint (/api/block-domain).
# If unset, that write is disabled (401). Supply it via the X-Auth-Token header.
DASHBOARD_TOKEN = os.environ.get("DASHBOARD_TOKEN", "")
# Explicit, allowlisted block list id for /api/block-domain (no fuzzy name match).
BLOCK_LIST_ID   = os.environ.get("BLOCK_LIST_ID", "")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
# LLM config — works with Groq or any OpenAI-compatible provider, no code edits.
# LLM_API_KEY falls back to GROQ_API_KEY for back-compat.
LLM_API_KEY  = os.environ.get("LLM_API_KEY") or GROQ_API_KEY  # `or`, not default: an empty env var must still fall back to GROQ_API_KEY
LLM_MODEL    = os.environ.get("LLM_MODEL") or "qwen/qwen3-32b"  # `or`, not default: an empty env var must still fall back to the default model
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "")  # blank = Groq default endpoint
DIR          = os.path.dirname(os.path.abspath(__file__))
_STATIC_FILES = frozenset(os.listdir(DIR))  # cached once; avoids O(n) fs hit per request

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript",
    ".css":  "text/css",
    ".json": "application/json",
    ".woff2": "font/woff2",
}

# Allowlist: Parquet table names returned by MCP are alphanumeric + _ - and .
# (the name carries a .parquet extension, e.g. ipamsvc_ipam_subnet_get.parquet)
_TABLE_RE = re.compile(r'^[a-zA-Z0-9_][a-zA-Z0-9_.\-]{0,127}$')

# Strict FQDN validation for the block-domain write path.
_FQDN_RE = re.compile(
    r'^(?=.{1,253}$)([a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$'
)

# IPv4 / IPv6 detection for Dossier indicator-type inference & validation.
_IP_RE = re.compile(
    r'^(\d{1,3}\.){3}\d{1,3}$'                 # IPv4
    r'|^(?=.*:)[0-9a-fA-F:]{2,45}$'            # IPv6 (loose; must contain a colon)
)

# ── Server-side TTL cache (5 min) ────────────────────────────────────────────
import time as _time
_START_TIME = _time.monotonic()   # used for post-restart apply cooldown
_cache: dict = {}
CACHE_TTL = 300  # seconds
CACHE_MAX = 256  # cap entries to bound memory

def _cache_key(service, endpoint, params, fetch_all):
    return f"{service}|{endpoint}|{str(sorted((params or {}).items()))}|{fetch_all}"

def _cache_get(key):
    entry = _cache.get(key)
    if entry and (_time.time() - entry[0]) < CACHE_TTL:
        return entry[1]
    return None

def _cache_set(key, value):
    # evict oldest entries when over the cap to bound memory growth
    if len(_cache) >= CACHE_MAX and key not in _cache:
        for _old in sorted(_cache, key=lambda k: _cache[k][0])[:len(_cache) - CACHE_MAX + 1]:
            _cache.pop(_old, None)
    _cache[key] = (_time.time(), value)

def cache_invalidate():
    _cache.clear()

# ── server-side cache-warmer (keep data hot so no load is ever cold) ──────────
WARM_INTERVAL = 240   # < CACHE_TTL (300) so cached entries never expire cold
_warm_lock = threading.Lock()

def _warm_tick():
    if VAULT_MODE and not MCP_HEADERS.get("Authorization"):
        return
    if not _warm_lock.acquire(blocking=False):
        return
    try:
        auth_before = MCP_HEADERS.get("Authorization")
        try: _maybe_refresh_jwt()
        except Exception: pass
        for fn in (fetch_dashboard_data, fetch_hub_health, fetch_hub_security, fetch_hub_domains):
            try: fn()
            except Exception as e: _log_exc("warm:"+fn.__name__, e)
        if MCP_HEADERS.get("Authorization") != auth_before:
            cache_invalidate()   # auth rotated mid-warm → drop rows keyed to the old tenant
    finally:
        _warm_lock.release()

def _warm_loop():
    _time.sleep(3)
    while True:
        _warm_tick()
        _time.sleep(WARM_INTERVAL)

# ── CSP account switching (portal-style sandbox switch, same API key) ─────────
# The CSP identity API lists every account the key's user can act in, and
# /v2/session/account_switch issues a Bearer JWT scoped to the chosen account.
# The home account always uses the long-lived Token key; other accounts use
# the (expiring, ~1h) JWT — re-switch from the UI if it lapses.

_HOME_ACCOUNT_ID = ""   # account the API key natively belongs to
_active_account_id = ""
_jwt_issued_at = 0.0    # when the current account JWT was minted
_JWT_REFRESH_AFTER = 50 * 60  # re-mint before the ~1h CSP expiry

def _maybe_refresh_jwt():
    """Re-mint the account JWT before it expires so a switched session
    doesn't silently die after ~1h. No-op on the home account."""
    if (_active_account_id and _HOME_ACCOUNT_ID
            and _active_account_id != _HOME_ACCOUNT_ID
            and _time.time() - _jwt_issued_at > _JWT_REFRESH_AFTER):
        try:
            switch_account(_active_account_id)
            print(f"  [info] refreshed account JWT for {_active_account_id}")
        except Exception as e:
            print(f"  [warn] JWT refresh failed: {e}", file=sys.stderr)

def _csp_json(path: str, body: dict | None = None) -> dict:
    """Small sync helper for CSP identity endpoints. Always authenticates with
    the original long-lived key so an expired account JWT can't lock us out."""
    from urllib.request import urlopen, Request
    data = json.dumps(body).encode() if body is not None else None
    req = Request(f"{BASE_URL}{path}", data=data,
                  headers={"Authorization": API_KEY,
                           "Content-Type": "application/json"})
    with urlopen(req, timeout=15) as r:
        parsed = json.loads(r.read())
        return parsed if isinstance(parsed, dict) else {}

def list_accounts() -> dict:
    global _HOME_ACCOUNT_ID, _active_account_id
    accounts = [{"id": a.get("id", ""), "name": a.get("name", "")}
                for a in _csp_json("/v2/current_user/accounts").get("results", [])
                if a.get("state", "active") == "active"]
    accounts.sort(key=lambda a: a["name"].lower())
    if not _HOME_ACCOUNT_ID:
        # resolve once: the account the raw API key is bound to
        try:
            home = _csp_json("/v2/current_user").get("result", {}).get("account_id", "")
        except Exception:
            home = ""
        _HOME_ACCOUNT_ID = home or (accounts[0]["id"] if accounts else "")
        if not _active_account_id:
            _active_account_id = _HOME_ACCOUNT_ID
    return {"accounts": accounts, "active": _active_account_id}

def switch_account(account_id: str) -> dict:
    """Switch the MCP proxy to another CSP account the user belongs to."""
    global _active_account_id, _jwt_issued_at
    known = {a["id"]: a["name"] for a in list_accounts()["accounts"]}
    if account_id not in known:
        return {"ok": False, "error": "unknown account"}
    if account_id == _HOME_ACCOUNT_ID:
        MCP_HEADERS["Authorization"] = API_KEY  # long-lived key beats a JWT
    else:
        resp = _csp_json("/v2/session/account_switch", {"id": account_id})
        jwt = resp.get("jwt") or resp.get("result", {}).get("jwt", "")
        if not jwt:
            return {"ok": False, "error": "switch failed (no jwt in response)"}
        MCP_HEADERS["Authorization"] = f"Bearer {jwt}"
        _jwt_issued_at = _time.time()
    _active_account_id = account_id
    cache_invalidate()  # cached rows belong to the previous tenant
    return {"ok": True, "active": account_id, "name": known[account_id]}

def _rest_get(path: str, params: dict | None = None) -> list:
    """Direct Infoblox REST GET → results list. Uses active tenant/account auth."""
    import urllib.request, urllib.parse
    q = ("?" + urllib.parse.urlencode(params)) if params else ""
    url = f"{BASE_URL}{path}{q}"
    auth = MCP_HEADERS.get("Authorization") or API_KEY
    req = urllib.request.Request(url, headers={"Authorization": auth, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=35) as r:
            j = json.loads(r.read())
        if isinstance(j, dict):
            return j.get("results", j.get("result", []) or [])
        return j if isinstance(j, list) else []
    except Exception as e:
        print(f"  [warn] rest_get {path}: {e}")
        return []

def _rest_get_ex(path: str, params: dict | None = None) -> tuple:
    """Status-surfacing REST GET → (parsed_json, http_status). Unlike _rest_get,
    this returns the raw parsed body (dict or list) plus the HTTP status code so
    callers can branch on 403/entitlement. status is None on a network error.
    Uses the active tenant/account auth. Does NOT modify _rest_get."""
    import urllib.request, urllib.parse, urllib.error
    q = ("?" + urllib.parse.urlencode(params)) if params else ""
    url = f"{BASE_URL}{path}{q}"
    auth = MCP_HEADERS.get("Authorization") or API_KEY
    req = urllib.request.Request(url, headers={"Authorization": auth, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=35) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return None, e.code
    except Exception as e:
        print(f"  [warn] rest_get_ex {path}: {e}")
        return None, None

def _rest_write(method: str, path: str, body: dict | None = None, params: dict | None = None) -> tuple:
    """Direct Infoblox REST write (POST/PATCH/DELETE) → (parsed_json, http_status).
    Mirrors _rest_get_ex's error handling. Callers pass the full path incl. the
    /api/ddi/v1 prefix. Uses active tenant/account auth. status is None on a
    network error (no HTTP response at all)."""
    import urllib.request, urllib.parse, urllib.error
    q = ("?" + urllib.parse.urlencode(params)) if params else ""
    url = f"{BASE_URL}{path}{q}"
    auth = MCP_HEADERS.get("Authorization") or API_KEY
    data = json.dumps(body).encode() if body is not None else b""
    req = urllib.request.Request(
        url, data=data, method=method.upper(),
        headers={"Authorization": auth, "Accept": "application/json", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=35) as r:
            raw = r.read()
            return (json.loads(raw) if raw else None), r.status
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read())
        except Exception:
            err_body = None
        return err_body, e.code
    except Exception as e:
        print(f"  [warn] rest_write {method} {path}: {e}")
        return None, None

def _dns_rdata(rtype: str, value: str) -> dict:
    """Presentation-format value → API rdata dict. Full port of the reference
    client.py's _rdata_str_to_dict — covers A/AAAA/CNAME/PTR/NS/DNAME/TXT/MX/
    SRV/CAA, falling back to a generic PRESENTATION subfield for other types.
    Raises ValueError on missing/malformed fields, mirroring the reference."""
    rtype = (rtype or "").upper().strip()
    v = (value or "").strip()
    if not v:
        raise ValueError(f"rdata is required for {rtype} records")
    if rtype in ("A", "AAAA"):
        return {"address": v}
    if rtype == "CNAME":
        return {"cname": v}
    if rtype in ("PTR", "NS"):
        return {"dname": v}
    if rtype == "DNAME":
        return {"target": v}
    if rtype == "TXT":
        if v.startswith('"') and v.endswith('"') and len(v) >= 2:
            v = v[1:-1]
        return {"text": v}
    if rtype == "MX":
        parts = v.split(None, 1)
        if len(parts) != 2:
            raise ValueError(f'MX rdata must be "preference exchange" (e.g. "10 mail.example.com."), got: {v!r}')
        try:
            return {"preference": int(parts[0]), "exchange": parts[1]}
        except ValueError:
            raise ValueError(f"MX preference must be an integer, got: {parts[0]!r}")
    if rtype == "SRV":
        parts = v.split(None, 3)
        if len(parts) != 4:
            raise ValueError(f'SRV rdata must be "priority weight port target" (e.g. "10 0 443 host.example.com."), got: {v!r}')
        try:
            return {"priority": int(parts[0]), "weight": int(parts[1]), "port": int(parts[2]), "target": parts[3]}
        except ValueError as exc:
            raise ValueError(f"SRV rdata contains non-integer field: {exc}")
    if rtype == "CAA":
        parts = v.split(None, 2)
        if len(parts) != 3:
            raise ValueError(f'CAA rdata must be "flags tag value" (e.g. "0 issue letsencrypt.org"), got: {v!r}')
        try:
            return {"flags": int(parts[0]), "tag": parts[1], "value": parts[2]}
        except ValueError:
            raise ValueError(f"CAA flags must be an integer, got: {parts[0]!r}")
    # Generic fallback — wrap as PRESENTATION subfield
    return {"subfields": [{"type": "PRESENTATION", "value": v}]}


def _dns_record_create(body: dict) -> tuple:
    """Build + POST a single DNS record. Port of portal.py's create_dns_record
    validation (name_in_zone/zone_id/type/value all required) plus client.py's
    create_dns_record body shape. `view` is deliberately never included: the
    API treats zone+view as mutually exclusive creation paths and rejects the
    combination with a 400 when zone is already set."""
    zone_id = str(body.get("zone_id") or "").strip()
    name_in_zone = body.get("name_in_zone")
    rtype = str(body.get("type") or "").strip().upper()
    value = str(body.get("value") or "").strip()
    dry = bool(body.get("dry"))

    if not rtype:
        return {"ok": False, "error": "type is required"}, 400
    if not zone_id:
        return {"ok": False, "error": "zone_id is required"}, 400
    if name_in_zone is None or str(name_in_zone).strip() == "":
        return {"ok": False, "error": 'name_in_zone is required (use "@" for the zone apex)'}, 400
    if not value:
        return {"ok": False, "error": f"value is required for {rtype} records"}, 400

    name_in_zone = str(name_in_zone).strip()
    if name_in_zone == "@":
        name_in_zone = ""

    try:
        rdata = _dns_rdata(rtype, value)
    except ValueError as e:
        return {"ok": False, "error": str(e)}, 400

    record_body = {"name_in_zone": name_in_zone, "zone": zone_id, "type": rtype, "rdata": rdata}
    if body.get("ttl") is not None:
        try:
            record_body["ttl"] = int(body["ttl"])
        except (TypeError, ValueError):
            return {"ok": False, "error": "ttl must be an integer"}, 400
    if body.get("comment"):
        record_body["comment"] = str(body["comment"])

    if dry:
        return {"ok": True, "dry_run": True, "record": record_body}, 200

    resp, status = _rest_write("POST", "/api/ddi/v1/dns/record", record_body)
    if status not in (200, 201) or resp is None:
        return {"ok": False, "error": f"create failed (status {status})", "detail": resp}, status or 502

    rec = resp.get("result") if isinstance(resp, dict) else None
    return {"ok": True, "record": rec or resp}, status


def _dns_record_update(body: dict) -> tuple:
    """Read-modify-write PATCH for a single DNS record (port of client.py's
    modify_dns_record). Only rebuilds fields the caller supplied — never
    blind-writes the full record, which would risk clobbering read-only
    fields. Falls back from PATCH to PUT if the upstream API rejects PATCH
    with 405 (some Infoblox record endpoints only accept PUT for updates)."""
    record_id = str(body.get("id") or "").strip()
    if not record_id:
        return {"ok": False, "error": "id is required"}, 400
    dry = bool(body.get("dry"))

    current, cur_status = _rest_get_ex(f"/api/ddi/v1/dns/record/{record_id}")
    if cur_status != 200 or not isinstance(current, dict):
        return {"ok": False, "error": f"record not found (status {cur_status})"}, (cur_status or 502)
    cur_record = current.get("result") or current
    cur_type = str(cur_record.get("type") or "").upper()

    update_body = {}
    if body.get("value") is not None:
        try:
            update_body["rdata"] = _dns_rdata(cur_type, str(body["value"]))
        except ValueError as e:
            return {"ok": False, "error": str(e)}, 400
    if body.get("ttl") is not None:
        try:
            update_body["ttl"] = int(body["ttl"])
        except (TypeError, ValueError):
            return {"ok": False, "error": "ttl must be an integer"}, 400
    if body.get("comment") is not None:
        update_body["comment"] = str(body["comment"])
    if body.get("disabled") is not None:
        update_body["disabled"] = bool(body["disabled"])

    if not update_body:
        return {"ok": False, "error": "no fields to update (value/ttl/comment/disabled)"}, 400

    if dry:
        return {"ok": True, "dry_run": True, "id": record_id, "would_update": update_body}, 200

    resp, status = _rest_write("PATCH", f"/api/ddi/v1/dns/record/{record_id}", update_body)
    method_used = "PATCH"
    if status == 405:
        # PATCH-then-PUT fallback: this environment cannot be live-tested
        # against the real API, so if PATCH is rejected as unsupported we
        # retry the same minimal body with PUT before giving up.
        resp, status = _rest_write("PUT", f"/api/ddi/v1/dns/record/{record_id}", update_body)
        method_used = "PUT"
    if status not in (200, 201) or resp is None:
        return {"ok": False, "error": f"update failed (status {status})", "detail": resp, "method": method_used}, status or 502

    rec = resp.get("result") if isinstance(resp, dict) else None
    return {"ok": True, "method": method_used, "record": rec or resp}, 200

def _cidr_to_reverse_zone(address: str, prefix_len: int) -> str:
    """Derive the in-addr.arpa reverse zone FQDN for an IPv4 network. Port of the
    reference portal.py helper — supports /8, /16, /24 natural boundaries; other
    prefix lengths fall back to the enclosing /8."""
    import ipaddress
    net = ipaddress.ip_network(f"{address}/{prefix_len}", strict=False)
    octets = str(net.network_address).split(".")
    if prefix_len >= 24:
        significant = octets[:3]
    elif prefix_len >= 16:
        significant = octets[:2]
    else:
        significant = octets[:1]
    return ".".join(reversed(significant)) + ".in-addr.arpa."

def _selfservice_allocate(body: dict) -> tuple:
    """Port of the reference allocate_ip (portal.py) using direct REST calls.
    Resolves a subnet (directly by id, or by tag lookup), reserves the next
    available IP(s), and optionally creates a DNS record for the first address.
    Returns (result_dict, http_status)."""
    subnet_id = str(body.get("subnet_id") or "").strip()
    tag_key = str(body.get("tag_key") or "").strip()
    tag_value = str(body.get("tag_value") or "").strip()
    try:
        count = int(body.get("count") or 1)
    except (TypeError, ValueError):
        count = 1
    name = str(body.get("name") or "").strip()
    dry = bool(body.get("dry"))
    dns = body.get("dns") or None

    if not subnet_id:
        if not (tag_key and tag_value):
            return {"ok": False, "error": "subnet_id or tag_key/tag_value required"}, 400
        subnets = _rest_get("/api/ddi/v1/ipam/subnet", {"_tfilter": f'{tag_key}=="{tag_value}"'})
        if not subnets:
            return {"ok": False, "error": f"No subnet found with tag {tag_key}=={tag_value}"}, 404
        subnet_id = subnets[0].get("id")

    if dry:
        result = {"ok": True, "dry_run": True, "subnet_id": subnet_id, "would_allocate": count, "addresses": []}
        if name:
            result["name"] = name
        if dns:
            result["record"] = {"dry_run": True, **dns}
        return result, 200

    body_extra = {}
    if name:
        body_extra["name"] = name
    resp, status = _rest_write(
        "POST", f"/api/ddi/v1/ipam/subnet/{subnet_id}/nextavailableip",
        body=body_extra or None, params={"count": count})
    if status not in (200, 201) or resp is None:
        return {"ok": False, "error": f"allocation failed (status {status})", "detail": resp}, status or 502

    addresses = resp.get("results") if isinstance(resp, dict) else None
    if not addresses and isinstance(resp, dict) and resp.get("result"):
        addresses = [resp["result"]]
    addresses = addresses or []
    out = {"ok": True, "addresses": [{"id": a.get("id"), "address": a.get("address")} for a in addresses]}

    if dns and addresses:
        zone_id = str(dns.get("zone_id") or "")
        rname = str(dns.get("name") or "")
        rtype = str(dns.get("type") or "A").upper()
        rvalue = str(dns.get("value") or addresses[0].get("address") or "")
        record_body = {"name_in_zone": rname, "zone": zone_id, "type": rtype, "rdata": _dns_rdata(rtype, rvalue)}
        rresp, rstatus = _rest_write("POST", "/api/ddi/v1/dns/record", body=record_body)
        if rstatus in (200, 201) and isinstance(rresp, dict):
            rec = rresp.get("result") or (rresp.get("results") or [None])[0]
            out["record"] = {"ok": True, "id": (rec or {}).get("id"), "status": rstatus}
        else:
            out["record"] = {"ok": False, "status": rstatus, "detail": rresp}

    return out, 200

# ── Phase-1 provisioning: template engine (port of Chris Marrison's UDDI ─────
#    Automation Toolkit — core.py + block/provision.py + site/provision.py).
#    Orchestration is ported, not the CLI/argparse/INI-file plumbing: request
#    params take the place of CLI flags, and the only remaining precedence
#    tier is YAML template value → hardcoded fallback (no env/INI tier).
class ProvisionError(Exception):
    """Raised instead of sys.exit() by the ported toolkit functions so a bad
    template or a failed API call turns into a JSON/SSE error response
    instead of killing the server process."""
    pass

TEMPLATES_DIR = os.environ.get("TEMPLATES_DIR", os.path.join(DIR, "templates"))
# Hardcoded fallbacks substituting for the reference toolkit's uddi.ini
# [DEFAULTS] tier, which this port drops (no INI/env config file here).
DEFAULT_IP_SPACE   = "default"
DEFAULT_DNS_PARENT = "internal.example.com"


def load_template(name: str) -> dict:
    """Load + parse a YAML template by path relative to TEMPLATES_DIR. Port of
    core.load_yaml_template, adapted to raise ProvisionError instead of
    sys.exit and to reject paths that escape TEMPLATES_DIR."""
    safe = str(name or "").strip()
    if not safe:
        raise ProvisionError("template name is required")
    base = os.path.realpath(TEMPLATES_DIR)
    path = os.path.realpath(os.path.join(base, safe))
    if path != base and not path.startswith(base + os.sep):
        raise ProvisionError(f"invalid template name: {name}")
    try:
        with open(path, "r") as fh:
            data = yaml.safe_load(fh)
    except FileNotFoundError:
        raise ProvisionError(f"template not found: {name}")
    except yaml.YAMLError as exc:
        raise ProvisionError(f"invalid YAML in {name}: {exc}")
    if not isinstance(data, dict):
        raise ProvisionError(f"template must be a mapping at the top level: {name}")
    return data


# ---------------------------------------------------------------------------
# Template type + validation — pure port of core.py, no API calls.
# ---------------------------------------------------------------------------

TEMPLATE_TYPES = ("site", "address-block", "dns")


def template_type(template: dict) -> str:
    """Classify a parsed template as 'site', 'address-block', 'dns', or
    'unknown'. Honours an explicit type: field; otherwise infers from the
    distinguishing top-level section. Port of core.template_type."""
    explicit = str(template.get("type", "")).strip().lower()
    if explicit in TEMPLATE_TYPES:
        return explicit
    if template.get("address_blocks") is not None:
        return "address-block"
    if template.get("zones") is not None:
        return "dns"
    if template.get("site") is not None or template.get("network") is not None:
        return "site"
    return "unknown"


SUPPORTED_RECORD_TYPES = ("A", "AAAA", "CNAME", "MX", "TXT", "PTR")


def build_record_body(zone_id: str, record: dict) -> dict:
    """Build a POST /dns/record body from a template record definition. Port
    of core.build_record_body — raises ValueError on a malformed record."""
    rtype = str(record.get("type", "")).strip().upper()
    if rtype not in SUPPORTED_RECORD_TYPES:
        raise ValueError(f"Unsupported record type {rtype!r}; supported: {', '.join(SUPPORTED_RECORD_TYPES)}")
    raw = record.get("rdata")
    if rtype in ("A", "AAAA"):
        rdata = {"address": str(raw)}
    elif rtype == "CNAME":
        rdata = {"cname": str(raw)}
    elif rtype == "TXT":
        rdata = {"text": str(raw)}
    elif rtype == "PTR":
        rdata = {"dname": str(raw)}
    else:  # MX
        if not isinstance(raw, dict):
            raise ValueError("MX rdata must be a mapping with preference and exchange")
        pref = raw.get("preference", raw.get("pref"))
        exchange = raw.get("exchange", "")
        if pref is None or not exchange:
            raise ValueError("MX rdata requires both preference and exchange")
        rdata = {"preference": int(pref), "exchange": str(exchange)}
    name = str(record.get("name", "")).strip()
    if name == "@":
        name = ""
    body = {"name_in_zone": name, "zone": zone_id, "type": rtype, "rdata": rdata}
    if record.get("ttl") is not None:
        body["ttl"] = int(record["ttl"])
    return body


def _validate_site(template: dict, errors: list, warnings: list) -> None:
    """Structural validation of a site template. Port of core._validate_site."""
    def _err(f, m): errors.append({"field": f, "message": m})
    def _warn(f, m): warnings.append({"field": f, "message": m})

    site = template.get("site") or {}
    if not isinstance(site, dict):
        _err("site", "Must be a mapping"); site = {}
    name = str(site.get("name", "")).strip()
    if not name:
        _err("site.name", "Required and must be non-empty")
    elif " " in name:
        _warn("site.name", "Contains spaces — consider hyphens for DNS compatibility")
    if not site.get("region"):
        _warn("site.region", "Not specified — useful for block-selection filtering")
    if not site.get("environment"):
        _warn("site.environment", "Not specified")

    net = template.get("network") or {}
    if net and not isinstance(net, dict):
        _err("network", "Must be a mapping"); net = {}
    if not net.get("ip_space"):
        _warn("network.ip_space", f"Not set — falls back to {DEFAULT_IP_SPACE!r}")

    subnet_size = net.get("subnet_size")
    if subnet_size is not None:
        try:
            sz = int(subnet_size)
            if not 8 <= sz <= 30:
                _err("network.subnet_size", f"CIDR prefix {sz} is outside valid range 8-30")
        except (TypeError, ValueError):
            _err("network.subnet_size", f"Must be an integer, got {subnet_size!r}")

    subnet_names = set()
    subnets = net.get("subnets") or []
    if subnets and not isinstance(subnets, list):
        _err("network.subnets", "Must be a list"); subnets = []
    for i, s in enumerate(subnets):
        pfx = f"network.subnets[{i}]"
        if not isinstance(s, dict):
            _err(pfx, "Each subnet must be a mapping"); continue
        sname = str(s.get("name", "")).strip()
        if not sname:
            _warn(f"{pfx}.name", "Subnet name is empty")
        else:
            if sname in subnet_names:
                _err(f"{pfx}.name", f"Duplicate subnet name {sname!r}")
            subnet_names.add(sname)
        if not s.get("purpose"):
            _warn(f"{pfx}.purpose", "No purpose specified")
        cidr = s.get("cidr")
        if cidr is not None:
            try:
                c = int(cidr)
                if not 8 <= c <= 30:
                    _err(f"{pfx}.cidr", f"CIDR prefix {c} is outside valid range 8-30")
            except (TypeError, ValueError):
                _err(f"{pfx}.cidr", f"Must be an integer, got {cidr!r}")
        if s.get("dhcp"):
            for off_key in ("dhcp_start", "dhcp_end"):
                val = s.get(off_key)
                if val is not None:
                    try:
                        v = int(val)
                        if not 1 <= v <= 254:
                            _err(f"{pfx}.{off_key}", f"Host offset {v} outside 1-254")
                    except (TypeError, ValueError):
                        _err(f"{pfx}.{off_key}", f"Must be an integer, got {val!r}")

    dns = template.get("dns") or {}
    if dns and not isinstance(dns, dict):
        _err("dns", "Must be a mapping"); dns = {}
    if not dns.get("parent"):
        _warn("dns.parent", f"Not set — falls back to {DEFAULT_DNS_PARENT!r}")
    for bool_key in ("create_zone", "create_reverse_zone"):
        val = dns.get(bool_key)
        if val is not None and not isinstance(val, bool):
            _err(f"dns.{bool_key}", f"Must be true or false, got {val!r}")

    hosts = template.get("hosts") or []
    if hosts and not isinstance(hosts, list):
        _err("hosts", "Must be a list"); hosts = []
    for i, h in enumerate(hosts):
        pfx = f"hosts[{i}]"
        if not isinstance(h, dict):
            _err(pfx, "Each host must be a mapping"); continue
        if not h.get("hostname"):
            _err(f"{pfx}.hostname", "hostname is required")
        ref = str(h.get("subnet", "")).strip()
        if ref and subnet_names and ref not in subnet_names:
            _err(f"{pfx}.subnet", f"References unknown subnet {ref!r}; defined: {sorted(subnet_names)}")

    tags = template.get("tags") or {}
    if tags and not isinstance(tags, dict):
        _err("tags", "Must be a mapping of key: value pairs")
    elif tags:
        for k, v in tags.items():
            if not isinstance(k, str):
                _err("tags", f"Tag key {k!r} must be a string")
            if v is not None and not isinstance(v, (str, int, float, bool)):
                _warn(f"tags.{k}", f"Value {v!r} is not a scalar")


def _validate_block(template: dict, errors: list, warnings: list) -> None:
    """Structural validation of an address-block template (recursive over
    nested children). Port of core._validate_block."""
    def _err(f, m): errors.append({"field": f, "message": m})
    def _warn(f, m): warnings.append({"field": f, "message": m})

    if not str(template.get("name", "")).strip():
        _warn("name", "No template name — used to tag and later find created blocks")

    blocks = template.get("address_blocks")
    if not blocks:
        _err("address_blocks", "Required and must be a non-empty list"); blocks = []
    elif not isinstance(blocks, list):
        _err("address_blocks", "Must be a list"); blocks = []

    def _check_block(block, pfx, parent_net):
        if not isinstance(block, dict):
            _err(pfx, "Each block must be a mapping"); return
        addr = str(block.get("address", "")).strip()
        cidr = block.get("cidr")
        net = None
        if not addr:
            _err(f"{pfx}.address", "Required")
        if cidr is None:
            _err(f"{pfx}.cidr", "Required")
        else:
            try:
                c = int(cidr)
                if not 8 <= c <= 30:
                    _err(f"{pfx}.cidr", f"CIDR prefix {c} is outside valid range 8-30")
                elif addr:
                    net = ipaddress.ip_network(f"{addr}/{c}", strict=False)
            except (TypeError, ValueError) as exc:
                _err(f"{pfx}.cidr", f"Invalid address/cidr: {exc}")
        if net is not None and parent_net is not None:
            if not (net.subnet_of(parent_net) and net != parent_net):
                _err(pfx, f"{net} is not contained within parent {parent_net}")
        if parent_net is None:
            if not block.get("region"):
                _warn(f"{pfx}.region", "No region — site discovery filters on Region")
            if not block.get("environment"):
                _warn(f"{pfx}.environment", "No environment — site discovery filters on Environment")
        children = block.get("children") or []
        if children and not isinstance(children, list):
            _err(f"{pfx}.children", "Must be a list"); children = []
        for j, child in enumerate(children):
            _check_block(child, f"{pfx}.children[{j}]", net)

    for i, block in enumerate(blocks):
        _check_block(block, f"address_blocks[{i}]", None)


def _validate_dns(template: dict, errors: list, warnings: list) -> None:
    """Structural validation of a dns template. Port of core._validate_dns."""
    def _err(f, m): errors.append({"field": f, "message": m})

    zones = template.get("zones")
    if not zones:
        _err("zones", "Required and must be a non-empty list"); zones = []
    elif not isinstance(zones, list):
        _err("zones", "Must be a list"); zones = []

    for i, zone in enumerate(zones):
        pfx = f"zones[{i}]"
        if not isinstance(zone, dict):
            _err(pfx, "Each zone must be a mapping"); continue
        if not str(zone.get("fqdn", "")).strip():
            _err(f"{pfx}.fqdn", "Required and must be non-empty")
        kind = str(zone.get("kind", "forward")).strip().lower()
        if kind not in ("forward", "reverse"):
            _err(f"{pfx}.kind", f"Must be 'forward' or 'reverse', got {kind!r}")
        records = zone.get("records") or []
        if records and not isinstance(records, list):
            _err(f"{pfx}.records", "Must be a list"); records = []
        for j, rec in enumerate(records):
            rpfx = f"{pfx}.records[{j}]"
            if not isinstance(rec, dict):
                _err(rpfx, "Each record must be a mapping"); continue
            try:
                build_record_body("validate", rec)
            except (ValueError, TypeError) as exc:
                _err(rpfx, str(exc))


def validate_template(template: dict, template_name: str = "") -> dict:
    """Validate a parsed template against its type's schema. Purely
    structural — never contacts the API. Port of core.validate_template."""
    errors, warnings = [], []
    ttype = template_type(template)
    if ttype == "address-block":
        _validate_block(template, errors, warnings)
    elif ttype == "dns":
        _validate_dns(template, errors, warnings)
    else:
        _validate_site(template, errors, warnings)
    return {"valid": len(errors) == 0, "template": template_name, "type": ttype,
            "errors": errors, "warnings": warnings}


# ---------------------------------------------------------------------------
# Address-block provisioning — port of block/provision.py
# ---------------------------------------------------------------------------

@dataclass
class BlockConfig:
    name: str
    ip_space: str
    dry_run: bool = False
    extra_tags: dict = field(default_factory=dict)
    blocks: list = field(default_factory=list)


def _parse_blocks(raw_blocks: list) -> list:
    """Recursively normalize raw YAML block mappings, filling defaults. Port
    of block.provision._parse_blocks (dict-based instead of a dataclass since
    nothing here needs argparse-style attribute defaults)."""
    parsed = []
    for raw in raw_blocks or []:
        if not isinstance(raw, dict):
            continue
        parsed.append({
            "address": str(raw.get("address", "")).strip(),
            "cidr": raw.get("cidr"),
            "region": str(raw.get("region", "")),
            "environment": str(raw.get("environment", "")),
            "status": str(raw.get("status", "available")),
            "location": str(raw.get("location", "")),
            "comment": str(raw.get("comment", "")),
            "tags": {k: str(v) for k, v in (raw.get("tags") or {}).items()},
            "children": _parse_blocks(raw.get("children") or []),
        })
    return parsed


def _truthy(raw, default=False) -> bool:
    """Parse a bool that may arrive as a real JSON bool (POST body) or a
    string (query string): absent → default; '0'/'false'/'no'/'' → False;
    anything else (including a real Python bool) → that bool / True.
    Needed because bool("false") is True in Python — a raw bool() call on a
    query-string value would silently invert every '0'/'false' the caller sends."""
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() not in ("0", "false", "no", "")


def _truthy_dry(raw) -> bool:
    """dry param parsing shared by every provisioning route: absent → dry-run
    (safe default); '0'/'false'/'no' → live; anything else → dry-run."""
    return _truthy(raw, default=True)


def _resolve_bool(param_val, yaml_val) -> bool:
    """Resolve a boolean field: params (CLI-flag stand-in) > YAML template
    value. param_val may be a query-string '0'/'1' or a JSON bool/absent."""
    if param_val not in (None, ""):
        return _truthy(param_val)
    return bool(yaml_val)


def template_to_block_config(template: dict, params: dict) -> BlockConfig:
    """Merge an address-block template + request params into a BlockConfig.
    Precedence: params (stands in for CLI flags) > template > hardcoded
    fallback. Drops the CLI/env/INI tiers of block.provision.
    template_to_block_config; raises ProvisionError instead of sys.exit."""
    name = params.get("name") or template.get("name") or ""
    ip_space = params.get("ip_space") or template.get("ip_space") or DEFAULT_IP_SPACE
    blocks = _parse_blocks(template.get("address_blocks") or [])
    if not blocks:
        raise ProvisionError("address_blocks (non-empty list) is required")
    extra_tags = {k: str(v) for k, v in (template.get("tags") or {}).items()}
    return BlockConfig(name=name, ip_space=ip_space,
                        dry_run=_truthy_dry(params.get("dry")),
                        extra_tags=extra_tags, blocks=blocks)


class BlockProvisioner:
    """Creates address blocks (and nested children) from a BlockConfig using
    direct REST calls. Idempotent via _exists() (skips blocks that already
    exist) — this app has no decommission path yet, so idempotency is the
    Phase-1 substitute for teardown. Port of block.provision.BlockProvisioner."""

    def __init__(self, cfg: BlockConfig, emit) -> None:
        self.cfg = cfg
        self.emit = emit
        self._space_id = ""

    def _block_tags(self, bdef: dict) -> dict:
        tags = {**self.cfg.extra_tags}
        if self.cfg.name:
            tags["Template"] = self.cfg.name
        if bdef.get("region"):
            tags["Region"] = bdef["region"]
        if bdef.get("environment"):
            tags["Environment"] = bdef["environment"]
        if bdef.get("status"):
            tags["Status"] = bdef["status"]
        if bdef.get("location"):
            tags["Location"] = bdef["location"]
        tags.update(bdef.get("tags") or {})
        return tags

    def _exists(self, bdef: dict) -> bool:
        results = _rest_get("/api/ddi/v1/ipam/address_block", {
            "_filter": f'space=="{self._space_id}" and address=="{bdef["address"]}" and cidr=={int(bdef["cidr"])}'})
        return bool(results)

    def _create_block(self, bdef: dict, parent_net, result: dict) -> None:
        try:
            net = ipaddress.ip_network(f'{bdef.get("address")}/{int(bdef["cidr"])}', strict=False)
        except (TypeError, ValueError) as exc:
            raise ProvisionError(f'Invalid block {bdef.get("address")}/{bdef.get("cidr")}: {exc}')
        if parent_net is not None and not (net.subnet_of(parent_net) and net != parent_net):
            raise ProvisionError(f"Child {net} is not contained within parent {parent_net}")

        tags = self._block_tags(bdef)
        mode = "[DRY-RUN] " if self.cfg.dry_run else ""
        self.emit({"step": f"{mode}Creating address block {net}  status={bdef.get('status', '')}"})

        if self.cfg.dry_run:
            result["blocks_created"].append({"address": str(net.network_address), "cidr": int(bdef["cidr"]),
                                              "id": "(dry-run)", "status": bdef.get("status", "")})
        elif self._exists(bdef):
            self.emit({"step": f"  Already exists — skipping: {net}"})
        else:
            body = {"address": str(net.network_address), "cidr": int(bdef["cidr"]), "space": self._space_id,
                     "comment": bdef.get("comment", ""), "tags": tags}
            resp, status = _rest_write("POST", "/api/ddi/v1/ipam/address_block", body)
            if status not in (200, 201) or resp is None:
                raise ProvisionError(f"Failed to create block {net}: status {status} {resp}")
            block = resp.get("result", {}) if isinstance(resp, dict) else {}
            self.emit({"step": f"  Created block id={block.get('id')}"})
            result["blocks_created"].append({"address": str(net.network_address), "cidr": int(bdef["cidr"]),
                                              "id": block.get("id", ""), "status": bdef.get("status", "")})

        for child in bdef.get("children") or []:
            self._create_block(child, net, result)

    def _rollback(self, result: dict) -> None:
        self.emit({"step": "Rolling back created address blocks…"})
        for block in reversed(result["blocks_created"]):
            block_id = block.get("id", "")
            if not block_id or block_id == "(dry-run)":
                continue
            _, status = _rest_write("DELETE", f"/api/ddi/v1/{block_id}")
            if not (status and 200 <= status < 300):
                self.emit({"step": f"  Rollback: failed to delete block id={block_id}"})

    def provision(self) -> dict:
        result = {"name": self.cfg.name, "ip_space": self.cfg.ip_space,
                  "blocks_created": [], "dry_run": self.cfg.dry_run}
        space_results = _rest_get("/api/ddi/v1/ipam/ip_space", {"_filter": f'name=="{self.cfg.ip_space}"'})
        if not space_results:
            raise ProvisionError(f"IP space not found: {self.cfg.ip_space}")
        self._space_id = space_results[0]["id"]
        try:
            for bdef in self.cfg.blocks:
                self._create_block(bdef, None, result)
        except Exception as exc:
            if not self.cfg.dry_run:
                self.emit({"step": f"Block provisioning failed ({exc}) — initiating rollback"})
                self._rollback(result)
            raise
        return result


# ---------------------------------------------------------------------------
# Site provisioning — port of site/provision.py
# ---------------------------------------------------------------------------

@dataclass
class SubnetDef:
    name: str
    purpose: str
    dhcp: str = "false"
    cidr: "int | None" = None
    dhcp_start: "int | None" = None
    dhcp_end: "int | None" = None


@dataclass
class HostDef:
    hostname: str
    subnet: str
    comment: str = ""


@dataclass
class SiteConfig:
    site: str
    region: str
    environment: str
    location: str
    ip_space: str
    dns_parent: str
    dns_view: str
    owner: str
    subnet_size: int
    dry_run: bool
    create_zone: bool = False
    create_reverse_zone: bool = False
    if_not_exists: bool = False
    extra_tags: dict = field(default_factory=dict)
    subnet_plan: list = field(default_factory=list)
    hosts: list = field(default_factory=list)

    @property
    def dns_zone(self) -> str:
        return f"site-{self.site}.{self.dns_parent}"


def template_to_site_config(template: dict, params: dict) -> SiteConfig:
    """Merge a site template + request params into a SiteConfig. Precedence:
    params (stands in for CLI flags) > YAML template > hardcoded fallback.
    Drops the CLI/env/INI tiers of site.provision.template_to_site_config;
    raises ProvisionError instead of sys.exit."""
    site_sec = template.get("site") or {}
    net_sec = template.get("network") or {}
    dns_sec = template.get("dns") or {}
    tags_sec = template.get("tags") or {}
    hosts_sec = template.get("hosts") or []
    subnets_sec = net_sec.get("subnets") or []

    def resolve(param_val, yaml_val, fallback=""):
        if param_val not in (None, ""):
            return param_val
        if yaml_val not in (None, ""):
            return yaml_val
        return fallback

    site = resolve(params.get("site"), site_sec.get("name"))
    region = resolve(params.get("region"), site_sec.get("region"))
    environment = resolve(params.get("environment"), site_sec.get("environment"))
    ip_space = resolve(params.get("ip_space"), net_sec.get("ip_space"), DEFAULT_IP_SPACE)
    dns_parent = resolve(params.get("dns_parent"), dns_sec.get("parent"), DEFAULT_DNS_PARENT)

    missing = [label for label, value in
               [("site", site), ("region", region), ("environment", environment),
                ("ip_space", ip_space), ("dns_parent", dns_parent)] if not value]
    if missing:
        raise ProvisionError(f"Required values missing: {', '.join(missing)}")
    site = str(site).lower()

    location = resolve(params.get("location"), site_sec.get("location"), str(site).capitalize())
    dns_view = resolve(params.get("dns_view"), dns_sec.get("view"), "default")
    owner = resolve(None, tags_sec.get("Owner") or site_sec.get("owner"), "network-team")
    subnet_size_raw = resolve(params.get("subnet_size"), net_sec.get("subnet_size"), 24)
    try:
        subnet_size = int(subnet_size_raw)
    except (TypeError, ValueError):
        raise ProvisionError(f"subnet_size must be an integer, got {subnet_size_raw!r}")

    subnet_plan = [
        SubnetDef(name=s.get("name", f'{site}-{s.get("purpose", "net")}'),
                  purpose=s.get("purpose", "general"),
                  dhcp=str(s.get("dhcp", False)).lower(),
                  cidr=s.get("cidr"), dhcp_start=s.get("dhcp_start"), dhcp_end=s.get("dhcp_end"))
        for s in subnets_sec if isinstance(s, dict)
    ]
    if not subnet_plan:
        subnet_plan = [
            SubnetDef(name=f"{site}-mgmt", purpose="mgmt", dhcp="false"),
            SubnetDef(name=f"{site}-lan", purpose="user-lan", dhcp="true"),
            SubnetDef(name=f"{site}-server", purpose="server", dhcp="false"),
        ]

    host_list = []
    for h in hosts_sec:
        if not isinstance(h, dict) or "hostname" not in h:
            continue
        default_subnet = subnet_plan[0].name if subnet_plan else f"{site}-mgmt"
        host_list.append(HostDef(hostname=h["hostname"], subnet=h.get("subnet", default_subnet),
                                  comment=h.get("comment", "")))
    if not host_list:
        host_list = [HostDef(hostname="gw01", subnet=subnet_plan[0].name,
                              comment=f"{site.capitalize()} site gateway")]

    extra_tags = {k: str(v) for k, v in tags_sec.items()}
    create_zone = _resolve_bool(params.get("create_zone"), dns_sec.get("create_zone", False))
    create_reverse_zone = _resolve_bool(params.get("create_reverse_zone"), dns_sec.get("create_reverse_zone", False))
    if_not_exists = _resolve_bool(params.get("if_not_exists"), False)

    return SiteConfig(site=site, region=region, environment=environment, location=location,
                       ip_space=ip_space, dns_parent=dns_parent, dns_view=dns_view, owner=owner,
                       subnet_size=subnet_size, dry_run=_truthy_dry(params.get("dry")),
                       create_zone=create_zone, create_reverse_zone=create_reverse_zone,
                       if_not_exists=if_not_exists, extra_tags=extra_tags,
                       subnet_plan=subnet_plan, hosts=host_list)


def _block_sort_key(block: dict) -> tuple:
    """Deterministic candidate-block ordering: lowest address, then cidr, so
    repeated runs pick the same pool block. Port of site.provision._block_sort_key."""
    try:
        addr_int = int(ipaddress.ip_address(block.get("address", "")))
    except ValueError:
        addr_int = 1 << 128
    try:
        cidr = int(block.get("cidr", 0))
    except (TypeError, ValueError):
        cidr = 0
    return (addr_int, cidr)


class SiteProvisioner:
    """Discovers a pool address block by Region/Environment/Status tags,
    carves subnets, creates DHCP ranges + forward/reverse DNS zones, and
    provisions IPAM hosts with DNS A/PTR records. Idempotent via
    find_existing_site() + if_not_exists — this app has no decommission path
    yet, so idempotency is the Phase-1 substitute for teardown. Port of
    site.provision.SiteProvisioner.

    GOTCHA: nextavailablesubnet is a create-and-allocate POST in this API (it
    both proposes AND reserves the subnet in one call, unlike the reference
    toolkit's read-only GET-then-separate-POST /ipam/subnet two-step) — see
    _create_subnet(). The dry-run preview path uses GET instead, since it
    must not create anything.
    """

    def __init__(self, cfg: SiteConfig, emit) -> None:
        self.cfg = cfg
        self.emit = emit
        self._space_id = ""
        self._view_id = ""
        self._zone_id = ""
        self._zone_created = False

    def resolve_ip_space(self) -> str:
        results = _rest_get("/api/ddi/v1/ipam/ip_space", {"_filter": f'name=="{self.cfg.ip_space}"'})
        if not results:
            raise ProvisionError(f"IP space not found: {self.cfg.ip_space}")
        self._space_id = results[0]["id"]
        return self._space_id

    def find_existing_site(self) -> list:
        return _rest_get("/api/ddi/v1/ipam/subnet", {
            "_filter": f'space=="{self._space_id}"', "_tfilter": f'Site=="{self.cfg.site}"'})

    def find_available_block(self) -> dict:
        results = _rest_get("/api/ddi/v1/ipam/address_block", {
            "_filter": f'space=="{self._space_id}"',
            "_tfilter": f'Region=="{self.cfg.region}" and Environment=="{self.cfg.environment}" and Status=="available"'})
        if not results:
            raise ProvisionError(
                f"No available address block found for Region={self.cfg.region} Environment={self.cfg.environment}")
        return min(results, key=_block_sort_key)

    def resolve_dns_view(self) -> str:
        results = _rest_get("/api/ddi/v1/dns/view", {"_filter": f'name=="{self.cfg.dns_view}"'})
        if not results:
            raise ProvisionError(f"DNS view not found: {self.cfg.dns_view}")
        self._view_id = results[0]["id"]
        return self._view_id

    def _create_subnet(self, block_id: str, sdef: SubnetDef, result: dict) -> dict:
        """Carve one subnet from block_id. block_id must be the FULL-form id
        (e.g. 'ipam/address_block/<uuid>') straight from the block object —
        do not re-prefix 'ipam/address_block/' onto it."""
        cidr = sdef.cidr if sdef.cidr is not None else self.cfg.subnet_size
        tags = {"Site": self.cfg.site, "Region": self.cfg.region, "Environment": self.cfg.environment,
                "Owner": self.cfg.owner, "Purpose": sdef.purpose, "DHCP": sdef.dhcp, "Name": sdef.name,
                **{k: v for k, v in self.cfg.extra_tags.items() if k != "Owner"}}
        mode = "[DRY-RUN] " if self.cfg.dry_run else ""
        self.emit({"step": f"{mode}Creating subnet /{cidr}  name={sdef.name}  purpose={sdef.purpose}"})

        if self.cfg.dry_run:
            # Preview only — GET nextavailablesubnet does not create anything.
            preview = _rest_get(f"/api/ddi/v1/{block_id}/nextavailablesubnet", {"cidr": int(cidr), "count": 1})
            subnet_addr = preview[0].get("address", "") if preview else ""
            result["subnets"].append({"address": f"{subnet_addr}/{cidr}", "name": sdef.name, "id": "(dry-run)"})
            return {"dry_run": True, "address": subnet_addr, "cidr": cidr, "name": sdef.name, "tags": tags}

        body = {"name": sdef.name, "space": self._space_id,
                "comment": f"{self.cfg.site.capitalize()} site - {sdef.purpose} network", "tags": tags}
        resp, status = _rest_write("POST", f"/api/ddi/v1/{block_id}/nextavailablesubnet",
                                    body=body, params={"cidr": int(cidr)})
        if status not in (200, 201) or resp is None:
            raise ProvisionError(f"Failed to create subnet {sdef.name}: status {status} {resp}")
        rows = (resp.get("results") or ([resp["result"]] if resp.get("result") else [])) if isinstance(resp, dict) else []
        subnet = rows[0] if rows else {}
        if not subnet.get("address"):
            raise ProvisionError(f"No free /{cidr} subnet available in block for {sdef.name}")
        self.emit({"step": f"  Created subnet id={subnet.get('id')}"})
        result["subnets"].append({"address": f'{subnet.get("address")}/{subnet.get("cidr", cidr)}',
                                   "name": sdef.name, "id": subnet.get("id", "")})
        return subnet

    def create_dhcp_range(self, subnet: dict, sdef: SubnetDef, result: dict) -> None:
        start_off = sdef.dhcp_start if sdef.dhcp_start is not None else 10
        end_off = sdef.dhcp_end if sdef.dhcp_end is not None else 250
        try:
            net = ipaddress.ip_network(f'{subnet.get("address", "")}/{subnet.get("cidr", self.cfg.subnet_size)}',
                                        strict=False)
        except ValueError as exc:
            self.emit({"step": f"  Cannot compute DHCP range for {sdef.name}: {exc}"})
            return
        start_ip, end_ip = str(net.network_address + start_off), str(net.network_address + end_off)
        mode = "[DRY-RUN] " if self.cfg.dry_run else ""
        self.emit({"step": f"{mode}Creating DHCP range {start_ip}-{end_ip}  subnet={sdef.name}"})
        if self.cfg.dry_run:
            result["dhcp_ranges"].append({"id": "(dry-run)", "start": start_ip, "end": end_ip, "name": f"{sdef.name}-dhcp"})
            return
        body = {"start": start_ip, "end": end_ip, "space": self._space_id,
                "comment": f"DHCP range for {sdef.name}",
                "tags": {"Site": self.cfg.site, "Purpose": sdef.purpose, "Name": f"{sdef.name}-dhcp", **self.cfg.extra_tags}}
        resp, status = _rest_write("POST", "/api/ddi/v1/ipam/range", body)
        if status not in (200, 201) or resp is None:
            raise ProvisionError(f"Failed to create DHCP range for {sdef.name}: status {status} {resp}")
        rng = resp.get("result", {}) if isinstance(resp, dict) else {}
        result["dhcp_ranges"].append({"id": rng.get("id", ""), "start": start_ip, "end": end_ip, "name": f"{sdef.name}-dhcp"})

    def create_dns_zone(self) -> dict:
        fqdn = self.cfg.dns_zone
        mode = "[DRY-RUN] " if self.cfg.dry_run else ""
        self.emit({"step": f"{mode}Ensuring DNS zone exists: {fqdn}  view={self.cfg.dns_view}"})
        if self.cfg.dry_run:
            return {"dry_run": True, "fqdn": fqdn, "id": "(dry-run)"}
        existing = _rest_get("/api/ddi/v1/dns/auth_zone", {"_filter": f'fqdn=="{fqdn}." and view=="{self._view_id}"'})
        if existing:
            zone = existing[0]
            self._zone_id = zone["id"]
            self.emit({"step": f"  Zone already exists: {fqdn}  id={self._zone_id} — skipping creation"})
            return zone
        if not self.cfg.create_zone:
            raise ProvisionError(
                f'DNS zone "{fqdn}" does not exist in view "{self.cfg.dns_view}"; set dns.create_zone: true to create it')
        resp, status = _rest_write("POST", "/api/ddi/v1/dns/auth_zone",
                                    {"fqdn": fqdn, "view": self._view_id, "primary_type": "cloud"})
        if status not in (200, 201) or resp is None:
            raise ProvisionError(f"Failed to create DNS zone {fqdn}: status {status} {resp}")
        zone = resp.get("result", {}) if isinstance(resp, dict) else {}
        self._zone_id = zone.get("id", "")
        self._zone_created = True
        self.emit({"step": f"  Created zone id={self._zone_id}"})
        return zone

    def create_reverse_zone(self, subnet_addr: str, cidr: int) -> dict:
        # _cidr_to_reverse_zone (defined above, already shipped for the
        # ad-hoc self-service subnet wizard) returns the fqdn WITH a trailing
        # dot — reused as-is rather than re-porting core.reverse_zone_fqdn.
        fqdn = _cidr_to_reverse_zone(subnet_addr, cidr)
        if cidr not in (8, 16, 24) and cidr < 24:
            self.emit({"step": f"  Warning: /{cidr} spans multiple reverse zones; only {fqdn} will be created"})
        mode = "[DRY-RUN] " if self.cfg.dry_run else ""
        self.emit({"step": f"{mode}Ensuring reverse DNS zone: {fqdn}  view={self.cfg.dns_view}"})
        if self.cfg.dry_run:
            return {"dry_run": True, "fqdn": fqdn, "id": "(dry-run)"}
        existing = _rest_get("/api/ddi/v1/dns/auth_zone", {"_filter": f'fqdn=="{fqdn}" and view=="{self._view_id}"'})
        if existing:
            zone = existing[0]
            self.emit({"step": f"  Reverse zone already exists: {fqdn}  id={zone.get('id')}"})
            return zone
        resp, status = _rest_write("POST", "/api/ddi/v1/dns/auth_zone",
                                    {"fqdn": fqdn, "view": self._view_id, "primary_type": "cloud"})
        if status not in (200, 201) or resp is None:
            raise ProvisionError(f"Failed to create reverse zone {fqdn}: status {status} {resp}")
        zone = resp.get("result", {}) if isinstance(resp, dict) else {}
        self.emit({"step": f"  Created reverse zone id={zone.get('id')}"})
        return zone

    def create_subnets(self, block: dict, result: dict) -> dict:
        created = {}
        block_id = block["id"]
        for sdef in self.cfg.subnet_plan:
            subnet = self._create_subnet(block_id, sdef, result)
            if sdef.dhcp == "true":
                self.create_dhcp_range(subnet, sdef, result)
            if self.cfg.create_reverse_zone and subnet.get("address"):
                zone = self.create_reverse_zone(subnet["address"], int(subnet.get("cidr", self.cfg.subnet_size)))
                result["reverse_zones"].append({"id": zone.get("id", "(dry-run)"), "fqdn": zone.get("fqdn", "")})
            created[sdef.name] = subnet
        return created

    def provision_hosts(self, subnets: dict) -> list:
        subnet_offsets: dict = {}
        results = []
        for hdef in self.cfg.hosts:
            subnet = subnets.get(hdef.subnet)
            if subnet is None:
                self.emit({"step": f'Host {hdef.hostname} references unknown subnet "{hdef.subnet}" — skipping'})
                continue
            base_addr = subnet.get("address", "")
            cidr = subnet.get("cidr", self.cfg.subnet_size)
            offset = subnet_offsets.get(hdef.subnet, 1)
            subnet_offsets[hdef.subnet] = offset + 1
            try:
                net = ipaddress.ip_network(f"{base_addr}/{cidr}", strict=False)
                host_addr = net.network_address + offset
            except ValueError as exc:
                self.emit({"step": f"Cannot compute IP for host {hdef.hostname}: {exc} — skipping"})
                continue
            if host_addr not in net:
                self.emit({"step": f"Host {hdef.hostname} offset {offset} falls outside subnet {net} — skipping"})
                continue
            host_ip = str(host_addr)
            fqdn = f"{hdef.hostname}.{self.cfg.dns_zone}"
            mode = "[DRY-RUN] " if self.cfg.dry_run else ""
            self.emit({"step": f"{mode}Provisioning host: {fqdn} -> {host_ip}  (subnet={hdef.subnet})"})
            if self.cfg.dry_run:
                results.append({"dry_run": True, "fqdn": fqdn, "ip": host_ip, "hostname": hdef.hostname, "id": "(dry-run)"})
                continue
            body = {
                "name": fqdn, "comment": hdef.comment or f"{self.cfg.site.capitalize()} - {hdef.hostname}",
                "addresses": [{"address": host_ip, "space": self._space_id}],
                "auto_generate_records": True,
                "host_names": [{"name": hdef.hostname, "zone": self._zone_id, "primary_name": True}],
            }
            resp, status = _rest_write("POST", "/api/ddi/v1/ipam/host", body)
            if status not in (200, 201) or resp is None:
                raise ProvisionError(f"Failed to create host {hdef.hostname}: status {status} {resp}")
            host = resp.get("result", {}) if isinstance(resp, dict) else {}
            self.emit({"step": f"  Created host id={host.get('id')}"})
            results.append({"fqdn": fqdn, "ip": host_ip, "hostname": hdef.hostname, "id": host.get("id", "(dry-run)")})
        return results

    def _rollback(self, partial: dict) -> None:
        self.emit({"step": "Rolling back partial site provisioning…"})
        for h in reversed(partial["hosts"]):
            hid = h.get("id", "")
            if hid and hid != "(dry-run)":
                _rest_write("DELETE", f"/api/ddi/v1/{hid}")
        if self._zone_created and partial["dns_zone_id"] not in ("", "(dry-run)"):
            _rest_write("DELETE", f'/api/ddi/v1/{partial["dns_zone_id"]}')
        for rz in reversed(partial["reverse_zones"]):
            rid = rz.get("id", "")
            if rid and rid != "(dry-run)":
                _rest_write("DELETE", f"/api/ddi/v1/{rid}")
        for r in reversed(partial["dhcp_ranges"]):
            rid = r.get("id", "")
            if rid and rid != "(dry-run)":
                _rest_write("DELETE", f"/api/ddi/v1/{rid}")
        for s in reversed(partial["subnets"]):
            sid = s.get("id", "")
            if sid and sid != "(dry-run)":
                _rest_write("DELETE", f"/api/ddi/v1/{sid}")
        # The pool block is shared and untagged by this flow, so nothing to reset there.

    def provision(self) -> dict:
        result = {"block_id": "", "block_address": "", "subnets": [], "dhcp_ranges": [],
                  "dns_zone_id": "", "dns_zone_fqdn": "", "reverse_zones": [], "hosts": [],
                  "dry_run": self.cfg.dry_run, "skipped": False, "skip_reason": ""}
        try:
            self.resolve_ip_space()
            existing = self.find_existing_site()
            if existing:
                first = existing[0]
                msg = (f"Site {self.cfg.site!r} is already provisioned "
                       f'({len(existing)} subnet(s), e.g. {first.get("address")}/{first.get("cidr")})')
                if self.cfg.if_not_exists:
                    self.emit({"step": f"{msg} — skipping (if_not_exists)"})
                    result["skipped"] = True
                    result["skip_reason"] = "already provisioned"
                else:
                    raise ProvisionError(f"{msg} — pass if_not_exists to skip")
            else:
                block = self.find_available_block()
                result["block_id"] = block.get("id", "")
                result["block_address"] = f'{block["address"]}/{block["cidr"]}'
                self.resolve_dns_view()
                subnets = self.create_subnets(block, result)
                zone = self.create_dns_zone()
                result["dns_zone_id"] = zone.get("id", "(dry-run)")
                result["dns_zone_fqdn"] = zone.get("fqdn", self.cfg.dns_zone)
                hosts = self.provision_hosts(subnets)
                result["hosts"] = [{"fqdn": h.get("fqdn", ""), "ip": h.get("ip", ""),
                                     "hostname": h.get("hostname", ""), "id": h.get("id", "(dry-run)")} for h in hosts]
        except Exception as exc:
            if not self.cfg.dry_run:
                self.emit({"step": f"Provisioning failed ({exc}) — initiating rollback"})
                self._rollback(result)
            raise
        return result


def list_templates() -> list:
    """Recursively scan TEMPLATES_DIR for YAML templates and summarize each
    for the template picker. Skips shared/placeholder scaffolding files."""
    out = []
    base = os.path.realpath(TEMPLATES_DIR)
    for path in sorted(glob.glob(os.path.join(base, "**", "*.y*ml"), recursive=True)):
        rel = os.path.relpath(path, base)
        base_name = os.path.basename(path)
        if base_name.startswith("_shared") or "SITENAME" in base_name.upper():
            continue
        try:
            with open(path, "r") as fh:
                data = yaml.safe_load(fh)
        except (OSError, yaml.YAMLError):
            continue
        if not isinstance(data, dict):
            continue
        site_sec = data.get("site") or {}
        validation = validate_template(data, rel)
        out.append({
            "name": rel, "type": validation["type"],
            "site": site_sec.get("name", data.get("name", "")),
            "region": site_sec.get("region", ""),
            "environment": site_sec.get("environment", ""),
            "valid": validation["valid"],
        })
    return out


# ---------------------------------------------------------------------------
# Phase-2: lifecycle (teardown/retag) + monitoring (drift) — port of Chris
# Marrison's UDDI Automation Toolkit site/decommission.py, block/decommission.py,
# retag.py, core.py::detect_drift, and site/query.py. Mirrors the Phase-1
# provisioning idioms above: direct REST via _rest_get/_rest_write, ProvisionError
# instead of sys.exit, dataclass configs, emit()-based SSE progress.
#
# CRITICAL: every lookup here is tag-scoped using the leading-underscore
# _tfilter query param — never the bare (no-underscore) param name the
# reference toolkit's client.py sends, since this app talks direct REST
# rather than through that client. Every `tags.X==` clause from the
# reference source is split out into its own _tfilter, leaving only
# structural clauses (space==, address==, cidr==) in _filter.
# ---------------------------------------------------------------------------

@dataclass
class DecommissionConfig:
    """Site-teardown config. Mirrors SiteConfig's field set (dns_zone
    derivation must match provisioning exactly so decommission finds what
    provisioning created)."""
    site: str
    ip_space: str
    dns_parent: str
    dns_view: str
    keep_zone: bool = False
    dry_run: bool = False

    @property
    def dns_zone(self) -> str:
        return f"site-{self.site}.{self.dns_parent}"


def template_to_decommission_config(template: dict, params: dict) -> DecommissionConfig:
    """Merge a site template + request params into a DecommissionConfig.
    Precedence: params > template > hardcoded fallback — same tier order as
    template_to_site_config. Port of site/decommission.py's config resolution
    (which in the reference CLI is CLI-flags > template > INI)."""
    site_sec = template.get("site") or {}
    net_sec = template.get("network") or {}
    dns_sec = template.get("dns") or {}

    def resolve(param_val, yaml_val, fallback=""):
        if param_val not in (None, ""):
            return param_val
        if yaml_val not in (None, ""):
            return yaml_val
        return fallback

    site = resolve(params.get("site"), site_sec.get("name"))
    if not site:
        raise ProvisionError("site is required")
    site = str(site).lower()
    ip_space = resolve(params.get("ip_space"), net_sec.get("ip_space"), DEFAULT_IP_SPACE)
    dns_parent = resolve(params.get("dns_parent"), dns_sec.get("parent"), DEFAULT_DNS_PARENT)
    dns_view = resolve(params.get("dns_view"), dns_sec.get("view"), "default")
    keep_zone = _truthy(params.get("keep_zone"), False)

    return DecommissionConfig(site=site, ip_space=ip_space, dns_parent=dns_parent, dns_view=dns_view,
                               keep_zone=keep_zone, dry_run=_truthy_dry(params.get("dry")))


# ---------------------------------------------------------------------------
# Block re-tag — port of retag.py
# ---------------------------------------------------------------------------

def _find_blocks_for_retag(space_id: str, template: str, address: str, cidr, site: str) -> list:
    """Resolve candidate blocks by Template tag, Site tag, or address+cidr (in
    that precedence — mirrors retag.py's find_blocks, extended with the
    Template-tag lookup this app's teardown/provisioning flows tag with)."""
    params = {"_filter": f'space=="{space_id}"'}
    if template:
        params["_tfilter"] = f'Template=="{template}"'
    elif site:
        params["_tfilter"] = f'Site=="{site}"'
    elif address and cidr not in (None, ""):
        params["_filter"] += f' and address=="{address}" and cidr=={int(cidr)}'
    else:
        raise ProvisionError("template, site, or address+cidr is required")
    return _rest_get("/api/ddi/v1/ipam/address_block", params)


def _retag_block(block: dict, status: str, dry_run: bool) -> dict:
    """Set a block's Status tag (and clear site-scoping fields when returning
    it to the pool). Port of retag.py::retag."""
    tags = dict(block.get("tags") or {})
    tags["Status"] = status
    if status == "available":
        tags["Site"] = "unassigned"
        tags["Location"] = ""
        tags["Provisioned"] = ""
        tags["Decommissioned"] = ""
    addr = f'{block.get("address", "")}/{block.get("cidr", "")}'
    if not dry_run:
        _, http_status = _rest_write("PATCH", f'/api/ddi/v1/{block["id"]}', body={"tags": tags})
        if not (http_status and 200 <= http_status < 300):
            raise ProvisionError(f"Failed to retag block {addr}: status {http_status}")
    return {"address": addr, "id": block.get("id", ""), "status": status}


# ---------------------------------------------------------------------------
# Address-block decommission — port of block/decommission.py
# ---------------------------------------------------------------------------

class BlockDecommissioner:
    """Deletes address blocks tagged Template==<name>, deepest-child-first
    (highest cidr first) so children are removed before their parents. Port
    of block/decommission.py::BlockDecommissioner, tag-scoped only (the
    reference toolkit's address/cidr fallback is dropped — this app's
    teardown route always supplies a template name)."""

    def __init__(self, name: str, ip_space: str, dry_run: bool, emit) -> None:
        self.name = name
        self.ip_space = ip_space
        self.dry_run = dry_run
        self.emit = emit
        self._space_id = ""

    def find_blocks(self) -> list:
        return _rest_get("/api/ddi/v1/ipam/address_block", {
            "_filter": f'space=="{self._space_id}"', "_tfilter": f'Template=="{self.name}"'})

    def delete_blocks(self, blocks: list) -> list:
        ordered = sorted(blocks, key=lambda b: int(b.get("cidr", 0)), reverse=True)
        deleted = []
        mode = "[DRY-RUN] " if self.dry_run else ""
        for block in ordered:
            block_id = block.get("id", "")
            addr = f'{block.get("address", "")}/{block.get("cidr", "")}'
            status = (block.get("tags") or {}).get("Status", "")
            self.emit({"step": f"{mode}Deleting block: {addr}  status={status}  id={block_id}"})
            if not self.dry_run:
                _, http_status = _rest_write("DELETE", f"/api/ddi/v1/{block_id}")
                if not (http_status and 200 <= http_status < 300):
                    raise ProvisionError(f"Failed to delete block {addr}: status {http_status}")
            deleted.append({"address": addr, "id": block_id, "status": status})
        return deleted

    def decommission(self) -> dict:
        space_results = _rest_get("/api/ddi/v1/ipam/ip_space", {"_filter": f'name=="{self.ip_space}"'})
        if not space_results:
            raise ProvisionError(f"IP space not found: {self.ip_space}")
        self._space_id = space_results[0]["id"]
        blocks = self.find_blocks()
        deleted = self.delete_blocks(blocks)
        return {"name": self.name, "ip_space": self.ip_space, "blocks_deleted": deleted, "dry_run": self.dry_run}


# ---------------------------------------------------------------------------
# Site decommission — port of site/decommission.py
# ---------------------------------------------------------------------------

class SiteDecommissioner:
    """Tag-driven site teardown — the exact reverse of SiteProvisioner. Port
    of site/decommission.py::SiteDecommissioner, adapted to direct REST calls
    + SSE emit.

    FAIL-FORWARD, NOT reversible: unlike provisioning's transactional
    rollback-on-failure, every step here IS a delete — there is nothing safe
    to "undo" a delete into. On any API error mid-sequence a ProvisionError
    propagates out of decommission(); the caller (the SSE route) emits it and
    stops. Whatever was deleted before the failure stays deleted, and the
    emitted step log is the record of exactly how far teardown got.

    Ordering is LOAD-BEARING, do not reorder:
      1. resolve ip_space + dns_view
      2. find subnets (space== + tags.Site==, i.e. _filter + _tfilter)
      3. delete forward DNS zone (unless keep_zone)
      4. delete DHCP ranges (tags.Site==, i.e. _tfilter)
      5. delete reverse zones (computed FQDN per subnet)
      6. delete subnets — releases DHCP-bound host addresses
      7. delete hosts LAST, matched by dns_zone FQDN suffix — a DHCP-bound
         host address reports "in use" and refuses deletion until step 6
         releases it, so hosts must come after subnets, not before.

    The pool address block is shared and never tagged for the site, so it is
    neither discovered nor touched here.
    """

    def __init__(self, cfg: DecommissionConfig, emit) -> None:
        self.cfg = cfg
        self.emit = emit
        self._space_id = ""
        self._view_id = ""

    def resolve_ip_space(self) -> str:
        results = _rest_get("/api/ddi/v1/ipam/ip_space", {"_filter": f'name=="{self.cfg.ip_space}"'})
        if not results:
            raise ProvisionError(f"IP space not found: {self.cfg.ip_space}")
        self._space_id = results[0]["id"]
        return self._space_id

    def resolve_dns_view(self) -> str:
        results = _rest_get("/api/ddi/v1/dns/view", {"_filter": f'name=="{self.cfg.dns_view}"'})
        if not results:
            raise ProvisionError(f"DNS view not found: {self.cfg.dns_view}")
        self._view_id = results[0]["id"]
        return self._view_id

    def find_subnets(self) -> list:
        return _rest_get("/api/ddi/v1/ipam/subnet", {
            "_filter": f'space=="{self._space_id}"', "_tfilter": f'Site=="{self.cfg.site}"'})

    def delete_dns_zone(self) -> bool:
        fqdn = self.cfg.dns_zone
        if self.cfg.keep_zone:
            self.emit({"step": f"keep_zone set — skipping forward zone: {fqdn}"})
            return False
        mode = "[DRY-RUN] " if self.cfg.dry_run else ""
        self.emit({"step": f"{mode}Looking up forward DNS zone: {fqdn}  view={self.cfg.dns_view}"})
        existing = _rest_get("/api/ddi/v1/dns/auth_zone",
                              {"_filter": f'fqdn=="{fqdn}." and view=="{self._view_id}"'})
        if not existing:
            self.emit({"step": f"  Zone not found — nothing to delete: {fqdn}"})
            return False
        zone_id = existing[0].get("id", "")
        self.emit({"step": f"{mode}Deleting forward DNS zone: {fqdn}  id={zone_id}"})
        if not self.cfg.dry_run:
            _, status = _rest_write("DELETE", f"/api/ddi/v1/{zone_id}")
            if not (status and 200 <= status < 300):
                raise ProvisionError(f"Failed to delete DNS zone {fqdn}: status {status}")
        return True

    def delete_dhcp_ranges(self) -> list:
        ranges = _rest_get("/api/ddi/v1/ipam/range", {
            "_filter": f'space=="{self._space_id}"', "_tfilter": f'Site=="{self.cfg.site}"'})
        deleted = []
        mode = "[DRY-RUN] " if self.cfg.dry_run else ""
        for r in ranges:
            range_id = r.get("id", "")
            self.emit({"step": f'{mode}Deleting DHCP range {r.get("start", "")}-{r.get("end", "")}  id={range_id}'})
            if not self.cfg.dry_run:
                _, status = _rest_write("DELETE", f"/api/ddi/v1/{range_id}")
                if not (status and 200 <= status < 300):
                    raise ProvisionError(f"Failed to delete DHCP range {range_id}: status {status}")
            deleted.append({"id": range_id, "start": r.get("start", ""), "end": r.get("end", "")})
        return deleted

    def delete_reverse_zones(self, subnets: list) -> list:
        deleted = []
        mode = "[DRY-RUN] " if self.cfg.dry_run else ""
        for subnet in subnets:
            try:
                fqdn = _cidr_to_reverse_zone(subnet["address"], int(subnet["cidr"]))
            except (KeyError, ValueError, TypeError):
                continue
            existing = _rest_get("/api/ddi/v1/dns/auth_zone",
                                  {"_filter": f'fqdn=="{fqdn}" and view=="{self._view_id}"'})
            if not existing:
                continue
            zone_id = existing[0].get("id", "")
            self.emit({"step": f"{mode}Deleting reverse DNS zone: {fqdn}  id={zone_id}"})
            if not self.cfg.dry_run:
                _, status = _rest_write("DELETE", f"/api/ddi/v1/{zone_id}")
                if not (status and 200 <= status < 300):
                    raise ProvisionError(f"Failed to delete reverse zone {fqdn}: status {status}")
            deleted.append({"id": zone_id, "fqdn": fqdn})
        return deleted

    def delete_subnets(self, subnets: list) -> list:
        deleted = []
        mode = "[DRY-RUN] " if self.cfg.dry_run else ""
        for subnet in subnets:
            subnet_id = subnet.get("id", "")
            addr = f'{subnet.get("address", "")}/{subnet.get("cidr", "")}'
            self.emit({"step": f'{mode}Deleting subnet: {addr}  name={subnet.get("name", "")}  id={subnet_id}'})
            if not self.cfg.dry_run:
                _, status = _rest_write("DELETE", f"/api/ddi/v1/{subnet_id}")
                if not (status and 200 <= status < 300):
                    raise ProvisionError(f"Failed to delete subnet {addr}: status {status}")
            deleted.append({"address": addr, "name": subnet.get("name", ""), "id": subnet_id})
        return deleted

    def delete_hosts(self) -> list:
        # subnets-before-hosts (see class docstring): a DHCP-bound host address
        # is "in use" until the subnet delete above releases it, so hosts must
        # be matched + deleted last, by FQDN suffix rather than subnet membership.
        suffix = f".{self.cfg.dns_zone}"
        all_hosts = _rest_get("/api/ddi/v1/ipam/host", {"_limit": 1000})
        site_hosts = [h for h in all_hosts if str(h.get("name", "")).endswith(suffix)]
        deleted = []
        mode = "[DRY-RUN] " if self.cfg.dry_run else ""
        for host in site_hosts:
            host_id = host.get("id", "")
            fqdn = host.get("name", host_id)
            self.emit({"step": f"{mode}Deleting host: {fqdn}  id={host_id}"})
            if not self.cfg.dry_run:
                _, status = _rest_write("DELETE", f"/api/ddi/v1/{host_id}")
                if not (status and 200 <= status < 300):
                    raise ProvisionError(f"Failed to delete host {fqdn}: status {status}")
            deleted.append({"fqdn": fqdn, "id": host_id})
        return deleted

    def decommission(self) -> dict:
        result = {"site": self.cfg.site, "ip_space": self.cfg.ip_space, "dry_run": self.cfg.dry_run,
                  "dns_zone_fqdn": self.cfg.dns_zone, "dns_zone_deleted": False,
                  "dhcp_ranges_deleted": [], "reverse_zones_deleted": [],
                  "subnets_deleted": [], "hosts_deleted": []}

        self.resolve_ip_space()
        self.resolve_dns_view()

        subnets = self.find_subnets()
        if not subnets:
            self.emit({"step": f"No subnets tagged Site={self.cfg.site} found — will still check zone/hosts"})

        result["dns_zone_deleted"] = self.delete_dns_zone()
        result["dhcp_ranges_deleted"] = self.delete_dhcp_ranges()
        result["reverse_zones_deleted"] = self.delete_reverse_zones(subnets)
        result["subnets_deleted"] = self.delete_subnets(subnets)
        result["hosts_deleted"] = self.delete_hosts()
        return result


# ---------------------------------------------------------------------------
# Drift detection — read-only, port of site/query.py::SiteQuerier.query() +
# core.py::detect_drift
# ---------------------------------------------------------------------------

def query_site_live(cfg) -> dict:
    """Read-only live-state snapshot of a site, shaped for detect_drift().
    Compact port of site/query.py::SiteQuerier.query() — drops the CLI
    dataclass ceremony and only keeps what detect_drift needs: subnets (with
    tags + hosts) and forward-zone presence. Never writes. cfg may be any
    config exposing .site/.ip_space/.dns_view/.dns_zone (SiteConfig or
    DecommissionConfig both qualify)."""
    space_results = _rest_get("/api/ddi/v1/ipam/ip_space", {"_filter": f'name=="{cfg.ip_space}"'})
    if not space_results:
        raise ProvisionError(f"IP space not found: {cfg.ip_space}")
    space_id = space_results[0]["id"]
    view_results = _rest_get("/api/ddi/v1/dns/view", {"_filter": f'name=="{cfg.dns_view}"'})
    if not view_results:
        raise ProvisionError(f"DNS view not found: {cfg.dns_view}")
    view_id = view_results[0]["id"]

    subnets_raw = _rest_get("/api/ddi/v1/ipam/subnet", {
        "_filter": f'space=="{space_id}"', "_tfilter": f'Site=="{cfg.site}"'})
    found = bool(subnets_raw)
    all_hosts = _rest_get("/api/ddi/v1/ipam/host", {"_limit": 1000}) if subnets_raw else []

    subnets_out = []
    for subnet in subnets_raw:
        try:
            net = ipaddress.ip_network(f'{subnet["address"]}/{subnet["cidr"]}', strict=False)
        except (KeyError, ValueError, TypeError):
            net = None
        hosts_out = []
        if net is not None:
            for host in all_hosts:
                for addr_entry in host.get("addresses") or []:
                    try:
                        ip = ipaddress.ip_address(addr_entry.get("address", ""))
                    except ValueError:
                        continue
                    if ip in net:
                        hosts_out.append({"name": host.get("name", "")})
                        break
        stags = subnet.get("tags") or {}
        subnets_out.append({
            "id": subnet.get("id", ""), "address": subnet.get("address", ""), "cidr": subnet.get("cidr", ""),
            "name": subnet.get("name", "") or stags.get("Name", ""), "tags": stags, "hosts": hosts_out,
        })

    zone_results = _rest_get("/api/ddi/v1/dns/auth_zone",
                              {"_filter": f'fqdn=="{cfg.dns_zone}." and view=="{view_id}"'})
    zone = zone_results[0] if zone_results else {}

    return {"site": cfg.site, "found": found, "subnets": subnets_out,
            "dns_zone_found": bool(zone), "dns_zone_fqdn": zone.get("fqdn", cfg.dns_zone)}


def detect_drift(template: dict, live: dict, site_name: str = "") -> dict:
    """Compare a template's expected state against a live query result.
    Verbatim port of core.py::detect_drift (pure — no API calls; the caller
    supplies `live` from query_site_live())."""
    drifts = []

    def _drift(category, severity, field, message):
        drifts.append({"category": category, "severity": severity, "field": field, "message": message})

    resolved_site = site_name or live.get("site", "")

    live_subnets = live.get("subnets") or []
    if not (live_subnets or live.get("found")):
        _drift("site", "error", "site", "Site is not provisioned — no subnets found")
        return {"site": resolved_site, "found": False, "drifted": True, "subnet_count": 0,
                "drifts": drifts, "summary": {"total": 1, "errors": 1, "warnings": 0}}

    net = template.get("network") or {}
    dns = template.get("dns") or {}
    tags_tmpl = template.get("tags") or {}
    live_tags = (live_subnets[0].get("tags") or {}) if live_subnets else {}

    expected_subnet_names = {str(s.get("name", "")).strip() for s in (net.get("subnets") or [])
                             if str(s.get("name", "")).strip()}
    live_subnet_names = {str(s.get("name", "")).strip() for s in live_subnets
                         if str(s.get("name", "")).strip()}
    for name in sorted(expected_subnet_names - live_subnet_names):
        _drift("subnet", "error", f"network.subnets[{name}]", f"Expected subnet {name!r} not found in API")
    for name in sorted(live_subnet_names - expected_subnet_names):
        _drift("subnet", "warning", f"subnet:{name}", f"Subnet {name!r} exists in API but is not in the template")

    wants_zone = bool(dns.get("create_zone"))
    zone_found = bool(live.get("dns_zone_found"))
    if wants_zone and not zone_found:
        _drift("dns", "error", "dns.create_zone", "Template specifies create_zone: true but no DNS zone was found")
    elif not wants_zone and zone_found:
        fqdn = live.get("dns_zone_fqdn", "")
        _drift("dns", "warning", "dns.create_zone",
               f"DNS zone {fqdn!r} exists in API but template does not specify create_zone: true")

    for key, expected_val in sorted(tags_tmpl.items()):
        live_val = live_tags.get(key)
        if live_val is None:
            _drift("tags", "warning", f"tags.{key}", f"Tag {key!r} missing from subnet tags (expected {str(expected_val)!r})")
        elif str(live_val) != str(expected_val):
            _drift("tags", "warning", f"tags.{key}",
                   f"Tag {key!r}: expected {str(expected_val)!r}, live value is {str(live_val)!r}")

    expected_hosts = {str(h.get("hostname", "")).strip() for h in (template.get("hosts") or [])
                      if str(h.get("hostname", "")).strip()}
    live_hosts = set()
    for subnet in live_subnets:
        for h in subnet.get("hosts") or []:
            raw = h.get("name") or h.get("id") or ""
            base = str(raw).split(".")[0].strip()
            if base:
                live_hosts.add(base)
    for hostname in sorted(expected_hosts - live_hosts):
        _drift("hosts", "warning", f"hosts[{hostname}]", f"Expected host {hostname!r} not found in any subnet")
    for hostname in sorted(live_hosts - expected_hosts):
        _drift("hosts", "info", f"host:{hostname}", f"Host {hostname!r} exists in API but is not in the template")

    errors = sum(1 for d in drifts if d["severity"] == "error")
    warnings = sum(1 for d in drifts if d["severity"] in ("warning", "info"))
    return {"site": resolved_site, "found": True, "drifted": len(drifts) > 0, "subnet_count": len(live_subnets),
            "drifts": drifts, "summary": {"total": len(drifts), "errors": errors, "warnings": warnings}}


# ── encrypted vault (multi-tenant key store) ──────────────────────────────────
# Keys are secrets the bridge must *replay* to Infoblox, so they're stored
# reversibly — but encrypted at rest (Fernet/AES) under a key derived from a
# user passphrase (scrypt). The passphrase is never stored; unlock re-derives
# it after each restart. Persist on a mounted volume so it survives updates.

def _resolve_vault_file():
    for d in (os.environ.get("VAULT_DIR", "/vault"), DIR):
        try:
            os.makedirs(d, exist_ok=True)
            t = os.path.join(d, ".wtest"); open(t, "w").close(); os.remove(t)
            return os.path.join(d, "vault.json")
        except Exception:
            continue
    return os.path.join(DIR, "vault.json")

VAULT_FILE = _resolve_vault_file()
BRAND_FILE = os.path.join(os.path.dirname(VAULT_FILE), "brand.json")
LOGO_FILE  = os.path.join(os.path.dirname(VAULT_FILE), "logo.png")

# ── saved views (dashboard layouts) ───────────────────────────────────────────
# One JSON blob per view on the same mounted volume as the vault, so saved
# layouts survive restarts/updates. Names are sanitized to a flat filename to
# prevent path traversal — no "/" or ".." can escape VIEWS_DIR.
VIEWS_DIR = os.path.join(os.path.dirname(VAULT_FILE) or os.environ.get("VAULT_DIR", "/vault"), "views")

def _view_path(name):
    """Sanitized absolute path for a view name, or None if the name is empty."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", str(name or "").strip())[:120]
    if not safe or safe in (".", ".."):
        return None
    return os.path.join(VIEWS_DIR, safe + ".json")

def views_list():
    """List saved views (name + saved_at only, no bodies)."""
    out = []
    try:
        for fn in sorted(os.listdir(VIEWS_DIR)):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(VIEWS_DIR, fn)) as f:
                    v = json.load(f)
                out.append({"name": v.get("name", fn[:-5]), "saved_at": v.get("saved_at"),
                            "folder": v.get("folder", "")})
            except Exception:
                continue
    except FileNotFoundError:
        pass
    return {"views": out}

def view_read(name):
    """Return the full stored view blob, or None if missing/invalid."""
    p = _view_path(name)
    if not p or not os.path.exists(p):
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None

def view_write(blob):
    """Validate + persist an (opaque) view blob. Returns (payload, status)."""
    if not isinstance(blob, dict):
        return {"ok": False, "error": "view must be an object"}, 400
    name = blob.get("name")
    if not name or not str(name).strip():
        return {"ok": False, "error": "name required"}, 400
    p = _view_path(name)
    if not p:
        return {"ok": False, "error": "invalid name"}, 400
    rec = {
        "name": str(name),
        "widgets": blob.get("widgets", {}),
        "order": blob.get("order", []),
        "layout": blob.get("layout", {}),
        "folder": str(blob.get("folder", "") or ""),
        "saved_at": blob.get("saved_at") or _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
    }
    os.makedirs(VIEWS_DIR, exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f)
    os.replace(tmp, p)
    return {"ok": True, "name": rec["name"]}, 200

def view_delete(name):
    """Delete a saved view. Returns True if a file was removed."""
    p = _view_path(name)
    if not p or not os.path.exists(p):
        return False
    os.remove(p)
    return True
_vault = {"unlocked": False, "tenants": [], "active": None, "groq": "", "llm_base": "", "llm_model": "", "_key": None, "_salt": ""}
_vault_lock = threading.Lock()

def vault_exists():
    return os.path.exists(VAULT_FILE)

def _vault_passphrase_from_env():
    """Optional auto-unlock secret. Prefer a mounted secret file over a raw
    env var so the passphrase stays out of `docker inspect`/process env."""
    p = os.environ.get("VAULT_PASSPHRASE_FILE", "").strip()
    if p:
        try:
            with open(p) as f:
                return f.read().strip()
        except Exception as e:
            print(f"  [warn] VAULT_PASSPHRASE_FILE unreadable: {e}", file=sys.stderr)
    return os.environ.get("VAULT_PASSPHRASE", "")

def _derive_key(passphrase, salt):
    dk = hashlib.scrypt(passphrase.encode(), salt=salt, n=2**15, r=8, p=1, dklen=32, maxmem=64*1024*1024)
    return base64.urlsafe_b64encode(dk)

def _vault_save():
    payload = {"tenants": _vault["tenants"], "active": _vault["active"], "groq": _vault["groq"],
               "llm_base": _vault.get("llm_base", ""), "llm_model": _vault.get("llm_model", "")}
    token = Fernet(_vault["_key"]).encrypt(json.dumps(payload).encode())
    tmp = VAULT_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"v": 1, "salt": _vault["_salt"], "data": token.decode()}, f)
    os.replace(tmp, VAULT_FILE)
    try: os.chmod(VAULT_FILE, 0o600)
    except Exception: pass

def _apply_active():
    """Point the MCP proxy (and LLM) at the active tenant's key."""
    global API_KEY, _HOME_ACCOUNT_ID, _active_account_id, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
    t = next((x for x in _vault["tenants"] if x["id"] == _vault["active"]), None)
    API_KEY = t["key"] if t else ""
    MCP_HEADERS["Authorization"] = API_KEY
    _HOME_ACCOUNT_ID = ""; _active_account_id = ""   # re-resolve accounts for this key
    if _vault.get("groq"):      LLM_API_KEY  = _vault["groq"]
    if _vault.get("llm_base"):  LLM_BASE_URL = _vault["llm_base"]
    if _vault.get("llm_model"): LLM_MODEL    = _vault["llm_model"]
    cache_invalidate()
    # warm the new tenant's data immediately so the first post-unlock/switch load
    # is a cache hit (non-blocking; _warm_tick self-guards via _warm_lock)
    threading.Thread(target=_warm_tick, daemon=True).start()

def vault_init(passphrase):
    with _vault_lock:
        if vault_exists():
            return {"ok": False, "error": "vault already exists — unlock instead"}
        if not passphrase or len(passphrase) < 8:
            return {"ok": False, "error": "passphrase must be at least 8 characters"}
        salt = secrets.token_bytes(16)
        _vault.update({"unlocked": True, "tenants": [], "active": None, "groq": "",
                       "_key": _derive_key(passphrase, salt), "_salt": base64.b64encode(salt).decode()})
        _vault_save()
        return {"ok": True}

def vault_unlock(passphrase):
    with _vault_lock:
        if not vault_exists():
            return {"ok": False, "error": "no vault yet"}
        with open(VAULT_FILE) as f:
            raw = json.load(f)
        key = _derive_key(passphrase, base64.b64decode(raw["salt"]))
        try:
            payload = json.loads(Fernet(key).decrypt(raw["data"].encode()))
        except (InvalidToken, Exception):
            return {"ok": False, "error": "wrong passphrase"}
        _vault.update({"unlocked": True, "tenants": payload.get("tenants", []),
                       "active": payload.get("active"), "groq": payload.get("groq", ""),
                       "llm_base": payload.get("llm_base", ""), "llm_model": payload.get("llm_model", ""),
                       "_key": key, "_salt": raw["salt"]})
        _apply_active()
    # lock released — best-effort: auto-resolve any 'Tenant N'/blank key names so a
    # valid-but-unnamed key shows its real CSP account (not a 'Tenant 2' fallback).
    try:
        vault_refresh_names()
    except Exception:
        pass
    return {"ok": True}

def _norm_key(k):
    """Accept whatever Infoblox-shaped key the user pastes and normalize to the
    Authorization value the bridge sends. Format-agnostic: handles surrounding
    quotes, a pasted 'Authorization:' header, any case of token/bearer, a bare
    JWT (-> Bearer), or a raw token (-> Token)."""
    k = (k or "").strip()
    if len(k) >= 2 and k[0] == k[-1] and k[0] in ("'", '"'):
        k = k[1:-1].strip()
    if k.lower().startswith("authorization:"):
        k = k.split(":", 1)[1].strip()
    if not k:
        return ""
    scheme, sep, rest = k.partition(" ")
    if sep and scheme.lower() in ("token", "bearer"):
        return scheme.capitalize() + " " + rest.strip()
    if k.startswith("eyJ"):            # unprefixed JWT
        return "Bearer " + k
    return "Token " + k

def _portal_label_for_key(key):
    """Resolve the CSP account name for a key, so a tenant auto-names itself
    from the portal (the user shouldn't have to invent a label)."""
    from urllib.request import urlopen, Request
    def _g(path):
        req = Request(f"{BASE_URL}{path}", headers={"Authorization": key})
        with urlopen(req, timeout=12) as r:
            return json.loads(r.read())
    try:
        accts = _g("/v2/current_user/accounts").get("results", [])
        active = [a for a in accts if a.get("state", "active") == "active"] or accts
        try:
            aid = _g("/v2/current_user").get("result", {}).get("account_id", "")
        except Exception:
            aid = ""
        for a in active:
            if a.get("id") == aid and a.get("name"):
                return a["name"]
        if active and active[0].get("name"):
            return active[0]["name"]
        return ""
    except Exception as e:
        print(f"  [warn] tenant auto-name lookup failed: {e}", file=sys.stderr)
        return ""

def vault_add_tenant(label, key, groq=None):
    if not _vault["unlocked"]:
        return {"ok": False, "error": "locked"}
    key = _norm_key(key)
    if not key:
        return {"ok": False, "error": "API key required"}
    label = (label or "").strip()
    if not label:                       # auto-name from the portal account
        label = _portal_label_for_key(key) or f"Tenant {len(_vault['tenants']) + 1}"
    with _vault_lock:
        if not _vault["unlocked"]:
            return {"ok": False, "error": "locked"}
        tid = secrets.token_hex(6)
        _vault["tenants"].append({"id": tid, "label": label, "key": key})
        if groq is not None:
            _vault["groq"] = (groq or "").strip()
        if not _vault["active"]:
            _vault["active"] = tid
        _vault_save(); _apply_active()
        return {"ok": True, "id": tid, "label": label}

def vault_remove_tenant(tid):
    with _vault_lock:
        if not _vault["unlocked"]:
            return {"ok": False, "error": "locked"}
        _vault["tenants"] = [t for t in _vault["tenants"] if t["id"] != tid]
        if _vault["active"] == tid:
            _vault["active"] = _vault["tenants"][0]["id"] if _vault["tenants"] else None
        _vault_save(); _apply_active()
        return {"ok": True}

def vault_update_tenant(tid, key, label=None):
    """Update a stored connection: replace its API key, rename it, or both.
    A blank key keeps the existing key (rename-only). Re-applies if active."""
    if not _vault["unlocked"]:
        return {"ok": False, "error": "locked"}
    key = _norm_key(key)                         # may be "" for rename-only
    lbl = (label or "").strip()
    if not key and not lbl:
        return {"ok": False, "error": "nothing to update"}
    with _vault_lock:
        t = next((x for x in _vault["tenants"] if x["id"] == tid), None)
        if not t:
            return {"ok": False, "error": "unknown connection"}
        if key:
            t["key"] = key
            if not lbl:                          # new key, no explicit name → auto-resolve
                lbl = _portal_label_for_key(key) or t.get("label") or f"Tenant {_vault['tenants'].index(t) + 1}"
        if lbl:
            t["label"] = lbl
        _vault_save()
        if _vault["active"] == tid and key:
            _apply_active()
        return {"ok": True, "id": tid, "label": t["label"]}

def vault_set_active(tid):
    with _vault_lock:
        if not _vault["unlocked"]:
            return {"ok": False, "error": "locked"}
        if not any(t["id"] == tid for t in _vault["tenants"]):
            return {"ok": False, "error": "unknown tenant"}
        _vault["active"] = tid
        _vault_save(); _apply_active()
        return {"ok": True, "active": tid}

def vault_lock():
    global API_KEY
    with _vault_lock:
        _vault.update({"unlocked": False, "tenants": [], "active": None, "groq": "", "_key": None})
        API_KEY = ""; MCP_HEADERS["Authorization"] = ""
        cache_invalidate()
    return {"ok": True}

def vault_reset():
    """Forgot-passphrase escape hatch: permanently delete the encrypted vault
    (all stored keys are unrecoverable by design) and return to first-run setup."""
    global API_KEY
    with _vault_lock:
        try:
            if os.path.exists(VAULT_FILE):
                os.remove(VAULT_FILE)
        except Exception:
            pass
        _vault.update({"unlocked": False, "tenants": [], "active": None, "groq": "", "_key": None, "_salt": ""})
        API_KEY = ""; MCP_HEADERS["Authorization"] = ""
        cache_invalidate()
    return {"ok": True}

def vault_set_llm(key, base_url=None, model=None):
    """Set the (provider-agnostic) LLM config: API key + optional OpenAI-compatible
    base URL + model. Blank base URL = Groq default."""
    global LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
    with _vault_lock:
        if not _vault["unlocked"]:
            return {"ok": False, "error": "locked"}
        _vault["groq"] = (key or "").strip()
        if base_url is not None: _vault["llm_base"]  = (base_url or "").strip()
        if model is not None:    _vault["llm_model"] = (model or "").strip()
        LLM_API_KEY  = _vault["groq"]
        if _vault.get("llm_base"):  LLM_BASE_URL = _vault["llm_base"]
        if _vault.get("llm_model"): LLM_MODEL    = _vault["llm_model"]
        _vault_save()
        return {"ok": True}

def vault_test_key(key):
    """Verify an Infoblox API key reaches CSP; return the resolved account name."""
    from urllib.request import urlopen, Request
    k = _norm_key(key)
    if not k:
        return {"ok": False, "error": "API key required"}
    name = _portal_label_for_key(k)
    if name:
        return {"ok": True, "name": name}
    try:
        req = Request(f"{BASE_URL}/v2/current_user", headers={"Authorization": k})
        with urlopen(req, timeout=12) as r:
            r.read()
        return {"ok": True, "name": ""}   # reachable, but no account name resolved
    except Exception:
        return {"ok": False, "error": "key rejected by Infoblox CSP"}

def vault_conn_test():
    """Verify the ACTIVE connection's key reaches Infoblox CSP (read-only)."""
    if not API_KEY:
        return {"ok": False, "error": "no active connection"}
    return vault_test_key(API_KEY)

def vault_llm_test(key, base_url=None, model=None):
    """Send a tiny completion to verify the LLM provider key/base/model work."""
    key = (key or "").strip() or _vault.get("groq", "")
    base = (base_url if base_url is not None else _vault.get("llm_base", "")).strip()
    mdl  = (model if model else _vault.get("llm_model", "")) or LLM_MODEL
    if not key:
        return {"ok": False, "error": "API key required"}
    async def _run():
        kw = {"api_key": key}
        if base: kw["base_url"] = base
        async with _groq.AsyncGroq(**kw) as c:
            await c.chat.completions.create(model=mdl, max_tokens=4,
                                            messages=[{"role": "user", "content": "ping"}])
    try:
        _run_async(_run()); return {"ok": True, "model": mdl}
    except Exception as e:
        _log_exc("vault_llm_test", e)
        return {"ok": False, "error": "LLM test failed"}

def vault_refresh_names():
    """Re-resolve the CSP account name for any tenant still labelled 'Tenant N' or blank."""
    if not _vault["unlocked"]:
        return {"ok": False, "error": "locked"}
    updated = 0
    for t in _vault["tenants"]:
        lbl = t.get("label", "")
        if not lbl or re.match(r"^Tenant \d+$", lbl):
            nm = _portal_label_for_key(t["key"])
            if nm and nm != lbl:
                t["label"] = nm; updated += 1
    if updated:
        with _vault_lock:
            _vault_save()
    return {"ok": True, "updated": updated}

def vault_status():
    return {
        "version": APP_VERSION,
        "vaultMode": VAULT_MODE,
        "exists": vault_exists(),
        "unlocked": (not VAULT_MODE) or _vault["unlocked"],
        "ready": bool(MCP_HEADERS.get("Authorization")),
        "tenants": [{"id": t["id"], "label": t["label"]} for t in _vault["tenants"]],
        "active": _vault["active"],
        "hasGroq": bool(_vault["groq"]),
        "llm": {"hasKey": bool(_vault["groq"]),
                "base_url": _vault.get("llm_base", ""),
                "model": _vault.get("llm_model", "")},
        "update": update_status(),
    }

# ── MCP helpers ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def _mcp_session():
    async with streamablehttp_client(MCP_URL, headers=MCP_HEADERS) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session

def _tool_text(result) -> str:
    return result.content[0].text if result.content else "{}"

def _columnar_to_dicts(raw: dict) -> list:
    """Convert DuckDB columnar result {columns, data} to list of dicts."""
    inner = raw.get("results", raw)
    cols = inner.get("columns", [])
    rows = inner.get("data", [])
    return [dict(zip(cols, row)) for row in rows]

def _results(data) -> list:
    """Pass-through: _mcp_get now returns a list directly."""
    if isinstance(data, list):
        return data
    for key in ("data", "results", "items"):
        val = data.get(key)
        if isinstance(val, list):
            return val
    return []

async def _query_all_rows(session, table: str, row_count: int, label: str) -> list:
    """Page through stored Parquet 100 rows at a time — MCP caps inline data at 100."""
    PAGE = 100
    rows: list = []
    offset = 0
    while offset < row_count:
        try:
            r = await asyncio.wait_for(
                session.call_tool("infoblox-portal_query_stored_data", {
                    "task_description": f"Read rows {offset}–{offset+PAGE} from {label}",
                    "sql_query": f'SELECT * FROM "{table}" LIMIT {PAGE} OFFSET {offset}',
                }), timeout=30)
        except asyncio.TimeoutError:
            print(f"  [warn] MCP timeout: {label} (step 2 @ offset {offset})", file=sys.stderr)
            break
        batch = _columnar_to_dicts(json.loads(_tool_text(r)))
        if not batch:
            break
        rows.extend(batch)
        offset += PAGE
    return rows

async def _mcp_get(session, service: str, endpoint: str,
                   params: dict | None = None, fetch_all: bool = False) -> list:
    ck = _cache_key(service, endpoint, params, fetch_all)
    cached = _cache_get(ck)
    if cached is not None:
        return cached
    # Step 1: store data as Parquet
    args = {
        "task_description": f"Fetch {service} {endpoint} for NOC dashboard",
        "service_name": service,
        "endpoint": endpoint,
        "fetch_all": fetch_all,
    }
    if params:
        args["query_params"] = params
    try:
        r1 = await asyncio.wait_for(
            session.call_tool("infoblox-portal_make_get_request", args), timeout=30)
    except asyncio.TimeoutError:
        print(f"  [warn] MCP timeout: {service}/{endpoint} (step 1)", file=sys.stderr)
        return []
    try:
        meta = json.loads(_tool_text(r1))
    except json.JSONDecodeError:
        return []
    if not isinstance(meta, dict):
        return []
    table = meta.get("table_name", "")
    if not table or not _TABLE_RE.match(table) or meta.get("row_count", 0) == 0:
        return []
    # Step 2: page through stored Parquet (MCP caps inline rows at 100)
    try:
        result = await _query_all_rows(session, table, meta.get("row_count", 0),
                                       f"{service}/{endpoint}")
        _cache_set(ck, result)
        return result
    except Exception as e:
        print(f"  [warn] _mcp_get {service}/{endpoint}: {e}", file=sys.stderr)
        return []

async def _mcp_query_cube(session, cube: str, measures: list,
                           dimensions: list | None = None,
                           time_dims: list | None = None,
                           order: dict | None = None,
                           limit: int | None = None) -> dict:
    args = {
        "task_description": f"Query {cube} for NOC dashboard analytics",
        "cube_name": cube,
        "measures": measures,
    }
    if dimensions: args["dimensions"] = dimensions
    if time_dims:  args["time_dimensions"] = time_dims
    if order:      args["order"] = order
    if limit:      args["limit"] = limit
    try:
        r1 = await asyncio.wait_for(
            session.call_tool("infoblox-portal_query_cube", args), timeout=30)
    except asyncio.TimeoutError:
        print(f"  [warn] MCP timeout: {cube} (step 1)", file=sys.stderr)
        return {}
    try:
        meta = json.loads(_tool_text(r1))
    except json.JSONDecodeError:
        return {}
    if not isinstance(meta, dict):
        return {}
    table = meta.get("table_name", "")
    if not table or not _TABLE_RE.match(table) or meta.get("row_count", 0) == 0:
        return {}
    try:
        # cube columns use __ separator; convert back to . for caller consistency
        rows = await _query_all_rows(session, table, meta.get("row_count", 0), f"{cube} cube")
        return {"data": [{k.replace("__", ".", 1): v for k, v in r.items()} for r in rows]}
    except Exception as e:
        print(f"  [warn] _mcp_query_cube {cube}: {e}", file=sys.stderr)
        return {}

async def _mcp_search(session, query: str) -> list:
    query = (query or "")[:256]  # cap length of user-controlled filter
    try:
        result = await asyncio.wait_for(
            session.call_tool("infoblox-portal_network_entity_search", {"query": query}),
            timeout=10.0
        )
    except asyncio.TimeoutError:
        return []
    try:
        data = json.loads(_tool_text(result))
        return data if isinstance(data, list) else _results(data)
    except json.JSONDecodeError:
        return []

# ── data normalisation ────────────────────────────────────────────────────────

def norm_subnets(raw):
    out = []
    for s in raw:
        u = s.get("utilization") or s.get("dhcp_utilization") or {}
        total = int(u.get("total") or u.get("total_count") or 0)
        used  = int(u.get("used")  or u.get("used_count")  or 0)
        pct   = round(used / total * 100) if total else 0
        tags  = s.get("tags") or {}
        out.append({
            "id":   s.get("id", ""),
            "name": s.get("name") or s.get("address", ""),
            "addr": s.get("address", ""),
            "cidr": s.get("cidr", 0),
            "total": total,
            "used":  used,
            "util":  pct,
            "site":  tags.get("site") or tags.get("location") or "–",
        })
    return out

def norm_leases(raw):
    out = []
    for l in raw:
        state = l.get("state", "")
        mapped = "active" if state in ("used", "issued", "dynamic") else "expired"
        hostname = l.get("hostname") or l.get("client_id", "")
        hostname = hostname.strip('"')
        out.append({
            "addr":      l.get("address", ""),
            "host":      hostname,
            "subnet":    l.get("subnet_name") or "",
            "subnet_id": "",
            "state":     mapped,
        })
    return out

def norm_zones(raw, view_map=None):
    vm = view_map or {}
    out = []
    for z in raw:
        za      = z.get("zone_authority") or {}
        ttl     = int(za.get("default_ttl") or 3600)
        neg_ttl = int(za.get("negative_ttl") or 3600)
        fqdn    = z.get("fqdn") or z.get("name", "")
        view_ref = z.get("view", "")
        view    = vm.get(view_ref) or view_ref.split("/")[-1][:12] or "default"
        issues  = []
        if ttl < 60:       issues.append("TTL Too Low")
        if ttl > 86400:    issues.append("TTL Too High")
        if neg_ttl > 3600: issues.append("High Neg-TTL")
        out.append({
            "id":      z.get("id", ""),
            "fqdn":    fqdn,
            "view":    view,
            "ttl":     ttl,
            "neg_ttl": neg_ttl,
            "records": 0,
            "issues":  issues,
            "anomaly": len(issues) > 0,
        })
    return out

def norm_views(raw):
    return [{"id": v.get("id",""), "name": v.get("name",""), "comment": v.get("comment","")} for v in raw]

def norm_hosts(raw):
    STATUS_MAP = {
        "online": "online", "active": "online",
        "degraded": "degraded",
        "offline": "offline", "inactive": "offline",
        "error": "error",
        "pending": "pending", "awaiting_provisioning": "pending",
    }
    TYPE_MAP = {
        "dns": "DNS", "dhcp": "DHCP", "ntp": "NTP",
        "dfp": "Forwarder", "cdc": "Connector",
    }
    HOST_TYPE_MAP = {
        "bloxone_appliance": "Appliance", "bloxone_vm": "VM",
        "k8s": "K8s", "cloud": "Cloud",
    }
    out = []
    for h in raw:
        raw_status = (h.get("composite_status") or
                      (h.get("connectivity_monitor") or {}).get("status") or
                      "pending")
        status = STATUS_MAP.get(raw_status.lower(), "pending")
        configs = h.get("configs") or []
        svc_types = [c.get("service_type","") for c in configs if c.get("service_type")]
        htype = TYPE_MAP.get(svc_types[0], None) if svc_types else None
        if not htype:
            htype = HOST_TYPE_MAP.get((h.get("host_type") or "").lower(), "Host")
        out.append({
            "id":     h.get("id", ""),
            "name":   h.get("display_name") or h.get("name", ""),
            "ip":     h.get("ip_address") or "",
            "type":   htype,
            "status": status,
        })
    return out

def norm_policies(raw):
    out = []
    for p in raw:
        action_raw = p.get("default_action") or p.get("action") or "action_allow"
        action = action_raw.replace("action_", "")
        rules = len(p.get("rules") or p.get("rule_names") or p.get("network_lists") or [])
        out.append({
            "id":      str(p.get("id","")),
            "name":    p.get("name",""),
            "action":  action,
            "rules":   rules,
            "created": (p.get("created_time") or "")[:10],
            "active":  not p.get("is_default", False),
        })
    return out

def norm_feeds(raw):
    LEVELS = {"high": "critical", "medium": "high", "low": "medium"}
    out = []
    for f in raw:
        conf_level = f.get("confidence_level", "MEDIUM").lower()
        threat_level = f.get("threat_level", "").lower() or LEVELS.get(conf_level, "medium")
        out.append({
            "id":      f.get("id",""),
            "name":    f.get("name",""),
            "level":   threat_level,
            "conf":    conf_level if conf_level in ("high","medium","low") else "medium",
            "cat":     f.get("type") or f.get("category","Mixed"),
            "entries": f.get("item_count") or f.get("items_described") or 0,
            "active":  f.get("is_default") or not f.get("is_default", False),
        })
    return out

def norm_audit(raw):
    return [{
        "id":       l.get("id",""),
        "ts":       l.get("created_at") or "",
        "user":     l.get("user_name") or l.get("user_email") or l.get("subject_type",""),
        "action":   (l.get("action") or l.get("http_method") or "READ").upper(),
        "resource": l.get("resource_type") or "",
        "result":   "failure" if int(l.get("http_code", 200)) >= 400 else "success",
    } for l in raw]

# ── fetch all dashboard data ──────────────────────────────────────────────────

async def _fetch_dashboard_async() -> dict:
    async with _mcp_session() as session:
        print("  MCP session established, fetching 8 data sources in parallel…")

        (subnets_d, leases_d, views_d, zones_d,
         hosts_d, policies_d, feeds_d, audit_d) = await asyncio.gather(
            _mcp_get(session, "Ipamsvc", "/ipam/subnet",
                     {"_fields": "id,name,address,cidr,utilization,tags"}, fetch_all=True),
            _mcp_get(session, "DhcpLeases", "/dhcp/lease",
                     {"_fields": "address,hostname,state,client_id"}, fetch_all=True),
            _mcp_get(session, "DnsConfig", "/dns/view",
                     {"_fields": "id,name,comment"}, fetch_all=True),
            _mcp_get(session, "DnsConfig", "/dns/auth_zone",
                     {"_fields": "id,fqdn,view,zone_authority,primary_type"}, fetch_all=True),
            _mcp_get(session, "Infrastructure", "/detail_hosts",
                     {"_fields": "id,display_name,ip_address,composite_status,host_type,configs"}, fetch_all=True),
            _mcp_get(session, "Atcfw", "/security_policies",
                     {"_fields": "id,name,default_action,rule_names,network_lists,created_time,is_default"}, fetch_all=True),
            _mcp_get(session, "Atcfw", "/named_lists",
                     {"_fields": "id,name,confidence_level,threat_level,type,item_count"}, fetch_all=True),
            _mcp_get(session, "AuditLog", "/logs",
                     {"_limit": 100, "_order_by": "created_at desc"}),
        )

        view_map = {v.get("id", ""): v.get("name", "") for v in _results(views_d)}

        subnets  = norm_subnets(_results(subnets_d))
        leases   = norm_leases(_results(leases_d))
        views    = norm_views(_results(views_d))
        zones    = norm_zones(_results(zones_d), view_map)
        hosts    = norm_hosts(_results(hosts_d))
        policies = norm_policies(_results(policies_d))
        feeds    = norm_feeds(_results(feeds_d))
        audit    = norm_audit(_results(audit_d))

        print(f"  subnets={len(subnets)} leases={len(leases)} zones={len(zones)} "
              f"hosts={len(hosts)} policies={len(policies)} feeds={len(feeds)} audit={len(audit)}")

        return {
            "subnets":    subnets,
            "leases":     leases,
            "dnsViews":   views,
            "zones":      zones,
            "hosts":      hosts,
            "secPolicies": policies,
            "feeds":      feeds,
            "auditLogs":  audit,
        }

def fetch_dashboard_data() -> dict:
    """Fetch all dashboard data via direct Infoblox REST (the MCP parquet path
    is broken server-side). Reuses the norm_* shapers unchanged."""
    ck = _cache_key("dashboard_rest", "", None, False)
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    print("Fetching dashboard data via direct REST…")
    subnets_d  = _rest_get("/api/ddi/v1/ipam/subnet",
                           {"_fields": "id,name,address,cidr,utilization,tags", "_limit": 5000})
    leases_d   = _rest_get("/api/ddi/v1/dhcp/lease",
                           {"_fields": "address,hostname,state,client_id", "_limit": 5000})
    views_d    = _rest_get("/api/ddi/v1/dns/view",
                           {"_fields": "id,name,comment", "_limit": 5000})
    zones_d    = _rest_get("/api/ddi/v1/dns/auth_zone",
                           {"_fields": "id,fqdn,view,zone_authority,primary_type", "_limit": 5000})
    hosts_d    = _rest_get("/api/infra/v1/detail_hosts", {"_limit": 500})
    policies_d = _rest_get("/api/atcfw/v1/security_policies", {"_limit": 200})
    feeds_d    = _rest_get("/api/atcfw/v1/named_lists", {"_limit": 200})
    audit_d    = []

    view_map = {v.get("id", ""): v.get("name", "") for v in views_d}

    result = {
        "subnets":     norm_subnets(subnets_d),
        "leases":      norm_leases(leases_d),
        "dnsViews":    norm_views(views_d),
        "zones":       norm_zones(zones_d, view_map),
        "hosts":       norm_hosts(hosts_d),
        "secPolicies": norm_policies(policies_d),
        "feeds":       norm_feeds(feeds_d),
        "auditLogs":   norm_audit(audit_d),
    }
    print(f"  subnets={len(result['subnets'])} leases={len(result['leases'])} "
          f"zones={len(result['zones'])} hosts={len(result['hosts'])} "
          f"policies={len(result['secPolicies'])} feeds={len(result['feeds'])}")
    _cache_set(ck, result)
    return result

# ── operator-hub fetchers (direct REST — ports of backend/data/fetch_*.py) ─────

_HUB_SERVICE_BUCKETS = {
    "DNS": {"dns", "ndns"},
    "DHCP": {"dhcp", "ndhcp"},
    "Security": {"dfp", "orpheus"},
}
_HUB_STATUS_RANK = {"online": 0, "stopped": 1, "error": 2}
_HUB_RANK_SEVERITY = {0: "ok", 1: "warn", 2: "crit"}
_HUB_SEVERITY_LABEL = {"ok": "healthy", "warn": "degraded", "crit": "critical"}

def fetch_hub_health() -> list:
    """Per-service-type health rollup for DNS / DHCP / Security."""
    ck = _cache_key("hub_health", "", None, False)
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    services = _rest_get("/api/infra/v1/detail_services", {"_limit": 500})
    rollup = []
    for svc_name, types in _HUB_SERVICE_BUCKETS.items():
        members = [s for s in services if s.get("service_type") in types]
        if not members:
            rollup.append({
                "name": svc_name, "status": "ok",
                "statusLabel": "no services", "meta": "0 deployed",
            })
            continue
        worst = max(_HUB_STATUS_RANK.get(s.get("composite_status", "online"), 0) for s in members)
        severity = _HUB_RANK_SEVERITY[worst]
        errs = sum(1 for s in members if s.get("composite_status") == "error")
        stopped = sum(1 for s in members if s.get("composite_status") == "stopped")
        online = sum(1 for s in members if s.get("composite_status") == "online")
        if errs:
            meta = f"{errs} error · {online}/{len(members)} up"
        elif stopped:
            meta = f"{stopped} stopped · {online}/{len(members)} up"
        else:
            meta = f"{online}/{len(members)} online"
        rollup.append({
            "name": svc_name,
            "status": severity,
            "statusLabel": _HUB_SEVERITY_LABEL[severity],
            "meta": meta,
        })
    _cache_set(ck, rollup)
    return rollup

def fetch_hub_security(window_secs: int = 3600, limit: int = 50) -> dict:
    """Recent DNS security (threat) events + severity/action counts."""
    ck = _cache_key("hub_security", "", {"w": window_secs, "l": limit}, False)
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    t1 = int(_time.time())
    t0 = t1 - window_secs
    rows = _rest_get("/api/dnsdata/v2/dns_event", {"t0": t0, "t1": t1, "_limit": limit})

    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    blocked = logged = 0
    events = []
    for e in rows:
        sev = str(e.get("severity", "")).lower()
        if sev in counts:
            counts[sev] += 1
        action = str(e.get("policy_action", "")).lower()
        if action in ("block", "redirect"):
            blocked += 1
        elif action == "log":
            logged += 1
        events.append({
            "event_time": e.get("event_time", ""),
            "qname": e.get("qname", ""),
            "severity": e.get("severity", ""),
            "policy_action": e.get("policy_action", ""),
            "feed_name": e.get("feed_name", ""),
            "threat_indicator": e.get("threat_indicator", ""),
            "device": e.get("device", ""),
            "network": e.get("network", ""),
        })
    result = {
        "events": events,
        "counts": counts,
        "blocked": blocked,
        "logged": logged,
        "total": len(rows),
    }
    _cache_set(ck, result)
    return result

def _hub_sev_rank(level: str) -> str:
    lv = str(level).upper()
    if lv in ("HIGH", "CRITICAL"):
        return "crit"
    if lv in ("MEDIUM", "MED"):
        return "warn"
    return "ok"

def fetch_hub_domains() -> dict:
    """Rich domain panels across the platform (threat defense, endpoints,
    anycast, DFP, hosts). Same output shape as backend/data/fetch_domains.py."""
    from collections import Counter
    ck = _cache_key("hub_domains", "", None, False)
    cached = _cache_get(ck)
    if cached is not None:
        return cached

    policies = _rest_get("/api/atcfw/v1/security_policies", {"_limit": 100})
    feeds    = _rest_get("/api/atcfw/v1/threat_feeds", {"_limit": 100})
    named    = _rest_get("/api/atcfw/v1/named_lists", {"_limit": 100})
    roaming  = _rest_get("/api/atcep/v1/roaming_devices", {"_limit": 200})
    anycast  = _rest_get("/api/anycast/v1/accm/ac_runtime_statuses", {"_limit": 100})
    dfp      = _rest_get("/api/atcdfp/v1/dfp_services", {"_limit": 100})
    hosts    = _rest_get("/api/infra/v1/detail_hosts", {"_limit": 200})

    threat_feeds = [{
        "name": f.get("name", ""),
        "source": f.get("source", ""),
        "threat_level": f.get("threat_level", ""),
        "confidence": f.get("confidence_level", ""),
        "severity": _hub_sev_rank(f.get("threat_level", "")),
    } for f in feeds]

    named_lists = [{
        "name": n.get("name", ""),
        "type": n.get("type", ""),
        "items": n.get("item_count", 0),
        "threat_level": n.get("threat_level", ""),
        "policies": len(n.get("policies", []) or []),
        "severity": _hub_sev_rank(n.get("threat_level", "")),
    } for n in named]

    security_policies = [{
        "name": p.get("name", ""),
        "default_action": p.get("default_action", ""),
        "dfps": len(p.get("dfps", []) or []),
        "rules": len(p.get("rules", []) or []),
        "doh": bool(p.get("doh_enabled")),
    } for p in policies]

    status_counts = Counter(
        str(d.get("display_status", d.get("calculated_status", "unknown"))).lower()
        for d in roaming
    )
    countries = Counter(d.get("country_name", "—") for d in roaming if d.get("country_name"))
    roaming_endpoints = {
        "total": len(roaming),
        "by_status": dict(status_counts),
        "top_countries": countries.most_common(5),
    }

    anycast_ha = []
    for a in anycast:
        rt = a.get("runtime_status", {}) or {}
        state = str(rt.get("state", rt) if isinstance(rt, dict) else rt).lower()
        anycast_ha.append({
            "name": a.get("name", ""),
            "service": a.get("service", ""),
            "ip": a.get("anycast_ip_address", ""),
            "state": state or "unknown",
            "severity": "ok" if "up" in state or "online" in state or "healthy" in state else ("warn" if state and state != "unknown" else "warn"),
        })

    def _dfp_host(d):
        h = d.get("host", "")
        if isinstance(h, list):
            return (h[0].get("name", "") if h and isinstance(h[0], dict) else "")
        return str(h)[:40]

    dfp_services = [{
        "name": d.get("name", ""),
        "mode": d.get("forwarding_policy", d.get("mode", "")),
        "host": _dfp_host(d),
        "resolvers": len(d.get("default_resolvers", []) or []),
    } for d in dfp]

    def _qps_num(h):
        # detail_hosts.qps may be a scalar or an object like {"limit": N, ...}
        q = h.get("qps", 0)
        if isinstance(q, dict):
            for k in ("current", "value", "avg", "limit"):
                if isinstance(q.get(k), (int, float)):
                    return q[k]
            return 0
        return q if isinstance(q, (int, float)) else 0

    host_status = Counter(str(h.get("composite_status", "unknown")).lower() for h in hosts)
    host_inventory = {
        "total": len(hosts),
        "by_status": dict(host_status),
        "hosts": [{
            "name": h.get("display_name", ""),
            "ip": h.get("ip_address", ""),
            "version": h.get("host_version", ""),
            "status": str(h.get("composite_status", "")).lower(),
            "qps": _qps_num(h),
        } for h in hosts[:12]],
    }

    result = {
        "threat_feeds": threat_feeds,
        "named_lists": named_lists,
        "security_policies": security_policies,
        "roaming_endpoints": roaming_endpoints,
        "anycast_ha": anycast_ha,
        "dfp_services": dfp_services,
        "host_inventory": host_inventory,
    }
    _cache_set(ck, result)
    return result

# ── NL query handler ──────────────────────────────────────────────────────────

_AI_SYSTEM = """You are a network analyst for the Bloxsmith dashboard. Call tools to fetch live data, then answer.

RULES:
1. Always call the right tool(s) before answering. Never fabricate data.
2. Your FINAL response must be ONLY this JSON (no other text before or after):
   {"answer": "text with \\n and • bullets", "suggestions": ["q1","q2","q3"]}
3. suggestions must be PLAIN ENGLISH QUESTIONS a human would type — never tool names like get_dns or search_entity.
   GOOD: "show me DNS zones for example.com"
   BAD:  "get_dns" or "search_entity with query=host1"
4. Always include 3-5 suggestions.
5. Ambiguous term? Try multiple search_entity calls, get_subnets, get_dns, get_audit_logs.
6. No data found? Suggest alternatives as plain English questions.
7. For "is X malicious", "lookalikes of my brand", or "what assets", use dossier_lookup / lookalike_domains / asset_insights respectively.

Output the JSON object and nothing else."""

_TOOLS = [
    {"type": "function", "function": {
        "name": "search_entity",
        "description": "Search for any network entity by name, IP address, hostname, or subnet CIDR",
        "parameters": {"type": "object", "required": ["query"],
            "properties": {"query": {"type": "string", "description": "Name, IP, hostname, or subnet to find"}}},
    }},
    {"type": "function", "function": {
        "name": "get_subnets",
        "description": "Get IPAM subnets with utilization. Use address param for a specific subnet.",
        "parameters": {"type": "object",
            "properties": {
                "address": {"type": "string", "description": "Filter by subnet address, e.g. '192.168.100.0'"},
                "cidr":    {"type": "integer", "description": "CIDR prefix length, e.g. 24"},
            }},
    }},
    {"type": "function", "function": {
        "name": "get_hosts",
        "description": "Get infrastructure hosts with status (online/offline/error/degraded)",
        "parameters": {"type": "object",
            "properties": {"status": {"type": "string", "description": "Filter: online, offline, error, or degraded"}}},
    }},
    {"type": "function", "function": {
        "name": "get_dns",
        "description": "Get DNS views and authoritative zones",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "get_dhcp_leases",
        "description": "Get DHCP leases. Optionally filter by subnet address.",
        "parameters": {"type": "object",
            "properties": {"subnet": {"type": "string", "description": "Subnet prefix to filter, e.g. '192.168.100'"}}},
    }},
    {"type": "function", "function": {
        "name": "get_threat_feeds",
        "description": "Get security threat feed names and entry counts",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "get_audit_logs",
        "description": "Get recent audit log events",
        "parameters": {"type": "object",
            "properties": {"limit": {"type": "integer", "description": "Number of log entries, default 20"}}},
    }},
    {"type": "function", "function": {
        "name": "get_dns_analytics",
        "description": "Get top DNS clients by query count over a time range",
        "parameters": {"type": "object",
            "properties": {
                "days":  {"type": "integer", "description": "Time range in days, default 7"},
                "limit": {"type": "integer", "description": "Number of top clients, default 10"},
            }},
    }},
    {"type": "function", "function": {
        "name": "dossier_lookup",
        "description": "Threat-intel Dossier lookup for one indicator (domain or IP): returns maliciousness verdict, threat level, geo, whois, actor.",
        "parameters": {"type": "object", "required": ["indicator"],
            "properties": {"indicator": {"type": "string", "description": "A domain or IP address to look up, e.g. 'eicar.co' or '1.2.3.4'"}}},
    }},
    {"type": "function", "function": {
        "name": "lookalike_domains",
        "description": "List detected lookalike/typosquat domains targeting the protected brand.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "asset_insights",
        "description": "Security-action asset inventory (devices seen in security actions in the last 30 days).",
        "parameters": {"type": "object", "properties": {}},
    }},
]

_MAX_TOOL_CHARS = 3000  # cap tool results to stay under TPM limits

async def _run_tool(name: str, args: dict) -> str:
    """Execute one tool call against MCP — opens its own session to avoid anyio/httpx conflicts."""
    print(f"  [AI tool] {name}({args})", flush=True)
    try:
        # REST-based threat-intel/asset tools need no MCP session. Run their sync
        # fetchers in a worker thread — they call asyncio.run() internally, which
        # can't nest inside this already-running event loop.
        if name in ("dossier_lookup", "lookalike_domains", "asset_insights"):
            loop = asyncio.get_running_loop()
            if name == "dossier_lookup":
                d = await loop.run_in_executor(None, fetch_dossier, str(args.get("indicator", "")))
                return json.dumps({"query": d.get("query"), "type": d.get("type"),
                                   "summary": d.get("summary"), "unavailable": d.get("unavailable")}, default=str)
            if name == "lookalike_domains":
                d = await loop.run_in_executor(None, fetch_lookalikes)
                return json.dumps({"domains": d.get("domains", [])[:50], "targets": d.get("targets", [])[:50],
                                   "unavailable": d.get("unavailable")}, default=str)
            if name == "asset_insights":
                d = await loop.run_in_executor(None, fetch_assets)
                return json.dumps({"assets": d.get("assets", [])[:50], "unavailable": d.get("unavailable")}, default=str)

        async with _mcp_session() as session:

            if name == "search_entity":
                hits = await _mcp_search(session, args.get("query", ""))
                return json.dumps(hits[:10], default=str) if hits else "No entities found."

            if name == "get_subnets":
                params = {"_fields": "name,address,cidr,utilization"}
                if args.get("address"):
                    addr = str(args["address"])
                    # constrain to an IP/CIDR-ish filter before forwarding upstream
                    if re.fullmatch(r'[0-9a-fA-F:.]{1,45}(/\d{1,3})?', addr):
                        params["address"] = addr
                if args.get("cidr") is not None:
                    try:
                        _c = int(args["cidr"])
                        if 0 <= _c <= 128:
                            params["cidr"] = str(_c)
                    except (TypeError, ValueError):
                        pass
                raw = await _mcp_get(session, "Ipamsvc", "/ipam/subnet", params,
                                     fetch_all=not args.get("address"))
                data = norm_subnets(_results(raw))
                return json.dumps(data[:100], default=str) if data else "No subnet data."

            if name == "get_hosts":
                raw = await _mcp_get(session, "Infrastructure", "/detail_hosts",
                                     {"_fields": "display_name,ip_address,composite_status,host_type"},
                                     fetch_all=True)
                data = norm_hosts(_results(raw))
                if args.get("status"):
                    data = [h for h in data if h["status"] == args["status"]]
                return json.dumps(data[:100], default=str) if data else "No host data."

            if name == "get_dns":
                views_d = await _mcp_get(session, "DnsConfig", "/dns/view",
                                         {"_fields": "id,name,comment"}, fetch_all=True)
                zones_d = await _mcp_get(session, "DnsConfig", "/dns/auth_zone",
                                         {"_fields": "fqdn,view,zone_authority"}, fetch_all=True)
                vm = {v.get("id", ""): v.get("name", "") for v in _results(views_d)}
                return json.dumps({
                    "views": norm_views(_results(views_d)),
                    "zones": norm_zones(_results(zones_d), vm)[:200],
                }, default=str)

            if name == "get_dhcp_leases":
                raw = await _mcp_get(session, "DhcpLeases", "/dhcp/lease",
                                     {"_fields": "address,hostname,state"}, fetch_all=True)
                data = norm_leases(_results(raw))
                if args.get("subnet"):
                    data = [l for l in data if l.get("addr", "").startswith(args["subnet"])]
                return json.dumps(data[:200], default=str) if data else "No lease data."

            if name == "get_threat_feeds":
                raw = await _mcp_get(session, "Atcfw", "/named_lists",
                                     {"_fields": "name,threat_level,item_count"}, fetch_all=True)
                data = norm_feeds(_results(raw))
                return json.dumps(data, default=str) if data else "No threat feed data."

            if name == "get_audit_logs":
                limit = int(args.get("limit", 20))
                raw = await _mcp_get(session, "AuditLog", "/logs",
                                     {"_limit": limit, "_order_by": "created_at desc"})
                data = norm_audit(_results(raw))
                return json.dumps(data, default=str) if data else "No audit log data."

            if name == "get_dns_analytics":
                cube = await _mcp_query_cube(
                    session, "NstarDnsActivity",
                    measures=["NstarDnsActivity.total_query_count"],
                    dimensions=["NstarDnsActivity.device_name", "NstarDnsActivity.device_ip"],
                    time_dims=[{"dimension": "NstarDnsActivity.timestamp",
                                "dateRange": f"{int(args.get('days', 7))} days"}],
                    order={"NstarDnsActivity.total_query_count": "desc"},
                    limit=int(args.get("limit", 10)),
                )
                rows = _results(cube)
                return json.dumps(rows, default=str) if rows else "No DNS analytics data."

            return f"Unknown tool: {name}"
    except Exception as e:
        return f"Tool error: {e}"

async def _handle_query_async(question: str, trace: list, context: str = "") -> str:
    if not LLM_API_KEY:
        return "AI query requires LLM_API_KEY (or GROQ_API_KEY) in .env — add it and restart the server."

    context = (context or "")[:8000]
    user_msg = (context.strip() + "\n\n" + question) if context.strip() else question
    messages = [
        {"role": "system", "content": _AI_SYSTEM},
        {"role": "user",   "content": user_msg},
    ]
    last = None
    try:
        _client_kwargs = {"api_key": LLM_API_KEY}
        if LLM_BASE_URL:
            _client_kwargs["base_url"] = LLM_BASE_URL
        async with _groq.AsyncGroq(**_client_kwargs) as client:
            for i in range(6):
                resp = await client.chat.completions.create(
                    model=LLM_MODEL,
                    max_tokens=1024,
                    messages=messages,
                    tools=_TOOLS,
                    tool_choice="auto",
                )
                last = resp.choices[0]
                if last.finish_reason != "tool_calls":
                    return last.message.content or '{"answer": "No content.", "suggestions": []}'
                messages.append(last.message)
                for tc in last.message.tool_calls:
                    args = json.loads(tc.function.arguments or "{}")
                    # record the tool call for the client-side trace (transparency)
                    trace.append({"tool": tc.function.name,
                                  "args": {k: str(v)[:80] for k, v in (args or {}).items()}})
                    result = await _run_tool(tc.function.name, args)
                    result = result[:_MAX_TOOL_CHARS] + ("…[truncated]" if len(result) > _MAX_TOOL_CHARS else "")
                    messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
    except Exception as e:
        _log_exc("_generate_ai_answer", e)
        return '{"answer": "AI error: request failed", "suggestions": ["try again in a moment", "show network summary", "show offline hosts", "list threat feeds", "show audit logs"]}'

    return last.message.content if last else '{"answer": "No response.", "suggestions": []}'

_TOOL_NAMES = frozenset(t["function"]["name"] for t in _TOOLS)

def _clean_suggestions(sugs: list) -> list:
    out = []
    for s in sugs:
        s = s.strip()
        if not s:
            continue
        # reject bare tool names or "tool_name with ..." patterns
        first_word = s.split()[0].rstrip("?").lower() if s.split() else ""
        if first_word in _TOOL_NAMES or s.lower().startswith(tuple(n + " " for n in _TOOL_NAMES)):
            continue
        out.append(s)
    return out[:5]

def _parse_ai_response(raw: str) -> dict:
    raw = raw.strip()
    # Strip Qwen3 <think>...</think> reasoning blocks
    raw = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL).strip()
    # Strip markdown code fences
    if raw.startswith("```"):
        raw = re.sub(r'^```[a-z]*\n?', '', raw).rstrip('`').strip()
    # Attempt 1: direct parse
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict) and "answer" in obj:
            sugs = _clean_suggestions([s for s in obj.get("suggestions", []) if isinstance(s, str)])
            return {"answer": str(obj["answer"]), "suggestions": sugs}
    except (json.JSONDecodeError, ValueError):
        pass
    # Attempt 2: scan for last valid JSON object using raw_decode (handles arrays/nesting)
    decoder = json.JSONDecoder()
    last_obj = None
    idx = 0
    while idx < len(raw):
        pos = raw.find('{', idx)
        if pos == -1:
            break
        try:
            obj, _ = decoder.raw_decode(raw, pos)
            if isinstance(obj, dict) and "answer" in obj:
                last_obj = obj
        except (json.JSONDecodeError, ValueError):
            pass
        idx = pos + 1
    if last_obj:
        sugs = _clean_suggestions([s for s in last_obj.get("suggestions", []) if isinstance(s, str)])
        return {"answer": str(last_obj["answer"]), "suggestions": sugs}
    return {"answer": raw, "suggestions": []}

def handle_query(question: str, context: str = "") -> dict:
    trace: list = []
    raw = _run_async(_handle_query_async(question, trace, context))
    out = _parse_ai_response(raw)
    if trace:
        out["trace"] = trace  # ordered list of {tool, args} the LLM invoked
    return out

# ── IQ Actions handler ────────────────────────────────────────────────────────

async def _fetch_actions_async() -> dict:
    async with _mcp_session() as session:
        result = await session.call_tool(
            "iq-actions_list_actions",
            {"limit": 50, "sort_field": "last_activity", "sort_order": "desc", "format": "json"},
        )
        try:
            return json.loads(_tool_text(result))
        except json.JSONDecodeError:
            return {"actions": [], "_raw": _tool_text(result)[:200]}

def fetch_actions() -> dict:
    """IQ Actions (SOC incidents). Never raises/500s — the upstream
    iq-actions_list_actions tool can error server-side; degrade gracefully so
    the widget (and SOURCES['incidents']) shows 'unavailable' instead of failing."""
    try:
        data = _run_async(_fetch_actions_async())
    except Exception as e:
        _log_exc("fetch_actions", e)
        return {"actions": [], "unavailable": "IQ Actions service unavailable (upstream error)."}
    if not isinstance(data, dict):
        return {"actions": [], "unavailable": "IQ Actions returned unexpected data."}
    if "actions" not in data or data.get("actions") is None:
        data["actions"] = []
    if not data["actions"] and "unavailable" not in data:
        data["unavailable"] = "No IQ Actions (SOC incidents) for this tenant."
    return data

# ── SOC Insights handler ──────────────────────────────────────────────────────

async def _fetch_insights_async() -> dict:
    # SOC Insights == "security actions" (SecurityActionSummaryView). The cube is
    # already scoped to visible=true rows created in the last 30 days. On this
    # cube totalEvents/totalVerifiedAssets/timeSaved are DIMENSIONS (per-row
    # numbers), not measures — the only numeric measures are count/totalAssets/
    # totalManualTime/totalAgentTime/totalTimeSaved. Using a dimension as a
    # measure 400s, so we group by the per-insight fields and aggregate with count.
    async with _mcp_session() as session:
        return await _mcp_query_cube(
            session, "SecurityActionSummaryView",
            measures=[
                "SecurityActionSummaryView.count",
                "SecurityActionSummaryView.totalTimeSaved",
            ],
            dimensions=[
                "SecurityActionSummaryView.name",
                "SecurityActionSummaryView.severity",
                "SecurityActionSummaryView.currentStatus",
                "SecurityActionSummaryView.totalEvents",
                "SecurityActionSummaryView.totalVerifiedAssets",
                "SecurityActionSummaryView.timeSaved",
            ],
            order={"SecurityActionSummaryView.count": "desc"},
            limit=20,
        )

def fetch_insights() -> dict:
    """Return {"data":[...]} of SOC insights, or degrade to
    {"data":[],"unavailable":...} — never raise/500 and never fabricate."""
    ck = _cache_key("insights", "", None, False)
    cached = _cache_get(ck)
    if cached is not None:
        return cached
    try:
        raw = _run_async(_fetch_insights_async())
    except Exception as e:
        _log_exc("fetch_insights", e)
        raw = {}
    rows = raw.get("data", []) if isinstance(raw, dict) else []
    if rows:
        result = {"data": rows}
    else:
        result = {"data": [], "unavailable":
                  "No SOC Insights (security actions) in the last 30 days for this tenant."}
    _cache_set(ck, result)
    return result

# ── DNS Analytics handler ─────────────────────────────────────────────────────

async def _fetch_dns_analytics_async() -> dict:
    async with _mcp_session() as session:
        vol_d, clients_d, types_d = await asyncio.gather(
            _mcp_query_cube(session, "NstarDnsActivity",
                measures=["NstarDnsActivity.total_query_count"],
                time_dims=[{"dimension": "NstarDnsActivity.timestamp",
                            "dateRange": "7 days", "granularity": "day"}]),
            _mcp_query_cube(session, "NstarDnsActivity",
                measures=["NstarDnsActivity.total_query_count"],
                dimensions=["NstarDnsActivity.device_name", "NstarDnsActivity.device_ip"],
                time_dims=[{"dimension": "NstarDnsActivity.timestamp", "dateRange": "7 days"}],
                order={"NstarDnsActivity.total_query_count": "desc"}, limit=50),
            _mcp_query_cube(session, "NstarDnsActivity",
                measures=["NstarDnsActivity.total_query_count"],
                dimensions=["NstarDnsActivity.query_type"],
                time_dims=[{"dimension": "NstarDnsActivity.timestamp", "dateRange": "7 days"}],
                order={"NstarDnsActivity.total_query_count": "desc"}, limit=10),
        )
        return {
            "volume":      _results(vol_d),
            "top_clients": _results(clients_d),
            "query_types": _results(types_d),
        }

def fetch_dns_analytics() -> dict:
    return _run_async(_fetch_dns_analytics_async())

# ── Host Metrics handler ──────────────────────────────────────────────────────

async def _fetch_host_metrics_async() -> dict:
    async with _mcp_session() as session:
        data = await _mcp_query_cube(
            session, "HostMetrics",
            measures=["HostMetrics.avg_value"],
            dimensions=["HostMetrics.host_name", "HostMetrics.metric_name"],
            time_dims=[{"dimension": "HostMetrics.timestamp", "dateRange": "1 hours"}],
            order={"HostMetrics.avg_value": "desc"},
            limit=100,
        )
        return {"metrics": _results(data)}

def fetch_host_metrics() -> dict:
    return _run_async(_fetch_host_metrics_async())

# ── Asset Inventory handler (SecurityActionAssets cube) ───────────────────────
# No dedicated asset-inventory cube exists in this deployment (the 19 cubes are
# DNS/DHCP/security-action/token only), so we use SecurityActionAssets — the
# per-asset detail cube for security actions (30-day, visible=true scope).

def _flatten_cube_row(r: dict) -> dict:
    """Strip the 'Cube.' prefix from a cube row's keys: 'Cube.field' → 'field'."""
    return {(k.split(".", 1)[1] if "." in k else k): v for k, v in r.items()}

def norm_assets(rows: list) -> list:
    out = []
    for raw in rows:
        r = _flatten_cube_row(raw)
        out.append({
            "device":    r.get("deviceName", "") or "",
            "os":        r.get("os", "") or "",
            "ip":        r.get("ipAddresses", "") or "",
            "mac":       r.get("macAddresses", "") or "",
            "vendor":    r.get("vendor", "") or "",
            "region":    r.get("region", "") or "",
            "risky":     r.get("isRisky"),
            "verified":  r.get("isVerified"),
            "last_seen": r.get("lastDetected", "") or "",
            "count":     r.get("count"),
        })
    return out

async def _fetch_assets_async() -> dict:
    async with _mcp_session() as session:
        inv_d, rollup_d, trend_d = await asyncio.gather(
            _mcp_query_cube(session, "SecurityActionAssets",
                measures=["SecurityActionAssets.count"],
                dimensions=["SecurityActionAssets.deviceName", "SecurityActionAssets.os",
                            "SecurityActionAssets.ipAddresses", "SecurityActionAssets.macAddresses",
                            "SecurityActionAssets.vendor", "SecurityActionAssets.region",
                            "SecurityActionAssets.isRisky", "SecurityActionAssets.isVerified",
                            "SecurityActionAssets.lastDetected"],
                order={"SecurityActionAssets.count": "desc"}, limit=500),
            _mcp_query_cube(session, "SecurityActionAssets",
                measures=["SecurityActionAssets.uniqueDevices", "SecurityActionAssets.count"],
                dimensions=["SecurityActionAssets.os", "SecurityActionAssets.isVerified"],
                order={"SecurityActionAssets.count": "desc"}, limit=50),
            _mcp_query_cube(session, "SecurityActionAssets",
                measures=["SecurityActionAssets.count"],
                time_dims=[{"dimension": "SecurityActionAssets.createdAt",
                            "dateRange": "30 days", "granularity": "day"}]),
        )
        return {"inventory": inv_d, "rollup": rollup_d, "trend": trend_d}

def fetch_assets() -> dict:
    """Asset inventory + rollup + discovery trend, or degrade to
    {"assets":[],...,"unavailable":...}. Never raises/500, never fabricates."""
    ck = _cache_key("assets", "", None, False)
    cached = _cache_get(ck)
    if cached is not None:
        return cached
    try:
        raw = _run_async(_fetch_assets_async())
    except Exception as e:
        _log_exc("fetch_assets", e)
        raw = {}
    assets = norm_assets(_results(raw.get("inventory", {}))) if isinstance(raw, dict) else []
    rollup = [_flatten_cube_row(r) for r in _results(raw.get("rollup", {}))] if isinstance(raw, dict) else []
    trend  = [_flatten_cube_row(r) for r in _results(raw.get("trend", {}))] if isinstance(raw, dict) else []
    if assets or rollup or trend:
        result = {"assets": assets, "rollup": rollup, "trend": trend, "unavailable": None}
    else:
        result = {"assets": [], "rollup": [], "trend": [], "unavailable":
                  "No security-action assets in the last 30 days for this tenant."}
    _cache_set(ck, result)
    return result

# ── Dossier handler (TIDE threat-intel indicator lookup, direct REST) ─────────

def _infer_indicator_type(q: str) -> str:
    return "ip" if _IP_RE.match(q or "") else "host"

def norm_dossier(query: str, itype: str, results: list) -> dict:
    """Flatten a Dossier /results payload (list of {params:{source},data:{...}})
    into {query,type,summary,sources:[...]}. Per source we keep a compact,
    size-bounded detail plus roll up cross-source threat signals."""
    sources = []
    summary = {"malicious": False, "max_threat_level": 0, "threat_classes": [],
               "properties": [], "country": "", "registrar": "", "actor": ""}
    for r in results:
        if not isinstance(r, dict):
            continue
        src = (r.get("params") or {}).get("source", "")
        data = r.get("data")
        if not data or not isinstance(data, dict):
            continue
        entry = {"source": src}
        # RPZ / threat feed records carry class + property + threat_level
        recs = data.get("records")
        if isinstance(recs, list) and recs:
            entry["records"] = [{"class": x.get("class"), "property": x.get("property"),
                                 "threat_level": x.get("threat_level"),
                                 "feed": x.get("feed_name"), "detected": x.get("detected")}
                                for x in recs[:10] if isinstance(x, dict)]
            for x in recs:
                if not isinstance(x, dict):
                    continue
                if x.get("class"):    summary["threat_classes"].append(x["class"])
                if x.get("property"): summary["properties"].append(x["property"])
                tl = x.get("threat_level")
                if isinstance(tl, (int, float)):
                    summary["max_threat_level"] = max(summary["max_threat_level"], tl)
                    summary["malicious"] = True
        if src == "geo":
            entry["geo"] = {k: data.get(k) for k in
                            ("country", "country_name", "city", "region", "asn", "org")
                            if data.get(k)}
            summary["country"] = (data.get("country_name") or data.get("country")
                                  or summary["country"])
        if src == "whois":
            resp = data.get("response", data)
            entry["whois"] = str(resp)[:600]
            if isinstance(resp, dict):
                summary["registrar"] = str(resp.get("registrar", "") or summary["registrar"])[:120]
        if src in ("threat_actor",) and data.get("actor_name"):
            entry["actor"] = {"name": data.get("actor_name"), "display": data.get("display_name"),
                              "description": str(data.get("actor_description", ""))[:300]}
            summary["actor"] = data.get("actor_name") or summary["actor"]
        if "malware" in src:
            attrs = (data.get("data") or {}).get("attributes") if isinstance(data.get("data"), dict) else None
            if isinstance(attrs, dict):
                entry["malware"] = {"reputation": attrs.get("reputation"),
                                    "last_analysis_stats": attrs.get("last_analysis_stats"),
                                    "categories": attrs.get("categories")}
                stats = attrs.get("last_analysis_stats") or {}
                if isinstance(stats, dict) and stats.get("malicious"):
                    summary["malicious"] = True
        # Fallback: keep a bounded raw slice so no source is silently dropped.
        if len(entry) == 1:
            entry["detail"] = json.dumps(data, default=str)[:400]
        sources.append(entry)
    summary["threat_classes"] = sorted(set(summary["threat_classes"]))[:15]
    summary["properties"] = sorted(set(summary["properties"]))[:15]
    return {"query": query, "type": itype, "summary": summary, "sources": sources,
            "unavailable": None}

def fetch_dossier(q: str, itype: str = "") -> dict:
    """TIDE Dossier lookup for one indicator. Two REST calls: create the lookup
    job (wait=true blocks until done), then read /jobs/{id}/results. Validates q
    is a plausible FQDN/IP before forwarding. 403 → 'not entitled' degrade."""
    q = (q or "").strip().lower()
    if not q:
        return {"query": "", "type": "", "summary": {}, "sources": [],
                "unavailable": "query required"}
    itype = (itype or "").strip().lower()
    if itype not in ("host", "ip", "url"):
        itype = _infer_indicator_type(q)
    # Validate before forwarding (blocks junk / injection into the REST path).
    if itype == "ip":
        if not _IP_RE.match(q):
            return {"query": q, "type": itype, "summary": {}, "sources": [],
                    "unavailable": "invalid IP indicator"}
    else:
        if not _FQDN_RE.match(q):
            return {"query": q, "type": itype, "summary": {}, "sources": [],
                    "unavailable": "invalid domain indicator"}
    ck = _cache_key("dossier", itype, {"q": q}, False)
    cached = _cache_get(ck)
    if cached is not None:
        return cached
    job, st = _rest_get_ex(f"/tide/api/services/intel/lookup/indicator/{itype}",
                           {"value": q, "wait": "true"})
    if st == 403:
        result = {"query": q, "type": itype, "summary": {}, "sources": [],
                  "unavailable": "Dossier not entitled"}
        _cache_set(ck, result)
        return result
    job_id = job.get("job_id") if isinstance(job, dict) else None
    if not job_id:
        return {"query": q, "type": itype, "summary": {}, "sources": [],
                "unavailable": "Dossier lookup failed"}
    res, _ = _rest_get_ex(f"/tide/api/services/intel/lookup/jobs/{job_id}/results")
    results = res.get("results", []) if isinstance(res, dict) else []
    result = norm_dossier(q, itype, results if isinstance(results, list) else [])
    _cache_set(ck, result)
    return result

# ── Lookalike Domains handler (TDLAD, direct REST) ────────────────────────────

def norm_lookalikes(domains_raw, targets_raw) -> dict:
    dom_list = domains_raw.get("results", []) if isinstance(domains_raw, dict) else (domains_raw or [])
    domains = [{
        "lookalike":   d.get("lookalike_domain", ""),
        "host":        d.get("lookalike_host", ""),
        "target":      d.get("target_domain", ""),
        "reason":      d.get("reason", ""),
        "suspicious":  bool(d.get("suspicious")),
        "detected_at": d.get("detected_at", ""),
    } for d in dom_list if isinstance(d, dict)]
    # lookalike_targets.results is an OBJECT {description,item_count,items:[...str]}
    targets = []
    if isinstance(targets_raw, dict):
        res = targets_raw.get("results", {})
        if isinstance(res, dict):
            targets = [t for t in (res.get("items") or []) if isinstance(t, str)]
        elif isinstance(res, list):
            targets = [t.get("domain", t) if isinstance(t, dict) else t for t in res]
    return {"domains": domains, "targets": targets, "unavailable": None}

def fetch_lookalikes() -> dict:
    """Lookalike (typosquat) domains + protected target list, via TDLAD REST.
    Degrades to unavailable on 403/error; never raises/500."""
    ck = _cache_key("lookalikes", "", None, False)
    cached = _cache_get(ck)
    if cached is not None:
        return cached
    dom, st1 = _rest_get_ex("/api/tdlad/v1/lookalike_domains", {"_limit": 500})
    tgt, st2 = _rest_get_ex("/api/tdlad/v1/lookalike_targets")
    if st1 == 403 and st2 == 403:
        result = {"domains": [], "targets": [], "unavailable": "Lookalike Domains not entitled"}
    elif dom is None and tgt is None:
        result = {"domains": [], "targets": [], "unavailable": "Lookalike Domains service unavailable"}
    else:
        result = norm_lookalikes(dom, tgt)
    _cache_set(ck, result)
    return result

# ── Threat Lookup handler ─────────────────────────────────────────────────────

async def _threat_lookup_async(query: str) -> dict:
    async with _mcp_session() as session:
        hits = await _mcp_search(session, query)
        return {"entities": hits, "query": query}

def threat_lookup(query: str) -> dict:
    return _run_async(_threat_lookup_async(query))

# ── Block Domain handler ──────────────────────────────────────────────────────

async def _block_domain_async(domain: str) -> dict:
    # Validate the domain against a strict FQDN regex (reject anything else).
    if not _FQDN_RE.match(domain):
        return {"ok": False, "error": "invalid domain"}
    # Require an explicit, allowlisted block list id from config — never fuzzy-match.
    if not BLOCK_LIST_ID:
        return {"ok": False, "error": "block list not configured (set BLOCK_LIST_ID)"}
    if not _TABLE_RE.match(BLOCK_LIST_ID):
        return {"ok": False, "error": "invalid block list id"}
    async with _mcp_session() as session:
        result = await session.call_tool("infoblox-portal_make_patch_request", {
            "task_description": f"Block domain {domain}",
            "service_name": "Atcfw",
            "endpoint": f"/named_lists/{BLOCK_LIST_ID}",
            "body": {"items_described": [{"item": domain, "description": "Blocked via NOC dashboard"}]},
        })
        return {"ok": True, "domain": domain, "list": BLOCK_LIST_ID}

def block_domain(domain: str) -> dict:
    return _run_async(_block_domain_async(domain))

async def _unblock_domain_async(domain: str) -> dict:
    """Rollback of a block: remove the domain item from the configured block list."""
    if not _FQDN_RE.match(domain):
        return {"ok": False, "error": "invalid domain"}
    if not BLOCK_LIST_ID or not _TABLE_RE.match(BLOCK_LIST_ID):
        return {"ok": False, "error": "block list not configured (set BLOCK_LIST_ID)"}
    async with _mcp_session() as session:
        await session.call_tool("infoblox-portal_make_delete_request", {
            "task_description": f"Unblock domain {domain}",
            "service_name": "Atcfw",
            "endpoint": f"/named_lists/{BLOCK_LIST_ID}/items",
            "body": {"items": [domain]},
        })
        return {"ok": True, "domain": domain, "list": BLOCK_LIST_ID}

def unblock_domain(domain: str) -> dict:
    return _run_async(_unblock_domain_async(domain))

# ── curated data-source registry (no-code widget builder) ─────────────────────
# Declarative catalog of chartable sources. Each entry carries typed field
# metadata (dimension / measure / filterable) so the frontend can ask
# "what can I chart?" (/api/sources — meta only) and "give me rows for X"
# (/api/source/<id> — normalized {rows,count,fields}). Only sources verified
# to return live rows are listed. Cubes are excluded (parquet path is broken).

def _fld(name, type_, role):
    return {"name": name, "type": type_, "role": role}

def norm_threat_feeds(raw):
    return [{
        "name":         f.get("name", ""),
        "source":       f.get("source", ""),
        "confidence":   f.get("confidence_level", ""),
        "threat_level": f.get("threat_level", ""),
    } for f in raw]

def norm_named_lists(raw):
    return [{
        "name":         n.get("name", ""),
        "type":         n.get("type", ""),
        "item_count":   n.get("item_count", 0),
        "threat_level": n.get("threat_level", ""),
        "policies":     len(n.get("policies", []) or []),
    } for n in raw]

def norm_dfp(raw):
    def _host(d):
        h = d.get("host", "")
        if isinstance(h, list):
            return (h[0].get("name", "") if h and isinstance(h[0], dict) else "")
        return str(h)[:40]
    return [{
        "name":      d.get("name", ""),
        "mode":      d.get("forwarding_policy", d.get("mode", "")),
        "host":      _host(d),
        "resolvers": len(d.get("default_resolvers", []) or []),
    } for d in raw]

def norm_anycast(raw):
    out = []
    for a in raw:
        rt = a.get("runtime_status", {}) or {}
        state = str(rt.get("state", rt) if isinstance(rt, dict) else rt).lower() or "unknown"
        out.append({
            "name":    a.get("name", ""),
            "service": a.get("service", ""),
            "ip":      a.get("anycast_ip_address", ""),
            "state":   state,
        })
    return out

def norm_roaming(raw):
    return [{
        "name":    d.get("name", ""),
        "status":  str(d.get("display_status") or d.get("calculated_status") or "unknown"),
        "country": d.get("country_name", ""),
        "os":      d.get("os_platform", ""),
        "group":   d.get("group_name", ""),
    } for d in raw]

def norm_records(raw):
    out = []
    for r in raw:
        meta = r.get("nios_metadata") or {}
        rtype = str(meta.get("objType", "")).replace("record_", "").upper() or r.get("type", "")
        out.append({
            "name":     r.get("absolute_name_spec") or r.get("name_in_zone", ""),
            "zone":     r.get("absolute_zone_name", ""),
            "type":     rtype,
            "rdata":    r.get("dns_rdata", ""),
            "disabled": bool(r.get("disabled")),
        })
    return out

def norm_incidents(raw):
    acts = raw.get("actions", []) if isinstance(raw, dict) else (raw or [])
    return [{
        "id":            a.get("id", ""),
        "type":          a.get("type", ""),
        "title":         a.get("title", ""),
        "priority":      a.get("priority", ""),
        "status":        a.get("status", ""),
        "affected":      a.get("affected", ""),
        "last_activity": a.get("last_activity", ""),
    } for a in acts]

SOURCES = {
    # ── REST (direct Infoblox REST via _rest_get; paths lifted from fetchers) ──
    "subnets": {
        "id": "subnets", "label": "IPAM Subnets", "transport": "rest",
        "fetch": lambda p: norm_subnets(_rest_get("/api/ddi/v1/ipam/subnet",
                 {"_fields": "id,name,address,cidr,utilization,tags", "_limit": 5000})),
        "fields": [_fld("id","string","dimension"), _fld("name","string","dimension"),
                   _fld("addr","string","dimension"), _fld("cidr","number","dimension"),
                   _fld("total","number","measure"), _fld("used","number","measure"),
                   _fld("util","number","measure"), _fld("site","string","filterable")],
    },
    "leases": {
        "id": "leases", "label": "DHCP Leases", "transport": "rest",
        "fetch": lambda p: norm_leases(_rest_get("/api/ddi/v1/dhcp/lease",
                 {"_fields": "address,hostname,state,client_id", "_limit": 5000})),
        "fields": [_fld("addr","string","dimension"), _fld("host","string","dimension"),
                   _fld("subnet","string","filterable"), _fld("state","string","filterable")],
    },
    "dns_zones": {
        "id": "dns_zones", "label": "DNS Auth Zones", "transport": "rest",
        "fetch": lambda p: norm_zones(_rest_get("/api/ddi/v1/dns/auth_zone",
                 {"_fields": "id,fqdn,view,zone_authority,primary_type", "_limit": 5000})),
        "fields": [_fld("id","string","dimension"), _fld("fqdn","string","dimension"),
                   _fld("view","string","filterable"), _fld("ttl","number","measure"),
                   _fld("neg_ttl","number","measure"), _fld("records","number","measure")],
    },
    "dns_records": {
        "id": "dns_records", "label": "DNS Records", "transport": "rest",
        "fetch": lambda p: norm_records(_rest_get("/api/ddi/v1/dns/record", {"_limit": 2000})),
        "fields": [_fld("name","string","dimension"), _fld("zone","string","filterable"),
                   _fld("type","string","filterable"), _fld("rdata","string","dimension"),
                   _fld("disabled","string","filterable")],
    },
    "hosts": {
        "id": "hosts", "label": "Infrastructure Hosts", "transport": "rest",
        "fetch": lambda p: norm_hosts(_rest_get("/api/infra/v1/detail_hosts", {"_limit": 500})),
        "fields": [_fld("id","string","dimension"), _fld("name","string","dimension"),
                   _fld("ip","string","dimension"), _fld("type","string","filterable"),
                   _fld("status","string","filterable")],
    },
    "threat_feeds": {
        "id": "threat_feeds", "label": "Threat Feeds", "transport": "rest",
        "fetch": lambda p: norm_threat_feeds(_rest_get("/api/atcfw/v1/threat_feeds", {"_limit": 200})),
        "fields": [_fld("name","string","dimension"), _fld("source","string","filterable"),
                   _fld("confidence","string","filterable"), _fld("threat_level","string","filterable")],
    },
    "named_lists": {
        "id": "named_lists", "label": "Named Lists", "transport": "rest",
        "fetch": lambda p: norm_named_lists(_rest_get("/api/atcfw/v1/named_lists", {"_limit": 200})),
        "fields": [_fld("name","string","dimension"), _fld("type","string","filterable"),
                   _fld("item_count","number","measure"), _fld("threat_level","string","filterable"),
                   _fld("policies","number","measure")],
    },
    "security_policies": {
        "id": "security_policies", "label": "Security Policies", "transport": "rest",
        "fetch": lambda p: norm_policies(_rest_get("/api/atcfw/v1/security_policies", {"_limit": 200})),
        "fields": [_fld("id","string","dimension"), _fld("name","string","dimension"),
                   _fld("action","string","filterable"), _fld("rules","number","measure"),
                   _fld("created","string","dimension"), _fld("active","string","filterable")],
    },
    "dfp": {
        "id": "dfp", "label": "DNS Forwarding Proxies", "transport": "rest",
        "fetch": lambda p: norm_dfp(_rest_get("/api/atcdfp/v1/dfp_services", {"_limit": 200})),
        "fields": [_fld("name","string","dimension"), _fld("mode","string","filterable"),
                   _fld("host","string","dimension"), _fld("resolvers","number","measure")],
    },
    "anycast": {
        "id": "anycast", "label": "Anycast HA Status", "transport": "rest",
        "fetch": lambda p: norm_anycast(_rest_get("/api/anycast/v1/accm/ac_runtime_statuses", {"_limit": 200})),
        "fields": [_fld("name","string","dimension"), _fld("service","string","filterable"),
                   _fld("ip","string","dimension"), _fld("state","string","filterable")],
    },
    "roaming": {
        "id": "roaming", "label": "Roaming Devices", "transport": "rest",
        "fetch": lambda p: norm_roaming(_rest_get("/api/atcep/v1/roaming_devices", {"_limit": 2000})),
        "fields": [_fld("name","string","dimension"), _fld("status","string","filterable"),
                   _fld("country","string","filterable"), _fld("os","string","filterable"),
                   _fld("group","string","filterable")],
    },
    # ── MCP (via iq-actions / network_entity_search) ──────────────────────────
    "incidents": {
        "id": "incidents", "label": "Incidents (SOC Actions)", "transport": "mcp",
        "fetch": lambda p: norm_incidents(fetch_actions()),
        "fields": [_fld("id","string","dimension"), _fld("type","string","filterable"),
                   _fld("title","string","dimension"), _fld("priority","string","filterable"),
                   _fld("status","string","filterable"), _fld("affected","string","filterable"),
                   _fld("last_activity","time","dimension")],
    },
    # Reuses the hub_security REST event fetch (dns_event); grouped with the
    # security/anomaly domain. transport reflects the actual mechanism (rest).
    "anomaly_events": {
        "id": "anomaly_events", "label": "DNS Security Events", "transport": "rest",
        "fetch": lambda p: fetch_hub_security(limit=200).get("events", []),
        "fields": [_fld("event_time","time","dimension"), _fld("qname","string","dimension"),
                   _fld("severity","string","filterable"), _fld("policy_action","string","filterable"),
                   _fld("feed_name","string","filterable"), _fld("threat_indicator","string","dimension"),
                   _fld("device","string","dimension"), _fld("network","string","dimension")],
    },
    "entity_search": {
        "id": "entity_search", "label": "Network Entity Search", "transport": "mcp",
        "requires": ["q"],
        "fetch": lambda p: threat_lookup(p.get("q", "")).get("entities", []) if p.get("q") else [],
        "fields": [_fld("name","string","dimension"), _fld("type","string","filterable")],
    },
}

def sources_meta():
    """Registry META only — no tenant data. Safe to serve while vault is locked."""
    return {"sources": [{
        "id": s["id"], "label": s["label"], "transport": s["transport"],
        "requires": s.get("requires", []), "fields": s["fields"],
    } for s in SOURCES.values()] + [
        # Escape hatch: call any Infoblox REST path directly (untyped rows).
        {"id": "__raw", "label": "Advanced: raw endpoint", "transport": "rest",
         "requires": ["path"], "fields": []},
    ]}

def _row_epoch(val):
    """Best-effort parse of a row time value → epoch seconds, or None if
    unparseable. Handles epoch int/float (s or ms) and common ISO-8601 strings."""
    if val is None or val == "":
        return None
    if isinstance(val, (int, float)):
        v = float(val)
        return v / 1000.0 if v > 1e11 else v  # ms → s heuristic
    s = str(val).strip()
    try:
        v = float(s)
        return v / 1000.0 if v > 1e11 else v
    except (TypeError, ValueError):
        pass
    try:
        from datetime import datetime, timezone
        iso = s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (TypeError, ValueError):
        return None

def source_rows(sid: str, params: dict) -> dict:
    """Resolve a source, fetch via its transport, apply optional equality
    filter(s) on field names + `limit` (default 200). For the two timestamped
    sources (a field with type "time": incidents.last_activity,
    anomaly_events.event_time) an optional t0/t1 epoch-second window filters
    rows honestly; all other sources ignore t0/t1 (point-in-time).
    Returns {rows,count,fields}."""
    if sid == "__raw":
        # Raw REST escape hatch: proxy an arbitrary Infoblox API path through the
        # same auth as every other source. Reject anything that isn't an /api/
        # path (blocks absolute URLs / SSRF to non-API endpoints).
        rest_path = params.get("path", "")
        if not rest_path.startswith("/api/"):
            return {"error": "path must start with /api/", "rows": [], "count": 0, "fields": []}
        rest_params = {k: v for k, v in params.items() if k != "path"}
        rows = _rest_get(rest_path, rest_params or None) or []
        return {"rows": rows, "count": len(rows), "fields": []}
    src = SOURCES.get(sid)
    if not src:
        return {"error": "unknown source", "rows": [], "count": 0, "fields": []}
    try:
        limit = max(1, min(int(params.get("limit", 200)), 5000))
    except (TypeError, ValueError):
        limit = 200
    rows = src["fetch"](params) or []
    field_names = {f["name"] for f in src["fields"]}
    for key, val in params.items():
        if key in field_names:
            rows = [r for r in rows if str(r.get(key, "")) == val]
    # Honest time-window: only the timestamped source (a field of type "time")
    # respects t0/t1. Point-in-time sources ignore the window entirely.
    time_field = next((f["name"] for f in src["fields"] if f.get("type") == "time"), None)
    if time_field and (params.get("t0") or params.get("t1")):
        def _win(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
        t0, t1 = _win(params.get("t0")), _win(params.get("t1"))
        def _keep(r):
            e = _row_epoch(r.get(time_field))
            if e is None:
                return True  # never fabricate exclusion for unparseable stamps
            if t0 is not None and e < t0:
                return False
            if t1 is not None and e > t1:
                return False
            return True
        rows = [r for r in rows if _keep(r)]
    rows = rows[:limit]
    return {"rows": rows, "count": len(rows), "fields": src["fields"]}

# ── HTTP handler ──────────────────────────────────────────────────────────────

def _log_exc(label: str, e: Exception):
    """Log full detail server-side; clients only ever see a generic message."""
    import traceback
    print(f"  [error] {label}: {e}", file=sys.stderr)
    traceback.print_exc()

class Handler(BaseHTTPRequestHandler):
    def _authed(self) -> bool:
        """Constant-time shared-secret check for mutating/AI endpoints."""
        if not DASHBOARD_TOKEN:
            return False
        supplied = self.headers.get("X-Auth-Token", "")
        return hmac.compare_digest(supplied, DASHBOARD_TOKEN)

    def do_OPTIONS(self):
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/logo":
            import urllib.request, urllib.parse
            qs = dict(urllib.parse.parse_qsl(self.path.split("?",1)[1] if "?" in self.path else ""))
            domain = re.sub(r"[^a-zA-Z0-9.\-]", "", qs.get("domain",""))
            # Serve vault logo first (user-uploaded or cached)
            if os.path.exists(LOGO_FILE):
                with open(LOGO_FILE, "rb") as f: data = f.read()
                self.send_response(200); self.send_header("Content-Type","image/png")
                self.send_header("Content-Length", str(len(data))); self.send_header("Cache-Control","public,max-age=3600")
                self.end_headers(); self.wfile.write(data); return
            # No vault logo — try CDN sources for the given domain
            if not domain:
                self.send_response(404); self.end_headers(); return
            tried = [
                f"https://icons.duckduckgo.com/ip3/{domain}.ico",
                f"https://logo.clearbit.com/{domain}",
            ]
            for logo_url in tried:
                try:
                    req = urllib.request.Request(
                        logo_url,
                        headers={"User-Agent":"Mozilla/5.0","Accept":"image/*"})
                    with urllib.request.urlopen(req, timeout=5) as r:
                        data = r.read()
                        ct = r.headers.get("Content-Type","image/png")
                    if len(data) < 50:
                        continue
                    self.send_response(200)
                    self.send_header("Content-Type", ct)
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "public, max-age=86400")
                    self.end_headers(); self.wfile.write(data); return
                except Exception:
                    continue
            self.send_response(404); self.end_headers()
            return
        if path == "/api/brand":
            try:
                with open(BRAND_FILE) as f: self._json(json.load(f))
            except Exception: self._json({})
            return
        if path == "/api/vault/status":
            self._json(vault_status()); return
        if path == "/api/update/check":
            self._json(update_status(force=True)); return
        if path == "/api/update/status":
            with _pull_lock:
                self._json({**dict(_pull_state), "instance_id": _INSTANCE_ID}); return
        if path == "/api/update/rollback-status":
            with _pull_lock:
                self._json({
                    "rolledback": _pull_state["rolledback"],
                    "rollback_from": _pull_state["rollback_from"],
                    "rollback_to": _pull_state["rollback_to"],
                }); return
        if path == "/api/sources":
            # Registry META only (no tenant data) — safe above the vault gate.
            self._json(sources_meta()); return
        if path == "/api/views":
            # View names/timestamps only (no tenant data) — safe above the gate.
            try:
                self._json(views_list())
            except Exception as e:
                _log_exc("/api/views", e); self._json({"error": "internal error"}, 500)
            return
        # In vault mode, no data leaves until a tenant key is unlocked + active.
        if VAULT_MODE and not MCP_HEADERS.get("Authorization") and path.startswith("/api/"):
            self._json({"error": "vault locked", "locked": True}, 503); return
        if path.startswith("/api/") and path not in ("/api/accounts",):
            _maybe_refresh_jwt()
        if path == "/":
            self._file("index.html")
        elif path == "/api/data":
            try:
                self._json(fetch_dashboard_data())
            except Exception as e:
                _log_exc("/api/data", e)
                self._json({"error": "internal error"}, 500)
        elif path == "/api/actions":
            try:
                self._json(fetch_actions())
            except Exception as e:
                _log_exc("/api/actions", e)
                self._json({"error": "internal error"}, 500)
        elif path == "/api/insights":
            try:
                self._json(fetch_insights())
            except Exception as e:
                _log_exc("/api/insights", e)
                self._json({"error": "internal error"}, 500)
        elif path == "/api/dns-analytics":
            try:
                self._json(fetch_dns_analytics())
            except Exception as e:
                _log_exc("/api/dns-analytics", e)
                self._json({"error": "internal error"}, 500)
        elif path == "/api/host-metrics":
            try:
                self._json(fetch_host_metrics())
            except Exception as e:
                _log_exc("/api/host-metrics", e)
                self._json({"error": "internal error"}, 500)
        elif path == "/api/assets":
            try:
                self._json(fetch_assets())
            except Exception as e:
                _log_exc("/api/assets", e)
                self._json({"error": "internal error"}, 500)
        elif path == "/api/dossier":
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            params = {k: v[0] for k, v in parse_qs(qs).items()}
            try:
                self._json(fetch_dossier(params.get("q", ""), params.get("type", "")))
            except Exception as e:
                _log_exc("/api/dossier", e)
                self._json({"error": "internal error"}, 500)
        elif path == "/api/lookalikes":
            try:
                self._json(fetch_lookalikes())
            except Exception as e:
                _log_exc("/api/lookalikes", e)
                self._json({"error": "internal error"}, 500)
        elif path == "/api/hub/health":
            try: self._json(fetch_hub_health())
            except Exception as e: _log_exc("/api/hub/health", e); self._json({"error":"internal error"},500)
        elif path == "/api/hub/security":
            try: self._json(fetch_hub_security())
            except Exception as e: _log_exc("/api/hub/security", e); self._json({"error":"internal error"},500)
        elif path == "/api/hub/domains":
            try: self._json(fetch_hub_domains())
            except Exception as e: _log_exc("/api/hub/domains", e); self._json({"error":"internal error"},500)
        elif path == "/api/threat-lookup":
            q = ""
            if "?" in self.path:
                qs = self.path.split("?", 1)[1]
                for part in qs.split("&"):
                    if part.startswith("q="):
                        from urllib.parse import unquote_plus
                        q = unquote_plus(part[2:])
            try:
                self._json(threat_lookup(q) if q else {"entities": [], "query": ""})
            except Exception as e:
                _log_exc("/api/threat-lookup", e)
                self._json({"error": "internal error"}, 500)
        elif path == "/api/cache-bust":
            cache_invalidate()
            self._json({"ok": True, "message": "Cache cleared"})
        elif path == "/api/accounts":
            try:
                self._json(list_accounts())
            except Exception as e:
                _log_exc("/api/accounts", e)
                # Surface the real CSP reason so the UI can say "no access (403)"
                # instead of an empty list with no explanation.
                status = getattr(e, "code", None)
                msg = f"CSP rejected this key ({status})" if status else "Infoblox CSP unreachable"
                self._json({"accounts": [], "active": "", "error": msg, "status": status}, 200)
        elif path.startswith("/api/views/"):
            from urllib.parse import unquote
            name = unquote(path[len("/api/views/"):].strip("/"))
            try:
                v = view_read(name)
                self._json(v if v is not None else {"error": "not found"}, 200 if v is not None else 404)
            except Exception as e:
                _log_exc("/api/views/get", e); self._json({"error": "internal error"}, 500)
        elif path.startswith("/api/source/"):
            sid = path[len("/api/source/"):].strip("/")
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            params = {k: v[0] for k, v in parse_qs(qs).items()}
            try:
                result = source_rows(sid, params)
                self._json(result, 404 if result.get("error") == "unknown source" else 200)
            except Exception as e:
                _log_exc(f"/api/source/{sid}", e)
                self._json({"error": "internal error"}, 500)
        elif path == "/api/ipam/spaces":
            try:
                spaces = _rest_get("/api/ddi/v1/ipam/ip_space")
                self._json({"spaces": [{"id": s.get("id"), "name": s.get("name")} for s in (spaces or [])]})
            except Exception as e:
                _log_exc("/api/ipam/spaces", e); self._json({"error": "internal error"}, 500)
        elif path == "/api/ipam/blocks":
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qp = {k: v[0] for k, v in parse_qs(qs).items()}
            try:
                rest_params = {}
                filt = []
                if qp.get("space"):
                    filt.append(f'space=="{qp["space"]}"')
                if filt:
                    rest_params["_filter"] = " and ".join(filt)
                if qp.get("tag_key") and qp.get("tag_value"):
                    rest_params["_tfilter"] = f'{qp["tag_key"]}=="{qp["tag_value"]}"'
                blocks = _rest_get("/api/ddi/v1/ipam/address_block", rest_params or None)
                self._json({"blocks": [
                    {"id": b.get("id"), "address": b.get("address"), "cidr": b.get("cidr"),
                     "name": b.get("name"), "tags": b.get("tags")} for b in (blocks or [])
                ]})
            except Exception as e:
                _log_exc("/api/ipam/blocks", e); self._json({"error": "internal error"}, 500)
        elif path == "/api/dns/zones":
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qp = {k: v[0] for k, v in parse_qs(qs).items()}
            try:
                view = qp.get("view", "")
                views = _rest_get("/api/ddi/v1/dns/view")
                zone_params = {"_filter": f'view=="{view}"'} if view else None
                zones = _rest_get("/api/ddi/v1/dns/auth_zone", zone_params)
                self._json({
                    "views": [{"id": v.get("id"), "name": v.get("name")} for v in (views or [])],
                    "zones": [{"id": z.get("id"), "fqdn": z.get("fqdn"), "view": z.get("view")} for z in (zones or [])],
                })
            except Exception as e:
                _log_exc("/api/dns/zones", e); self._json({"error": "internal error"}, 500)
        elif path == "/api/dns/records":
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qp = {k: v[0] for k, v in parse_qs(qs).items()}
            try:
                zone = qp.get("zone", "").strip()
                if not zone:
                    self._json({"error": "zone is required"}, 400)
                else:
                    filt = [f'zone=="{zone}"']
                    if qp.get("type"):
                        filt.append(f'type=="{qp["type"].strip().upper()}"')
                    if qp.get("name"):
                        filt.append(f'name_in_zone=="{qp["name"]}"')
                    records = _rest_get("/api/ddi/v1/dns/record", {"_filter": " and ".join(filt)})
                    self._json({"records": [
                        {"id": r.get("id"), "name_in_zone": r.get("name_in_zone"), "type": r.get("type"),
                         "ttl": r.get("ttl"), "dns_rdata": r.get("dns_rdata"), "comment": r.get("comment"),
                         "disabled": r.get("disabled")} for r in (records or [])
                    ]})
            except Exception as e:
                _log_exc("/api/dns/records", e); self._json({"error": "internal error"}, 500)
        elif path == "/api/ipam/addresses":
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qp = {k: v[0] for k, v in parse_qs(qs).items()}
            try:
                subnet = qp.get("subnet", "").strip()
                if not subnet:
                    self._json({"error": "subnet is required"}, 400)
                else:
                    addrs = _rest_get("/api/ddi/v1/ipam/address", {"_filter": f'subnet=="{subnet}"'})
                    self._json({"addresses": [
                        {"id": a.get("id"), "address": a.get("address"), "name": a.get("name"),
                         "comment": a.get("comment"), "state": a.get("state")} for a in (addrs or [])
                    ]})
            except Exception as e:
                _log_exc("/api/ipam/addresses", e); self._json({"error": "internal error"}, 500)
        elif path == "/api/ipam/availability":
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qp = {k: v[0] for k, v in parse_qs(qs).items()}
            try:
                subnet = qp.get("subnet", "").strip()
                if not subnet:
                    self._json({"error": "subnet is required"}, 400)
                else:
                    data, status = _rest_get_ex(f"/api/ddi/v1/ipam/subnet/{subnet}", {"_fields": "id,address,cidr,utilization"})
                    if status != 200 or not isinstance(data, dict):
                        self._json({"error": f"subnet lookup failed (status {status})"}, status or 502)
                    else:
                        s = data.get("result") or data
                        util = s.get("utilization") or {}
                        used = util.get("used")
                        total = util.get("total") or util.get("dhcp_total") or util.get("static_total")
                        free = util.get("free")
                        if free is None and used is not None and total is not None:
                            try: free = int(total) - int(used)
                            except (TypeError, ValueError): free = None
                        pct = util.get("utilization") or util.get("percent") or util.get("pct")
                        self._json({
                            "id": s.get("id"), "address": s.get("address"), "cidr": s.get("cidr"),
                            "utilization": {"used": used, "total": total, "free": free, "pct": pct},
                        })
            except Exception as e:
                _log_exc("/api/ipam/availability", e); self._json({"error": "internal error"}, 500)
        elif path == "/api/ipam/subnets":
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qp = {k: v[0] for k, v in parse_qs(qs).items()}
            try:
                filt = []
                if qp.get("space"):
                    filt.append(f'space=="{qp["space"]}"')
                if qp.get("block"):
                    filt.append(f'parent=="{qp["block"]}"')
                params = {"_filter": " and ".join(filt)} if filt else None
                subnets = _rest_get("/api/ddi/v1/ipam/subnet", params)
                self._json({"subnets": [
                    {"id": s.get("id"), "address": s.get("address"), "cidr": s.get("cidr"),
                     "name": s.get("name"), "utilization": s.get("utilization")} for s in (subnets or [])
                ]})
            except Exception as e:
                _log_exc("/api/ipam/subnets", e); self._json({"error": "internal error"}, 500)
        elif path == "/api/provision/stream":
            # SSE progress stream for the self-service subnet provisioning wizard.
            # ThreadingMixIn gives this connection its own thread, so blocking
            # between flushed events is fine — no async needed.
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qp = {k: v[0] for k, v in parse_qs(qs).items()}
            block = qp.get("block", "").strip()
            cidr = qp.get("cidr", "24").strip() or "24"
            name = qp.get("name", "").strip()
            comment = qp.get("comment", "").strip()
            make_zone = qp.get("make_zone", "0") == "1"
            dry = qp.get("dry", "0") == "1"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self._send_cors_origin()
            self.end_headers()

            def emit(obj):
                try:
                    self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
                    self.wfile.flush()
                except Exception:
                    pass  # client disconnected mid-stream — nothing to recover

            try:
                if not block:
                    emit({"error": "block is required"}); return
                emit({"step": f"Resolving block {block}…"})
                if dry:
                    emit({"step": f"[DRY-RUN] Would create /{cidr} in block {block}"})
                    emit({"done": True, "subnet": {"id": None, "address": None, "cidr": cidr}})
                    return
                body = {}
                if name: body["name"] = name
                if comment: body["comment"] = comment
                # `block` is the FULL-form resource id returned by /api/ipam/blocks
                # (e.g. "ipam/address_block/<uuid>") — do not re-prefix
                # "ipam/address_block/" onto it (that would double-prefix and 404).
                # Normalized to match SiteProvisioner._create_subnet's convention.
                result, status = _rest_write(
                    "POST", f"/api/ddi/v1/{block}/nextavailablesubnet",
                    body=body or None, params={"cidr": int(cidr)})
                emit({"step": "Subnet allocation result", "status": status, "result": result})
                subnet = {}
                if isinstance(result, dict):
                    rows = result.get("results") or ([result["result"]] if result.get("result") else [])
                    if rows:
                        subnet = rows[0] or {}
                if make_zone and subnet.get("address"):
                    emit({"step": "Creating DNS zone…"})
                    fqdn = _cidr_to_reverse_zone(subnet["address"], int(subnet.get("cidr") or cidr))
                    zresult, zstatus = _rest_write("POST", "/api/ddi/v1/dns/auth_zone", body={"fqdn": fqdn})
                    emit({"step": "Zone creation result", "status": zstatus, "result": zresult})
                emit({"done": True, "subnet": {
                    "id": subnet.get("id"), "address": subnet.get("address"), "cidr": subnet.get("cidr")}})
            except Exception as e:
                emit({"error": str(e)})
            return
        elif path == "/api/templates":
            try:
                self._json(list_templates())
            except Exception as e:
                _log_exc("/api/templates", e); self._json({"error": "internal error"}, 500)
        elif path == "/api/provision/site/stream":
            # SSE progress stream for template-driven site provisioning
            # (Phase-1 port of Chris Marrison's UDDI toolkit site provisioner).
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qp = {k: v[0] for k, v in parse_qs(qs).items()}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self._send_cors_origin()
            self.end_headers()

            def emit(obj):
                try:
                    self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
                    self.wfile.flush()
                except Exception:
                    pass  # client disconnected mid-stream — nothing to recover

            try:
                name = qp.get("template", "").strip()
                if not name:
                    emit({"error": "template is required"}); return
                template = load_template(name)
                cfg = template_to_site_config(template, qp)
                emit({"step": f"Provisioning site: {cfg.site}"})
                result = SiteProvisioner(cfg, emit).provision()
                emit({"done": True, "result": result})
            except ProvisionError as e:
                emit({"error": str(e)})
            except Exception as e:
                _log_exc("/api/provision/site/stream", e); emit({"error": str(e)})
            return
        elif path == "/api/provision/seed-demo/stream":
            # SSE batch stream: seeds the regional address-block pool, then
            # provisions all site templates in-process (in-process, not the
            # reference toolkit's subprocess-per-template batch.py model —
            # per-template failures are caught and reported without aborting).
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qp = {k: v[0] for k, v in parse_qs(qs).items()}
            dry = _truthy_dry(qp.get("dry"))
            regions_raw = qp.get("regions", "amer,emea,apac")
            regions = [r.strip().lower() for r in regions_raw.split(",") if r.strip()] or ["amer", "emea", "apac"]
            # optional: override every template's ip_space so seeding targets a real
            # space in this tenant (templates ship with a placeholder space name).
            ip_space_override = qp.get("ip_space", "").strip() or None

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self._send_cors_origin()
            self.end_headers()

            def emit(obj):
                try:
                    self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
                    self.wfile.flush()
                except Exception:
                    pass  # client disconnected mid-stream — nothing to recover

            summary = {"succeeded": [], "failed": [], "skipped": []}
            try:
                emit({"step": "Seeding blocks…"})
                try:
                    block_template = load_template("blocks/regional_address_blocks.yaml")
                    block_cfg = template_to_block_config(block_template, {"dry": "1" if dry else "0", "ip_space": ip_space_override})
                    BlockProvisioner(block_cfg, emit).provision()
                except ProvisionError as exc:
                    emit({"template": "blocks/regional_address_blocks.yaml", "error": str(exc)})

                site_templates = []
                for region in regions:
                    region_dir = os.path.join(TEMPLATES_DIR, region)
                    if os.path.isdir(region_dir):
                        site_templates.extend(sorted(glob.glob(os.path.join(region_dir, "*", "site-*.yaml"))))

                for tpath in site_templates:
                    rel = os.path.relpath(tpath, TEMPLATES_DIR)
                    try:
                        template = load_template(rel)
                        cfg = template_to_site_config(template, {"dry": "1" if dry else "0", "if_not_exists": True, "ip_space": ip_space_override})

                        def _forward(obj, _rel=rel):
                            emit({"step": f"[{_rel}] {obj['step']}"} if "step" in obj else obj)

                        result = SiteProvisioner(cfg, _forward).provision()
                        (summary["skipped"] if result["skipped"] else summary["succeeded"]).append(rel)
                    except Exception as exc:
                        summary["failed"].append(rel)
                        emit({"template": rel, "error": str(exc)})

                emit({"done": True, "summary": summary})
            except Exception as e:
                _log_exc("/api/provision/seed-demo/stream", e); emit({"error": str(e)})
            return
        elif path == "/api/teardown/site/stream":
            # SSE progress stream for tag-driven site decommission (Phase-2
            # port of Chris Marrison's UDDI toolkit site/decommission.py).
            # FAIL-FORWARD: a mid-sequence API error is emitted and stops the
            # stream — there is no rollback for a teardown (see SiteDecommissioner).
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qp = {k: v[0] for k, v in parse_qs(qs).items()}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self._send_cors_origin()
            self.end_headers()

            def emit(obj):
                try:
                    self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
                    self.wfile.flush()
                except Exception:
                    pass  # client disconnected mid-stream — nothing to recover

            try:
                name = qp.get("template", "").strip()
                if not name:
                    emit({"error": "template is required"}); return
                template = load_template(name)
                cfg = template_to_decommission_config(template, qp)
                if not cfg.dry_run and qp.get("confirm", "") != cfg.site:
                    emit({"error": "confirmation required"}); return
                emit({"step": f"Decommissioning site: {cfg.site}"})
                result = SiteDecommissioner(cfg, emit).decommission()
                emit({"done": True, "result": result})
            except ProvisionError as e:
                emit({"error": str(e)})
            except Exception as e:
                _log_exc("/api/teardown/site/stream", e); emit({"error": str(e)})
            return
        elif path == "/api/teardown/seed-demo/stream":
            # SSE batch stream: inverse of /api/provision/seed-demo/stream —
            # decommissions every seeded site template, then the regional
            # address-block pool LAST (mirrors seed's "blocks first" by doing
            # the reverse: blocks last, since sites depend on the pool blocks
            # existing while they're being torn down).
            from urllib.parse import parse_qs
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qp = {k: v[0] for k, v in parse_qs(qs).items()}
            dry = _truthy_dry(qp.get("dry"))
            regions_raw = qp.get("regions", "amer,emea,apac")
            regions = [r.strip().lower() for r in regions_raw.split(",") if r.strip()] or ["amer", "emea", "apac"]
            ip_space_override = qp.get("ip_space", "").strip() or None
            confirm = qp.get("confirm", "")

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self._send_cors_origin()
            self.end_headers()

            def emit(obj):
                try:
                    self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
                    self.wfile.flush()
                except Exception:
                    pass  # client disconnected mid-stream — nothing to recover

            if not dry and confirm != "DELETE":
                emit({"error": "confirmation required"}); return

            summary = {"succeeded": [], "failed": [], "skipped": []}
            try:
                site_templates = []
                for region in regions:
                    region_dir = os.path.join(TEMPLATES_DIR, region)
                    if os.path.isdir(region_dir):
                        site_templates.extend(sorted(glob.glob(os.path.join(region_dir, "*", "site-*.yaml"))))

                for tpath in site_templates:
                    rel = os.path.relpath(tpath, TEMPLATES_DIR)
                    try:
                        template = load_template(rel)
                        cfg = template_to_decommission_config(
                            template, {"dry": "1" if dry else "0", "ip_space": ip_space_override})

                        def _forward(obj, _rel=rel):
                            emit({"step": f"[{_rel}] {obj['step']}"} if "step" in obj else obj)

                        SiteDecommissioner(cfg, _forward).decommission()
                        summary["succeeded"].append(rel)
                    except Exception as exc:
                        summary["failed"].append(rel)
                        emit({"template": rel, "error": str(exc)})

                emit({"step": "Decommissioning regional address-block pool…"})
                try:
                    block_template = load_template("blocks/regional_address_blocks.yaml")
                    block_name = str(block_template.get("name") or "")
                    block_ip_space = ip_space_override or block_template.get("ip_space") or DEFAULT_IP_SPACE
                    BlockDecommissioner(block_name, block_ip_space, dry, emit).decommission()
                except ProvisionError as exc:
                    emit({"template": "blocks/regional_address_blocks.yaml", "error": str(exc)})

                emit({"done": True, "summary": summary})
            except Exception as e:
                _log_exc("/api/teardown/seed-demo/stream", e); emit({"error": str(e)})
            return
        elif path.lstrip("/") in _STATIC_FILES:
            self._file(path.lstrip("/"))  # _file validates realpath before serving
        elif not path.startswith("/api/"):
            self._file("index.html")  # SPA fallback — all non-API routes serve the app
        else:
            self._json({"error": "not found"}, 404)

    MAX_BODY = 64 * 1024  # 64 KB

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (ValueError, TypeError):
            self._json({"error": "invalid Content-Length"}, 400); return
        if length < 0 or length > self.MAX_BODY:
            self.send_error(413, "Request Too Large")
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        except (json.JSONDecodeError, ValueError):
            self._json({"error": "invalid JSON body"}, 400); return
        # vault control endpoints — reachable while locked (that's their purpose)
        if self.path == "/api/brand":
            domain = re.sub(r"[^a-zA-Z0-9.\-]", "", str(body.get("domain", "")))[:253]
            name   = str(body.get("name", ""))[:120]
            try:
                with open(BRAND_FILE, "w") as f: json.dump({"domain": domain, "name": name}, f)
                # Fetch and cache logo server-side so UI can use /api/logo instead of CDN
                if domain:
                    try:
                        from urllib.request import urlopen, Request
                        logo_url = f"https://cdn.brandfetch.io/{domain}/w/128/h/128"
                        req = Request(logo_url, headers={"User-Agent": "Mozilla/5.0"})
                        with urlopen(req, timeout=8) as r:
                            data = r.read()
                        with open(LOGO_FILE, "wb") as f: f.write(data)
                    except Exception: pass  # CDN failure is non-fatal — UI falls back to CDN img tag
                self._json({"ok": True})
            except Exception as e: _log_exc("/api/brand", e); self._json({"ok": False, "error": "internal error"}, 500)
            return
        if self.path == "/api/vault/init":
            self._json(vault_init(str(body.get("passphrase", "")))); return
        if self.path == "/api/vault/unlock":
            r = vault_unlock(str(body.get("passphrase", ""))); self._json(r, 200 if r.get("ok") else 401); return
        if self.path == "/api/vault/tenant":
            r = vault_add_tenant(body.get("label", ""), body.get("key", ""), body.get("groq")); self._json(r, 200 if r.get("ok") else 400); return
        if self.path == "/api/vault/tenant-remove":
            r = vault_remove_tenant(str(body.get("id", ""))); self._json(r, 200 if r.get("ok") else 400); return
        if self.path == "/api/vault/tenant-update":
            r = vault_update_tenant(str(body.get("id", "")), body.get("key", ""), body.get("label")); self._json(r, 200 if r.get("ok") else 400); return
        if self.path == "/api/vault/active":
            r = vault_set_active(str(body.get("id", ""))); self._json(r, 200 if r.get("ok") else 400); return
        if self.path == "/api/vault/groq":
            self._json(vault_set_llm(str(body.get("key", "")))); return
        if self.path == "/api/vault/llm":
            self._json(vault_set_llm(str(body.get("key", "")), body.get("base_url"), body.get("model"))); return
        if self.path == "/api/vault/test-key":
            self._json(vault_test_key(str(body.get("key", "")))); return
        if self.path == "/api/vault/conn-test":
            self._json(vault_conn_test()); return
        if self.path == "/api/vault/llm-test":
            self._json(vault_llm_test(str(body.get("key", "")), body.get("base_url"), body.get("model"))); return
        if self.path == "/api/vault/refresh-names":
            self._json(vault_refresh_names()); return
        if self.path == "/api/vault/lock":
            if not MCP_HEADERS.get("Authorization") and not self._authed():
                self._json({"ok": False, "error": "unauthorized"}, 401); return
            self._json(vault_lock()); return
        if self.path == "/api/vault/reset":
            # Destructive + irreversible: require vault unlocked OR DASHBOARD_TOKEN.
            # Blocks unauthenticated LAN/CSRF callers; preserves logged-in reset and
            # admin recovery via token.
            if not MCP_HEADERS.get("Authorization") and not self._authed():
                self._json({"ok": False, "error": "unauthorized"}, 401); return
            self._json(vault_reset()); return
        if self.path == "/api/update/rollback-clear":
            if not MCP_HEADERS.get("Authorization") and not self._authed():
                self._json({"ok": False, "error": "unauthorized"}, 401); return
            with _pull_lock:
                _pull_state.update(rolledback=False, rollback_from=None, rollback_to=None)
            self._json({"ok": True}); return
        if self.path == "/api/update/apply":
            if not MCP_HEADERS.get("Authorization") and not self._authed():
                self._json({"ok": False, "error": "vault locked", "locked": True}, 401); return
            self._json(apply_self_update()); return
        if VAULT_MODE and not MCP_HEADERS.get("Authorization"):
            self._json({"error": "vault locked", "locked": True}, 503); return
        if self.path != "/api/switch-account":
            _maybe_refresh_jwt()
        if self.path == "/api/query":
            # Read-only + LLM; not state-changing. Cross-origin reads are already
            # blocked by the same-origin CORS allowlist, so no token is required
            # (keeps the AI query box working out of the box).
            try:
                result = handle_query(body.get("question", ""), body.get("context", ""))
                self._json(result)
            except Exception as e:
                _log_exc("/api/query", e)
                self._json({"answer": "Error: internal error", "suggestions": []}, 500)
        elif self.path in ("/api/views", "/api/views/import"):
            # Persist a dashboard view. /api/views/import accepts a complete
            # exported blob; both validate + write the same way. MAX_BODY is
            # already enforced at the top of do_POST.
            try:
                payload, status = view_write(body)
                self._json(payload, status)
            except Exception as e:
                _log_exc("/api/views", e); self._json({"ok": False, "error": "internal error"}, 500)
        elif self.path == "/api/switch-account":
            # Portal-style sandbox switch: target must be an account the key's
            # user already belongs to; no credentials in the request.
            try:
                account_id = str(body.get("id", "")).strip()
                res = switch_account(account_id)
                self._json(res, 200 if res.get("ok") else 400)
            except Exception as e:
                from urllib.error import HTTPError
                _log_exc("/api/switch-account", e)
                if isinstance(e, HTTPError) and e.code == 403:
                    self._json({"ok": False, "error": "Account switching requires an interactive User API key with multi-account access (CSP returned 403)"}, 403)
                elif isinstance(e, HTTPError):
                    self._json({"ok": False, "error": f"CSP error {e.code}"}, 502)
                else:
                    self._json({"ok": False, "error": "internal error"}, 500)
        elif self.path == "/api/block-domain":
            # State-changing write to Infoblox config — require the shared secret.
            if not self._authed():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            try:
                domain = body.get("domain", "").strip()
                if not domain:
                    self._json({"ok": False, "error": "domain required"}, 400)
                else:
                    self._json(block_domain(domain))
            except Exception as e:
                _log_exc("/api/block-domain", e)
                self._json({"ok": False, "error": "internal error"}, 500)
        elif self.path == "/api/unblock-domain":
            # Rollback of a block — also a state-changing write; require the secret.
            if not self._authed():
                self._json({"ok": False, "error": "unauthorized"}, 401)
                return
            try:
                domain = body.get("domain", "").strip()
                if not domain:
                    self._json({"ok": False, "error": "domain required"}, 400)
                else:
                    self._json(unblock_domain(domain))
            except Exception as e:
                _log_exc("/api/unblock-domain", e)
                self._json({"ok": False, "error": "internal error"}, 500)
        elif self.path == "/api/selfservice/allocate":
            # State-changing write, but same precedent as /api/switch-account:
            # gated by the vault-unlocked check above only, no X-Auth-Token.
            try:
                result, status = _selfservice_allocate(body)
                self._json(result, status)
            except Exception as e:
                _log_exc("/api/selfservice/allocate", e)
                self._json({"ok": False, "error": "internal error"}, 500)
        elif self.path == "/api/dns/records":
            # State-changing write, same precedent as /api/selfservice/allocate:
            # gated by the vault-unlocked check above only, no X-Auth-Token.
            try:
                result, status = _dns_record_create(body)
                self._json(result, status)
            except Exception as e:
                _log_exc("/api/dns/records", e)
                self._json({"ok": False, "error": "internal error"}, 500)
        elif self.path == "/api/templates/validate":
            # Pure structural validation — never contacts the Infoblox API.
            try:
                name = str(body.get("name", "")).strip()
                template = load_template(name)
                v = validate_template(template, name)
                self._json({"valid": v["valid"], "type": v["type"], "errors": v["errors"], "warnings": v["warnings"]})
            except ProvisionError as e:
                self._json({"valid": False, "type": "unknown",
                             "errors": [{"field": "template", "message": str(e)}], "warnings": []})
            except Exception as e:
                _log_exc("/api/templates/validate", e); self._json({"error": "internal error"}, 500)
        elif self.path == "/api/provision/block":
            # Address-block provisioning (Phase-1 port of Chris Marrison's
            # UDDI toolkit block provisioner). Not a stream — a single result.
            try:
                name = str(body.get("template", "")).strip()
                if not name:
                    self._json({"error": "template is required"}, 400)
                else:
                    template = load_template(name)
                    params = {"ip_space": body.get("ip_space"), "dry": body.get("dry")}
                    cfg = template_to_block_config(template, params)
                    result = BlockProvisioner(cfg, lambda _obj: None).provision()
                    self._json({"blocks_created": result["blocks_created"]})
            except ProvisionError as e:
                self._json({"error": str(e)}, 400)
            except Exception as e:
                _log_exc("/api/provision/block", e); self._json({"error": "internal error"}, 500)
        elif self.path == "/api/teardown/block":
            # Address-block decommission (Phase-2 port of Chris Marrison's
            # UDDI toolkit block/decommission.py). Not a stream — a single
            # result. Live (non-dry) runs require confirm == template name.
            try:
                name = str(body.get("template", "")).strip()
                if not name:
                    self._json({"error": "template is required"}, 400)
                else:
                    template = load_template(name)
                    ip_space = str(body.get("ip_space") or template.get("ip_space") or DEFAULT_IP_SPACE).strip()
                    dry = _truthy_dry(body.get("dry"))
                    block_name = str(template.get("name") or name).strip()
                    if not dry and str(body.get("confirm", "")) != name:
                        self._json({"error": "confirmation required"}, 400)
                    else:
                        result = BlockDecommissioner(block_name, ip_space, dry, lambda _obj: None).decommission()
                        self._json({"result": result})
            except ProvisionError as e:
                self._json({"error": str(e)}, 400)
            except Exception as e:
                _log_exc("/api/teardown/block", e); self._json({"error": "internal error"}, 500)
        elif self.path == "/api/retag/block":
            # Set a block's Status tag (and clear site-scoping fields when
            # returning it to the pool). Phase-2 port of retag.py. Not gated
            # by the confirm-token safety net below (a Status re-tag doesn't
            # delete anything) — same trust level as /api/provision/block.
            try:
                template_name = str(body.get("template", "")).strip()
                site = str(body.get("site", "")).strip()
                address = str(body.get("address", "")).strip()
                cidr = body.get("cidr")
                status = str(body.get("status") or "available").strip()
                ip_space = str(body.get("ip_space") or DEFAULT_IP_SPACE).strip()
                dry = _truthy_dry(body.get("dry"))
                space_results = _rest_get("/api/ddi/v1/ipam/ip_space", {"_filter": f'name=="{ip_space}"'})
                if not space_results:
                    self._json({"error": f"IP space not found: {ip_space}"}, 400)
                else:
                    space_id = space_results[0]["id"]
                    blocks = _find_blocks_for_retag(space_id, template_name, address, cidr, site)
                    changed = [_retag_block(b, status, dry) for b in blocks]
                    self._json({"status": status, "changed": changed, "dry_run": dry})
            except ProvisionError as e:
                self._json({"error": str(e)}, 400)
            except Exception as e:
                _log_exc("/api/retag/block", e); self._json({"error": "internal error"}, 500)
        elif self.path == "/api/drift/check":
            # Read-only comparison of a site template's expected state against
            # its live API state. Phase-2 port of core.py::detect_drift +
            # site/query.py's live-query. No writes, no dry, no confirm.
            try:
                name = str(body.get("template", "")).strip()
                if not name:
                    self._json({"error": "template is required"}, 400)
                else:
                    template = load_template(name)
                    params = {"ip_space": body.get("ip_space")}
                    cfg = template_to_site_config(template, params)
                    live = query_site_live(cfg)
                    self._json(detect_drift(template, live, cfg.site))
            except ProvisionError as e:
                self._json({"error": str(e)}, 400)
            except Exception as e:
                _log_exc("/api/drift/check", e); self._json({"error": "internal error"}, 500)
        else:
            self._json({"error": "not found"}, 404)

    def do_PATCH(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (ValueError, TypeError):
            self._json({"error": "invalid Content-Length"}, 400); return
        if length < 0 or length > self.MAX_BODY:
            self.send_error(413, "Request Too Large")
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        except (json.JSONDecodeError, ValueError):
            self._json({"error": "invalid JSON body"}, 400); return
        if VAULT_MODE and not MCP_HEADERS.get("Authorization"):
            self._json({"error": "vault locked", "locked": True}, 503); return
        path = self.path.split("?")[0]
        if path == "/api/dns/records":
            # Single-record read-modify-write; explicit id only, no filter-based
            # bulk update. Same trust level as /api/selfservice/allocate.
            try:
                result, status = _dns_record_update(body)
                self._json(result, status)
            except Exception as e:
                _log_exc("/api/dns/records PATCH", e)
                self._json({"ok": False, "error": "internal error"}, 500)
            return
        self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/views/"):
            from urllib.parse import unquote
            name = unquote(path[len("/api/views/"):].strip("/"))
            try:
                ok = view_delete(name)
                self._json({"ok": True} if ok else {"error": "not found"}, 200 if ok else 404)
            except Exception as e:
                _log_exc("/api/views/delete", e); self._json({"error": "internal error"}, 500)
            return
        if VAULT_MODE and not MCP_HEADERS.get("Authorization"):
            self._json({"error": "vault locked", "locked": True}, 503); return
        if path.startswith("/api/dns/records/"):
            # Explicit id only — never delete-by-filter.
            record_id = path[len("/api/dns/records/"):].strip("/")
            if not record_id:
                self._json({"error": "id is required"}, 400); return
            try:
                resp, status = _rest_write("DELETE", f"/api/ddi/v1/dns/record/{record_id}")
                if status in (200, 204, 404):
                    self._json({"ok": True})
                else:
                    self._json({"ok": False, "error": f"delete failed (status {status})", "detail": resp}, status or 502)
            except Exception as e:
                _log_exc("/api/dns/records DELETE", e); self._json({"ok": False, "error": "internal error"}, 500)
            return
        if path.startswith("/api/ipam/addresses/"):
            # Explicit id only — never delete-by-filter.
            addr_id = path[len("/api/ipam/addresses/"):].strip("/")
            if not addr_id:
                self._json({"error": "id is required"}, 400); return
            try:
                resp, status = _rest_write("DELETE", f"/api/ddi/v1/ipam/address/{addr_id}")
                if status in (200, 204, 404):
                    self._json({"ok": True})
                else:
                    self._json({"ok": False, "error": f"delete failed (status {status})", "detail": resp}, status or 502)
            except Exception as e:
                _log_exc("/api/ipam/addresses DELETE", e); self._json({"ok": False, "error": "internal error"}, 500)
            return
        self._json({"error": "not found"}, 404)

    def _send_cors_origin(self):
        # Reflect only an allowlisted same-host origin; never wildcard.
        origin = self.headers.get("Origin", "")
        allowed = {
            f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}",
        }
        if origin in allowed:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _cors(self):
        self.send_response(200)
        self._send_cors_origin()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token")

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._send_cors_origin()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, name):
        fpath = os.path.join(DIR, name)
        # Reject symlinks and paths that escape DIR (path traversal guard)
        if os.path.islink(fpath):
            self.send_error(403)
            return
        real_dir = os.path.realpath(DIR)
        real_path = os.path.realpath(fpath)
        if not real_path.startswith(real_dir + os.sep) and real_path != real_dir:
            self.send_error(403)
            return
        if not os.path.isfile(fpath):  # 404 cleanly for missing files and directories
            self.send_error(404)
            return
        ext  = os.path.splitext(name)[1]
        mime = MIME.get(ext, "application/octet-stream")
        try:
            with open(fpath, "rb") as f:
                body = f.read()
        except OSError as e:
            _log_exc(f"_file({name})", e)
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        # HTML is a single-file app updated on every image build — never let the
        # browser serve a stale copy after an upgrade. Other assets revalidate.
        if ext == ".html":
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} {fmt % args}")

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

# ── entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if HOST not in ("localhost", "127.0.0.1", "::1"):
        print(f"WARNING: HOST={HOST} is not a loopback address — the dashboard "
              "(and the privileged INFOBLOX_API_KEY proxy) is exposed on the network. "
              "Prefer binding to loopback and publishing via -p 127.0.0.1:PORT:PORT.",
              file=sys.stderr)
    if not DASHBOARD_TOKEN:
        print("NOTE: DASHBOARD_TOKEN not set — the write endpoint POST /api/block-domain "
              "is disabled (returns 401). The read/LLM query box works normally.",
              file=sys.stderr)
    if VAULT_MODE:
        print(f"VAULT MODE — no INFOBLOX_API_KEY set. Open the dashboard to set a "
              f"passphrase and add tenant keys (encrypted at rest at {VAULT_FILE}).",
              file=sys.stderr)
        pw = _vault_passphrase_from_env()
        if pw and vault_exists():
            r = vault_unlock(pw)
            print("Vault auto-unlocked from environment." if r.get("ok")
                  else f"  [warn] vault auto-unlock failed: {r.get('error')} — "
                       "falling back to manual unlock in the browser.",
                  file=sys.stderr)
        elif pw:                       # first run, no vault yet → create + unlock it
            r = vault_init(pw)
            print("Vault created and unlocked from environment — add your tenant key in the browser."
                  if r.get("ok")
                  else f"  [warn] vault auto-create failed: {r.get('error')} — "
                       "set it up manually in the browser.",
                  file=sys.stderr)
    server = ThreadedHTTPServer((HOST, PORT), Handler)
    print(f"Bloxsmith → http://{HOST}:{PORT}")
    print(f"MCP: {MCP_URL}")
    print("Ctrl+C to stop\n")
    threading.Thread(target=_warm_loop, daemon=True, name="cache-warmer").start()
    print(f"Cache-warmer started (every {WARM_INTERVAL}s).")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
