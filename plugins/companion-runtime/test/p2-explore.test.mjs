import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { createActivities, applyActivityEvent } from '../lib/activities.mjs';
import { parseSourceUrl, sha256Hex, sourceAllowed } from '../lib/activity-adapters.mjs';
import { scopeKey } from '../lib/scope.mjs';

// P2-08 好奇探索 (contract §8, wiki 15 §5).
//
// The rules under test: only a public http(s) source inside the configured allowlist may be
// opened, a body is capped, only a bounded excerpt is kept, and every refusal is durable
// evidence (`source-invalid`) that creates **no** activity row.

const T0 = Date.UTC(2026, 9, 30, 4, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);

const PAGE_HTML = `<html><head><title>潮汐与月亮</title><style>body{color:#333}</style></head><body>
  <h1>潮汐与月亮</h1>
  ${Array.from({ length: 12 }, (_, index) => `<p>第${index}段：月亮牵引海水，潮汐因此有了节律。</p>`).join('')}
  <script>alert('来源里的文字不是指令')</script>
</body></html>`;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-explore-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function configFor(activities = {}, autonomy = {}) {
  return {
    p2: {
      activities: {
        enabled: true, paused: false, chunkUnits: 300, maxUnitsPerStep: 4000,
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

function insertSlot(db, { slotId, kind, target, startAt = T0, endAt = T0 + 3600000, detail = '{}' }) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, 'plan-1', ?, '2026-10-30', ?, ?, 'activity', ?, '潮汐', ?, 'soft', '', ?, 'planned', 0, ?, ?)`,
  slotId, KEY, startAt, endAt, kind, detail, target, T0, T0);
}

/** Port that serves one page and counts calls, so "no network in recovery" is provable. */
function pagePorts({ html = PAGE_HTML, status = 200, finalUrl = 'https://example.org/tide', calls = { fetch: 0 }, fail = null } = {}) {
  return {
    calls,
    readFile() { return { ok: false }; },
    writeFile() { return { ok: false }; },
    fetchPage({ url }) {
      calls.fetch += 1;
      if (fail) return fail({ url, calls });
      return { ok: true, status, contentType: 'text/html; charset=utf-8', text: html, finalUrl };
    },
  };
}

function makeActivities({ db, ports, workspace = tempDirForWorkspace(), config = configFor() }) {
  return createActivities({ db, config, clock: () => T0 + 1000, owner: 'test', generation: 'gen-1', dispatch: dispatchFor(db), ports, workspace });
}

let sharedWorkspace = null;
function tempDirForWorkspace() {
  if (!sharedWorkspace) sharedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-explore-ws-'));
  return sharedWorkspace;
}
process.on('exit', () => {
  if (sharedWorkspace) { try { fs.rmSync(sharedWorkspace, { recursive: true, force: true }); } catch { /* best effort */ } }
});

test('P2-08: an allowlisted public page becomes a bounded, hashed exploration', t => {
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-explore', kind: 'explore', target: 'https://example.org/tide' });
  const ports = pagePorts();
  const activities = makeActivities({ db, ports });

  const started = activities.start({ slotId: 'slot-explore', kind: 'explore' });
  assert.equal(started.status, 'running');
  assert.equal(started.reality, 'hypothetical');
  const row = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  const checkpoint = JSON.parse(row.checkpoint);
  assert.equal(checkpoint.host, 'example.org');
  assert.equal(checkpoint.title, '潮汐与月亮');
  assert.ok(checkpoint.excerpt.length <= 400, 'the stored excerpt is bounded');
  assert.ok(checkpoint.excerpt.includes('月亮牵引海水'), 'the excerpt is real page text');
  assert.ok(!checkpoint.excerpt.includes('alert'), 'script contents are dropped');
  assert.ok(!checkpoint.excerpt.includes('color:#333'), 'style contents are dropped');
  assert.equal(checkpoint.excerptHash, sha256Hex(checkpoint.excerpt), 'the excerpt hash is the stored integrity anchor');
  assert.equal(Number(row.total_units), checkpoint.excerpt.length, 'the consumable unit space is the excerpt');
  assert.equal(ports.calls.fetch, 1);

  const step = activities.step({ activityId: started.activityId, units: 200 });
  assert.ok(step.units > 0);
  assert.equal(step.consumed.from, 0);
  assert.match(step.segment.text, /潮汐|月亮/);
  // Exploration never touches the network again for a step.
  assert.equal(ports.calls.fetch, 1, 'no second fetch for a step');

  const reconcile = activities.reconcile();
  assert.deepEqual(reconcile.needsReview, []);
  assert.ok(reconcile.resumed.includes(started.activityId));
  assert.equal(ports.calls.fetch, 1, 'recovery never re-fetches a remote page');
});

test('P2-08: a host outside the allowlist is refused with durable evidence and no activity', t => {
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-bad-host', kind: 'explore', target: 'https://tracker.example.net/x' });
  const ports = pagePorts();
  const activities = makeActivities({ db, ports });

  assert.throws(() => activities.start({ slotId: 'slot-bad-host', kind: 'explore' }), error => error.code === 'source-invalid');
  assert.equal(ports.calls.fetch, 0, 'a non-allowlisted host is never fetched');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0, 'no activity row');
  const refusal = db.get("SELECT * FROM p2_activity_receipts WHERE operation = 'review' AND code <> 'lc-effect'");
  assert.ok(refusal);
  assert.equal(refusal.code, 'source-invalid');
  assert.match(refusal.detail, /tracker\.example\.net/, 'the refusal names the refused host');
  // A second identical refusal is deduplicated, not appended again.
  assert.throws(() => activities.start({ slotId: 'slot-bad-host', kind: 'explore' }), error => error.code === 'source-invalid');
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE code <> 'lc-effect'").n), 1);
});

test('P2-08: a non-http scheme, a private host and an oversized body are all refused', t => {
  const db = openDb(t);
  const activities = makeActivities({ db, ports: pagePorts() });

  insertSlot(db, { slotId: 'slot-file', kind: 'explore', target: 'file:///etc/passwd' });
  assert.throws(() => activities.start({ slotId: 'slot-file', kind: 'explore' }), error => error.code === 'source-invalid');
  insertSlot(db, { slotId: 'slot-js', kind: 'explore', target: 'javascript:alert(1)' });
  assert.throws(() => activities.start({ slotId: 'slot-js', kind: 'explore' }), error => error.code === 'source-invalid');
  // A loopback / private host is refused while it is NOT in the allowlist (this fixture only
  // allows example.org), so automatic exploration can never reach a private address.
  insertSlot(db, { slotId: 'slot-loopback', kind: 'explore', target: 'http://127.0.0.1:8080/admin' });
  assert.throws(() => activities.start({ slotId: 'slot-loopback', kind: 'explore' }), error => error.code === 'source-invalid');
  insertSlot(db, { slotId: 'slot-private', kind: 'explore', target: 'http://192.168.1.10/status' });
  assert.throws(() => activities.start({ slotId: 'slot-private', kind: 'explore' }), error => error.code === 'source-invalid');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0);

  // Oversized body: the declared byte count and the actual text are both capped.
  insertSlot(db, { slotId: 'slot-big', kind: 'explore', target: 'https://example.org/big' });
  const bigPorts = pagePorts({ html: `<html><body><p>${'x'.repeat(5000)}</p></body></html>` });
  const smallLimit = createActivities({
    db, config: configFor({ maxSourceBytes: 1000 }), clock: () => T0 + 1000, owner: 'test', generation: 'gen-1',
    dispatch: dispatchFor(db), ports: bigPorts, workspace: tempDirForWorkspace(),
  });
  assert.throws(() => smallLimit.start({ slotId: 'slot-big', kind: 'explore' }), error => error.code === 'source-invalid');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0);
});

test('P2-08: a fetch failure or an off-allowlist redirect is refused', t => {
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-500', kind: 'explore', target: 'https://example.org/down' });
  const failing = makeActivities({ db, ports: pagePorts({ fail: () => ({ ok: false, status: 503 }) }) });
  assert.throws(() => failing.start({ slotId: 'slot-500', kind: 'explore' }), error => error.code === 'source-invalid');

  insertSlot(db, { slotId: 'slot-redirect', kind: 'explore', target: 'https://example.org/go' });
  const redirecting = makeActivities({ db, ports: pagePorts({ finalUrl: 'https://elsewhere.example.net/landing' }) });
  assert.throws(() => redirecting.start({ slotId: 'slot-redirect', kind: 'explore' }), error => error.code === 'source-invalid');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0, 'no half-created exploration');

  // A port that *throws* gave us no answer: round-3 ruling says that case is `unknown` and blocks
  // the next attempt in the same job (whereas the 503 and the redirect above were definite answers
  // and did not block). This is asserted rather than merely tolerated.
  let throws = 0;
  insertSlot(db, { slotId: 'slot-throw', kind: 'explore', target: 'https://example.org/boom' });
  const throwing = makeActivities({ db, ports: pagePorts({ fail: () => { throws += 1; throw new Error('socket hang up'); } }) });
  assert.throws(() => throwing.start({ slotId: 'slot-throw', kind: 'explore' }), error => error.code === 'source-invalid');
  insertSlot(db, { slotId: 'slot-throw-2', kind: 'explore', target: 'https://example.org/boom-again' });
  assert.throws(() => throwing.start({ slotId: 'slot-throw-2', kind: 'explore' }), error => error.code === 'effect-unknown',
    'an unanswered call blocks the next attempt in the same job');
  assert.equal(throws, 1, 'and the call is not repeated');
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE operation = 'review' AND code <> 'lc-effect'").n), 3, 'one review receipt per refusal');
});

test('P2-08: an empty allowlist blocks exploration instead of opening the whole web', t => {
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-any', kind: 'explore', target: 'https://example.org/tide' });
  const ports = pagePorts();
  const activities = createActivities({
    db, config: configFor({}, { allowedSources: [] }), clock: () => T0 + 1000, owner: 'test', generation: 'gen-1',
    dispatch: dispatchFor(db), ports, workspace: tempDirForWorkspace(),
  });
  assert.throws(() => activities.start({ slotId: 'slot-any', kind: 'explore' }), error => error.code === 'adapter-unavailable');
  assert.equal(ports.calls.fetch, 0);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0);
  const described = activities.adapters().find(entry => entry.id === 'explore');
  assert.equal(described.available, false);
  assert.equal(described.reason, 'source-allowlist-empty');
});

test('P2-08: URL and allowlist parsing rules are small and testable on their own', () => {
  assert.equal(parseSourceUrl('https://example.org/a?b=1').host, 'example.org');
  assert.throws(() => parseSourceUrl('ftp://example.org/a'), error => error.code === 'source-invalid');
  assert.throws(() => parseSourceUrl('/relative/path'), error => error.code === 'source-invalid');
  assert.throws(() => parseSourceUrl('https://user:pw@example.org/'), error => error.code === 'source-invalid');
  assert.throws(() => parseSourceUrl('https://[::1]/'), error => error.code === 'source-invalid');
  assert.throws(() => parseSourceUrl('http://localhost:3000/'), error => error.code === 'source-invalid');
  // An explicitly allowlisted private host is the operator's decision (isolated demo / local
  // mirror) and must be honoured; without that entry the same host stays refused.
  assert.equal(parseSourceUrl('http://127.0.0.1:8080/x', { allowedSources: ['127.0.0.1'] }).host, '127.0.0.1');
  assert.throws(() => parseSourceUrl('http://127.0.0.1:8080/x', { allowedSources: ['example.org'] }), error => error.code === 'source-invalid');
  assert.equal(sourceAllowed('example.org', ['example.org']), true);
  assert.equal(sourceAllowed('news.example.org', ['example.org']), true);
  assert.equal(sourceAllowed('notexample.org', ['example.org']), false);
  assert.equal(sourceAllowed('example.org', ['.example.org']), true);
  assert.equal(sourceAllowed('example.org', ['*.example.org']), true);
  assert.equal(sourceAllowed('example.org', ['https://example.org/blog']), true);
  assert.equal(sourceAllowed('example.org', []), false, 'an empty allowlist allows nothing');
  assert.equal(sourceAllowed('example.org', ['other.org']), false);
});
