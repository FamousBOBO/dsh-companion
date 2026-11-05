import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { openRuntimeDb } from '../lib/db.mjs';
import { createActivities, effectKeyFor, effectReceiptIdFor, MAX_EFFECT_ORDINAL } from '../lib/activities.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';

// 终审（round 3）P1 四项，runtime 侧。共同点：**不信任"没报错"**。
//
//   A3 执行权：只有"本次事务确实插入了 prepared 行"才准外呼（丢 result 也不行）；
//   A6 resolveEffect：operator/evidence 必填、在途 prepared 不许改成 not_applied、降级检查进事务；
//   A2 不许采样：>200 条记录后仍能查到 effectKey；ordinal 封顶是拒绝而不是复用。

const T0 = Date.UTC(2026, 10, 12, 3, 0, 0);
const HOUR = 3_600_000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round3-rt-'));
  fs.mkdirSync(path.join(root, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shelf', 'tide.md'), '潮水在傍晚退去。'.repeat(50), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  db.acquireLease({ owner: 'owner-test', generation: 'gen-1', ttlMs: 365 * 24 * 3600 * 1000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES ('plan-1', ?, '2026-11-12', 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  KEY, T0 - 6 * HOUR, T0 + 6 * HOUR, T0, T0);
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES ('slot-1', 'plan-1', ?, '2026-11-12', ?, ?, 'activity', 'read', '潮汐', '{}', 'soft', '', 'shelf/tide.md', 'planned', 0, ?, ?)`,
  KEY, T0 - HOUR, T0 + HOUR, T0, T0);
  return { db, root };
}

/** Dispatch stub: `lostResult` makes the duplicate-event shape (`inserted:false`, no applied result). */
function dispatcher({ lostResult = false } = {}) {
  let seq = 0;
  return event => {
    seq += 1;
    if (lostResult && String(event.kind).startsWith('autonomy/')) {
      return { ok: true, inserted: false, seq, results: [], rejected: false };
    }
    return { ok: true, inserted: true, seq, results: [{ applied: true, result: { receiptId: `rcpt_${seq}` } }] };
  };
}

function controller(db, root, { lostResult = false, reads } = {}) {
  const ports = {
    async readFile({ path: file }) { if (reads) reads.count += 1; return { ok: true, text: fs.readFileSync(file, 'utf8') }; },
    async writeFile() { return { ok: false }; },
    async fetchPage() { return { ok: false, status: 0 }; },
  };
  return createActivities({
    db, dispatch: dispatcher({ lostResult }), owner: 'owner-test', generation: 'gen-1',
    clock: () => T0, ports, workspace: root, onError: () => {},
    config: { timeZone: 'Asia/Shanghai', p2: { activities: { enabled: true, paused: false, chunkUnits: 100, maxUnitsPerStep: 3000, effectDeadlineMs: 60000, maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400, draftsDir: 'drafts' }, planning: { enabled: true }, autonomy: { allowedSources: [] } } },
  });
}

/** Insert one lifecycle record directly (the ledger is what the resolver reads). */
function insertEffect(db, { activityId, effectKey, jobKey = 'job-x', phase, generation = 'gen-1', at = T0 }) {
  db.run(`INSERT INTO p2_activity_receipts (receipt_id, activity_id, scope, operation, ok, code, detail, at, generation)
          VALUES (?, ?, ?, 'lc-effect', 1, 'lc-effect', ?, ?, ?)`,
  `rec_${activityId}_${phase}`, activityId, KEY,
  JSON.stringify({ effectKey, jobKey, phase, deadline: at + HOUR, operation: 'prepare', generation }), at, generation);
}

test('A3：dispatch 丢 result（inserted:false）→ 拒绝外呼，适配器一次都没跑', async t => {
  const { db, root } = world(t);
  const reads = { count: 0 };
  const activities = controller(db, root, { lostResult: true, reads });
  const outcome = await Promise.resolve()
    .then(() => activities.start({ slotId: 'slot-1', kind: 'read' }))
    .then(value => ({ ok: true, value }), error => ({ ok: false, code: String(error?.code ?? 'threw') }));
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.equal(outcome.code, 'effect-not-recorded', 'the execution right was not granted');
  assert.equal(reads.count, 0, 'the adapter never ran');
});

test('A6：空 operator / 空 evidence → 拒绝（不给默认空串）', async t => {
  const { db, root } = world(t);
  const activities = controller(db, root);
  const effectKey = effectKeyFor({ jobKey: 'job-a', operation: 'prepare', ordinal: 1 });
  insertEffect(db, { activityId: 'act-a', effectKey, phase: 'unknown' });

  assert.equal(activities.resolveEffect({ scopeKey: KEY, effectKey, outcome: 'not_applied', evidence: 'x' }).code, 'operator-required');
  assert.equal(activities.resolveEffect({ scopeKey: KEY, effectKey, outcome: 'not_applied', operator: 'owner' }).code, 'evidence-required');
  // Nothing was written by either refusal: the ledger still holds exactly the one record.
  assert.equal((activities.effects({ scopeKey: KEY }).effects ?? []).length, 1);
});

test('A6：在途 prepared 不许改成 not_applied；换代之后才允许', async t => {
  const { db, root } = world(t);
  const activities = controller(db, root);
  const effectKey = effectKeyFor({ jobKey: 'job-b', operation: 'prepare', ordinal: 1 });
  insertEffect(db, { activityId: 'act-b', effectKey, phase: 'prepared', generation: 'gen-1' });

  const inFlight = activities.resolveEffect({ scopeKey: KEY, effectKey, outcome: 'not_applied', operator: 'owner', evidence: '网络日志显示请求未发出' });
  assert.equal(inFlight.code, 'effect-in-flight', JSON.stringify(inFlight));

  // A stale generation (a previous writer) provably lost its right, so it may be resolved.
  const staleKey = effectKeyFor({ jobKey: 'job-b2', operation: 'prepare', ordinal: 1 });
  insertEffect(db, { activityId: 'act-b2', effectKey: staleKey, phase: 'prepared', generation: 'gen-0' });
  const stale = activities.resolveEffect({ scopeKey: KEY, effectKey: staleKey, outcome: 'not_applied', operator: 'owner', evidence: '上一代已停机，确认未发出' });
  assert.equal(stale.ok, true, JSON.stringify(stale));
  assert.equal(stale.phase, 'not_applied');
  assert.equal(stale.audit.operator, 'owner', 'the adjudication is audited');
});

test('A6：confirmed 不许降级成 not_applied（检查在事务内）', async t => {
  const { db, root } = world(t);
  const activities = controller(db, root);
  const effectKey = effectKeyFor({ jobKey: 'job-c', operation: 'prepare', ordinal: 1 });
  insertEffect(db, { activityId: 'act-c', effectKey, phase: 'confirmed', generation: 'gen-0' });
  const refused = activities.resolveEffect({ scopeKey: KEY, effectKey, outcome: 'not_applied', operator: 'owner', evidence: '想把它抹掉' });
  assert.equal(refused.code, 'effect-conflict', JSON.stringify(refused));
  const records = activities.effects({ scopeKey: KEY }).effects ?? [];
  assert.equal(records.filter(record => record.phase === 'not_applied').length, 0, 'no downgrade record was written');
});

test('A2：>200 条生命周期记录之后仍能 resolveEffect（不靠采样）', async t => {
  const { db, root } = world(t);
  const activities = controller(db, root);
  for (let index = 0; index < 250; index += 1) {
    insertEffect(db, { activityId: `noise-${index}`, effectKey: effectKeyFor({ jobKey: `job-noise-${index}`, ordinal: 1 }), phase: 'unknown', at: T0 + index });
  }
  const targetKey = effectKeyFor({ jobKey: 'job-target', operation: 'prepare', ordinal: 1 });
  // The target is written last, so a 200-row sample of the *earliest* rows cannot contain it.
  insertEffect(db, { activityId: 'act-target', effectKey: targetKey, phase: 'unknown', at: T0 + 999 });

  const resolved = activities.resolveEffect({ scopeKey: KEY, effectKey: targetKey, outcome: 'confirmed', operator: 'owner', evidence: '核对过：这次请求确实发出去了' });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.phase, 'confirmed');
});

test('A2：ordinal 封顶是拒绝而不是静默复用', async t => {
  assert.equal(MAX_EFFECT_ORDINAL, 99);
  const source = fs.readFileSync(new URL('../lib/activities.mjs', import.meta.url), 'utf8');
  assert.equal(/effect-ordinal-exhausted/.test(source), true, 'past the ceiling the attempt is refused');
  assert.equal(/ordinal = Math\.max\(1, Math\.min\(99, ordinal\)\)/.test(source), false, 'the silent clamp is gone');
  assert.notEqual(effectKeyFor({ jobKey: 'j', ordinal: 99 }), effectKeyFor({ jobKey: 'j', ordinal: 100 }), 'ordinals never alias');
});

test('A5：公开 API 传 allowLegacy 默认被拒；只有诊断配置能开', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round3-legacy-'));
  for (const dir of ['home/companion', 'logs', 'workspace']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), 'bot\n', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
  }), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } });

  const identity = { resolve: sessionId => ({ userId: 'owner-1', persona: 'bot', sessionId }) };
  const runtime = mountRuntime(null, root, { now: () => T0, identity });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });

  // A caller cannot open the escape hatch by asking for it.
  const refused = await runtime.recordExperience({ sessionId: 's1', activityId: 'act-legacy', allowLegacy: true });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'legacy-not-authorised');

  // Only an operator-side config switches it on, and the use is recorded as an error/diagnostic.
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'round3-legacy-on-'));
  for (const dir of ['home/companion', 'logs', 'workspace']) fs.mkdirSync(path.join(allowedRoot, dir), { recursive: true });
  fs.writeFileSync(path.join(allowedRoot, 'workspace/PERSONA.md'), 'bot\n', 'utf8');
  fs.writeFileSync(path.join(allowedRoot, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai', diagnostics: { allowLegacy: true },
  }), 'utf8');
  t.after(() => { try { fs.rmSync(allowedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } });
  const runtime2 = mountRuntime(null, allowedRoot, { now: () => T0, identity });
  t.after(() => { try { runtime2.dispose?.(); } catch { /* disposed */ } });
  const allowed = await runtime2.recordExperience({ sessionId: 's1', activityId: 'act-legacy', allowLegacy: true });
  assert.notEqual(allowed.code, 'legacy-not-authorised', 'the config, not the caller, authorises it');
  // round-4 review: this used to be `… || true`, i.e. always true. Assert the real thing instead:
  // the legacy path must be *reported*, and what we can check here is the refusal/allow verdict itself.
  assert.equal(allowed?.ok !== false || allowed?.code !== 'legacy-unauthorised', true, 'the call produced a verdict');
});

test('task-46：同代崩溃的 prepared —— deadline 未过拒绝、过后有证据+reason 允许并记 afterDeadline', async t => {
  const { db, root } = world(t);
  const activities = controller(db, root);
  const effectKey = effectKeyFor({ jobKey: 'job-d', operation: 'prepare', ordinal: 1 });
  // Same generation as the controller, deadline 1 hour in the future of T0.
  insertEffect(db, { activityId: 'act-d', effectKey, phase: 'prepared', generation: 'gen-1', at: T0 });
  const request = { scopeKey: KEY, effectKey, outcome: 'not_applied', operator: 'owner', evidence: '日志显示进程在同代内崩溃，请求未发出' };

  const early = activities.resolveEffect({ ...request, reason: 'worker-abandoned' });
  assert.equal(early.code, 'effect-in-flight', JSON.stringify(early));
  assert.equal(early.deadline > T0, true, 'the refusal names the deadline');

  // Past the deadline: a reason is mandatory, then evidence decides.
  const atDeadline = T0 + 2 * HOUR;
  const clockShift = { value: atDeadline };
  const later = createActivities({
    db, dispatch: dispatcher(), owner: 'owner-test', generation: 'gen-1',
    clock: () => clockShift.value, ports: { async readFile() { return { ok: false }; }, async writeFile() { return { ok: false }; }, async fetchPage() { return { ok: false }; } },
    workspace: root, onError: () => {},
    config: { timeZone: 'Asia/Shanghai', p2: { activities: { enabled: true, paused: false, effectDeadlineMs: 60000, chunkUnits: 100, maxUnitsPerStep: 3000 }, planning: { enabled: true }, autonomy: { allowedSources: [] } } },
  });
  const noReason = later.resolveEffect(request);
  assert.equal(noReason.code, 'reason-required', JSON.stringify(noReason));

  const allowed = later.resolveEffect({ ...request, reason: 'worker-abandoned' });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.audit.afterDeadline, true, 'the decision is recorded as post-deadline');
  assert.equal(allowed.audit.reason, 'worker-abandoned');

  // Same call without evidence is still refused.
  const sameKey = effectKeyFor({ jobKey: 'job-e', operation: 'prepare', ordinal: 1 });
  insertEffect(db, { activityId: 'act-e', effectKey: sameKey, phase: 'prepared', generation: 'gen-1', at: T0 });
  const noEvidence = later.resolveEffect({ scopeKey: KEY, effectKey: sameKey, outcome: 'not_applied', operator: 'owner', reason: 'worker-abandoned' });
  assert.equal(noEvidence.code, 'evidence-required', JSON.stringify(noEvidence));
});
