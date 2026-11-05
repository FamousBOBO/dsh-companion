import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { createDb, openRuntimeDb } from '../lib/db.mjs';
import { scopeKey } from '../lib/scope.mjs';

const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: '' });
const KEY = scopeKey(SCOPE);
const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);

function buildRoot(t, { config = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-modes-'));
  for (const dir of ['home/companion', 'home/memory', 'home/channel-qq', 'logs', 'workspace']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'bot',
    owner: { id: 'owner-1', displayName: 'owner', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: 'owner-1' }, sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite', injection: { budgetChars: 2400 },
    extraction: { enabled: false }, embedding: { provider: 'local', dimensions: 128 },
    wiki: { enabled: false },
  }));
  // A stand-in outbound ledger: the cognitive runtime must never touch it.
  fs.writeFileSync(path.join(root, 'home/channel-qq/contact.json'), JSON.stringify({ candidates: [], outbox: [], version: 1 }));
  if (config) fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify(config));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

function identityStub() {
  return {
    resolve(sessionId) {
      if (!sessionId) throw new Error('session required');
      return { userId: 'owner-1', persona: 'bot', sessionId, mode: 'local-owner' };
    },
  };
}

function memoryStub() {
  return {
    version: 'stub-0.4.0',
    calls: [],
    async ingestDomainEvent(input) {
      this.calls.push(input);
      return { status: 'accepted', receiptId: `rcpt-${input.eventId}` };
    },
  };
}

function mount(root, { config, memory = memoryStub(), now = () => T0 } = {}) {
  return mountRuntime({ tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } }, root, {
    config, memory, identity: identityStub(), now,
  });
}

test('A12: no runtime.config.json means off — no database, no writes, no injection', t => {
  const root = buildRoot(t);
  const runtime = mount(root);
  assert.equal(runtime.mode, 'off');
  assert.equal(runtime.writable, false);
  assert.equal(fs.existsSync(path.join(root, 'home/companion/companion-runtime.db')), false, 'the database is not even created');
  assert.equal(runtime.proposeGoal({ sessionId: 'session-a', title: '整理资料' }).ok, false);
  assert.equal(runtime.injectionFor({ sessionId: 'session-a' }).text, '');
  assert.equal(runtime.recordEvent({ kind: 'state/impulse', sessionId: 'session-a', payload: { amount: 0.1 } }).ok, false);
  const status = runtime.status({ sessionId: 'session-a' });
  assert.equal(status.mode, 'off');
  assert.equal(status.eventCount, 0);
  runtime.dispose();
});

test('A12: an on-disk config with enabled=false also stays off even if mode says active', t => {
  const root = buildRoot(t, { config: { enabled: false, mode: 'active' } });
  const runtime = mount(root);
  assert.equal(runtime.mode, 'off');
  assert.equal(fs.existsSync(path.join(root, 'home/companion/companion-runtime.db')), false);
  runtime.dispose();
});

test('A12: shadow mode records proposals only and never touches authoritative state', t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'shadow' } });
  const runtime = mount(root);
  assert.equal(runtime.mode, 'shadow');
  const proposed = runtime.proposeGoal({ sessionId: 'session-a', title: '整理资料', authorization: 'none' });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.shadow, true);
  assert.equal(proposed.decision, 'accepted-shadow');
  const belief = runtime.assertBelief({ sessionId: 'session-a', proposition: '用户可能在忙', rootEvidenceIds: ['ev-1'] });
  assert.equal(belief.shadow, true);
  const db = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM goals').n, 0, 'shadow never writes goals');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM beliefs').n, 0, 'shadow never writes beliefs');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM domain_events').n, 0, 'shadow never writes events');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM shadow_proposals').n, 2);
  assert.equal(runtime.injectionFor({ sessionId: 'session-a' }).text, '', 'shadow injects nothing');
  db.close();
  runtime.dispose();
});

test('A12: active mode writes state, exposes working memory, and stop refuses new commits', t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  const memory = memoryStub();
  const runtime = mount(root, { memory });
  assert.equal(runtime.mode, 'active');
  const created = runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶', nextStep: '联系师傅' });
  assert.equal(created.ok, true, JSON.stringify(created));

  const goals = runtime.listGoals({ sessionId: 'session-a', includeClosed: true });
  assert.equal(goals.goals.length, 1);
  const goalId = goals.goals[0].goalId;
  assert.equal(goals.goals[0].status, 'proposed');

  const baseRevision = goals.goals[0].revision;
  const accepted = runtime.transitionGoal({ sessionId: 'session-a', goalId, to: 'accepted', expectedRevision: baseRevision });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const started = runtime.transitionGoal({ sessionId: 'session-a', goalId, to: 'started', expectedRevision: baseRevision + 1 });
  assert.equal(started.ok, true, JSON.stringify(started));
  const stepped = runtime.recordGoalStep({ sessionId: 'session-a', goalId, step: '联系师傅', expectedRevision: baseRevision + 2 });
  assert.equal(stepped.ok, true, JSON.stringify(stepped));

  const injected = runtime.injectionFor({ sessionId: 'session-a', budgetChars: 320 });
  assert.ok(injected.text.length > 0);
  assert.ok(injected.text.length <= 320);
  assert.match(injected.text, /修屋顶/);

  const stopped = runtime.stop({ reason: 'test' });
  assert.equal(stopped.ok, true);
  const afterStop = runtime.proposeGoal({ sessionId: 'session-a', title: '停止后不应写入' });
  assert.equal(afterStop.ok, false);
  assert.equal(afterStop.code, 'runtime-stopped');
  assert.equal(runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals.length, 1);
  runtime.dispose();
});

test('A12: the runtime opens no outbound path and leaves the channel ledger untouched', t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  const ledger = path.join(root, 'home/channel-qq/contact.json');
  const before = fs.readFileSync(ledger, 'utf8');
  const runtime = mount(root);
  runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶' });
  runtime.recordEvent({ kind: 'state/impulse', sessionId: 'session-a', occurredAt: T0, payload: { amount: 0.2 } });
  runtime.observeSessionEvent({ sessionId: 'session-a', type: 'user/message', at: T0 + 1 });
  assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'the contact ledger is not written by the runtime');
  const forbidden = ['send', 'deliver', 'sendMessage', 'enqueueOutbound', 'submit'];
  for (const name of forbidden) assert.equal(typeof runtime[name], 'undefined', `runtime must not expose ${name}`);
  runtime.dispose();
});

test('stale revisions are rejected before any event is appended', t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  const runtime = mount(root);
  const created = runtime.proposeGoal({ sessionId: 'session-a', title: '整资料' });
  assert.equal(created.ok, true);
  const [goal] = runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals;
  const stale = runtime.transitionGoal({ sessionId: 'session-a', goalId: goal.goalId, to: 'paused', expectedRevision: goal.revision + 7 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-revision');
  const db = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM domain_events WHERE kind = 'goal/paused'").n, 0, 'no poisoned event in the log');
  db.close();
  runtime.dispose();
});

test('the runtime config file is read from disk and can be overridden', t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'shadow', injection: { budgetChars: 200 } } });
  const runtime = mount(root);
  assert.equal(runtime.mode, 'shadow');
  assert.equal(runtime.config.injection.budgetChars, 200);
  runtime.dispose();
});

test('B8: enabled:true with mode off still opens no database', t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'off' } });
  const runtime = mount(root);
  assert.equal(runtime.mode, 'off');
  assert.equal(fs.existsSync(path.join(root, 'home/companion/companion-runtime.db')), false, 'no database is created');
  const db = openRuntimeDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM runtime_lease').n, 0, 'no lease is taken');
  db.close();
  runtime.dispose();
});

test('B2: stop fences delivery and shadow proposals, not just event commits', async t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  const runtime = mount(root);
  runtime.requestMemoryIngest({ sessionId: 'session-a', content: '合成内容：停止之后不得投递', namespace: 'companion.event', realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed' });
  runtime.stop({ reason: 'test' });
  const drained = await runtime.drainOutbox({ sessionId: 'session-a' });
  assert.equal(drained.code, 'runtime-stopped', JSON.stringify(drained));
  const db = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'sent'").n, 0, 'nothing is marked delivered after stop');
  db.close();
  runtime.dispose();

  const shadowRoot = buildRoot(t, { config: { enabled: true, mode: 'shadow' } });
  const shadow = mount(shadowRoot);
  assert.equal(shadow.proposeGoal({ sessionId: 'session-a', title: '停止前' }).ok, true);
  const before = shadow.shadowProposals({ limit: 50 }).length;
  shadow.stop({ reason: 'test' });
  const rejected = shadow.proposeGoal({ sessionId: 'session-a', title: '停止后' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'runtime-stopped');
  assert.equal(shadow.shadowProposals({ limit: 50 }).length, before, 'no proposal is written after stop');
  shadow.dispose();
});

test('B2: a generation takeover during delivery fences the old writer', async t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const calls = [];
  const slowMemory = {
    version: 'slow',
    async ingestDomainEvent(request) {
      calls.push(request.eventId);
      if (calls.length === 1) {
        notifyStarted();
        await gate;
        return { status: 'accepted', receiptId: `rcpt-${request.eventId}` };
      }
      return { status: 'accepted', receiptId: `rcpt-${request.eventId}` };
    },
  };
  const first = mount(root, { memory: slowMemory });
  first.requestMemoryIngest({ sessionId: 'session-a', content: '合成内容：第一条', namespace: 'companion.event', realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed' });
  first.requestMemoryIngest({ sessionId: 'session-a', content: '合成内容：第二条', namespace: 'companion.event', realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed' });

  const pending = first.drainOutbox({ sessionId: 'session-a' });
  await started;
  // The takeover happens while the first delivery is in flight, exactly as in production.
  const later = mount(root, { now: () => T0 + 10 * 60 * 1000, memory: memoryStub() });
  assert.equal(later.writable, true, 'the later generation owns the lease');
  release();
  const drained = await pending;

  assert.equal(calls.length, 1, 'the fenced generation stops after the in-flight call; it does not send the next record');
  assert.equal(drained.delivered, 0, 'the fenced generation records no delivery');
  assert.equal(drained.skipped, 'writer-fenced', JSON.stringify(drained));
  assert.equal(drained.queued, 2, 'both records stay queued for the new generation');
  const db = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'sent'").n, 0);
  db.close();
  first.dispose();
  later.dispose();
});

test('B2: stopping mid-drain aborts the remaining records before they reach memory', async t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  const calls = [];
  let runtime;
  const memory = {
    version: 'stop-during-call',
    async ingestDomainEvent(request) {
      calls.push(request.eventId);
      runtime.stop({ reason: 'operator' });
      return { status: 'accepted', receiptId: `rcpt-${request.eventId}` };
    },
  };
  runtime = mount(root, { memory });
  runtime.requestMemoryIngest({ sessionId: 'session-a', content: '合成内容：一', namespace: 'companion.event', realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed' });
  runtime.requestMemoryIngest({ sessionId: 'session-a', content: '合成内容：二', namespace: 'companion.event', realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed' });
  const drained = await runtime.drainOutbox({ sessionId: 'session-a' });
  assert.equal(calls.length, 1, 'only the in-flight record reached memory');
  assert.equal(drained.skipped, 'writer-fenced');
  assert.equal(drained.delivered, 0);
  assert.equal(drained.queued, 2);
  const db = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'sent'").n, 0);
  db.close();
  runtime.dispose();
});

test('N3: the mounted runtime renews its lease so a long session is not taken over', t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  let clock = T0;
  const runtime = mountRuntime({ tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } }, root, {
    memory: memoryStub(), identity: identityStub(), now: () => clock,
  });
  assert.equal(runtime.writable, true);
  const dbFile = path.join(root, 'home/companion/companion-runtime.db');
  const db = openRuntimeDb({ file: dbFile, now: () => clock });
  const before = db.get('SELECT expires_at FROM runtime_lease').expires_at;
  clock += 60000;
  const renewed = runtime.heartbeat();
  assert.equal(renewed.ok, true, JSON.stringify(renewed));
  const after = db.get('SELECT expires_at, heartbeat_at FROM runtime_lease').expires_at;
  assert.ok(Number(after) > Number(before), `${after} should extend ${before}`);
  const status = runtime.status({ sessionId: 'session-a' });
  assert.equal(status.lease.state, 'held');
  db.close();
  runtime.dispose();
});

test('B3: the generic event API cannot bypass a goal revision fence or move focus', t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  const runtime = mount(root);
  runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶', nextStep: '联系师傅' });
  const [goal] = runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals;
  const before = runtime.status({ sessionId: 'session-a' });
  const focusBefore = runtime.workingMemory({ sessionId: 'session-a' }).focusGoalId;

  // The reviewer's first repro: goal/updated with no expectedRevision.
  const unfenced = runtime.recordEvent({ kind: 'goal/updated', sessionId: 'session-a', payload: { goalId: goal.goalId, nextStep: '被绕过' } });
  assert.equal(unfenced.ok, false, JSON.stringify(unfenced));
  assert.equal(unfenced.code, 'revision-required');
  // The reviewer's second repro: a stale acceptance must not move the focus.
  const stale = runtime.recordEvent({ kind: 'goal/accepted', sessionId: 'session-a', payload: { goalId: goal.goalId, expectedRevision: 999 } });
  assert.equal(stale.ok, false, JSON.stringify(stale));
  assert.equal(stale.code, 'stale-revision');

  const db = openRuntimeDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM domain_events').n, before.eventCount, 'refused events never enter the log');
  db.close();
  assert.equal(runtime.listGoals({ sessionId: 'session-a' }).goals[0].nextStep, '联系师傅', 'the refused update did not land');
  assert.equal(runtime.listGoals({ sessionId: 'session-a' }).goals[0].status, 'proposed');
  assert.equal(runtime.workingMemory({ sessionId: 'session-a' }).focusGoalId, focusBefore, 'the refused acceptance did not move focus');
  runtime.dispose();
});

test('N7: injection reports why it is short instead of a flat empty', t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  const runtime = mount(root);
  runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶', nextStep: '联系师傅' });
  const [goal] = runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals;
  runtime.transitionGoal({ sessionId: 'session-a', goalId: goal.goalId, to: 'accepted', expectedRevision: goal.revision });
  runtime.transitionGoal({ sessionId: 'session-a', goalId: goal.goalId, to: 'started', expectedRevision: goal.revision + 1 });
  for (let i = 0; i < 12; i += 1) {
    runtime.makeCommitment({ sessionId: 'session-a', text: `承诺 ${i}：周末要回她的消息`, dueAt: T0 + i * 3600000 });
  }
  const tiny = runtime.injectionFor({ sessionId: 'session-a', budgetChars: 20 });
  assert.equal(tiny.text, '');
  assert.equal(tiny.state, 'budget-too-small');
  const squeezed = runtime.injectionFor({ sessionId: 'session-a', budgetChars: 60 });
  assert.equal(squeezed.state, 'commitments-omitted');
  assert.ok(squeezed.text.length <= 60);
  assert.ok(squeezed.omittedCommitments > 0, JSON.stringify(squeezed));
  assert.match(squeezed.text, /另有\d+条承诺/);
  const stored = runtime.workingMemory({ sessionId: 'session-a' }).commitments;
  assert.equal(stored.length, 12, 'omitted from the prompt, still stored');
  runtime.dispose();
});

test('R3: two concurrent drains never hand the same queued record to memory twice', async t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const memory = {
    version: 'gated',
    async ingestDomainEvent(request) {
      calls.push(request.eventId);
      await gate;
      return { status: 'accepted', receiptId: `rcpt-${request.eventId}` };
    },
  };
  const runtime = mount(root, { memory });
  runtime.requestMemoryIngest({ sessionId: 'session-a', content: '合成内容：甲', namespace: 'companion.event', realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed' });
  runtime.requestMemoryIngest({ sessionId: 'session-a', content: '合成内容：乙', namespace: 'companion.event', realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed' });

  const first = runtime.drainOutbox({ sessionId: 'session-a' });
  const second = runtime.drainOutbox({ sessionId: 'session-a' });
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls.length, 2, `each record is delivered once, got ${calls.length} calls: ${calls.join(',')}`);
  assert.equal(new Set(calls).size, calls.length, 'no record is handed to memory twice');
  assert.equal(a.delivered + b.delivered, 2, JSON.stringify({ a, b }));
  const db = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'sent'").n, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM memory_outbox WHERE claim_owner <> ''").n, 0, 'claims are released on terminal rows');
  db.close();
  runtime.dispose();
});

// One failure-report scenario: the memory answer arrives after a stop or after another
// generation took the lease. Every combination must leave the row untouched.
async function fencedFailure(t, { fence, outcome, items }) {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  const dbFile = path.join(root, 'home/companion/companion-runtime.db');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  let runtime;
  // T1 (sixth review): the reviewer's independent probe also checked the memory call
  // count and that the whole claim row survives the fenced write. Read the rows through
  // a second handle at the instant the failing answer is produced — that is the state the
  // fenced write is not allowed to touch (the drain already committed its claim by then).
  const readRows = () => {
    const reader = createDb({ file: dbFile, now: () => T0, pragmas: false });
    try {
      return reader.all('SELECT outbox_id, status, attempts, last_error, claim_owner, claimed_until, updated_at FROM memory_outbox ORDER BY outbox_id');
    } finally { reader.close(); }
  };
  let claimedAtFailure = null;
  const memory = {
    version: `fence-${fence}-${outcome}`,
    calls: [],
    async ingestDomainEvent() {
      this.calls.push(`call-${this.calls.length + 1}`);
      if (claimedAtFailure === null) claimedAtFailure = readRows();
      if (fence === 'takeover') { started(); await gate; } else { runtime.stop({ reason: 'operator' }); }
      if (outcome === 'throw') throw Object.assign(new Error('memory hiccup'), { code: 'memory-unavailable' });
      if (outcome === 'null') return null;
      return { status: 'retryable_failure', reason: 'busy' };
    },
  };
  runtime = mount(root, { memory });
  for (let index = 0; index < items; index += 1) {
    runtime.requestMemoryIngest({
      sessionId: 'session-a', content: `合成内容：围栏-${fence}-${outcome}-${index}`,
      namespace: 'companion.event', realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed',
    });
  }
  const pending = runtime.drainOutbox({ sessionId: 'session-a' });
  let later = null;
  if (fence === 'takeover') {
    await startedPromise;
    later = mount(root, { now: () => T0 + 10 * 60 * 1000, memory: memoryStub() });
    assert.equal(later.writable, true, 'the later generation owns the lease');
    release();
  }
  const drained = await pending;
  const label = `${fence}/${outcome}/${items} item(s)`;
  assert.equal(drained.retryable, 0, `${label}: a fenced failure is not counted`);
  assert.equal(drained.delivered, 0, label);
  assert.equal(drained.skipped, 'writer-fenced', `${label}: ${JSON.stringify(drained)}`);
  assert.equal(memory.calls.length, 1, `${label}: memory is called exactly once, the second queued record never reaches it`);
  const db = createDb({ file: dbFile, now: () => T0 });
  const rows = db.all('SELECT status, attempts, last_error, claim_owner FROM memory_outbox ORDER BY outbox_id');
  const afterRows = db.all('SELECT outbox_id, status, attempts, last_error, claim_owner, claimed_until, updated_at FROM memory_outbox ORDER BY outbox_id');
  assert.equal(rows.length, items);
  for (const row of rows) {
    assert.equal(row.status, 'queued', `${label}: the row stays queued`);
    assert.equal(row.attempts, 0, `${label}: no attempt is recorded after the fence`);
    assert.equal(row.last_error, '', `${label}: no failure code is written`);
  }
  assert.equal(claimedAtFailure.length, items, `${label}: the claim snapshot covers every queued row`);
  for (let index = 0; index < afterRows.length; index += 1) {
    const before = claimedAtFailure[index];
    const after = afterRows[index];
    assert.equal(after.outbox_id, before.outbox_id);
    assert.equal(after.claim_owner, before.claim_owner, `${label}: the fenced failure neither steals nor clears the claim owner`);
    assert.ok(before.claim_owner !== '', `${label}: the row really was claimed by the drain that failed`);
    assert.equal(Number(after.claimed_until), Number(before.claimed_until), `${label}: the claim deadline is untouched`);
    assert.equal(Number(after.updated_at), Number(before.updated_at), `${label}: the failure does not bump updated_at`);
    assert.equal(Number(after.attempts), Number(before.attempts), `${label}: attempts is untouched`);
    assert.equal(after.last_error, before.last_error, `${label}: last_error is untouched`);
  }
  db.close();
  if (later) later.dispose();
  runtime.dispose();
}

test('B2: every failure report is fenced after stop (3 outcomes × single/multi queue)', async t => {
  for (const outcome of ['retryable', 'null', 'throw']) {
    for (const items of [1, 2]) await fencedFailure(t, { fence: 'stop', outcome, items });
  }
});

test('B2: every failure report is fenced after a generation takeover (3 outcomes × single/multi queue)', async t => {
  for (const outcome of ['retryable', 'null', 'throw']) {
    for (const items of [1, 2]) await fencedFailure(t, { fence: 'takeover', outcome, items });
  }
});

test('A12: cross-scope reads never leak (identity determines scope, session does not)', t => {
  const root = buildRoot(t, { config: { enabled: true, mode: 'active' } });
  const runtime = mount(root);
  runtime.proposeGoal({ sessionId: 'session-a', title: 'A 的目标' });
  const otherIdentity = { resolve: sessionId => ({ userId: 'owner-2', persona: 'bot', sessionId }) };
  const otherScope = runtime.listGoals({ binding: otherIdentity.resolve('session-x') });
  assert.equal(otherScope.goals.length, 0);
  const own = runtime.listGoals({ sessionId: 'session-a' });
  assert.equal(own.goals.length, 1);
  const db = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  const scopes = db.all('SELECT scope, COUNT(*) AS n FROM goals GROUP BY scope');
  assert.equal(scopes.length, 1);
  assert.ok(scopes.every(row => row.scope.startsWith('u:owner-1|')));
  db.close();
  runtime.dispose();
});
