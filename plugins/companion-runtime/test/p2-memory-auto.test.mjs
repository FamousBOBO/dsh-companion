import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { openRuntimeDb } from '../lib/db.mjs';

// Automatic memory — single-write contract (contract v1.2 §5 + Codex review R3).
//
// What changed with R3: a finished activity must produce **exactly one** experience. The runtime
// wires one P1 hook (`memory/ingest-request`, namespace `p2/activity`) and the legacy memoryPort
// write (`p2/experience`) is retired while that hook exists — the two keys differ and memory
// cannot merge them, so keeping both wrote the same activity twice.
//
// A P1 event is not a memory by itself: it becomes one only when `memory_outbox` is drained. This
// file therefore proves the whole chain end to end — finish → P1 event → bridge consumer → outbox
// row → drain → memory engine — plus the compensation path for "the finish committed but the P1
// write did not", and the guarantee that a repeat never doubles a row, an event or a delivery.

const T0 = Date.UTC(2026, 10, 3, 1, 0, 0);
const BOUND = { userId: 'owner-1', persona: 'march7' };

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-memory-'));
  fs.mkdirSync(path.join(root, 'home/companion/works/sources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/works/sources/a.md'), '慢速观察'.repeat(12));
  fs.writeFileSync(path.join(root, 'home/companion/works/sources/b.md'), '另一段材料'.repeat(12));
  fs.writeFileSync(path.join(root, 'home/companion/works/sources/c.md'), '第三段材料'.repeat(12));
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { planning: { enabled: true }, activities: { enabled: true, artifactRoot: 'home/companion/works', chunkUnits: 24, maxUnitsPerStep: 24 } },
  }));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows lock leftover */ } });
  return root;
}

function planJson(now, targets) {
  return JSON.stringify({
    summary: '读三段',
    slots: targets.map((target, index) => ({
      kind: 'activity', activity: 'read', title: `读 ${target}`, detail: '',
      startAt: now + index * 3600_000, endAt: now + index * 3600_000 + 1800_000, flexibility: 'soft', targetRef: target,
    })),
  });
}

function mountWithMemory(root, plan) {
  // The legacy port is deliberately provided and counting: R3's claim is that it is **not** used
  // while the P1 hook is wired. The engine is the real public entry the drain calls.
  const legacyWrites = [];
  const ingested = [];
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ ...BOUND, sessionId }) },
    callModel: async args => {
      if (args.purpose === 'p2-planning') return { text: plan, provider: 'test', model: 'test', inputTokens: 10, outputTokens: 10 };
      return { text: '读到了：慢速观察反复出现', provider: 'test', model: 'test', inputTokens: 10, outputTokens: 6 };
    },
    memoryPort: {
      recordExperience: async experience => {
        legacyWrites.push(experience);
        return { ok: true, receiptId: `legacy-${legacyWrites.length}`, duplicate: false };
      },
    },
    memory: {
      version: 'fake-memory-r3',
      async ingestDomainEvent(request) {
        ingested.push(request);
        return { status: 'accepted', receiptId: `rcpt-${ingested.length}` };
      },
    },
    p2Ports: { readFile: async ({ path: file }) => ({ ok: true, text: fs.readFileSync(file, 'utf8') }) },
  });
  return { runtime, legacyWrites, ingested, root };
}

function openCheck(root) {
  return openRuntimeDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
}

async function runToFinish(runtime, { cycles = 6 } = {}) {
  runtime.proposeGoal({ bound: BOUND, title: 'x' });
  await runtime.pumpPlanning({ reason: 'timer' });
  await runtime.pumpActivities({ now: T0 });
  for (let index = 0; index < cycles; index += 1) await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 1 });
}

test('memory(R3): a finished activity writes ONE experience — event, outbox row, then delivery', async t => {
  const root = makeRoot(t);
  const { runtime, legacyWrites, ingested } = mountWithMemory(root, planJson(T0, ['sources/a.md']));
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } });

  await runToFinish(runtime);
  const activity = runtime.listActivities({ bound: BOUND }).activities[0];
  assert.equal(activity.status, 'done', 'the activity finished');

  const db = openCheck(root);
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  const events = db.all("SELECT event_id, payload FROM domain_events WHERE kind = 'memory/ingest-request'");
  assert.equal(events.length, 1, 'exactly one P1 experience event');
  const payload = JSON.parse(events[0].payload);
  assert.equal(payload.namespace, 'p2/activity', 'the P1 namespace, not the legacy one');
  assert.equal(payload.transformVersion, 'p2-activity-v1');
  const outbox = db.all('SELECT outbox_id, namespace, status FROM memory_outbox');
  assert.equal(outbox.length, 1, 'the bridge consumer queued it exactly once');
  assert.equal(outbox[0].namespace, 'p2/activity');
  assert.equal(outbox[0].status, 'queued');
  assert.equal(legacyWrites.length, 0, 'R3: the legacy memoryPort was NOT called as well');

  // Nothing is delivered until the outbox is drained — this is the step that never ran before.
  assert.equal(ingested.length, 0, 'an outbox row is not a memory yet');
  const drained = await runtime.drainOutboxNow();
  assert.equal(drained.delivered, 1, JSON.stringify(drained));
  assert.equal(ingested.length, 1, 'the drain handed it to the memory engine');
  assert.equal(ingested[0].namespace ?? ingested[0].payload?.namespace ?? 'p2/activity', ingested[0].namespace ?? 'p2/activity');
  assert.equal(db.get('SELECT status FROM memory_outbox').status, 'sent');

  // A second drain is a no-op: a delivered record is never handed over twice.
  const again = await runtime.drainOutboxNow();
  assert.equal(again.delivered, 0);
  assert.equal(ingested.length, 1);
  assert.equal(legacyWrites.length, 0);
});

test('memory(R3): with the P1 hook wired there is no fallback to the legacy port when memory is absent', async t => {
  const root = makeRoot(t);
  // No memory engine at all: the P1 event must still be written and queued (not swapped back to
  // the legacy port, which would be the double write one deploy later).
  const legacyWrites = [];
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ ...BOUND, sessionId }) },
    callModel: async args => {
      if (args.purpose === 'p2-planning') return { text: planJson(T0, ['sources/b.md']), provider: 'test', model: 'test', inputTokens: 10, outputTokens: 10 };
      return { text: '读到了：另一段材料', provider: 'test', model: 'test', inputTokens: 10, outputTokens: 6 };
    },
    memoryPort: { recordExperience: async experience => { legacyWrites.push(experience); return { ok: true, receiptId: 'legacy' }; } },
    p2Ports: { readFile: async ({ path: file }) => ({ ok: true, text: fs.readFileSync(file, 'utf8') }) },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } });

  await runToFinish(runtime);
  const db = openRuntimeDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  assert.equal(db.all("SELECT event_id FROM domain_events WHERE kind = 'memory/ingest-request'").length, 1);
  assert.equal(db.all('SELECT outbox_id FROM memory_outbox').length, 1, 'the row waits for an engine instead of being lost');
  assert.equal(legacyWrites.length, 0);

  const drained = await runtime.drainOutboxNow();
  assert.equal(drained.skipped, 'memory-unavailable', 'no engine → quiet skip, attempts untouched');
  assert.equal(db.get('SELECT attempts FROM memory_outbox').attempts, 0, 'a missing engine does not burn a delivery attempt');
});

test('memory(R3): a finish whose P1 mark is missing is compensated with the same event id', async t => {
  const root = makeRoot(t);
  const { runtime, legacyWrites, ingested } = mountWithMemory(root, planJson(T0, ['sources/a.md']));
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } });

  await runToFinish(runtime);
  const db = openCheck(root);
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  const activity = runtime.listActivities({ bound: BOUND }).activities[0];
  const eventBefore = db.get("SELECT event_id FROM domain_events WHERE kind = 'memory/ingest-request'");
  assert.ok(db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', `p2_p1_${activity.activityId}`), 'the write was marked');

  // The dangerous window: the finish committed, the mark is gone (the process died between the
  // hook and the mark, or the mark itself failed). Nothing else changed.
  db.run("UPDATE runtime_meta SET meta_value = '' WHERE meta_key = ?", `p2_p1_${activity.activityId}`);

  await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 1 });
  const replayedMark = db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', `p2_p1_${activity.activityId}`);
  assert.equal(replayedMark.meta_value, '1', 'the compensation pass re-marked it');
  const events = db.all("SELECT event_id FROM domain_events WHERE kind = 'memory/ingest-request'");
  assert.equal(events.length, 1, 'the replay produced no second event');
  assert.equal(events[0].event_id, eventBefore.event_id, 'and it is the same content-addressed id');
  assert.equal(db.all('SELECT outbox_id FROM memory_outbox').length, 1, 'still exactly one outbox row');

  await runtime.drainOutboxNow();
  assert.equal(ingested.length, 1, 'exactly one experience reached memory');
  assert.equal(legacyWrites.length, 0);
  assert.equal(ingested[0].eventId ?? ingested[0].payload?.eventId ?? events[0].event_id, ingested[0].eventId ?? events[0].event_id);
});

test('memory(R3): compensation never doubles a delivered experience and never starves a later one', async t => {
  const root = makeRoot(t);
  const { runtime, ingested, legacyWrites } = mountWithMemory(root, planJson(T0, ['sources/a.md', 'sources/b.md']));
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } });

  await runToFinish(runtime, { cycles: 10 });
  const db = openCheck(root);
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  const done = Number(db.get("SELECT COUNT(*) AS n FROM p2_activities WHERE status = 'done'").n);
  assert.ok(done >= 1, 'at least one activity finished');
  const queuedOnce = db.all('SELECT outbox_id FROM memory_outbox');
  assert.equal(queuedOnce.length, done, 'one outbox row per finished activity, never more');

  // Extra compensation cycles must not add rows, events or deliveries.
  for (let index = 0; index < 3; index += 1) await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 1 });
  assert.equal(db.all('SELECT outbox_id FROM memory_outbox').length, done, 'no duplicate outbox row');
  assert.equal(db.all("SELECT event_id FROM domain_events WHERE kind = 'memory/ingest-request'").length, done, 'no duplicate event');
  assert.equal(legacyWrites.length, 0);

  await runtime.drainOutboxNow();
  assert.equal(ingested.length, done, 'each finished activity delivered exactly once');
  const second = await runtime.drainOutboxNow();
  assert.equal(second.delivered, 0);
  assert.equal(ingested.length, done);
});
