import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { createActivities, applyActivityEvent, receiptIdFor } from '../lib/activities.mjs';
import { extractPlainText, sha256Hex } from '../lib/activity-adapters.mjs';
import { scopeKey } from '../lib/scope.mjs';

// P2-07 断点续读 (contract logs/p2-autonomous-day/contract-p2.md §8, wiki 15 §5.1).
//
// The evidence rule under test: reading text into a buffer is not "read". A receipt must
// cover the exact character interval that was consumed, the next step must continue at that
// offset after a restart, and no interval may ever be consumed twice.

const T0 = Date.UTC(2026, 9, 30, 4, 0, 0); // 2026-10-30T04:00Z = 12:00 Asia/Shanghai
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);

const PARAGRAPHS = [
  '# 潮汐笔记',
  '第一段：潮水在傍晚退去，露出湿漉漉的礁石。'.repeat(10),
  '第二段：风向变了，海鸟贴着浪尖飞。'.repeat(10),
  '第三段：远处的灯塔每隔十二秒闪一次。'.repeat(10),
  '第四段：我在沙上写字，又看着它被水抹平。'.repeat(10),
];
const SOURCE_MD = PARAGRAPHS.join('\n\n');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-reading-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/**
 * Real filesystem ports restricted to the workspace, like the Lead's production mount.
 * Deliberately **synchronous**: the runtime tick calls the activity API synchronously, and
 * the thenable-transparent contract must keep it that way (async ports are covered in
 * p2-adapter-contract.test.mjs).
 */
function filePorts(root, counter = { reads: 0, writes: 0 }) {
  return {
    counter,
    readFile({ path: file }) {
      counter.reads += 1;
      try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; }
    },
    writeFile({ path: file, text }) {
      counter.writes += 1;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
      return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
    },
    fetchPage() { return { ok: false, status: 0 }; },
  };
}

function configFor(activities = {}, autonomy = {}) {
  return {
    p2: {
      activities: {
        enabled: true,
        paused: false,
        chunkUnits: 300,
        maxUnitsPerStep: 4000,
        maxSourceBytes: 200000,
        maxTotalUnits: 200000,
        maxExcerptChars: 400,
        draftsDir: 'drafts',
        ...activities,
      },
      autonomy: { allowedSources: [], ...autonomy },
    },
  };
}

function openDb(t, file, { now = () => T0 } = {}) {
  const db = openRuntimeDb({ file, now });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  return db;
}

const dispatchFor = db => event => dispatchEvent(db, event, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });

function insertSlot(db, { slotId, kind, target, startAt = T0, endAt = T0 + 3600000, detail = '{}', scope = KEY }) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, 'plan-1', ?, '2026-10-30', ?, ?, 'activity', ?, '潮汐笔记', ?, 'soft', '', ?, 'planned', 0, ?, ?)`,
  slotId, scope, startAt, endAt, kind, detail, target, T0, T0);
}

function makeActivities({ db, ports, workspace, config = configFor(), clock = () => T0 + 1000 }) {
  return createActivities({ db, config, clock, owner: 'test', generation: 'gen-1', dispatch: dispatchFor(db), ports, workspace });
}

function receiptsOf(db, activityId) {
  return db.all('SELECT * FROM p2_activity_receipts WHERE activity_id = ? ORDER BY consumed_from ASC, at ASC', activityId);
}

test('P2-07: a read activity resumes at the exact consumed offset across a restart', t => {
  const dir = tempDir(t);
  const workspace = path.join(dir, 'works');
  fs.mkdirSync(path.join(workspace, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'shelf', 'tide.md'), SOURCE_MD, 'utf8');
  const dbFile = path.join(dir, 'runtime.db');

  const db = openDb(t, dbFile);
  insertSlot(db, { slotId: 'slot-read', kind: 'read', target: 'shelf/tide.md' });
  const ports = filePorts(workspace);
  const activities = makeActivities({ db, ports, workspace });

  const started = activities.start({ slotId: 'slot-read', kind: 'read' });
  assert.equal(started.ok, true);
  assert.equal(started.status, 'running');
  const first = activities.step({ activityId: started.activityId, units: 300 });
  const second = activities.step({ activityId: started.activityId, units: 300 });
  assert.ok(first.units > 0 && second.units > 0);
  assert.deepEqual(second.consumed, { from: first.consumed.to, to: second.consumed.to });
  const offsetBeforeRestart = second.consumedPrefix;
  assert.equal(offsetBeforeRestart, first.units + second.units);
  assert.equal(activities.pause({ activityId: started.activityId }).status, 'paused');

  // Simulated restart: the database file survives, every in-memory controller does not.
  db.close();
  const reopened = openDb(t, dbFile);
  const restarted = makeActivities({ db: reopened, ports: filePorts(workspace), workspace });
  const verdict = restarted.reconcile();
  assert.deepEqual(verdict.needsReview, []);
  assert.deepEqual(verdict.stale, []);
  assert.ok(verdict.resumed.includes(started.activityId), 'a paused activity with an intact source is safe to resume');

  assert.equal(restarted.resume({ activityId: started.activityId }).status, 'running');
  const third = restarted.step({ activityId: started.activityId, units: 300 });
  assert.equal(third.consumed.from, offsetBeforeRestart, 'the next step starts exactly where the last one stopped');
  assert.ok(third.units > 0);

  // The receipts cover disjoint, contiguous intervals: nothing replayed, nothing skipped.
  const stepReceipts = receiptsOf(reopened, started.activityId).filter(receipt => receipt.operation === 'step');
  assert.equal(stepReceipts.length, 3, 'one receipt per consumed interval');
  let cursor = 0;
  for (const receipt of stepReceipts) {
    assert.equal(Number(receipt.consumed_from), cursor, 'intervals are contiguous and never overlap');
    assert.ok(Number(receipt.consumed_to) > Number(receipt.consumed_from));
    cursor = Number(receipt.consumed_to);
    assert.equal(receipt.generation, 'gen-1', 'every receipt names the writer generation');
  }
  assert.equal(cursor, third.consumedPrefix);
  const row = reopened.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  assert.equal(Number(row.consumed_prefix), cursor);
  assert.equal(row.status, 'running');
  assert.equal(row.reality, 'hypothetical', 'an unspecified activity is hypothetical, never "actual"');
});

test('P2-07: chunk boundaries land on paragraph breaks and the hash is stable', t => {
  const dir = tempDir(t);
  const workspace = path.join(dir, 'works');
  fs.mkdirSync(path.join(workspace, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'shelf', 'a.md'), SOURCE_MD, 'utf8');
  // Same visible text, different container: extraction must agree on the plain text.
  fs.writeFileSync(path.join(workspace, 'shelf', 'b.html'), `<html><head><title>潮汐笔记</title></head><body>${
    PARAGRAPHS.map(line => `<p>${line.replace(/^# /, '')}</p>`).join('')
  }</body></html>`, 'utf8');

  const db = openDb(t, ':memory:');
  insertSlot(db, { slotId: 'slot-a', kind: 'read', target: 'shelf/a.md' });
  insertSlot(db, { slotId: 'slot-b', kind: 'read', target: 'shelf/b.md' });
  const activities = makeActivities({ db, ports: filePorts(workspace), workspace });

  const started = activities.start({ slotId: 'slot-a', kind: 'read' });
  const step = activities.step({ activityId: started.activityId, units: 300 });
  assert.match(step.segment.text, /\n\n$/, 'a chunk ends at a paragraph break, not mid-sentence');
  assert.ok(step.units < 300, 'the boundary is pulled back inside the requested window');

  const html = fs.readFileSync(path.join(workspace, 'shelf', 'b.html'), 'utf8');
  const md = fs.readFileSync(path.join(workspace, 'shelf', 'a.md'), 'utf8');
  const fromHtml = extractPlainText({ contentType: 'text/html', text: html });
  const fromMarkdown = extractPlainText({ contentType: 'text/markdown', text: md });
  assert.equal(fromHtml.format, 'html');
  assert.equal(fromMarkdown.format, 'markdown');
  // Stability is per source: the same bytes always hash the same, whatever the container.
  // (Cross-format whitespace is normalised differently on purpose — an HTML <p> run and a
  // blank-line separated markdown body are different text, and pretending otherwise would
  // make an offset silently reusable across formats.)
  assert.equal(sha256Hex(fromHtml.text), sha256Hex(extractPlainText({ contentType: 'text/html', text: html }).text));
  assert.equal(sha256Hex(fromMarkdown.text), sha256Hex(extractPlainText({ contentType: 'text/markdown', text: md }).text));
  assert.equal(fromHtml.title, '潮汐笔记');
  assert.equal(fromMarkdown.title, '潮汐笔记');
  for (const sentence of ['潮水在傍晚退去', '海鸟贴着浪尖飞', '灯塔每隔十二秒闪一次']) {
    assert.ok(fromHtml.text.includes(sentence), `html extraction keeps "${sentence}"`);
    assert.ok(fromMarkdown.text.includes(sentence), `markdown extraction keeps "${sentence}"`);
  }
  assert.ok(!fromMarkdown.text.includes('#'), 'markdown syntax is stripped from the consumed text');

  // Two activities bound to the same untouched file share one source hash.
  const again = activities.start({ slotId: 'slot-b', kind: 'read', target: 'shelf/a.md', reality: 'actual_tool_activity' });
  const rowAgain = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', again.activityId);
  assert.equal(rowAgain.source_hash, db.get('SELECT source_hash FROM p2_activities WHERE activity_id = ?', started.activityId).source_hash);
  assert.equal(rowAgain.reality, 'actual_tool_activity', 'an explicit reality is kept as given');
});

test('P2-07: a source with no readable text is refused and leaves review evidence only', t => {
  const dir = tempDir(t);
  const workspace = path.join(dir, 'works');
  fs.mkdirSync(path.join(workspace, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'shelf', 'blank.md'), '   \n\n\t\n', 'utf8');
  const db = openDb(t, ':memory:');
  insertSlot(db, { slotId: 'slot-blank', kind: 'read', target: 'shelf/blank.md' });
  const activities = makeActivities({ db, ports: filePorts(workspace), workspace });

  assert.throws(() => activities.start({ slotId: 'slot-blank', kind: 'read' }), error => error.code === 'source-invalid');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0, 'a refused start creates no activity');
  // `code <> 'lc-effect'`: the R4 execution-intent rows share `operation='review'` but are a
  // different row class (see the lifecycle design §2.1); refusals are still exactly one per
  // activity+code.
  const refusal = db.get("SELECT * FROM p2_activity_receipts WHERE operation = 'review' AND code <> 'lc-effect'");
  assert.ok(refusal, 'the refusal is durable evidence');
  assert.equal(refusal.code, 'source-invalid');
  assert.equal(JSON.parse(refusal.detail).reality, 'hypothetical');
  assert.equal(refusal.ok, 0);

  // A missing file is the same class of refusal, and a retry does not flood the table.
  insertSlot(db, { slotId: 'slot-missing', kind: 'read', target: 'shelf/nope.md' });
  assert.throws(() => activities.start({ slotId: 'slot-missing', kind: 'read' }), error => error.code === 'source-invalid');
  assert.throws(() => activities.start({ slotId: 'slot-missing', kind: 'read' }), error => error.code === 'source-invalid');
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE code <> 'lc-effect'").n), 2, 'one refusal receipt per activity/code');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0);
});

test('P2-07: finishing a partial read reports coverage instead of claiming the whole text', t => {
  const dir = tempDir(t);
  const workspace = path.join(dir, 'works');
  fs.mkdirSync(path.join(workspace, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'shelf', 'tide.md'), SOURCE_MD, 'utf8');
  const db = openDb(t, ':memory:');
  insertSlot(db, { slotId: 'slot-read', kind: 'read', target: 'shelf/tide.md' });
  const activities = makeActivities({ db, ports: filePorts(workspace), workspace });

  const started = activities.start({ slotId: 'slot-read', kind: 'read' });
  activities.step({ activityId: started.activityId, units: 300 });
  const finished = activities.finish({ activityId: started.activityId });
  assert.equal(finished.status, 'done');
  assert.equal(finished.complete, false, 'one chunk is not the whole text');
  assert.ok(finished.consumedPrefix > 0 && finished.consumedPrefix < finished.totalUnits);
  const row = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  const checkpoint = JSON.parse(row.checkpoint);
  assert.equal(checkpoint.consumed.to, Number(row.consumed_prefix));
  assert.equal(checkpoint.unit, 'chars');
  assert.ok(Array.isArray(checkpoint.notes));
  assert.equal(checkpoint.artifactVersion, 0);
  assert.ok(db.get("SELECT 1 AS one FROM p2_activity_receipts WHERE operation = 'finish' AND ok = 1"));
});

test('P2-07: the same consumed interval can never be charged twice', t => {
  const dir = tempDir(t);
  const workspace = path.join(dir, 'works');
  fs.mkdirSync(path.join(workspace, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'shelf', 'tide.md'), SOURCE_MD, 'utf8');
  const db = openDb(t, ':memory:');
  insertSlot(db, { slotId: 'slot-read', kind: 'read', target: 'shelf/tide.md' });
  const activities = makeActivities({ db, ports: filePorts(workspace), workspace });

  const started = activities.start({ slotId: 'slot-read', kind: 'read' });
  const step = activities.step({ activityId: started.activityId, units: 300 });
  const receiptsBefore = Number(db.get('SELECT COUNT(*) AS n FROM p2_activity_receipts').n);
  const prefixBefore = Number(db.get('SELECT consumed_prefix FROM p2_activities WHERE activity_id = ?', started.activityId).consumed_prefix);

  // A stale executor replays the identical event: the receipt primary key rejects the
  // second row, and the activity row does not move.
  const row = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  const replay = dispatchEvent(db, {
    kind: 'autonomy/activity',
    scope: SCOPE,
    occurredAt: T0 + 2000,
    payload: {
      phase: 'progress',
      generation: 'gen-1',
      activity: { activityId: started.activityId, scope: KEY, kind: 'read', totalUnits: row.total_units },
      consumed: step.consumed,
      expectedConsumed: 0,
      checkpoint: JSON.parse(row.checkpoint),
      receipt: { operation: 'step', ok: true, code: '', detail: '{"reality":"hypothetical","kind":"read","adapter":"read","units":1,"note":"replay"}', sourceHash: row.source_hash, consumedFrom: 0, consumedTo: step.consumed.to, artifactRef: '' },
    },
  }, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });
  assert.equal(replay.results[0].applied, true);
  assert.equal(replay.results[0].result.duplicate, true, 'a repeated interval is reported as a duplicate');
  assert.equal(Number(db.get('SELECT consumed_prefix FROM p2_activities WHERE activity_id = ?', started.activityId).consumed_prefix), prefixBefore);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activity_receipts').n), receiptsBefore, 'no second receipt for one interval');

  // The frozen receipt id is exactly the contract formula.
  const expected = 'rcp_' + sha256Hex([KEY, started.activityId, 'step', 0, step.consumed.to, 0].join('|')).slice(0, 24);
  assert.equal(receiptIdFor({ scopeKey: KEY, activityId: started.activityId, operation: 'step', consumedFrom: 0, consumedTo: step.consumed.to, artifactVersion: 0 }), expected);
  assert.ok(db.get('SELECT 1 AS one FROM p2_activity_receipts WHERE receipt_id = ?', expected));
});
