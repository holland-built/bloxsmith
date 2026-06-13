# MCP.md
# MCP servers available in this project.

## Configured (work account — remote, require auth)

Authenticate via `/mcp` or `claude mcp` before use.
These are registered in the work account config (`~/.claude-work`).

| Server | Purpose |
|---|---|
| Glean | Company knowledge search — Infoblox docs, product info, internal resources |
| Databricks (dev) | Query Infoblox dev lakehouse via SQL MCP |
| Databricks (prod) | Query Infoblox prod lakehouse via SQL MCP |
| Microsoft 365 | M365 docs / mail / calendar |
| Notion | Notion workspace search + pages |
| Atlassian Rovo | Jira / Confluence |
| Figma | Design file + component access |
| Canva | Design asset access |
| Miro | Whiteboard / diagram access |
| Gamma | Deck / doc generation |

## Used via skills (local)

| Server | Purpose |
|---|---|
| playwright | Browser automation, UI testing, screenshot verification (driven by `prove` / `verify` skills) |

## Notes

- Databricks SQL MCP is the primary path to NOC alert/event data for prototyping queries.
- Glean is the fastest path to internal Infoblox documentation or product specs.
