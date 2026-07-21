# SHIP.md — release playbook for bloxsmith

## Environments
| Env  | Branch | Default | Notes |
|------|--------|---------|-------|
| prod | master | *       | tag vX.Y.Z → GitHub release + ghcr image; :8080 self-updates |

## Steps
1. Ensure bundle is current: `node scripts/build_ui.js` (commit go/web/app.bundle.js if changed)
2. Bump patch/minor version = next tag
3. Commit all with feat/fix message

## Guards
- .env
- ~/Library/LaunchAgents/*.plist   (machine-local, never in repo)
- /tmp/bloxsmith-dev

## Release
- Tag master `vX.Y.Z` + push tag → .github/workflows/release.yml runs goreleaser → ghcr image + GitHub release
- Verify: `gh run watch` then :8080 "Check now" self-updates
