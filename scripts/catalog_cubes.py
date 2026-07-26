"""Dump all cubes + detailed measures/dimensions for NOC-relevant ones + live query tests."""
import asyncio, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcp_session import _mcp_session, _tool_text


def txt(r):
    try:
        return json.loads(_tool_text(r))
    except Exception:
        return _tool_text(r)


async def main():
    async with _mcp_session() as session:
        result = {}
        # 1. all cubes
        r = await session.call_tool("infoblox-portal_list_all_cubes", {})
        cubes = txt(r)
        result["all_cubes"] = cubes
        # figure out cube names
        cube_list = cubes.get("cubes", cubes) if isinstance(cubes, dict) else cubes
        names = []
        if isinstance(cube_list, list):
            for c in cube_list:
                if isinstance(c, dict):
                    names.append(c.get("name") or c.get("title"))
        print(f"=== {len(names)} cubes ===", file=sys.stderr)
        for n in names:
            print("  " + str(n), file=sys.stderr)

        # 2. detailed info for NOC-relevant cubes (match by keyword)
        kws = ["security", "dns", "dhcp", "lease", "host", "asset", "token",
               "network", "insight", "action", "metric"]
        relevant = [n for n in names if n and any(k in n.lower() for k in kws)]
        result["_relevant_names"] = relevant
        details = {}
        for n in relevant:
            try:
                ri = await session.call_tool("infoblox-portal_get_cube_info", {"cube_name": n})
                info = txt(ri)
                # extract just measures + dimensions names
                def field_names(key):
                    items = []
                    src = info if isinstance(info, dict) else {}
                    fields = src.get(key) or (src.get("cube", {}) or {}).get(key) or []
                    for f in fields:
                        if isinstance(f, dict):
                            items.append({"name": f.get("name"), "type": f.get("type"),
                                          "title": f.get("title")})
                        else:
                            items.append(f)
                    return items
                details[n] = {
                    "raw_keys": list(info.keys()) if isinstance(info, dict) else str(type(info)),
                    "measures": field_names("measures"),
                    "dimensions": field_names("dimensions"),
                    "segments": field_names("segments"),
                    "full": info,
                }
                print(f"  [info ok] {n}: {len(details[n]['measures'])}m {len(details[n]['dimensions'])}d", file=sys.stderr)
            except Exception as e:
                details[n] = {"error": str(e)}
                print(f"  [info ERR] {n}: {e}", file=sys.stderr)
        result["cube_details"] = details
        print(json.dumps(result, indent=2, default=str))


asyncio.run(main())
