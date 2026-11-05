import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXPERIENCE_NAMESPACE,
  EXPERIENCE_TRANSFORM_VERSION,
  EXPERIENCE_KEY_FIELDS,
  buildExperienceRequest,
  createMemoryPort,
  experienceIdentity,
  parseScopeKey,
} from './autonomy-memory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = relative => pathToFileURL(path.join(here, relative)).href;
const { createMemoryEngine } = await import(moduleUrl('../companion-memory/index.mjs'));
const { openRuntimeDb } = await import(moduleUrl('../companion-runtime/lib/db.mjs'));
const { drainOutbox, enqueueIngest } = await import(moduleUrl('../companion-runtime/lib/bridge.mjs'));

// Contract v1.2 section 5: the finished-experience write must use the existing persistent
// chain, a frozen dedupe key and `no-experience` for a legitimately empty completion.
// The memory side is either the real SQLite engine over a throwaway root or an explicit
// fake; the production `home/` tree and the production databases are never opened.

const T0 = Date.UTC(2026, 9, 30, 9, 0, 0);
const USER = '1429709395';
const PERSONA = 'march7';
const SCOPE_KEY = `u:${USER}|p:${PERSONA}|w:world:default`;

function makeRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const dir of ['logs', 'home/memory', 'home/companion']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    backend: 'sqlite',
    database: 'home/memory/companion-memory.db',
    wiki: { enabled: false },
    extraction: { enabled: false },
    retrieval: { semanticEnabled: false },
  }, null, 2), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows lock leftover */ } });
  return root;
}

function identityStub(userId = USER) {
  return {
    owner() { return { id: userId, displayName: '记忆桥测试', platform: 'local' }; },
    resolve(sessionId) { return { userId, personaId: PERSONA, displayName: '记忆桥测试', sessionId }; },
  };
}

async function realEngine(t) {
  const root = makeRoot(t, 'p2-memory-');
  const engine = createMemoryEngine({ root, identity: identityStub(), env: {}, now: () => T0 });
  t.after(async () => { try { await engine.close(); } catch { /* cleanup only */ } });
  await engine.initialize();
  return engine;
}

async function memoryCount(engine) {
  const internal = await engine.internal();
  return Number(internal.db.handle.prepare('SELECT COUNT(*) AS n FROM memories').get().n);
}

const READ_INPUT = Object.freeze({
  scopeKey: SCOPE_KEY,
  kind: 'read',
  target: 'https://en.wikipedia.org/wiki/Bridge',
  sourceRef: 'url:https://en.wikipedia.org/wiki/Bridge',
  sourceHash: 'a'.repeat(64),
  consumed: 1200,
  artifactRef: '',
  artifactVersion: 0,
  at: T0,
});

const WRITE_INPUT = Object.freeze({
  scopeKey: SCOPE_KEY,
  activityId: 'act_write_1',
  operation: 'finish',
  kind: 'write',
  target: '桥的一千种说法',
  sourceHash: 'b'.repeat(64),
  consumed: 0,
  artifactRef: 'home/companion/works/bridges.md',
  artifactVersion: 2,
  at: T0,
});

// ---------------------------------------------------------------------------
// scope parsing (the `w:world:default` bug)
// ---------------------------------------------------------------------------

test('scope parsing keeps `w:world:default` whole instead of truncating it to `world`', () => {
  const scope = parseScopeKey(SCOPE_KEY);
  assert.equal(scope.worldId, 'world:default');
  assert.notEqual(scope.worldId, 'world', 'the truncated world id is what made every ingest a world-scope-mismatch');
  assert.equal(scope.userId, USER);
  assert.equal(scope.personaId, PERSONA);
  assert.equal(scope.via, 'parseScope');
  // A world id that itself contains a colon (a roleplay world) survives too.
  assert.equal(parseScopeKey(`u:${USER}|p:${PERSONA}|w:archive:1999`).worldId, 'archive:1999');
});

test('the local fallback splits on the first colon only and defaults the world', () => {
  const partial = parseScopeKey(`u:${USER}|p:${PERSONA}`);
  assert.equal(partial.worldId, 'world:default', 'a missing world segment means the reality world');
  assert.equal(partial.via, 'first-colon');
  assert.equal(parseScopeKey(`u:${USER}|p:${PERSONA}|w:world:default|note:extra`).userId, USER);
  assert.equal(parseScopeKey(`u:*|p:${PERSONA}|w:world:default`), null, 'a wildcard scope is never writable');
  assert.equal(parseScopeKey(''), null);
  assert.equal(parseScopeKey('garbage'), null);
});

// ---------------------------------------------------------------------------
// deterministic dedupe key
// ---------------------------------------------------------------------------

test('the dedupe key is the frozen tuple and is stable across calls', () => {
  assert.deepEqual([...EXPERIENCE_KEY_FIELDS], ['scopeKey', 'activityId', 'operation', 'sourceHash', 'consumedFrom', 'consumedTo', 'artifactVersion']);
  const first = experienceIdentity(WRITE_INPUT);
  const second = experienceIdentity({ ...WRITE_INPUT });
  assert.equal(first.eventId, second.eventId);
  assert.match(first.eventId, /^p2_[0-9a-f]{64}$/);
  assert.deepEqual(first.tuple, [SCOPE_KEY, 'act_write_1', 'finish', 'b'.repeat(64), '0', '0', '2']);
  assert.equal(first.basis, 'activityId');
  // Every component moves the key.
  for (const change of [
    { scopeKey: `u:${USER}|p:${PERSONA}|w:world:other` },
    { activityId: 'act_write_2' },
    { operation: 'step' },
    { sourceHash: 'c'.repeat(64) },
    { consumedFrom: 1 },
    { consumedTo: 1 },
    { artifactVersion: 3 },
  ]) {
    assert.notEqual(experienceIdentity({ ...WRITE_INPUT, ...change }).eventId, first.eventId, `${Object.keys(change)[0]} must change the key`);
  }
});

test('without an activity id the key falls back to a stable content surrogate', () => {
  const first = experienceIdentity(READ_INPUT);
  const second = experienceIdentity({ ...READ_INPUT });
  assert.equal(first.basis, 'surrogate');
  assert.equal(first.eventId, second.eventId);
  assert.notEqual(experienceIdentity({ ...READ_INPUT, consumed: 900 }).eventId, first.eventId);
  const built = buildExperienceRequest(READ_INPUT, { now: () => T0 });
  assert.equal(built.meta.identityBasis, 'surrogate');
});

// ---------------------------------------------------------------------------
// payload construction
// ---------------------------------------------------------------------------

test('the ingest payload carries the frozen namespace, versions and actuality labels', () => {
  const built = buildExperienceRequest(READ_INPUT, { now: () => T0 });
  assert.equal(built.ok, true);
  assert.equal(built.value.namespace, EXPERIENCE_NAMESPACE);
  assert.equal(built.value.transformVersion, EXPERIENCE_TRANSFORM_VERSION);
  assert.equal(built.value.realityStatus, 'actual_tool_activity');
  assert.equal(built.value.evidenceStatus, 'observed');
  assert.deepEqual(built.value.subject, { userId: USER, personaId: PERSONA, worldId: 'world:default' });
  assert.equal(built.value.occurredAt, T0);
  assert.equal(built.value.eventId, experienceIdentity(READ_INPUT).eventId);
  assert.match(built.value.content, /阅读/);
  assert.match(built.value.content, /1200/);
});

test('the remembered content is bounded and never carries the body of what was read', () => {
  const built = buildExperienceRequest({
    ...READ_INPUT,
    content: 'SECRET BODY',
    body: 'SECRET BODY',
    text: 'SECRET BODY',
    excerpt: 'SECRET BODY',
  }, { now: () => T0 });
  assert.equal(built.ok, true);
  assert.doesNotMatch(built.value.content, /SECRET BODY/);
  assert.ok(built.value.content.length <= 600, 'the description stays bounded');
  const long = buildExperienceRequest({ ...READ_INPUT, target: 'x'.repeat(4000) }, { now: () => T0 });
  assert.ok(long.value.content.length <= 600);
});

test('simulated and hypothetical activity is never turned into an ingest request', async () => {
  const calls = [];
  const port = createMemoryPort({ engine: { async ingestDomainEvent(input) { calls.push(input); return { status: 'accepted' }; } }, now: () => T0 });
  for (const reality of ['simulated_world', 'hypothetical']) {
    const skipped = await port.recordExperience({ ...READ_INPUT, reality });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.code, 'simulated-not-remembered');
    assert.equal(skipped.reality, reality);
  }
  assert.equal(calls.length, 0, 'nothing reached the memory engine');
});

test('a finished activity with nothing worth remembering returns no-experience, not an error', async () => {
  const calls = [];
  const port = createMemoryPort({ engine: { async ingestDomainEvent(input) { calls.push(input); return { status: 'accepted' }; } }, now: () => T0 });
  const result = await port.recordExperience({ scopeKey: SCOPE_KEY, kind: 'explore', target: '', consumed: 0, artifactVersion: 0, at: T0 });
  assert.equal(result.ok, true, 'an empty completion is legal');
  assert.equal(result.status, 'skipped');
  assert.equal(result.code, 'no-experience');
  assert.equal(result.written, false);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// real memory engine
// ---------------------------------------------------------------------------

test('the real engine accepts the experience once and reports the second write as duplicate', async t => {
  const engine = await realEngine(t);
  const port = createMemoryPort({ engine, now: () => T0 });
  const first = await port.recordExperience(READ_INPUT);
  assert.equal(first.ok, true);
  assert.equal(first.status, 'accepted');
  assert.equal(first.written, true);
  assert.match(first.receiptId, /^rcpt_/);
  assert.equal(await memoryCount(engine), 1);

  const second = await port.recordExperience({ ...READ_INPUT });
  assert.equal(second.ok, true);
  assert.equal(second.status, 'duplicate');
  assert.equal(second.written, false);
  assert.equal(second.eventId, first.eventId, 'the same key is retried, not duplicated');
  assert.equal(await memoryCount(engine), 1, 'the engine holds exactly one memory');

  // The exact bug the contract calls out: a truncated world id is refused by the engine.
  const truncated = await port.recordExperience({ ...READ_INPUT, scopeKey: `u:${USER}|p:${PERSONA}|w:world` });
  assert.equal(truncated.ok, false);
  assert.equal(truncated.code, 'memory-rejected');
  assert.equal(truncated.reason, 'world-scope-mismatch');
  assert.equal(await memoryCount(engine), 1);
});

test('two different finished activities produce two memories with different keys', async t => {
  const engine = await realEngine(t);
  const port = createMemoryPort({ engine, now: () => T0 });
  const read = await port.recordExperience(READ_INPUT);
  const write = await port.recordExperience(WRITE_INPUT);
  assert.equal(read.status, 'accepted');
  assert.equal(write.status, 'accepted');
  assert.notEqual(read.eventId, write.eventId);
  assert.equal(await memoryCount(engine), 2);
});

// ---------------------------------------------------------------------------
// write-through outbox (the runtime's own memory_outbox)
// ---------------------------------------------------------------------------

test('an unavailable engine queues one outbox row that a single drain delivers exactly once', async t => {
  const root = makeRoot(t, 'p2-outbox-');
  const db = openRuntimeDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0, pragmas: false });
  db.acquireLease({ owner: 'p2-wiring-test', generation: 'gen-1', ttlMs: 600000 });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });

  const delivered = [];
  const memory = { async ingestDomainEvent(request) { delivered.push(request); return { status: 'accepted', receiptId: `rcpt_${delivered.length}` }; } };
  const outbox = {
    async enqueue(request) {
      const queued = enqueueIngest(db, {
        scopeKey: request.scopeKey,
        event: request.eventId,
        namespace: request.namespace,
        payload: {
          content: request.content,
          transformVersion: request.transformVersion,
          realityStatus: request.realityStatus,
          evidenceStatus: request.evidenceStatus,
          occurredAt: request.occurredAt,
        },
      });
      return { ok: true, outboxId: queued.outboxId, queued: queued.queued, duplicate: queued.queued === false, status: queued.status };
    },
    async drain() { return drainOutbox({ db, memory, generation: 'gen-1', now: T0 }); },
  };
  const unavailable = { async ingestDomainEvent() { return { status: 'retryable_failure', reason: 'memory-unavailable' }; } };
  const port = createMemoryPort({ engine: unavailable, outbox, now: () => T0 });

  const queuedOnce = await port.recordExperience(WRITE_INPUT);
  assert.equal(queuedOnce.ok, true);
  assert.equal(queuedOnce.status, 'queued');
  assert.equal(queuedOnce.written, false);
  assert.match(queuedOnce.outboxId, /^out_/);
  assert.equal(db.all('SELECT * FROM memory_outbox').length, 1);

  const queuedAgain = await port.recordExperience({ ...WRITE_INPUT });
  assert.equal(queuedAgain.ok, true);
  assert.equal(queuedAgain.duplicate, true);
  assert.equal(queuedAgain.outboxId, queuedOnce.outboxId);
  assert.equal(db.all('SELECT * FROM memory_outbox').length, 1, 'the same key never queues twice');

  const drained = await port.drain();
  assert.equal(drained.ok, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].namespace, EXPERIENCE_NAMESPACE);
  assert.equal(delivered[0].transformVersion, EXPERIENCE_TRANSFORM_VERSION);
  assert.equal(delivered[0].realityStatus, 'actual_tool_activity');
  assert.equal(db.all("SELECT * FROM memory_outbox WHERE status = 'sent'").length, 1);

  const drainedAgain = await port.drain();
  assert.equal(drainedAgain.detail.processed, 0, 'a second drain finds nothing to do');
  assert.equal(delivered.length, 1, 'memory is written exactly once');

  // A late retry after the drain must not queue a second row either.
  const afterDrain = await port.recordExperience({ ...WRITE_INPUT });
  assert.equal(afterDrain.ok, true);
  assert.equal(afterDrain.duplicate, true);
  assert.equal(db.all('SELECT * FROM memory_outbox').length, 1);
});

test('without an outbox the unavailable engine is reported honestly instead of silently dropped', async () => {
  const port = createMemoryPort({ engine: null, outbox: null, now: () => T0 });
  const result = await port.recordExperience(WRITE_INPUT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'memory-engine-unavailable');
  assert.equal(result.outbox, 'unwired');
  assert.equal(result.eventId, experienceIdentity(WRITE_INPUT).eventId, 'the key is still reported for a later retry');
});

test('a rejected experience is reported, not queued for a replay of the same rejection', async () => {
  const calls = [];
  const port = createMemoryPort({
    engine: { async ingestDomainEvent(input) { calls.push(input); return { status: 'rejected', reason: 'unbound-subject' }; } },
    outbox: { enqueue: async () => ({ ok: true, outboxId: 'out_x' }) },
    now: () => T0,
  });
  const result = await port.recordExperience(READ_INPUT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'memory-rejected');
  assert.equal(result.reason, 'unbound-subject');
  assert.equal(calls.length, 1);
});
