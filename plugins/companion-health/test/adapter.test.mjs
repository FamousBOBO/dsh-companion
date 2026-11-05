// The sidecar boundary (INTERFACES.md §5).
//
// Every test here injects `fetchImpl`, so no socket is opened and the live
// sidecar is never disturbed. What is under test is the *safety* of the boundary:
// loopback-only, redacted before it leaves, and self-checked afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertNoSecrets,
  createCnAdapter,
  isLoopbackHost,
  redactWindowPayload,
} from '../lib/cn-adapter.mjs';

const NOW = Date.parse('2026-11-03T21:05:00+08:00');

/** A payload shaped like the real sidecar's, including the fields we must remove. */
function rawPayload(overrides = {}) {
  return {
    synced_at: NOW / 1000,
    newest_cloud: NOW / 1000,
    errors: [],
    daily: [{ date: '2026-11-03', steps: 1112 }],
    health: [],
    sessions: [],
    sleep_rows: [],
    sources: [{ name: '心率', ms: NOW / 1000, text: '2026-11-03 20:26:06', rel: '39 分钟前', rt_text: '95 bpm @ 20:19' }],
    devices: [{
      deviceCode: 1260900415,
      name: 'HUAWEI Band 8-002',
      uniqueId: 'JBTTQ23424001783#ANDROID21',
      devId: '618b708f-5783-4fdb-b820-1cfd9363c15d',
      mac: '50:F9:58:49:60:02',
      sn: 'JBTTQ23424001783',
      udid: '75E7C83DA0A74030996D740F6BFB224EC812FDB046D3E42078B9801B0A5903CA',
      deviceData: '{"mMap":{"model":"HUAWEI Band 8"}}',
      firmwareVersion: '4.2.0.103',
      modifyTime: 1793525169000,
    }],
    realtime: { 心率: { value: 95, unit: 'bpm', at: NOW / 1000 - 600, device: 1260900415 } },
    token: {
      uid: '100860123456',
      data_host: 'https://healthdata.dbankcloud.cn',
      session_host: 'https://healthcommon.dbankcloud.cn',
      expires_at_text: '2026-11-03 21:54:38',
      expires_in_min: 58,
      refresh_dies_text: '2027-05-02 19:04:43',
      rotated: false,
    },
    ...overrides,
  };
}

function jsonFetch(payload, { status = 200, delayMs = 0, failWith = null } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (failWith) throw failWith;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    };
  };
  impl.calls = calls;
  return impl;
}

test('isLoopbackHost accepts loopback spellings and nothing else', () => {
  for (const host of ['127.0.0.1', '127.5.5.5', 'localhost', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['192.168.1.5', 'example.com', 'healthdata.dbankcloud.cn', '10.0.0.1', '']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('describe reports the loopback base url and timeout', () => {
  const adapter = createCnAdapter({ fetchImpl: jsonFetch(rawPayload()), now: () => NOW });
  assert.deepEqual(adapter.describe(), {
    baseUrl: 'http://127.0.0.1:8765',
    loopback: true,
    timeoutMs: 20000,
  });
  assert.equal(createCnAdapter({ timeoutMs: 500 }).describe().timeoutMs, 500);
});

test('a non-loopback baseUrl is refused before any request is made', async () => {
  for (const baseUrl of ['http://example.com:8765', 'https://healthdata.dbankcloud.cn', 'http://192.168.1.9:8765']) {
    const fetchImpl = jsonFetch(rawPayload());
    const adapter = createCnAdapter({ baseUrl, fetchImpl, now: () => NOW });
    const result = await adapter.fetchWindow({ days: 7 });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'non-loopback-refused');
    assert.equal(result.httpStatus, 0);
    assert.equal(fetchImpl.calls.length, 0, `${baseUrl} must not be contacted`);
  }
});

test('127.x and localhost are allowed and the query string carries days/force', async () => {
  const fetchImpl = jsonFetch(rawPayload());
  const adapter = createCnAdapter({ baseUrl: 'http://127.0.0.1:8765/', fetchImpl, now: () => NOW });
  const result = await adapter.fetchWindow({ days: 3, force: true });
  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.length, 1);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.pathname, '/api/data');
  assert.equal(url.searchParams.get('days'), '3');
  assert.equal(url.searchParams.get('force'), '1');
  assert.ok(fetchImpl.calls[0].options.signal, 'a timeout signal is attached');
});

test('the returned payload carries no uid, token, MAC, serial or udid', async () => {
  const adapter = createCnAdapter({ fetchImpl: jsonFetch(rawPayload()), now: () => NOW });
  const result = await adapter.fetchWindow({ days: 7 });
  assert.equal(result.ok, true);

  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /100860123456/, 'raw uid');
  assert.doesNotMatch(text, /"uid"/);
  assert.doesNotMatch(text, /access_?token|refresh_?token/i);
  assert.doesNotMatch(text, /50:F9:58:49:60:02/, 'device MAC');
  assert.doesNotMatch(text, /JBTTQ23424001783/, 'device serial');
  assert.doesNotMatch(text, /75E7C83DA0A7403/, 'device udid');

  // What survives is the non-identifying part.
  assert.equal(result.payload.devices[0].name, 'HUAWEI Band 8-002');
  assert.equal(result.payload.devices[0].model, 'HUAWEI Band 8');
  assert.match(result.payload.devices[0].uniqueId, /^[0-9a-f]{16}$/);
  assert.match(result.payload.devices[0].devId, /^[0-9a-f]{16}$/);
});

test('the redacted token view exposes only status/minutes/rotation/host/expiry text', async () => {
  const adapter = createCnAdapter({ fetchImpl: jsonFetch(rawPayload()), now: () => NOW });
  const { redactedToken, payload } = await adapter.fetchWindow({ days: 7 });
  assert.deepEqual(redactedToken, {
    status: 'valid',
    minutesLeft: 58,
    rotated: false,
    hostKind: 'cn',
    expiresAtText: '2026-11-03 21:54:38',
    refreshExpiresAtText: '2027-05-02 19:04:43',
  });
  assert.equal(payload.token.redacted, true);
  // The status page reads the display text from the payload token block.
  assert.equal(payload.token.expires_at_text, '2026-11-03 21:54:38');
  assert.equal(payload.token.refresh_dies_text, '2027-05-02 19:04:43');
  assert.equal(JSON.stringify(redactedToken).includes('uid'), false);
});

test('token status follows minutesLeft', async () => {
  const cases = [[120, 'valid'], [20, 'expiring'], [0, 'expired'], [-5, 'expired'], [null, 'unknown']];
  for (const [minutes, expected] of cases) {
    const adapter = createCnAdapter({
      fetchImpl: jsonFetch(rawPayload({ token: { expires_in_min: minutes, rotated: true } })),
      now: () => NOW,
    });
    const { redactedToken } = await adapter.fetchWindow({ days: 7 });
    assert.equal(redactedToken.status, expected, `minutesLeft=${minutes}`);
  }
});

test('hostKind distinguishes the CN contour from anything else', async () => {
  const cn = createCnAdapter({
    fetchImpl: jsonFetch(rawPayload({ token: { data_host: 'https://healthdata.dbankcloud.cn' } })),
    now: () => NOW,
  });
  assert.equal((await cn.fetchWindow({})).redactedToken.hostKind, 'cn');

  const other = createCnAdapter({
    fetchImpl: jsonFetch(rawPayload({ token: { data_host: 'https://healthdata.dbankcloud.eu' } })),
    now: () => NOW,
  });
  assert.equal((await other.fetchWindow({})).redactedToken.hostKind, 'other');

  const unknown = createCnAdapter({
    fetchImpl: jsonFetch(rawPayload({ token: {} })),
    now: () => NOW,
  });
  assert.equal((await unknown.fetchWindow({})).redactedToken.hostKind, 'unknown');
});

test('an aborted request reads as a timeout', async () => {
  const impl = async (url, options) => new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal) {
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
      });
    }
  });
  const adapter = createCnAdapter({ fetchImpl: impl, timeoutMs: 20, now: () => NOW });
  const result = await adapter.fetchWindow({ days: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'timeout');
  assert.equal(result.httpStatus, 0);
  assert.equal(typeof result.latencyMs, 'number');
});

test('a rejected fetch reads as unreachable, an HTTP error keeps its status', async () => {
  const unreachable = createCnAdapter({
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8765'); },
    now: () => NOW,
  });
  const failed = await unreachable.fetchWindow({});
  assert.equal(failed.errorCode, 'unreachable');

  for (const status of [500, 404, 429]) {
    const adapter = createCnAdapter({ fetchImpl: jsonFetch(rawPayload(), { status }), now: () => NOW });
    const result = await adapter.fetchWindow({});
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'http-error');
    assert.equal(result.httpStatus, status);
  }
});

test('a non-JSON body reads as bad-json', async () => {
  const adapter = createCnAdapter({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' }),
    now: () => NOW,
  });
  const result = await adapter.fetchWindow({});
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'bad-json');

  const empty = createCnAdapter({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'null' }),
    now: () => NOW,
  });
  assert.equal((await empty.fetchWindow({})).errorCode, 'bad-json');
});

test('sidecar errors[] are passed through verbatim', async () => {
  const errors = [{ code: 30005, message: 'Invalid device' }];
  const adapter = createCnAdapter({ fetchImpl: jsonFetch(rawPayload({ errors })), now: () => NOW });
  const result = await adapter.fetchWindow({});
  assert.deepEqual(result.errors, errors);
  assert.equal(result.days, 7);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.fetchedAt, NOW);
});

test('no fetch implementation at all is a clean failure, not a crash', async () => {
  const adapter = createCnAdapter({ fetchImpl: null, now: () => NOW });
  const result = await adapter.fetchWindow({});
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'unreachable');
});

test('assertNoSecrets is the regression guard, and it actually fires', () => {
  assert.equal(assertNoSecrets({ ok: true, value: 95 }), true);
  assert.throws(() => assertNoSecrets({ access_token: 'abc' }), /token/);
  assert.throws(() => assertNoSecrets({ refreshToken: 'abc' }), /token/);
  assert.throws(() => assertNoSecrets({ token: { uid: '100860123456' } }), /uid/);
  assert.throws(() => assertNoSecrets({ device: { mac: '50:F9:58:49:60:02' } }), /MAC/);
  // Wrapped payload-like objects are scanned too.
  assert.throws(() => assertNoSecrets({ payload: { token: { uid: '123456789' } } }), /uid/);
});

test('redactWindowPayload is idempotent and safe on empty input', () => {
  const once = redactWindowPayload(rawPayload());
  const twice = redactWindowPayload(once);
  assert.deepEqual(twice, once);
  assert.doesNotMatch(JSON.stringify(twice), /"uid"/);

  const empty = redactWindowPayload(null);
  assert.deepEqual(empty.devices, []);
  assert.equal(empty.token.redacted, true);
  assert.equal(assertNoSecrets(empty), true);
});

test('the raw payload object handed in is not mutated', () => {
  const payload = rawPayload();
  const before = JSON.stringify(payload);
  redactWindowPayload(payload);
  assert.equal(JSON.stringify(payload), before, 'redaction must build a new object');
  assert.equal(payload.token.uid, '100860123456', 'the caller still owns its own object');
});
