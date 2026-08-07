# SHIP.md — release playbook for bloxsmith

## Environments
| Env  | Branch | Default | Notes |
|------|--------|---------|-------|
| prod | master | *       | tag vX.Y.Z → GitHub release + ghcr image; :8080 self-updates |

## Steps
1. Ensure UI is current: `cd ui && npm run build && rm -rf ../go/web/* && cp -R dist/* ../go/web/` (commit go/web if changed). Legacy no-build JSX pipeline retired at v3.0.0 — the old app was deleted; it lives on only in git history.
2. Commit all with feat/fix message
3. Push master
4. **Tag and push the tag — this is not optional.** `git tag vX.Y.Z && git push origin vX.Y.Z`, where X.Y.Z is one above `git tag --sort=-v:refname | head -1`: minor for a feature, patch for a fix. Never ask whether to tag.

   WHY THIS IS A STEP AND NOT A `## Release` EXTRA. It used to live under `## Release`, which `/release` reads as "publish only if the user asked for it" — so a normal run pushed `master`, cut no release, and :8080 correctly reported it was already up to date while the new code sat on GitHub unreleased. That is not a second decision anybody makes here: this repo has exactly one environment, there is no dev or staging branch, so pushing master IS releasing. Splitting the two only produced a silent gap between "shipped" and "shipped".

## Guards
- .env
- ~/Library/LaunchAgents/*.plist   (machine-local, never in repo)
- /tmp/bloxsmith-dev

## Release
Post-push verification only — Step 4 already published.
- The pushed tag triggers .github/workflows/release.yml → goreleaser → ghcr image + GitHub release
- Verify: `gh run watch` then :8080 "Check now" self-updates
