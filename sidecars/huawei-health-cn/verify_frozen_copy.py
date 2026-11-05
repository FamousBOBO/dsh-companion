#!/usr/bin/env python3
"""Check the client/const copies under ``python/`` — either on their own, or against an upstream.

    python sidecars/huawei-health-cn/verify_frozen_copy.py
    HUAWEI_UPSTREAM_PKG=/path/to/custom_components/huawei_health \
        python sidecars/huawei-health-cn/verify_frozen_copy.py

What is in ``python/`` (see ``PROTOCOL-FREEZE.md`` §1.1):

* ``client.py`` / ``const.py`` — **derived copies** of the MIT-licensed upstream integration
  (`and7ey/huawei_health`, ``Copyright (c) 2026 and7ey``; full text in ``UPSTREAM-LICENSE.txt``).
  They are **not** byte-identical to today's upstream: the commit the freeze recorded is no longer
  reachable, upstream's current files are different sizes, and these copies carry the flat-layout
  path resolution (adaptation A1).
* ``huawei_dashboard.py`` — this project's own read-only HTTP harness (not upstream).
* ``huawei_login.py`` — derived from the upstream login probe + two documented adaptations
  (A1 path resolution, A2 the uid is masked on the console).

Two modes:

* **self-check (default)** — no upstream needed. Verifies the files are present, parse, keep their
  provenance block, and still expose the definitions the protocol depends on.
* **compare (``HUAWEI_UPSTREAM_PKG`` set)** — additionally diffs each copy against the upstream file
  and prints the changed lines. Drift is *expected* for a derived copy, so it is reported, not failed;
  a missing provenance block or a dropped definition still fails.

Exit codes: ``0`` ok, ``1`` structural problem (missing file / broken provenance / dropped
definition), ``3`` the configured upstream path is unusable (nothing to compare against).
"""

from __future__ import annotations

import ast
import difflib
import hashlib
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUITE_ROOT = HERE.parent.parent
PYTHON_DIR = HERE / "python"

#: Optional newer upstream checkout: `.../custom_components/huawei_health` (the package directory).
_UPSTREAM = os.environ.get("HUAWEI_UPSTREAM_PKG", "").strip()
UPSTREAM_PKG = Path(_UPSTREAM).expanduser() if _UPSTREAM else None

#: (copy in this repo, upstream file name inside the checkout, or None when upstream has no such file)
COPIES = (
    ("client.py", "client.py"),
    ("const.py", "const.py"),
    ("huawei_dashboard.py", None),      # our own harness — nothing upstream to compare with
    ("huawei_login.py", "login.py"),    # upstream keeps a login probe; ours is derived from it
)

PROVENANCE_RE = re.compile(
    r"# --- sidecar-freeze provenance .*?# --- end sidecar-freeze provenance ---\n\n", re.S)

#: Definitions the rest of this sidecar (and the frozen protocol) actually depends on.
REQUIRED = {
    "client.py": {"HuaweiHealthClient", "Tokens", "health_series", "HuaweiAuthError"},
    "const.py": {"APP_HOSTS", "SESSION_HOSTS", "OAUTH_BASE", "SPORT_TYPES"},
    "huawei_dashboard.py": {"main"},
    "huawei_login.py": {"PACKAGE_DIR", "STORE", "load", "load_tokens"},
}

#: The adaptations ``huawei_login.py`` is allowed to carry (PROTOCOL-FREEZE.md §1.1).
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


def recorded_upstream_sha(text: str) -> str | None:
    match = re.search(r"# upstream-sha256:\s*([0-9a-f]{16,64})", text)
    return match.group(1) if match else None


def self_check() -> int:
    failures = 0
    print("self-check (no upstream needed)")
    for name, _upstream_name in COPIES:
        path = PYTHON_DIR / name
        if not path.is_file():
            print(f"  MISSING  {name}")
            failures += 1
            continue
        text = path.read_text(encoding="utf-8")
        body = strip_provenance(text)
        has_block = "sidecar-freeze provenance" in text
        try:
            names = top_level_names(body)
        except SyntaxError as err:
            print(f"  FAIL     {name}: does not parse ({err})")
            failures += 1
            continue
        missing = sorted(REQUIRED[name] - names)
        recorded = recorded_upstream_sha(text)
        line_count = len(body.splitlines())
        print(f"  {name:22} {line_count:5d} lines (provenance stripped)  sha256 {sha256_text(body)[:16]}…"
              f"  upstream-sha256 {'recorded' if recorded else 'not recorded'}"
              f"  provenance {'ok' if has_block else 'ABSENT'}")
        if not has_block:
            print("      FAIL expected a provenance block in the header (see PROTOCOL-FREEZE §1.1)")
            failures += 1
        if missing:
            print(f"      FAIL missing definitions: {missing}")
            failures += 1
        if name == "huawei_login.py":
            absent = [marker for marker in EXPECTED_PATCH_MARKERS if marker not in body]
            if absent:
                print(f"      FAIL expected adaptation markers absent: {absent}")
                failures += 1
    print()
    if failures:
        print(f"FAILED: {failures} structural problem(s) — do not trust the copies until this is green")
        return 1
    print("OK: the copies are present, parse, keep their provenance and expose the protocol surface")
    if UPSTREAM_PKG is None:
        print("    (set HUAWEI_UPSTREAM_PKG=<your checkout> to also diff against upstream)")
    return 0


def compare_with_upstream() -> int:
    assert UPSTREAM_PKG is not None
    failures = 0
    print(f"compare with upstream: {UPSTREAM_PKG}")
    print("  `raw` = on-disk byte hash; `body` = the copy with its provenance block stripped.")
    print("  Drift is expected: these are derived copies (MIT), not byte-identical snapshots.")
    for name, upstream_name in COPIES:
        copy = PYTHON_DIR / name
        if not copy.is_file():
            print(f"  MISSING  {name}")
            failures += 1
            continue
        if upstream_name is None:
            print(f"  {name:22} local-only (no upstream counterpart) — skipped")
            continue
        origin = (UPSTREAM_PKG.parent / upstream_name) if upstream_name != "client.py" and upstream_name != "const.py" \
            else (UPSTREAM_PKG / upstream_name)
        if not origin.is_file():
            print(f"  {name:22} upstream file not found: {origin} — nothing to compare")
            continue
        origin_raw = sha256_bytes(origin.read_bytes())
        copy_raw = sha256_bytes(copy.read_bytes())
        original = origin.read_text(encoding="utf-8")
        body = strip_provenance(copy.read_text(encoding="utf-8"))
        diff = list(difflib.unified_diff(
            original.splitlines(), body.splitlines(),
            fromfile=str(origin), tofile=str(copy), lineterm="", n=1))
        changed = [line for line in diff if line[:1] in "+-" and not line.startswith(("+++", "---"))]
        lost = top_level_names(original) - top_level_names(body)
        same = original == body
        print(f"  {name:22} raw upstream {origin_raw[:16]}… / copy {copy_raw[:16]}…"
              f"  body {'IDENTICAL' if same else 'DERIVED'}"
              f"  changed lines {len(changed)}")
        if lost:
            print(f"      FAIL upstream definitions dropped: {sorted(lost)}")
            failures += 1
        for line in changed[:40]:
            print(f"      {line}")
        if len(changed) > 40:
            print(f"      … {len(changed) - 40} more changed lines")
    print()
    if failures:
        print(f"FAILED: {failures} structural problem(s)")
        return 1
    print("OK: every copy is present and keeps the upstream definitions "
          "(differences are the documented adaptations)")
    return 0


def main() -> int:
    if UPSTREAM_PKG is not None and not UPSTREAM_PKG.is_dir():
        print(f"upstream path unusable: {UPSTREAM_PKG} (not a directory) — nothing to compare against",
              file=sys.stderr)
        return 3
    return compare_with_upstream() if UPSTREAM_PKG is not None else self_check()


if __name__ == "__main__":
    raise SystemExit(main())
