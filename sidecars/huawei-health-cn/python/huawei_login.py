"""Interactive login probe for the CN contour of the Huawei Health cloud.

Three steps, each a separate command, so the browser step stays in human hands:

    python huawei_login.py url                 # print + open the consent page
    python huawei_login.py exchange "<paste>"  # trade the pasted code for a token pair
    python huawei_login.py probe               # read real data with the stored pair

The pair is kept in ``tmp/huawei_account.json`` (never in the repository): it grants read
access to the account's health statistics for 180 days, so treat that file as a password.

FROZEN COPY - see ``sidecars/huawei-health-cn/PROTOCOL-FREEZE.md`` for the two adaptations
(A1: path resolution for the flat frozen layout, A2: the uid is masked on the console).  No
protocol behaviour was changed.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import types
import urllib.parse
import webbrowser
from datetime import date
from pathlib import Path

# ── frozen-copy path resolution (adaptation A1 of the freeze, no protocol change) ──────────
# Upstream this file lived next to the checkout and found the integration at
# ``<here>/huawei_health/custom_components/huawei_health``.  In the frozen sidecar the pair
# ``client.py``/``const.py`` sits right next to this file, so the flat layout is tried first and
# the two upstream layouts are kept as fallbacks (handy when running straight from a checkout).
_HERE = Path(__file__).resolve().parent
_WORKSPACE = _HERE.parent.parent.parent           # sidecars/huawei-health-cn/python -> workspace
_PACKAGE_CANDIDATES = (
    _HERE,                                        # frozen layout: python/{client,const}.py
    _HERE / "huawei_health" / "custom_components" / "huawei_health",
    _WORKSPACE / "tmp" / "huawei_health" / "custom_components" / "huawei_health",
)
PACKAGE_DIR = next((path for path in _PACKAGE_CANDIDATES if (path / "client.py").is_file()), _HERE)
REPO = PACKAGE_DIR.parent.parent                  # kept for upstream compatibility

# The credential file is NEVER copied into the sidecar tree: it is read in place, by this
# process only.  ``HUAWEI_ACCOUNT_JSON`` overrides the location for tests / other machines.
STORE = Path(os.environ.get("HUAWEI_ACCOUNT_JSON")
             or _WORKSPACE / "tmp" / "huawei_account.json")


def load() -> tuple[types.ModuleType, types.ModuleType]:
    """Import ``const``/``client`` without dragging the Home Assistant package in."""
    package_dir = PACKAGE_DIR
    package = types.ModuleType("huawei_probe")
    package.__path__ = [str(package_dir)]
    sys.modules["huawei_probe"] = package
    spec = importlib.util.spec_from_file_location(
        "huawei_probe.const", package_dir / "const.py")
    const = importlib.util.module_from_spec(spec)
    sys.modules["huawei_probe.const"] = const
    spec.loader.exec_module(const)
    spec = importlib.util.spec_from_file_location(
        "huawei_probe.client", package_dir / "client.py")
    client = importlib.util.module_from_spec(spec)
    sys.modules["huawei_probe.client"] = client
    spec.loader.exec_module(client)
    return const, client


CONST, CLIENT = load()


def show_url() -> None:
    url = CLIENT.authorization_url()
    print(url)
    print(f"\nlogin page host : {urllib.parse.urlsplit(url).netloc}")
    print(f"oauth base      : {CONST.OAUTH_BASE}")
    Path(__file__).resolve().parent.joinpath("huawei_authorize_url.txt").write_text(
        url, encoding="utf-8")
    opened = False
    try:
        opened = webbrowser.open(url, new=2)
    except Exception as exc:  # noqa: BLE001 - a headless box is not an error here
        print(f"could not open a browser automatically: {exc}")
    print(f"browser opened  : {opened}")


_TOKEN_FIELDS = ("access_token", "refresh_token", "uid")


def mask(value) -> str:
    """Never print a credential or a full account id (freeze adaptation A2)."""
    text = "" if value is None else str(value)
    return f"{text[:6]}…" if text else "-"


def save(tokens) -> None:
    STORE.write_text(json.dumps(tokens.as_dict, indent=2), encoding="utf-8")
    print(f"stored the pair (uid={mask(tokens.uid)}, session_host={tokens.session_host})")
    print(f"file: {STORE}")


def load_tokens():
    data = json.loads(STORE.read_text(encoding="utf-8"))
    return CLIENT.Tokens(**data)


def do_exchange(pasted: str) -> None:
    code = CLIENT.authorization_code_from(pasted)
    if not code:
        raise SystemExit("no authorization code found in the pasted text")
    print(f"code length     : {len(code)}")
    tokens = CLIENT.exchange_authorization_code(code)
    save(tokens)
    print("\nwho am I:")
    info = CLIENT.query_access_token(tokens.access_token,
                                     session_host=tokens.session_host)
    for key in ("nickName", "displayName", "uid", "siteId", "headPictureUrl"):
        if info.get(key):
            shown = mask(info[key]) if key in _TOKEN_FIELDS else info[key]
            print(f"  {key}: {shown}")
    return tokens


def do_probe() -> None:
    tokens = load_tokens()
    api = CLIENT.HuaweiHealthClient(tokens)
    print(f"data host       : {api.host}")
    print(f"session host    : {tokens.session_host or CONST.SESSION_HOSTS[0]}")
    print(f"token expires   : {date.fromtimestamp(tokens.expires_at) if tokens.expires_at else '-'}")

    print("\n== daily activity ==")
    for row in api.daily_summary(3):
        print(f"  {row['date']} type={row['sport_type']} steps={row['steps']} "
              f"dist={row['distance_m']}m kcal={row['kcal']} active_h={row['active_hours']}")

    print("\n== health (heart rate / sleep / stress) ==")
    for row in api.health_summary(3):
        shown = {k: v for k, v in row.items() if k != "date"}
        print(f"  {row['date']} {shown}")

    print("\n== workouts (7 days) ==")
    for session in api.sessions(7)[-5:]:
        print(f"  {session['start']} type={session['sport_type']} "
              f"{session['duration_min']}min {session['distance_m']}m {session['kcal']}kcal")

    print("\n== bound devices ==")
    answer = api.bind_devices()
    print(f"  resultCode={answer.get('resultCode')} keys={sorted(answer)[:8]}")

    # A read may have rotated the pair; a rotated access token is the only one that works.
    if tokens.dirty:
        save(tokens)


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] not in ("url", "exchange", "probe"):
        print(__doc__)
        return 2
    if argv[1] == "url":
        show_url()
    elif argv[1] == "exchange":
        if len(argv) < 3:
            raise SystemExit("pass the pasted redirect address / console line as one argument")
        do_exchange(argv[2])
        print("\nnow read the account:  python huawei_login.py probe")
    else:
        do_probe()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
