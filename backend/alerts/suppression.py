"""
On-disk alert-snooze store.

Plain JSON, NOT encrypted — a snooze expiry timestamp isn't a secret. The
writable-directory resolution mirrors backend/vault.py's `_resolve_vault_file`
PATTERN (env var -> env var -> repo-relative dir, each probed for
writability before use) but is copied, not imported, so this module has zero
dependency on vault.py.
"""

import json
import os
import threading
import time

DIR = os.path.dirname(os.path.abspath(__file__))


def _resolve_state_file():
    candidates = []
    if os.environ.get("ALERT_STATE_DIR"):
        candidates.append(os.environ["ALERT_STATE_DIR"])
    if os.environ.get("VAULT_DIR"):
        candidates.append(os.environ["VAULT_DIR"])
    candidates.append(os.path.join(os.path.dirname(DIR), "data"))

    for d in candidates:
        try:
            os.makedirs(d, exist_ok=True)
            t = os.path.join(d, ".wtest"); open(t, "w").close(); os.remove(t)
            return os.path.join(d, "alert_state.json")
        except Exception:
            continue
    return os.path.join(os.path.dirname(DIR), "data", "alert_state.json")


STATE_FILE = _resolve_state_file()
_lock = threading.Lock()


def _load():
    """Read {category: expiry_epoch_float} from disk. Never raises."""
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save(d):
    """Atomic write: serialize to a .tmp file then os.replace into place."""
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f)
    os.replace(tmp, STATE_FILE)


def snooze(category, minutes):
    """Snooze a category for `minutes` from now (single locked critical section)."""
    with _lock:
        d = _load()
        d[category] = time.time() + minutes * 60
        _save(d)


def is_snoozed(category):
    with _lock:
        state = _load()
        return state.get(category, 0) > time.time()


def active_snoozes():
    """Return only the still-active snooze entries (expired ones pruned from the view)."""
    with _lock:
        state = _load()
        now = time.time()
        return {k: v for k, v in state.items() if v > now}
