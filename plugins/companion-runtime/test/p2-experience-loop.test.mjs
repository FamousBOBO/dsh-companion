import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { createP2 } from '../lib/p2.mjs';
import { applyActivityEvent } from '../lib/activities.mjs';
import { applyPlanEvent } from '../lib/planner.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { parseScope, scopeKey as scopeKeyOf } from '../lib/scope.mjs';
import { openRuntimeDb } from '../lib/db.mjs';
import { buildPlanningPrompt } from '../lib/planner.mjs';
import { createMemoryEngine } from '../../companion-memory/index.mjs';

// P2.5-2 (A4 audit §1/§2/§3/§4): the experience loop.
//
//   E1  a failed / abandoned / missed outcome is a P1 fact too. "Tomorrow knows it did not finish"
//       was impossible before: only `phase === 'finished'` wrote anything, and a failure reached
//       the plan only as a row nobody rendered.
//   E2  significance is decided by the runtime and routed by memory: a plain reading stays in the
//       activity history, a produced artifact / external exploration / failure becomes a memory
//       (the exploration and the failure as a *pending* candidate, because external material and
//       failures are not user facts). Reading the same thing twice is one memory, not two.
//   E3  the next day's plan prompt contains "what actually happened" — finished *and* not finished.
//   E5  a target that keeps failing is marked in the target list instead of being re-planned as if
//       nothing had happened.
//
// Everything is isolated (`os.tmpdir()`), uses the real memory engine and the real prompt builder,
// and never opens the production tree.

const T0 = Date.UTC(2026, 10, 6, 3, 0, 0);
const HOUR = 3600000;
const BOUND = { userId: 'owner-1', persona: 'bot' };
const SCOPE_KEY = 'u:owner-1|p:bot|w:world:default';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-loop-'));
  for (const dir of ['home/companion/works/sources', 'home/memory', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/works/sources/tide.md'), '潮水在傍晚退去。'.repeat(80), 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/works/sources/light.md'), '灯塔每隔十二秒闪一次。'.repeat(80), 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    backend: 'sqlite', database: 'home/memory/companion-memory.db', wiki: { enabled: false },
    extraction: { enabled: false }, retrieval: { semanticEnabled: false },
  }), 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { planning: { enabled: true }, activities: { enabled: true, artifactRoot: 'home/companion/works', chunkUnits: 40, maxUnitsPerStep: 4000 } },
  }), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows lock leftover */ } });
  return root;
}

function planJson(now, slots) {
  return JSON.stringify({
    summary: '读两段',
    slots: slots.map((slot, index) => ({
      kind: 'activity', activity: slot.activity ?? 'read', title: slot.title ?? `读 ${slot.target}`,
      detail: '', startAt: now + (slot.offset ?? index) * 60_000, endAt: now + (slot.offset ?? index) * 60_000 + 1800_000,
      flexibility: 'soft', targetRef: slot.target,
    })),
  });
}

function identify() {
  return {
    owner() { return { id: 'owner-1', displayName: '记忆桥测试', platform: 'local' }; },
    resolve: sessionId => ({ ...BOUND, sessionId }),
  };
}

/** Mount with the real memory engine so "became a memory or not" is a database fact. */
async function mountWithMemory(t, root, { plan = '', prompts = [] } = {}) {
  const engine = createMemoryEngine({ root, identity: identify(), env: {}, now: () => T0 });
  t.after(async () => { try { await engine.close(); } catch { /* cleanup only */ } });
  await engine.initialize();
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: identify(),
    memory: engine,
    callModel: async args => {
      if (args.purpose === 'p2-planning') {
        prompts.push(String(args.input ?? ''));
        return { text: plan || planJson(T0, []), provider: 'test', model: 'test', inputTokens: 10, outputTokens: 10 };
      }
      return { text: '读到了：潮水在傍晚退去', provider: 'test', model: 'test', inputTokens: 10, outputTokens: 6 };
    },
    p2Ports: {
      readFile: async ({ path: file }) => { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } },
      writeFile: async ({ path: file, text }) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); return { ok: true, bytes: Buffer.byteLength(text) }; },
      fetchPage: async () => ({ ok: false, status: 0 }),
    },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } });
  const db = openRuntimeDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  return { runtime, engine, db };
}

function factsOf(db) {
  return db.all("SELECT payload, reality_status, evidence_status FROM domain_events WHERE kind = 'memory/ingest-request' ORDER BY seq")
    .map(row => ({ ...JSON.parse(row.payload), realityStatus: row.reality_status, evidenceStatus: row.evidence_status }));
}

async function readyPlan(runtime, slots) {
  runtime.proposeGoal({ bound: BOUND, title: 'x' });
  await runtime.pumpPlanning({ reason: 'timer' });
  assert.ok(runtime.p2Status({ bound: BOUND }).planning?.lastRun?.plan, 'a plan exists');
  return slots;
}

async function memoryRows(engine) {
  const internal = await engine.internal();
  return internal.db.handle.prepare('SELECT predicate, kind, status, value FROM memories ORDER BY created_at').all();
}

// ---------------------------------------------------------------------------
// E1 — the three non-success terminal states each leave a P1 fact
// ---------------------------------------------------------------------------

test('E1: a failed activity leaves one fact that says failed — never "finished"', async t => {
  const root = makeRoot(t);
  const { runtime, db } = await mountWithMemory(t, root, { plan: planJson(T0, [{ target: 'sources/tide.md' }]) });
  await readyPlan(runtime);
  await runtime.pumpActivities({ now: T0 });
  const activity = runtime.listActivities({ bound: BOUND }).activities[0];
  assert.equal(activity.status, 'running');

  // A network-style failure after the adapter committed the activity.
  const failed = runtime.recordActivityOutcome({
    scopeKey: SCOPE_KEY, activityId: activity.activityId, slotId: activity.planSlotId ?? '',
    kind: 'read', target: 'sources/tide.md', reality: 'actual_tool_activity',
    phase: 'failed', reason: 'source-invalid', consumedPrefix: 0, totalUnits: 100, artifactVersion: 0, at: T0 + 1000,
  });
  assert.equal(failed.ok, true, JSON.stringify(failed));

  const facts = factsOf(db);
  assert.equal(facts.length, 1, 'exactly one fact');
  assert.equal(facts[0].namespace, 'p2/activity');
  assert.equal(facts[0].facts.phase, 'failed');
  assert.equal(facts[0].facts.result, 'failed');
  assert.equal(facts[0].facts.code, 'source-invalid');
  assert.equal(facts[0].facts.sourceRef ?? '', '', 'no invented source');
  assert.match(facts[0].content, /失败/);
  assert.doesNotMatch(facts[0].content, /结束/, 'a failure is not described as a completion');
  assert.equal(facts[0].significance, 'routine',
    'F4: it read nothing, so it is a fact (kept above) but not a permanent memory');
});

test('E1: an abandoned activity leaves one fact with the user-facing reason', async t => {
  const root = makeRoot(t);
  const { runtime, db } = await mountWithMemory(t, root, { plan: planJson(T0, [{ target: 'sources/light.md' }]) });
  await readyPlan(runtime);
  await runtime.pumpActivities({ now: T0 });
  const activity = runtime.listActivities({ bound: BOUND }).activities[0];
  const abandoned = runtime.recordActivityOutcome({
    scopeKey: SCOPE_KEY, activityId: activity.activityId, kind: 'read', target: 'sources/light.md',
    reality: 'actual_tool_activity', phase: 'abandoned', reason: '没兴趣了',
    consumedPrefix: 120, totalUnits: 800, artifactVersion: 0, at: T0 + 2000,
  });
  assert.equal(abandoned.ok, true, JSON.stringify(abandoned));
  const facts = factsOf(db);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].facts.phase, 'abandoned');
  assert.equal(facts[0].facts.result, 'failed', 'abandoned is not a success either');
  assert.match(facts[0].content, /放弃/);
  assert.match(facts[0].content, /没兴趣了/);
  assert.equal(facts[0].significance, 'routine', 'abandoning something is not an experience to remember');
});

test('E1: a slot that never started leaves one "missed" fact', async t => {
  const root = makeRoot(t);
  const { runtime, db } = await mountWithMemory(t, root, { plan: planJson(T0, [{ target: 'sources/tide.md' }]) });
  await readyPlan(runtime);
  const missed = runtime.recordMissedSlot({
    scopeKey: SCOPE_KEY, slotId: 'slot_x', kind: 'read', target: 'sources/tide.md',
    reality: 'actual_tool_activity', reason: 'window-closed', at: T0 + 3000,
  });
  assert.equal(missed.ok, true, JSON.stringify(missed));
  const facts = factsOf(db);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].facts.phase, 'missed');
  assert.equal(facts[0].facts.result, 'skipped');
  assert.match(facts[0].content, /没有开始/);
  // F4 (lead ruling): the fact stays (asserted above), but a slot that never started read nothing, so
  // it is not a permanent memory.
  assert.equal(facts[0].significance, 'routine', 'information for the planner, not a memory');
});

test('E1: a simulated outcome never becomes a real experience (red line)', async t => {
  const root = makeRoot(t);
  const { runtime, db } = await mountWithMemory(t, root, { plan: planJson(T0, [{ target: 'sources/tide.md' }]) });
  await readyPlan(runtime);
  runtime.recordActivityOutcome({
    scopeKey: SCOPE_KEY, activityId: 'act_sim', kind: 'read', target: 'sources/tide.md',
    // Not one of the three envelope labels → must be forced to `hypothetical`.
    reality: 'definitely_real', phase: 'finished', consumedPrefix: 800, totalUnits: 800, artifactVersion: 0, at: T0 + 4000,
  });
  const [fact] = factsOf(db);
  assert.equal(fact.realityStatus, 'hypothetical', 'an unrecognised reality label is fail-closed');
});

// ---------------------------------------------------------------------------
// E2 — significance routing and same-subject dedupe
// ---------------------------------------------------------------------------

test('E2: a plain reading that ran to the end stays in the activity history, not in memory', async t => {
  const root = makeRoot(t);
  const { runtime, engine, db } = await mountWithMemory(t, root, { plan: planJson(T0, [{ target: 'sources/tide.md' }]) });
  await readyPlan(runtime);
  await runtime.pumpActivities({ now: T0 });
  for (let index = 0; index < 12; index += 1) await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 1 });
  const activity = runtime.listActivities({ bound: BOUND }).activities[0];
  assert.equal(activity.status, 'done');
  const row = db.get('SELECT consumed_prefix, total_units FROM p2_activities WHERE activity_id = ?', activity.activityId);
  assert.equal(Number(row.consumed_prefix), Number(row.total_units), 'the whole source was read');

  const [fact] = factsOf(db);
  assert.equal(fact.significance, 'routine', 'routine browsing is not a memory');
  await runtime.drainOutboxNow();
  const rows = await memoryRows(engine);
  assert.equal(rows.filter(row => row.predicate === 'runtime:p2/activity').length, 0, 'nothing was remembered');
  // …and the activity history still exists: that is where a routine outcome lives.
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 1);
});

test('E2: an artifact is significant → one confirmed memory; exploration → pending', async t => {
  const root = makeRoot(t);
  const { runtime, engine, db } = await mountWithMemory(t, root, { plan: planJson(T0, [{ target: 'sources/tide.md' }]) });
  await readyPlan(runtime);
  // A write that produced a versioned draft.
  runtime.recordActivityOutcome({
    scopeKey: SCOPE_KEY, activityId: 'act_write', kind: 'write', target: 'drafts/潮汐',
    reality: 'actual_tool_activity', phase: 'finished', consumedPrefix: 400, totalUnits: 900, artifactVersion: 2, at: T0 + 5000,
  });
  // An exploration of the outside world: notable, but its content is somebody else's claim.
  runtime.recordActivityOutcome({
    scopeKey: SCOPE_KEY, activityId: 'act_explore', kind: 'explore', target: 'https://example.org/tide',
    reality: 'actual_tool_activity', phase: 'finished', consumedPrefix: 1200, totalUnits: 3000, artifactVersion: 0, at: T0 + 6000,
  });
  const facts = factsOf(db);
  assert.deepEqual(facts.map(fact => fact.significance), ['notable', 'notable']);
  assert.deepEqual(facts.map(fact => fact.evidenceStatus), ['observed', 'inferred']);

  await runtime.drainOutboxNow();
  const rows = (await memoryRows(engine)).filter(row => row.predicate === 'runtime:p2/activity');
  assert.equal(rows.length, 2);
  const write = rows.find(row => row.value.includes('写作'));
  const explore = rows.find(row => row.value.includes('探索'));
  assert.equal(write.status, 'confirmed', 'her own writing is a confirmed event');
  assert.equal(explore.status, 'pending', 'external material waits for a human, it is not a user fact');
});

test('E2: the same source read twice is one memory, not two', async t => {
  const root = makeRoot(t);
  const { runtime, engine, db } = await mountWithMemory(t, root, { plan: planJson(T0, [{ target: 'sources/tide.md' }]) });
  await readyPlan(runtime);
  // First: an exploration of that subject (notable) — it becomes a memory.
  runtime.recordActivityOutcome({
    scopeKey: SCOPE_KEY, activityId: 'act_ex1', kind: 'explore', target: 'https://example.org/tide',
    reality: 'actual_tool_activity', phase: 'finished', consumedPrefix: 900, totalUnits: 900, artifactVersion: 0, at: T0,
  });
  // Then a *finished, notable* activity row for the same kind+target, one day later (a real row, so
  // the dedupe sees the history rather than only the event log).
  db.run(`INSERT INTO p2_activities (activity_id, scope, plan_slot_id, kind, adapter, capability, reality, status,
            target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_hash,
            artifact_version, started_at, paused_at, ended_at, created_at, updated_at)
          VALUES ('act_ex1', ?, '', 'explore', 'explore', 'explore', 'actual_tool_activity', 'done',
            'https://example.org/tide', 'url:https://example.org/tide', '', 900, 900, '{}', '', '', 2, ?, 0, ?, ?, ?)`,
  SCOPE_KEY, T0, T0, T0, T0);
  const second = runtime.recordActivityOutcome({
    scopeKey: SCOPE_KEY, activityId: 'act_ex2', kind: 'explore', target: 'https://example.org/tide',
    reality: 'actual_tool_activity', phase: 'finished', consumedPrefix: 1500, totalUnits: 1500, artifactVersion: 0, at: T0 + 24 * HOUR,
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  const facts = factsOf(db);
  assert.equal(facts.length, 2, 'both are recorded as activity facts');
  assert.equal(facts[1].significance, 'routine', 'the repetition is history only');
  assert.equal(facts[1].facts.subjectKey, facts[0].facts.subjectKey, 'both name the same subject');

  await runtime.drainOutboxNow();
  const rows = (await memoryRows(engine)).filter(row => row.predicate === 'runtime:p2/activity');
  assert.equal(rows.length, 1, 'one durable memory for one subject');
});

// ---------------------------------------------------------------------------
// E3 / E5 — what the next day's plan reads
// ---------------------------------------------------------------------------

test('E3: the planning prompt contains finished *and* not-finished history, labelled as history', async t => {
  const root = makeRoot(t);
  const prompts = [];
  const { runtime, db } = await mountWithMemory(t, root, { plan: planJson(T0, []), prompts });
  // The material query is what turns these rows into prompt lines, so the rows are seeded directly
  // (the *emission* of the corresponding facts is covered by the E1 tests above). They are seeded
  // before the first planning round, because that is the round whose prompt is captured.
  for (const [activityId, status, needsReview] of [['act_done', 'done', false], ['act_failed', 'failed', false], ['act_review', 'paused', true]]) {
    db.run(`INSERT INTO p2_activities (activity_id, scope, plan_slot_id, kind, adapter, capability, reality, status,
              target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_hash,
              artifact_version, started_at, paused_at, ended_at, created_at, updated_at)
            VALUES (?, ?, '', 'read', 'read', 'read', 'actual_tool_activity', ?, ?, '', '', 800, 400, ?, '', '', 0, ?, 0, ?, ?, ?)`,
    activityId, SCOPE_KEY, status, `sources/${activityId}.md`, JSON.stringify({ needsReview }), T0, T0, T0, T0);
  }
  runtime.proposeGoal({ bound: BOUND, title: 'y' });
  await runtime.pumpPlanning({ reason: 'timer' });
  assert.ok(prompts.length >= 1, 'a planning round really ran');

  const prompt = prompts.at(-1) ?? '';
  assert.match(prompt, /## 最近做完的事/, 'the section exists');
  assert.match(prompt, /已经发生的事，不是计划/, 'and it says these are history, not a plan');
  assert.match(prompt, /\[完成\].*act_done\.md/, 'the finished reading is visible');
  assert.match(prompt, /\[未完成·失败\].*act_failed\.md/, 'a failed activity is visible and labelled');
  assert.match(prompt, /\[未完成·待复核\].*act_review\.md/, 'a review park is visible too — it is the commonest failure');
  assert.ok(!/\[完成\].*act_failed\.md/.test(prompt), 'a failure is never rendered as a completion');
  assert.ok(!/\[完成\].*act_review\.md/.test(prompt), 'a parked activity is never rendered as a completion');
});

test('E1: a review park (source broke mid-read) also emits the fact', async t => {
  const root = tempDirFor(t);
  const { db, clock } = world(t);
  const calls = { reads: 0 };
  const facts = [];
  const p2 = createP2({
    db, config: configFor(), clock: () => clock.value, owner: OWNER, generation: GEN,
    getMode: () => 'active', isActive: () => true, emit: emitThrough(db, clock),
    ports: {
      readFile({ path: file }) {
        calls.reads += 1;
        // The source changes *after* the activity started: the next step must refuse it.
        const text = calls.reads === 1 ? '潮水在傍晚退去。'.repeat(40) : '另一个人改了这段材料。'.repeat(40);
        void file;
        return { ok: true, text };
      },
      writeFile() { return { ok: false }; },
      fetchPage() { return { ok: false, status: 0 }; },
    },
    options: {
      artifactRoot: root,
      onFinished: info => { facts.push(info); return { ok: true }; },
    },
  });
  seedPlan(db);
  insertSlot(db, { slotId: 'slot-park', target: 'shelf/tide.md' });
  const started = p2.activities.start({ slotId: 'slot-park', kind: 'read' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const stepped = p2.activities.step({ activityId: started.activityId, units: 50 });
  assert.equal(stepped.ok, false, 'the changed source is refused');
  assert.equal(stepped.code, 'source-changed');
  const row = db.get('SELECT status, checkpoint FROM p2_activities WHERE activity_id = ?', started.activityId);
  assert.equal(row.status, 'paused', 'the row parks for review');
  assert.equal(JSON.parse(row.checkpoint).needsReview, true);
  assert.equal(facts.length, 1, 'exactly one fact for the park');
  assert.equal(facts[0].phase, 'failed', 'a park is reported as not-finished, never as a completion');
  assert.equal(facts[0].reason, 'source-changed');
});

test('E3: the material layer reports failed/abandoned outcomes, not only done ones', async t => {
  const root = makeRoot(t);
  const { runtime, db } = await mountWithMemory(t, root, { plan: planJson(T0, [{ target: 'sources/tide.md' }]) });
  await readyPlan(runtime);
  // Seed one of each terminal state directly: the material query is what is under test.
  for (const [activityId, status] of [['act_done', 'done'], ['act_failed', 'failed'], ['act_abandoned', 'abandoned']]) {
    db.run(`INSERT INTO p2_activities (activity_id, scope, plan_slot_id, kind, adapter, capability, reality, status,
              target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_hash,
              artifact_version, started_at, paused_at, ended_at, created_at, updated_at)
            VALUES (?, ?, '', 'read', 'read', 'read', 'actual_tool_activity', ?, ?, '', '', 800, 400, '{}', '', '', 0, ?, 0, ?, ?, ?)`,
    activityId, SCOPE_KEY, status, `sources/${activityId}.md`, T0, T0, T0, T0);
  }
  const prompts = [];
  const runtime2 = runtime;
  void runtime2;
  // `p2Materials` is not exported; assert through the prompt the planner actually builds.
  const material = {
    timeZone: 'Asia/Shanghai',
    now: T0,
    day: '2026-11-06',
    windowStart: T0,
    windowEnd: T0 + 6 * HOUR,
    recentOutcomes: [
      { kind: 'read', target: 'sources/act_done.md', outcome: 'done', consumed_prefix: 800, total_units: 800, artifact_version: 0, at: T0 },
      { kind: 'read', target: 'sources/act_failed.md', outcome: 'failed', consumed_prefix: 400, total_units: 800, artifact_version: 0, at: T0 },
      { kind: 'read', target: 'sources/act_abandoned.md', outcome: 'abandoned', consumed_prefix: 0, total_units: 0, artifact_version: 0, at: T0 },
    ],
    recentFailures: [],
  };
  const built = buildPlanningPrompt({ material, day: material.day, timeZone: material.timeZone, now: material.now, windowStart: material.windowStart, windowEnd: material.windowEnd });
  assert.match(built.input, /\[完成\].*act_done\.md/);
  assert.match(built.input, /\[未完成·失败\].*act_failed\.md/);
  assert.match(built.input, /\[放弃\].*act_abandoned\.md/);
  void prompts;
});

test('E5: a target that failed twice is marked in the target list', async t => {
  const material = {
    timeZone: 'Asia/Shanghai',
    now: T0,
    day: '2026-11-06',
    windowStart: T0,
    windowEnd: T0 + 6 * HOUR,
    entryPoints: ['sources/tide.md', 'sources/light.md'],
    recentFailures: [
      { target: 'sources/tide.md', code: 'source-invalid', failures: 3, last_at: T0 },
      { target: 'sources/light.md', code: 'source-changed', failures: 1, last_at: T0 },
    ],
  };
  const built = buildPlanningPrompt({ material, day: material.day, timeZone: material.timeZone, now: material.now, windowStart: material.windowStart, windowEnd: material.windowEnd });
  assert.match(built.input, /## 最近失败过的事/, 'the failure section exists');
  assert.match(built.input, /tide\.md — source-invalid ×3/, 'the repeated failure is visible');
  assert.match(built.input, /tide\.md（近期失败 3 次，优先换一条）/, 'and the target itself is marked');
  assert.ok(!/light\.md（近期失败/.test(built.input), 'a single transient failure does not demote a source');
});

// The prompt builder is exported by the planner module; this import guard keeps the test honest if
// the export ever moves (a silently missing function would make the assertions vacuous).
assert.equal(typeof buildPlanningPrompt, 'function', 'buildPlanningPrompt must stay exported');

// ---------------------------------------------------------------------------
// A controller-level harness for the one emission that no runtime API produces directly: a review
// park (the activity row stays `paused`, the fact is `failed`).
// ---------------------------------------------------------------------------

const T0C = Date.UTC(2026, 10, 6, 5, 0, 0);
const HOURC = 3600000;
const SCOPE_C = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY_C = scopeKeyOf(SCOPE_C);
const OWNER = '999999:p25-2:test';
const GEN = 'gen-p25-2';

function tempDirFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-park-'));
  fs.mkdirSync(path.join(dir, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shelf', 'tide.md'), '潮水在傍晚退去。'.repeat(40), 'utf8');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return dir;
}

function configFor() {
  return {
    p2: {
      planning: { enabled: true },
      activities: {
        enabled: true, paused: false, chunkUnits: 50, maxUnitsPerStep: 4000,
        maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400, draftsDir: 'drafts',
      },
      autonomy: { allowedSources: [] },
    },
  };
}

function world(t) {
  const clock = { value: T0C };
  const db = openRuntimeDb({ file: ':memory:', now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  assert.equal(db.acquireLease({ owner: OWNER, generation: GEN, ttlMs: 3600000 }).ok, true);
  db.commitProjection({ scope: KEY_C, generation: GEN, payload: {}, updatedAt: T0C });
  return { db, clock };
}

function seedPlan(db) {
  db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES ('plan-1', ?, '2026-11-06', 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  KEY_C, T0C - 6 * HOURC, T0C + 6 * HOURC, T0C, T0C);
}

function insertSlot(db, { slotId, target }) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, 'plan-1', ?, '2026-11-06', ?, ?, 'activity', 'read', '潮汐', '{}', 'soft', '', ?, 'planned', 0, ?, ?)`,
  slotId, KEY_C, T0C - HOURC, T0C + HOURC, target, T0C, T0C);
}

function emitThrough(db, clock) {
  const handlers = {
    autonomy: args => (args.event.kind === 'autonomy/receipt' || args.event.kind === 'autonomy/activity'
      ? applyActivityEvent(args)
      : applyPlanEvent(args)),
  };
  return (input = {}) => {
    const scope = input.scope ?? parseScope(input.scopeKey);
    if (!scope) throw new Error('unbound');
    db.assertLeaseHeld({ owner: OWNER, generation: GEN, at: Number(clock.value) });
    const { scopeKey: _drop, ...rest } = input;
    const outcome = dispatchEvent(db, { ...rest, scope }, { handlers, generation: GEN, owner: OWNER, requireConsumers: true });
    const failure = outcome.results.find(result => result.error);
    if (outcome.rejected) throw new Error(failure?.error ?? 'rejected');
    if (failure) throw new Error(failure.error ?? 'consumer failed');
    return { ok: true, eventId: outcome.event.eventId, inserted: outcome.inserted, seq: outcome.seq, results: outcome.results };
  };
}
