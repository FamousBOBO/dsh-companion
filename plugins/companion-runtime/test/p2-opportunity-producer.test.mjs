import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import {
  ACTIVITY_OPPORTUNITY_KINDS,
  OPPORTUNITY_TTL_MS,
  applyActivityEvent,
  createActivities,
  opportunityDedupeKey,
} from '../lib/activities.mjs';
import { applyPlanEvent } from '../lib/planner.mjs';
import { scopeKey } from '../lib/scope.mjs';

// P2-22 生产者半边 (Lead ruling: one bounded opportunity per ended activity, BLOCK-8 origin).
//
// Rules under test: only a *real* tool activity that finished or paused may queue, at most
// one opportunity per activity, the origin is a receipt that actually exists, the payload is
// references only, and a throwing queue never rolls back the finish that caused it.

const T0 = Date.UTC(2026, 9, 30, 4, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);
const SOURCE = Array.from({ length: 10 }, (_, index) => `第${index}段：` + '雨落在窗台上。'.repeat(6)).join('\n\n');
const PAGE_HTML = `<html><head><title>雨天的海</title></head><body><p>${'雨声'.repeat(80)}</p></body></html>`;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-opportunity-'));
  fs.mkdirSync(path.join(dir, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shelf', 'rain.md'), `# 雨\n\n${SOURCE}`, 'utf8');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function syncPorts(html = PAGE_HTML) {
  return {
    readFile({ path: file }) { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } },
    writeFile({ path: file, text }) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); return { ok: true, bytes: Buffer.byteLength(text) }; },
    fetchPage({ url }) { return { ok: true, status: 200, contentType: 'text/html', text: html, finalUrl: url }; },
  };
}

function configFor(activities = {}, autonomy = {}) {
  return {
    p2: {
      activities: {
        enabled: true, paused: false, chunkUnits: 200, maxUnitsPerStep: 4000,
        maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400, draftsDir: 'drafts',
        ...activities,
      },
      autonomy: { allowedSources: ['example.org'], ...autonomy },
    },
  };
}

function openDb(t) {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  return db;
}

/** The Lead's routing in `p2.mjs`: one `autonomy` consumer that fans out by kind. */
function handlerFor({ db, hooks = {} }) {
  return ({ db: handlerDb, event, slice, now }) => {
    if (event.kind === 'autonomy/opportunity') {
      if (hooks.opportunityHandler) return hooks.opportunityHandler({ db: handlerDb, event, slice, now });
      return applyPlanEvent({ db: handlerDb, event, slice, now });
    }
    return applyActivityEvent({ db: handlerDb, event, slice, now });
  };
}

function dispatchFor(db, hooks = {}) {
  const handler = handlerFor({ db, hooks });
  return event => {
    if (hooks.throwOn && event.kind === hooks.throwOn) throw new Error(`dispatch refused ${event.kind}`);
    return dispatchEvent(db, event, { handlers: { autonomy: handler }, generation: 'gen-1', requireConsumers: true });
  };
}

function insertSlot(db, { slotId, kind, target, detail = '{}' }) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, 'plan-1', ?, '2026-10-30', ?, ?, 'activity', ?, '雨', ?, 'soft', '', ?, 'planned', 0, ?, ?)`,
  slotId, KEY, T0, T0 + 3600000, kind, detail, target, T0, T0);
}

function makeActivities({ db, workspace, ports = syncPorts(), config = configFor(), hooks = {}, errors = [], clock = () => T0 + 1000 }) {
  return createActivities({
    db, config, clock, owner: 'test', generation: 'gen-1',
    dispatch: dispatchFor(db, hooks), ports, workspace,
    onError: (code, detail) => { errors.push({ code, detail }); },
  });
}

function opportunities(db) {
  return db.all('SELECT * FROM p2_opportunities WHERE scope = ? ORDER BY created_at, opportunity_id', KEY);
}

function opportunityEvents(db) {
  return db.all("SELECT * FROM domain_events WHERE kind = 'autonomy/opportunity' ORDER BY seq");
}

test('P2-22: a finished write activity queues exactly one traceable "continue" opportunity', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-write', kind: 'write', target: '雨天的一页' });
  const activities = makeActivities({ db, workspace });

  const started = activities.start({ slotId: 'slot-write', kind: 'write', reality: 'actual_tool_activity' });
  activities.step({ activityId: started.activityId, append: '雨小了一点，我把窗子推开一条缝。' });
  const finished = activities.finish({ activityId: started.activityId });
  assert.equal(finished.status, 'done');

  const rows = opportunities(db);
  assert.equal(rows.length, 1, 'exactly one opportunity for one activity');
  const opportunity = rows[0];
  assert.equal(opportunity.kind, ACTIVITY_OPPORTUNITY_KINDS.continue);
  assert.equal(opportunity.status, 'open');
  assert.equal(opportunity.source, 'activity');
  assert.ok(Number(opportunity.weight) >= 1);
  assert.equal(
    opportunity.dedupe_key,
    opportunityDedupeKey({ scopeKey: KEY, kind: ACTIVITY_OPPORTUNITY_KINDS.continue, activityId: started.activityId }),
  );
  assert.equal(opportunity.dedupe_key.length, 64, 'the dedupe key is a full sha256 digest');

  // The origin is a receipt that really exists, and it is the finish receipt.
  const finishReceipt = db.get("SELECT * FROM p2_activity_receipts WHERE activity_id = ? AND operation = 'finish'", started.activityId);
  assert.ok(finishReceipt, 'the finish receipt exists');
  const payload = JSON.parse(opportunity.payload);
  assert.equal(payload.activityId, started.activityId);
  assert.equal(payload.kind, ACTIVITY_OPPORTUNITY_KINDS.continue);
  // The producer supplies references only; the planner's reducer adds its own provenance
  // (`originEventId`/`originReceiptId`/`ref`) on top, which is also ids/text-free metadata.
  for (const key of ['activityId', 'kind', 'sourceRef', 'sourceHashPrefix', 'target']) {
    assert.ok(key in payload, `the queued payload keeps ${key}`);
  }
  for (const [key, value] of Object.entries(payload)) {
    assert.ok(typeof value === 'string' || typeof value === 'number', `${key} is a scalar reference, not a body`);
    assert.ok(String(value).length <= 200, `${key} stays bounded`);
  }
  assert.equal(payload.sourceHashPrefix.length, 16);
  assert.ok(payload.sourceRef.startsWith('draft:'));
  // No body text anywhere in the queued payload: no draft prose, no excerpt.
  assert.ok(!opportunity.payload.includes('窗外'), 'the queue carries references only');
  assert.ok(!opportunity.payload.includes('窗子'), 'the draft text is not copied into the queue');
  assert.equal(Number(opportunity.expires_at), Number(finishReceipt.at) + OPPORTUNITY_TTL_MS);
  assert.ok(Number(opportunity.expires_at) > T0);

  // The event itself names the originating receipt (BLOCK-8) for both accepted spellings.
  const [event] = opportunityEvents(db);
  const eventPayload = JSON.parse(event.payload);
  assert.equal(eventPayload.action, 'queue');
  assert.equal(eventPayload.originReceiptId, finishReceipt.receipt_id);
  assert.equal(eventPayload.opportunity.originReceiptId, finishReceipt.receipt_id);
  assert.equal(eventPayload.opportunityId, opportunity.opportunity_id);
  assert.equal(activities.status().lastOpportunityId, opportunity.opportunity_id);
});

test('P2-22: a duplicate finish never queues a second opportunity', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-write', kind: 'write', target: '同一篇' });
  const activities = makeActivities({ db, workspace });
  const started = activities.start({ slotId: 'slot-write', kind: 'write', reality: 'actual_tool_activity' });
  activities.step({ activityId: started.activityId, append: '第一段。' });

  activities.finish({ activityId: started.activityId });
  const duplicate = activities.finish({ activityId: started.activityId });
  assert.equal(duplicate.duplicate, true);
  assert.equal(opportunities(db).length, 1, 'still one opportunity');
  assert.equal(opportunityEvents(db).length, 1, 'still one opportunity event');

  // Pause → resume → pause on the same activity is also bounded by the dedupe key.
  insertSlot(db, { slotId: 'slot-read', kind: 'read', target: 'shelf/rain.md' });
  const reader = activities.start({ slotId: 'slot-read', kind: 'read', reality: 'actual_tool_activity' });
  activities.step({ activityId: reader.activityId, units: 200 });
  activities.pause({ activityId: reader.activityId });
  activities.resume({ activityId: reader.activityId });
  activities.pause({ activityId: reader.activityId });
  assert.equal(opportunities(db).length, 2, 'one per activity, not one per operation');
  assert.equal(opportunityEvents(db).length, 2);
});

test('P2-22: simulated, hypothetical, failed and abandoned activities queue nothing', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-sim', kind: 'write', target: '模拟的一页', detail: '{"reality":"simulated"}' });
  insertSlot(db, { slotId: 'slot-hyp', kind: 'write', target: '未证实的一页' });
  insertSlot(db, { slotId: 'slot-fail', kind: 'write', target: '失败的一页' });
  insertSlot(db, { slotId: 'slot-abandon', kind: 'write', target: '放弃的一页' });
  const activities = makeActivities({ db, workspace });

  const simulated = activities.start({ slotId: 'slot-sim', kind: 'write' });
  assert.equal(simulated.reality, 'simulated_world');
  activities.finish({ activityId: simulated.activityId });

  const hypothetical = activities.start({ slotId: 'slot-hyp', kind: 'write' });
  assert.equal(hypothetical.reality, 'hypothetical');
  activities.pause({ activityId: hypothetical.activityId });
  activities.finish({ activityId: hypothetical.activityId });

  const failed = activities.start({ slotId: 'slot-fail', kind: 'write', reality: 'actual_tool_activity' });
  activities.fail({ activityId: failed.activityId, code: 'failed-unknown' });

  const abandoned = activities.start({ slotId: 'slot-abandon', kind: 'write', reality: 'actual_tool_activity' });
  activities.abandon({ activityId: abandoned.activityId, reason: '不想写了' });

  assert.equal(opportunities(db).length, 0, 'no opportunity from a simulated, unproven, failed or abandoned activity');
  assert.equal(opportunityEvents(db).length, 0);
  // Two natural finishes committed (the failed activity's terminal receipt is inish with ok=0).
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE operation = 'finish' AND ok = 1").n), 2, 'the finishes themselves still committed');
});

test('P2-22: a throwing queue dispatch never rolls back the finish that caused it', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-write', kind: 'write', target: '断线的一页' });
  const errors = [];
  const activities = makeActivities({ db, workspace, errors, hooks: { throwOn: 'autonomy/opportunity' } });
  const started = activities.start({ slotId: 'slot-write', kind: 'write', reality: 'actual_tool_activity' });
  activities.step({ activityId: started.activityId, append: '写到这里。' });

  const finished = activities.finish({ activityId: started.activityId });
  assert.equal(finished.ok, true);
  assert.equal(finished.status, 'done', 'the finish is committed regardless of the queue');
  const row = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  assert.equal(row.status, 'done');
  assert.ok(db.get("SELECT 1 AS one FROM p2_activity_receipts WHERE activity_id = ? AND operation = 'finish'", started.activityId));
  assert.equal(opportunities(db).length, 0, 'no opportunity was queued');
  const surfaced = errors.filter(entry => entry.code === 'p2-opportunity-failed');
  assert.equal(surfaced.length, 1, 'the failure is surfaced through onError');
  assert.match(surfaced[0].detail, /autonomy\/opportunity/);
});

test('P2-22: an origin-less queue stays rejected by the reducer', t => {
  const db = openDb(t);
  const outcome = dispatchEvent(db, {
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: T0,
    payload: {
      action: 'queue',
      dedupeKey: 'k1',
      opportunity: { opportunityId: 'opp_x', kind: ACTIVITY_OPPORTUNITY_KINDS.continue, weight: 1, expiresAt: T0 + 1000 },
    },
  }, { handlers: { autonomy: handlerFor({ db }) }, generation: 'gen-1', requireConsumers: true });
  assert.equal(outcome.rejected, true, 'a free-floating "reason" is not evidence');
  assert.equal(outcome.results[0].code, 'invalid-opportunity');
  assert.equal(opportunities(db).length, 0);
  assert.equal(opportunityEvents(db).length, 0);
});

test('P2-22: the kind follows what is actually left to do', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-partial-read', kind: 'read', target: 'shelf/rain.md' });
  insertSlot(db, { slotId: 'slot-full-read', kind: 'read', target: 'shelf/short.md' });
  insertSlot(db, { slotId: 'slot-explore', kind: 'explore', target: 'https://example.org/rain' });
  fs.writeFileSync(path.join(workspace, 'shelf', 'short.md'), '很短的一段。\n', 'utf8');
  const activities = makeActivities({ db, workspace });

  // A partial read leaves something to continue.
  const partial = activities.start({ slotId: 'slot-partial-read', kind: 'read', reality: 'actual_tool_activity' });
  activities.step({ activityId: partial.activityId, units: 200 });
  activities.finish({ activityId: partial.activityId });
  const partialOpportunity = opportunities(db).find(row => JSON.parse(row.payload).activityId === partial.activityId);
  assert.ok(partialOpportunity);
  assert.equal(partialOpportunity.kind, ACTIVITY_OPPORTUNITY_KINDS.continue);

  // A read that consumed everything and produced no artifact has nothing to offer.
  const full = activities.start({ slotId: 'slot-full-read', kind: 'read', reality: 'actual_tool_activity' });
  activities.step({ activityId: full.activityId, units: 4000 });
  assert.equal(db.get('SELECT consumed_prefix = total_units AS done FROM p2_activities WHERE activity_id = ?', full.activityId).done, 1);
  activities.finish({ activityId: full.activityId });
  assert.equal(opportunities(db).filter(row => JSON.parse(row.payload).activityId === full.activityId).length, 0);

  // An exploration that produced a usable excerpt is new material for the planner.
  const explored = activities.start({ slotId: 'slot-explore', kind: 'explore', reality: 'actual_tool_activity' });
  activities.step({ activityId: explored.activityId, units: 4000 });
  activities.finish({ activityId: explored.activityId });
  const material = opportunities(db).find(row => JSON.parse(row.payload).activityId === explored.activityId);
  assert.ok(material);
  assert.equal(material.kind, ACTIVITY_OPPORTUNITY_KINDS.material);
  assert.equal(opportunities(db).length, 2);
});

test('P2-22: a withdrawn share candidate silences the producer for that activity', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-write', kind: 'write', target: '撤回的一页' });
  const activities = makeActivities({ db, workspace });
  const started = activities.start({ slotId: 'slot-write', kind: 'write', reality: 'actual_tool_activity' });
  activities.step({ activityId: started.activityId, append: '写了一段。' });
  // The Lead's share flow withdrew the candidate for this activity: it must not come back as
  // a curiosity queue entry.
  db.run(`INSERT INTO p2_share_candidates (candidate_id, scope, activity_id, kind, title, body, source_ref, status, created_at, decision_at, decision_reason)
          VALUES ('shr_1', ?, ?, 'activity', 't', 'b', '', 'withdrawn', ?, ?, 'owner-declined')`, KEY, started.activityId, T0, T0 + 1);
  activities.finish({ activityId: started.activityId });
  assert.equal(opportunities(db).length, 0);
  assert.equal(opportunityEvents(db).length, 0);
});
