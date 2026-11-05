import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { createActivities, applyActivityEvent } from '../lib/activities.mjs';
import { sha256Hex, slugFor } from '../lib/activity-adapters.mjs';
import { scopeKey } from '../lib/scope.mjs';

// P2-09 创作/作品版本 (contract §8, wiki 15 §5).
//
// The evidence rule under test: a draft is the artifact. Each version is an immutable new
// file with its own sha256, the history lives in the checkpoint, and an existing version is
// never rewritten. A write activity without an artifact hash can never become `done`.

const T0 = Date.UTC(2026, 9, 30, 4, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-writing-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function filePorts(counter = { reads: 0, writes: 0 }) {
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

function configFor(activities = {}) {
  return {
    p2: {
      activities: {
        enabled: true, paused: false, chunkUnits: 300, maxUnitsPerStep: 4000,
        maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400, draftsDir: 'drafts',
        ...activities,
      },
      autonomy: { allowedSources: [] },
    },
  };
}

function openDb(t, file = ':memory:', { now = () => T0 } = {}) {
  const db = openRuntimeDb({ file, now });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  return db;
}

const dispatchFor = db => event => dispatchEvent(db, event, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });

function insertSlot(db, { slotId, kind, target, startAt = T0, endAt = T0 + 3600000, detail = '{}' }) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, 'plan-1', ?, '2026-10-30', ?, ?, 'activity', ?, '随笔', ?, 'soft', '', ?, 'planned', 0, ?, ?)`,
  slotId, KEY, startAt, endAt, kind, detail, target, T0, T0);
}

function makeActivities({ db, ports, workspace, config = configFor(), clock = () => T0 + 1000 }) {
  return createActivities({ db, config, clock, owner: 'test', generation: 'gen-1', dispatch: dispatchFor(db), ports, workspace });
}

test('P2-09: a draft starts as v1 and every step writes a new immutable version', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-write', kind: 'write', target: '夜里写的一段' });
  const ports = filePorts();
  const activities = makeActivities({ db, ports, workspace });

  const started = activities.start({ slotId: 'slot-write', kind: 'write' });
  assert.equal(started.status, 'running');
  assert.equal(started.artifactVersion, 1);
  assert.equal(started.reality, 'hypothetical');
  const row1 = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  const slug = JSON.parse(row1.checkpoint).slug;
  assert.equal(slug, slugFor('夜里写的一段'), 'the slug is deterministic');
  const v1Path = path.join(workspace, 'drafts', slug, 'v1.md');
  assert.ok(fs.existsSync(v1Path), 'v1 exists on disk');
  const v1Text = fs.readFileSync(v1Path, 'utf8');
  assert.equal(row1.artifact_hash, sha256Hex(v1Text), 'artifact_hash is the sha256 of the version file');
  assert.equal(row1.source_hash, row1.artifact_hash, 'for a write activity the version hash is the source hash');
  assert.equal(Number(row1.consumed_prefix), v1Text.length);
  assert.equal(Number(row1.artifact_version), 1);

  const step = activities.step({ activityId: started.activityId, append: '潮水退去以后，礁石上留下了一层薄薄的盐。' });
  assert.equal(step.artifactVersion, 2);
  assert.ok(step.units > 0);
  assert.deepEqual(step.consumed, { from: v1Text.length, to: step.consumedPrefix });
  const v2Path = path.join(workspace, 'drafts', slug, 'v2.md');
  assert.ok(fs.existsSync(v2Path), 'v2 is a new file');
  assert.equal(fs.readFileSync(v1Path, 'utf8'), v1Text, 'v1 is byte-identical after v2 was written');
  const v2Text = fs.readFileSync(v2Path, 'utf8');
  assert.ok(v2Text.startsWith(v1Text.trimEnd()), 'v2 extends v1 instead of replacing it');
  const row2 = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  assert.equal(row2.artifact_hash, sha256Hex(v2Text));
  assert.notEqual(row2.artifact_hash, row1.artifact_hash, 'a new version has a new hash');
  assert.equal(Number(row2.artifact_version), 2);
  const checkpoint = JSON.parse(row2.checkpoint);
  assert.equal(checkpoint.versions.length, 2, 'the checkpoint keeps the version history');
  assert.deepEqual(checkpoint.versions.map(entry => entry.version), [1, 2]);
  assert.equal(checkpoint.versions[1].hash, row2.artifact_hash);

  const finished = activities.finish({ activityId: started.activityId });
  assert.equal(finished.status, 'done');
  assert.equal(finished.artifactVersion, 2);
  assert.ok(finished.complete, 'the whole draft has been written');
  const receipts = db.all("SELECT operation, code, ok, consumed_from, consumed_to, artifact_ref FROM p2_activity_receipts WHERE activity_id = ? ORDER BY at", started.activityId);
  // R4 added a second row class to this table (`operation='review'`, `code='lc-effect'`: the
  // write-ahead execution intent and its confirmation). They are not interval receipts, so the
  // interval history is asserted without them — and their presence is asserted separately, so the
  // test does not lose strength by ignoring them.
  const intervalReceipts = receipts.filter(r => r.code !== 'lc-effect');
  assert.deepEqual(intervalReceipts.map(r => r.operation), ['start', 'step', 'finish']);
  assert.ok(intervalReceipts.every(r => r.artifact_ref.startsWith('drafts/')), 'every write receipt names the artifact it produced');
  assert.deepEqual(receipts.filter(r => r.code === 'lc-effect').map(r => r.ok), [1, 1], 'a prepared intent and its confirmation surround the adapter work');
});

test('P2-09: an existing draft is extended, never overwritten', t => {
  const workspace = tempDir(t);
  const title = '海边札记';
  const slug = slugFor(title);
  const existingPath = path.join(workspace, 'drafts', slug, 'v1.md');
  fs.mkdirSync(path.dirname(existingPath), { recursive: true });
  const existing = '# 海边札记\n\n昨天写下的第一段。\n';
  fs.writeFileSync(existingPath, existing, 'utf8');

  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-again', kind: 'write', target: title });
  const activities = makeActivities({ db, ports: filePorts(), workspace });

  const started = activities.start({ slotId: 'slot-again', kind: 'write' });
  assert.equal(started.artifactVersion, 2, 'an existing project continues at the next version');
  assert.equal(fs.readFileSync(existingPath, 'utf8'), existing, 'the old version was not overwritten');
  const checkpoint = JSON.parse(db.get('SELECT checkpoint FROM p2_activities WHERE activity_id = ?', started.activityId).checkpoint);
  assert.equal(checkpoint.extended, true);
  assert.equal(checkpoint.versions.length, 2);
  assert.equal(checkpoint.versions[0].hash, sha256Hex(existing), 'the previous version stays in the history');

  // Two different titles never share a draft directory.
  assert.notEqual(slugFor('海边札记'), slugFor('另一篇'));
  insertSlot(db, { slotId: 'slot-again-2', kind: 'write', target: '另一篇' });
  const second = activities.start({ slotId: 'slot-again-2', kind: 'write', target: '另一篇' });
  assert.notEqual(
    JSON.parse(db.get('SELECT checkpoint FROM p2_activities WHERE activity_id = ?', second.activityId).checkpoint).slug,
    slug,
  );
});

test('P2-09: an empty append is a no-op with no event and no receipt', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-write', kind: 'write', target: '空段落' });
  const activities = makeActivities({ db, ports: filePorts(), workspace });
  const started = activities.start({ slotId: 'slot-write', kind: 'write' });
  const eventsBefore = Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n);
  const receiptsBefore = Number(db.get('SELECT COUNT(*) AS n FROM p2_activity_receipts').n);

  const empty = activities.step({ activityId: started.activityId, append: '   ' });
  assert.equal(empty.ok, true);
  assert.equal(empty.units, 0);
  assert.equal(empty.empty, true);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n), eventsBefore, 'no event for a no-op');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activity_receipts').n), receiptsBefore, 'no receipt for a no-op');
  assert.equal(Number(db.get('SELECT artifact_version FROM p2_activities WHERE activity_id = ?', started.activityId).artifact_version), 1);
});

test('P2-09: a write activity without an artifact hash can never be done', t => {
  const db = openDb(t);
  // A row that claims to be a write activity but recorded no artifact hash (a repaired or
  // hand-written row): finishing it must be refused, not silently accepted.
  db.run(`INSERT INTO p2_activities (activity_id, scope, plan_slot_id, kind, adapter, capability, reality, status,
            target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_hash,
            artifact_version, started_at, paused_at, ended_at, created_at, updated_at)
          VALUES ('act_broken', ?, '', 'write', 'write', 'write', 'hypothetical', 'running', 'x', 'draft:x', ?, 10, 10, '{}', '', '', 1, ?, 0, 0, ?, ?)`,
  KEY, sha256Hex('whatever'), T0, T0, T0);
  const outcome = dispatchEvent(db, {
    kind: 'autonomy/activity',
    scope: SCOPE,
    occurredAt: T0 + 1000,
    payload: {
      phase: 'finished',
      generation: 'gen-1',
      activity: { activityId: 'act_broken', scope: KEY, kind: 'write' },
      consumed: { from: 10, to: 10 },
      receipt: { operation: 'finish', ok: true, code: '', detail: '{"reality":"hypothetical","kind":"write","adapter":"write","units":0,"note":"finish"}', sourceHash: '', consumedFrom: 10, consumedTo: 10, artifactRef: '' },
    },
  }, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });
  assert.equal(outcome.rejected, true, 'the whole event is rolled back');
  assert.equal(outcome.results[0].code, 'artifact-missing');
  assert.equal(db.get('SELECT status FROM p2_activities WHERE activity_id = ?', 'act_broken').status, 'running', 'status unchanged');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE activity_id = ?', 'act_broken').n), 0, 'no receipt was written');
});

test('P2-09: write steps refuse a version that would not grow the artifact', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-write', kind: 'write', target: '太长的段落' });
  const activities = makeActivities({ db, ports: filePorts(), workspace, config: configFor({ maxSourceBytes: 1000 }) });
  const started = activities.start({ slotId: 'slot-write', kind: 'write' });
  const huge = '很长的段落。'.repeat(400); // > maxSourceBytes once appended
  assert.throws(() => activities.step({ activityId: started.activityId, append: huge }), error => error.code === 'invalid-input');
  assert.equal(db.get('SELECT status FROM p2_activities WHERE activity_id = ?', started.activityId).status, 'running', 'a caller error never parks the activity');
  assert.equal(Number(db.get('SELECT artifact_version FROM p2_activities WHERE activity_id = ?', started.activityId).artifact_version), 1, 'no version was created');
  const slug = JSON.parse(db.get('SELECT checkpoint FROM p2_activities WHERE activity_id = ?', started.activityId).checkpoint).slug;
  assert.deepEqual(fs.readdirSync(path.join(workspace, 'drafts', slug)), ['v1.md'], 'nothing was written for a refused step');
});
