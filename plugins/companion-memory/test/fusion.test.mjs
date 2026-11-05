import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CIRCUIT_COOLDOWN_MS,
  DEFAULT_DIMENSIONS,
  EMBEDDING_VERSION,
  FAILURE_THRESHOLD,
  cosineSimilarity,
  createEmbeddingProvider,
  hashEmbedding,
  localModelName,
  resolveEmbeddingsUrl,
} from '../lib/embed.mjs';
import {
  SECTIONS,
  budgetCaps,
  fuse,
  mmrSelect,
  packBudget,
} from '../lib/fusion.mjs';
import { BUDGET, RETRIEVAL_DEFAULTS } from '../lib/policy.mjs';

// No real network is ever used: every remote test injects a fake fetch. No
// production data is touched; only the single round-trip test writes a scratch
// vector file into a temp dir that is removed in t.after.

function fakeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function norm(vector) {
  return Math.sqrt([...vector].reduce((sum, value) => sum + value * value, 0));
}

// Element-wise, numeric comparison: the fallback must be the *same* vector the
// local channel produces, not merely a vector of the same length.
function assertSameVector(actual, expected, label = 'vector') {
  assert.ok(actual, `${label}: no vector`);
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let index = 0; index < expected.length; index++) {
    assert.equal(actual[index], expected[index], `${label}: element ${index}`);
  }
}

// ---------------------------------------------------------------------------
// local vector channel
// ---------------------------------------------------------------------------

test('hashEmbedding is deterministic, unit length and 256 dimensional by default', () => {
  const vector = hashEmbedding('用户喜欢喝手冲咖啡');
  const again = hashEmbedding('用户喜欢喝手冲咖啡');

  assert.ok(vector instanceof Float32Array);
  assert.equal(vector.length, DEFAULT_DIMENSIONS);
  assert.deepEqual([...vector], [...again]);
  assert.ok(Math.abs(norm(vector) - 1) < 1e-5, `expected unit length, got ${norm(vector)}`);
  assert.equal(localModelName(), 'hash-bigram-256');
  assert.equal(hashEmbedding('用户喜欢喝手冲咖啡', { dimensions: 64 }).length, 64);

  // Lexical neighbourhood: shared bigrams score higher than unrelated text.
  const nearby = cosineSimilarity(vector, hashEmbedding('用户喜欢喝茶'));
  const unrelated = cosineSimilarity(vector, hashEmbedding('今天上海天气晴朗'));
  assert.ok(nearby > unrelated, `nearby ${nearby} should beat unrelated ${unrelated}`);
  assert.ok(nearby > 0);
});

test('empty or stop-word only text gives a zero vector and zero similarity', () => {
  const zero = hashEmbedding('');
  assert.equal(zero.length, DEFAULT_DIMENSIONS);
  assert.ok([...zero].every(value => value === 0));
  assert.equal(cosineSimilarity(zero, hashEmbedding('用户喜欢喝咖啡')), 0);
  assert.equal(cosineSimilarity(zero, zero), 0);
  assert.equal(cosineSimilarity(hashEmbedding('的'), hashEmbedding('的了')), 0);
});

test('cosineSimilarity stays inside [-1, 1] and never returns NaN', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0, 0], [1, 0, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0, 0], [-1, 0, 0, 0]) + 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);

  // Bad input is a score of 0, never a throw or a NaN.
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0]), 0, 'length mismatch');
  assert.equal(cosineSimilarity(null, [1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, 'zero vector');
  assert.ok(Number.isFinite(cosineSimilarity([Number.NaN, 1], [1, 1])));

  const samples = [
    hashEmbedding('用户喜欢喝咖啡'),
    hashEmbedding('用户喜欢喝茶'),
    hashEmbedding('今天上海天气晴朗'),
    hashEmbedding('的'),
  ];
  for (const left of samples) {
    for (const right of samples) {
      const value = cosineSimilarity(left, right);
      assert.ok(value >= -1 && value <= 1, `out of range: ${value}`);
      assert.ok(Number.isFinite(value));
    }
  }
});

test('local vectors survive a Float32 disk round-trip, so an index can be rebuilt', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-fusion-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'vector.bin');

  const vector = hashEmbedding('用户喜欢喝手冲咖啡');
  fs.writeFileSync(file, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
  const bytes = Uint8Array.from(fs.readFileSync(file));
  const restored = new Float32Array(bytes.buffer, 0, vector.length);

  assert.deepEqual([...restored], [...vector]);
  assert.ok(Math.abs(cosineSimilarity(vector, restored) - 1) < 1e-6);
});

// ---------------------------------------------------------------------------
// provider factory: local / off / remote
// ---------------------------------------------------------------------------

test('local provider reports honest index metadata', async () => {
  const provider = await createEmbeddingProvider({ provider: 'local', dimensions: 128 });
  assert.equal(provider.provider, 'local');
  assert.equal(provider.model, 'hash-bigram-128');
  assert.equal(provider.dimensions, 128);
  assert.equal(provider.version, EMBEDDING_VERSION);
  assert.equal(provider.enabled(), true);

  const vectors = await provider.embed(['用户喜欢喝咖啡', '用户喜欢喝茶']);
  assert.equal(vectors.length, 2);
  for (const vector of vectors) assert.equal(vector.length, 128);
  assert.deepEqual([...vectors[0]], [...hashEmbedding('用户喜欢喝咖啡', { dimensions: 128 })]);
  assert.deepEqual(await provider.embed([]), []);

  // Batch envelope: plain array for legacy call sites plus the source tag.
  assert.ok(Array.isArray(vectors));
  assert.equal(vectors.vectors, vectors, 'vectors is the batch itself');
  assert.deepEqual(vectors.source, {
    provider: 'local', model: 'hash-bigram-128', dimensions: 128, version: EMBEDDING_VERSION, degraded: false,
  });

  const health = provider.health();
  assert.deepEqual(Object.keys(health).sort(), [
    'circuitOpenUntil', 'createdAt', 'degradedCount', 'dimensions', 'failures',
    'lastDegradedAt', 'lastError', 'lastSource', 'model', 'provider', 'version',
  ]);
  assert.equal(health.provider, 'local');
  assert.equal(health.model, 'hash-bigram-128');
  assert.equal(health.dimensions, 128);
  assert.equal(health.version, EMBEDDING_VERSION);
  assert.equal(health.failures, 0);
  assert.equal(health.circuitOpenUntil, 0);
  assert.equal(health.lastError, '');
  assert.equal(health.degradedCount, 0);
  assert.equal(health.lastDegradedAt, '');
  assert.deepEqual(health.lastSource, vectors.source);
  assert.ok(Number.isFinite(Date.parse(health.createdAt)));
});

test('a degraded remote batch is tagged with the local source, never the remote one', async () => {
  const provider = await createEmbeddingProvider({
    provider: 'remote', baseUrl: 'https://embed.example.test', model: 'text-embedding-3-small', dimensions: 64,
  }, { fetchImpl: async () => { throw new Error('endpoint down'); } });

  const batch = await provider.embed(['用户喜欢喝咖啡', '用户住在上海']);

  // Legacy array shape keeps working...
  assert.ok(Array.isArray(batch));
  assert.equal(batch.length, 2);
  assert.equal(batch.vectors, batch);

  // ...and the identity is honest: local_hash vectors, not the remote model.
  assert.deepEqual(batch.source, {
    provider: 'local', model: 'hash-bigram-64', dimensions: 64, version: EMBEDDING_VERSION, degraded: true,
  });
  assertSameVector(batch[0], hashEmbedding('用户喜欢喝咖啡', { dimensions: 64 }), 'degraded[0]');
  assertSameVector(batch[1], hashEmbedding('用户住在上海', { dimensions: 64 }), 'degraded[1]');

  // The configured target stays reported as the target, health shows reality.
  assert.equal(provider.provider, 'remote');
  assert.equal(provider.model, 'text-embedding-3-small');
  const health = provider.health();
  assert.equal(health.provider, 'remote');
  assert.equal(health.model, 'text-embedding-3-small');
  assert.deepEqual(health.lastSource, batch.source);
  assert.equal(health.degradedCount, 1);
  assert.ok(Number.isFinite(Date.parse(health.lastDegradedAt)));
  assert.equal(health.lastError, 'endpoint down');
});

test('provider off disables the channel without breaking the shapes', async () => {
  const provider = await createEmbeddingProvider({ provider: 'off' });
  assert.equal(provider.enabled(), false);
  const vectors = await provider.embed(['用户喜欢喝咖啡', '第二句']);
  assert.equal(vectors.length, 2);
  for (const vector of vectors) {
    assert.equal(vector.length, DEFAULT_DIMENSIONS);
    assert.ok([...vector].every(value => value === 0));
  }
  assert.equal(provider.health().provider, 'off');
  assert.deepEqual(vectors.source, {
    provider: 'off', model: '', dimensions: DEFAULT_DIMENSIONS, version: EMBEDDING_VERSION, degraded: false,
  });
  assert.deepEqual(provider.health().lastSource, vectors.source);
  assert.equal(provider.health().degradedCount, 0);
});

test('resolveEmbeddingsUrl accepts the usual base url shapes', () => {
  assert.equal(resolveEmbeddingsUrl('https://api.example.test/v1'), 'https://api.example.test/v1/embeddings');
  assert.equal(resolveEmbeddingsUrl('https://api.example.test'), 'https://api.example.test/v1/embeddings');
  assert.equal(resolveEmbeddingsUrl('https://api.example.test/v1/'), 'https://api.example.test/v1/embeddings');
  assert.equal(resolveEmbeddingsUrl('https://api.example.test/v1/embeddings'), 'https://api.example.test/v1/embeddings');
  assert.equal(resolveEmbeddingsUrl(''), '');
  assert.equal(resolveEmbeddingsUrl(undefined), '');
});

test('remote provider posts an OpenAI compatible request and normalises the answer', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return fakeResponse({
      data: [
        { index: 0, embedding: [3, 4, 0, 0, 0, 0, 0, 0] },
        { index: 1, embedding: [0, 0, 5, 12, 0, 0, 0, 0] },
      ],
    });
  };
  const provider = await createEmbeddingProvider({
    provider: 'remote',
    baseUrl: 'https://embed.example.test/v1',
    model: 'text-embedding-3-small',
    dimensions: 8,
    apiKey: 'test-key',
  }, { fetchImpl });

  const vectors = await provider.embed(['用户喜欢喝咖啡', '用户喜欢喝茶']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://embed.example.test/v1/embeddings');
  assert.equal(calls[0].body.model, 'text-embedding-3-small');
  assert.deepEqual(calls[0].body.input, ['用户喜欢喝咖啡', '用户喜欢喝茶']);
  assert.equal(calls[0].headers.authorization, 'Bearer test-key');

  // 3-4-0.. -> 0.6/0.8, 5-12-0.. -> 5/13, 12/13: remote vectors are unit length.
  assert.ok(Math.abs(vectors[0][0] - 0.6) < 1e-6);
  assert.ok(Math.abs(vectors[0][1] - 0.8) < 1e-6);
  assert.ok(Math.abs(vectors[1][2] - 5 / 13) < 1e-6);
  assert.ok(Math.abs(vectors[1][3] - 12 / 13) < 1e-6);

  const health = provider.health();
  assert.equal(health.provider, 'remote');
  assert.equal(health.model, 'text-embedding-3-small');
  assert.equal(health.failures, 0);
  assert.equal(vectors.source.provider, 'remote');
  assert.equal(vectors.source.model, 'text-embedding-3-small');
  assert.equal(vectors.source.degraded, false);
  assert.deepEqual(health.lastSource, vectors.source);
  assert.equal(health.degradedCount, 0);
});

test('remote without usable config stays on the local channel and says so', async () => {
  const provider = await createEmbeddingProvider({ provider: 'remote', model: 'text-embedding-3-small', dimensions: 32 });

  // Configured target is still reported as remote...
  assert.equal(provider.provider, 'remote');
  assert.equal(provider.model, 'text-embedding-3-small');
  assert.match(provider.health().lastError, /baseUrl/);

  // ...but the batch is honestly local and marked degraded.
  const batch = await provider.embed(['用户喜欢喝咖啡']);
  assert.deepEqual(batch.source, {
    provider: 'local', model: 'hash-bigram-32', dimensions: 32, version: EMBEDDING_VERSION, degraded: true,
  });
  assertSameVector(batch[0], hashEmbedding('用户喜欢喝咖啡', { dimensions: 32 }), 'unconfigured remote');
  assert.deepEqual(provider.health().lastSource, batch.source);
  assert.equal(provider.health().degradedCount, 1);
});

test('every remote failure degrades to local vectors and never throws', async () => {
  const cases = [
    ['non-2xx', async () => fakeResponse({ error: 'boom' }, 500)],
    ['invalid json', async () => fakeResponse('<html>not json</html>')],
    ['dimension mismatch', async () => fakeResponse({ data: [{ index: 0, embedding: [1, 0] }] })],
    ['missing data', async () => fakeResponse({ ok: true })],
    ['network error', async () => { throw new Error('ECONNREFUSED'); }],
    ['invalid response object', async () => null],
  ];
  for (const [name, fetchImpl] of cases) {
    const provider = await createEmbeddingProvider({
      provider: 'remote', baseUrl: 'https://embed.example.test', model: 'm', dimensions: 16,
    }, { fetchImpl });
    const batch = await provider.embed('用户喜欢喝咖啡');
    assert.equal(batch.source.provider, 'local', name);
    assert.equal(batch.source.model, 'hash-bigram-16', name);
    assert.equal(batch.source.degraded, true, name);
    assertSameVector(batch[0], hashEmbedding('用户喜欢喝咖啡', { dimensions: 16 }), name);
    const health = provider.health();
    assert.equal(health.failures, 1, name);
    assert.ok(health.lastError.length > 0, name);
    assert.equal(health.circuitOpenUntil, 0, name);
    assert.equal(health.provider, 'remote', name);
    assert.equal(health.degradedCount, 1, name);
  }
});

test('an already aborted caller signal degrades without throwing or hanging', async () => {
  const fetchImpl = async (url, init) => {
    if (init.signal?.aborted) throw new Error('aborted before send');
    return fakeResponse({ data: [{ index: 0, embedding: new Array(8).fill(1) }] });
  };
  const provider = await createEmbeddingProvider({
    provider: 'remote', baseUrl: 'https://embed.example.test', model: 'm', dimensions: 8, timeoutMs: 5000,
  }, { fetchImpl });
  const controller = new AbortController();
  controller.abort();
  const batch = await provider.embed(['用户喜欢喝咖啡'], { signal: controller.signal });
  assertSameVector(batch[0], hashEmbedding('用户喜欢喝咖啡', { dimensions: 8 }), 'aborted signal');
  assert.equal(batch.source.provider, 'local');
  assert.equal(batch.source.degraded, true);
  assert.equal(provider.health().failures, 1);
});

test('remote timeout degrades to local and records the timeout', async () => {
  let aborted = false;
  const fetchImpl = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted'));
    }, { once: true });
  });
  const provider = await createEmbeddingProvider({
    provider: 'remote', baseUrl: 'https://embed.example.test', model: 'm', dimensions: 16, timeoutMs: 60,
  }, { fetchImpl });

  const batch = await provider.embed(['用户喜欢喝咖啡']);
  assert.equal(aborted, true);
  assertSameVector(batch[0], hashEmbedding('用户喜欢喝咖啡', { dimensions: 16 }), 'timeout');
  assert.equal(batch.source.provider, 'local');
  assert.equal(batch.source.degraded, true);
  assert.match(provider.health().lastError, /超时/);
});

test('three consecutive failures open the breaker, block traffic and later recover', async () => {
  let now = Date.parse('2026-03-07T10:00:00.000Z');
  let calls = 0;
  let failing = true;
  const fetchImpl = async () => {
    calls += 1;
    if (failing) throw new Error('endpoint down');
    return fakeResponse({ data: [{ index: 0, embedding: [0, 0, 0, 0, 0, 0, 7, 24] }] });
  };
  const provider = await createEmbeddingProvider({
    provider: 'remote', baseUrl: 'https://embed.example.test/v1', model: 'm', dimensions: 8,
  }, { fetchImpl, now: () => now });

  for (let i = 0; i < FAILURE_THRESHOLD; i++) {
    const batch = await provider.embed(['用户喜欢喝咖啡']);
    assertSameVector(batch[0], hashEmbedding('用户喜欢喝咖啡', { dimensions: 8 }), `failure ${i}`);
    assert.equal(batch.source.provider, 'local');
    assert.equal(batch.source.degraded, true);
  }
  assert.equal(calls, FAILURE_THRESHOLD);
  const open = provider.health();
  assert.equal(open.failures, FAILURE_THRESHOLD);
  assert.equal(open.circuitOpenUntil, now + CIRCUIT_COOLDOWN_MS);
  assert.equal(open.degradedCount, FAILURE_THRESHOLD);
  assert.equal(open.lastSource.provider, 'local');
  assert.equal(open.lastSource.degraded, true);
  const degradedAt = open.lastDegradedAt;
  assert.ok(Number.isFinite(Date.parse(degradedAt)));

  // Breaker open: no further request is attempted, local vectors are used.
  const duringOutage = await provider.embed(['用户喜欢喝咖啡']);
  assert.equal(calls, FAILURE_THRESHOLD);
  assertSameVector(duringOutage[0], hashEmbedding('用户喜欢喝咖啡', { dimensions: 8 }), 'breaker open');
  assert.equal(duringOutage.source.degraded, true);
  assert.equal(provider.health().degradedCount, FAILURE_THRESHOLD + 1);

  // Cooldown elapsed and the endpoint is healthy again: one probe, then reset.
  failing = false;
  now += CIRCUIT_COOLDOWN_MS + 1;
  const recoveredBatch = await provider.embed(['用户喜欢喝咖啡']);
  const recovered = recoveredBatch[0];
  assert.equal(calls, FAILURE_THRESHOLD + 1);
  assert.ok(Math.abs(recovered[6] - 7 / 25) < 1e-6, 'expected the remote vector after recovery');
  assert.ok(Math.abs(recovered[7] - 24 / 25) < 1e-6);
  assert.ok(Math.abs(recovered[0]) < 1e-9);
  assert.equal(recoveredBatch.source.provider, 'remote');
  assert.equal(recoveredBatch.source.degraded, false);

  const closed = provider.health();
  assert.equal(closed.failures, 0);
  assert.equal(closed.circuitOpenUntil, 0);
  assert.equal(closed.lastError, '');
  assert.equal(closed.degradedCount, FAILURE_THRESHOLD + 1, 'success does not add degradations');
  assert.equal(closed.lastSource.provider, 'remote');
  assert.equal(closed.lastDegradedAt, degradedAt, 'last degradation time is not overwritten by a success');
});

// ---------------------------------------------------------------------------
// reciprocal rank fusion
// ---------------------------------------------------------------------------

test('fuse merges both channels with reciprocal rank fusion', () => {
  const lexical = [{ id: 'a', score: 9 }, { id: 'b', score: 7 }, { id: 'c', score: 5 }];
  const semantic = [{ id: 'c', score: 0.9 }, { id: 'a', score: 0.8 }, { id: 'd', score: 0.4 }];
  const fused = fuse({ lexical, semantic, rrfK: 60 });

  // a is 1st+2nd, c is 3rd+1st: the two channels complement each other.
  assert.deepEqual(fused.map(item => item.id), ['a', 'c', 'b', 'd']);

  const k = 60;
  const expected = {
    a: 1 / (k + 1) + 1 / (k + 2),
    c: 1 / (k + 3) + 1 / (k + 1),
    b: 1 / (k + 2),
    d: 1 / (k + 3),
  };
  for (const item of fused) {
    assert.ok(Math.abs(item.score - expected[item.id]) < 1e-12, `${item.id}: ${item.score}`);
  }
  for (let i = 1; i < fused.length; i++) assert.ok(fused[i - 1].score >= fused[i].score);

  assert.deepEqual(fused.find(item => item.id === 'a').channels, ['lexical', 'semantic']);
  assert.deepEqual(fused.find(item => item.id === 'c').channels, ['lexical', 'semantic']);
  assert.deepEqual(fused.find(item => item.id === 'b').channels, ['lexical']);
  assert.deepEqual(fused.find(item => item.id === 'd').channels, ['semantic']);
});

test('fuse counts one rank per channel and is safe on empty input', () => {
  assert.deepEqual(fuse({}), []);
  assert.deepEqual(fuse(), []);
  assert.deepEqual(fuse({ lexical: null, semantic: undefined }), []);
  assert.deepEqual(fuse({ lexical: [{ id: '' }, null, { score: 3 }] }), []);

  const fused = fuse({
    lexical: [{ id: 'a', score: 1 }, { id: 'a', score: 5 }],
    semantic: [{ id: 'a', score: 1 }],
    rrfK: 10,
  });
  assert.equal(fused.length, 1);
  assert.ok(Math.abs(fused[0].score - (1 / 11 + 1 / 11)) < 1e-12, 'duplicate id keeps the best rank once');

  // minScore can drop weak fused candidates.
  assert.deepEqual(fuse({ lexical: [{ id: 'a', score: 1 }], rrfK: 10, minScore: 0.5 }), []);
  assert.equal(RETRIEVAL_DEFAULTS.rrfK, 60);

  // Equal fused scores fall back to id order, never to input order or locale.
  const tie = fuse({ lexical: [{ id: 'b', score: 3 }], semantic: [{ id: 'a', score: 3 }], rrfK: 60 });
  assert.deepEqual(tie.map(item => item.id), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// MMR
// ---------------------------------------------------------------------------

test('mmrSelect drops near duplicates but keeps distinct candidates', () => {
  const candidates = [
    { id: 'a', score: 1.0, text: '用户喜欢手冲咖啡' },
    { id: 'b', score: 0.95, text: '用户喜欢手冲咖啡这件事' },
    { id: 'c', score: 0.6, text: '用户住在上海' },
    { id: 'd', score: 0.5, text: '用户的猫叫布丁' },
  ];
  const vectors = new Map([
    ['a', new Float32Array([1, 0, 0, 0])],
    ['b', new Float32Array([1, 0, 0, 0])], // same fact, rendered twice
    ['c', new Float32Array([0, 1, 0, 0])],
    ['d', new Float32Array([0, 0, 1, 0])],
  ]);

  const selected = mmrSelect({ candidates, vectors, limit: 3, lambda: 0.72 });
  assert.deepEqual(selected.map(item => item.id), ['a', 'c', 'd']);
  assert.deepEqual(mmrSelect({ candidates, vectors, limit: 3, lambda: 0.72 }), selected, 'stable across runs');
  // Raising the limit does not resurrect the duplicate.
  assert.deepEqual(mmrSelect({ candidates, vectors, limit: 4, lambda: 0.72 }).map(item => item.id), ['a', 'c', 'd']);
});

test('mmrSelect falls back to a text fingerprint when vectors are missing', () => {
  const prefix = '用户喜欢喝咖啡尤其是手冲每天早上都要来一杯自己磨豆子再加一点奶，不加糖也不加冰';
  assert.ok(prefix.length >= 32);
  const candidates = [
    { id: 'x', score: 1, text: `${prefix}，这是第一段讲法` },
    { id: 'y', score: 0.9, text: `${prefix}，换一种说法复述` },
    { id: 'z', score: 0.5, text: '用户住在上海，周末常去打球' },
  ];
  const selected = mmrSelect({ candidates, limit: 3 });
  assert.deepEqual(selected.map(item => item.id), ['x', 'z']);
});

test('mmrSelect handles empty and degenerate input', () => {
  assert.deepEqual(mmrSelect({}), []);
  assert.deepEqual(mmrSelect({ candidates: [] }), []);
  assert.deepEqual(mmrSelect({ candidates: [{ score: 1 }] }), []);
  assert.deepEqual(mmrSelect({ candidates: [{ id: 'a', score: 1 }], limit: 0 }), []);

  const single = mmrSelect({ candidates: [{ id: 'a', score: 1 }], limit: 5 });
  assert.deepEqual(single.map(item => item.id), ['a']);
  assert.ok(Number.isFinite(single[0].score));
  assert.equal(RETRIEVAL_DEFAULTS.mmrLambda, 0.72);
});

// ---------------------------------------------------------------------------
// budget packing
// ---------------------------------------------------------------------------

test('packBudget never exceeds the budget and honours the policy section shares', () => {
  const entries = [];
  for (let i = 0; i < 12; i++) {
    // Distinct values, otherwise the value dedupe (not the budget) drops them.
    entries.push({ id: `stable-${i}`, section: 'stable', score: 1 - i * 0.01, text: `事实${i}`.padEnd(120, '稳') });
  }
  const result = packBudget({ entries, budget: 1000 });
  const limits = budgetCaps({ budget: 1000 });

  assert.ok(result.used <= 1000);
  assert.ok(result.used <= limits.allocatable);
  assert.equal(limits.caps.stable, 300);
  assert.equal(result.lines.length, 2, '121 char lines under a 300 char stable cap');
  const stableUsed = result.lines.reduce((sum, line) => sum + line.length + 1, 0);
  assert.ok(stableUsed <= limits.caps.stable);
  assert.equal(result.used, stableUsed);
  assert.equal(result.dropped.length, 10);
  assert.ok(result.dropped.every(item => item.reason === 'section-budget'));
});

test('packBudget fills sections in priority order regardless of score', () => {
  const entries = [];
  for (let i = 0; i < 5; i++) entries.push({ id: `id-${i}`, section: 'identity', score: 0.1, text: `身份${i}`.padEnd(40, '甲') });
  for (let i = 0; i < 3; i++) entries.push({ id: `cur-${i}`, section: 'current', score: 0.99, text: `状态${i}`.padEnd(40, '乙') });

  const result = packBudget({ entries, budget: 1000 });
  assert.deepEqual(result.lines.map(line => line.slice(0, 2)), ['身份', '身份', '身份', '身份', '状态', '状态']);
  assert.equal(result.lines.length, 6);
  assert.equal(result.dropped.length, 2);
  assert.ok(result.dropped.every(item => item.reason === 'section-budget'));
  assert.ok(result.used <= 1000);
});

test('packBudget honours explicit weights and de-duplicates ids and values', () => {
  const entries = [
    { id: 'a', section: 'identity', score: 1, text: '核心身份说明' },
    { id: 'b', section: 'stable', score: 1, text: '稳定事实一' },
    { id: 'b', section: 'stable', score: 0.5, text: '稳定事实一的重复条目' },
    { id: 'c', section: 'related', score: 1, text: '相关剧情' },
    { id: 'd', section: 'related', score: 0.9, text: '相关剧情' },
    { id: 'e', section: 'current', score: 1, text: '当前状态' },
  ];

  const onlyCurrent = packBudget({
    entries,
    budget: 500,
    weights: { identity: 0, stable: 0, related: 0, current: 1 },
  });
  assert.deepEqual(onlyCurrent.lines, ['当前状态']);
  assert.ok(onlyCurrent.used <= 500);
  assert.equal(onlyCurrent.dropped.length, 5);

  const packed = packBudget({ entries, budget: 2400 });
  assert.deepEqual(packed.lines, ['核心身份说明', '稳定事实一', '相关剧情', '当前状态']);
  assert.equal(new Set(packed.lines).size, packed.lines.length);
  assert.deepEqual(packed.dropped.filter(item => item.reason === 'duplicate-id').map(item => item.id), ['b']);
  assert.deepEqual(packed.dropped.filter(item => item.reason === 'duplicate-value').map(item => item.id), ['d']);
  assert.ok(packed.used <= 2400);
});

test('packBudget is safe on empty input and reproducible, and defaults follow policy', () => {
  assert.deepEqual(packBudget({ entries: [] }), { lines: [], used: 0, dropped: [] });
  assert.deepEqual(packBudget(), { lines: [], used: 0, dropped: [] });
  assert.deepEqual(packBudget({ entries: null, budget: 0 }), { lines: [], used: 0, dropped: [] });

  const entries = [{ id: 'a', section: 'stable', score: 0.5, text: '稳定事实' }];
  assert.deepEqual(packBudget({ entries, budget: 2400 }), packBudget({ entries, budget: 2400 }));

  const zero = packBudget({ entries, budget: 0 });
  assert.deepEqual(zero.lines, []);
  assert.equal(zero.used, 0);
  assert.equal(zero.dropped.length, 1);

  const defaults = budgetCaps();
  assert.equal(defaults.budget, BUDGET.total);
  assert.equal(defaults.reserve, BUDGET.reserve);
  assert.equal(defaults.caps.identity, 466);
  assert.deepEqual(Object.keys(defaults.caps), [...SECTIONS]);
  assert.ok(SECTIONS.every(section => defaults.caps[section] > 0));
  assert.equal(Object.values(defaults.caps).reduce((a, b) => a + b, 0) <= defaults.allocatable, true);
});
