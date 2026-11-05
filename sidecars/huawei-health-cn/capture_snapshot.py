#!/usr/bin/env python3
"""Pull one ``/api/data`` snapshot from the local CN sidecar and store it redacted.

    # the normal call (one HTTP GET against the loopback sidecar, 15 s server cache)
    python capture_snapshot.py

    # what the acceptance run uses — deterministic file name, same content shape
    python capture_snapshot.py --out snapshots/cn-snapshot-20261103-2100.json

    # offline: re-derive the redacted document from a payload you already saved
    python capture_snapshot.py --url file:///path/to/raw-payload.json --out /tmp/x.json

Output defaults to `<data>/snapshots/huawei-health-cn/cn-snapshot-<stamp>.json`
(`$HUAWEI_SNAPSHOT_DIR` overrides); snapshots are personal data and are never committed.

Rules this script follows (frozen, see ``PROTOCOL-FREEZE.md``):

* **low frequency** — exactly one HTTP request per invocation, no retries, no polling loops.
  The sidecar caches its own payload for 15 s and the cloud rate-limits at ~40 calls, so the
  operator is told how many pulls this run used and when the cache expires.
* **only loopback** — an http(s) ``--url`` whose host is not ``127.0.0.1``/``localhost``/``::1``
  is refused before any connection is made.
* **never prints the payload** — the console gets counts and the output path, nothing else.
* **redacted + reproducible** — :mod:`redact` rewrites ``token{}`` and ``devices[]``, the result
  is asserted against the contract and serialised with sorted keys, so the same payload always
  produces a byte-identical file (modulo the ``_capture.capturedAt`` stamp).

Exit codes: ``0`` ok, ``2`` bad arguments, ``3`` sidecar unreachable / bad answer,
``4`` redaction contract violated (nothing is written in that case).
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

import redact
import sidecar_paths

HERE = Path(__file__).resolve().parent
# Snapshots are personal data: they never ship, and they live under the suite's data directory
# (`$HUAWEI_SNAPSHOT_DIR` overrides; default `<data>/snapshots/huawei-health-cn`).
SNAPSHOT_DIR = sidecar_paths.snapshots_dir()
DEFAULT_URL = "http://127.0.0.1:8765/api/data?days=7"
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
TIMEOUT_S = 25

#: Top-level keys the frozen protocol promises / the capture always reports on.
REPORTED_COUNTS = ("daily", "health", "sleep_rows", "sessions", "devices", "sources", "errors")


class CaptureError(RuntimeError):
    """The pull itself failed (unreachable, non-JSON, non-loopback, …)."""


def _is_loopback(url: str) -> bool:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == "file":
        return True
    host = (parsed.hostname or "").lower()
    if host in LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def fetch(url: str, timeout: float = TIMEOUT_S) -> dict[str, Any]:
    """One GET, no retry.  ``file://`` is allowed so the redaction path can be replayed offline."""
    if not _is_loopback(url):
        raise CaptureError(f"refusing a non-loopback URL: {urllib.parse.urlsplit(url).netloc}")
    started = time.perf_counter()
    request = urllib.request.Request(url, headers={"Accept": "application/json"},
                                     method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:  # noqa: S310 - loopback
            raw = answer.read()
    except urllib.error.HTTPError as err:  # a subclass of URLError, so it goes first
        raise CaptureError(f"sidecar answered HTTP {err.code} for {url}") from err
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        raise CaptureError(f"sidecar unreachable at {url}: {err}") from err
    latency_ms = round((time.perf_counter() - started) * 1000, 1)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise CaptureError(f"sidecar did not answer JSON: {err}") from err
    if not isinstance(payload, dict):
        raise CaptureError("sidecar answered JSON that is not an object")
    payload["_latency_ms"] = latency_ms  # consumed by _capture, never part of the document
    return payload


def build_capture_block(payload: dict[str, Any], url: str, latency_ms: float | None) -> dict[str, Any]:
    """The ``_capture`` metadata block required by the freeze."""
    counts = {key: (len(payload[key]) if isinstance(payload.get(key), list) else None)
              for key in REPORTED_COUNTS}
    scope = payload.get("scope") if isinstance(payload.get("scope"), dict) else {}
    capture: dict[str, Any] = {
        "capturedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": url,
        "redacted": True,
        "keys": sorted(key for key in payload if key != "_latency_ms"),
        "counts": counts,
        "scopeDays": scope.get("days"),
        "syncedAt": payload.get("synced_at_text"),
        "cloudCalls": len(payload.get("calls") or []),
        "errors": len(payload.get("errors") or []),
        "redactionRules": sorted(redact.TOKEN_KEY_WHITELIST),
        "tool": "sidecars/huawei-health-cn/capture_snapshot.py",
    }
    if latency_ms is not None:
        capture["latencyMs"] = latency_ms
    return capture


def capture(url: str = DEFAULT_URL, timeout: float = TIMEOUT_S) -> dict[str, Any]:
    """Fetch once, redact, attach ``_capture``.  Returns the finished document."""
    payload = fetch(url, timeout=timeout)
    latency_ms = payload.pop("_latency_ms", None)
    if latency_ms is None:
        latency_ms = payload.get("total_ms")
    document = redact.redact_payload(payload)
    document["_capture"] = build_capture_block(document, url, latency_ms)
    redact.assert_redacted(document)          # raises RedactionError before anything is written
    return document


def default_out() -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    return SNAPSHOT_DIR / f"cn-snapshot-{stamp}.json"


def write_document(document: dict[str, Any], out: Path) -> Path:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(redact.dumps(document), encoding="utf-8")
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Capture one redacted /api/data snapshot from the CN sidecar.")
    parser.add_argument("--url", default=DEFAULT_URL,
                        help=f"loopback sidecar URL or file:// payload (default {DEFAULT_URL})")
    parser.add_argument("--out", default=None,
                        help="output path (default snapshots/cn-snapshot-<YYYYMMDD-HHMM>.json)")
    parser.add_argument("--timeout", type=float, default=TIMEOUT_S, help="seconds (default 25)")
    parser.add_argument("--quiet", action="store_true", help="only the output path on stdout")
    args = parser.parse_args(argv)

    out = Path(args.out) if args.out else default_out()
    try:
        document = capture(args.url, timeout=args.timeout)
    except redact.RedactionError as err:
        print(f"REFUSED: redaction contract violated, nothing written\n{err}", file=sys.stderr)
        return 4
    except CaptureError as err:
        print(f"FAILED: {err}", file=sys.stderr)
        return 3

    written = write_document(document, out)
    counts = document["_capture"]["counts"]
    if args.quiet:
        print(written)
        return 0
    print(f"snapshot  : {written}")
    print(f"source    : {args.url}")
    print(f"captured  : {document['_capture']['capturedAt']}"
          f" (sidecar synced_at {document['_capture']['syncedAt']}, "
          f"{document['_capture']['latencyMs']} ms, {document['_capture']['cloudCalls']} cloud calls)")
    print("counts    : " + "  ".join(f"{key}={value}" for key, value in counts.items()))
    print(f"redacted  : token keys -> {len(document.get('token') or {})}, "
          f"devices -> {counts.get('devices')} (uniqueId/devId hashed)")
    print("privacy   : "
          f"Select-String -Path {written} -Pattern '{redact.PRIVACY_GREP_PATTERN}'"
          "   # expect no output")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
