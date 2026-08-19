#!/usr/bin/env bash
# needs-tag.sh — decides whether a push must also cut a release.
#
# WHY THIS EXISTS. SHIP.md step 4 used to say tagging is "not optional" and
# "never ask whether to tag", on the reasoning that this repo has one
# environment so pushing master IS releasing. That is right for code and wrong
# for everything else, and it went wrong twice in two days: v3.65.3 shipped
# byte-identical code for a README edit, and 6bc5ee3 was a commit of test files
# with nothing in it a customer could see. Both put an "update available" banner
# in front of every customer. :8080 self-updates, so a pointless tag is not a
# no-op — it is work handed to every operator running this.
#
# The rule has to be MECHANICAL. "Tag unless the change is trivial" decays into
# never tagging, because every change looks trivial to whoever just made it.
# So it is a path list, it lives in a script rather than in prose, and it has a
# selftest — a path rule with no test rots the first time someone adds a
# directory.
#
#   scripts/needs-tag.sh              # decide for HEAD vs the latest tag
#   scripts/needs-tag.sh v3.65.0      # decide for HEAD vs a given ref
#   scripts/needs-tag.sh --selftest   # prove the matcher still agrees with the table
#
# THE DECISION IS ON STDOUT, NEVER IN THE EXIT CODE. Prints exactly one word,
# `tag` or `skip`, and both exit 0. A nonzero "no tag needed" would abort
# /release under `set -e` and read as a failure — the opposite of the intent.
# Nonzero means this script could not decide: not a git repo, no tags, bad args.
set -uo pipefail

# Paths that ship nothing a customer runs. EVERYTHING NOT LISTED HERE TAGS,
# including any path this list does not recognise — a new top-level directory
# that turns out to ship must fail toward releasing, never toward silence.
#
# THE TEST FOR ADDING A PATH HERE. Until 2026-08-14 this was a list with no stated
# principle, and it took three patches in a single day (third_party/,
# scripts/out_*.json, and a fourth that was proposed and rejected) before anyone
# wrote down what the list is FOR. It is this:
#
#   A path is exempt when changing it cannot alter any published artifact — the
#   binary, the archive, the image, the installers — AND cannot alter anything a
#   customer executes, AND cannot mutate this repository.
#
# That third clause is not padding. `.github/workflows/mcp-drift.yml` was proposed
# for exemption as "maintainer-only, it just opens issues". It holds
# `contents: write` and runs `git push`: it commits to this repo, so it can change
# what the next build is made of. Being maintainer-FACING is not the same as being
# unable to affect what ships, and a workflow almost never passes this test.
#
# The asymmetry that settles every borderline case: a needless release is visible,
# bounded and recoverable — an operator sees an update banner once. A missed release
# is none of those, and neither is a workflow that quietly gains the ability to
# publish while sitting on this list. When unsure, leave it off.
#
# `.github/workflows/ci.yml` WAS PROPOSED FOR EXEMPTION AND REJECTED, on 2026-08-18,
# and the reasoning is here so the next person does not spend an afternoon
# re-deriving it. The case for it looked strong. ci.yml declares no `permissions:`
# block at all, this repo's default_workflow_permissions is `read`
# (`gh api repos/holland-built/bloxsmith/actions/permissions/workflow`), it runs no
# `git push` and no `git commit`, and it is a gate rather than a builder —
# release.yml is what publishes. On paper it passes all three clauses above, unlike
# mcp-drift.yml.
#
# Two things killed it, and the measurement is the more important one.
#
# WHAT IT WOULD ACTUALLY SAVE: one release. Replaying every tag range in this
# repo's history and asking "was this `tag` caused by workflow files alone", four
# come back yes — v3.65.3..v3.65.4 and v3.65.4..v3.65.5 (release.yml, which really
# does publish), v3.66.5..v3.66.6 (mcp-drift.yml, which really can push), and
# v3.67.1..v3.67.2, the CI-sharding change that raised the question. Only the last
# would have been avoided. An earlier draft of this argument claimed "twelve
# workflow-only commits in sixty days, one avoidable release every five days"; that
# counted COMMITS and not release ranges, and most of those commits landed in the
# same range as real code that tagged anyway. The true cost of this rule, over the
# whole life of the repo, is a single needless banner.
#
# WHY IT CANNOT BE GUARDED: the exemption is only safe while ci.yml stays read-only,
# and nothing here can enforce that. The repo-wide permissions default is a toggle
# in the GitHub web UI, so ci.yml could gain `contents: write` with no commit at
# all — declaring `permissions: contents: read` in ci.yml closes that, but not the
# second hole: under a by-name exemption, the very commit that adds
# `contents: write` to ci.yml is a change to ci.yml, so it would exempt itself. A
# CI check would go red only AFTER the push (master has no branch protection and
# SHIP.md pushes straight to it), and the same commit can edit the check. Nor is
# grepping for `git push` a capability model — `gh`, `curl` against the API, and any
# third-party action can write when the token allows it.
#
# So: one avoidable banner, versus a path that can silently stop being safe. That is
# the asymmetry in the paragraph above, pointing the same way it always does. The
# `tag .github/workflows/ci.yml` row in the selftest is what pins this decision;
# deleting it is how the decision would get reversed by accident.
#
# Two entries are named individually instead of by a `scripts/` wildcard, and
# the reason matters: `scripts/install.sh` IS what a customer runs to install,
# so a blanket scripts/ exemption would let the installer change with no release
# to exercise it. Enumerating the two safe ones keeps that trap shut, and the
# selftest below pins the list so a third cannot be added quietly.
exempt() {
  case "$1" in
    tests/*|plans/*|docs/*)                 return 0 ;;
    *.md)                                   return 0 ;;
    .github/dependabot.yml)                 return 0 ;;
    .github/ISSUE_TEMPLATE/*)               return 0 ;;
    .github/PULL_REQUEST_TEMPLATE*)         return 0 ;;
    scripts/e2e.sh|scripts/needs-tag.sh)    return 0 ;;
    # Committed baselines for the nightly MCP drift check, plus the differ that
    # reads them. Maintainer-facing: nothing bundles them, no customer runs them,
    # and a refresh changes no shipped byte. They were forcing a release every
    # time Infoblox reshuffled its API — v3.66.5 was tagged partly for this.
    #
    # A NARROW glob on purpose. `scripts/*` would swallow install.sh, which IS
    # what a customer runs, and that trap is the reason the two safe scripts
    # above are enumerated one by one rather than wildcarded.
    #
    # Worst case if this is wrong: a snapshot-only change skips a release — and a
    # snapshot-only change is by definition invisible to customers.
    scripts/out_*.json|scripts/mcp_diff.py) return 0 ;;
    # Test-runner configuration. Same category as tests/ and scripts/e2e.sh: it
    # decides how the suite runs and reaches no customer. Found the same way
    # .gitignore was — by running this script on a real change (7468e9e, which
    # touched only tests/ and this file) and getting `tag` for something that
    # ships nothing.
    playwright.config.ts)                    return 0 ;;
    # Repo hygiene that cannot reach a customer. .gitignore governs what git
    # tracks; goreleaser builds from tracked files, so a file it hides was never
    # going to be in the artifact. Found by running this script against
    # v3.65.2..v3.65.3 — the README-only release — which came back `tag` purely
    # because of a .gitignore line, i.e. the rule failed the exact case it was
    # written for. NOT the same as .dockerignore, which decides what enters the
    # image build context and therefore TAGS; the two look alike and are not.
    .gitignore|.gitattributes|.editorconfig) return 0 ;;
    # Vendored upstream source, kept for attribution (see NOTICE.md). Exempt
    # because it reaches no artifact, and that was VERIFIED rather than assumed
    # when it landed on 2026-08-14: `go list ./...` shows no third_party
    # packages (go/ is a separate module), oxlint runs with cwd ui/, Playwright's
    # testDir is ./tests, and goreleaser's archive `files:` and dockers_v2
    # `extra_files:` are allowlists resolved against go/ — so nothing here can
    # ride along by default.
    #
    # This is the ONE exemption that is a whole top-level directory, which the
    # rule above says must fail toward releasing. It is safe only for as long as
    # that stays a pure archive nothing builds. If anything in third_party/ ever
    # becomes a build input, delete this arm — do not add an exception to it.
    third_party/*)                           return 0 ;;
    # Go test files. `go build` does not compile a *_test.go at all — the file
    # is invisible to every non-test build — so one cannot alter the binary, the
    # archive, the image or the installers, and there is nothing in it a
    # customer executes. Same category as tests/ and playwright.config.ts, and
    # found the same way both of those were: by running this script on a real
    # change and getting `tag` for something that ships nothing. Measured on
    # v3.67.0..v3.67.1 — 16 paths printed, 14 of them _test.go, and only
    # go/internal/mcp/mcp.go and go/templates/dns/corp.yaml real. The two
    # changes that mattered were outnumbered seven to one by files that could
    # not reach anybody, which is how this list stops being read.
    #
    # REPLAYED AGAINST REAL HISTORY, both directions, because the noise argument
    # alone would not justify an arm on this list. Across the last eleven
    # release ranges (v3.65.3..v3.67.1) this arm flips NO verdict — every one of
    # those releases shipped real code and still says `tag`, so it cannot cost a
    # release that was correctly cut. It flips exactly one commit in that span:
    # ea1da6a (#144), "Make the last five MCP test fakes answer the id they were
    # asked", which touched nothing but *_test.go and which the old matcher
    # called `tag`. That commit is the case this arm is for, and it is the same
    # shape as 6bc5ee3 in SHIP.md:34 — a commit of test files that would have
    # put an update banner in front of every operator for nothing.
    #
    # THIS IS NOT THE "WHEN UNSURE, LEAVE IT OFF" CASE, and that distinction is
    # the only reason this arm is allowed to exist. That posture is for paths
    # whose reach nobody has established — a new workflow, a new top-level
    # directory, third_party/ on the day it might become a build input. Here the
    # reach is a property of the Go toolchain rather than a claim about how this
    # repo happens to be wired, so there is nothing left to be unsure about.
    # Every other entry on this list would have to be re-verified if the build
    # changed; this one would not. Do not delete it as an unsafe exemption.
    #
    # It is a SUFFIX rule and not a directory rule. The selftest pins that with
    # a go/internal/dashboard/tiles.go row that must keep tagging, because
    # widening this to go/internal/* would exempt the server.
    #
    # THE FIRST ARM IS WHERE THE GUARANTEE STOPS. The archive `files:` list in
    # go/.goreleaser.yaml bundles `templates/**/*` by GLOB, so a _test.go under
    # go/templates would be copied into every release archive as a data file
    # without the compiler ever looking at it — exempt by suffix, shipped by
    # glob. No such file exists today. The arm is here so that the day somebody
    # adds one, this script says `tag` instead of quietly agreeing with itself.
    go/templates/*_test.go)                  return 1 ;;
    *_test.go)                               return 0 ;;
    *)                                      return 1 ;;
  esac
}

# Every row was a real decision, and the four marked ← were wrong in an earlier
# draft of the rule. They are here so the mistakes cannot come back.
selftest() {
  local fails=0 path want got
  while read -r want path; do
    [ -z "$want" ] && continue
    if exempt "$path"; then got=skip; else got=tag; fi
    if [ "$got" != "$want" ]; then
      echo "selftest FAIL: $path -> $got, expected $want" >&2
      fails=$((fails + 1))
    fi
  # TWO OF THESE ROWS ARE NOT .md ON PURPOSE, and they are load-bearing.
  # Every docs/ and plans/ case here used to end in .md, and `*.md)` is its own
  # rule in exempt() — so those rows passed whether or not `docs/*` and `plans/*`
  # existed. Measured by deleting each prefix in turn: dropping docs/* left this
  # table green, dropping plans/* left it green, dropping tests/* failed it with 2
  # errors, because the tests/ rows are .spec.ts and .yml. docs/logo.svg and
  # plans/screens/before.png are the only rows that exercise those two prefixes,
  # and docs/logo.svg is a real tracked file — so is docs/dashboard.png, which is
  # exempt today by nothing else.
  #
  # THE THREE _test.go ROWS ARE A SET AND MUST STAY ONE. tiles_test.go proves the
  # suffix is exempt; tiles.go — same directory, one word shorter — proves the arm
  # is about the suffix and not about go/internal/, which is the only way it could
  # be widened into exempting the server; go/templates/foo_test.go proves the
  # guard arm still fires, i.e. that a file the release archive picks up by glob
  # tags even though its name says test. Delete any one of the three and the other
  # two stop proving anything. foo_test.go is deliberately a path that does not
  # exist — it is the case this table is defending against, not a file to create.
  done <<'TABLE'
skip README.md
skip docs/SHIP.md
skip SHIP.md
skip docs/context/notes.md
skip docs/logo.svg
skip plans/screens/before.png
skip tests/page-baseline.spec.ts
skip tests/page-baseline.spec.ts-snapshots/overview.aria.yml
skip plans/034-close-the-open-three.md
skip .github/dependabot.yml
skip .github/ISSUE_TEMPLATE/bug.yml
skip scripts/e2e.sh
skip scripts/needs-tag.sh
skip .gitignore
skip playwright.config.ts
skip third_party/uddi_self_service_example/web_portal.py
skip third_party/uddi_automation_toolkit/SOURCE.md
skip scripts/out_cubes.json
skip scripts/out_tools.json
skip scripts/mcp_diff.py
skip go/internal/dashboard/tiles_test.go
tag scripts/install.command
tag .dockerignore
tag .env.example
tag .github/workflows/release.yml
tag .github/workflows/ci.yml
tag .github/workflows/mcp-drift.yml
tag .github/workflows/some-new-thing.yml
tag scripts/install.sh
tag scripts/install.command
tag scripts/dev-serve.sh
tag go/main.go
tag go/Dockerfile.goreleaser
tag go/internal/dashboard/tiles.go
tag go/templates/foo_test.go
tag go/templates/subnet.json
tag ui/src/App.jsx
tag ui/package.json
tag docker-compose.yml
tag .goreleaser.yaml
tag some-new-toplevel-thing/file.go
TABLE
  if [ "$fails" -gt 0 ]; then
    echo "selftest: $fails failure(s)" >&2
    return 1
  fi
  echo "selftest: ok"
}

if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit $?
fi

git rev-parse --git-dir >/dev/null 2>&1 || { echo "needs-tag: not a git repo" >&2; exit 2; }

SINCE="${1:-}"
if [ -z "$SINCE" ]; then
  SINCE="$(git tag --sort=-v:refname | head -1)"
  [ -n "$SINCE" ] || { echo "needs-tag: no tags in this repo — cannot compare" >&2; exit 2; }
fi
git rev-parse --verify --quiet "$SINCE" >/dev/null \
  || { echo "needs-tag: '$SINCE' is not a ref in this repo" >&2; exit 2; }

# This reads COMMITTED history only. In SHIP.md's order that is always right —
# step 2 commits and step 3 pushes, so by the time step 4 runs, HEAD is the
# thing being released. Run by hand before committing, though, it silently
# answers about the wrong tree: staged workflow changes gave `skip` during this
# script's own development, which is the exact wrong answer delivered
# confidently. Warned, not failed, because the verdict for HEAD is still a real
# verdict — it is just not a verdict about the work in progress.
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "needs-tag: WARNING — uncommitted changes present; this verdict covers HEAD only, not your working tree" >&2
fi

CHANGED="$(git diff --name-only "$SINCE"..HEAD)"

# No diff at all is not "nothing shipped" — it is a question this script has no
# business answering silently, so it says skip and explains on stderr.
if [ -z "$CHANGED" ]; then
  echo "needs-tag: no changes between $SINCE and HEAD" >&2
  echo skip
  exit 0
fi

verdict=skip
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if ! exempt "$f"; then
    echo "needs-tag: '$f' ships something a customer runs" >&2
    verdict=tag
  fi
done <<< "$CHANGED"

echo "$verdict"
