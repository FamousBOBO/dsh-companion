"""Where the CN Huawei Health sidecar keeps runtime files.

Everything here is **derived or overridable** — nothing is hard-coded to a machine, a drive letter,
a user name or a virtualenv:

    data dir        $DSH_COMPANION_DATA_DIR  or  <suite root>/data
    logs            $HUAWEI_LOG_DIR          or  <data>/logs/huawei-health-cn
    snapshots       $HUAWEI_SNAPSHOT_DIR     or  <data>/snapshots/huawei-health-cn
    credential      $HUAWEI_ACCOUNT_JSON     or  <data>/credentials/huawei_account.json

The suite root is the directory two levels above this file (`sidecars/huawei-health-cn` →
repository root), so a checkout works without any environment at all; the environment variables
exist so the suite installer (or a user with a different `dataDir`) can move the data elsewhere.

The credential file is read **in place** and never copied into the repository. Treat it as a
password: it grants read access to the account's health statistics.
"""

from __future__ import annotations

import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
SIDECAR_ROOT = HERE
SUITE_ROOT = HERE.parent.parent


def _env_path(name: str) -> Path | None:
    raw = os.environ.get(name, "").strip()
    return Path(raw).expanduser() if raw else None


def data_dir() -> Path:
    """Suite data directory (`<suite root>/data` unless overridden)."""
    return _env_path("DSH_COMPANION_DATA_DIR") or (SUITE_ROOT / "data")


def logs_dir() -> Path:
    """Where the launcher scripts put stdout/stderr and the PID file."""
    return _env_path("HUAWEI_LOG_DIR") or (data_dir() / "logs" / "huawei-health-cn")


def snapshots_dir() -> Path:
    """Where `capture_snapshot.py` writes redacted snapshots by default."""
    return _env_path("HUAWEI_SNAPSHOT_DIR") or (data_dir() / "snapshots" / "huawei-health-cn")


def credentials_file() -> Path:
    """The token pair. Never in the repository, never echoed, never copied."""
    return _env_path("HUAWEI_ACCOUNT_JSON") or (data_dir() / "credentials" / "huawei_account.json")


def upstream_pkg() -> Path | None:
    """The user's own upstream integration checkout (`custom_components/huawei_health`).

    **This repository does not ship the upstream implementation** (its license is not ours to
    redistribute — see PROTOCOL-FREEZE §1.1), so every code path that needs the real client asks
    for it here. ``None`` means "not configured": callers must say so and stop, never guess.
    """
    return _env_path("HUAWEI_UPSTREAM_PKG")


def serve_script() -> Path | None:
    """The HTTP entry that answers ``GET /api/data``.

    Resolution order: ``$HUAWEI_SERVE_SCRIPT`` → ``<sidecar>/python/serve.py`` (yours, if you drop
    one in) → ``None``. The launchers refuse to start with a clear message when this is ``None``.
    """
    explicit = _env_path("HUAWEI_SERVE_SCRIPT")
    if explicit:
        return explicit
    candidate = SIDECAR_ROOT / "python" / "serve.py"
    return candidate if candidate.is_file() else None


def pid_file(port: int) -> Path:
    """The only handle the stop scripts will ever act on (per port, so two instances cannot clash)."""
    name = "sidecar.pid" if int(port) == 8765 else f"sidecar-{int(port)}.pid"
    return logs_dir() / name


__all__ = [
    "HERE", "SIDECAR_ROOT", "SUITE_ROOT",
    "data_dir", "logs_dir", "snapshots_dir", "credentials_file", "pid_file",
    "upstream_pkg", "serve_script",
]
