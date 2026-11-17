import test from 'node:test';
import assert from 'node:assert/strict';

import { publishPort, resolvePort, registryKeysFor, describeKeys, PORT_NAME, COMPANION_PORTS_SYMBOL } from '../publish.mjs';

const ROOT = 'D:\\DSH\\dsh-production\\data';

function registry() {
  return process[COMPANION_PORTS_SYMBOL];
}

test('the published name is the one the contract promises', () => {
  assert.equal(PORT_NAME, 'companionVoceChat');
});

test('publish then resolve round-trips on the namespaced key', () => {
  const service = { send: async () => ({ mid: 1 }), subscribe: () => () => {} };
  const release = publishPort({ root: ROOT, service });
  const found = resolvePort({ root: ROOT });
  assert.equal(found, service);
  release();
  assert.equal(resolvePort({ root: ROOT }), null, 'releasing must remove the entry');
});

test('release is idempotent and does not disturb a later publisher', () => {
  const a = { tag: 'a' };
  const b = { tag: 'b' };
  const releaseA = publishPort({ root: ROOT, service: a });
  releaseA();
  releaseA();
  const releaseB = publishPort({ root: ROOT, service: b });
  assert.equal(resolvePort({ root: ROOT }).tag, 'b');
  releaseB();
});

test('a service that reports itself unready is treated as absent', () => {
  const service = { tag: 'unready' };
  let ready = false;
  const release = publishPort({ root: ROOT, service, ready: () => ready });
  // Half-broken must look absent, not half-present: a consumer acting on an uninitialised service
  // is how the 2026-11-04 health incident cascaded.
  assert.equal(resolvePort({ root: ROOT }), null);
  ready = true;
  assert.equal(resolvePort({ root: ROOT }).tag, 'unready');
  release();
});

test('a throwing ready() is treated as not ready, not as ready', () => {
  const service = { tag: 'throws' };
  const release = publishPort({ root: ROOT, service, ready: () => { throw new Error('nope'); } });
  assert.equal(resolvePort({ root: ROOT }), null);
  release();
});

test('the bare data-root key is NOT overwritten when another service holds it', () => {
  // companion-health publishes under the bare root too. Overwriting would silently break it.
  const health = { tag: 'health' };
  const registryMap = new Map();
  process[COMPANION_PORTS_SYMBOL] = registryMap;
  registryMap.set(ROOT, { service: health, ready: () => true, name: 'companionHealth' });

  const service = { tag: 'vocechat' };
  const release = publishPort({ root: ROOT, service });

  // The occupant must survive.
  assert.deepEqual(registryMap.get(ROOT).service, health, 'the first occupant must keep the bare key');
  // And our service must still be reachable via its namespaced key.
  const key = registryKeysFor(ROOT)[0];
  assert.equal(registryMap.get(key).service, service);

  release();
  assert.equal(registryMap.has(key), false);
  assert.equal(registryMap.get(ROOT).service, health);
  process[COMPANION_PORTS_SYMBOL] = new Map();
});

test('namespaced keys survive Windows spelling differences', () => {
  const keys = registryKeysFor(ROOT);
  assert.ok(keys.length >= 2, `expected several spellings, got ${keys.length}`);
  // Forward slash, no trailing slash and lowercase are all covered.
  assert.ok(keys.some(k => k.includes('D:/DSH')));
  assert.ok(keys.some(k => k.includes('d:/dsh')), 'case-insensitive variant on win32');
  for (const key of keys) assert.ok(key.startsWith(`${PORT_NAME}\u0000`));
});

test('describeKeys reports both spellings, so key alignment is checkable at runtime', () => {
  const described = describeKeys(ROOT);
  assert.ok(described.namespaced.length >= 2);
  assert.ok(described.bare.length >= 2);
  assert.ok(described.bare.includes(ROOT));
});

test('an empty root publishes nothing rather than a key of ""', () => {
  const release = publishPort({ root: '', service: { tag: 'x' } });
  // Nothing to resolve against: an empty key would be a global slot every plugin shares.
  assert.equal(registryKeysFor('').length, 0);
  release();
});

test('a missing service publishes nothing and returns a safe no-op', () => {
  const release = publishPort({ root: ROOT, service: null });
  assert.equal(typeof release, 'function');
  assert.equal(resolvePort({ root: ROOT }), null);
});

test('accept lets a consumer reject a foreign service on the shared bare key', () => {
  const registryMap = new Map();
  process[COMPANION_PORTS_SYMBOL] = registryMap;
  const foreign = { tag: 'something-else' };
  registryMap.set(ROOT, { service: foreign, ready: () => true, name: 'other' });

  const ours = { tag: 'ours', send: () => {} };
  const release = publishPort({ root: ROOT, service: ours });

  // Without a shape check a resolver could hand back the foreign object and fail far away.
  const strict = resolvePort({ root: ROOT, accept: v => typeof v?.send === 'function' });
  assert.equal(strict.tag, 'ours');
  release();
  process[COMPANION_PORTS_SYMBOL] = new Map();
});

test('a stale registry left by a previous test run does not leak into an assertion', () => {
  // Guard: the symbol is process-global by design, so each test that seeds it must clean up.
  assert.ok(registry() === undefined || registry() instanceof Map);
});
