// Care-candidate rules (INTERFACES.md §10 / §15).
//
// The contract this file enforces is mostly a *negative* one: evaluating rules may
// not send a message, call a model, or write anything. So the tests check the
// absence of side effects as carefully as the matches themselves, and every fixture
// here is synthetic.
//
// Thresholds used below are product parameters, not health advice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openHealthDb } from '../lib/db.mjs';
import {
  DEFAULT_POLICY,
  PATTERNS,
  POLICY_VERSION,
  evaluateCareRules,
  explainCareState,
} from '../lib/rules.mjs';

const NOW = Date.parse('2026-11-03T21:05:00+08:00');

function putSummary(db, localDate, metricKind, summary) {
  db.run(
    `INSERT INTO health_daily_summaries
       (owner_scope, local_date, timezone_id, metric_kind, summary_json, origin_hash, updated_at)
     VALUES ('owner-only', ?, 'Asia/Shanghai', ?, ?, ?, ?)
     ON CONFLICT(owner_scope, local_date, timezone_id, metric_kind) DO UPDATE SET
       summary_json = excluded.summary_json, origin_hash = excluded.origin_hash`,
    [localDate, metricKind, JSON.stringify(summary), `hash-${localDate}-${metricKind}`, NOW],
  );
}

function makeDb() {
  return openHealthDb({ file: ':memory:' });
}

test('the pattern list and policy are stable and carry no advice', () => {
  assert.deepEqual([...PATTERNS], [
    'sleep_debt',
    'resting_heart_rate_rise',
    'activity_drop',
    'stress_persistent',
  ]);
  assert.equal(POLICY_VERSION, 'care-rules-v1');
  assert.equal(typeof DEFAULT_POLICY.sleepShortMinutes, 'number');
  // A policy field must never read like a diagnosis.
  assert.doesNotMatch(JSON.stringify(DEFAULT_POLICY), /建议|推荐|诊断|治疗/);
});

test('an empty store yields no candidates at all', () => {
  const db = makeDb();
  try {
    assert.deepEqual(evaluateCareRules({ db, nowMs: NOW }), []);
    // ...and an unusable handle does not throw either.
    assert.deepEqual(evaluateCareRules({ db: null, nowMs: NOW }), []);
    assert.deepEqual(evaluateCareRules({ nowMs: NOW }), []);
  } finally {
    db.close();
  }
});

test('evaluating rules never writes a row', () => {
  const db = makeDb();
  try {
    for (const offset of [0, 1, 2, 3]) {
      const date = new Date(NOW - offset * 86400000).toISOString().slice(0, 10);
      putSummary(db, date, 'sleep_day', { asleepMinutes: 200 });
    }
    const before = JSON.stringify(db.stats());
    const candidates = evaluateCareRules({ db, nowMs: NOW });
    assert.ok(candidates.length > 0, 'the fixture should trip the sleep-debt pattern');
    assert.equal(JSON.stringify(db.stats()), before, 'no candidate row, no outbox row, no write');
    assert.equal(db.all('SELECT * FROM health_care_candidates').length, 0);
  } finally {
    db.close();
  }
});

test('sleep debt fires on consecutive short nights, with an evidence hash', () => {
  const db = makeDb();
  try {
    for (const date of ['2026-11-01', '2026-11-02', '2026-11-03']) {
      putSummary(db, date, 'sleep_day', { asleepMinutes: 240 });
    }
    const candidates = evaluateCareRules({ db, nowMs: NOW });
    const debt = candidates.find(entry => entry.pattern === 'sleep_debt');
    assert.ok(debt);
    assert.equal(debt.status, 'observe');
    assert.equal(debt.policyVersion, POLICY_VERSION);
    assert.equal(debt.ownerScope, 'owner-only');
    assert.ok(debt.evidenceHash.length > 0);
    assert.ok(debt.expiresAt > debt.createdAt);
    assert.match(debt.reason, /产品参数/);
    assert.match(debt.reason, /不是医学结论/);
  } finally {
    db.close();
  }
});

test('one long night is enough to keep the sleep-debt pattern quiet', () => {
  const db = makeDb();
  try {
    putSummary(db, '2026-11-01', 'sleep_day', { asleepMinutes: 240 });
    putSummary(db, '2026-11-02', 'sleep_day', { asleepMinutes: 240 });
    putSummary(db, '2026-11-03', 'sleep_day', { asleepMinutes: 480 });
    const patterns = evaluateCareRules({ db, nowMs: NOW }).map(entry => entry.pattern);
    assert.equal(patterns.includes('sleep_debt'), false);
  } finally {
    db.close();
  }
});

test('a rising resting heart rate is compared against the recent mean', () => {
  const db = makeDb();
  try {
    putSummary(db, '2026-11-03', 'health_day', { heartRate: { resting: 90 } });
    putSummary(db, '2026-11-02', 'health_day', { heartRate: { resting: 70 } });
    putSummary(db, '2026-11-01', 'health_day', { heartRate: { resting: 71 } });
    putSummary(db, '2026-10-31', 'health_day', { heartRate: { resting: 70 } });
    const hit = evaluateCareRules({ db, nowMs: NOW }).find(entry => entry.pattern === 'resting_heart_rate_rise');
    assert.ok(hit);
    assert.match(hit.reason, /不是医学结论/);

    // A flat series stays quiet.
    const db2 = makeDb();
    try {
      putSummary(db2, '2026-11-03', 'health_day', { heartRate: { resting: 71 } });
      putSummary(db2, '2026-11-02', 'health_day', { heartRate: { resting: 70 } });
      putSummary(db2, '2026-11-01', 'health_day', { heartRate: { resting: 71 } });
      assert.equal(
        evaluateCareRules({ db: db2, nowMs: NOW }).some(entry => entry.pattern === 'resting_heart_rate_rise'),
        false,
      );
    } finally {
      db2.close();
    }
  } finally {
    db.close();
  }
});

test('an activity collapse and persistent stress each fire once, and only when asked for', () => {
  const db = makeDb();
  try {
    putSummary(db, '2026-11-03', 'activity', { steps: 20 });
    putSummary(db, '2026-11-02', 'activity', { steps: 900 });
    putSummary(db, '2026-11-01', 'activity', { steps: 950 });
    for (const date of ['2026-11-01', '2026-11-02', '2026-11-03']) {
      putSummary(db, date, 'health_day', { stress: { avg: 88 } });
    }
    const patterns = evaluateCareRules({ db, nowMs: NOW }).map(entry => entry.pattern);
    assert.ok(patterns.includes('activity_drop'));
    assert.ok(patterns.includes('stress_persistent'));
    // No duplicates of the same pattern in one pass.
    assert.equal(new Set(patterns).size, patterns.length);

    // A stricter threshold silences it.
    const quiet = evaluateCareRules({ db, nowMs: NOW, policy: { stressHighScore: 99 } });
    assert.equal(quiet.some(entry => entry.pattern === 'stress_persistent'), false);
  } finally {
    db.close();
  }
});

test('every candidate is observe only — nothing is ever marked suppressed or sent', () => {
  const db = makeDb();
  try {
    for (const date of ['2026-11-01', '2026-11-02', '2026-11-03']) {
      putSummary(db, date, 'sleep_day', { asleepMinutes: 200 });
    }
    for (const candidate of evaluateCareRules({ db, nowMs: NOW })) {
      assert.equal(candidate.status, 'observe');
      assert.equal(candidate.outboxId ?? null, null);
      assert.equal(candidate.platformMessageId ?? null, null);
      assert.ok(PATTERNS.includes(candidate.pattern));
    }
  } finally {
    db.close();
  }
});

test('explainCareState says, in words, that care is off this round', () => {
  const db = makeDb();
  try {
    const state = explainCareState({ db, nowMs: NOW });
    assert.equal(state.evaluated, false);
    assert.match(state.reason, /本轮不启用/);
    assert.equal(state.sleepAvailability, 'awaiting_first_night');
    assert.equal(state.hasActivityToday, false);
  } finally {
    db.close();
  }
});
