import time
from typing import Optional

_last: Optional[float] = None


def mark_fetch_ok() -> None:
    """Call this after any successful data fetch. Stamps the current time."""
    global _last
    _last = time.time()


def freshness(stale_after: int = 600) -> dict:
    """Returns whether the last successful fetch is within `stale_after` seconds."""
    if _last is None:
        return {
            "fresh": False,
            "last_successful_fetch": None,
            "age_seconds": None,
            "stale_after_seconds": stale_after,
        }
    age = time.time() - _last
    return {
        "fresh": age <= stale_after,
        "last_successful_fetch": _last,
        "age_seconds": round(age, 1),
        "stale_after_seconds": stale_after,
    }
