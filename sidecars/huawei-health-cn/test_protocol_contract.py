#!/usr/bin/env python3
"""Offline protocol contract test for the frozen CN Huawei Health sidecar.

    python sidecars/huawei-health-cn/test_protocol_contract.py -v
    # a specific snapshot instead of the newest one:
    HUAWEI_SNAPSHOT=<path>/cn-snapshot-YYYYMMDD-HHMM.json python sidecars/huawei-health-cn/test_protocol_contract.py -v

**No network, no credential file, no sidecar process.**  Everything is asserted against

1. redacted snapshots (default `<data>/snapshots/huawei-health-cn/`, override with
   ``HUAWEI_SNAPSHOT`` / ``HUAWEI_SNAPSHOT_DIR``) — the real payload the sidecar answered, and
2. **your own** upstream checkout (``HUAWEI_UPSTREAM_PKG``) — importing it proves it still loads,
   and ``health_series()`` is a pure function, so the "0 / -1 means not measured" rule can be
   exercised on a synthetic cloud answer without a single request.

This repository does **not** ship the upstream implementation (see ``PROTOCOL-FREEZE.md`` §1.1),
so case group 2 **skips** with that reason until you point ``HUAWEI_UPSTREAM_PKG`` at a checkout.

Snapshots are personal data, so they are **not** in the repository; without one, the
snapshot-dependent cases `skip` (they do not fail) and the rule-level cases still run.
Standard library ``unittest`` only, on purpose — it must stay runnable under a bare interpreter.
"""

from __future__ import annotations

import json
import os
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import redact  # noqa: E402  - same directory as this file
import sidecar_paths  # noqa: E402  - same directory as this file

SNAPSHOT_DIR = sidecar_paths.snapshots_dir()
PYTHON_DIR = HERE / "python"

#: Top-level keys the frozen protocol promises (design/health/INTERFACES.md §5, README §8).
REQUIRED_TOP_LEVEL = {
    "synced_at", "synced_at_text", "daily", "health", "sleep_rows", "sessions", "devices",
    "realtime", "token", "sources", "errors", "newest_cloud", "scope",
}

#: The only keys a stored ``token`` block may carry (``redact.TOKEN_KEY_WHITELIST``).
TOKEN_KEYS = set(redact.TOKEN_KEY_WHITELIST)

#: Devices that carry a health metric; their values are data, not credentials, and must survive.
HEALTH_ROW_KEYS = {
    "date", "heart_rate", "max_heart_rate", "min_heart_rate", "resting_heart_rate",
    "average_resting_heart_rate", "stress_average", "stress_last", "stress_max", "stress_min",
    "stress_measurements", "moderate_high_intensity_minutes", "spo2_avg", "spo2_min", "spo2_max",
    "spo2_last", "sleep_duration", "sleep_deep", "sleep_light", "sleep_rem", "sleep_awake",
    "sleep_score", "sleep_efficiency", "sleep_latency", "sleep_wake_ups", "sleep_average_heart_rate",
    "sleep_hrv", "sleep_spo2", "fall_asleep", "wakeup",
}

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HEX16_RE = re.compile(r"^[0-9a-f]{16}$")

_frozen: dict[str, object] = {}


def frozen() -> dict[str, object]:
    """Import the **user's** upstream copies once (no network, no token file touched).

    This repository deliberately does **not** ship the upstream implementation (its license is not
    ours to distribute — see PROTOCOL-FREEZE §1.1). Point ``HUAWEI_UPSTREAM_PKG`` at your own
    checkout and the copy-level cases run; without it they **skip** with this reason instead of
    failing, and the snapshot/redaction cases still run.
    """
    if not _frozen:
        package_dir = sidecar_paths.upstream_pkg()
        if package_dir is None:
            raise unittest.SkipTest(
                "no upstream checkout: set HUAWEI_UPSTREAM_PKG to your own "
                "custom_components/huawei_health directory (this repository does not ship it)")
        sys.path.insert(0, str(package_dir.parent))
        sys.path.insert(0, str(package_dir))
        # The upstream package's own module names: `client.py` / `const.py`.
        import client as upstream_client  # noqa: PLC0415 - deliberately lazy
        import const as upstream_const  # noqa: PLC0415 - deliberately lazy

        _frozen["client"] = upstream_client
        _frozen["const"] = upstream_const
    return _frozen


def snapshot_path() -> Path:
    override = os.environ.get("HUAWEI_SNAPSHOT")
    if override:
        return Path(override)
    candidates = sorted(SNAPSHOT_DIR.glob("cn-snapshot-*.json"))
    if not candidates:
        raise unittest.SkipTest(f"no snapshot in {SNAPSHOT_DIR} - run capture_snapshot.py first")
    return candidates[-1]


def load_snapshot() -> tuple[Path, str, dict]:
    path = snapshot_path()
    text = path.read_text(encoding="utf-8")
    return path, text, json.loads(text)


class TestFrozenCopiesLoad(unittest.TestCase):
    """The upstream client/const must import and behave (skipped when no checkout is configured)."""

    def test_copies_import_without_network(self) -> None:
        modules = frozen()
        self.assertTrue(hasattr(modules["client"], "HuaweiHealthClient"))
        self.assertTrue(hasattr(modules["client"], "Tokens"))
        self.assertTrue(callable(modules["client"].health_series))

    def test_contour_is_china(self) -> None:
        const = frozen()["const"]
        # INTERFACES.md §5 / PROTOCOL-FREEZE.md §2: element 0 is the CN default host.
        self.assertEqual(const.APP_HOSTS[0], "https://healthdata.dbankcloud.cn")
        self.assertEqual(const.SESSION_HOSTS[0], "https://healthcommon.dbankcloud.cn")
        self.assertEqual(const.OAUTH_BASE, "https://oauth-login.cloud.huawei.com.cn/oauth2")

    def test_sport_type_two_stays_the_upstream_mapping(self) -> None:
        """sportType 2 -> 'hill' is upstream's table, frozen on purpose (§5 of the freeze)."""
        const = frozen()["const"]
        self.assertEqual(const.SPORT_TYPES[2], "hill")
        self.assertIn(2, const.SPORT_TYPES)

    def test_health_series_treats_zero_and_minus_one_as_not_measured(self) -> None:
        client = frozen()["client"]
        answer = {"heartRateTotal": [{
            "recordDay": 20261103,
            "heartRateBasic": {"lastHeartRate": 0, "minHeartRate": -1,
                               "maxHeartRate": 112, "lastRestHeartRate": 79},
        }]}
        rows = client.health_series(answer)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["date"], "2026-11-03")
        self.assertEqual(row["max_heart_rate"], 112)
        self.assertEqual(row["resting_heart_rate"], 79)
        self.assertNotIn("heart_rate", row)   # 0  -> not measured, dropped
        self.assertNotIn("min_heart_rate", row)  # -1 -> not measured, dropped

    def test_health_series_keeps_the_sleep_family_the_probe_watches(self) -> None:
        """The 11/04 probe looks for exactly these keys; pin the shape offline."""
        client = frozen()["client"]
        answer = {"professionalSleepTotal": [{
            "recordDay": 20261104,
            "professionalSleep": {"allSleepTime": 402, "deepSleepTime": 71, "lightSleepTime": 250,
                                  "dreamTime": 60, "awakeTime": 21, "sleepScore": 83,
                                  "fallAsleepTime": 1793664000000, "wakeupTime": 1793692800000},
        }]}
        rows = client.health_series(answer)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["sleep_duration"], 402.0)
        self.assertEqual(row["sleep_deep"], 71.0)
        self.assertEqual(row["sleep_rem"], 60.0)
        self.assertEqual(row["sleep_score"], 83.0)
        self.assertIn("fall_asleep", row)
        self.assertIn("wakeup", row)

    def test_health_series_drops_an_all_zero_sleep_night(self) -> None:
        client = frozen()["client"]
        answer = {"professionalSleepTotal": [{
            "recordDay": 20261104,
            "professionalSleep": {"allSleepTime": 0, "deepSleepTime": -1, "sleepScore": 0},
        }]}
        rows = client.health_series(answer)
        self.assertEqual(rows, [{"date": "2026-11-04"}])


class SnapshotCase(unittest.TestCase):
    """Base class: every test runs against the newest committed snapshot."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.path, cls.text, cls.doc = load_snapshot()


class TestTopLevelContract(SnapshotCase):
    def test_required_fields_are_present(self) -> None:
        missing = REQUIRED_TOP_LEVEL - set(self.doc)
        self.assertEqual(missing, set(), f"snapshot {self.path.name} is missing {sorted(missing)}")

    def test_container_types(self) -> None:
        for key in ("daily", "health", "sleep_rows", "sessions", "devices", "sources", "errors"):
            self.assertIsInstance(self.doc[key], list, key)
        for key in ("realtime", "token", "scope"):
            self.assertIsInstance(self.doc[key], dict, key)

    def test_scope_is_a_7_day_window(self) -> None:
        self.assertEqual(self.doc["scope"].get("days"), 7)
        self.assertIn(7, self.doc["scope"].get("allowed_days") or [])

    def test_errors_is_empty_or_a_list_of_strings(self) -> None:
        self.assertTrue(all(isinstance(item, str) for item in self.doc["errors"]))


class TestTokenBlockIsRedacted(SnapshotCase):
    def test_only_whitelisted_keys(self) -> None:
        extra = set(self.doc["token"]) - TOKEN_KEYS
        self.assertEqual(extra, set(), f"token block grew unredacted keys: {sorted(extra)}")

    def test_raw_uid_is_gone(self) -> None:
        self.assertNotIn("uid", self.doc["token"])
        self.assertNotIn("uid", self.doc["_capture"]["redactionRules"])

    def test_uid_pseudonym_is_sha16(self) -> None:
        value = self.doc["token"].get("uid_sha256_16")
        if value is not None:
            self.assertRegex(value, HEX16_RE)

    def test_no_token_material_in_the_file(self) -> None:
        self.assertNotIn("DgE", self.text)              # the prefix of this account's tokens
        self.assertNotIn("accessToken", self.text)
        self.assertNotIn("refreshToken", self.text)
        self.assertNotIn("x-huid", self.text)

    def test_privacy_grep_pattern_matches_nothing(self) -> None:
        self.assertIsNone(re.search(redact.PRIVACY_GREP_PATTERN, self.text),
                          "the README privacy regression check must stay silent")


class TestDailyContract(SnapshotCase):
    def test_each_row_has_the_required_fields(self) -> None:
        self.assertTrue(self.doc["daily"], "a 7-day window must have at least one day")
        for row in self.doc["daily"]:
            for field in ("date", "steps", "distance_m", "kcal"):
                self.assertIn(field, row, f"daily row {row.get('date')} lacks {field}")
            self.assertRegex(row["date"], DATE_RE)
            self.assertIsInstance(row["steps"], int)
            self.assertGreaterEqual(row["steps"], 0)
            self.assertIsInstance(row["sport_type"], int)   # 0 = the day's total row

    def test_days_are_ascending_and_unique(self) -> None:
        dates = [row["date"] for row in self.doc["daily"]]
        self.assertEqual(dates, sorted(dates))
        self.assertEqual(len(dates), len(set(dates)))


class TestSessionsKeepTheRawSportType(SnapshotCase):
    def test_sport_type_is_the_raw_integer(self) -> None:
        const = frozen()["const"]
        for session in self.doc["sessions"]:
            self.assertIsInstance(session["sport_type"], int, "raw sport code must stay an int")
            self.assertNotIsInstance(session["sport_type"], bool)
            # the label is upstream's opinion about the code, kept next to it, never instead
            self.assertEqual(session["sport"], const.SPORT_TYPES.get(session["sport_type"]))

    def test_sessions_have_bounds(self) -> None:
        for session in self.doc["sessions"]:
            self.assertRegex(session["start"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")
            self.assertGreaterEqual(session["duration_min"], 0)
            self.assertIn("sport", session)


class TestSleepRowsMayBeEmpty(SnapshotCase):
    def test_sleep_rows_is_a_list(self) -> None:
        self.assertIsInstance(self.doc["sleep_rows"], list)

    def test_empty_is_not_an_error(self) -> None:
        if not self.doc["sleep_rows"]:
            # The account has no sleep family on the cloud (README §10.1).  That is a valid
            # answer, not a fault: no errors, and no sleep_* metric smuggled into health[].
            self.assertEqual(self.doc["errors"], [])
            smuggled = {key for row in self.doc["health"] for key in row
                        if key.startswith("sleep_")}
            self.assertEqual(smuggled, set())

    def test_rows_would_be_parsable(self) -> None:
        for row in self.doc["sleep_rows"]:
            self.assertIsInstance(row, dict)
            self.assertRegex(row.get("date", ""), DATE_RE)


class TestHealthRowsCarryRealReadings(SnapshotCase):
    def test_values_are_readings_never_zero_or_minus_one(self) -> None:
        for row in self.doc["health"]:
            self.assertRegex(row["date"], DATE_RE)
            for key, value in row.items():
                if key == "date" or not isinstance(value, (int, float)):
                    continue
                self.assertNotIn(value, (0, -1),
                                 f"{row['date']}.{key} is the cloud's 'not measured' marker")
                self.assertGreater(value, 0, f"{row['date']}.{key} must be positive")

    def test_keys_are_known_metric_names(self) -> None:
        unknown = {key for row in self.doc["health"] for key in row} - HEALTH_ROW_KEYS
        self.assertEqual(unknown, set(), f"undocumented health keys: {sorted(unknown)}")

    def test_heart_rate_and_spo2_ranges_survive_redaction(self) -> None:
        for row in self.doc["health"]:
            for key in ("heart_rate", "max_heart_rate", "min_heart_rate", "resting_heart_rate"):
                if key in row:
                    self.assertTrue(20 <= row[key] <= 250, f"{row['date']}.{key}={row[key]}")
            for key in ("spo2_avg", "spo2_min", "spo2_max", "spo2_last"):
                if key in row:
                    self.assertTrue(50 <= row[key] <= 100, f"{row['date']}.{key}={row[key]}")


class TestRealtimeAndSourcesSurvive(SnapshotCase):
    def test_realtime_values_are_kept(self) -> None:
        """Realtime numbers are health data, not credentials — redaction must not eat them."""
        for stream, sample in self.doc["realtime"].items():
            self.assertIsInstance(sample, dict, stream)
            self.assertIn("value", sample)
            self.assertIn("at", sample)
            self.assertIsInstance(sample["value"], (int, float))
            self.assertGreater(sample["value"], 0)

    def test_source_rt_text_is_kept(self) -> None:
        self.assertTrue(self.doc["sources"])
        for source in self.doc["sources"]:
            self.assertIn("name", source)
            self.assertIn("rt_text", source)


class TestDeviceIdentifiersArePseudonyms(SnapshotCase):
    def test_every_identifier_is_a_sha16(self) -> None:
        self.assertTrue(self.doc["devices"])
        for index, device in enumerate(self.doc["devices"]):
            for field in redact.DEVICE_HASH_FIELDS:
                if field in device:
                    self.assertRegex(str(device[field]), HEX16_RE,
                                     f"devices[{index}].{field} is not a pseudonym")

    def test_opaque_blob_is_reduced_to_a_hash(self) -> None:
        for device in self.doc["devices"]:
            if "deviceData" in device:
                blob = device["deviceData"]
                if blob is not None:
                    self.assertEqual(set(blob), {"bytes", "sha256_16", "dropped"})
                    self.assertTrue(blob["dropped"])
                    self.assertRegex(blob["sha256_16"], HEX16_RE)

    def test_names_and_codes_are_kept(self) -> None:
        """Device names are diagnostics the operator reads in the acceptance log."""
        self.assertTrue(any(device.get("name") for device in self.doc["devices"]))
        for device in self.doc["devices"]:
            self.assertIsInstance(device.get("deviceCode"), int)

    def test_hashing_is_deterministic(self) -> None:
        """The same raw payload always redacts to the same document (stable pseudonyms)."""
        raw = {"devices": [{"uniqueId": "raw-unique-1", "devId": "raw-dev-1", "name": "band"},
                           {"uniqueId": "raw-unique-1", "devId": "raw-dev-2", "name": "band"}],
               "token": {"uid": "10086000026432748", "expires_in_min": 50}}
        first = redact.redact_payload(raw)
        second = redact.redact_payload(json.loads(json.dumps(raw)))
        self.assertEqual(first, second)
        self.assertEqual(first["devices"][0]["uniqueId"], redact.sha16("raw-unique-1"))
        # the same raw identifier seen twice must collapse to the same pseudonym, not to two
        self.assertEqual(first["devices"][0]["uniqueId"], first["devices"][1]["uniqueId"])
        self.assertNotEqual(first["devices"][0]["devId"], first["devices"][1]["devId"])


class TestRedactionRulesOnASyntheticPayload(unittest.TestCase):
    """The redaction rules themselves, independent of what today's snapshot happens to hold."""

    RAW = {
        "synced_at": 1793711067.16,
        "token": {
            "uid": "10086000026432748",
            "accessToken": "DgEBIwUaXbYcZd1e2f3g4h5i6j7k8l9m0n",
            "refreshToken": "DgFBIwUaXbYcZd1e2f3g4h5i6j7k8l9m0n",
            "session_host": "https://healthcommon.dbankcloud.cn",
            "data_host": "https://healthdata.dbankcloud.cn",
            "expires_in_min": 50,
            "expires_at_text": "2026-11-03 21:54:38",
            "refresh_dies_text": "2027-05-02 19:04:43",
            "rotated": False,
            "Authorization": "Bearer DgEBIwUaXbYcZd1e2f",
            "x-huid": "10086000026432748",
        },
        "devices": [{
            "name": "HUAWEI Band 8-002",
            "uniqueId": "raw-unique", "devId": "raw-dev", "udid": "u" * 64,
            "sn": "SN123456", "mac": "AA:BB:CC:DD:EE:FF", "deviceData": "opaque-blob",
            "deviceCode": 1260900415, "productId": 700,
        }],
        "realtime": {"心率": {"value": 95.0, "unit": "bpm", "at": 1793708340.0}},
        "sources": [{"name": "心率", "rt_text": "95 bpm @ 20:19"}],
        "daily": [{"date": "2026-11-03", "steps": 1112, "distance_m": 864, "kcal": 53.1}],
        "health": [{"date": "2026-11-03", "heart_rate": 95.0}],
        "sleep_rows": [], "sessions": [], "errors": [], "newest_cloud": 1793708766.66,
        "scope": {"days": 7},
    }

    def redacted(self) -> dict:
        return redact.redact_payload(self.RAW)

    def test_access_and_refresh_tokens_are_dropped(self) -> None:
        out = self.redacted()
        self.assertNotIn("accessToken", out["token"])
        self.assertNotIn("refreshToken", out["token"])
        self.assertNotIn("Authorization", out["token"])
        self.assertNotIn("x-huid", out["token"])
        self.assertNotIn("DgE", json.dumps(out))

    def test_token_keeps_only_the_whitelist(self) -> None:
        token = self.redacted()["token"]
        self.assertLessEqual(set(token), TOKEN_KEYS)
        self.assertNotIn("uid", token)
        self.assertEqual(token["uid_sha256_16"], redact.sha16("10086000026432748"))
        self.assertEqual(token["expires_in_min"], 50)

    def test_device_identifiers_become_pseudonyms(self) -> None:
        device = self.redacted()["devices"][0]
        for field, raw in (("uniqueId", "raw-unique"), ("devId", "raw-dev"),
                           ("udid", "u" * 64), ("sn", "SN123456"), ("mac", "AA:BB:CC:DD:EE:FF")):
            self.assertEqual(device[field], redact.sha16(raw), field)
        self.assertTrue(device["deviceData"]["dropped"])
        self.assertEqual(device["deviceData"]["bytes"], len("opaque-blob"))
        # what the operator needs to read survives
        self.assertEqual(device["name"], "HUAWEI Band 8-002")
        self.assertEqual(device["deviceCode"], 1260900415)

    def test_health_data_is_not_redacted(self) -> None:
        out = self.redacted()
        self.assertEqual(out["realtime"], self.RAW["realtime"])
        self.assertEqual(out["sources"], self.RAW["sources"])
        self.assertEqual(out["daily"], self.RAW["daily"])
        self.assertEqual(out["health"], self.RAW["health"])
        self.assertEqual(out["token"]["session_host"], "https://healthcommon.dbankcloud.cn")

    def test_the_checker_bites(self) -> None:
        """Negative control: an unredacted payload must be rejected, not written."""
        with self.assertRaises(redact.RedactionError):
            redact.assert_redacted(self.RAW)
        with self.assertRaises(redact.RedactionError):
            redact.dumps(self.RAW)
        self.assertEqual(redact.find_violations(self.redacted()), [])

    def test_a_leaked_token_value_is_caught_even_under_an_innocent_key(self) -> None:
        sneaky = {"token": {"expires_at_text": "DgEBIwUaXbYcZd1e2f3g4h5i6j"}}
        self.assertTrue(redact.find_violations(sneaky))
        with self.assertRaises(redact.RedactionError):
            redact.assert_redacted(sneaky)

    def test_a_bare_uid_value_is_caught(self) -> None:
        sneaky = {"token": {"expires_at_text": "10086000026432748"}}
        self.assertTrue(redact.find_violations(sneaky))


class TestDocumentIsFrozen(SnapshotCase):
    def test_capture_block_contract(self) -> None:
        capture = self.doc.get("_capture")
        self.assertIsInstance(capture, dict)
        for field in ("capturedAt", "source", "redacted", "keys", "counts"):
            self.assertIn(field, capture, f"_capture lacks {field}")
        self.assertIs(capture["redacted"], True)
        self.assertIn("/api/data?days=7", capture["source"])
        self.assertEqual(set(capture["counts"]),
                         {"daily", "health", "sleep_rows", "sessions", "devices",
                          "sources", "errors"})
        self.assertEqual(capture["keys"], sorted(k for k in self.doc if k != "_capture"))

    def test_counts_match_the_arrays(self) -> None:
        counts = self.doc["_capture"]["counts"]
        for key in ("daily", "health", "sleep_rows", "sessions", "devices", "sources", "errors"):
            self.assertEqual(counts[key], len(self.doc[key]), key)

    def test_serialisation_is_reproducible(self) -> None:
        """Same payload -> byte-identical file: sorted keys, 2-space indent, UTF-8, newline."""
        self.assertEqual(redact.dumps(self.doc), self.text)

    def test_redaction_contract_has_no_violations(self) -> None:
        self.assertEqual(redact.find_violations(self.doc), [])

    def test_forbidden_keys_absent(self) -> None:
        for key in ("access_token", "refresh_token", "accessToken", "refreshToken",
                    "Authorization", "x-huid"):
            self.assertNotIn(key, self.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
