import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig, parseBaseUrl, DEFAULTS } from '../config.mjs';

test('a bare config resolves to inert defaults', () => {
  const { config, problems } = resolveConfig(undefined, {});
  assert.equal(config.enabled, false);
  assert.equal(config.baseUrl, '');
  assert.equal(config.uid, 0);
  assert.equal(config.deviceName, 'dsh-companion');
  assert.equal(config.sse.reconnectBaseMs, 1000);
  assert.equal(config.sse.reconnectMaxMs, 30000);
  assert.equal(config.sse.idleTimeoutMs, 120000);
  assert.equal(config.outbound.maxChars, 4000);
  // Disabled means nothing is missing: there is nothing to be missing.
  assert.deepEqual(problems, []);
});

test('the webhook section is gone in V2 — a leftover key cannot resurrect it', () => {
  const { config } = resolveConfig({
    enabled: false,
    // A stale profile might still carry V1 fields; they must simply be ignored.
    webhook: { bind: '127.0.0.1', port: 3011, pathTokenEnv: 'X' },
    apiKeyEnv: 'SOMETHING',
    botUid: 2,
  }, {});
  assert.equal('webhook' in config, false, 'no webhook section should exist');
  assert.equal('apiKeyEnv' in config, false, 'no Bot key field should exist');
  assert.equal('botUid' in config, false, 'no Bot uid field should exist');
});

test('enabled with nothing configured reports every missing piece', () => {
  const { config, problems } = resolveConfig({ enabled: true }, {});
  assert.equal(config.enabled, true);
  assert.ok(problems.some(p => p.includes('baseUrl')));
  assert.ok(problems.some(p => p.includes('uid')));
  assert.ok(problems.some(p => p.includes('refresh_token')), problems.join(' | '));
});

test('a complete config resolves cleanly', () => {
  const { config, problems } = resolveConfig({
    enabled: true,
    baseUrl: 'http://127.0.0.1:3009',
    uid: 4,
    deviceName: 'dsh-companion',
    credentialFile: 'D:/DSH/vocechat/secrets/user-companion.json',
  }, {});
  assert.equal(config.base.origin, 'http://127.0.0.1:3009');
  assert.equal(config.uid, 4);
  assert.equal(config.base.port, 3009);
  assert.deepEqual(problems, []);
});

test('a dbFile alone is an accepted credential source', () => {
  const { problems } = resolveConfig({
    enabled: true, baseUrl: 'http://127.0.0.1:3009', uid: 4,
    dbFile: 'D:/DSH/vocechat/vocechat-data/db/db.sqlite',
  }, {});
  assert.deepEqual(problems, []);
});

test('an inverted backoff window is reported', () => {
  const { problems } = resolveConfig({
    enabled: true, baseUrl: 'http://x', uid: 4, dbFile: 'x',
    sse: { reconnectBaseMs: 30000, reconnectMaxMs: 1000 },
  }, {});
  assert.ok(problems.some(p => p.includes('退避区间')));
});

test('bad numeric values fall back instead of producing NaN', () => {
  const { config } = resolveConfig({
    enabled: true,
    uid: 'abc',
    sse: { reconnectBaseMs: -1, reconnectMaxMs: 0, idleTimeoutMs: 'x' },
    outbound: { timeoutMs: 'x', maxChars: 0 },
    queue: { maxPending: -5 },
  }, {});
  assert.equal(config.uid, 0);
  assert.equal(config.sse.reconnectBaseMs, DEFAULTS.sse.reconnectBaseMs);
  assert.equal(config.sse.reconnectMaxMs, DEFAULTS.sse.reconnectMaxMs);
  assert.equal(config.sse.idleTimeoutMs, DEFAULTS.sse.idleTimeoutMs);
  assert.equal(config.outbound.timeoutMs, DEFAULTS.outbound.timeoutMs);
  assert.equal(config.outbound.maxChars, DEFAULTS.outbound.maxChars);
  assert.equal(config.queue.maxPending, DEFAULTS.queue.maxPending);
});

test('parseBaseUrl refuses paths, queries and credentials', () => {
  assert.deepEqual(parseBaseUrl('http://127.0.0.1:3009'), {
    origin: 'http://127.0.0.1:3009', host: '127.0.0.1', port: 3009, secure: false,
  });
  assert.equal(parseBaseUrl('http://127.0.0.1:3009/api'), null);
  assert.equal(parseBaseUrl('http://127.0.0.1:3009/?x=1'), null);
  assert.equal(parseBaseUrl('http://u:p@127.0.0.1:3009'), null);
  assert.equal(parseBaseUrl('https://chat.example.com').port, 443);
  assert.equal(parseBaseUrl(''), null);
});

test('the config object never contains a credential value', () => {
  const { config } = resolveConfig({
    enabled: true, baseUrl: 'http://x', uid: 4, credentialFile: '/path/cred.json',
  }, { VOICECHAT_BOT_API_KEY: 'should-not-be-read' });
  const text = JSON.stringify(config);
  assert.equal(text.includes('should-not-be-read'), false);
});
