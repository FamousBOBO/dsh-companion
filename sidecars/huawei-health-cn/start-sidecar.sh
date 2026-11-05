#!/bin/sh
# Start the frozen CN Huawei Health sidecar on 127.0.0.1:8765 — Linux / macOS path.
#
# Windows uses `start-sidecar.ps1` (WMI detach + taskkill). This script contains **no**
# PowerShell, WMI or Windows-specific code; it only uses POSIX sh + the Python interpreter.
#
# Usage:
#   ./start-sidecar.sh                        # python3 from PATH, port 8765
#   PYTHON=/usr/bin/python3.12 ./start-sidecar.sh
#   ./start-sidecar.sh --port 8766 --log-dir /tmp/hw-logs
#
# Guarantees (same as the Windows script, see README §3):
#   * the listener is 127.0.0.1 and nothing else — there is no flag that can widen it;
#   * the port is checked before launching; a foreign listener is refused, never replaced (exit 2);
#   * the interpreter is whatever you point PYTHON at — this sidecar is standard library only;
#   * logs and the PID file go to <data>/logs/huawei-health-cn, never into the repository
#     (<data> = $DSH_COMPANION_DATA_DIR or <suite root>/data; override with --log-dir / $HUAWEI_LOG_DIR);
#   * the credential file is only ever read by the sidecar process itself — this script prints its
#     path and never reads, copies or echoes it.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SIDECAR_ROOT="$HERE"
SUITE_ROOT=$(cd "$HERE/../.." && pwd)
DASHBOARD="$HERE/python/huawei_dashboard.py"

PORT=8765
LOG_DIR="${HUAWEI_LOG_DIR:-}"
PYTHON_BIN="${PYTHON:-}"
WAIT_SECONDS=30

while [ $# -gt 0 ]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        --port=*) PORT="${1#*=}"; shift ;;
        --log-dir) LOG_DIR="$2"; shift 2 ;;
        --log-dir=*) LOG_DIR="${1#*=}"; shift ;;
        --python) PYTHON_BIN="$2"; shift 2 ;;
        --python=*) PYTHON_BIN="${1#*=}"; shift ;;
        -h|--help)
            sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "未知参数: $1（--help 看用法）" >&2; exit 2 ;;
    esac
done

DATA_DIR="${DSH_COMPANION_DATA_DIR:-$SUITE_ROOT/data}"
[ -n "$LOG_DIR" ] || LOG_DIR="$DATA_DIR/logs/huawei-health-cn"
CREDENTIAL="${HUAWEI_ACCOUNT_JSON:-$DATA_DIR/credentials/huawei_account.json}"
PID_FILE="$LOG_DIR/sidecar.pid"
[ "$PORT" = "8765" ] || PID_FILE="$LOG_DIR/sidecar-$PORT.pid"
OUT_LOG="$LOG_DIR/sidecar.out.log"
ERR_LOG="$LOG_DIR/sidecar.err.log"
[ "$PORT" = "8765" ] || { OUT_LOG="$LOG_DIR/sidecar-$PORT.out.log"; ERR_LOG="$LOG_DIR/sidecar-$PORT.err.log"; }

say() { printf '  %s\n' "$1"; }

echo "huawei-health-cn sidecar (posix)"

[ -f "$DASHBOARD" ] || { echo "frozen dashboard copy missing: $DASHBOARD" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# ── interpreter ───────────────────────────────────────────────────────────────────────────────
if [ -z "$PYTHON_BIN" ]; then
    for candidate in "$HERE/.venv/bin/python" "$DATA_DIR/venv/bin/python" python3 python; do
        if command -v "$candidate" >/dev/null 2>&1; then PYTHON_BIN=$(command -v "$candidate"); break; fi
    done
fi
if [ -z "$PYTHON_BIN" ]; then
    echo "python not found. Set PYTHON=/path/to/python3 (3.11+). This sidecar needs no third-party packages." >&2
    exit 1
fi
say "python      : $PYTHON_BIN ($("$PYTHON_BIN" --version 2>&1))"

# ── is something already listening? ───────────────────────────────────────────────────────────
LISTENER=$("$PYTHON_BIN" - "$PORT" <<'PY'
import socket, sys
port = int(sys.argv[1])
s = socket.socket()
s.settimeout(0.4)
try:
    s.connect(("127.0.0.1", port))
    print("busy")
except OSError:
    print("free")
finally:
    s.close()
PY
)
if [ "$LISTENER" = "busy" ]; then
    if [ -f "$PID_FILE" ] && kill -0 "$(sed -n 's/.*"listenerPid" *: *\([0-9]*\).*/\1/p' "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
        say "already running on 127.0.0.1:$PORT (pid file $PID_FILE) — nothing to do"
        echo "stop with: $(dirname "$0")/stop-sidecar.sh --port $PORT"
        exit 0
    fi
    say "port $PORT is already in use and it is NOT recorded in $PID_FILE."
    echo "  refusing to touch it — stop that process yourself, or pass --port <other>." >&2
    exit 2
fi

# ── launch detached ───────────────────────────────────────────────────────────────────────────
say "bind        : 127.0.0.1:$PORT (loopback only)"
say "credential  : $CREDENTIAL — read by the sidecar process, never by this script"
say "logs        : $LOG_DIR"

cd "$HERE/python"
if command -v setsid >/dev/null 2>&1; then
    setsid "$PYTHON_BIN" "$DASHBOARD" serve --port "$PORT" --host 127.0.0.1 >"$OUT_LOG" 2>"$ERR_LOG" &
else
    # macOS has no setsid(1); nohup + fully redirected stdio is enough to survive this shell.
    nohup "$PYTHON_BIN" "$DASHBOARD" serve --port "$PORT" --host 127.0.0.1 >"$OUT_LOG" 2>"$ERR_LOG" &
fi
WRAPPER_PID=$!
cd "$HERE"
say "launched    : pid $WRAPPER_PID (detached, logs redirected)"

# ── wait for the listener (TCP only — no HTTP, so no cloud call is spent) ─────────────────────
LISTENER_PID=$("$PYTHON_BIN" - "$PORT" "$WRAPPER_PID" "$WAIT_SECONDS" <<'PY'
import os, socket, sys, time
port, wrapper, wait = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
deadline = time.time() + wait
while time.time() < deadline:
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port)); print(wrapper); break
    except OSError:
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
    echo "sidecar did not start listening on $PORT within ${WAIT_SECONDS}s." >&2
    tail -n 20 "$ERR_LOG" >&2 2>/dev/null || echo "  (no stderr log)" >&2
    kill "$WRAPPER_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    exit 1
fi

"$PYTHON_BIN" - "$PID_FILE" "$PORT" "$WRAPPER_PID" "$LISTENER_PID" "$PYTHON_BIN" "$DASHBOARD" "$OUT_LOG" "$ERR_LOG" <<'PY'
import json, sys, time
pid_file, port, wrapper, listener, python, script, out_log, err_log = sys.argv[1:9]
record = {
    "wrapperPid": int(wrapper), "listenerPid": int(listener), "port": int(port), "host": "127.0.0.1",
    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "python": python, "script": script,
    "outLog": out_log, "errLog": err_log,
    "note": "posix launcher: the pid above is the python process that listens (no re-exec on posix)",
}
with open(pid_file, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2)
    handle.write("\n")
PY
say "pid file    : $PID_FILE (pid $LISTENER_PID)"

# ── log hygiene gate ─────────────────────────────────────────────────────────────────────────
if grep -Eq 'DgE[A-Za-z0-9+/=_-]{8,}|accessToken|refreshToken|x-huid' "$OUT_LOG" "$ERR_LOG" 2>/dev/null; then
    echo "token material found in the sidecar logs — stopping the process." >&2
    kill "$LISTENER_PID" "$WRAPPER_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "Delete $LOG_DIR/*.log and investigate before retrying." >&2
    exit 1
fi
say "log hygiene : clean (no token material in stdout/stderr)"

echo ""
echo "sidecar is up: http://127.0.0.1:$PORT/  (pid $LISTENER_PID)"
echo "  probe (costs one cloud pull): curl -s \"http://127.0.0.1:$PORT/api/data?days=7\""
echo "  snapshot (redacted)         : $PYTHON_BIN $SIDECAR_ROOT/capture_snapshot.py"
echo "  contract test (offline)     : $PYTHON_BIN $SIDECAR_ROOT/test_protocol_contract.py"
echo "  redaction tests (offline)   : $PYTHON_BIN $SIDECAR_ROOT/test_redact.py"
echo "  stop                        : $SIDECAR_ROOT/stop-sidecar.sh"
