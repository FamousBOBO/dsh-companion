// Pulse sidecar boundary: whitelist rebuild, loopback refusal, and the "no invented reading" rule.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPulseAdapter, sanitizeState, containsAddress, DEFAULT_PULSE_BASE_URL,
} from '../lib/pulse-adapter.mjs';

const T0 = 1793731200000;

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

test('sanitize: a missing or impossible reading is null, never zero', () => {
  const base = { connected: true, contact: 'yes', sampleAt: T0 };
  assert.equal(sanitizeState({ ...base, bpm: 0 }, { nowMs: T0 }).bpm, null);
  assert.equal(sanitizeState({ ...base, bpm: 300 }, { nowMs: T0 }).bpm, null);
  assert.equal(sanitizeState({ ...base, bpm: null }, { nowMs: T0 }).bpm, null);
  assert.equal(sanitizeState({ ...base, bpm: '118' }, { nowMs: T0 }).bpm, 118);
  assert.equal(sanitizeState({ ...base, bpm: 118.4 }, { nowMs: T0 }).bpm, 118);
});

test('sanitize: age is recomputed locally and decides the quality', () => {
  const fresh = sanitizeState({ connected: true, contact: 'yes', bpm: 90, sampleAt: T0 }, { nowMs: T0 + 1000 });
  assert.equal(fresh.sampleAgeMs, 1000);
  assert.equal(fresh.quality, 'ok');

  const quiet = sanitizeState({ connected: true, contact: 'yes', bpm: 90, sampleAt: T0 }, { nowMs: T0 + 20_000 });
  assert.equal(quiet.quality, 'sparse');

  const noContact = sanitizeState({ connected: true, contact: 'no', bpm: 90, sampleAt: T0 }, { nowMs: T0 + 500 });
  assert.equal(noContact.quality, 'no-contact');
});

test('sanitize: unknown enumerations fall back instead of passing through', () => {
  const state = sanitizeState({
    connected: 'yes', contact: 'maybe', quality: 'perfect', lastErrorCode: 'weird', addressHash: 'nope',
  }, { nowMs: T0 });
  assert.equal(state.connected, false);
  assert.equal(state.contact, 'unsupported');
  assert.equal(state.lastErrorCode, null);
  assert.equal(state.addressHash, null);
});

test('sanitize: rr intervals are bounded and clamped to a plausible range', () => {
  const state = sanitizeState({ connected: true, contact: 'yes', rrMs: [10, 600, 600, 99999, 'x'] }, { nowMs: T0 });
  assert.deepEqual(state.rrMs, [600, 600]);
});

test('a reply carrying a Bluetooth address is rejected outright', () => {
  const leaky = { connected: true, bpm: 90, deviceLabel: 'STRAP', address: 'AA:BB:CC:DD:EE:FF' };
  assert.equal(containsAddress(sanitizeState(leaky, { nowMs: T0 })), false, 'the whitelist already removed it');
  assert.equal(containsAddress({ note: 'AA:BB:CC:DD:EE:FF' }), true);
  assert.equal(containsAddress({ note: 'aabbccddeeff' }), true);
  assert.equal(containsAddress({ note: '3f9a1c2d7b0e4411' }), false);
});

test('a non-loopback base URL is refused before any socket is opened', async () => {
  const fetchImpl = fakeFetch(() => { throw new Error('must not be called'); });
  const adapter = createPulseAdapter({ baseUrl: 'http://10.0.0.5:8151', fetchImpl });
  assert.equal(adapter.describe().loopback, false);
  const result = await adapter.state();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'non-loopback-refused');
  assert.equal(fetchImpl.calls.length, 0);
});

test('state: a good reply is rebuilt from the whitelist', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({
    ok: true,
    connected: true,
    deviceLabel: '  HUAWEI   WATCH ',
    bpm: 118,
    rrMs: [498, 502],
    contact: 'yes',
    sensorLocation: 'chest',
    sampleAt: T0,
    addressHash: '3F9A1C2D7B0E4411',
    secret_uid: 'should-not-survive',
  }));
  const adapter = createPulseAdapter({ baseUrl: DEFAULT_PULSE_BASE_URL, fetchImpl, now: () => T0 });
  const result = await adapter.state();
  assert.equal(result.ok, true);
  assert.equal(result.bpm, 118);
  assert.equal(result.deviceLabel, 'HUAWEI WATCH');
  assert.equal(result.addressHash, '3f9a1c2d7b0e4411');
  assert.equal(result.secret_uid, undefined, 'unknown fields are dropped, not forwarded');
  assert.match(fetchImpl.calls[0].url, /127\.0\.0\.1:8151\/api\/state$/);
});

test('state: transport failures become codes, never exceptions', async () => {
  const cases = [
    ['unreachable', () => { const error = new Error('boom'); error.name = 'TypeError'; throw error; }],
    ['timeout', () => { const error = new Error('slow'); error.name = 'TimeoutError'; throw error; }],
    ['http-error', () => jsonResponse({}, { status: 500 })],
    ['bad-json', () => jsonResponse('not json')],
  ];
  for (const [code, handler] of cases) {
    const adapter = createPulseAdapter({ baseUrl: DEFAULT_PULSE_BASE_URL, fetchImpl: fakeFetch(handler) });
    const result = await adapter.state();
    assert.equal(result.ok, false, `${code} should not be ok`);
    assert.equal(result.code, code);
  }
});

test('devices: addresses are replaced by a stable hash', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({
    ok: true,
    scannedAt: T0,
    devices: [
      { label: 'HUAWEI WATCH', address: 'AA:BB:CC:DD:EE:FF', rssi: -58, hasHrs: true },
      { label: null, addressHash: '3f9a1c2d7b0e4411', rssi: -70 },
      { nonsense: true },
    ],
  }));
  const adapter = createPulseAdapter({ baseUrl: DEFAULT_PULSE_BASE_URL, fetchImpl });
  const result = await adapter.devices();
  assert.equal(result.ok, true);
  assert.equal(result.devices.length, 2);
  assert.match(result.devices[0].addressHash, /^[0-9a-f]{16}$/);
  assert.equal(result.devices[0].rssi, -58);
  assert.equal(result.devices[1].addressHash, '3f9a1c2d7b0e4411');
});

test('connect posts a body and reports the device verdict', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ ok: true, connected: false, code: 'connect-failed' }));
  const adapter = createPulseAdapter({ baseUrl: DEFAULT_PULSE_BASE_URL, fetchImpl });
  const result = await adapter.connect({ nameHint: ' WATCH ' });
  assert.equal(result.ok, true);
  assert.equal(result.connected, false);
  assert.equal(result.code, 'connect-failed');
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(body, { nameHint: 'WATCH' });
});
