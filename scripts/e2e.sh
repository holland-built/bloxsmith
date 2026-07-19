#!/usr/bin/env bash
# scripts/e2e.sh — Playwright harness for the CURRENT working tree.
#
# Builds the image from local source and runs it in a disposable container on
# its own port/name, waits for readiness, runs Playwright against it, then
# ALWAYS tears the container (and its volume) down — pass, fail, or Ctrl-C.
#
# Never touches the live stack: different container name, different port,
# different volume. Never runs scripts/dev.sh (which does `docker rm -f bloxsmith`).
#
# Usage:  ./scripts/e2e.sh [playwright args...]
#   ./scripts/e2e.sh                      # full suite
#   ./scripts/e2e.sh tests/copy-cell.spec.ts   # one spec
# All of this script's own output goes to stderr: stdout belongs to Playwright, so
# `./scripts/e2e.sh --reporter=json > out.json` yields parseable JSON and not a file
# with docker build layers glued to the front of it.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="bloxsmith-e2e"
PORT="${E2E_PORT:-8090}"
VOLUME="bloxsmith-e2e-vault"
BASE_URL="http://localhost:${PORT}"

[[ -f .env ]] || {
  echo "ERROR: no .env — copy .env.example to .env and set INFOBLOX_API_KEY." >&2
  echo "       (5 specs have no page.route mocks and need real data.)" >&2
  exit 1
}
if ! grep -q '^INFOBLOX_API_KEY=.\+' .env; then
  echo "ERROR: .env has no INFOBLOX_API_KEY set — required for the unmocked specs." >&2
  exit 1
fi

JSON=""; NEWFAIL=""   # set if the gate runs; cleaned up by the same trap
cleanup() {
  local code=$?
  echo "Tearing down ${NAME}…" >&2
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  [ -n "$JSON" ] && rm -f "$JSON"
  [ -n "$NEWFAIL" ] && rm -f "$NEWFAIL"
  exit "$code"
}
# A single EXIT trap covers normal exit, errors (set -e), and signals (Ctrl-C) —
# bash runs it on every termination path without a separate INT/TERM handler.
trap cleanup EXIT

VER="1.0.$(git rev-list --count HEAD 2>/dev/null || echo 0)-e2e"
echo "Building image from current source (${VER})…" >&2
docker build -t "$NAME" --build-arg APP_VERSION="${VER}" . >&2

# Never the live name/port/volume: distinct container, distinct volume, spare port.
docker rm -f "$NAME" >/dev/null 2>&1 || true
echo "Starting ${NAME} on 127.0.0.1:${PORT}…" >&2
docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:8080" \
  --env-file .env \
  -e HOST=0.0.0.0 \
  -e INFOBLOX_URL="${INFOBLOX_URL:-https://csp.infoblox.com}" \
  -v "${VOLUME}:/vault" \
  "$NAME" >/dev/null

echo "Waiting for ${BASE_URL} to answer…" >&2
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "${BASE_URL}/"; then
    echo "  up after ${i}s" >&2
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "ERROR: ${NAME} did not become ready within 60s. Logs:" >&2
    docker logs "$NAME" 2>&1 | tail -50 >&2
    exit 1
  fi
  sleep 1
done

export NOC_BASE="$BASE_URL"
echo "Running Playwright against ${NOC_BASE}…" >&2

# Known-failure gate. 27 tests fail for reasons that predate this harness (proven:
# identical failing set at bec9769). A CI that is red from day one gets ignored, and
# test.fixme'ing them would HIDE 27 possible real bugs. So: record them in
# tests/known-failures.txt and fail only when the SET CHANGES — a new failure is a
# real regression; a fixed one asks you to delete its line. Burn the list down.
#
# Skipped when the caller passes their own --reporter or a spec filter: the gate
# needs a full-suite json run to compare sets, and a partial run's "missing" tests
# would look like fixes.
#
# E2E_KNOWN_FAILURES swaps the baseline. A credential-free run (CI with no
# INFOBLOX_API_KEY secret, booted with a dummy key) has a DIFFERENT expected
# failing set — 18, not 27 — so it points at tests/known-failures-nokey.txt.
# Reusing the 27-line list there would let 9 real failures through unnoticed.
KNOWN="${E2E_KNOWN_FAILURES:-tests/known-failures.txt}"
if [ "$#" -eq 0 ] && [ -f "$KNOWN" ]; then
  # Portable across BSD/macOS and GNU/Linux: `mktemp -t PREFIX` is fine on macOS but
  # GNU requires the template to end in XXXXXX ("too few X's in template") — which only
  # showed up on a Linux CI runner. An explicit template works on both.
  JSON="$(mktemp "${TMPDIR:-/tmp}/e2e-json.XXXXXX")"
  set +e
  # Keep stderr: when the json comes back empty the ONLY clue lives there, and
  # discarding it turns "the report is empty" into an unfixable mystery (it did).
  ERR="$(mktemp "${TMPDIR:-/tmp}/e2e-err.XXXXXX")"
  # json goes to a FILE (via PLAYWRIGHT_JSON_OUTPUT_NAME) so html can run alongside it.
  # `--reporter=json` alone overrides the config's html reporter, so playwright-report/ was
  # never written and CI's artifact upload had nothing to upload — leaving a failed gate
  # with no way to see WHY. The gate needs the machine-readable set; a human needs the report.
  NEWFAIL="$(mktemp "${TMPDIR:-/tmp}/e2e-new.XXXXXX")"; export E2E_NEWFAIL_OUT="$NEWFAIL"
  npx playwright test --reporter=json > "$JSON" 2>"$ERR"
  if [ ! -s "$JSON" ]; then
    echo "e2e: playwright wrote no report. Its stderr:" >&2
    tail -20 "$ERR" >&2
    rm -f "$ERR"; exit 1
  fi
  rm -f "$ERR"
  # set -e stays OFF across the gate: it exits 2 to mean "candidate new failures, go
  # confirm them", and under set -e that non-zero exit would kill the script before the
  # confirm branch below ever ran (it did — the harness just exited 2).
  python3 - "$JSON" "$KNOWN" <<'PY_GATE'
import json, os, sys
report, known_path = sys.argv[1], sys.argv[2]
def walk(node, out):
    for spec in node.get('specs', []):
        if not spec.get('ok', True):
            out.add(spec['file'] + ' :: ' + spec['title'])
    for su in node.get('suites', []):
        walk(su, out)
try:
    d = json.load(open(report))
except Exception as e:
    print('e2e: could not parse the playwright report: %s' % e, file=sys.stderr); sys.exit(1)
actual = set()
for su in d.get('suites', []):
    walk(su, actual)
known = {l.strip() for l in open(known_path) if l.strip() and not l.startswith('#')}
new_fail = sorted(actual - known)
fixed    = sorted(known - actual)
st = d.get('stats', {})
print('e2e: %s passed, %s failed, %s flaky (%d known-failing)'
      % (st.get('expected'), st.get('unexpected'), st.get('flaky'), len(known)), file=sys.stderr)
for t in fixed:
    print('e2e: FIXED — delete this line from %s:\n      %s' % (known_path, t), file=sys.stderr)
if new_fail:
    print('\ne2e: %d candidate NEW failure(s) — confirming (see below):' % len(new_fail), file=sys.stderr)
    for t in new_fail:
        print('      %s' % t, file=sys.stderr)
    # hand the shell the spec files to re-run; a flake and a regression look identical here
    with open(os.environ.get('E2E_NEWFAIL_OUT', '/dev/null'), 'w') as f:
        f.write('\n'.join(sorted({t.split(' :: ')[0] for t in new_fail})))
    sys.exit(2)
print('e2e: no new failures.', file=sys.stderr)
PY_GATE
  GATE=$?
  set -e
  if [ "$GATE" = "2" ]; then
    # A flake and a regression are indistinguishable in the set diff — this suite HAS
    # flakes that fail both retry attempts (observed: the same tree gave 25 failed / 1 NEW
    # then 24 failed / 0 NEW back to back). So confirm: re-run ONLY the suspects with a
    # human reporter. Pass on the focused re-run => flake, say so and don't cry wolf.
    # Fail again => a real regression, and the error lands in the log where it's readable.
    SUSPECTS="$(cat "$NEWFAIL" 2>/dev/null | tr '\n' ' ')"
    echo "" >&2
    echo "e2e: confirming against: $SUSPECTS" >&2
    set +e; npx playwright test $SUSPECTS --reporter=line >&2; RC=$?; set -e
    if [ "$RC" = "0" ]; then
      echo "" >&2
      echo "e2e: those PASSED on a focused re-run => FLAKE, not a regression. Not failing the run." >&2
      echo "e2e: (if this spec flakes repeatedly, fix or quarantine it deliberately.)" >&2
      exit 0
    fi
    echo "" >&2
    echo "e2e: they FAILED again — this is a real regression (error above)." >&2
    exit 1
  fi
  exit $GATE
fi

npx playwright test "$@"
