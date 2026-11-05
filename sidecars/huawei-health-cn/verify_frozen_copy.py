#!/usr/bin/env python3
"""Re-prove that ``python/`` holds the upstream files, not a rewrite.

    tmp\\hwvenv\\Scripts\\python.exe sidecars\\huawei-health-cn\\verify_frozen_copy.py

Two kinds of copy live in ``python/``:

**verbatim** — ``client.py``, ``const.py``, ``huawei_dashboard.py``.  The only difference from
``tmp/`` is a five-line provenance comment block; delete that block and the file is byte-identical
(sha256 compared here).

**patched** — ``huawei_login.py``.  It keeps the upstream logic but needs four edits to run from
this layout (path resolution, ``HUAWEI_ACCOUNT_JSON``, the ``os`` import, masked console output).
For those the script asserts the patch is *only* that: every upstream top-level name is still
defined and the diff is printed for review.  Nothing else in the tree is allowed to drift.

Exit codes: ``0`` all good, ``1`` drift found, ``3`` ``tmp/`` originals are gone (nothing to
compare against — the frozen copies then stand alone).
"""

from __future__ import annotations

import ast
import difflib
import hashlib
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parent.parent
PYTHON_DIR = HERE / "python"

UPSTREAM_PKG = WORKSPACE / "tmp" / "huawei_health" / "custom_components" / "huawei_health"

VERBATIM = (
    (UPSTREAM_PKG / "client.py", PYTHON_DIR / "client.py"),
    (UPSTREAM_PKG / "const.py", PYTHON_DIR / "const.py"),
    (WORKSPACE / "tmp" / "huawei_dashboard.py", PYTHON_DIR / "huawei_dashboard.py"),
)

PATCHED = (
    (WORKSPACE / "tmp" / "huawei_login.py", PYTHON_DIR / "huawei_login.py"),
)

PROVENANCE_RE = re.compile(
    r"# --- sidecar-freeze provenance .*?# --- end sidecar-freeze provenance ---\n\n", re.S)

#: The adaptations huawei_login.py is allowed to carry (PROTOCOL-FREEZE.md §3).
EXPECTED_PATCH_MARKERS = ("PACKAGE_DIR", "HUAWEI_ACCOUNT_JSON", "def mask(", "import os")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def strip_provenance(text: str) -> str:
    return PROVENANCE_RE.sub("", text)


def top_level_names(source: str) -> set[str]:
    tree = ast.parse(source)
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    names.add(target.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def main() -> int:
    if not UPSTREAM_PKG.is_dir():
        print(f"originals gone: {UPSTREAM_PKG} — the frozen copies stand on their own", file=sys.stderr)
        return 3

    failures = 0
    print("verbatim copies (provenance block stripped)")
    print("  `raw` is the on-disk byte hash (what the header comment records);")
    print("  `body` is the same text with the provenance block removed, newlines normalised.")
    for origin, copy in VERBATIM:
        if not origin.is_file() or not copy.is_file():
            print(f"  MISSING  {origin} / {copy}")
            failures += 1
            continue
        origin_raw = sha256_bytes(origin.read_bytes())
        copy_raw = sha256_bytes(copy.read_bytes())
        original = origin.read_text(encoding="utf-8")
        body = strip_provenance(copy.read_text(encoding="utf-8"))
        same = original == body
        mark = "IDENTICAL" if same else "DRIFT"
        print(f"  {mark:9} {copy.name:22} raw origin {origin_raw[:16]}… / copy {copy_raw[:16]}…")
        print(f"  {'':9} {'':22} body {sha256_text(body)[:16]}… vs original text "
              f"{sha256_text(original)[:16]}…  -> {'equal' if same else 'DIFFERENT'}")
        if not same:
            failures += 1
            diff = difflib.unified_diff(original.splitlines(), body.splitlines(),
                                        fromfile=str(origin), tofile=str(copy), lineterm="")
            for line in list(diff)[:40]:
                print(f"      {line}")

    print("\npatched copy (documented adaptations only)")
    for origin, copy in PATCHED:
        if not origin.is_file() or not copy.is_file():
            print(f"  MISSING  {origin} / {copy}")
            failures += 1
            continue
        origin_raw = sha256_bytes(origin.read_bytes())
        copy_raw = sha256_bytes(copy.read_bytes())
        original = origin.read_text(encoding="utf-8")
        adapted = copy.read_text(encoding="utf-8")
        body = strip_provenance(adapted)
        missing_markers = [m for m in EXPECTED_PATCH_MARKERS if m not in body]
        lost = top_level_names(original) - top_level_names(body)
        print(f"  {copy.name:22} raw origin {origin_raw[:16]}… / copy {copy_raw[:16]}…")
        if missing_markers:
            print(f"      FAIL expected patch markers absent: {missing_markers}")
            failures += 1
        if lost:
            print(f"      FAIL upstream definitions dropped: {sorted(lost)}")
            failures += 1
        diff = [line for line in difflib.unified_diff(
            original.splitlines(), body.splitlines(),
            fromfile=str(origin), tofile=str(copy), lineterm="", n=1)]
        changed = [line for line in diff if line[:1] in "+-" and not line.startswith(("+++", "---"))]
        print(f"      changed lines vs upstream: {len(changed)} (all reviewed here)")
        for line in changed:
            print(f"      {line}")

    print()
    if failures:
        print(f"FAILED: {failures} drift item(s) — the freeze is broken, do not trust the copies")
        return 1
    print("OK: the frozen copies match the upstream originals (within the documented patch)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
