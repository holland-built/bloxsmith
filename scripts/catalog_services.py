"""Dump all REST services + endpoint listings for NOC-relevant ones."""
import asyncio, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcp_session import _mcp_session, _tool_text


def txt(r):
    try:
        return json.loads(_tool_text(r))
    except Exception:
        return _tool_text(r)


def extract_get_endpoints(info):
    """Pull GET paths from a get_service_info payload (best-effort across shapes)."""
    gets = []
    all_eps = []
    if not isinstance(info, dict):
        return gets, all_eps, str(type(info))
    # common shapes: {"methods": [...]} / {"paths": {...}} / {"endpoints":[...]}
    container = None
    used_key = None
    for k in ("methods", "endpoints", "paths", "operations"):
        if k in info:
            container = info[k]
            used_key = k
            break
    if container is None:
        return gets, all_eps, "keys=" + ",".join(info.keys())
    if isinstance(container, dict):
        for path, spec in container.items():
            methods = spec.keys() if isinstance(spec, dict) else []
            all_eps.append(f"{path} [{','.join(methods)}]")
            if isinstance(spec, dict) and any(m.lower() == "get" for m in spec):
                gets.append(path)
    elif isinstance(container, list):
        for e in container:
            if isinstance(e, dict):
                m = e.get("method", e.get("http_method", ""))
                p = e.get("endpoint", e.get("path", e.get("name", "")))
                summ = e.get("summary", e.get("description", ""))[:60]
                all_eps.append(f"{m} {p} — {summ}")
                if str(m).upper() == "GET":
                    gets.append(f"{p} — {summ}")
            else:
                all_eps.append(str(e))
    return gets, all_eps, used_key


async def main():
    async with _mcp_session() as session:
        result = {}
        r = await session.call_tool("infoblox-portal_list_all_available_services", {})
        services = txt(r)
        result["all_services"] = services
        svc_list = services["services"] if isinstance(services, dict) else services
        names = [s.get("service_name") for s in svc_list if isinstance(s, dict)]
        print(f"=== {len(names)} services ===", file=sys.stderr)
        for s in svc_list:
            print(f"  {s.get('service_name')}: {s.get('paths_count')} paths — {s.get('title')}", file=sys.stderr)

        kws = ["ipam", "dns", "dhcp", "atc", "dfp", "fw", "lease", "host",
               "asset", "anycast", "cdc", "threat", "network", "dossier", "infra"]
        relevant = [n for n in names if n and any(k in str(n).lower() for k in kws)]
        result["_relevant_names"] = relevant
        details = {}
        for n in relevant:
            try:
                ri = await session.call_tool("infoblox-portal_get_service_info", {"service_name": n})
                info = txt(ri)
                gets, all_eps, key = extract_get_endpoints(info)
                details[n] = {
                    "info_keys": list(info.keys()) if isinstance(info, dict) else str(type(info)),
                    "container_key": key,
                    "get_endpoints": gets,
                    "all_endpoints": all_eps,
                    "raw": info,
                }
                print(f"  [svc ok] {n}: {len(all_eps)} eps ({len(gets)} GET) via {key}", file=sys.stderr)
            except Exception as e:
                details[n] = {"error": str(e)}
                print(f"  [svc ERR] {n}: {e}", file=sys.stderr)
        result["service_details"] = details
        print(json.dumps(result, indent=2, default=str))


asyncio.run(main())
