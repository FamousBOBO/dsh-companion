import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { ACTIVITY_KINDS, createActivities, applyActivityEvent } from '../lib/activities.mjs';
import {
  ADAPTER_IDS,
  adapterContext,
  adapterContract,
  describeAdapters,
  extractPlainText,
  listAdapters,
  parseSourceUrl,
  resolveInsideWorkspace,
  sha256Hex,
  slugFor,
  sourceAllowed,
} from '../lib/activity-adapters.mjs';
import { scopeKey } from '../lib/scope.mjs';

// P2-21 适配器失败契约 (contract §8, amendment BLOCK-5).
//
// The rules under test: every adapter publishes `{available, requires, produces,
// evidenceFields}` and the declared evidence fields are exactly what a receipt actually
// stores; a missing port is reported as unavailable instead of pretending; containment is a
// refusal; and the whole API is thenable-transparent (sync ports keep it synchronous).

const T0 = Date.UTC(2026, 9, 30, 4, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);
const SOURCE = Array.from({ length: 6 }, (_, index) => `第${index}段：` + '窗外的雨一直没停。'.repeat(6)).join('\n\n');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-contract-'));
  fs.mkdirSync(path.join(dir, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shelf', 'rain.md'), `# 雨\n\n${SOURCE}`, 'utf8');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function syncPorts() {
  return {
    readFile({ path: file }) { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } },
    writeFile({ path: file, text }) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); return { ok: true, bytes: Buffer.byteLength(text) }; },
    fetchPage({ url }) {
      return { ok: true, status: 200, contentType: 'text/html', text: `<html><head><title>雨</title></head><body><p>${'雨声'.repeat(40)}</p></body></html>`, finalUrl: url };
    },
  };
}

function asyncPorts(inner = syncPorts()) {
  return {
    readFile: async input => inner.readFile(input),
    writeFile: async input => inner.writeFile(input),
    fetchPage: async input => inner.fetchPage(input),
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

const dispatchFor = db => event => dispatchEvent(db, event, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });

function insertSlot(db, { slotId, kind, target, detail = '{}' }) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, 'plan-1', ?, '2026-10-30', ?, ?, 'activity', ?, '雨', ?, 'soft', '', ?, 'planned', 0, ?, ?)`,
  slotId, KEY, T0, T0 + 3600000, kind, detail, target, T0, T0);
}

function makeActivities({ db, workspace, ports = syncPorts(), config = configFor(), clock = () => T0 + 1000 }) {
  return createActivities({ db, config, clock, owner: 'test', generation: 'gen-1', dispatch: dispatchFor(db), ports, workspace });
}

test('P2-21: every adapter publishes the contract and the directory agrees with it', () => {
  const context = adapterContext({ ports: syncPorts(), config: configFor(), workspace: 'C:/works' });
  const table = adapterContract(context);
  assert.equal(table.length, 4);
  assert.deepEqual(table.map(entry => entry.id), [...ADAPTER_IDS]);
  assert.deepEqual([...ADAPTER_IDS], [...ACTIVITY_KINDS], 'adapter ids and activity kinds are the same vocabulary');
  for (const entry of table) {
    assert.equal(typeof entry.available, 'boolean');
    assert.ok(Array.isArray(entry.requires) && entry.requires.length > 0, `${entry.id} declares what it requires`);
    assert.ok(Array.isArray(entry.produces) && entry.produces.length > 0, `${entry.id} declares what it produces`);
    assert.ok(Array.isArray(entry.evidenceFields) && entry.evidenceFields.length > 0, `${entry.id} declares its evidence`);
    for (const field of entry.evidenceFields) {
      assert.ok(['sourceHash', 'consumedFrom', 'consumedTo', 'reality', 'artifactRef', 'roundEvidence'].includes(field), `unknown evidence field ${field}`);
    }
  }
  const directory = describeAdapters({ ports: syncPorts(), config: configFor(), workspace: 'C:/works' });
  assert.deepEqual(Object.keys(directory).sort(), ['bilibili', 'explore', 'read', 'write']);
  assert.equal(directory.bilibili.available, false);
  assert.ok(['read', 'explore', 'write'].every(id => directory[id].available === true));
  assert.equal(describeAdapters({ ports: { runBilibili() {} } }).bilibili.available, true);
  assert.equal(directory.write.port, 'writeFile');

  // Layout matters: `slugFor` and the hash helpers are deterministic across calls.
  assert.equal(slugFor('海边札记'), slugFor('海边札记'));
  assert.equal(slugFor('海边札记'), slugFor('  海边札记  '), 'surrounding whitespace never forks a project');
  assert.notEqual(slugFor('海边札记'), slugFor('海边札记！'), 'a different title is a different project');
  assert.equal(sha256Hex('abc'), sha256Hex('abc'));
  assert.equal(extractPlainText({ contentType: 'text/plain', text: 'a\r\nb' }).text, 'a\nb');
  assert.equal(parseSourceUrl('https://example.org/a').host, 'example.org');
  assert.equal(sourceAllowed('example.org', ['example.org']), true);
});

test('P2-21: missing ports and an empty allowlist are reported, never faked', () => {
  const noPorts = describeAdapters({ ports: {}, config: configFor({}, { allowedSources: ['example.org'] }), workspace: 'C:/works' });
  assert.equal(noPorts.read.available, false);
  assert.equal(noPorts.read.reason, 'port-not-mounted');
  assert.equal(noPorts.explore.available, false);
  assert.equal(noPorts.write.available, false);

  const noAllowlist = describeAdapters({ ports: syncPorts(), config: configFor({}, { allowedSources: [] }), workspace: 'C:/works' });
  assert.equal(noAllowlist.explore.available, false);
  assert.equal(noAllowlist.explore.reason, 'source-allowlist-empty');
  assert.equal(noAllowlist.read.available, true, 'a missing explore allowlist never drags the read adapter down');

  const noWorkspace = describeAdapters({ ports: syncPorts(), config: configFor(), workspace: '' });
  assert.equal(noWorkspace.read.available, false);
  assert.equal(noWorkspace.read.reason, 'workspace-not-mounted');
  assert.equal(noWorkspace.write.available, false);

  // The controller refuses with `adapter-unavailable` and creates nothing.
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  insertSlot(db, { slotId: 'slot-1', kind: 'read', target: 'shelf/rain.md' });
  const activities = createActivities({ db, config: configFor(), clock: () => T0 + 1000, owner: 'test', generation: 'gen-1', dispatch: dispatchFor(db), ports: {}, workspace: tempDirSafe() });
  assert.throws(() => activities.start({ slotId: 'slot-1', kind: 'read' }), error => error.code === 'adapter-unavailable');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0);
  db.close();
});

let scratch = null;
function tempDirSafe() {
  if (!scratch) scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-contract-ws-'));
  return scratch;
}
process.on('exit', () => {
  if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } }
});

test('P2-21: the declared evidence fields are exactly what the receipts store', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-read', kind: 'read', target: 'shelf/rain.md' });
  insertSlot(db, { slotId: 'slot-explore', kind: 'explore', target: 'https://example.org/rain' });
  insertSlot(db, { slotId: 'slot-write', kind: 'write', target: '雨天的一页' });
  const activities = makeActivities({ db, workspace });

  const ids = {
    read: activities.start({ slotId: 'slot-read', kind: 'read' }).activityId,
    explore: activities.start({ slotId: 'slot-explore', kind: 'explore' }).activityId,
    write: activities.start({ slotId: 'slot-write', kind: 'write' }).activityId,
  };
  activities.step({ activityId: ids.read, units: 200 });
  activities.step({ activityId: ids.explore, units: 200 });
  activities.step({ activityId: ids.write, append: '雨小了一点，我把窗子推开一条缝。' });

  const table = new Map(adapterContract(adapterContext({ ports: syncPorts(), config: configFor(), workspace })).map(entry => [entry.id, entry]));
  const valueOf = {
    sourceHash: receipt => receipt.source_hash,
    consumedFrom: receipt => Number(receipt.consumed_from),
    consumedTo: receipt => Number(receipt.consumed_to),
    reality: receipt => JSON.parse(receipt.detail).reality,
    artifactRef: receipt => receipt.artifact_ref,
  };
  for (const [kind, activityId] of Object.entries(ids)) {
    const declared = table.get(kind).evidenceFields;
    const receipts = db.all("SELECT * FROM p2_activity_receipts WHERE activity_id = ? AND code <> 'lc-effect' ORDER BY at", activityId);
    assert.ok(receipts.length >= 2, `${kind} produced a start receipt and an operation receipt`);
    for (const field of declared) {
      const reader = valueOf[field];
      assert.equal(typeof reader, 'function', `the test knows how to read ${field}`);
      const values = receipts.map(reader);
      if (field === 'consumedFrom') {
        assert.ok(values.every(value => Number.isFinite(value)), `${kind} records a numeric consumedFrom`);
      } else if (field === 'consumedTo') {
        assert.ok(values.some(value => value > 0), `${kind} records a non-empty consumed interval`);
      } else {
        assert.ok(values.some(value => typeof value === 'string' && value.length > 0), `${kind} records evidence field ${field}`);
      }
    }
    // Every receipt carries the writer generation and a fixed-key-order detail object.
    for (const receipt of receipts) {
      assert.equal(receipt.generation, 'gen-1');
      assert.match(receipt.receipt_id, /^rcp_[0-9a-f]{24}$/);
      assert.deepEqual(Object.keys(JSON.parse(receipt.detail)), ['reality', 'kind', 'adapter', 'units', 'note']);
      if (kind !== 'write') {
        // read/explore never change artifactVersion, so the frozen id formula is checkable
        // straight from the stored row.
        const expected = 'rcp_' + sha256Hex([KEY, activityId, receipt.operation, receipt.consumed_from, receipt.consumed_to, 0].join('|')).slice(0, 24);
        assert.equal(receipt.receipt_id, expected, 'the receipt id is the frozen scope|activity|operation|from|to|version digest');
      }
    }
  }
});

test('P2-21: containment refuses traversal, absolute paths and empty targets', t => {
  const workspace = tempDir(t);
  assert.throws(() => resolveInsideWorkspace(workspace, '../escape.md'), error => error.code === 'workspace-denied');
  assert.throws(() => resolveInsideWorkspace(workspace, 'shelf/../../escape.md'), error => error.code === 'workspace-denied');
  assert.throws(() => resolveInsideWorkspace(workspace, 'C:/Windows/system32/config'), error => error.code === 'workspace-denied');
  assert.throws(() => resolveInsideWorkspace(workspace, '/etc/passwd'), error => error.code === 'workspace-denied');
  assert.throws(() => resolveInsideWorkspace(workspace, ''), error => error.code === 'workspace-denied');
  assert.throws(() => resolveInsideWorkspace('', 'a.md'), error => error.code === 'workspace-denied');
  assert.equal(resolveInsideWorkspace(workspace, 'shelf/rain.md').relative, 'shelf/rain.md');

  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-evil', kind: 'read', target: '../../../etc/passwd' });
  insertSlot(db, { slotId: 'slot-abs', kind: 'read', target: 'C:/Windows/win.ini' });
  const activities = makeActivities({ db, workspace });
  assert.throws(() => activities.start({ slotId: 'slot-evil', kind: 'read' }), error => error.code === 'workspace-denied');
  assert.throws(() => activities.start({ slotId: 'slot-abs', kind: 'read' }), error => error.code === 'workspace-denied');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0);
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE operation = 'review' AND code = 'workspace-denied'").n), 2);
});

test('P2-21: the API is thenable-transparent — sync ports stay sync, async ports return a Promise', async t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-sync', kind: 'read', target: 'shelf/rain.md' });
  insertSlot(db, { slotId: 'slot-async', kind: 'read', target: 'shelf/rain.md' });

  const syncActivities = makeActivities({ db, workspace, ports: syncPorts() });
  const syncResult = syncActivities.start({ slotId: 'slot-sync', kind: 'read' });
  assert.equal(typeof syncResult?.then, 'undefined', 'a synchronous mount keeps the lifecycle synchronous');
  assert.equal(syncResult.status, 'running');
  const syncStep = syncActivities.step({ activityId: syncResult.activityId, units: 200 });
  assert.equal(typeof syncStep?.then, 'undefined');
  assert.ok(syncStep.units > 0);

  const asyncActivities = makeActivities({ db, workspace, ports: asyncPorts() });
  const pending = asyncActivities.start({ slotId: 'slot-async', kind: 'read' });
  assert.equal(typeof pending.then, 'function', 'an asynchronous port makes the same call return a Promise');
  const started = await pending;
  assert.equal(started.status, 'running');
  const step = await asyncActivities.step({ activityId: started.activityId, units: 200 });
  assert.ok(step.units > 0);
  assert.equal(step.consumed.from, 0);
  const reconcile = await asyncActivities.reconcile();
  assert.ok(reconcile.resumed.includes(started.activityId));
});

test('P2-21: listAdapters reports foundational adapters and the optional Bilibili adapter', () => {
  const entries = listAdapters(adapterContext({ ports: syncPorts(), config: configFor(), workspace: 'C:/works' }));
  assert.deepEqual(entries.map(entry => entry.id), ['read', 'explore', 'write', 'bilibili']);
  assert.ok(entries.every(entry => entry.capability === entry.id), 'no invented capability names');
  for (const entry of entries) {
    assert.ok(entry.requires.every(requirement => typeof requirement === 'string'));
    assert.ok(entry.produces.every(product => typeof product === 'string'));
  }
});
