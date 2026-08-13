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
4. **Run `bash scripts/needs-tag.sh` and do exactly what it prints.** It writes one word:

   - **`tag`** → `git tag vX.Y.Z && git push origin vX.Y.Z`, where X.Y.Z is one above `git tag --sort=-v:refname | head -1`: minor for a feature, patch for a fix. Not optional, and never ask.
   - **`skip`** → stop here. The push is the whole release. Do not tag, and do not ask whether to tag.

   It always exits 0 for both answers — the word on stdout is the decision, not the exit code. A nonzero exit means the script could not decide (no tags, not a repo) and is a real failure. `bash scripts/needs-tag.sh --selftest` proves the path rules still hold.

   WHY THIS IS A STEP AND NOT A `## Release` EXTRA. It used to live under `## Release`, which `/release` reads as "publish only if the user asked for it" — so a normal run pushed `master`, cut no release, and :8080 correctly reported it was already up to date while the new code sat on GitHub unreleased. This repo has one environment and no staging branch, so for anything a customer runs, pushing master IS releasing.

   WHY IT IS NOW CONDITIONAL. That reasoning is right for code and wrong for everything else, and it failed twice in two days. `v3.65.3` shipped byte-identical code for a README edit; `6bc5ee3` was a commit of test files. :8080 self-updates, so each of those handed an "update available" banner to every operator for a change with nothing in it to see. The judgment version of this rule — "tag unless it's trivial" — decays into never tagging, because every change looks trivial to whoever just made it. So the decision is a path list, it lives in a script, and the script has a selftest: a path rule with no test rots the first time someone adds a directory. Replayed against real history it returns `skip` for `v3.65.2..v3.65.3` and `tag` for the three code releases before it.

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
