#!/usr/bin/env python3
"""Fetch the UDDI demo/seed templates from Chris Marrison's public toolkit.

These YAML templates (region site definitions + regional address blocks) are the
seed-data source for the Provision → "Seed Demo Data" flow. They are third-party
content, so they are NOT committed here (see .gitignore) — they are fetched at
build/install time instead.

Usage:
    python scripts/fetch_templates.py            # -> ./templates
    TEMPLATES_DIR=/app/templates python scripts/fetch_templates.py

Stdlib only (urllib + tarfile) so it runs in the python:slim image with no extra
tools. Excludes the _shared/ scaffolding (SITENAME placeholders that can't provision).
"""
import io
import os
import sys
import tarfile
import urllib.request

REPO = "ccmarris/uddi_automation_toolkit"
BRANCH = os.environ.get("TEMPLATES_REF", "main")
# Only these subtrees under templates/ are shipped (skip _shared placeholders and
# the stray root-level example templates).
KEEP = ("amer/", "emea/", "apac/", "blocks/", "dns/")
DEST = os.environ.get("TEMPLATES_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates"
)


def main() -> int:
    url = f"https://github.com/{REPO}/archive/refs/heads/{BRANCH}.tar.gz"
    print(f"[fetch_templates] downloading {url}")
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            blob = resp.read()
    except Exception as e:  # noqa: BLE001
        print(f"[fetch_templates] ERROR downloading: {e}", file=sys.stderr)
        return 1

    # tarball root dir is "<repo>-<branch>/"; strip it + the "templates/" prefix.
    prefix = f"{REPO.split('/')[-1]}-{BRANCH}/templates/"
    count = 0
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        for m in tar.getmembers():
            if not m.isfile() or not m.name.startswith(prefix):
                continue
            rel = m.name[len(prefix):]
            if not rel.endswith((".yaml", ".yml")) or not rel.startswith(KEEP):
                continue
            data = tar.extractfile(m).read()
            out = os.path.join(DEST, rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "wb") as f:
                f.write(data)
            count += 1

    if count == 0:
        print("[fetch_templates] ERROR: no templates extracted", file=sys.stderr)
        return 1
    print(f"[fetch_templates] wrote {count} templates -> {DEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
