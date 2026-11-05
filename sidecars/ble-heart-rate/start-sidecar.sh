#!/bin/sh
# Start the BLE heart-rate sidecar on 127.0.0.1:8151 — Linux / macOS path.
#
# Windows uses `start-sidecar.ps1` (WMI detach + taskkill). This script contains **no** PowerShell,
# WMI or Windows-specific code; it only uses POSIX sh + the Python interpreter.
#
# Usage:
#   ./start-sidecar.sh                     # needs bleak (real hardware)
#   ./start-sidecar.sh --fixture           # replay a synthetic series — no Bluetooth at all
#   PYTHON=/usr/bin/python3.12 ./start-sidecar.sh --name-hint WATCH
#   ./start-sidecar.sh --port 8152 --log-dir /tmp/ble-logs
#
# Guarantees (same as the Windows script, see README):
#   * the listener is 127.0.0.1 and nothing else — there is no flag that can widen it;
#   * the port is checked before launching; a foreign listener is refused, never replaced (exit 2);
#   * the process is detached with setsid (or nohup) and its stdout/stderr go to a log file;
#   * logs + PID file live in <data>/logs/ble-heart-rate, never inside the repository
#     (<data> = $DSH_COMPANION_DATA_DIR or <suite root>/data; --log-dir / $BLE_HEART_RATE_LOG_DIR);
#   * after start the log is scanned for a plaintext Bluetooth address; a hit stops the process
#     (logs may only carry the 8-character addressHash prefix).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SIDECAR_ROOT="$HERE"
SUITE_ROOT=$(cd "$HERE/../.." && pwd)
SCRIPT="$HERE/heart_rate.py"

PORT=8151
LOG_DIR="${BLE_HEART_RATE_LOG_DIR:-}"
PYTHON_BIN="${PYTHON:-}"
FIXTURE=""
ADDRESS=""
NAME_HINT=""
AUTO=0
NO_AUTO_CONNECT=0
ALLOW_ADDRESS_DISPLAY=0
VERBOSE=0
WAIT_SECONDS=40

while [ $# -gt 0 ]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        --port=*) PORT="${1#*=}"; shift ;;
        --log-dir) LOG_DIR="$2"; shift 2 ;;
        --log-dir=*) LOG_DIR="${1#*=}"; shift ;;
        --python) PYTHON_BIN="$2"; shift 2 ;;
        --python=*) PYTHON_BIN="${1#*=}"; shift ;;
        --fixture) FIXTURE="${2:-synthetic-ramp.json}"; shift; [ $# -gt 0 ] && case "$1" in -*) ;; *) shift ;; esac ;;
        --fixture=*) FIXTURE="${1#*=}"; shift ;;
        --address) ADDRESS="$2"; shift 2 ;;
        --address=*) ADDRESS="${1#*=}"; shift ;;
        --name-hint) NAME_HINT="$2"; shift 2 ;;
        --name-hint=*) NAME_HINT="${1#*=}"; shift ;;
        --auto) AUTO=1; shift ;;
        --no-auto-connect) NO_AUTO_CONNECT=1; shift ;;
        --allow-address-display) ALLOW_ADDRESS_DISPLAY=1; shift ;;
        --verbose) VERBOSE=1; shift ;;
        -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "未知参数: $1（--help 看用法）" >&2; exit 2 ;;
    esac
done

DATA_DIR="${DSH_COMPANION_DATA_DIR:-$SUITE_ROOT/data}"
[ -n "$LOG_DIR" ] || LOG_DIR="$DATA_DIR/logs/ble-heart-rate"
PID_FILE="$LOG_DIR/sidecar.pid"
OUT_LOG="$LOG_DIR/sidecar.out.log"
ERR_LOG="$LOG_DIR/sidecar.err.log"
if [ "$PORT" != "8151" ]; then
    PID_FILE="$LOG_DIR/sidecar-$PORT.pid"
    OUT_LOG="$LOG_DIR/sidecar-$PORT.out.log"
    ERR_LOG="$LOG_DIR/sidecar-$PORT.err.log"
fi

say() { printf '  %s\n' "$1"; }

echo "ble-heart-rate sidecar (posix)"

[ -f "$SCRIPT" ] || { echo "sidecar 脚本不存在: $SCRIPT" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# ── interpreter ───────────────────────────────────────────────────────────────────────────────
if [ -z "$PYTHON_BIN" ]; then
    for candidate in "$HERE/.venv/bin/python" "$DATA_DIR/venv/bin/python" python3 python; do
        if command -v "$candidate" >/dev/null 2>&1; then PYTHON_BIN=$(command -v "$candidate"); break; fi
    done
fi
if [ -z "$PYTHON_BIN" ]; then
    echo "python not found. Set PYTHON=/path/to/python3 (3.11+); real-hardware mode needs bleak." >&2
    exit 1
fi
PY_CHECK=$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>&1) || {
    echo "interpreter unusable: $PYTHON_BIN ($PY_CHECK)" >&2
    exit 1
}
case "$PY_CHECK" in 3.*) ;; *) echo "需要 Python 3.11+，当前是 $PY_CHECK" >&2; exit 1 ;; esac
say "python      : $PYTHON_BIN ($PY_CHECK)"

# ── fixture / bleak availability ──────────────────────────────────────────────────────────────
if [ -n "$FIXTURE" ]; then
    RESOLVED="$FIXTURE"
    [ -f "$RESOLVED" ] || RESOLVED="$HERE/fixtures/$FIXTURE"
    [ -f "$RESOLVED" ] || RESOLVED="$HERE/fixtures/$FIXTURE.json"
    if [ ! -f "$RESOLVED" ]; then
        echo "fixture 不存在: $FIXTURE" >&2
        echo "  可用的（fixtures/）: $(ls "$HERE/fixtures" 2>/dev/null | tr '\n' ' ')" >&2
        exit 1
    fi
    say "fixture     : $RESOLVED (回放模式，不需要蓝牙硬件)"
else
    if ! "$PYTHON_BIN" -c 'import bleak' >/dev/null 2>&1; then
        echo "这个解释器里没有 bleak（真机模式需要）：" >&2
        echo "  $PYTHON_BIN -m pip install -r $HERE/requirements.txt" >&2
        echo "  （没有硬件只是想验证协议：加 --fixture，连 bleak 都不需要）" >&2
        exit 1
    fi
    BLEAK_VERSION=$("$PYTHON_BIN" -c 'import importlib.metadata as m; print(m.version("bleak"))' 2>/dev/null || echo "?")
    say "bleak       : $BLEAK_VERSION"
fi

# ── port preflight: never take someone else's listener ────────────────────────────────────────
BUSY=$("$PYTHON_BIN" - "$PORT" <<'PY'
import socket, sys
port = int(sys.argv[1])
s = socket.socket(); s.settimeout(0.4)
try:
    s.connect(("127.0.0.1", port)); print("busy")
except OSError:
    print("free")
finally:
    s.close()
PY
)
if [ "$BUSY" = "busy" ]; then
    if [ -f "$PID_FILE" ] && kill -0 "$(sed -n 's/.*"listenerPid" *: *\([0-9]*\).*/\1/p' "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
        say "已经在跑：127.0.0.1:$PORT（pid file $PID_FILE），什么都没做"
        echo "stop with: $HERE/stop-sidecar.sh --port $PORT"
        exit 0
    fi
    say "端口 $PORT 已被别的进程占用，且不在 $PID_FILE 里 —— 不抢。"
    echo "  要么自己停掉它，要么换端口：$0 --port $((PORT + 1))" >&2
    exit 2
fi

# ── launch detached ───────────────────────────────────────────────────────────────────────────
MODE="lazy（默认：不扫、不自动连、不重连，等 POST /api/connect）"
[ "$AUTO" = "1" ] && MODE="auto（启动就扫、自动连接、断线自动重连）"
say "mode        : $MODE"
say "bind        : 127.0.0.1:$PORT (loopback only，不可改)"
say "logs        : $LOG_DIR"

cd "$HERE"
# No command string is ever built: arguments are passed as an array, so paths with spaces or
# backslashes cannot be re-split by a downstream shell.
set -- "$PYTHON_BIN" "$SCRIPT" --port "$PORT"
[ -n "$FIXTURE" ] && set -- "$@" --fixture "$RESOLVED"
[ -n "$ADDRESS" ] && set -- "$@" --address "$ADDRESS"
[ -n "$NAME_HINT" ] && set -- "$@" --name-hint "$NAME_HINT"
[ "$ALLOW_ADDRESS_DISPLAY" = "1" ] && set -- "$@" --allow-address-display
[ "$AUTO" = "1" ] && set -- "$@" --auto
[ "$NO_AUTO_CONNECT" = "1" ] && set -- "$@" --no-auto-connect
[ "$VERBOSE" = "1" ] && set -- "$@" --verbose

if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >"$OUT_LOG" 2>"$ERR_LOG" &
else
    nohup "$@" >"$OUT_LOG" 2>"$ERR_LOG" &
fi
WRAPPER_PID=$!
cd "$HERE"
say "launched    : pid $WRAPPER_PID (detached)"

# ── wait for the listener ─────────────────────────────────────────────────────────────────────
LISTENER_PID=$("$PYTHON_BIN" - "$PORT" "$WRAPPER_PID" "$WAIT_SECONDS" <<'PY'
import os, socket, sys, time
port, wrapper, wait = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
# `$!` is only a real OS pid on a native shell. Under MSYS/Cygwin/Windows it is a shell-local id,
# so `os.kill` means nothing there — on those we simply poll until the deadline.
native = not (sys.platform.startswith("win") or sys.platform.startswith("msys") or sys.platform.startswith("cygwin"))
deadline = time.time() + wait
while time.time() < deadline:
    s = socket.socket(); s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port)); print(wrapper); break
    except OSError:
        if native:
            try:
                os.kill(wrapper, 0)
            except OSError:
                print(0); break
    finally:
        s.close()
    time.sleep(0.4)
else:
    print(0)
PY
)
if [ "$LISTENER_PID" = "0" ]; then
    echo "sidecar 在 ${WAIT_SECONDS} 秒内没有监听 $PORT。" >&2
    tail -n 20 "$ERR_LOG" >&2 2>/dev/null || echo "  (no stderr log)" >&2
    kill "$WRAPPER_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    exit 1
fi

"$PYTHON_BIN" - "$PID_FILE" "$PORT" "$WRAPPER_PID" "$LISTENER_PID" "$PYTHON_BIN" "$SCRIPT" "$OUT_LOG" "$ERR_LOG" "$FIXTURE" <<'PY'
import json, sys, time
pid_file, port, wrapper, listener, python, script, out_log, err_log, fixture = sys.argv[1:10]
record = {
    "port": int(port), "wrapperPid": int(wrapper), "listenerPid": int(listener), "host": "127.0.0.1",
    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "python": python, "script": script,
    "fixture": fixture or None, "outLog": out_log, "errLog": err_log,
}
with open(pid_file, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2)
    handle.write("\n")
PY
say "pid file    : $PID_FILE (port $PORT, pid $LISTENER_PID)"

# ── self-check: GET /api/health ───────────────────────────────────────────────────────────────
HEALTH=$("$PYTHON_BIN" - "http://127.0.0.1:$PORT/api/health" <<'PY'
import json, sys, time, urllib.request
url = sys.argv[1]
deadline = time.time() + 15
while time.time() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=3) as answer:
            print(answer.read().decode("utf-8", "replace")); break
    except Exception:
        time.sleep(0.3)
else:
    print("")
PY
)
if [ -z "$HEALTH" ]; then
    echo "端口通了但 /api/health 拉不到 —— sidecar 不健康，已停掉。" >&2
    kill "$LISTENER_PID" "$WRAPPER_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    exit 1
fi
say "health      : $HEALTH"

# ── privacy gate: no plaintext Bluetooth address in the logs ─────────────────────────────────
if grep -Eq '([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}' "$OUT_LOG" "$ERR_LOG" 2>/dev/null; then
    echo "日志里出现蓝牙地址明文 —— 已停掉进程。" >&2
    kill "$LISTENER_PID" "$WRAPPER_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "删掉 $LOG_DIR/*.log、修好打印再重试（日志只允许 addressHash 前 8 位）。" >&2
    exit 1
fi
say "privacy     : 日志干净（无蓝牙地址明文）"

echo ""
echo "sidecar 起来了：http://127.0.0.1:$PORT/  (pid $LISTENER_PID)"
echo "  自检（不联网、不开蓝牙）: $PYTHON_BIN $SCRIPT --selftest"
echo "  按需连接一次（要硬件）  : curl -s -X POST \"http://127.0.0.1:$PORT/api/connect\""
echo "  扫一次（要硬件）        : curl -s \"http://127.0.0.1:$PORT/api/devices?scan=1\""
echo "  读当前状态              : curl -s \"http://127.0.0.1:$PORT/api/state\""
echo "  stop                    : $HERE/stop-sidecar.sh"
