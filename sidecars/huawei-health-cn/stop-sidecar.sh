#!/bin/sh
# Stop the sidecar that start-sidecar.sh started — and nothing else. Linux / macOS path.
#
# The PID file is the only source of truth (<data>/logs/huawei-health-cn/sidecar.pid, or
# sidecar-<port>.pid for other ports; --log-dir / $HUAWEI_LOG_DIR override the directory).
# Before killing anything this script verifies that the recorded PID is still alive **and** that
# its command line still names huawei_dashboard.py; a recycled PID or a foreign listener means
# "leave it alone and tell the operator" (exit 2).
#
# Usage:
#   ./stop-sidecar.sh
#   ./stop-sidecar.sh --port 8766 --dry-run
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SUITE_ROOT=$(cd "$HERE/../.." && pwd)

PORT=8765
LOG_DIR="${HUAWEI_LOG_DIR:-}"
DRY_RUN=0
WAIT_SECONDS=15

while [ $# -gt 0 ]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        --port=*) PORT="${1#*=}"; shift ;;
        --log-dir) LOG_DIR="$2"; shift 2 ;;
        --log-dir=*) LOG_DIR="${1#*=}"; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "未知参数: $1（--help 看用法）" >&2; exit 2 ;;
    esac
done

DATA_DIR="${DSH_COMPANION_DATA_DIR:-$SUITE_ROOT/data}"
[ -n "$LOG_DIR" ] || LOG_DIR="$DATA_DIR/logs/huawei-health-cn"
PID_FILE="$LOG_DIR/sidecar.pid"
[ "$PORT" = "8765" ] || PID_FILE="$LOG_DIR/sidecar-$PORT.pid"

say() { printf '  %s\n' "$1"; }

echo "huawei-health-cn sidecar — stop (posix)"

if [ ! -f "$PID_FILE" ]; then
    say "no PID file at $PID_FILE"
    echo "  (if a sidecar is running, it was not started by start-sidecar.sh — find it with: ps aux | grep huawei_dashboard)" >&2
    exit 2
fi

RECORDED_PORT=$(sed -n 's/.*"port" *: *\([0-9]*\).*/\1/p' "$PID_FILE" | head -n 1)
LISTENER_PID=$(sed -n 's/.*"listenerPid" *: *\([0-9]*\).*/\1/p' "$PID_FILE" | head -n 1)
WRAPPER_PID=$(sed -n 's/.*"wrapperPid" *: *\([0-9]*\).*/\1/p' "$PID_FILE" | head -n 1)

if [ -n "$RECORDED_PORT" ] && [ "$RECORDED_PORT" != "$PORT" ]; then
    echo "PID file $PID_FILE records port $RECORDED_PORT but you asked to stop $PORT — refusing." >&2
    exit 2
fi
say "pid file    : $PID_FILE (port ${RECORDED_PORT:-?}, listener ${LISTENER_PID:-?}, wrapper ${WRAPPER_PID:-?})"

verify_ours() {
    pid=$1
    [ -n "$pid" ] && [ "$pid" != "0" ] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    case "$(ps -p "$pid" -o args= 2>/dev/null || true)" in
        *huawei_dashboard.py*) return 0 ;;
        *) return 1 ;;
    esac
}

TARGETS=""
if verify_ours "$LISTENER_PID"; then
    say "verified    : pid $LISTENER_PID is our dashboard"
    TARGETS="$LISTENER_PID"
elif [ -n "$LISTENER_PID" ] && [ "$LISTENER_PID" != "0" ] && kill -0 "$LISTENER_PID" 2>/dev/null; then
    echo "pid $LISTENER_PID is alive but its command line is not huawei_dashboard.py — refusing to kill it." >&2
    echo "its command line: $(ps -p "$LISTENER_PID" -o args= 2>/dev/null || echo '(unreadable)')" >&2
    exit 2
else
    say "listener pid ${LISTENER_PID:-?} is already gone"
fi

if verify_ours "$WRAPPER_PID" && [ "$WRAPPER_PID" != "$LISTENER_PID" ]; then
    say "verified    : wrapper pid $WRAPPER_PID still carries the dashboard command line"
    TARGETS="$TARGETS $WRAPPER_PID"
fi

TARGETS=$(echo "$TARGETS" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
if [ -z "$TARGETS" ]; then
    say "no live process belongs to the PID file — cleaning it up"
    [ "$DRY_RUN" = "1" ] || rm -f "$PID_FILE"
    exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
    say "--dry-run: would stop pid(s) $TARGETS and delete $PID_FILE"
    exit 0
fi

for pid in $TARGETS; do
    kill "$pid" 2>/dev/null || true
done
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while [ "$(date +%s)" -lt "$deadline" ]; do
    alive=0
    for pid in $TARGETS; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [ "$alive" = "0" ] && break
    sleep 0.3
done
for pid in $TARGETS; do
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
done

rm -f "$PID_FILE"
say "stopped     : pid(s) $TARGETS, PID file removed"
echo "sidecar is down."
