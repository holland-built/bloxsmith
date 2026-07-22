# SHIP.md — release playbook for bloxsmith

## Environments
| Env  | Branch | Default | Notes |
|------|--------|---------|-------|
| prod | master | *       | tag vX.Y.Z → GitHub release + ghcr image; :8080 self-updates |

## Steps
1. Ensure UI is current: `cd ui && npm run build && rm -rf ../go/web/* && cp -R dist/* ../go/web/` (commit go/web if changed). Legacy no-build pipeline (`scripts/build_ui.js` → app.bundle.js) retired at v3.0.0 — src/*.jsx is the OLD app, kept for reference only.
2. Bump patch/minor version = next tag
3. Commit all with feat/fix message

## Guards
- .env
- ~/Library/LaunchAgents/*.plist   (machine-local, never in repo)
- /tmp/bloxsmith-dev

## Release
- Tag master `vX.Y.Z` + push tag → .github/workflows/release.yml runs goreleaser → ghcr image + GitHub release
- Verify: `gh run watch` then :8080 "Check now" self-updates
