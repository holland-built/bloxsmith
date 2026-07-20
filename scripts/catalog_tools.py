"""Dump EVERY MCP tool: name, full description, input schema params."""
import asyncio, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcp_session import _mcp_session


async def main():
    async with _mcp_session() as session:
        tools = await session.list_tools()
        out = []
        for t in tools.tools:
            schema = t.inputSchema or {}
            props = schema.get("properties", {})
            required = set(schema.get("required", []))
            params = []
            for name, spec in props.items():
                typ = spec.get("type", spec.get("anyOf", "?"))
                req = "*" if name in required else ""
                params.append(f"{name}{req}:{typ}")
            out.append({
                "name": t.name,
                "description": (t.description or "").strip(),
                "params": params,
                "required": sorted(required),
            })
        print(json.dumps(out, indent=2, default=str))
        print(f"\n\n=== TOTAL TOOLS: {len(out)} ===", file=sys.stderr)
        for o in out:
            print(f"- {o['name']} ({len(o['params'])} params)", file=sys.stderr)


asyncio.run(main())
