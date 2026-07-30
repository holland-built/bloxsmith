#!/usr/bin/env bash
# Runs the SHIPPED `bloxsmith service install|start|status|stop|uninstall` round
# trip against the REAL OS service manager. Nothing else does.
#
# WHY THIS EXISTS. `bloxsmith service install` is what README.md tells every user
# to run, what the Homebrew formula's caveats print, and how the maintainer's own
# :8080 deployment is registered. Nothing anywhere executed it:
#
#   * There is no Go test for runServiceCLI.
#   * install.sh DOES call it -- but only when DO_SERVICE=yes, and install.sh sets
#     DO_SERVICE=no whenever stdin is not a TTY ("non-interactive (CI/piped):
#     never hang, default to no"). CI is never a TTY, so the CI install job has
#     never once reached the service branch.
#   * install.ps1's CI job tests -Uninstall, which shells out to `service
#     uninstall`, but only after an install that never registered a service --
#     so it exercises the not-installed path and nothing more.
#
# That is the exact profile of the three defects this repo found the hard way: a
# broken install.sh, a Windows installer that could not parse, and five SSE
# handlers with no panic guard. All shipped, all unexecuted.
#
# THIS SCRIPT MUST NOT BE RUN ON A MACHINE WITH A REAL BLOXSMITH SERVICE.
# The service name is a fixed constant ("bloxsmith"), so install/uninstall here
# would clobber a real deployment. It refuses to run unless BLOXSMITH_SERVICE_TEST
# is set to "yes-this-machine-is-disposable", which CI sets and a workstation does
# not. That refusal is the whole safety model -- there is no way to scope the
# service name per-run.
#
# Usage: BLOXSMITH_SERVICE_TEST=yes-this-machine-is-disposable bash scripts/service-cli-test.sh
# Exit:  0 all checks passed, 1 a check failed, 2 refused to run.

set -uo pipefail

if [ "${BLOXSMITH_SERVICE_TEST:-}" != "yes-this-machine-is-disposable" ]; then
    cat >&2 <<'EOF'
REFUSED: this test installs, starts, stops and uninstalls a service named
"bloxsmith" -- the same fixed name a real deployment uses. On a machine running
Bloxsmith it would stop and deregister it.

It only runs on a disposable machine (a CI runner). To confirm this machine is
disposable:

  BLOXSMITH_SERVICE_TEST=yes-this-machine-is-disposable bash scripts/service-cli-test.sh
EOF
    exit 2
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
BIN="$WORK/bloxsmith"
PORT_T=8231

pass_count=0
fail_count=0
ok()  { pass_count=$((pass_count + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail_count=$((fail_count + 1)); printf '  FAIL %s\n' "$1"; }

cleanup() {
    # Best effort, then PROVE it. A test that leaves a service registered has
    # changed the machine it ran on, and the next run's "not installed" assertion
    # would fail for the wrong reason.
    "$BIN" service stop      >/dev/null 2>&1
    "$BIN" service uninstall >/dev/null 2>&1
    if "$BIN" service status 2>/dev/null | grep -q "service:  running"; then
        printf '  FAIL cleanup left the service RUNNING\n'
        fail_count=$((fail_count + 1))
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT

echo "building the real binary"
( cd "$REPO/go" && go build -o "$BIN" . ) || { echo "build failed"; exit 1; }

# The service reads its config from the user config dir, never the shell. Point
# the port there so the round trip does not collide with anything on 8080.
CFG_DIR=""
case "$(uname -s)" in
    Darwin) CFG_DIR="$HOME/Library/Application Support/bloxsmith" ;;
    Linux)  CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/bloxsmith" ;;
    *)      echo "SKIP: unsupported platform $(uname -s)"; exit 0 ;;
esac
mkdir -p "$CFG_DIR"
printf 'PORT=%s\n' "$PORT_T" > "$CFG_DIR/.env"
echo "config dir: $CFG_DIR (PORT=$PORT_T)"

# --- 1. before anything: status must say NOT INSTALLED, and exit 0 -----------
# "not installed" is a real answer, not a failure, so it must not exit non-zero:
# a monitoring script would read that as broken.
out="$("$BIN" service status 2>&1)"; code=$?
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q "not installed"; then
    ok "status reports 'not installed' and exits 0 before any install"
else
    bad "status before install: exit $code, output: $out"
fi
# It must also report the port it would use, read the way the SERVICE reads it.
if printf '%s' "$out" | grep -q "port:     $PORT_T"; then
    ok "status reads the port from the service config dir, not the shell"
else
    bad "status did not report PORT=$PORT_T from $CFG_DIR/.env: $out"
fi

# --- 2. install ---------------------------------------------------------------
out="$("$BIN" service install 2>&1)"; code=$?
if [ "$code" -eq 0 ]; then
    ok "service install exited 0"
else
    bad "service install exited $code: $out"
    echo "$out"
fi
if printf '%s' "$out" | grep -q "start it with: bloxsmith service start"; then
    ok "install tells the operator it did NOT start the service"
else
    bad "install did not say the service still needs starting: $out"
fi
# The config path must be named. A service that silently has no API key is the
# single most confusing outcome of this command.
if printf '%s' "$out" | grep -q "config read from:"; then
    ok "install names the config file the service will read"
else
    bad "install did not name the config file: $out"
fi

# --- 3. status must now say STOPPED, not running, not unknown ----------------
out="$("$BIN" service status 2>&1)"; code=$?
if printf '%s' "$out" | grep -q "service:  stopped"; then
    ok "status reports 'stopped' after install (installed but not started)"
elif printf '%s' "$out" | grep -q "service:  running"; then
    bad "status reports 'running' after an install that does not start anything: $out"
else
    bad "status after install: exit $code, output: $out"
fi

# --- 4. start, and prove the SERVER is actually serving ----------------------
# The assertion that matters. `service start` exiting 0 only means the service
# manager accepted the request; it says nothing about whether the process came up
# and bound a port. A start that reports success and serves nothing is the failure
# this whole round trip is for.
out="$("$BIN" service start 2>&1)"; code=$?
if [ "$code" -eq 0 ]; then
    ok "service start exited 0"
else
    bad "service start exited $code: $out"
fi

served=no
for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://localhost:$PORT_T/api/vault/status" 2>/dev/null; then
        served=yes; break
    fi
    sleep 0.5
done
if [ "$served" = yes ]; then
    ok "the started service actually answers HTTP on port $PORT_T"
else
    bad "service start reported success but nothing answered on port $PORT_T after 30s"
    echo "  --- service logs, if any ---"
    sed -n '1,30p' "$CFG_DIR/bloxsmith.err.log" 2>/dev/null
    journalctl --user -u bloxsmith -n 30 --no-pager 2>/dev/null
fi

out="$("$BIN" service status 2>&1)"
if printf '%s' "$out" | grep -q "service:  running"; then
    ok "status reports 'running' while it is running"
else
    bad "status did not report running while the port was answering: $out"
fi
# The URL it prints must be the one that actually works.
if printf '%s' "$out" | grep -q "url:      http://localhost:$PORT_T"; then
    ok "status prints the URL that actually serves"
else
    bad "status printed a URL that is not the serving one: $out"
fi

# --- 5. stop, and prove it actually stopped serving -------------------------
out="$("$BIN" service stop 2>&1)"; code=$?
if [ "$code" -eq 0 ]; then
    ok "service stop exited 0"
else
    bad "service stop exited $code: $out"
fi
stopped=no
for _ in $(seq 1 40); do
    if ! curl -fsS -o /dev/null "http://localhost:$PORT_T/api/vault/status" 2>/dev/null; then
        stopped=yes; break
    fi
    sleep 0.5
done
if [ "$stopped" = yes ]; then
    ok "the port stops answering after stop (it really stopped)"
else
    bad "service stop reported success but port $PORT_T is still answering"
fi

# --- 6. restart must bring it back ------------------------------------------
if "$BIN" service restart >/dev/null 2>&1; then
    ok "service restart exited 0"
else
    bad "service restart failed"
fi
back=no
for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://localhost:$PORT_T/api/vault/status" 2>/dev/null; then
        back=yes; break
    fi
    sleep 0.5
done
if [ "$back" = yes ]; then
    ok "restart brought the service back up and serving"
else
    bad "restart reported success but nothing is serving on port $PORT_T"
fi
"$BIN" service stop >/dev/null 2>&1

# --- 7. uninstall, and prove it is deregistered ------------------------------
out="$("$BIN" service uninstall 2>&1)"; code=$?
if [ "$code" -eq 0 ]; then
    ok "service uninstall exited 0"
else
    bad "service uninstall exited $code: $out"
fi
# The config must be left ALONE and said to be left alone: an uninstall that
# silently deleted the config would take the vault passphrase and API key with it.
if printf '%s' "$out" | grep -q "config left in place"; then
    ok "uninstall says it left the config alone"
else
    bad "uninstall did not state what happened to the config: $out"
fi
if [ -f "$CFG_DIR/.env" ]; then
    ok "the config file really is still there after uninstall"
else
    bad "uninstall DELETED $CFG_DIR/.env"
fi

out="$("$BIN" service status 2>&1)"
if printf '%s' "$out" | grep -q "not installed"; then
    ok "status reports 'not installed' again after uninstall"
else
    bad "status after uninstall: $out"
fi

# --- 8. usage and exit codes -------------------------------------------------
"$BIN" service >/dev/null 2>&1; code=$?
if [ "$code" -eq 0 ]; then ok "bare 'service' prints usage and exits 0"; else bad "bare 'service' exited $code"; fi
"$BIN" service frobnicate >/dev/null 2>&1; code=$?
if [ "$code" -eq 2 ]; then ok "an unknown service subcommand exits 2"; else bad "unknown subcommand exited $code, want 2"; fi

echo
echo "service CLI: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
