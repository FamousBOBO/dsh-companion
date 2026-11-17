import test from 'node:test';
import assert from 'node:assert/strict';

import { createUserApi, VoceChatApiError, targetOf, codeForStatus } from '../user-api.mjs';

/** Records requests and answers from a scripted queue. */
function stubFetch(script = []) {
  const calls = [];
  let index = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(index, script.length - 1)] ?? { status: 200, body: '' };
    index += 1;
    if (step.throws) throw step.throws;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      text: async () => step.body ?? '',
    };
  };
  return { impl, calls };
}

/** An auth stub that hands out a token and counts renewals, switching to the fresh one after. */
function stubAuth({ token = 'T1', refresh = 'T2' } = {}) {
  let current = token;
  let renewals = 0;
  return {
    token: async () => current,
    refreshNow: async () => { renewals += 1; current = refresh; return refresh; },
    renewals: () => renewals,
  };
}

function apiWith(script, authOverrides = {}) {
  const stub = stubFetch(script);
  const auth = stubAuth(authOverrides);
  const api = createUserApi({ baseUrl: 'http://127.0.0.1:3009', auth, fetchImpl: stub.impl });
  return { api, stub, auth };
}

test('send posts the raw text to the channel endpoint', async () => {
  const { api, stub } = apiWith([{ status: 200, body: '222' }]);
  const { mid } = await api.send({ channel: 1 }, 'hello');
  assert.equal(mid, 222);
  assert.equal(stub.calls[0].url, 'http://127.0.0.1:3009/api/group/1/send');
  assert.equal(stub.calls[0].init.body, 'hello');
  assert.equal(stub.calls[0].init.headers['content-type'], 'text/plain');
  assert.equal(stub.calls[0].init.headers['x-api-key'], 'T1');
});

test('a DM goes to the user send endpoint', async () => {
  const { api, stub } = apiWith([{ status: 200, body: '223' }]);
  await api.send({ user: 1 }, 'dm');
  assert.equal(stub.calls[0].url, 'http://127.0.0.1:3009/api/user/1/send');
});

test('markdown reaches the header verbatim', async () => {
  const { api, stub } = apiWith([{ status: 200, body: '1' }]);
  await api.send({ channel: 1 }, '**x**', 'text/markdown');
  assert.equal(stub.calls[0].init.headers['content-type'], 'text/markdown');
});

test('an unsupported content type is refused locally', async () => {
  const { api, stub } = apiWith([]);
  await assert.rejects(api.send({ channel: 1 }, 'x', 'text/html'), error => error.code === 'unsupported-content-type');
  assert.equal(stub.calls.length, 0);
});

test('an empty message is refused locally', async () => {
  const { api, stub } = apiWith([]);
  await assert.rejects(api.send({ channel: 1 }, '   '), error => error.code === 'empty-text');
  assert.equal(stub.calls.length, 0);
});

test('targetOf refuses id 0 and non-integers', () => {
  assert.deepEqual(targetOf({ channel: 1 }), { kind: 'channel', id: 1 });
  assert.deepEqual(targetOf({ user: 4 }), { kind: 'user', id: 4 });
  assert.equal(targetOf({ channel: 0 }), null);
  assert.equal(targetOf({ channel: 1.5 }), null);
  assert.equal(targetOf({}), null);
});

test('codeForStatus maps every status we handle', () => {
  assert.equal(codeForStatus(400), 'payload');
  assert.equal(codeForStatus(401), 'unauthorized');
  assert.equal(codeForStatus(403), 'forbidden');
  assert.equal(codeForStatus(404), 'not-found');
  assert.equal(codeForStatus(413), 'too-large');
  assert.equal(codeForStatus(415), 'unsupported-content-type');
  assert.equal(codeForStatus(429), 'rate-limited');
  assert.equal(codeForStatus(500), 'server');
  assert.equal(codeForStatus(418), 'http-418');
});

test('a 401 renews once and retries — that is the whole point of the auth layer', async () => {
  const { api, stub, auth } = apiWith([
    { status: 401, body: 'authorization error' },
    { status: 200, body: '300' },
  ]);
  const { mid } = await api.send({ channel: 1 }, 'after-renew');
  assert.equal(mid, 300);
  assert.equal(auth.renewals(), 1);
  assert.equal(stub.calls.length, 2, 'one failed attempt + one retry');
  // The retry must carry the renewed token, not the dead one.
  assert.equal(stub.calls[1].init.headers['x-api-key'], 'T2');
});

test('a second 401 inside the retry surfaces instead of looping', async () => {
  const { api, stub, auth } = apiWith([
    { status: 401, body: 'nope' },
    { status: 401, body: 'still nope' },
  ]);
  await assert.rejects(api.send({ channel: 1 }, 'x'), error => error.code === 'unauthorized');
  assert.equal(auth.renewals(), 1, 'exactly one renewal, never a loop');
  assert.equal(stub.calls.length, 2);
});

test('a 403 does NOT trigger a renewal (it is a permission problem, not a token problem)', async () => {
  const { api, auth } = apiWith([{ status: 403, body: 'forbidden' }]);
  await assert.rejects(api.send({ channel: 1 }, 'x'), error => error.code === 'forbidden');
  assert.equal(auth.renewals(), 0);
});

test('history requests the right path with limit and before', async () => {
  const { api, stub } = apiWith([{ status: 200, body: '[{"mid":5}]' }]);
  const rows = await api.history({ channel: 1 }, { limit: 3, before: 9 });
  assert.equal(rows.length, 1);
  assert.match(stub.calls[0].url, /\/api\/group\/1\/history\?limit=3&before=9$/);

  const dm = await api.history({ user: 1 }, { limit: 2 });
  assert.match(stub.calls[1].url, /\/api\/user\/1\/history\?limit=2$/);
});

test('history refuses a non-array body rather than pretending there is no history', async () => {
  const { api } = apiWith([{ status: 200, body: '{"nope":true}' }]);
  await assert.rejects(api.history({ channel: 1 }), error => error.code === 'bad-response');
});

test('history caps an absurd limit', async () => {
  const { api, stub } = apiWith([{ status: 200, body: '[]' }]);
  await api.history({ channel: 1 }, { limit: 100000 });
  assert.match(stub.calls[0].url, /limit=100/);
});

test('channel detail parses JSON and refuses a bad gid', async () => {
  const { api } = apiWith([{ status: 200, body: '{"gid":1,"members":[1,2,4]}' }]);
  const detail = await api.channel(1);
  assert.deepEqual(detail.members, [1, 2, 4]);
  await assert.rejects(api.channel(0), error => error.code === 'bad-target');
});

test('me and contacts parse their shapes', async () => {
  const { api } = apiWith([
    { status: 200, body: '{"uid":4,"name":"companion"}' },
    { status: 200, body: '[{"uid":1}]' },
  ]);
  const profile = await api.me();
  assert.equal(profile.uid, 4);
  const list = await api.contacts();
  assert.equal(list.length, 1);
});

test('status never throws and reports the failure code', async () => {
  const ok = apiWith([{ status: 200, body: '{"uid":4,"name":"companion","is_admin":false}' }]).api;
  const good = await ok.status();
  assert.equal(good.ok, true);
  assert.equal(good.uid, 4);

  const down = apiWith([{ throws: new TypeError('refused') }]).api;
  const bad = await down.status();
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'network');
});

test('an unconfigured baseUrl or missing auth is refused before any call', async () => {
  const stub = stubFetch([{ status: 200, body: '1' }]);
  const noBase = createUserApi({ baseUrl: '', auth: stubAuth(), fetchImpl: stub.impl });
  await assert.rejects(noBase.send({ channel: 1 }, 'x'), error => error.code === 'not-configured');
  assert.equal(stub.calls.length, 0);

  assert.throws(() => createUserApi({ baseUrl: 'http://x', auth: null }), error => error.code === 'no-auth');
});

test('a trailing slash on baseUrl does not double the separator', async () => {
  const stub = stubFetch([{ status: 200, body: '5' }]);
  const api = createUserApi({ baseUrl: 'http://x/', auth: stubAuth(), fetchImpl: stub.impl });
  await api.send({ channel: 1 }, 'x');
  assert.equal(stub.calls[0].url, 'http://x/api/group/1/send');
});

test('network errors and aborts get distinct codes', async () => {
  await assert.rejects(
    apiWith([{ throws: new TypeError('fetch failed') }]).api.send({ channel: 1 }, 'x'),
    error => error.code === 'network',
  );
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  await assert.rejects(
    apiWith([{ throws: abort }]).api.send({ channel: 1 }, 'x'),
    error => error.code === 'timeout',
  );
});

test('describe carries no credentials', () => {
  const { api } = apiWith([]);
  const text = JSON.stringify(api.describe());
  assert.equal(text.includes('T1'), false);
  assert.equal(text.includes('T2'), false);
});
