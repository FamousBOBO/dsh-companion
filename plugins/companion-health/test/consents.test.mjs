// Capability consents (INTERFACES.md §10).
//
// These tests double as the proof that this round cannot silently enable the
// four gated capabilities: they are off in the defaults, and the only writer is
// `setConsent` — no other module in the plugin calls it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openHealthDb } from '../lib/db.mjs';
import {
  CAPABILITIES,
  CONSENT_VERSION,
  DEFAULT_ON,
  GATED_OFF,
  describeConsents,
  isAllowed,
  isGated,
  loadConsents,
  setConsent,
} from '../lib/consents.mjs';

function makeDb() {
  return openHealthDb({ file: ':memory:' });
}

test('CAPABILITIES and DEFAULT_ON match the contract exactly', () => {
  assert.deepEqual([...CAPABILITIES], [
    'health.connect',
    'health.read.on_demand',
    'health.dashboard',
    'health.sleep.read',
    // v2 (design/pulse-bond-20261103.md): live BLE heart rate, on by default like on-demand reads —
    // it is still fenced by an explicit per-scene session and a hand-started sidecar.
    'health.pulse.live',
    'health.context.auto',
    'health.memory.habits',
    'health.schedule.adjust',
    'health.care.proactive',
    'health.export',
    'health.delete',
  ]);
  assert.deepEqual([...DEFAULT_ON], [
    'health.connect',
    'health.read.on_demand',
    'health.dashboard',
    'health.sleep.read',
    'health.pulse.live',
  ]);
});

test('the four proactive/gated capabilities are off unless something writes a row', () => {
  const db = makeDb();
  try {
    const consents = loadConsents(db);
    for (const capability of CAPABILITIES) {
      const expected = DEFAULT_ON.includes(capability);
      assert.equal(consents[capability], expected, capability);
    }
    for (const capability of ['health.context.auto', 'health.memory.habits',
      'health.schedule.adjust', 'health.care.proactive', 'health.export', 'health.delete']) {
      assert.equal(consents[capability], false, capability);
      assert.equal(isAllowed(db, capability), false, capability);
    }
    assert.deepEqual([...GATED_OFF].sort(), ['health.care.proactive', 'health.context.auto',
      'health.delete', 'health.export', 'health.memory.habits', 'health.schedule.adjust'].sort());
  } finally {
    db.close();
  }
});

test('loadConsents on an unusable handle returns the defaults instead of throwing', () => {
  const defaults = loadConsents(null);
  assert.equal(defaults['health.read.on_demand'], true);
  assert.equal(defaults['health.care.proactive'], false);
  assert.equal(isAllowed(null, 'health.read.on_demand'), true);
  assert.equal(isAllowed(undefined, 'health.care.proactive'), false);
});

test('setConsent writes, persists and is readable back', () => {
  const db = makeDb();
  try {
    const result = setConsent(db, 'health.dashboard', false);
    assert.deepEqual(
      { capability: result.capability, enabled: result.enabled, version: result.consentVersion },
      { capability: 'health.dashboard', enabled: false, version: CONSENT_VERSION },
    );
    assert.equal(loadConsents(db)['health.dashboard'], false);
    assert.equal(isAllowed(db, 'health.dashboard'), false);

    setConsent(db, 'health.dashboard', true);
    assert.equal(loadConsents(db)['health.dashboard'], true);

    // Only one row per capability; the second write updates in place.
    const rows = db.all('SELECT * FROM health_consents');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].capability, 'health.dashboard');
    assert.equal(rows[0].consent_version, CONSENT_VERSION);

    // A gated capability can be written by this API alone — and nothing else in the
    // plugin calls it. The row is the whole story.
    setConsent(db, 'health.care.proactive', true);
    assert.equal(isAllowed(db, 'health.care.proactive'), true);
    setConsent(db, 'health.care.proactive', false);
    assert.equal(loadConsents(db)['health.care.proactive'], false);
  } finally {
    db.close();
  }
});

test('setConsent refuses an unknown capability with a bad-capability code', () => {
  const db = makeDb();
  try {
    for (const capability of ['health.teleport', '', null, undefined, 'HEALTH.CONNECT']) {
      assert.throws(
        () => setConsent(db, capability, true),
        (error) => error.code === 'bad-capability',
        `expected bad-capability for ${String(capability)}`,
      );
    }
    assert.equal(db.all('SELECT * FROM health_consents').length, 0, 'a typo must not create a permission');
  } finally {
    db.close();
  }
});

test('isAllowed answers false for anything outside the list', () => {
  const db = makeDb();
  try {
    assert.equal(isAllowed(db, 'root'), false);
    assert.equal(isAllowed(db, ''), false);
    assert.equal(isAllowed(db, null), false);
  } finally {
    db.close();
  }
});

test('an unknown row in the table is ignored rather than honoured', () => {
  const db = makeDb();
  try {
    db.run(
      'INSERT INTO health_consents (capability, enabled, consent_version, updated_at) VALUES (?, 1, 1, 0)',
      ['health.teleport'],
    );
    const consents = loadConsents(db);
    assert.equal(Object.hasOwn(consents, 'health.teleport'), false);
    assert.equal(Object.keys(consents).length, CAPABILITIES.length);
  } finally {
    db.close();
  }
});

test('isGated labels exactly the capabilities this round cannot enable', () => {
  assert.equal(isGated('health.care.proactive'), true);
  assert.equal(isGated('health.export'), true);
  assert.equal(isGated('health.connect'), false);
  assert.equal(isGated('nope'), false);
});

test('describeConsents explains each row without claiming more than it does', () => {
  const db = makeDb();
  try {
    const described = describeConsents(db);
    assert.equal(described.length, CAPABILITIES.length);
    const care = described.find(entry => entry.capability === 'health.care.proactive');
    assert.equal(care.enabled, false);
    assert.equal(care.gated, true);
    assert.match(care.note, /不可启用/);

    const read = described.find(entry => entry.capability === 'health.read.on_demand');
    assert.equal(read.enabled, true);
    assert.equal(read.gated, false);
    assert.match(read.note, /只读/);
  } finally {
    db.close();
  }
});
