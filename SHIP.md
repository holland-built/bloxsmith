# SHIP.md — release playbook for bloxsmith

Repo: `github.com/holland-built/bloxsmith`. This is the file `/release` reads and
runs — it resolves `$REPO_ROOT/SHIP.md` and nothing else, so a step that is not
here does not happen.

**This file is the steps. `docs/SHIP.md` is the detail** — goreleaser internals,
cosign signing, the Homebrew tap, digest pinning and rollback. Neither is a copy of
the other; they were allowed to drift once and disagreed about whether Step 1 below
existed at all.

## Environments
| Env  | Branch | Default | Notes |
|------|--------|---------|-------|
| prod | master | *       | tag vX.Y.Z → GitHub release + ghcr image; :8080 self-updates |

## Steps
1. Ensure UI is current: `cd ui && npm run build && rm -rf ../go/web/* && cp -R dist/* ../go/web/` (commit go/web if changed). Legacy no-build JSX pipeline retired at v3.0.0 — the old app was deleted; it lives on only in git history.
2. Commit all with a feat/fix message. The first line states WHAT changed, in
   ≤60 characters — GitHub shows it, truncated, as the label next to every file
   and folder the commit touched, so a story-shaped subject reads as gibberish
   there (measured 2026-08-11 on the repo front page). The story and reasoning
   belong in the body, where `git show` keeps them in full.
3. Push master
4. **Tag and push the tag — this is not optional.** `git tag vX.Y.Z && git push origin vX.Y.Z`, where X.Y.Z is one above `git tag --sort=-v:refname | head -1`: minor for a feature, patch for a fix. Never ask whether to tag.

   WHY THIS IS A STEP AND NOT A `## Release` EXTRA. It used to live under `## Release`, which `/release` reads as "publish only if the user asked for it" — so a normal run pushed `master`, cut no release, and :8080 correctly reported it was already up to date while the new code sat on GitHub unreleased. That is not a second decision anybody makes here: this repo has exactly one environment, there is no dev or staging branch, so pushing master IS releasing. Splitting the two only produced a silent gap between "shipped" and "shipped".

## Guards

Kept identical to `docs/SHIP.md`'s copy. Both lists previously named different
things and neither contained the other.

Never committed — enforced by `.gitignore`, not by remembering. Check any one of
them with `git check-ignore -v <path>`:
- `.env`, and `.env.*` — except `.env.example`, the tracked template
- `secrets/`
- `vault.json` — the encrypted tenant key store
- `.vault-passphrase`

Never touched by a release, and outside the repo, so git cannot see them anyway:
- `~/Library/LaunchAgents/*.plist` — the machine-local service definition
- `/tmp/bloxsmith-dev` — the dev binary `scripts/dev-serve.sh` builds and owns

## Release
Post-push verification only — Step 4 already published.
- The pushed tag triggers .github/workflows/release.yml → goreleaser → ghcr image + GitHub release
- Verify: `gh run watch`, then on :8080 open Settings → Updates → **Check for updates**

  That control is the only user-driven check in the app, and it forces a fresh lookup
  (`/api/update/check?force=1`). Without it you are reading a cached answer: the server
  remembers its last GitHub reply for 30 minutes, so a release published inside that
  window shows as "up to date" until the cache expires or the service restarts. This
  line used to say "Check now", naming a button that did not exist anywhere in the UI.
