#!/usr/bin/env python3
"""Offline unit tests for :mod:`redact` — the rule that decides what a stored snapshot may hold.

    python sidecars/huawei-health-cn/test_redact.py -v

Why a separate file: ``test_protocol_contract.py`` asserts the *shape of a real payload*, and its
snapshot-dependent cases skip when no snapshot is present (snapshots are personal data and never
ship). The redaction rules themselves must stay under test **without** a snapshot, a network or a
credential file — they are the only thing standing between the account's identifiers and a file on
disk. Standard library ``unittest`` only, so a bare interpreter can run it.

Exit codes: 0 all good, 1 an assertion failed (unittest's own behaviour).
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import redact  # noqa: E402  - same directory as this file


def payload(**overrides):
    """A minimal answer that looks like the sidecar's, with the sensitive bits filled in."""
    base = {
        "synced_at": 1793731200,
        "scope": {"days": 7},
        "daily": [{"date": "2026-11-03", "sport_type": 0, "steps": 1112}],
        "health": [{"date": "2026-11-03", "heart_rate": 95, "stress_average": 65}],
        "sleep_rows": [],
        "sessions": [{"sport_type": 2, "duration_min": 2}],
        "realtime": {"心率": {"value": 95, "unit": "bpm", "at": 1793731140}},
        "token": {
            "uid": "12345678901234567",
            "accessToken": "DgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "refreshToken": "DgEBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            "session_host": "health-cloud.example.invalid",
            "data_host": "health-cloud.example.invalid",
            "expires_at_text": "2026-11-03 21:54",
            "expires_in_min": 37,
            "refresh_dies_text": "2027-05-02 11:04",
            "rotated": False,
            "siteId": 42,
            "x-huid": "12345678901234567",
        },
        "devices": [{
            "deviceCode": 7,
            "name": "BAND",
            "uniqueId": "unique-raw-identifier",
            "devId": "dev-raw-identifier",
            "udid": "a" * 64,
            "sn": "SN-1234567890",
            "mac": "AA:BB:CC:DD:EE:FF",
            "deviceData": "opaque-blob-used-by-the-cloud",
        }],
        "sources": [{"id": "huawei-cn", "rt_text": "20:19"}],
        "errors": [],
    }
    base.update(overrides)
    return base


class TokenTests(unittest.TestCase):
    def test_token_whitelist_keeps_only_the_allowed_keys(self):
        out = redact.redact_payload(payload())["token"]
        self.assertEqual(set(out), {
            "uid_sha256_16", "session_host", "data_host", "expires_at_text",
            "expires_in_min", "refresh_dies_text", "rotated",
        })
        self.assertNotIn("uid", out)
        self.assertNotIn("accessToken", out)
        self.assertNotIn("siteId", out)

    def test_uid_becomes_a_stable_pseudonym(self):
        first = redact.redact_payload(payload())["token"]["uid_sha256_16"]
        second = redact.redact_payload(payload())["token"]["uid_sha256_16"]
        self.assertEqual(first, second, "same uid must always give the same pseudonym")
        self.assertRegex(first, r"^[0-9a-f]{16}$")
        self.assertNotEqual(first, redact.redact_payload(payload(token={"uid": "1"}))["token"]["uid_sha256_16"])

    def test_an_absent_or_empty_uid_does_not_invent_one(self):
        for token in ({}, {"uid": ""}, {"uid": None}):
            self.assertNotIn("uid_sha256_16", redact.redact_payload(payload(token=token))["token"])


class DeviceTests(unittest.TestCase):
    def test_every_identifier_becomes_sha16_and_the_blob_is_shrunk(self):
        device = redact.redact_payload(payload())["devices"][0]
        for field in redact.DEVICE_HASH_FIELDS:
            self.assertRegex(device[field], r"^[0-9a-f]{16}$", field)
        self.assertEqual(device["deviceData"]["dropped"], True)
        self.assertEqual(device["deviceData"]["bytes"], len("opaque-blob-used-by-the-cloud"))
        # untouched fields stay verbatim — this is not a blanket rewrite
        self.assertEqual(device["deviceCode"], 7)
        self.assertEqual(device["name"], "BAND")

    def test_hash_fields_are_case_and_shape_stable(self):
        first = redact.redact_payload(payload())["devices"][0]["mac"]
        second = redact.redact_payload(payload())["devices"][0]["mac"]
        self.assertEqual(first, second)


class HealthDataTests(unittest.TestCase):
    def test_health_numbers_are_never_rewritten(self):
        out = redact.redact_payload(payload())
        self.assertEqual(out["daily"][0]["steps"], 1112)
        self.assertEqual(out["health"][0]["heart_rate"], 95)
        self.assertEqual(out["realtime"]["心率"]["value"], 95)
        self.assertEqual(out["sessions"][0]["sport_type"], 2)

    def test_nested_credential_keys_are_dropped_wherever_they_appear(self):
        nested = payload(extra={"deep": [{"access_token": "x", "keep": 1}]})
        out = redact.redact_payload(nested)["extra"]["deep"][0]
        self.assertNotIn("access_token", out)
        self.assertEqual(out["keep"], 1)


class ViolationTests(unittest.TestCase):
    def test_clean_payload_passes(self):
        self.assertEqual(redact.find_violations(redact.redact_payload(payload())), [])

    def test_a_raw_uid_key_is_a_violation(self):
        bad = redact.redact_payload(payload())
        bad["token"]["uid"] = "12345678901234567"
        self.assertTrue(any("uid" in item for item in redact.find_violations(bad)))

    def test_a_raw_device_identifier_is_a_violation(self):
        bad = redact.redact_payload(payload())
        bad["devices"][0]["mac"] = "AA:BB:CC:DD:EE:FF"
        self.assertTrue(any("mac" in item for item in redact.find_violations(bad)))

    def test_a_token_looking_value_is_a_violation(self):
        bad = redact.redact_payload(payload())
        bad["note"] = "DgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        self.assertTrue(any("credential" in item for item in redact.find_violations(bad)))

    def test_assert_redacted_raises_with_the_reasons(self):
        bad = redact.redact_payload(payload())
        bad["devices"][0]["udid"] = "a" * 64
        with self.assertRaises(redact.RedactionError) as caught:
            redact.assert_redacted(bad)
        self.assertTrue(caught.exception.violations)

    def test_dumps_refuses_to_write_a_violating_document(self):
        bad = redact.redact_payload(payload())
        bad["devices"][0]["sn"] = "SN-1234567890"
        with self.assertRaises(redact.RedactionError):
            redact.dumps(bad)


class SerialisationTests(unittest.TestCase):
    def test_dumps_is_sorted_two_space_utf8_with_trailing_newline(self):
        text = redact.dumps(redact.redact_payload(payload()))
        self.assertTrue(text.endswith("\n"))
        self.assertIn('\n  "daily"', text)
        again = redact.dumps(json.loads(text))
        self.assertEqual(text, again, "the same payload must serialise byte-identically")

    def test_the_privacy_grep_pattern_finds_nothing_in_a_redacted_document(self):
        import re
        text = redact.dumps(redact.redact_payload(payload()))
        self.assertIsNone(re.search(redact.PRIVACY_GREP_PATTERN, text))
        self.assertNotIn("DgE", text)
        self.assertNotIn("AA:BB:CC:DD:EE:FF", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
