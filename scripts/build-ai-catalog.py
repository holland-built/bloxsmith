#!/usr/bin/env python3
"""Build go/internal/dashboard/ai_catalog.json from scripts/out_services.json.

The Ask tab's find_data / api_get tools may read only the paths listed in the
output: list endpoints (no {id} in the path, taking _filter or _limit) whose
catalogued methods include GET. Paths that hand out secrets or bulk downloads are left out on purpose.

Run after the nightly drift job refreshes out_services.json:
    python3 scripts/build-ai-catalog.py
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "scripts" / "out_services.json"
OUT = ROOT / "go" / "internal" / "dashboard" / "ai_catalog.json"

# Services whose list endpoints hand out credentials (join tokens, CSRs).
SKIP_SERVICES = {"HostActivation"}
# Paths that return secrets, bypass codes, device credentials or bulk files.
SKIP_PATH = re.compile(
    r"join_?token|csr|download|access_codes|mdm_configs|authn_|vpn_profiles|/destinations/"
)


def main():
    details = json.loads(SRC.read_text())["service_details"]
    out = []
    for service in sorted(details):
        if service in SKIP_SERVICES:
            continue
        raw = details[service]["raw"]
        base = raw["base_path"].rstrip("/")
        for path in sorted(raw["endpoints"]):
            get = raw["endpoints"][path]["methods"].get("GET")
            if get is None or "{" in path or SKIP_PATH.search(path):
                continue
            # A list endpoint takes _filter or _limit. Without them the GET returns one
            # object (dns/global) that api_get would report as "0 records".
            params = " ".join(get.get("parameters") or [])
            if "_filter (query)" not in params and "_limit (query)" not in params:
                continue
            summary = (get.get("summary") or "").strip()
            if not summary:
                # fall back to the first line of the description, else the path
                summary = (get.get("description") or "").strip().split("\n")[0] or path
            out.append({"path": base + path, "service": service, "summary": summary[:120]})
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print(f"{len(out)} paths -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
