# SHIP.md — release playbook for Infoblox MCP

Repo: `github.com/holland-built/infoblox-noc-dashboard`. Run `/release` from anywhere in the repo.

## Environments
| Env | Branch | Default | Notes |
|-----|--------|---------|-------|
| prod | master | * | single-branch repo; push straight to master |

## Steps
1. If a `CHANGELOG.md` exists at the repo root, add or update today's section with a plain-English bullet per change. If none exists, skip.
2. Commit + push `master`.

## Guards
- .env
- .env.*
- secrets/
- config with real API keys, tokens, or Infoblox credentials

## Release
- none — no GitHub tag/release step.
