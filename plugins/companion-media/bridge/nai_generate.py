"""One-shot NovelAI bridge for companion-media.

Reads one JSON request on stdin and writes one JSON reply on stdout. It never
prints a token, a prompt or a scene description: the reply carries only status,
a params digest, geometry and the generated file's hash.

Why a bridge instead of a port: the independent `astrbot_plugin_image_pipeline`
already encodes the real V4/V5 request format, the Opus-free size rules, the
cloud-queue handshake and the transparent-image rules. Re-implementing those in
JavaScript would drift. This script imports that package's framework-independent
modules under a small `astrbot` shim; it never starts AstrBot and never touches
the plugin's own config file beyond reading it.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import io
import json
import os
import struct
import sys
import time
import types
from pathlib import Path
# --- UTF-8 pipe contract ---
# The host writes UTF-8 JSON on stdin and expects UTF-8 JSON on stdout. On
# Windows, sys.stdin/sys.stdout default to the console code page, which mangles
# non-ASCII prompts. Reconfigure both once, before any read or write.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="surrogateescape")
    except (AttributeError, ValueError):
        pass


SCHEMA_VERSION = 1


# ---------------------------------------------------------------------------
# astrbot shim
# ---------------------------------------------------------------------------

class _Logger:
    def __init__(self):
        self.lines: list[str] = []

    def _write(self, level, message, *args):
        try:
            text = message % args if args else str(message)
        except Exception:
            text = str(message)
        # Keep the bridge's stderr quiet: the JSON reply is the contract.
        self.lines.append(f"[{level}] {text}"[:2000])
        if len(self.lines) > 200:
            del self.lines[:100]

    def info(self, message, *args): self._write("info", message, *args)
    def debug(self, message, *args): self._write("debug", message, *args)
    def warning(self, message, *args): self._write("warning", message, *args)
    def error(self, message, *args): self._write("error", message, *args)
    def exception(self, message, *args): self._write("exception", message, *args)


def install_shims():
    astrbot = types.ModuleType("astrbot")
    api = types.ModuleType("astrbot.api")
    api.logger = _Logger()
    components = types.ModuleType("astrbot.api.message_components")

    class BaseMessageComponent:  # noqa: D401 - marker base class
        pass

    class Image(BaseMessageComponent):
        def __init__(self, file=None, url=None, **kwargs):
            self.file = file
            self.url = url
            self.__dict__.update(kwargs)

    class Node(BaseMessageComponent):
        pass

    class Nodes(BaseMessageComponent):
        pass

    components.BaseMessageComponent = BaseMessageComponent
    components.Image = Image
    components.Node = Node
    components.Nodes = Nodes
    api.message_components = components
    astrbot.api = api
    sys.modules["astrbot"] = astrbot
    sys.modules["astrbot.api"] = api
    sys.modules["astrbot.api.message_components"] = components

    core = types.ModuleType("astrbot.core")
    core_message = types.ModuleType("astrbot.core.message")
    core_components = types.ModuleType("astrbot.core.message.components")
    core_components.BaseMessageComponent = BaseMessageComponent
    core_components.Image = Image
    core.message = core_message
    core_message.components = core_components
    astrbot.core = core
    sys.modules["astrbot.core"] = core
    sys.modules["astrbot.core.message"] = core_message
    sys.modules["astrbot.core.message.components"] = core_components


# `cookit` is a small AstrBot helper package (not installed here). Only two
# helpers are used by the pipeline's models module, and both are pure:
#   * camel_case  -> pydantic serialization aliases
#   * model_with_model_config -> a class decorator that applies a ConfigDict
# Both are re-implemented exactly; nothing else from cookit is reachable.

def _camel_case(name: str) -> str:
    first, *rest = str(name).split("_")
    return first + "".join(part.capitalize() for part in rest)


def _model_with_model_config(config):
    def decorator(cls):
        cls.model_config = config
        try:
            cls.model_rebuild(force=True)
        except Exception:
            pass
        return cls

    return decorator


def install_cookit_shim():
    pyd = types.ModuleType("cookit.pyd")
    pyd.model_with_model_config = _model_with_model_config
    cookit = types.ModuleType("cookit")
    cookit.camel_case = _camel_case
    cookit.pyd = pyd
    sys.modules["cookit"] = cookit
    sys.modules["cookit.pyd"] = pyd


def load_package(root: Path, name: str = "ipx"):
    """Import the pipeline's `src` directory as a package without installing it."""
    src = root / "src"
    if not (src / "params.py").is_file():
        raise RuntimeError(f"image pipeline sources are missing under {src}")
    package = types.ModuleType(name)
    package.__path__ = [str(src)]
    package.__package__ = name
    sys.modules[name] = package
    module = importlib.import_module(f"{name}.params")
    return module


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def png_info(data: bytes) -> dict:
    if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return {"width": None, "height": None, "alpha": False}
    width, height = struct.unpack(">II", data[16:24])
    color_type = data[25]
    bit_depth = data[24]
    has_alpha = color_type in (4, 6)
    if color_type == 3:
        # Palette images need the tRNS chunk to carry transparency.
        has_alpha = b"tRNS" in data[:4096]
    return {"width": width, "height": height, "alpha": bool(has_alpha), "bitDepth": bit_depth}


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def redact(value, depth=0):
    if depth > 6 or value is None or not isinstance(value, (dict, list)):
        return value
    if isinstance(value, list):
        return [redact(item, depth + 1) for item in value]
    out = {}
    for key, item in value.items():
        name = str(key).lower()
        if any(token in name for token in ("token", "key", "secret", "auth")):
            out[key] = "[redacted]"
        else:
            out[key] = redact(item, depth + 1)
    return out


def load_config_module(root: Path):
    module = importlib.import_module("ipx.config")
    return module


def build_config(config_module, config_path: Path):
    raw = json.loads(config_path.read_text(encoding="utf-8-sig"))
    return config_module.Config(**raw)


# The media layer owns the queue settings. They arrive with each request and are
# applied to the in-memory config only: the old AstrBot config file stays
# untouched, and a change here never depends on editing that install.
QUEUE_FIELDS = {
    "enabled": "cloud_queue_enabled",
    "baseUrl": "cloud_queue_base_url",
    "userId": "cloud_queue_user_id",
    "greeting": "cloud_queue_greeting",
    "keyHash": "cloud_queue_key_hash",
    "joinTimeoutSeconds": "cloud_queue_join_timeout_seconds",
    "pollIntervalSeconds": "cloud_queue_poll_interval_seconds",
    "requestTimeoutSeconds": "cloud_queue_request_timeout_seconds",
    "failOpen": "cloud_queue_fail_open",
}


def apply_queue_overrides(config, queue) -> dict:
    """Apply queue settings from the request payload; return the effective ones."""
    request = getattr(config, "request", None)
    if request is None or not isinstance(queue, dict):
        return {}
    updates = {
        target: queue[source]
        for source, target in QUEUE_FIELDS.items()
        if source in queue and queue[source] is not None
    }
    if updates:
        try:
            config.request = request.model_copy(update=updates)
        except AttributeError:  # pragma: no cover - pydantic v1 fallback
            for key, value in updates.items():
                setattr(request, key, value)
    effective = getattr(config, "request", request)
    return {target: getattr(effective, target, None) for target in updates}


def install_queue_probe() -> dict:
    """Measure how long the cloud-queue lock acquisition really took.

    The old pipeline waits for a queue lock around the HTTP call; reporting that
    wait separately is the only way to tell "slow queue" from "slow model".
    """
    probe = {"waitMs": None}
    try:
        module = importlib.import_module("ipx.cloud_queue")
        client = module.CloudQueueClient
        original = client.acquire
    except Exception:
        return probe
    if getattr(client, "_companion_queue_probe", False):
        return probe

    async def timed_acquire(self, *args, **kwargs):
        started_at = time.perf_counter()
        try:
            return await original(self, *args, **kwargs)
        finally:
            probe["waitMs"] = int((time.perf_counter() - started_at) * 1000)

    client.acquire = timed_acquire
    client._companion_queue_probe = True
    return probe


def queue_report(config, probe) -> dict:
    request = getattr(config, "request", None)
    return {
        "enabled": bool(getattr(request, "cloud_queue_enabled", False)),
        "baseUrl": str(getattr(request, "cloud_queue_base_url", "") or ""),
        "userId": str(getattr(request, "cloud_queue_user_id", "") or ""),
        "greeting": str(getattr(request, "cloud_queue_greeting", "") or ""),
        "failOpen": bool(getattr(request, "cloud_queue_fail_open", True)),
        "waitMs": probe.get("waitMs"),
    }


# ---------------------------------------------------------------------------
# request assembly
# ---------------------------------------------------------------------------

def assemble(req_params: dict, config, params_module, models_module):
    data = dict(req_params)
    # Only the fields this bridge owns are accepted; anything else would be a
    # way to smuggle parameters past the caller's quota/limit checks.
    allowed = {
        "model", "tag", "negative", "size", "steps", "scale", "cfg", "sampler",
        "noise_schedule", "seed", "other", "prompt_mode", "natural_prompt",
        "natural_prompt_suffix", "v5_quality_suffix", "straight_alpha", "artist",
    }
    unknown = set(data) - allowed
    if unknown:
        raise ValueError(f"unsupported request fields: {sorted(unknown)}")
    params_module.complete_defaults(data, config)
    req = models_module.Req(**data)
    params_module.post_check_limits(req, config, is_whitelisted=True)
    return req


def main() -> int:
    started = time.time()
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": {"code": "MEDIA_BAD_INPUT", "message": f"invalid json: {exc}"}}))
        return 2

    mode = request.get("mode", "dry-run")
    root = Path(request.get("imagePipelineRoot", "")).expanduser()
    config_path = Path(request.get("configPath", "")).expanduser()
    if mode not in {"dry-run", "generate"}:
        print(json.dumps({"ok": False, "error": {"code": "MEDIA_BAD_INPUT", "message": "mode must be dry-run or generate"}}))
        return 2
    if not root.is_dir():
        print(json.dumps({"ok": False, "error": {"code": "MEDIA_BAD_INPUT", "message": "imagePipelineRoot is not a directory"}}))
        return 2
    if not config_path.is_file():
        print(json.dumps({"ok": False, "error": {"code": "MEDIA_BAD_INPUT", "message": "configPath is not a file"}}))
        return 2

    try:
        install_shims()
        install_cookit_shim()
        params_module = load_package(root)
        config_module = load_config_module(root)
        models_module = importlib.import_module("ipx.models")
        data_source = importlib.import_module("ipx.data_source")
        config = build_config(config_module, config_path)
        apply_queue_overrides(config, request.get("queue"))
        queue_probe = install_queue_probe()
        req = assemble(request.get("params") or {}, config, params_module, models_module)
    except Exception as exc:  # assembly failures are caller-correctable
        print(json.dumps({"ok": False, "error": {"code": "MEDIA_BAD_INPUT", "message": f"{type(exc).__name__}: {exc}"}}))
        return 2

    body = data_source._convert_req_to_official_format(req, opus_free_mode=config.request.opus_free_mode)
    summary = {
        "model": body.get("model"),
        "size": body.get("parameters", {}).get("width"),
        "height": body.get("parameters", {}).get("height"),
        "steps": body.get("parameters", {}).get("steps"),
        "scale": body.get("parameters", {}).get("scale"),
        "sampler": body.get("parameters", {}).get("sampler"),
        "noiseSchedule": body.get("parameters", {}).get("noise_schedule"),
        "seed": body.get("parameters", {}).get("seed"),
        "hasV4Prompt": isinstance(body.get("parameters", {}).get("v4_prompt"), dict),
        "hasV4Negative": isinstance(body.get("parameters", {}).get("v4_negative_prompt"), dict),
        "stream": body.get("parameters", {}).get("stream"),
        "opusFree": bool(config.request.opus_free_mode),
    }
    result = {
        "ok": True,
        "mode": mode,
        "paramsDigest": digest(redact(body))[:32],
        "summary": summary,
        "cloudQueue": bool(config.request.cloud_queue_enabled),
        "queue": queue_report(config, queue_probe),
        "promptMode": getattr(req, "prompt_mode", "tag"),
        "elapsedMs": int((time.time() - started) * 1000),
    }
    # The caller injects the wardrobe and the quality preset, so it must be able to
    # see the caption that actually goes to NovelAI — in dry-run and for real runs.
    if request.get("dumpCaption"):
        parameters = body.get("parameters", {})
        caption = ""
        if isinstance(parameters.get("v4_prompt"), dict):
            caption = str(parameters["v4_prompt"].get("caption", {}).get("base_caption", ""))
        result["caption"] = caption[:400]
        result["negativeChars"] = len(str((parameters.get("v4_negative_prompt") or {}).get("caption", {}).get("base_caption", "")))
    if mode == "dry-run":
        print(json.dumps(result, ensure_ascii=False))
        return 0

    token = ""
    try:
        tokens = config.request.tokens or []
        if isinstance(tokens, list) and tokens:
            token = str(tokens[0])
    except Exception:
        token = ""
    if not token:
        print(json.dumps({**result, "ok": False, "error": {"code": "MEDIA_BACKEND_UNAVAILABLE", "message": "no NovelAI token configured"}}))
        return 3

    timeout_seconds = float(request.get("timeoutSeconds") or 240)

    async def run():
        return await asyncio.wait_for(
            data_source.wrapped_generate(req, config, token),
            timeout=timeout_seconds,
        )

    try:
        image = asyncio.run(run())
    except asyncio.TimeoutError:
        result["queue"] = queue_report(config, queue_probe)
        print(json.dumps({**result, "ok": False, "error": {"code": "MEDIA_TIMEOUT", "message": f"generation exceeded {timeout_seconds}s; result unknown"}}))
        return 4
    except Exception as exc:
        result["queue"] = queue_report(config, queue_probe)
        message = f"{type(exc).__name__}: {exc}"[:300]
        code = "MEDIA_QUOTA_DENIED" if "quota" in message.lower() else "MEDIA_BACKEND_FAILED"
        print(json.dumps({**result, "ok": False, "error": {"code": code, "message": message}}))
        return 5

    # The queue wait only exists after the request ran; refresh before reporting.
    result["queue"] = queue_report(config, queue_probe)

    info = png_info(image)
    out = request.get("out")
    if not out:
        print(json.dumps({**result, "ok": False, "error": {"code": "MEDIA_BAD_INPUT", "message": "out path is required for generate"}}))
        return 2
    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(image)
    print(json.dumps({
        **result,
        "ok": True,
        "file": str(out_path),
        "bytes": len(image),
        "sha256": hashlib.sha256(image).hexdigest(),
        "width": info["width"],
        "height": info["height"],
        "alpha": info["alpha"],
        "elapsedMs": int((time.time() - started) * 1000),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
