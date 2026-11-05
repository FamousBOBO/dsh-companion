"""Local, read-only dashboard for the CN Huawei Health account.

    python huawei_dashboard.py serve --port 8765     # 网页 + 手动/自动刷新
    python huawei_dashboard.py bench --runs 5        # 量一遍刷新耗时

Everything it shows comes from the integration's own client
(``custom_components/huawei_health``): daily activity, heart rate / sleep / stress, workouts,
bound devices, the per-source "last updated" stamps the cloud puts on the records, the token's
remaining life, and — for every refresh — how long the whole pull took and how long each cloud
call took. The window can be switched between 3 / 7 / 30 days from the page.

The page listens on 127.0.0.1 only and never shows the tokens: the pair stays in the credential
file outside the repository (``<dataRoot>/credentials/huawei_account.json``, see
``sidecar_paths.py`` / ``$HUAWEI_ACCOUNT_JSON``).
"""

# --- sidecar-freeze provenance (added by sidecars/huawei-health-cn; not upstream) ---
# frozen-from:     local research harness (authors of this sidecar; not upstream)
# frozen-at:       2026-11-03
# upstream-sha256: ca44f47d411f8597d239144228bfb41637ecf5806bcc1609c55117fbcc0b6d12
# code-unchanged:  this block is the only difference; delete these five lines to get the original
# --- end sidecar-freeze provenance ---

from __future__ import annotations

import argparse
import json
import statistics
import threading
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from huawei_login import CLIENT, CONST, STORE, load_tokens

CACHE_TTL = 15.0           # seconds a served snapshot stays fresh
DEFAULT_DAYS = 3
ALLOWED_DAYS = (3, 7, 30)

# getHealthStat family -> 中文名 for the "last updated" table
HEALTH_FAMILIES = {
    "heartRateTotal": "心率",
    "professionalSleepTotal": "睡眠",
    "stressTotal": "压力",
    "exerciseIntensityTotal": "中高强度",
    "bloodOxygenSaturationTotal": "血氧",
}
# The health ids this account's cloud actually answers for. 16 is SpO2, which the upstream
# HEALTH_TYPES table does not list but the CN controller returns.
HEALTH_TYPE_IDS = (7, 9, 11, 12, 16)

_lock = threading.Lock()
_state: dict = {"payload": None, "at": 0.0, "key": None, "history": []}

# ── timing instrumentation on the single transport seam ────────────────────
_original_json_request = CLIENT._json_request
_calls: list[dict] = []


def _timed_json_request(method, url, **kwargs):
    started = time.perf_counter()
    try:
        answer = _original_json_request(method, url, **kwargs)
    except Exception:
        _calls.append({"url": url, "ms": round((time.perf_counter() - started) * 1000, 1),
                       "code": None, "ok": False})
        raise
    _calls.append({"url": url, "ms": round((time.perf_counter() - started) * 1000, 1),
                   "code": answer.get("resultCode") if isinstance(answer, dict) else None,
                   "ok": True})
    return answer


CLIENT._json_request = _timed_json_request


# ── helpers ────────────────────────────────────────────────────────────────
def _text(epoch: float | None, fmt: str = "%Y-%m-%d %H:%M:%S") -> str | None:
    return time.strftime(fmt, time.localtime(epoch)) if epoch else None


def _stamp_from_rows(rows) -> float | None:
    """Newest ms stamp the cloud wrote on a record (``version`` or ``generateTime``)."""
    stamps: list[float] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        for key in ("version", "generateTime", "modifyTime"):
            value = row.get(key)
            if isinstance(value, (int, float)) and value > 1e12:
                stamps.append(value / 1000)
    return max(stamps) if stamps else None


def _merge_spo2(health: list[dict], answer: dict) -> list[dict]:
    """Fold getHealthStat type 16 (血氧) into the per-day rows.

    ``health_series()`` only knows the four families the integration ships with, so the SpO2
    family is merged here instead of touching the integration's shaping.
    """
    rows = {row["date"]: row for row in health}
    for record in (answer or {}).get("bloodOxygenSaturationTotal") or []:
        if not isinstance(record, dict):
            continue
        day = CLIENT.normalize_day(record.get("recordDay"))
        block = record.get("bloodOxygenSaturationBasic") or {}
        if not day or not isinstance(block, dict):
            continue
        row = rows.setdefault(day.isoformat(), {"date": day.isoformat()})
        for key, name in (("avgSaturation", "spo2_avg"), ("maxSaturation", "spo2_max"),
                          ("minSaturation", "spo2_min"), ("lastSaturation", "spo2_last")):
            value = CLIENT.to_float(block.get(key))
            if value and value > 0:
                row[name] = value
    return [rows[key] for key in sorted(rows)]


def _fmt_num(value) -> str:
    """112.0 -> 112, 97.2 -> 97.2 (the cloud sends floats for everything)."""
    if value is None:
        return "—"
    number = float(value)
    return str(int(number)) if number.is_integer() else f"{number:.1f}"


def _sample_value(record: dict) -> tuple[float | None, str]:
    """Read the value out of a ByTime record's samplePoints, whatever stream it is."""
    for point in record.get("samplePoints") or []:
        key, raw = point.get("key"), point.get("value")
        if key == "DATA_POINT_DYNAMIC_HEARTRATE":
            return CLIENT.to_float(raw), "bpm"
        if key == "BLOOD_OXYGEN_SATURATION":
            try:
                return CLIENT.to_float(json.loads(raw).get("avgSaturation")), "%"
            except (TypeError, ValueError):
                return None, ""
        if key == "STRESS_DATA":
            try:
                return CLIENT.to_float(json.loads(raw).get("score")), ""
            except (TypeError, ValueError):
                return None, ""
    return None, ""


# The three streams that carry a per-minute/per-measurement sample: this is the closest the
# cloud gets to "realtime" - what the band uploaded a few minutes ago, not a live BLE reading.
REALTIME_STREAMS = ((7, "心率"), (11, "压力"), (16, "血氧"))


def _realtime(api, day: int) -> dict[str, dict]:
    """Newest sample per stream: value, unit and the stamp it was measured at."""
    out: dict[str, dict] = {}
    for type_id, name in REALTIME_STREAMS:
        try:
            answer = api.health_data(day, day, type_id)
        except CLIENT.HuaweiError:
            continue
        records = [record for rows in (answer.get("data") or {}).values()
                   for record in rows or [] if isinstance(record, dict)]
        records.sort(key=lambda record: record.get("endTime") or 0)
        if not records:
            continue
        last = records[-1]
        value, unit = _sample_value(last)
        if value is None:
            continue
        at = (last.get("endTime") or 0) / 1000
        out[name] = {"value": value, "unit": unit, "at": at, "at_text": _text(at),
                     "rel": _relative(at), "device": last.get("deviceCode")}
    return out


def _sample_text(sample: dict) -> str:
    """'112 bpm @ 18:50' - the unit is optional, the stamp is not."""
    unit = f" {sample['unit']}" if sample.get("unit") else ""
    return f"{_fmt_num(sample['value'])}{unit} @ {sample['at_text'][11:16]}"


# ── one full pull ──────────────────────────────────────────────────────────
def collect(days: int = DEFAULT_DAYS) -> dict:
    """Read everything the integration reads, timing every cloud call."""
    _calls.clear()
    started = time.perf_counter()
    errors: list[str] = []
    sources: list[dict] = []

    def note_source(name: str, rows) -> None:
        stamp = _stamp_from_rows(rows)
        sources.append({"name": name, "ms": stamp, "text": _text(stamp),
                        "rel": _relative(stamp)})

    tokens = load_tokens()
    api = CLIENT.HuaweiHealthClient(tokens)
    today = date.today()
    start_day = int((today - timedelta(days=days - 1)).strftime("%Y%m%d"))
    end_day = int(today.strftime("%Y%m%d"))

    daily: dict[str, dict] = {}
    health: list[dict] = []
    sessions: list[dict] = []
    devices: list[dict] = []

    try:
        rows = api.sports_stat(start_day, end_day).get("sportStat") or []
        daily = CLIENT.daily_totals(CLIENT.daily_activity(rows))
        note_source("活动", rows)
    except CLIENT.HuaweiError as err:
        errors.append(f"活动数据: {err}")

    try:
        answer = api.health_stat(start_day, end_day, types=list(HEALTH_TYPE_IDS))
        health = CLIENT.health_series(answer)
        for family, family_rows in (answer or {}).items():
            if isinstance(family_rows, list) and family_rows:
                note_source(HEALTH_FAMILIES.get(family, family), family_rows)
        health = _merge_spo2(health, answer)
    except CLIENT.HuaweiError as err:
        errors.append(f"健康数据: {err}")

    try:
        # A *ByTime window is capped at ten days by the cloud, so a 30-day view is chunked
        # exactly the way the integration's own sessions() does it.
        records: list[dict] = []
        for window_start, window_end in CLIENT.day_windows(start_day, end_day):
            answer = api.sports_detail(window_start, window_end, CLIENT.SESSION_SPORT_TYPES)
            for rows in (answer.get("data") or {}).values():
                records.extend(record for record in rows or [] if isinstance(record, dict))
        sessions = CLIENT.sport_sessions(records)
        note_source("训练", records)
    except CLIENT.HuaweiError as err:
        errors.append(f"训练数据: {err}")

    try:
        answer = api.bind_devices()
        devices = [device for device in (answer.get("deviceInfos") or [])
                   if isinstance(device, dict)]
        note_source("设备", devices)
    except CLIENT.HuaweiError as err:
        errors.append(f"设备列表: {err}")

    # Realtime: the newest uploaded sample per stream (HR / stress / SpO2), plus the live
    # numbers behind activity, workouts and devices - these land in the 数据源 table's 最新值.
    realtime = _realtime(api, end_day)
    realtime_all = dict(realtime)
    for source in sources:
        sample = realtime.pop(source["name"], None)
        if sample:
            source["rt_text"] = _sample_text(sample)
    for source in sources:
        if source["name"] == "活动" and daily:
            today_row = daily.get(date.today().isoformat()) or daily[max(daily)]
            source["rt_text"] = f"今日 {_fmt_num(today_row.get('steps'))} 步"
        elif source["name"] == "训练" and sessions:
            last = sessions[-1]
            source["rt_text"] = (f"{last['start'].strftime('%m-%d %H:%M')} "
                                 f"{CONST.SPORT_TYPES.get(last['sport_type'], '?')} "
                                 f"{last['duration_min']} min")
        elif source["name"] == "设备":
            source["rt_text"] = f"{len(devices)} 台"
        elif source["name"] == "中高强度":
            today_row = next((row for row in health if row["date"] == date.today().isoformat()),
                             None)
            minutes = (today_row or {}).get("moderate_high_intensity_minutes")
            source["rt_text"] = f"今日 {_fmt_num(minutes)} 分钟" if minutes else "—"
    for name, sample in realtime.items():
        sources.append({
            "name": f"{name}（实时）", "ms": sample["at"], "text": sample["at_text"],
            "rel": sample["rel"], "rt_text": _sample_text(sample)})

    rotated = False
    if tokens.dirty:  # a read may have rotated the pair; the new access token is the live one
        STORE.write_text(json.dumps(tokens.as_dict, indent=2), encoding="utf-8")
        rotated = True

    total_ms = round((time.perf_counter() - started) * 1000, 1)
    synced_at = time.time()
    newest = max((source["ms"] for source in sources if source["ms"]), default=None)

    payload = {
        "synced_at": synced_at,
        "synced_at_text": _text(synced_at),
        "total_ms": total_ms,
        "calls": list(_calls),
        "errors": errors,
        "sources": sorted(sources, key=lambda s: -(s["ms"] or 0)),
        "newest_cloud": newest,
        "newest_cloud_text": _text(newest),
        "daily": [daily[key] for key in sorted(daily)],
        "health": health,
        "sleep_rows": [row for row in health
                       if any(key.startswith("sleep_") for key in row)],
        "sessions": [
            {**{key: value for key, value in session.items() if key not in ("start", "end")},
             "start": session["start"].isoformat() if session.get("start") else None,
             "end": session["end"].isoformat() if session.get("end") else None,
             "sport": CONST.SPORT_TYPES.get(session.get("sport_type"), "未知"),
             "start_text": session["start"].strftime("%m-%d %H:%M") if session.get("start") else None,
             "end_text": session["end"].strftime("%H:%M") if session.get("end") else None}
            for session in sessions
        ],
        "devices": devices,
        "realtime": realtime_all,
        "token": {
            "uid": f"{str(tokens.uid)[:6]}…" if tokens.uid else None,
            "session_host": tokens.session_host,
            "data_host": api.host,
            "expires_at_text": _text(tokens.expires_at),
            "expires_in_min": round((tokens.expires_at - time.time()) / 60)
            if tokens.expires_at else None,
            "refresh_dies_text": _text(tokens.refresh_expires_at),
            "rotated": rotated,
        },
        "scope": {"days": days, "allowed_days": list(ALLOWED_DAYS)},
    }
    _state.update(payload=payload, at=time.time(), key=days)
    _state["history"] = (_state["history"] + [
        {"at": synced_at, "at_text": _text(synced_at, "%H:%M:%S"), "total_ms": total_ms,
         "calls": len(_calls), "days": days, "ok": not errors}])[-20:]
    return payload


def _relative(epoch: float | None) -> str | None:
    if not epoch:
        return None
    seconds = int(time.time() - epoch)
    if seconds < 90:
        return f"{seconds} 秒前"
    if seconds < 5400:
        return f"{seconds // 60} 分钟前"
    if seconds < 86400 * 2:
        return f"{seconds // 3600} 小时前"
    return f"{seconds // 86400} 天前"


def snapshot(force: bool, days: int) -> dict:
    """Serve from cache unless stale, forced, or the window changed; one pull at a time."""
    with _lock:
        current = _state["payload"]
        fresh = (current is not None and _state["key"] == days
                 and (time.time() - _state["at"]) < CACHE_TTL)
        payload = current if (fresh and not force) else collect(days)
        payload = dict(payload)
        payload["cache_age_s"] = round(time.time() - _state["at"], 1)
        payload["cache_ttl_s"] = CACHE_TTL
        payload["history"] = _state["history"]
        payload["server_time_text"] = _text(time.time())
        payload["oauth_base"] = CONST.OAUTH_BASE
        return payload


# ── the page ───────────────────────────────────────────────────────────────
PAGE = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>华为运动健康 · CN 轮廓数据面板</title>
<style>
  :root { color-scheme: dark; --bg:#0f1216; --card:#171c23; --line:#232c37; --fg:#e6edf3;
          --dim:#8b98a7; --ok:#4ec9a5; --warn:#e2b33c; --bad:#e2716b; --accent:#4f9cf9; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px 24px 40px; background:var(--bg); color:var(--fg);
         font:17px/1.62 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  h1 { font-size:23px; margin:0 0 2px; font-weight:600; letter-spacing:.2px; }
  h2 { font-size:15.5px; margin:0 0 10px; color:var(--dim); font-weight:600;
       letter-spacing:.04em; }
  .sub { color:var(--dim); font-size:14px; margin-bottom:16px; }
  .bar { display:flex; flex-wrap:wrap; gap:10px; align-items:stretch; margin-bottom:16px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 16px;
          min-width:148px; }
  .stat .k { font-size:12.5px; color:var(--dim); letter-spacing:.05em; }
  .stat .v { font-size:23px; font-weight:600; margin-top:2px; font-variant-numeric:tabular-nums; }
  .stat .n { font-size:12.5px; color:var(--dim); margin-top:1px; }
  .controls { display:flex; gap:8px; align-items:center; margin-left:auto; }
  button, select { background:#1d2530; color:var(--fg); border:1px solid var(--line);
                   border-radius:8px; padding:9px 14px; font:inherit; font-size:15.5px; cursor:pointer; }
  button:hover, select:hover { border-color:var(--accent); }
  button:disabled { opacity:.5; cursor:progress; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line);
          border-radius:10px; overflow:hidden; font-variant-numeric:tabular-nums; }
  th, td { padding:9px 12px; font-size:15.5px; text-align:right; border-bottom:1px solid var(--line); white-space:nowrap; }
  th:first-child, td:first-child { text-align:left; }
  th { font-size:12.5px; color:var(--dim); font-weight:600; letter-spacing:.04em; background:#1b222b; }
  tr:last-child td { border-bottom:none; }
  td.z { color:#5c6675; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px;
          margin-bottom:16px; overflow:auto; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:16px; }
  .chip { display:inline-flex; gap:6px; align-items:baseline; background:#1d2530;
          border:1px solid var(--line); border-radius:999px; padding:4px 11px; font-size:13px;
          margin:0 6px 6px 0; font-variant-numeric:tabular-nums; }
  .chip b { font-weight:600; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
  .muted { color:var(--dim); }
  .err { border-color:#5a2f2f; background:#221718; color:#f0b6b2; }
  .ts { font-size:13.5px; color:var(--dim); margin-top:8px; line-height:1.7; }
  .src { display:inline-block; min-width:86px; }
</style>
</head>
<body>
<h1>华为运动健康 · CN 轮廓</h1>
<div class="sub" id="hosts">读取中…</div>

<div class="bar">
  <div class="stat"><div class="k">上次同步（页面拉取）</div><div class="v" id="synced">--</div>
    <div class="n" id="syncedAgo">--</div></div>
  <div class="stat"><div class="k">本次刷新耗时</div><div class="v" id="took">--</div>
    <div class="n" id="calls">--</div></div>
  <div class="stat"><div class="k">云端最新数据时间</div><div class="v" id="cloud">--</div>
    <div class="n" id="cloudAgo">记录 version / generateTime</div></div>
  <div class="stat"><div class="k">access token 剩余</div><div class="v" id="tok">--</div>
    <div class="n" id="refresh">--</div></div>
  <div class="controls">
    <select id="days">
      <option value="3">近 3 天</option>
      <option value="7">近 7 天</option>
      <option value="30">近 30 天</option>
    </select>
    <select id="auto">
      <option value="0">不自动刷新</option>
      <option value="30">每 30 秒</option>
      <option value="60" selected>每 60 秒</option>
      <option value="300">每 5 分钟</option>
    </select>
    <button id="go">立即刷新</button>
    <span class="muted" id="countdown"></span>
  </div>
</div>

<div id="errors"></div>

<div class="grid">
  <div class="card">
    <h2>数据源 · 上次更新</h2>
    <div id="sources"></div>
  </div>
  <div class="card">
    <h2>刷新耗时明细</h2>
    <div id="timings"></div>
    <div class="ts" id="history"></div>
  </div>
</div>

<div class="card">
  <h2>每日活动</h2>
  <div id="daily"></div>
</div>

<div class="card">
  <h2>健康指标</h2>
  <div id="health"></div>
</div>

<div class="card">
  <h2>睡眠（专业睡眠 type 9 / 睡眠分段 6·7·8）</h2>
  <div id="sleep"></div>
</div>

<div class="card">
  <h2>训练记录</h2>
  <div id="sessions"></div>
</div>

<div class="card">
  <h2>绑定设备</h2>
  <div id="devices"></div>
</div>

<script>
const DAILY = [
  ["date","日期"], ["steps","步数"], ["distance_m","距离 km",v=>(v/1000).toFixed(2)],
  ["kcal","千卡"], ["duration_min","活动 min"], ["walk_min","步行 min"],
  ["active_hours","活跃小时"], ["exercise_min","中高强度 min"], ["step_goal","步数目标"],
];
const HEALTH = [
  ["date","日期"], ["heart_rate","心率"], ["resting_heart_rate","静息心率"],
  ["max_heart_rate","最高心率"], ["min_heart_rate","最低心率"],
  ["stress_average","压力均值"], ["stress_last","压力最新"], ["stress_max","压力峰值"],
  ["stress_min","压力最低"], ["stress_measurements","压力测量"],
  ["spo2_avg","血氧均值 %"], ["spo2_min","血氧最低"], ["spo2_max","血氧最高"],
  ["moderate_high_intensity_minutes","中高强度 min"],
];
const SLEEP = [
  ["date","日期"], ["sleep_duration","睡眠 min"], ["sleep_deep","深睡 min"],
  ["sleep_light","浅睡 min"], ["sleep_rem","REM min"], ["sleep_awake","清醒 min"],
  ["sleep_score","睡眠评分"], ["sleep_efficiency","效率 %"], ["sleep_latency","入睡 min"],
  ["sleep_wake_ups","醒来次数"], ["sleep_average_heart_rate","睡眠心率"],
  ["sleep_hrv","HRV"], ["sleep_spo2","睡眠血氧 %"], ["fall_asleep","入睡时刻"],
  ["wakeup","醒来时刻"],
];

const cell = (v, fmt) => (v === null || v === undefined || v === "")
  ? '<td class="z">—</td>' : `<td>${fmt ? fmt(v) : v}</td>`;

function table(rows, spec) {
  if (!rows || !rows.length) {
    // 不隐藏列：没有数据时也要把这一块的字段名摆出来，看到的是「—」而不是消失
    const head = spec.map(([, label]) => `<th>${label}</th>`).join("");
    const body = `<tr>${spec.map(() => '<td class="z">—</td>').join("")}</tr>`;
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
           '<div class="ts">该窗口内云端没有返回记录</div>';
  }
  const cols = spec;
  const head = cols.map(([, label]) => `<th>${label}</th>`).join("");
  const body = rows.map(r => "<tr>" + cols.map(([key, , fmt]) => cell(r[key], fmt)).join("") + "</tr>").join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function set(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  if (cls !== undefined) el.className = cls;
}

function renderSleep(d) {
  const rows = d.sleep_rows || [];
  if (rows.length) return table(rows, SLEEP);
  return `<div class="muted" style="margin-bottom:8px">近 ${d.scope.days} 天云端没有返回任何睡眠记录（列不隐藏，值就是「—」）。</div>` +
    table([], SLEEP) +
    `<div class="ts">已逐项验证（2026-11-03 19:20 前后，都是 resultCode 0，不是报错）：<br>` +
    `· getHealthStat type 9（专业睡眠）30 天 / 90 天 → 连 family 都不返回<br>` +
    `· getHealthData（ByTime）type 9 按天 → <code>data: {}</code><br>` +
    `· getSportsDataByTime sportTypes 6/7/8（深睡/浅睡/清醒分段）30 天 → 0 条<br>` +
    `· 同一路由 type 16（血氧）今天有记录、type 7/11/12 也有 → 链路正常<br>` +
    `结论：这个账号的睡眠数据没有上传到云端（云端只有心率 / 压力 / 血氧 / 中高强度），` +
    `手机 App 里的睡眠是从手表本地读的；面板不会把它显示成 0。</div>`;
}

function render(d) {
  document.getElementById("hosts").textContent =
    `OAuth ${d.oauth_base} · 令牌 ${d.token.session_host} · 数据 ${d.token.data_host}` +
    ` · 账号 ${d.token.uid} · 窗口 近 ${d.scope.days} 天`;
  set("synced", d.synced_at_text.slice(11));
  set("syncedAgo", `${d.cache_age_s}s 前拉取 · 缓存 ${d.cache_ttl_s}s`);
  set("took", `${d.total_ms} ms`);
  set("calls", `${d.calls.length} 次云调用 · 服务器 ${d.server_time_text.slice(11)}`);
  set("cloud", d.newest_cloud_text ? d.newest_cloud_text.slice(5) : "—");
  set("cloudAgo", d.sources.length ? d.sources[0].rel + " · " + d.sources[0].name : "—");
  const mins = d.token.expires_in_min;
  set("tok", mins === null ? "—" : `${mins} 分钟`, mins !== null && mins < 10 ? "v warn" : "v");
  set("refresh", `refresh 至 ${d.token.refresh_dies_text ? d.token.refresh_dies_text.slice(0,10) : "—"}`);

  document.getElementById("sources").innerHTML = d.sources.length ? (
    '<table><thead><tr><th>数据源</th><th>最新值（实时）</th><th>记录时间戳</th><th>距今</th>' +
    '</tr></thead><tbody>' +
    d.sources.map(s => `<tr><td class="src">${s.name}</td>` +
      `<td class="${s.rt_text ? "" : "z"}">${s.rt_text ?? "—"}</td>` +
      `<td>${(s.text || "—").slice(5)}</td><td>${s.rel ?? "—"}</td></tr>`).join("") +
    "</tbody></table>") : '<div class="muted">没有数据</div>';

  document.getElementById("daily").innerHTML = table(d.daily, DAILY);
  document.getElementById("health").innerHTML = table(d.health, HEALTH);
  document.getElementById("sleep").innerHTML = renderSleep(d);
  document.getElementById("sessions").innerHTML = d.sessions.length ? (
    '<table><thead><tr><th>开始</th><th>结束</th><th>类型</th><th>时长 min</th>' +
    '<th>距离 m</th><th>千卡</th><th>段</th></tr></thead><tbody>' +
    d.sessions.slice().reverse().map(s => `<tr><td>${s.start_text}</td><td>${s.end_text}</td>` +
      `<td>${s.sport}</td><td>${s.duration_min}</td><td>${s.distance_m}</td>` +
      `<td>${s.kcal}</td><td>${s.segments}</td></tr>`).join("") +
    "</tbody></table>") : '<div class="muted">没有训练记录</div>';
  document.getElementById("devices").innerHTML = d.devices.length ? (
    '<table><thead><tr><th>设备</th><th>productId</th><th>deviceCode</th><th>typeId</th>' +
    '<th>状态</th></tr></thead><tbody>' +
    d.devices.map(x => `<tr><td>${x.name ?? "（未命名）"}</td><td>${x.productId ?? "—"}</td>` +
      `<td>${x.deviceCode ?? "—"}</td><td>${x.deviceTypeId ?? "—"}</td>` +
      `<td>${x.status ?? "—"}</td></tr>`).join("") + "</tbody></table>")
    : '<div class="muted">没有设备</div>';

  const chips = d.calls.map(c => {
    const path = c.url.replace(/^https:\/\/[^/]+/, "");
    const short = path.length > 44 ? path.slice(0, 41) + "…" : path;
    const cls = !c.ok ? "bad" : (c.code && c.code !== 0 ? "warn" : "");
    return `<span class="chip ${cls}"><b>${c.ms} ms</b> ${short} · code ${c.code ?? "—"}</span>`;
  }).join("");
  document.getElementById("timings").innerHTML =
    `<span class="chip"><b>${d.total_ms} ms</b> 合计 · ${d.calls.length} 次调用 · ` +
    `缓存命中约 1 ms</span>` + chips;

  document.getElementById("history").textContent = "最近刷新：" + (d.history || []).slice().reverse()
    .map(h => `${h.at_text} ${h.days}d ${h.total_ms}ms${h.ok ? "" : " (有错误)"}`).join(" · ");

  document.getElementById("errors").innerHTML = (d.errors || []).length
    ? `<div class="card err"><h2>错误</h2><div>${d.errors.map(e => `<div>${e}</div>`).join("")}</div></div>`
    : "";
}

let timer = null, nextAt = 0;
function schedule() {
  if (timer) clearInterval(timer);
  const every = Number(document.getElementById("auto").value);
  nextAt = every ? Date.now() + every * 1000 : 0;
  if (!every) { document.getElementById("countdown").textContent = ""; return; }
  timer = setInterval(() => {
    const left = Math.round((nextAt - Date.now()) / 1000);
    document.getElementById("countdown").textContent = left >= 0 ? `${left}s 后自动刷新` : "刷新中…";
    if (Date.now() >= nextAt) { nextAt = Date.now() + every * 1000; load(false); }
  }, 1000);
}

async function load(force) {
  const btn = document.getElementById("go");
  btn.disabled = true;
  const days = Number(document.getElementById("days").value);
  try {
    const res = await fetch(`/api/data?days=${days}${force ? "&force=1" : ""}`, {cache: "no-store"});
    render(await res.json());
  } catch (err) {
    document.getElementById("errors").innerHTML =
      `<div class="card err"><h2>错误</h2><div>${err}</div></div>`;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("go").addEventListener("click", () => load(true));
document.getElementById("days").addEventListener("change", () => load(true));
document.getElementById("auto").addEventListener("change", schedule);
// 支持 ?days=30&auto=30 这样的直达链接
const params = new URLSearchParams(location.search);
if (params.get("days")) document.getElementById("days").value = params.get("days");
if (params.get("auto")) document.getElementById("auto").value = params.get("auto");
load(false);
schedule();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "HuaweiHealthDashboard/1.0"

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
            return
        if parsed.path == "/api/data":
            query = parse_qs(parsed.query)
            force = query.get("force", ["0"])[0] in ("1", "true", "yes")
            try:
                days = int(query.get("days", [str(DEFAULT_DAYS)])[0])
            except ValueError:
                days = DEFAULT_DAYS
            days = min(max(days, 1), 30)
            try:
                payload = snapshot(force, days)
            except Exception as exc:  # noqa: BLE001 - the page must render, not crash
                payload = {
                    "errors": [f"{type(exc).__name__}: {exc}"], "calls": [], "daily": [],
                    "health": [], "sessions": [], "devices": [], "sources": [], "total_ms": 0,
                    "synced_at": time.time(),
                    "synced_at_text": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "server_time_text": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "cache_age_s": 0, "cache_ttl_s": CACHE_TTL, "history": [],
                    "newest_cloud_text": None,
                    "scope": {"days": days, "allowed_days": list(ALLOWED_DAYS)},
                    "token": {"session_host": None, "data_host": None, "uid": None,
                              "expires_in_min": None, "refresh_dies_text": None},
                    "oauth_base": CONST.OAUTH_BASE,
                }
            self._send(200, json.dumps(payload, ensure_ascii=False,
                                      default=str).encode("utf-8"),
                       "application/json; charset=utf-8")
            return
        self._send(404, b"not found", "text/plain; charset=utf-8")

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:  # keep the console quiet
        if "api/data" in (args[0] if args else ""):
            return
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}", flush=True)


# ── bench: how long does one refresh take ──────────────────────────────────
def bench(runs: int, days: int = DEFAULT_DAYS) -> int:
    totals: list[float] = []
    per_call: dict[str, list[float]] = {}
    print(f"refresh benchmark: {runs} runs, window {days}d")
    for index in range(1, runs + 1):
        payload = collect(days)
        totals.append(payload["total_ms"])
        for call in payload["calls"]:
            path = call["url"].split("://", 1)[1].split("/", 1)[1]
            per_call.setdefault(path, []).append(call["ms"])
        suffix = "" if not payload["errors"] else f"  errors={payload['errors']}"
        print(f"  run {index}: {payload['total_ms']:>7.1f} ms  calls={len(payload['calls'])}{suffix}")
        time.sleep(0.4)

    print(f"\nper refresh: min {min(totals):.1f} · median {statistics.median(totals):.1f} · "
          f"max {max(totals):.1f} · mean {statistics.mean(totals):.1f} ms")
    print("per endpoint (median ms):")
    for path, values in sorted(per_call.items(), key=lambda kv: -statistics.median(kv[1])):
        print(f"  {statistics.median(values):>7.1f}  {path}  (x{len(values)})")

    tokens = load_tokens()
    started = time.perf_counter()
    before = tokens.access_token
    CLIENT.refresh_tokens(tokens)
    elapsed = round((time.perf_counter() - started) * 1000, 1)
    if tokens.dirty:
        STORE.write_text(json.dumps(tokens.as_dict, indent=2), encoding="utf-8")
    print(f"\ntoken refresh call: {elapsed} ms · rotated={tokens.access_token != before} "
          f"· expiry {_text(tokens.expires_at)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--host", default="127.0.0.1")
    bench_cmd = sub.add_parser("bench")
    bench_cmd.add_argument("--runs", type=int, default=5)
    bench_cmd.add_argument("--days", type=int, default=DEFAULT_DAYS)
    args = parser.parse_args()

    if args.command == "bench":
        return bench(args.runs, args.days)

    snapshot(force=True, days=DEFAULT_DAYS)  # warm the cache so the first paint is instant
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"dashboard: http://{args.host}:{args.port}/   (Ctrl+C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopped", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
