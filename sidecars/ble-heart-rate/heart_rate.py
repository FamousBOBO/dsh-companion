#!/usr/bin/env python3
"""BLE 心率广播接收端（Pulse Bond / 心跳共振 · P1 sidecar）。

一个只在回环上跑的 HTTP 进程，把蓝牙 HRS（Heart Rate Service，service ``0x180D``，
characteristic ``0x2A37``，可选 ``0x2A38`` 传感器位置）的读数变成 JSON 给上层拉。

契约：``design/pulse-bond-20261103.md`` §3（本文件只实现 sidecar 那一层，不做档位/基线/
RMSSD 之类的派生统计 —— 那些在 Node 侧算）。

约定（与契约一致，别自己改字段名）：

    GET  /api/health      {ok, version, port, connected, uptimeSec, fixture}
    GET  /api/state       §3.2 的 13 个字段
    GET  /api/devices     {ok, scannedAt, devices:[{label, addressHash, rssi, hasHrs}]}
    POST /api/connect     {address?, nameHint?} -> {ok, connected}
    POST /api/disconnect  {}                     -> {ok, connected}

硬规矩：

* 绑定地址是 **127.0.0.1 硬编码**，没有 ``--bind``，不可能被参数放大到局域网。
* 端口被占用即退出码 2，绝不抢占别人的监听。
* 日志里不出现任何 MAC/蓝牙地址明文，只允许 ``addressHash`` 的前 8 位；
  连 WinRT 异常文本里带出来的地址也会被 ``scrub()`` 抹掉。
* 任何未预期异常都**不会**变成 HTTP 500。统一回
  ``{"ok": false, "code": "internal", "message": "读取心率数据时出了点问题。"}``（HTTP 200）。
* ``--fixture`` 模式不需要 bleak、不需要蓝牙硬件，``sampleAt`` 跟着真实时钟走，
  所以 ``sampleAgeMs`` 一直是小的 —— 上层可以在任何机器上跑验收。

用法：

    python heart_rate.py                                  # 自动扫描 0x180D 并连第一个
    python heart_rate.py --name-hint WATCH                # 只看名字里带 WATCH 的
    python heart_rate.py --address 3f9a1c2d7b0e4411      # 按 addressHash 前缀挑（推荐）
    python heart_rate.py --fixture fixtures/synthetic-ramp.json   # 无硬件回放
    python heart_rate.py --selftest                       # 只跑 0x2A37 解析自检，不联网
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

VERSION = "1.0.0"

DEFAULT_PORT = 8151
# 8765 是华为健康 sidecar，8139 是 GPU 网关：8151 是本工位独占的端口。
# 绑定地址硬编码，任何参数都改不了它。
BIND_HOST = "127.0.0.1"

HRS_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb"
HR_MEASUREMENT_UUID = "00002a37-0000-1000-8000-00805f9b34fb"
BODY_SENSOR_LOCATION_UUID = "00002a38-0000-1000-8000-00805f9b34fb"

SENSOR_LOCATIONS = {
    0: "other",
    1: "chest",
    2: "wrist",
    3: "finger",
    4: "hand",
    5: "ear-lobe",
    6: "foot",
}

RR_KEEP = 30             # /api/state 的 rrMs 最多 30 个
SPARSE_AFTER_MS = 5000   # 连续两次通知间隔 > 5 s -> quality=sparse
BACKOFF_START = 1.0      # 断线重连退避：1s -> 30s
BACKOFF_MAX = 30.0
MAX_ERROR_LOG_EVERY = 30.0  # 同类内部错误最多 30 s 记一次，避免 1 Hz 轮询把日志刷爆

INTERNAL_MESSAGE = "读取心率数据时出了点问题。"

# 按需连接（POST /api/connect）失败时的固定中文句
_CONNECT_MESSAGES = {
    "device-not-found": "没有找到心率广播设备（确认设备上已打开「心率广播」，且没被其它设备连着）。",
    "connect-timeout": "连接超时（设备在广播但没连上，靠近一点再试）。",
    "connect-failed": "连接设备失败（信号、配对或被占用）。",
}

# 地址明文只允许出现在内存里。日志/异常文本一律先过 scrub()。
_MAC_RE = re.compile(
    r"\b(?:[0-9A-Fa-f]{2}([:-]))(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}\b"
)


def now_ms() -> int:
    return int(time.time() * 1000)


def ensure_utf8_stdio() -> None:
    """日志文件一律 UTF-8（Windows 控制台默认 cp936，管道里会让中文变成乱码）。

    start-sidecar.ps1 用 ``-Encoding utf8`` 读日志，两边对得上。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass


def address_hash(address: str | None) -> str | None:
    """sha256(address) 前 16 hex —— 契约 §3.2 的 addressHash。无地址则 None。"""
    if not address:
        return None
    digest = hashlib.sha256(str(address).strip().lower().encode("utf-8")).hexdigest()
    return digest[:16]


def scrub(text: str) -> str:
    """把文本里的 MAC 类地址换成 hash 前 8 位。日志的唯一安全入口。"""
    def _repl(match: re.Match) -> str:
        return "ble:" + (address_hash(match.group(0)) or "")[:8]
    return _MAC_RE.sub(_repl, str(text))


def log(message: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
    try:
        sys.stdout.write(f"[{stamp}] {scrub(message)}\n")
        sys.stdout.flush()
    except Exception:
        pass


# ────────────────────────────── 0x2A37 解析（§3.5） ──────────────────────────────
#
# 按 Bluetooth SIG HRS 规范逐位解析（这是唯一能让真机跑起来的读法）：
#
#   flags bit0 : 0 = bpm 是 uint8，1 = uint16LE
#   flags bit1 : 传感器接触 *能力*（0 = 不支持，1 = 支持）
#   flags bit2 : 传感器接触 *状态*（仅在 bit1=1 时有效；1 = 有接触）
#   flags bit3 : energy expended 存在（uint16LE，2 字节，跳过）
#   flags bit4 : RR 间期存在（uint16LE × n，单位 1/1024 s！）
#
# 注意：契约草案里把接触位写成"bit1/bit2 是 1-based"，又把 energy/RR 写成 bit2/bit3，
# 两套编号混在一起。真机发的是 flags=0x10 之类（RR 在 bit4），照草案的字面编号读会把
# RR 当 energy 跳掉、把 energy 当 RR 读。这里按 SIG 规范实现，并已在 README §6 记录。

def parse_hr_measurement(data: bytes) -> dict:
    """解析 0x2A37 的一帧。返回 {bpm, contact, rrMs, energyExpended, flags}。

    截断的帧不抛异常：能读到多少算多少（真机上偶发短帧不该让整条链路抖）。
    """
    if not data:
        raise ValueError("empty heart rate measurement")
    flags = data[0]
    offset = 1

    bpm = None
    if flags & 0x01:                      # bit0: uint16 bpm
        if len(data) >= offset + 2:
            bpm = int.from_bytes(data[offset:offset + 2], "little")
            offset += 2
        else:
            offset = len(data)
    else:                                  # bit0: uint8 bpm
        if len(data) >= offset + 1:
            bpm = data[offset]
        offset += 1

    contact_supported = bool(flags & 0x02)
    contact_detected = bool(flags & 0x04)
    if contact_supported:
        contact = "yes" if contact_detected else "no"
    else:
        contact = "unsupported"

    energy = None
    if flags & 0x08:                       # bit3: energy expended（2 字节，跳过）
        if len(data) >= offset + 2:
            energy = int.from_bytes(data[offset:offset + 2], "little")
        offset += 2

    rr_ms: list[int] = []
    if flags & 0x10:                       # bit4: RR 间期，单位 1/1024 s
        while offset + 2 <= len(data):
            raw = int.from_bytes(data[offset:offset + 2], "little")
            offset += 2
            if raw <= 0:
                continue
            # 1/1024 s -> ms
            value = int(round(raw * 1000.0 / 1024.0))
            if 0 < value <= 10000:
                rr_ms.append(value)

    return {"bpm": bpm, "contact": contact, "rrMs": rr_ms,
            "energyExpended": energy, "flags": flags}


# ────────────────────────────── 设备状态中心 ──────────────────────────────

class PulseHub:
    """唯一的读数/连接状态持有者；HTTP 线程和 BLE 线程都只通过它读写。"""

    def __init__(self, args: argparse.Namespace):
        self.port = int(args.port)
        self.verbose = bool(args.verbose)
        self.fixture_path = args.fixture
        self.fixture_mode = bool(args.fixture)
        self.scan_timeout = max(2.0, float(args.scan_timeout))
        self.connect_timeout = max(4.0, float(args.connect_timeout))
        # 默认完全懒：不扫描、不自动连接、不后台重连。只有 --auto 才回到旧行为。
        self.auto_mode = bool(getattr(args, "auto", False))
        self.allow_address_display = bool(args.allow_address_display)
        self.name_hint = (args.name_hint or "").strip() or None
        self.target_address = None          # 真地址，只在内存里
        self.target_hash = None
        self._given_address = (args.address or "").strip() or None
        # 用户显式指定的地址不能被自动丢掉；自动扫出来的地址连续失败 3 次后清掉重扫
        self._address_from_user = bool(self._given_address)
        # 新的 connect 请求会让重连退避立刻醒来（不用等完 30 s）
        self._connect_epoch = 0
        # 扫描次数计数器：/api/health 暴露成 scanCount，用来证明"没请求就不扫"
        self.scan_count = 0
        # 上一次 /api/devices 的结果（不带 scan=1 时直接返回它，不扫）
        self._last_devices: dict | None = None
        # 懒模式下当前持有的连接（只在 bridge 事件循环里操作）
        self._client = None
        self._monitor_task = None
        # 串行化按需连接：两个 HTTP 请求同时来也只扫一轮
        self._connect_lock = threading.Lock()

        self.started_monotonic = time.monotonic()
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._want = threading.Event()

        # ── /api/state 的原始字段 ──
        self.connected = False
        self.device_label: str | None = None
        self.device_hash: str | None = None
        self.bpm: int | None = None
        self.rr: deque[int] = deque(maxlen=RR_KEEP)
        self.contact = "unsupported"
        self.sensor_location: str | None = None
        self.sample_at: int | None = None
        self.last_notify_ms: int | None = None
        self.last_error_code: str | None = None
        self.scanning = False
        self.scanning_at: int | None = None

        # ── 一次性动作的结果回执（供 /api/connect 阻塞等结果） ──
        self._connect_done = threading.Event()
        self._connect_result: tuple[bool, str | None, str | None] | None = None
        self._disconnect_done = threading.Event()

        # ── fixture ──
        self.fixture: dict | None = None
        self._fixture_index = 0
        # 回放循环吐过一帧的凭据：/api/connect 要等它，别做乐观应答
        self._replay_tick = threading.Event()

        self._error_log_at: dict[str, float] = {}
        self._ble_loop = None
        self._ble_thread: threading.Thread | None = None

    # ── 日志 ────────────────────────────────────────────────────────────
    def log(self, message: str) -> None:
        log(message)

    def log_error(self, tag: str, exc: BaseException) -> None:
        """同一 tag 最多 30 s 记一次；文本一定过 scrub()。"""
        current = time.monotonic()
        last = self._error_log_at.get(tag, 0.0)
        if current - last < MAX_ERROR_LOG_EVERY:
            return
        self._error_log_at[tag] = current
        detail = scrub(f"{type(exc).__name__}: {exc}")[:300]
        self.log(f"error[{tag}] {detail}")

    # ── 读数写入 ────────────────────────────────────────────────────────
    def ingest(self, *, bpm, rr_ms, contact, sensor_location, at_ms) -> None:
        with self._lock:
            self.last_notify_ms = at_ms
            if bpm is not None and int(bpm) > 0:   # 契约：bpm 不许写 0
                self.bpm = int(bpm)
                self.sample_at = at_ms
            for value in rr_ms or []:
                if 0 < int(value) <= 5000:
                    self.rr.append(int(value))
            if contact in ("yes", "no", "unsupported"):
                self.contact = contact
            if sensor_location is not None:
                self.sensor_location = sensor_location

    def ingest_hr_frame(self, data: bytes, at_ms: int | None = None) -> None:
        parsed = parse_hr_measurement(data)
        self.ingest(bpm=parsed["bpm"], rr_ms=parsed["rrMs"],
                    contact=parsed["contact"], sensor_location=None,
                    at_ms=at_ms if at_ms is not None else now_ms())

    # ── 契约接口 ────────────────────────────────────────────────────────
    def health(self) -> dict:
        with self._lock:
            connected = bool(self.connected)
            scans = int(self.scan_count)
        return {
            "ok": True,
            "version": VERSION,
            "port": self.port,
            "connected": connected,
            "uptimeSec": int(max(0.0, time.monotonic() - self.started_monotonic)),
            "fixture": bool(self.fixture_mode),
            # 自 2026-11-04 新增：累计扫描次数。懒模式下它应该一直是 0，
            # 直到有人 POST /api/connect 或 GET /api/devices?scan=1（验收靠它量化"不扫"）。
            "scanCount": scans,
        }

    def state(self) -> dict:
        with self._lock:
            current = now_ms()
            sample_age = None if self.sample_at is None else max(0, current - self.sample_at)
            if self.contact == "no":
                quality = "no-contact"
            elif self.last_notify_ms is not None and current - self.last_notify_ms > SPARSE_AFTER_MS:
                quality = "sparse"
            else:
                quality = "ok"
            return {
                "ok": True,
                "connected": bool(self.connected),
                "deviceLabel": self.device_label,
                "addressHash": self.device_hash,
                # 契约：只在真收到 0x2A37 通知时非 null，断线后保留最后读数
                "bpm": self.bpm,
                "rrMs": list(self.rr),
                "contact": self.contact,
                "sensorLocation": self.sensor_location,
                "sampleAt": self.sample_at,
                "sampleAgeMs": sample_age,
                "quality": quality,
                "lastErrorCode": self.last_error_code,
                "scanning": bool(self.scanning),
            }

    def devices(self, scan: bool = False) -> dict:
        """``scan=True``（HTTP 的 ``?scan=1``）才真扫一轮；否则返回上一次的结果。

        懒模式的默认路径**不扫描**：上层如果不带 ``scan=1``，拿到的永远是缓存
        （没扫过就是空列表 + ``scannedAt: null``）。诊断/手动排障才显式触发扫描。
        """
        if not scan:
            with self._lock:
                cached = self._last_devices
            if cached is None:
                return {"ok": True, "scannedAt": None, "devices": []}
            return cached

        scanned_at = now_ms()
        if self.fixture_mode:
            self._count_scan()
            result = {"ok": True, "scannedAt": scanned_at, "devices": [self._fixture_device_entry()]}
            with self._lock:
                self._last_devices = result
            return result

        self._mark_scanning(True)
        try:
            candidates = self._scan_blocking(self.scan_timeout, hrs_only=False)
        except Exception as exc:
            self.log_error("devices", exc)
            candidates = []
        finally:
            self._mark_scanning(False)

        entries = []
        for item in candidates:
            entry = {
                "label": item.get("label"),
                "addressHash": address_hash(item.get("address")),
                "rssi": item.get("rssi"),
                "hasHrs": bool(item.get("hasHrs")),
            }
            if self.allow_address_display:
                entry["address"] = item.get("address")
            entries.append(entry)
        result = {"ok": True, "scannedAt": scanned_at, "devices": entries}
        with self._lock:
            self._last_devices = result
        return result

    def connect(self, address: str | None, name_hint: str | None) -> dict:
        """按需连接的唯一入口。

        **懒模式（默认）**：扫一轮（0x180D 过滤 + nameHint/address），选第一个匹配，连接并订阅
        `0x2A37`，总预算 ``--connect-timeout``（默认 12 s）。连上后**不做后台重连**：
        断线只把状态改成 `disconnected`，等人再调一次 /api/connect。

        **--auto（旧行为）**：仍然把连接交给常驻 worker + 退避重连。

        已连着时直接返回成功，不再扫 —— 因为已连接的外设会停止广播，扫也扫不到它自己。
        """
        started = time.monotonic()
        hint = (name_hint or "").strip() or self.name_hint
        target = (address or "").strip() or None

        if self.fixture_mode:
            if hint:
                self.name_hint = hint
            # 真机按需连接会扫一轮再连；回放模式没有 BLE 扫描器，这里如实记一次
            # "模拟扫描"，让上层/验收在离线环境下也能验证"connect 只触发一次扫描"。
            if not self.auto_mode:
                self._count_scan()
            # 等回放真的开始吐帧再回 connected:true（最多 3 s）。乐观应答会让上层紧接着的
            # /api/state 看到 connected:false —— 那是 Lead 2026-11-03 复现出来的竞态。
            if not self._fixture_begin(wait=True):
                with self._lock:
                    self.last_error_code = "connect-failed"
                return {"ok": False, "code": "connect-failed",
                        "message": "回放没有在 3 秒内恢复。",
                        "elapsedMs": int((time.monotonic() - started) * 1000)}
            with self._lock:
                connected = bool(self.connected)
                label = self.device_label
                digest = self.device_hash
            if not connected:
                return {"ok": False, "code": "connect-failed",
                        "message": "回放已恢复但状态还没落定，请重试。",
                        "elapsedMs": int((time.monotonic() - started) * 1000)}
            return {"ok": True, "connected": True, "deviceLabel": label,
                    "addressHash": digest, "elapsedMs": int((time.monotonic() - started) * 1000)}

        if not self.auto_mode:
            return self._connect_on_demand(hint, target, started)

        # ── 以下为 --auto 的旧路径 ──
        with self._lock:
            self._connect_result = None
            self._connect_done.clear()
            self._disconnect_done.clear()
            self._connect_epoch += 1      # 打断可能正在退避的 worker
            if target:
                if _looks_like_hash(target):
                    self.target_hash = target.lower()
                    self.target_address = None
                else:
                    self.target_address = target
                    self.target_hash = address_hash(target)
                self._address_from_user = True
            if hint:
                self.name_hint = hint
        self._want.set()

        # 等第一次尝试的结果（worker 会在成功/失败后回执）。超时也算失败，但别让它 500。
        timeout = min(60.0, self.scan_timeout + self.connect_timeout + 10.0)
        if not self._connect_done.wait(timeout):
            with self._lock:
                self.last_error_code = "connect-failed"
            return {"ok": False, "code": "connect-timeout",
                    "message": f"{int(timeout)} 秒内没有连上设备。",
                    "elapsedMs": int((time.monotonic() - started) * 1000)}
        with self._lock:
            result = self._connect_result
            label = self.device_label
            digest = self.device_hash
        if result and result[0]:
            return {"ok": True, "connected": True, "deviceLabel": label, "addressHash": digest,
                    "elapsedMs": int((time.monotonic() - started) * 1000)}
        code = (result[1] if result else None) or "connect-failed"
        message = (result[2] if result else None) or "连接设备失败。"
        return {"ok": False, "code": code, "message": message,
                "elapsedMs": int((time.monotonic() - started) * 1000)}

    # ── 懒模式：按需连接（一次扫描 + 一次连接，不重连） ──────────────────
    def _connect_on_demand(self, hint: str | None, target: str | None, started: float) -> dict:
        elapsed = lambda: int((time.monotonic() - started) * 1000)  # noqa: E731

        with self._lock:
            # 已经连着就直接复用，绝不为此再扫一轮（已连接的外设不广播，扫也白扫）
            if self.connected and not target:
                return {"ok": True, "connected": True, "deviceLabel": self.device_label,
                        "addressHash": self.device_hash, "elapsedMs": elapsed()}

        if not self._connect_lock.acquire(timeout=2.0):
            return {"ok": False, "code": "connect-failed",
                    "message": "另一个连接请求正在进行。", "elapsedMs": elapsed()}
        try:
            # 同一时刻只允许一条连接：先把旧连接放掉，避免两个客户端抢同一个外设
            if self.connected or self._client is not None:
                self._close_current_connection()
            deadline = started + self.connect_timeout
            if self._ble_loop is None:
                return {"ok": False, "code": "connect-failed",
                        "message": "BLE 事件循环没起来。", "elapsedMs": elapsed()}
            import asyncio
            future = asyncio.run_coroutine_threadsafe(
                self._lazy_connect(hint, target, deadline), self._ble_loop)
            try:
                outcome = future.result(timeout=self.connect_timeout + 6.0)
            except Exception as exc:                     # FutureTimeout / 底层异常
                self.log_error("lazy-connect-wait", exc)
                with self._lock:
                    self.last_error_code = "connect-failed"
                return {"ok": False, "code": "connect-timeout",
                        "message": f"{int(self.connect_timeout)} 秒内没有连上设备。",
                        "elapsedMs": elapsed()}
            outcome.setdefault("elapsedMs", elapsed())
            if not outcome.get("ok"):
                code = outcome.get("code") or "connect-failed"
                with self._lock:
                    self.last_error_code = ("scan-timeout" if code == "device-not-found"
                                            else "connect-failed")
                outcome.setdefault("message", _CONNECT_MESSAGES.get(code, "连接设备失败。"))
            return outcome
        finally:
            self._connect_lock.release()

    def _close_current_connection(self) -> None:
        """把当前连接关掉（懒模式内部用；不触发重连）。"""
        import asyncio
        client = self._client
        self._client = None
        if client is not None and self._ble_loop is not None:
            try:
                future = asyncio.run_coroutine_threadsafe(self._close_client(client), self._ble_loop)
                future.result(timeout=6.0)
            except Exception as exc:
                self.log_error("close-client", exc)
        with self._lock:
            self.connected = False

    async def _close_client(self, client) -> None:
        try:
            try:
                await client.stop_notify(HR_MEASUREMENT_UUID)
            except Exception:
                pass
            if client.is_connected:
                await client.disconnect()
        except Exception as exc:
            self.log_error("close-client-async", exc)

    async def _lazy_connect(self, hint: str | None, target: str | None, deadline: float) -> dict:
        """扫一轮 → 挑一个 → 连接 + 订阅。全程受 ``deadline`` 约束。"""
        import asyncio
        from bleak import BleakClient

        with self._lock:
            hash_hint = None
            address_hint = None
            if target:
                if _looks_like_hash(target):
                    hash_hint = target.lower()
                else:
                    address_hint = target

        remaining = deadline - time.monotonic()
        if remaining <= 2.0:
            return {"ok": False, "code": "connect-timeout"}
        # 扫描窗口 = 剩余预算的一半左右，留够连接时间；发现目标会提前结束
        scan_budget = max(2.0, min(self.scan_timeout, remaining * 0.6))
        self._mark_scanning(True)
        try:
            candidates = await self._discover_for_connect(scan_budget, hint, address_hint, hash_hint)
        except Exception as exc:
            self.log_error("lazy-scan", exc)
            return {"ok": False, "code": "connect-failed"}
        finally:
            self._mark_scanning(False)

        picked = self._pick(candidates, address=address_hint, hash_prefix=hash_hint, hint=hint)
        if picked is None:
            self.log("on-demand connect: no HRS device found in "
                     f"{int(scan_budget)}s scan (broadcast off?)")
            return {"ok": False, "code": "device-not-found"}

        address = picked.get("address")
        label = picked.get("label")
        remaining = deadline - time.monotonic()
        if remaining <= 1.0:
            return {"ok": False, "code": "connect-timeout"}
        self.log(f"on-demand connect: device ble:{(address_hash(address) or '')[:8]}"
                 f" (label={label or 'null'}), budget left {int(remaining)}s")

        client = None
        try:
            client = BleakClient(address, timeout=max(3.0, min(8.0, remaining)))
            await client.connect()
        except Exception as exc:
            self.log_error("lazy-connect", exc)
            return {"ok": False, "code": "connect-failed"}

        try:
            await client.start_notify(HR_MEASUREMENT_UUID, self._on_notify)
        except Exception as exc:
            self.log_error("lazy-notify", exc)
            try:
                if client.is_connected:
                    await client.disconnect()
            except Exception:
                pass
            return {"ok": False, "code": "connect-failed"}

        self._read_sensor_location(client)
        self._set_connected(address=address, label=label, remember=False)
        self._client = client
        self._monitor_task = asyncio.get_running_loop().create_task(
            self._monitor_link(client, address, label))
        # 顺手等一帧，让 /api/connect 返回时上层第一次拉 /api/state 就有 bpm
        # （最多 2.5 s，且不越过总预算）
        with self._lock:
            before = self.last_notify_ms
        wait_until = min(deadline, time.monotonic() + 2.5)
        while time.monotonic() < wait_until:
            with self._lock:
                if self.last_notify_ms is not None and self.last_notify_ms != before:
                    break
            await asyncio.sleep(0.1)
        return {"ok": True, "connected": True, "deviceLabel": label,
                "addressHash": address_hash(address)}

    async def _monitor_link(self, client, address: str, label: str | None) -> None:
        """只观察、不重连：连接一旦掉了就把状态改成 disconnected，然后停手。"""
        import asyncio
        try:
            while not self._stop.is_set():
                if not client.is_connected:
                    break
                await asyncio.sleep(0.5)
        except Exception as exc:
            self.log_error("monitor", exc)
        finally:
            with self._lock:
                still_ours = self._client is client
                if still_ours:
                    self._client = None
                    self.connected = False
                    self.last_error_code = "disconnected"
            if still_ours:
                self.log("device link lost (broadcast off / out of range) — idle until next "
                         "/api/connect; no auto-reconnect by design")
            try:
                if client.is_connected:
                    await client.disconnect()
            except Exception:
                pass

    def disconnect(self) -> dict:
        with self._lock:
            self._connect_result = None
            self._connect_done.set()      # 释放可能还在等连接的请求
            self._disconnect_done.clear()
        self._want.clear()
        if self.fixture_mode:
            with self._lock:
                self.connected = False
                self.last_error_code = "disconnected"
            return {"ok": True, "connected": False}

        if self.auto_mode:
            # 给 worker 最多 8 s 收尾（关 notify / 关连接）
            deadline = time.monotonic() + 8.0
            while time.monotonic() < deadline:
                with self._lock:
                    if not self.connected:
                        break
                time.sleep(0.1)
            with self._lock:
                self.connected = False
                self.last_error_code = "disconnected"
            return {"ok": True, "connected": False}

        # 懒模式：直接关掉这条连接，不留后台任务
        self._close_current_connection()
        with self._lock:
            self.last_error_code = "disconnected"
        return {"ok": True, "connected": False}

    # ── 内部：扫描/连接阻塞封装 ─────────────────────────────────────────
    def _count_scan(self) -> None:
        with self._lock:
            self.scan_count += 1

    def _mark_scanning(self, value: bool) -> None:
        with self._lock:
            self.scanning = bool(value)
            if value:
                self.scanning_at = now_ms()

    def _fixture_device_entry(self) -> dict:
        label = (self.fixture or {}).get("deviceLabel") or "FIXTURE"
        entry = {
            "label": label,
            "addressHash": address_hash(f"fixture:{label}"),
            "rssi": -52,
            "hasHrs": True,
        }
        if self.allow_address_display:
            entry["address"] = "fixture-" + re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
        return entry

    def _scan_blocking(self, timeout: float, hrs_only: bool) -> list[dict]:
        if self._ble_loop is None:
            raise RuntimeError("BLE bridge is not running")
        import asyncio
        future = asyncio.run_coroutine_threadsafe(self._discover(timeout, hrs_only), self._ble_loop)
        return future.result(timeout=timeout + 20.0)

    # ── BLE：扫描 ───────────────────────────────────────────────────────
    async def _discover_for_connect(self, timeout: float, hint: str | None,
                                    address: str | None, hash_prefix: str | None) -> list[dict]:
        """按需连接用的"一发现就停"扫描（比等满窗口快得多，直接决定端到端秒数）。

        仍然只按 service UUID 0x180D 过滤；命中条件：给了 nameHint 就要求名字匹配，
        否则要求广播里有 0x180D；给了 address/hash 就要求对上（这种情形等满窗口）。
        """
        from bleak import BleakScanner
        import asyncio

        self._count_scan()
        found: dict[str, dict] = {}
        hit = asyncio.Event()
        want_specific = bool(address or hash_prefix)

        def _matches(item: dict) -> bool:
            if address:
                return (item.get("address") or "").lower() == address.lower()
            if hash_prefix:
                digest = address_hash(item.get("address")) or ""
                return digest.startswith(hash_prefix)
            if hint:
                return hint.lower() in (item.get("label") or "").lower()
            return bool(item.get("hasHrs"))

        def _on_detect(device, adv) -> None:
            uuids = [str(u).lower() for u in (getattr(adv, "service_uuids", None) or [])]
            item = {
                "address": getattr(device, "address", None),
                "label": getattr(device, "name", None) or getattr(adv, "local_name", None),
                "rssi": getattr(adv, "rssi", None),
                "hasHrs": HRS_SERVICE_UUID in uuids,
            }
            if not item["address"]:
                return
            found[item["address"]] = item
            if not want_specific and _matches(item):
                hit.set()

        kwargs = {"detection_callback": _on_detect, "service_uuids": [HRS_SERVICE_UUID]}
        try:
            scanner = BleakScanner(**kwargs)
        except TypeError:
            scanner = BleakScanner(detection_callback=_on_detect)

        await scanner.start()
        try:
            try:
                await asyncio.wait_for(hit.wait(), timeout)
            except asyncio.TimeoutError:
                pass
        finally:
            try:
                await scanner.stop()
            except Exception:
                pass
        return list(found.values())

    async def _discover(self, timeout: float, hrs_only: bool) -> list[dict]:
        """扫一轮。hrs_only=True 时按 service UUID 0x180D 过滤（契约 §8 的做法）。"""
        from bleak import BleakScanner  # 惰性导入：fixture 模式不需要 bleak

        kwargs = {"service_uuids": [HRS_SERVICE_UUID]} if hrs_only else {}
        try:
            scanner = BleakScanner(**kwargs)
        except TypeError:                      # 老后端不认 service_uuids
            scanner = BleakScanner()

        await scanner.start()
        try:
            import asyncio
            await asyncio.sleep(timeout)
        finally:
            try:
                await scanner.stop()
            except Exception:
                pass

        # 广播数据在 bleak 的版本间换过名字：0.22 是属性
        # ``discovered_devices_and_advertisement_data``，更早/更晚有的叫
        # ``get_discovered_devices_and_advertisement_data()``。两边都试。
        raw = None
        getter = getattr(scanner, "get_discovered_devices_and_advertisement_data", None)
        if callable(getter):
            try:
                raw = getter()
            except Exception:
                raw = None
        if raw is None:
            for attr_name in ("discovered_devices_and_advertisement_data",
                              "discovered_devices_and_metadata"):
                candidate = getattr(scanner, attr_name, None)
                if candidate is not None:
                    raw = candidate
                    break

        candidates: list[dict] = []
        if raw is None:
            # 老后端拿不到广播数据：过滤模式下"后端已经按 0x180D 筛过"，否则老实说不知道。
            # 这里不碰 device.rssi（bleak 已弃用，会往 stderr 吐 FutureWarning 污染日志）。
            for device in getattr(scanner, "discovered_devices", []) or []:
                candidates.append({
                    "address": getattr(device, "address", None),
                    "label": getattr(device, "name", None),
                    "rssi": None,
                    "hasHrs": bool(hrs_only),
                })
            return candidates

        pairs = raw.items() if hasattr(raw, "items") else [(None, pair) for pair in raw]
        for address, payload in pairs:
            device, adv = (payload if isinstance(payload, (tuple, list)) and len(payload) == 2
                           else (payload, None))
            ble_address = getattr(device, "address", None) or address
            uuids = [str(u).lower() for u in (getattr(adv, "service_uuids", None) or [])]
            label = getattr(device, "name", None) or getattr(adv, "local_name", None)
            rssi = getattr(adv, "rssi", None)
            candidates.append({
                "address": ble_address,
                "label": label,
                "rssi": rssi,
                # 只认广播里真的出现 0x180D 的：/api/devices 的 hasHrs 不能让上层误以为
                # 耳机也能测心率（这里是上一版的一个真 bug，扫到 6 个设备全被标成 hasHrs）
                "hasHrs": HRS_SERVICE_UUID in uuids,
            })
        return candidates

    def _pick(self, candidates: list[dict], address: str | None = None,
              hash_prefix: str | None = None, hint: str | None = None) -> dict | None:
        """挑目标：显式 address/hash > nameHint > 第一个带 0x180D 的。

        参数缺省时回落到实例配置（--auto 的老路径就是这么用的）。
        """
        with self._lock:
            wanted_address = address if address is not None else self.target_address
            wanted_hash = hash_prefix if hash_prefix is not None else self.target_hash
            wanted_hint = hint if hint is not None else self.name_hint
        if wanted_address:
            for item in candidates:
                if (item.get("address") or "").lower() == wanted_address.lower():
                    return item
        if wanted_hash:
            for item in candidates:
                digest = address_hash(item.get("address"))
                if digest and digest.startswith(wanted_hash):
                    return item
        if wanted_hint:
            lowered = wanted_hint.lower()
            for item in candidates:
                label = (item.get("label") or "").lower()
                if lowered in label:
                    return item
        for item in candidates:
            if item.get("hasHrs"):
                return item
        return None

    # ── BLE：连接会话 ───────────────────────────────────────────────────
    def _set_connected(self, *, address: str, label: str | None, remember: bool = True) -> None:
        with self._lock:
            self.connected = True
            self.device_label = label
            self.device_hash = address_hash(address)
            self.last_error_code = None
            if remember and not self.target_address:
                self.target_address = address

    def _signal_connect_result(self, ok: bool, code: str | None = None,
                               message: str | None = None) -> None:
        with self._lock:
            self._connect_result = (ok, code, message)
        self._connect_done.set()

    async def _session(self, scan_timeout: float | None = None) -> str | None:
        """跑一次连接；返回 None = 用户要求的正常断开，返回字符串 = 异常原因码。"""
        from bleak import BleakClient  # 惰性导入

        scan_window = self.scan_timeout if scan_timeout is None else scan_timeout
        with self._lock:
            known_address = self.target_address
        candidates: list[dict] = []
        picked = None

        if known_address:
            picked = {"address": known_address, "label": self.device_label, "hasHrs": True}
        else:
            try:
                candidates = await self._discover(scan_window, hrs_only=True)
            except Exception as exc:
                self.log_error("scan", exc)
                candidates = []
            picked = self._pick(candidates)
            if picked is None:
                # 有的设备广播里不带 0x180D（只在 GATT 表里），或者后端把过滤做过头了：
                # 用名字兜一轮全量扫描再挑一次。
                try:
                    candidates = await self._discover(scan_window, hrs_only=False)
                except Exception as exc:
                    self.log_error("scan-fallback", exc)
                    candidates = []
                picked = self._pick(candidates)

        if picked is None:
            with self._lock:
                self.last_error_code = "scan-timeout"
            self._signal_connect_result(False, "device-not-found",
                                        "没有找到心率广播设备（确认手表已开启心率广播）。")
            return "scan-timeout"

        address = picked.get("address")
        label = picked.get("label")
        self.log(f"connecting to device ble:{(address_hash(address) or '')[:8]}"
                 f" (label={label or 'null'})")

        client = None
        try:
            try:
                from bleak import BleakClient as _Client
                client = _Client(address, timeout=self.connect_timeout)
            except TypeError:
                client = _Client(address)
            await client.connect()
        except Exception as exc:
            self.log_error("connect", exc)
            with self._lock:
                self.last_error_code = "connect-failed"
            self._signal_connect_result(False, "connect-failed", "连接设备失败（信号或配对问题）。")
            return "connect-failed"

        try:
            try:
                await client.start_notify(HR_MEASUREMENT_UUID, self._on_notify)
            except Exception as exc:
                self.log_error("notify", exc)
                with self._lock:
                    self.last_error_code = "notify-failed"
                self._signal_connect_result(False, "connect-failed",
                                            "连上了但订阅不到心率特征（0x2A37）。")
                return "notify-failed"

            self._read_sensor_location(client)   # 顺手读 0x2A38，失败不管
            self._set_connected(address=address, label=label)
            self._signal_connect_result(True)
            self.log(f"connected (connected=true, notify=0x2A37)")

            while self._want.is_set() and not self._stop.is_set():
                if not client.is_connected:
                    with self._lock:
                        self.last_error_code = "disconnected"
                    return "disconnected"
                import asyncio
                await asyncio.sleep(0.5)
            return None
        finally:
            try:
                if client is not None and client.is_connected:
                    try:
                        await client.stop_notify(HR_MEASUREMENT_UUID)
                    except Exception:
                        pass
                    await client.disconnect()
            except Exception:
                pass
            with self._lock:
                self.connected = False

    def _on_notify(self, _sender, data: bytearray) -> None:
        try:
            self.ingest_hr_frame(bytes(data), now_ms())
        except Exception as exc:
            self.log_error("notify-parse", exc)

    def _read_sensor_location(self, client) -> None:
        """0x2A38 是可选的：读不到就保持 null，不算错误。"""
        async def _inner():
            try:
                raw = await client.read_gatt_char(BODY_SENSOR_LOCATION_UUID)
            except Exception:
                return
            try:
                value = int(bytes(raw)[0])
            except Exception:
                return
            name = SENSOR_LOCATIONS.get(value)
            if name:
                with self._lock:
                    self.sensor_location = name
                self.log(f"sensor location: {name}")

        try:
            import asyncio
            asyncio.get_running_loop().create_task(_inner())
        except Exception:
            pass

    def _forget_vanished_address(self) -> None:
        """设备"消失"（广播关了/走远了）之后必须重新扫描。

        这里不能死抱着旧地址直接 ``BleakClient(address)``：不广播的外设在 Windows 上要等到
        connect 超时（默认 20 s）才失败，而失败后还要走退避 —— 实测上就会变成"重新打开广播
        之后要等半分钟才恢复"。丢掉地址、下一轮重新扫，恢复时间就是"扫描 5~8 s + 连接 1~2 s"。
        用户用 ``--address`` 显式指定的地址不丢（那是他的决定，只在连续失败 3 次后放手）。
        """
        if self._address_from_user:
            return
        with self._lock:
            if not (self.target_address or self.target_hash):
                return
            dropped = (self.target_hash or address_hash(self.target_address) or "")[:8]
            self.target_address = None
            self.target_hash = None
        self.log(f"device ble:{dropped} vanished (broadcast stopped?) — will rescan on next attempt")

    # ── BLE worker（单 asyncio 循环，持有一切连接状态） ─────────────────
    async def _sleep_unless_woken(self, delay: float) -> None:
        """退避睡眠，但 POST /api/connect 能把它叫醒（否则 UI 上点"连接"要干等 30 s）。"""
        import asyncio
        with self._lock:
            start_epoch = self._connect_epoch
        slept = 0.0
        slice_len = 0.25
        while slept < delay and not self._stop.is_set():
            await asyncio.sleep(slice_len)
            slept += slice_len
            with self._lock:
                if self._connect_epoch != start_epoch:
                    self.log("reconnect backoff interrupted by a new connect request")
                    return

    def _maybe_forget_auto_address(self, failures: int) -> None:
        """自动选中的地址连续连不上，就别死盯着它，清掉让下一轮重新扫。"""
        with self._lock:
            if self._address_from_user or failures < 3:
                return
            if not (self.target_address or self.target_hash):
                return
            dropped = (self.target_hash or address_hash(self.target_address) or "")[:8]
            self.target_address = None
            self.target_hash = None
        self.log(f"forget auto-selected device ble:{dropped} after {failures} failed attempts, rescanning")

    async def _worker(self) -> None:
        import asyncio
        backoff = BACKOFF_START
        attempt = 0
        failures = 0
        while not self._stop.is_set():
            if not self._want.is_set():
                await asyncio.sleep(0.2)
                backoff = BACKOFF_START
                attempt = 0
                failures = 0
                continue
            attempt += 1
            # 重连（attempt > 1）不值得等满冷启动的扫描窗口：设备刚闪断时扫 5~6 s 就够，
            # 恢复更快，也不至于让上层长时间看到 sampleAgeMs 一路涨。
            scan_window = self.scan_timeout if attempt <= 1 else min(self.scan_timeout, 6.0)
            try:
                reason = await self._session(scan_window)
            except Exception as exc:
                self.log_error("session", exc)
                with self._lock:
                    self.last_error_code = "connect-failed"
                self._signal_connect_result(False, "connect-failed", "连接设备失败。")
                reason = "connect-failed"

            if self._stop.is_set():
                return
            if reason is None:
                backoff = BACKOFF_START
                attempt = 0
                failures = 0
                continue

            with self._lock:
                self.connected = False
                self.last_error_code = reason
            if not self._want.is_set():
                backoff = BACKOFF_START
                attempt = 0
                failures = 0
                continue

            if reason in ("connect-failed", "notify-failed"):
                failures += 1
                self._maybe_forget_auto_address(failures)
            elif reason == "disconnected":
                # 设备从中途掉线 = 大概率广播关了/走远了：马上丢地址重扫，别等 3 次失败
                failures = 0
                self._forget_vanished_address()
            else:
                failures = 0

            # 不刷屏：前 3 次与每 10 次才记一行
            if attempt <= 3 or attempt % 10 == 0:
                self.log(f"reconnect #{attempt} in {int(backoff)}s (reason: {reason})")
            await self._sleep_unless_woken(backoff)
            backoff = min(BACKOFF_MAX, backoff * 2.0)

    def _run_bridge(self) -> None:
        import asyncio
        loop = asyncio.new_event_loop()
        self._ble_loop = loop
        asyncio.set_event_loop(loop)
        try:
            if self.auto_mode:
                loop.run_until_complete(self._worker())
            else:
                # 懒模式：只把事件循环挂在那里等按需调用，**不跑任何后台循环**
                loop.run_until_complete(self._idle_loop())
        except Exception as exc:  # 循环本身挂了也不能让进程死得没说法
            self.log_error("bridge", exc)
        finally:
            try:
                loop.close()
            except Exception:
                pass

    async def _idle_loop(self) -> None:
        """什么都不做，只是让事件循环活着（按需连接靠 run_coroutine_threadsafe 进来）。"""
        import asyncio
        while not self._stop.is_set():
            await asyncio.sleep(0.5)

    def start_ble(self, auto_connect: bool) -> None:
        if auto_connect:
            self._want.set()
        self._ble_thread = threading.Thread(target=self._run_bridge, name="ble-bridge", daemon=True)
        self._ble_thread.start()

    # ── fixture 回放 ────────────────────────────────────────────────────
    def load_fixture(self, path: str) -> None:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        samples = data.get("samples")
        if not isinstance(samples, list) or not samples:
            raise ValueError("fixture 缺少非空 samples 数组")
        interval = float(data.get("intervalMs") or 1000)
        if interval < 200:
            raise ValueError("fixture.intervalMs 最小 200")
        label = str(data.get("deviceLabel") or "FIXTURE")
        self.fixture = {
            "deviceLabel": label,
            "intervalMs": interval,
            "samples": samples,
            "sensorLocation": data.get("sensorLocation"),
            "contact": data.get("contact") or "yes",
        }
        with self._lock:
            self.device_label = label
            self.device_hash = address_hash(f"fixture:{label}")
            self.sensor_location = data.get("sensorLocation")
            self.contact = data.get("contact") or "yes"

    def _fixture_begin(self, wait: bool = False) -> bool:
        """让回放开始跑。``wait=True`` 时等循环真的吐了第一帧再返回。

        ``POST /api/connect`` 不能只置一个"乐观"标志就回 ``connected:true``——上层紧接着
        拉 ``/api/state`` 会看到 ``connected:false``（2026-11-03 由 Lead 复现的真实竞态）。
        所以这里等到 ``_replay_tick`` 落定，最多等 3 s。
        """
        self._replay_tick.clear()
        self._want.set()
        with self._lock:
            self.connected = True
            self.last_error_code = None
        if not wait:
            return True
        return self._replay_tick.wait(3.0)

    def _fixture_loop(self, paused: bool = False) -> None:
        fixture = self.fixture or {}
        samples = fixture.get("samples") or []
        interval = float(fixture.get("intervalMs") or 1000) / 1000.0
        contact_default = fixture.get("contact") or "yes"
        location = fixture.get("sensorLocation")
        if paused:
            # 懒模式：不自动开始回放，等人 POST /api/connect（模拟"设备还没连"）
            self.log("fixture replay armed but paused (lazy: waiting for POST /api/connect)")
        else:
            self._fixture_begin()
            self.log(f"fixture replay: {len(samples)} samples every {int(interval * 1000)}ms")

        next_at = time.monotonic()
        while not self._stop.is_set():
            if not self._want.is_set():
                # 关键：写 connected=False 之前必须在锁里复查一次 _want。
                # 否则会出现"connect 已经把 want 打开、这里却拿着旧结论写 False"的竞态
                # （写入落在 connect 之后，上层马上读 state 就看见 connected:false）。
                with self._lock:
                    if self._want.is_set():
                        continue
                    self.connected = False
                self._stop.wait(0.15)
                next_at = time.monotonic()
                continue
            sample = samples[self._fixture_index % len(samples)]
            self._fixture_index += 1
            # sampleAt 跟着真实时钟走 —— 这就是 sampleAgeMs 一直很小的原因
            self.ingest(
                bpm=sample.get("bpm"),
                rr_ms=sample.get("rrMs") or [],
                contact=sample.get("contact") or contact_default,
                sensor_location=sample.get("sensorLocation") or location,
                at_ms=now_ms(),
            )
            with self._lock:
                self.connected = True
                self.last_error_code = None
            self._replay_tick.set()
            next_at += interval
            delay = next_at - time.monotonic()
            if delay <= 0:
                next_at = time.monotonic() + interval
                delay = interval
            self._stop.wait(delay)

    def start_fixture(self, paused: bool = False) -> None:
        thread = threading.Thread(target=self._fixture_loop, args=(paused,),
                                   name="fixture", daemon=True)
        thread.start()

    # ── 收尾 ────────────────────────────────────────────────────────────
    def begin_shutdown(self) -> None:
        self._want.clear()
        self._stop.set()

    def wait_ble(self, timeout: float = 3.0) -> None:
        thread = self._ble_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout)


def _looks_like_hash(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{6,16}", value))


# ────────────────────────────── HTTP 层 ──────────────────────────────

class LoopbackServer(ThreadingHTTPServer):
    daemon_threads = True
    # Windows 上 SO_REUSEADDR 允许两个进程绑同一端口 —— 那就是"抢"。这里必须独占。
    allow_reuse_address = False

    def __init__(self, address, handler, hub: PulseHub):
        self.hub = hub
        super().__init__(address, handler)

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            except OSError:
                pass
        super().server_bind()


class PulseHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "pulse-bond-sidecar/" + VERSION
    sys_version = ""

    @property
    def hub(self) -> PulseHub:
        return self.server.hub  # type: ignore[attr-defined]

    # 1 Hz 轮询会把访问日志刷爆；默认闭嘴，--verbose 才写。
    def log_message(self, fmt, *args):  # noqa: A003
        if self.hub.verbose:
            self.hub.log("http " + scrub(fmt % args))

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return {}
        if length <= 0:
            return {}
        try:
            raw = self.rfile.read(min(length, 64 * 1024))
            parsed = json.loads(raw.decode("utf-8"))
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}

    def do_GET(self):  # noqa: N802
        split = urlsplit(self.path)
        path = split.path.rstrip("/") or "/"
        try:
            if path == "/api/health":
                payload = self.hub.health()
            elif path == "/api/state":
                payload = self.hub.state()
            elif path == "/api/devices":
                # 懒模式：只有显式 ?scan=1 才真扫一轮；否则返回上一次结果（不扫）
                query = parse_qs(split.query)
                scan = (query.get("scan", [""])[0] or "").strip().lower() in ("1", "true", "yes", "on")
                payload = self.hub.devices(scan=scan)
            elif path in ("/", "/api"):
                payload = {"ok": True, "version": VERSION, "service": "ble-heart-rate",
                           "mode": "auto" if self.hub.auto_mode else "lazy",
                           "endpoints": ["/api/health", "/api/state", "/api/devices?scan=1",
                                         "/api/connect", "/api/disconnect"]}
            else:
                self._send_json({"ok": False, "code": "not-found", "message": "没有这个接口。"}, 404)
                return
        except Exception as exc:
            self.hub.log_error("http-get", exc)
            payload = {"ok": False, "code": "internal", "message": INTERNAL_MESSAGE}
        self._send_json(payload)

    def do_POST(self):  # noqa: N802
        path = urlsplit(self.path).path.rstrip("/") or "/"
        body = self._read_json_body()
        try:
            if path == "/api/connect":
                payload = self.hub.connect(body.get("address"), body.get("nameHint"))
            elif path == "/api/disconnect":
                payload = self.hub.disconnect()
            else:
                self._send_json({"ok": False, "code": "not-found", "message": "没有这个接口。"}, 404)
                return
        except Exception as exc:
            self.hub.log_error("http-post", exc)
            payload = {"ok": False, "code": "internal", "message": INTERNAL_MESSAGE}
        self._send_json(payload)


# ────────────────────────────── 自检 ──────────────────────────────

def run_selftest() -> int:
    """只跑解析器 + 脱敏的单元自检。不联网、不需要硬件。"""
    cases = [
        # (说明, 帧字节, 期望 bpm, 期望 contact, 期望 rrMs)
        ("uint8 bpm, 无接触位", b"\x00\x58", 88, "unsupported", []),
        ("接触支持 + 有接触", b"\x06\x76", 118, "yes", []),
        ("接触支持 + 无接触", b"\x02\x76", 118, "no", []),
        ("bit2 单独置位不算接触", b"\x04\x76", 118, "unsupported", []),
        ("uint16 bpm (300)", b"\x01\x2c\x01", 300, "unsupported", []),
        ("RR 单条 1024/1024s = 1000ms", b"\x10\x3c\x00\x04", 60, "unsupported", [1000]),
        ("energy 2 字节跳过后再读 RR", b"\x18\x3c\x88\x13\x00\x04", 60, "unsupported", [1000]),
        ("RR 两条 1024,512 -> 1000,500", b"\x10\x3c\x00\x04\x00\x02", 60, "unsupported", [1000, 500]),
        ("RR 截断不崩", b"\x10\x3c\x00", 60, "unsupported", []),
        # flags=0x1f: uint16 bpm(bit0) + 接触支持(bit1) + 有接触(bit2) + energy(bit3) + RR(bit4)
        ("uint16 bpm + 接触 + energy + RR", b"\x1f\x04\x01\x88\x13\x00\x04", 260, "yes", [1000]),
    ]
    failures = 0
    for name, raw, want_bpm, want_contact, want_rr in cases:
        try:
            got = parse_hr_measurement(raw)
        except Exception as exc:
            print(f"FAIL  {name}: 抛了异常 {type(exc).__name__}")
            failures += 1
            continue
        ok = (got["bpm"] == want_bpm and got["contact"] == want_contact
              and got["rrMs"] == want_rr)
        if ok:
            print(f"PASS  {name}")
        else:
            failures += 1
            print(f"FAIL  {name}: 得到 {got}, 期望 bpm={want_bpm} contact={want_contact} rrMs={want_rr}")

    # 脱敏断言：日志里不许出现 MAC 明文
    dirty = "connect failed for AA:BB:CC:DD:EE:FF (0a-1b-2c-3d-4e-5f)"
    clean = scrub(dirty)
    if "AA:BB:CC:DD:EE:FF" in clean or "0a-1b-2c-3d-4e-5f" in clean:
        print(f"FAIL  scrub: 地址明文没被抹掉 -> {clean}")
        failures += 1
    else:
        print(f"PASS  scrub 抹掉地址明文 -> {clean}")

    # addressHash 形状
    digest = address_hash("AA:BB:CC:DD:EE:FF")
    if digest is None or len(digest) != 16 or not re.fullmatch(r"[0-9a-f]{16}", digest):
        print(f"FAIL  addressHash: {digest!r}")
        failures += 1
    else:
        print(f"PASS  addressHash 是 16 hex -> {digest}")

    # bpm=0 不许写进 state
    hub = PulseHub(argparse.Namespace(
        port=DEFAULT_PORT, verbose=False, fixture=None, scan_timeout=8.0,
        connect_timeout=20.0, allow_address_display=False, name_hint=None, address=None))
    hub.ingest_hr_frame(b"\x00\x00", now_ms())
    if hub.state()["bpm"] is not None:
        print("FAIL  bpm=0 应该保持 null")
        failures += 1
    else:
        print("PASS  bpm=0 不写成 0（保持 null）")

    print("")
    print(f"selftest: {'PASS' if failures == 0 else 'FAIL'} ({failures} 项失败)")
    return 0 if failures == 0 else 1


# ────────────────────────────── 入口 ──────────────────────────────

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="heart_rate.py",
        description="BLE 心率广播接收端（loopback only, 127.0.0.1 硬编码）",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"HTTP 端口，默认 {DEFAULT_PORT}（被占用则退出码 2）")
    parser.add_argument("--address", default=None,
                        help="设备地址或 addressHash（15/16 hex 前缀）")
    parser.add_argument("--name-hint", default=None, help="设备名子串，如 WATCH")
    parser.add_argument("--fixture", default=None, help="回放合成序列（无硬件验收）")
    parser.add_argument("--scan-timeout", type=float, default=8.0,
                        help="单次扫描窗口上限（按需连接通常提前命中就停）")
    parser.add_argument("--connect-timeout", type=float, default=12.0,
                        help="POST /api/connect 的总预算秒数，默认 12")
    parser.add_argument("--auto", action="store_true",
                        help="旧行为：启动就扫、自动连接、断线后台退避重连（默认是懒模式，不扫不连不重连）")
    parser.add_argument("--allow-address-display", action="store_true",
                        help="在 /api/devices 里带上 address（默认省略；仅供本地排障）")
    parser.add_argument("--no-auto-connect", action="store_true",
                        help="（--auto 下才有意义）启动后不自动连，等 POST /api/connect")
    parser.add_argument("--verbose", action="store_true", help="把 HTTP 访问日志也写出来")
    parser.add_argument("--selftest", action="store_true", help="只跑解析自检后退出")
    parser.add_argument("--version", action="store_true", help="打印版本后退出")
    return parser.parse_args(argv)


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.4)
        return probe.connect_ex((BIND_HOST, port)) == 0


def main(argv: list[str] | None = None) -> int:
    ensure_utf8_stdio()
    args = parse_args(list(sys.argv[1:] if argv is None else argv))

    if args.version:
        print(VERSION)
        return 0
    if args.selftest:
        return run_selftest()

    if not (1 <= int(args.port) <= 65535):
        print(f"非法端口: {args.port}", file=sys.stderr)
        return 1

    # ── 端口预检：别人的监听绝不抢（契约 §3） ──
    if port_in_use(args.port):
        print(f"端口 {args.port} 已被占用（且不是本进程），拒绝启动。退出码 2。", file=sys.stderr)
        return 2

    hub = PulseHub(args)
    if args.fixture:
        try:
            hub.load_fixture(args.fixture)
        except Exception as exc:
            print(f"fixture 读取失败: {exc}", file=sys.stderr)
            return 1

    try:
        server = LoopbackServer((BIND_HOST, int(args.port)), PulseHandler, hub)
    except OSError as exc:
        if getattr(exc, "errno", None) in (48, 98, 10048) or "in use" in str(exc).lower():
            print(f"端口 {args.port} 绑定失败（已被占用）。退出码 2。", file=sys.stderr)
            return 2
        raise

    hub.log(f"ble-heart-rate sidecar v{VERSION} listening on {BIND_HOST}:{args.port} "
            f"(fixture={hub.fixture_mode}, mode={'auto' if hub.auto_mode else 'lazy'})")
    if hub.auto_mode:
        hub.log("auto mode: will scan and connect on its own (legacy behaviour)")
    else:
        hub.log("lazy mode: no scanning, no auto-connect, no background reconnect — "
                "POST /api/connect to act on demand")

    if hub.fixture_mode:
        # --auto：回放立刻开始（旧行为）；默认懒模式：回放待命，等 POST /api/connect
        hub.start_fixture(paused=not hub.auto_mode)
    else:
        hub.start_ble(auto_connect=hub.auto_mode and not args.no_auto_connect)

    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        hub.begin_shutdown()
        try:
            server.shutdown()
        except Exception:
            pass
        server.server_close()
        hub.wait_ble(3.0)
        hub.log("sidecar stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
