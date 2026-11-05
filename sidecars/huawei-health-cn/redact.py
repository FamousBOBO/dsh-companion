"""Redaction rules for the frozen CN Huawei Health sidecar payload.

The sidecar itself (``python/huawei_dashboard.py``) already masks the account id, but it serves
the *raw* ``devices[]`` entries and the *raw* ``token{}`` block, and the collection path is not
allowed to grow new fields without somebody checking.  This module is the single place that
decides what a stored snapshot may contain, so the rules can be unit-tested without a network.

Frozen contract (see ``PROTOCOL-FREEZE.md`` §4):

1. ``token{}`` keeps **only** :data:`TOKEN_KEY_WHITELIST`; ``token.uid`` never survives, its
   stable pseudonym is ``uid_sha256_16`` = ``sha256(raw uid)[:16]``.
2. Any ``accessToken`` / ``refreshToken`` / ``access_token`` / ``refresh_token`` /
   ``Authorization`` / ``x-huid`` / ``x-token`` key is dropped wherever it appears.
3. ``devices[].uniqueId`` and ``devices[].devId`` become ``sha256(raw)[:16]``; the same is done
   to the three extra identifiers this account's cloud actually returns — ``udid`` (64 chars),
   ``sn`` and ``mac`` — because ``design/health/INTERFACES.md`` §4/§13 forbid a plaintext device
   MAC anywhere.  ``deviceData`` (an opaque blob the cloud uses, no read path needs it) becomes
   a length + hash record.
4. Health data is **not** redacted: ``sources[].rt_text``, ``realtime`` values, ``daily``,
   ``health``, ``sessions`` and ``sleep_rows`` are the point of the snapshot and stay verbatim.
5. :func:`assert_redacted` must pass on the final document.  The snapshot is written with
   ``json.dumps(..., sort_keys=True, ensure_ascii=False, indent=2)`` so a plain
   ``grep -iE '(accesstoken|refreshtoken|x-huid)'`` on the file finds nothing but key names.

Nothing here reads the credential file, and nothing here talks to the network.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Iterable, Mapping

__all__ = [
    "TOKEN_KEY_WHITELIST",
    "FORBIDDEN_KEYS",
    "DEVICE_HASH_FIELDS",
    "DEVICE_DROP_FIELDS",
    "RedactionError",
    "sha16",
    "redact_token",
    "redact_device",
    "redact_devices",
    "redact_payload",
    "find_violations",
    "assert_redacted",
    "dumps",
    "TOKEN_VALUE_PATTERNS",
    "PRIVACY_GREP_PATTERN",
]

#: The only keys a stored ``token{}`` block may carry.  ``uid`` is *not* one of them.
TOKEN_KEY_WHITELIST: frozenset[str] = frozenset({
    "uid_sha256_16",
    "session_host",
    "data_host",
    "expires_at_text",
    "expires_in_min",
    "refresh_dies_text",
    "rotated",
})

#: Credential-ish keys that must not exist anywhere in a stored document (lower-case compare).
#: ``token`` is deliberately absent: the top-level ``token`` *container* is part of the frozen
#: protocol and is validated against :data:`TOKEN_KEY_WHITELIST` instead.
FORBIDDEN_KEYS: frozenset[str] = frozenset({
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "authorization",
    "x-huid",
    "x-token",
    "x-auth-token",
    "siteid",
    "site_id",
})

#: Device identifier fields hashed in place (``sha256(raw)[:16]``).  The first two are the ones
#: the protocol freeze names; ``udid``/``sn``/``mac`` are the same class of identifier and the
#: cloud does return them for four of the nine bound devices (see PROTOCOL-FREEZE.md §4.2).
DEVICE_HASH_FIELDS: tuple[str, ...] = ("uniqueId", "devId", "udid", "sn", "mac")

#: Opaque device fields replaced by ``{"bytes": n, "sha256_16": "…"}`` — no read path uses them.
DEVICE_DROP_FIELDS: tuple[str, ...] = ("deviceData",)

#: Values that must never appear in a stored document.  ``DgE…`` is the prefix every Huawei
#: access/refresh token in this account started with; the digit rule catches a bare 17-digit uid.
TOKEN_VALUE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^DgE[A-Za-z0-9+/\-=_]{8,}$"),
    re.compile(r"^[A-Za-z0-9+/\-_]{40,}={0,2}$"),
    re.compile(r"^\d{15,}$"),
)

#: The exact pattern the README hands to the operator as the privacy regression check.
PRIVACY_GREP_PATTERN = r'(?i)(accesstoken|refreshtoken|x-huid|"uid"\s*:\s*"\d{6,})'


class RedactionError(RuntimeError):
    """A stored document still carries something that must not leave the process."""

    def __init__(self, violations: Iterable[str]) -> None:
        self.violations = list(violations)
        super().__init__(
            "redaction contract violated:\n  " + "\n  ".join(self.violations)
            if self.violations else "redaction contract violated")


def sha16(value: Any) -> str:
    """``sha256(str(value))[:16]`` — the frozen pseudonym for identifiers."""
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]


# ── per-block redaction ────────────────────────────────────────────────────
def redact_token(token: Any) -> dict[str, Any]:
    """Keep only the whitelisted keys of ``token{}`` and hash the account id away."""
    if not isinstance(token, Mapping):
        return {}
    out: dict[str, Any] = {}
    for key, value in token.items():
        name = str(key)
        if name == "uid":
            if value not in (None, ""):
                out["uid_sha256_16"] = sha16(value)
            continue
        if name.lower() in FORBIDDEN_KEYS:
            continue
        if name in TOKEN_KEY_WHITELIST:
            out[name] = value
        # anything else the sidecar invents later is dropped, not forwarded
    return out


def redact_device(device: Any) -> dict[str, Any]:
    """Hash the two device identifiers, shrink the opaque blob, keep the rest verbatim."""
    if not isinstance(device, Mapping):
        return {}
    out: dict[str, Any] = {}
    for key, value in device.items():
        name = str(key)
        if name.lower() in FORBIDDEN_KEYS:
            continue
        if name in DEVICE_HASH_FIELDS:
            if value not in (None, ""):
                out[name] = sha16(value)
            continue
        if name in DEVICE_DROP_FIELDS:
            blob = "" if value is None else str(value)
            out[name] = {"bytes": len(blob), "sha256_16": sha16(blob), "dropped": True}
            continue
        out[name] = redact_payload(value)
    return out


def redact_devices(devices: Any) -> list[dict[str, Any]]:
    if not isinstance(devices, (list, tuple)):
        return []
    return [redact_device(device) for device in devices]


def redact_payload(value: Any) -> Any:
    """Deep redaction.  Lists/dicts are rebuilt; scalars are returned unchanged.

    Applied to a whole ``/api/data`` payload the only blocks that actually change are
    ``token[]`` and ``devices[]`` — health values are never touched.
    """
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for key, item in value.items():
            name = str(key)
            lowered = name.lower()
            if lowered in FORBIDDEN_KEYS:
                continue
            if name == "uid":
                if item not in (None, ""):
                    out["uid_sha256_16"] = sha16(item)
                continue
            if name in DEVICE_HASH_FIELDS:
                if item not in (None, ""):
                    out[name] = sha16(item)
                continue
            if name in DEVICE_DROP_FIELDS and isinstance(item, str):
                out[name] = {"bytes": len(item), "sha256_16": sha16(item), "dropped": True}
                continue
            out[name] = redact_payload(item)
        return out
    if isinstance(value, (list, tuple)):
        return [redact_payload(item) for item in value]
    return value


# ── verification ───────────────────────────────────────────────────────────
def _walk(value: Any, path: str = "$") -> Iterable[tuple[str, Any, Any]]:
    """Yield ``(path, key, value)`` for every mapping entry, recursively."""
    if isinstance(value, Mapping):
        for key, item in value.items():
            here = f"{path}.{key}"
            yield here, key, item
            if isinstance(item, (Mapping, list, tuple)):
                yield from _walk(item, here)
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            here = f"{path}[{index}]"
            if isinstance(item, (Mapping, list, tuple)):
                yield from _walk(item, here)


def find_violations(payload: Any) -> list[str]:
    """Return a list of human-readable contract violations (empty means clean)."""
    violations: list[str] = []

    # 1. the token block is validated as a block, not key by key
    token = payload.get("token") if isinstance(payload, Mapping) else None
    if token is not None and not isinstance(token, Mapping):
        violations.append("$.token must be an object")
    elif isinstance(token, Mapping):
        for key in token:
            if key not in TOKEN_KEY_WHITELIST:
                violations.append(f"$.token.{key} is not in the token whitelist")

    # 2. no credential key anywhere, and no credential-looking value
    for path, key, value in _walk(payload):
        lowered = str(key).lower()
        if path != "$.token" and lowered in FORBIDDEN_KEYS:
            violations.append(f"{path}: forbidden key {key!r}")
        if lowered == "uid":
            violations.append(f"{path}: raw 'uid' key survived")
        if isinstance(value, str):
            if key in DEVICE_HASH_FIELDS or key == "uid_sha256_16":
                continue  # pseudonyms are validated as hex just below
            for pattern in TOKEN_VALUE_PATTERNS:
                if pattern.match(value):
                    violations.append(f"{path}: value looks like a credential/token")
                    break
        # device pseudonyms must be exactly the frozen shape
        if key in DEVICE_HASH_FIELDS or key == "uid_sha256_16":
            if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{16}", value):
                violations.append(f"{path}: {key} is not a sha256[:16] pseudonym")

    # 3. devices[] identifiers must be pseudonyms, never raw
    devices = payload.get("devices") if isinstance(payload, Mapping) else None
    if isinstance(devices, list):
        for index, device in enumerate(devices):
            if not isinstance(device, Mapping):
                continue
            for field in DEVICE_HASH_FIELDS:
                if field in device and not re.fullmatch(r"[0-9a-f]{16}", str(device[field])):
                    violations.append(f"$.devices[{index}].{field} is not a sha256[:16] pseudonym")

    return violations


def assert_redacted(payload: Any) -> None:
    """Raise :class:`RedactionError` unless ``payload`` satisfies the frozen contract."""
    violations = find_violations(payload)
    if violations:
        raise RedactionError(violations)


def dumps(payload: Any) -> str:
    """The frozen serialisation: sorted keys, UTF-8, two-space indent, trailing newline."""
    assert_redacted(payload)
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, indent=2) + "\n"
