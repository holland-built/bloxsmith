"""Append-only, hash-chained audit log.

Persistence pattern (writable-dir probe) copied from backend/alerts/suppression.py,
adapted for append-only writes -- each line is a JSON object; each entry's `hash`
is a SHA-256 of its own content chained to the previous entry's `hash`, so any
on-disk tampering (edited/deleted/reordered line) is detectable via verify_chain().
"""

import hashlib
import json
import os
import threading
import time
from typing import Optional

DIR = os.path.dirname(os.path.abspath(__file__))


def _resolve_log_file():
    candidates = []
    if os.environ.get("AUDIT_LOG_DIR"):
        candidates.append(os.environ["AUDIT_LOG_DIR"])
    if os.environ.get("VAULT_DIR"):
        candidates.append(os.environ["VAULT_DIR"])
    candidates.append(os.path.join(os.path.dirname(DIR), "data"))

    for d in candidates:
        try:
            os.makedirs(d, exist_ok=True)
            t = os.path.join(d, ".wtest"); open(t, "w").close(); os.remove(t)
            return os.path.join(d, "audit_log.jsonl")
        except Exception:
            continue
    return os.path.join(os.path.dirname(DIR), "data", "audit_log.jsonl")


LOG_FILE = _resolve_log_file()
_lock = threading.Lock()


def _entry_hash(entry: dict) -> str:
    """SHA-256 over the entry's content fields + prev_hash, excluding the entry's own hash field."""
    payload = {k: v for k, v in entry.items() if k != "hash"}
    blob = json.dumps(payload, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()


def _read_lines():
    try:
        with open(LOG_FILE) as f:
            return [json.loads(line) for line in f if line.strip()]
    except FileNotFoundError:
        return []


def append_event(event: str, sub: str, email: str, detail: Optional[dict] = None) -> dict:
    """Append one tamper-evident entry. Never logs secrets -- only sub/email/event/detail."""
    with _lock:
        entries = _read_lines()
        prev_hash = entries[-1]["hash"] if entries else "0" * 64
        entry = {
            "ts": time.time(),
            "event": event,
            "sub": sub,
            "email": email,
            "detail": detail or {},
            "prev_hash": prev_hash,
        }
        entry["hash"] = _entry_hash(entry)
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
        return entry


def read_all() -> list:
    with _lock:
        return _read_lines()


def verify_chain() -> dict:
    """Walk all entries, recompute each hash, confirm the chain. Returns
    {"valid": bool, "broken_index": int|None}."""
    entries = _read_lines()
    prev_hash = "0" * 64
    for i, entry in enumerate(entries):
        if entry.get("prev_hash") != prev_hash:
            return {"valid": False, "broken_index": i}
        recomputed = _entry_hash(entry)
        if recomputed != entry.get("hash"):
            return {"valid": False, "broken_index": i}
        prev_hash = entry["hash"]
    return {"valid": True, "broken_index": None}
