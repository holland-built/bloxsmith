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
LLM_API_KEY  = os.environ.get("LLM_API_KEY", GROQ_API_KEY)
LLM_MODEL    = os.environ.get("LLM_MODEL", "qwen/qwen3-32b")
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
                out.append({"name": v.get("name", fn[:-5]), "saved_at": v.get("saved_at")})
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
]

_MAX_TOOL_CHARS = 3000  # cap tool results to stay under TPM limits

async def _run_tool(name: str, args: dict) -> str:
    """Execute one tool call against MCP — opens its own session to avoid anyio/httpx conflicts."""
    print(f"  [AI tool] {name}({args})", flush=True)
    try:
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

    context = (context or "")[:2000]
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
    return _run_async(_fetch_actions_async())

# ── SOC Insights handler ──────────────────────────────────────────────────────

async def _fetch_insights_async() -> dict:
    async with _mcp_session() as session:
        return await _mcp_query_cube(
            session, "InsightsSummaryView",
            measures=[
                "InsightsSummaryView.totalEvents",
                "InsightsSummaryView.totalVerifiedAssets",
                "InsightsSummaryView.timeSaved",
            ],
            dimensions=[
                "InsightsSummaryView.name",
                "InsightsSummaryView.severity",
                "InsightsSummaryView.currentStatus",
            ],
            order={"InsightsSummaryView.totalEvents": "desc"},
            limit=20,
        )

def fetch_insights() -> dict:
    return _run_async(_fetch_insights_async())

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

def source_rows(sid: str, params: dict) -> dict:
    """Resolve a source, fetch via its transport, apply optional equality
    filter(s) on field names + `limit` (default 200). Returns {rows,count,fields}."""
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
        else:
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
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
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
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
