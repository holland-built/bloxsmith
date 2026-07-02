"""
Encrypted vault (multi-tenant key store) — 1:1 logic port of server.py's
vault module (lines ~549-869 as of the noc-dashboard-step2 plan).

Keys are secrets the bridge must *replay* to Infoblox, so they're stored
reversibly — but encrypted at rest (Fernet/AES) under a key derived from a
user passphrase (scrypt). The passphrase is never stored; unlock re-derives
it after each restart. Persist on a mounted volume so it survives updates.

CRITICAL compatibility constraint: the scrypt params, on-disk envelope shape,
and inner payload keys below MUST match server.py byte-for-byte, or an
existing deployed vault.json becomes unrecoverable. Do not "improve" this.

State is shared with other backend modules via `backend.config` — this file
imports the module (`from backend import config`) and writes attributes on
it (`config.API_KEY = ...`), never `from backend.config import API_KEY`,
which would bind an independent copy at import time and break propagation.
"""

import base64
import hashlib
import json
import os
import re
import secrets
import sys
import threading

from cryptography.fernet import Fernet, InvalidToken

from backend import config
from backend.cache import cache_invalidate

DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── encrypted vault (multi-tenant key store) ──────────────────────────────────

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
    t = next((x for x in _vault["tenants"] if x["id"] == _vault["active"]), None)
    config.API_KEY = t["key"] if t else ""
    config.MCP_HEADERS["Authorization"] = config.API_KEY
    config._HOME_ACCOUNT_ID = ""; config._active_account_id = ""   # re-resolve accounts for this key
    if _vault.get("groq"):      config.LLM_API_KEY  = _vault["groq"]
    if _vault.get("llm_base"):  config.LLM_BASE_URL = _vault["llm_base"]
    if _vault.get("llm_model"): config.LLM_MODEL    = _vault["llm_model"]
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
        req = Request(f"{config.BASE_URL}{path}", headers={"Authorization": key})
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
    with _vault_lock:
        _vault.update({"unlocked": False, "tenants": [], "active": None, "groq": "", "_key": None})
        config.API_KEY = ""; config.MCP_HEADERS["Authorization"] = ""
        cache_invalidate()
    return {"ok": True}

def vault_reset():
    """Forgot-passphrase escape hatch: permanently delete the encrypted vault
    (all stored keys are unrecoverable by design) and return to first-run setup."""
    with _vault_lock:
        try:
            if os.path.exists(VAULT_FILE):
                os.remove(VAULT_FILE)
        except Exception:
            pass
        _vault.update({"unlocked": False, "tenants": [], "active": None, "groq": "", "_key": None, "_salt": ""})
        config.API_KEY = ""; config.MCP_HEADERS["Authorization"] = ""
        cache_invalidate()
    return {"ok": True}

def vault_set_llm(key, base_url=None, model=None):
    """Set the (provider-agnostic) LLM config: API key + optional OpenAI-compatible
    base URL + model. Blank base URL = Groq default."""
    with _vault_lock:
        if not _vault["unlocked"]:
            return {"ok": False, "error": "locked"}
        _vault["groq"] = (key or "").strip()
        if base_url is not None: _vault["llm_base"]  = (base_url or "").strip()
        if model is not None:    _vault["llm_model"] = (model or "").strip()
        config.LLM_API_KEY  = _vault["groq"]
        if _vault.get("llm_base"):  config.LLM_BASE_URL = _vault["llm_base"]
        if _vault.get("llm_model"): config.LLM_MODEL    = _vault["llm_model"]
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
        req = Request(f"{config.BASE_URL}/v2/current_user", headers={"Authorization": k})
        with urlopen(req, timeout=12) as r:
            r.read()
        return {"ok": True, "name": ""}   # reachable, but no account name resolved
    except Exception:
        return {"ok": False, "error": "key rejected by Infoblox CSP"}

def vault_conn_test():
    """Verify the ACTIVE connection's key reaches Infoblox CSP (read-only)."""
    if not config.API_KEY:
        return {"ok": False, "error": "no active connection"}
    return vault_test_key(config.API_KEY)

def _log_exc(label, e):
    """Log full detail server-side; clients only ever see a generic message."""
    import traceback
    print(f"  [error] {label}: {e}", file=sys.stderr)
    traceback.print_exc()

def vault_llm_test(key, base_url=None, model=None):
    """Send a tiny completion to verify the LLM provider key/base/model work."""
    import asyncio
    import groq as _groq

    key = (key or "").strip() or _vault.get("groq", "")
    base = (base_url if base_url is not None else _vault.get("llm_base", "")).strip()
    mdl  = (model if model else _vault.get("llm_model", "")) or config.LLM_MODEL
    if not key:
        return {"ok": False, "error": "API key required"}
    async def _run():
        kw = {"api_key": key}
        if base: kw["base_url"] = base
        async with _groq.AsyncGroq(**kw) as c:
            await c.chat.completions.create(model=mdl, max_tokens=4,
                                            messages=[{"role": "user", "content": "ping"}])
    try:
        asyncio.run(_run()); return {"ok": True, "model": mdl}
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
        "version": config.APP_VERSION,
        "vaultMode": config.VAULT_MODE,
        "exists": vault_exists(),
        "unlocked": (not config.VAULT_MODE) or _vault["unlocked"],
        "ready": bool(config.MCP_HEADERS.get("Authorization")),
        "tenants": [{"id": t["id"], "label": t["label"]} for t in _vault["tenants"]],
        "active": _vault["active"],
        "hasGroq": bool(_vault["groq"]),
        "llm": {"hasKey": bool(_vault["groq"]),
                "base_url": _vault.get("llm_base", ""),
                "model": _vault.get("llm_model", "")},
        # TODO(step-8): update status — deferred, belongs to the self-update subsystem
    }
