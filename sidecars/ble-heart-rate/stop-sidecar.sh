#!/bin/sh
# Stop the BLE heart-rate sidecar that start-sidecar.sh started — and nothing else.
#
# The PID file is the only source of truth (<data>/logs/ble-heart-rate/sidecar.pid, or
# sidecar-<port>.pid; --log-dir / $BLE_HEART_RATE_LOG_DIR override the directory). Before killing
# anything this script verifies the recorded PID is still alive **and** that its command line still
# names heart_rate.py; a recycled PID or a foreign listener means "leave it alone" (exit 2).
#
# Linux / macOS path: no PowerShell, no WMI, no taskkill.
#
# Usage:
#   ./stop-sidecar.sh
#   ./stop-sidecar.sh --port 8152 --dry-run
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SUITE_ROOT=$(cd "$HERE/../.." && pwd)

PORT=8151
LOG_DIR="${BLE_HEART_RATE_LOG_DIR:-}"
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
[ -n "$LOG_DIR" ] || LOG_DIR="$DATA_DIR/logs/ble-heart-rate"
PID_FILE="$LOG_DIR/sidecar.pid"
[ "$PORT" = "8151" ] || PID_FILE="$LOG_DIR/sidecar-$PORT.pid"

say() { printf '  %s\n' "$1"; }

echo "ble-heart-rate sidecar — stop (posix)"

if [ ! -f "$PID_FILE" ]; then
    say "没有 PID 文件: $PID_FILE"
    echo "  （如果确实有 sidecar 在跑，它不是 start-sidecar.sh 起的：ps aux | grep heart_rate）" >&2
    exit 2
fi

RECORDED_PORT=$(sed -n 's/.*"port" *: *\([0-9]*\).*/\1/p' "$PID_FILE" | head -n 1)
LISTENER_PID=$(sed -n 's/.*"listenerPid" *: *\([0-9]*\).*/\1/p' "$PID_FILE" | head -n 1)
WRAPPER_PID=$(sed -n 's/.*"wrapperPid" *: *\([0-9]*\).*/\1/p' "$PID_FILE" | head -n 1)

if [ -n "$RECORDED_PORT" ] && [ "$RECORDED_PORT" != "$PORT" ]; then
    echo "PID 文件 $PID_FILE 记的是端口 $RECORDED_PORT，但你要停的是 $PORT —— 拒绝动手。" >&2
    exit 2
fi
say "pid file    : $PID_FILE (port ${RECORDED_PORT:-?}, listener ${LISTENER_PID:-?}, wrapper ${WRAPPER_PID:-?})"

verify_ours() {
    pid=$1
    [ -n "$pid" ] && [ "$pid" != "0" ] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    case "$(ps -p "$pid" -o args= 2>/dev/null || true)" in
        *heart_rate.py*) return 0 ;;
        *) return 1 ;;
    esac
}

TARGETS=""
if verify_ours "$LISTENER_PID"; then
    say "verified    : pid $LISTENER_PID 是本 sidecar"
    TARGETS="$LISTENER_PID"
elif [ -n "$LISTENER_PID" ] && [ "$LISTENER_PID" != "0" ] && kill -0 "$LISTENER_PID" 2>/dev/null; then
    echo "pid $LISTENER_PID 还活着，但命令行不是 heart_rate.py —— 不杀。" >&2
    echo "它的命令行: $(ps -p "$LISTENER_PID" -o args= 2>/dev/null || echo '(unreadable)')" >&2
    exit 2
else
    say "listener pid ${LISTENER_PID:-?} 已经退出"
fi

if verify_ours "$WRAPPER_PID" && [ "$WRAPPER_PID" != "$LISTENER_PID" ]; then
    say "verified    : wrapper pid $WRAPPER_PID 的命令行还带着 heart_rate.py"
    TARGETS="$TARGETS $WRAPPER_PID"
fi

TARGETS=$(echo "$TARGETS" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
if [ -z "$TARGETS" ]; then
    say "PID 文件里没有活着的进程 —— 清掉 PID 文件"
    [ "$DRY_RUN" = "1" ] || rm -f "$PID_FILE"
    exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
    say "--dry-run: 会停 pid(s) $TARGETS 并删掉 $PID_FILE"
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
say "stopped     : pid(s) $TARGETS，PID 文件已删"
echo "sidecar is down."
