#!/usr/bin/env python3
"""First-night sleep acceptance probe — low frequency, read-only, runs once.

    # the morning after the band has synced the night through the phone app
    python sidecars/huawei-health-cn/sleep-first-night-probe.py

    # explicit output path (the default already lands under the suite data directory)
    python sidecars/huawei-health-cn/sleep-first-night-probe.py --out <data>/logs/health/sleep-probe.json

    # no network at all: proves the script, the frozen client copy and the paths are sane
    python sidecars/huawei-health-cn/sleep-first-night-probe.py --dry-run

What it does, in order, and **nothing else**:

1. ``GET http://127.0.0.1:8765/api/data?days=7`` (one HTTP request, the sidecar's own 15 s cache
   applies) and reports what is in ``sleep_rows[]`` / whether any ``sleep_*`` metric appeared in
   ``health[]``.
2. Calls the frozen client **exactly once**: ``health_stat(type=9)`` for the last seven days, to
   see whether the ``professionalSleepTotal`` family answers at all.  It does *not* scan types
   1–32 — a burst of ~40 probe calls is what earns a ``1101 Too Many Requests``.
3. Writes one JSON document with the raw field names, units, timestamps and ``resultCode``,
   redacted through :mod:`redact` (no token, no uid, no device identifiers), to ``--out``
   (default ``<data>/logs/huawei-health-cn/sleep-first-night-probe.json``).

The document is the evidence for the S0–S2 acceptance: ``verdict`` is
``sleep_present`` as soon as a night exists, ``awaiting_first_night`` while it does not.

Cost: **1** cloud call (plus one loopback HTTP request).  One run per morning is far inside the
measured rate limit; do not loop this script.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PYTHON_DIR = HERE / "python"

sys.path.insert(0, str(HERE))
import redact  # noqa: E402  - same directory as this file
import sidecar_paths  # noqa: E402  - same directory as this file

DEFAULT_BASE_URL = "http://127.0.0.1:8765"
#: Never inside the repository: probe output is personal data (`$HUAWEI_LOG_DIR` overrides).
DEFAULT_OUT = sidecar_paths.logs_dir() / "sleep-first-night-probe.json"
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
TIMEOUT_S = 25

#: Units straight out of the sidecar's own field table ("任何 *Time 是毫秒时间戳，睡眠时长是分钟").
#: Anything not listed is reported as ``"unit": "unknown"`` rather than guessed.
SLEEP_FIELD_UNITS: dict[str, str] = {
    "allSleepTime": "min",
    "deepSleepTime": "min",
    "lightSleepTime": "min",
    "dreamTime": "min",
    "awakeTime": "min",
    "sleepLatency": "min",
    "sleepScore": "score",
    "sleepEfficiency": "ratio",
    "wakeupCnt": "count",
    "lastAvgHeartrate": "bpm",
    "lastAvgHrv": "ms?",
    "lastAvgSpO2": "%",
    "fallAsleepTime": "ms-epoch",
    "wakeupTime": "ms-epoch",
}

SLEEP_FAMILY = "professionalSleepTotal"
SLEEP_BLOCK = "professionalSleep"


def _iso_from_ms(value: Any) -> str | None:
    try:
        stamp = float(value)
    except (TypeError, ValueError):
        return None
    if stamp <= 0:
        return None
    if stamp < 1e11:        # seconds, not milliseconds
        stamp *= 1000
    return datetime.fromtimestamp(stamp / 1000).astimezone().isoformat(timespec="seconds")


def _describe_value(name: str, value: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {"value": value, "unit": SLEEP_FIELD_UNITS.get(name, "unknown")}
    if entry["unit"] == "ms-epoch":
        entry["iso"] = _iso_from_ms(value)
    return entry


def _is_loopback(url: str) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return host in LOOPBACK_HOSTS


# ── step 1: the sidecar payload ────────────────────────────────────────────
def probe_api(base_url: str, days: int = 7, timeout: float = TIMEOUT_S) -> dict[str, Any]:
    if not _is_loopback(base_url):
        return {"ok": False, "error": "non-loopback base url refused", "url": base_url}
    url = f"{base_url.rstrip('/')}/api/data?days={days}"
    try:
        with urllib.request.urlopen(  # noqa: S310 - loopback only
                urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=timeout) as answer:
            payload = json.loads(answer.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return {"ok": False, "url": url, "error": f"HTTP {err.code}"}
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        return {"ok": False, "url": url, "error": f"unreachable: {err}"}
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        return {"ok": False, "url": url, "error": f"bad json: {err}"}

    sleep_rows = payload.get("sleep_rows") or []
    health = payload.get("health") or []
    sleep_keys = sorted({key for row in health if isinstance(row, dict)
                         for key in row if key.startswith("sleep_")})
    return {
        "ok": True,
        "url": url,
        "syncedAt": payload.get("synced_at_text"),
        "cacheAgeSeconds": payload.get("cache_age_s"),
        "counts": {key: len(payload.get(key) or []) if isinstance(payload.get(key), list) else None
                   for key in ("daily", "health", "sleep_rows", "sessions", "devices")},
        "sleepRows": [{key: row.get(key) for key in ("date", "sleep_duration", "sleep_deep",
                                                     "sleep_light", "sleep_rem", "sleep_awake",
                                                     "sleep_score", "fall_asleep", "wakeup")}
                      for row in sleep_rows if isinstance(row, dict)],
        "sleepMetricKeysInHealth": sleep_keys,
        "errors": payload.get("errors") or [],
        "newestCloud": payload.get("newest_cloud_text"),
    }


# ── step 2: the one cloud call ─────────────────────────────────────────────
class UpstreamMissing(RuntimeError):
    """The upstream integration is not available — say so, do not traceback."""


def _read_token_pair(store: Path):
    """Load the token pair from the credential file and hand it to the upstream client.

    The upstream ``Tokens`` class is the only accepted shape (the client expects attributes), so the
    file is described here in the same JSON shape the upstream login flow writes.
    """
    raw = json.loads(store.read_text(encoding="utf-8"))
    return _load_upstream()[1].Tokens(**raw)


def _load_upstream():
    """Import the **user's** upstream client/const (this repo ships none — see PROTOCOL-FREEZE §1.1)."""
    package_dir = sidecar_paths.upstream_pkg()
    if package_dir is None or not (package_dir / "client.py").is_file():
        raise UpstreamMissing(
            "找不到上游实现（本仓库因许可证原因不包含它）。请自备一份上游检出，并设置 "
            "HUAWEI_UPSTREAM_PKG=<你的>/custom_components/huawei_health；"
            "只有 --dry-run 可以不需要它。")
    sys.path.insert(0, str(package_dir.parent))
    sys.path.insert(0, str(package_dir))
    import client  # noqa: PLC0415 - deliberately lazy
    import const  # noqa: PLC0415 - deliberately lazy
    return package_dir, client, const


def probe_cloud(days: int = 7, timeout: int = 30) -> dict[str, Any]:
    """One ``health_stat(type=9)`` call through the user's upstream client."""
    package_dir, client, const = _load_upstream()
    store = sidecar_paths.credentials_file()
    today = date.today()
    start_day = int((today - timedelta(days=max(days, 1) - 1)).strftime("%Y%m%d"))
    end_day = int(today.strftime("%Y%m%d"))
    result: dict[str, Any] = {
        "called": True,
        "endpoint": "/dataQuery/health/getHealthStat",
        "types": [9],
        "window": {"startDay": start_day, "endDay": end_day, "days": max(days, 1)},
        "cloudCalls": 1,
        "store": str(store),
    }
    if not Path(store).is_file():
        return {**result, "ok": False, "error": "credential store missing (never printed)"}

    tokens = _read_token_pair(store)
    api = client.HuaweiHealthClient(tokens, timeout=timeout)
    result["dataHost"] = api.host
    try:
        answer = api.health_stat(start_day, end_day, types=[9])
    except client.HuaweiAuthError:
        return {**result, "ok": False,
                "error": "HuaweiAuthError: the pair must be renewed (re-run your upstream login flow)"}
    except client.HuaweiConnectionError as err:
        return {**result, "ok": False, "error": f"connection: {err}"}
    except client.HuaweiError as err:
        # 1101 lives here: report it, do not retry (that is how a burst becomes a lock-out)
        return {**result, "ok": False, "error": f"{type(err).__name__}: {err}"}

    family = answer.get(SLEEP_FAMILY) or []
    records = []
    for record in family:
        if not isinstance(record, dict):
            continue
        block = record.get(SLEEP_BLOCK) or {}
        fields = ({name: _describe_value(name, value) for name, value in block.items()}
                  if isinstance(block, dict) else {})
        records.append({
            "recordDay": record.get("recordDay"),
            "timeZone": record.get("timeZone"),
            "deviceCode": record.get("deviceCode"),      # numbers only, no device identifier
            "version": {"raw": record.get("version"), "iso": _iso_from_ms(record.get("version"))},
            "block": SLEEP_BLOCK,
            "fieldNames": sorted(fields),
            "fields": fields,
        })

    return {**result, "ok": True,
            "resultCode": answer.get("resultCode"),
            "resultDesc": answer.get("resultDesc"),
            "topKeys": sorted(answer),
            "familyPresent": bool(family),
            "recordCount": len(records),
            "records": records,
            "note": ("professionalSleepTotal 未返回：账号云端仍无睡眠族"
                     if not family else "professionalSleepTotal 已返回：首夜睡眠到云了")}


# ── the document ───────────────────────────────────────────────────────────
def build_document(base_url: str, days: int, api_answer: dict[str, Any],
                   cloud_answer: dict[str, Any] | None) -> dict[str, Any]:
    api_sleep = bool(api_answer.get("ok") and
                     (api_answer.get("sleepRows") or api_answer.get("sleepMetricKeysInHealth")))
    cloud_sleep = bool(cloud_answer and cloud_answer.get("ok")
                       and cloud_answer.get("familyPresent"))
    if api_sleep or cloud_sleep:
        verdict = "sleep_present"
    elif cloud_answer is not None and not cloud_answer.get("ok") and "Auth" in str(
            cloud_answer.get("error", "")):
        verdict = "blocked_auth"
    elif api_answer.get("ok") and cloud_answer is not None and cloud_answer.get("ok"):
        verdict = "awaiting_first_night"
    else:
        verdict = "probe_incomplete"

    notes: list[str] = []
    if verdict == "awaiting_first_night":
        notes.append("云端仍无睡眠：手表要在手机 App 里完成一次同步，type 9 才会出现（README §10.1）")
    if verdict == "probe_incomplete":
        notes.append("有一路探测失败，先看 steps 里的 error；不要重跑，等下一轮窗口")
    if api_answer.get("ok") and not api_answer.get("sleepRows"):
        notes.append("sleep_rows 为空是账号现状，不是解析错误：errors 也为空即视为「没有数据」")

    return {
        "probe": "sleep-first-night",
        "probeVersion": 1,
        "startedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "readOnly": True,
        "cloudCalls": 1 if cloud_answer is not None else 0,
        "baseUrl": base_url,
        "windowDays": days,
        "verdict": verdict,
        "steps": {"apiData": api_answer, "professionalSleep": cloud_answer},
        "notes": notes,
        "howToRead": {
            "sleep_present": "首夜已到云：S0–S2 可以开始对阶段/时长做验收",
            "awaiting_first_night": "首夜未到云：睡眠能力保持 awaiting_first_night，不算故障",
            "blocked_auth": "令牌需要重新登录（用你自己的上游登录流程重新取一对）",
            "probe_incomplete": "至少一路失败：先修链路再谈睡眠",
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="One-shot read-only sleep acceptance probe (sidecar + one type=9 call).")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help=f"output path (default {DEFAULT_OUT})")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="loopback sidecar base url")
    parser.add_argument("--days", type=int, default=7, help="window in days (default 7)")
    parser.add_argument("--timeout", type=float, default=TIMEOUT_S, help="squarely, seconds")
    parser.add_argument("--dry-run", action="store_true",
                        help="no network: check paths, the frozen copy and the plan")
    args = parser.parse_args(argv)

    out = Path(args.out)
    if args.dry_run:
        store = sidecar_paths.credentials_file()
        package_dir = sidecar_paths.upstream_pkg()
        print("dry run - nothing is sent")
        print(f"  sidecar      : {args.base_url}/api/data?days={args.days}"
              f" (loopback ok: {_is_loopback(args.base_url)})")
        print(f"  upstream pkg : {package_dir or '(未配置 HUAWEI_UPSTREAM_PKG — 本仓库不含上游实现)'}")
        print(f"  client copy  : "
              f"{'present' if package_dir and (package_dir / 'client.py').is_file() else 'MISSING'}")
        print(f"  credential   : {store} (exists: {store.is_file()}, contents never read here)")
        print(f"  planned      : 1 HTTP GET + 1 cloud call health_stat(type=9)")
        print(f"  would write  : {out}")
        print(f"  sleep family : {SLEEP_FAMILY} / block {SLEEP_BLOCK}")
        return 0

    try:
        api_answer = probe_api(args.base_url, args.days, args.timeout)
        cloud_answer = probe_cloud(args.days, timeout=int(args.timeout) + 5)
    except UpstreamMissing as err:
        # 明确可操作的中文提示 + 非零退出码：不抛栈、不假装成功。
        print(f"REFUSED: {err}", file=sys.stderr)
        print("  （只想检查路径与计划：加 --dry-run，它不需要上游实现）", file=sys.stderr)
        return 5
    document = redact.redact_payload(build_document(args.base_url, args.days, api_answer,
                                                    cloud_answer))
    document["finishedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")

    try:
        text = redact.dumps(document)             # asserts the redaction contract first
    except redact.RedactionError as err:
        print(f"REFUSED: redaction contract violated, nothing written\n{err}", file=sys.stderr)
        return 4

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")

    print(f"verdict   : {document['verdict']}")
    print(f"cloud     : 1 call, type=9, window {cloud_answer.get('window')}")
    print(f"family    : {SLEEP_FAMILY} present={cloud_answer.get('familyPresent')} "
          f"records={cloud_answer.get('recordCount')} resultCode={cloud_answer.get('resultCode')}")
    print(f"sidecar   : sleep_rows={api_answer.get('counts', {}).get('sleep_rows')} "
          f"health={api_answer.get('counts', {}).get('health')}")
    for note in document["notes"]:
        print(f"note      : {note}")
    print(f"written   : {out}")
    return 0 if document["verdict"] in ("sleep_present", "awaiting_first_night") else 1


if __name__ == "__main__":
    raise SystemExit(main())
