import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { createDb, openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { applyAgendaEvent } from '../lib/agenda.mjs';
import { scopeKey } from '../lib/scope.mjs';

// Regression for the two blockers the independent review found in Pass 2.
//
// BLOCK-1 (HH02): cancel + repeat-the-same-create produced one extra active definition per
// retry, because the idempotency lookup only matched the bare request key while the
// re-arranged definition had been stored under a suffixed key.
//
// BLOCK-2 (HH11/HH15): a definition-level event whose reducer failed transiently stayed in
// the log without a receipt; the caller's retry appended a second event and replay then
// rejected it for ever, so `verifyRecovery` reported a permanent mismatch.

const T0 = Date.UTC(2026, 9, 30, 1, 0, 0);
const BOUND = { userId: 'owner-1' };
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: '' });
const KEY = scopeKey(SCOPE);

function buildRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blockers-'));
  for (const dir of ['home/companion', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', agenda: { enabled: true }, heartbeat: { enabled: false },
  }));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

const identity = () => ({ resolve: sessionId => ({ userId: 'owner-1', persona: 'bot', sessionId }) });
const mount = root => mountRuntime(null, root, { now: () => T0, identity: identity() });

function activeDefinitions(db) {
  return db.all("SELECT item_id, request_key FROM agenda_items WHERE scope = ? AND status = 'active'", KEY);
}

test('BLOCK-1/HH02: cancel then repeating the same create keeps exactly one active definition', t => {
  const root = buildRoot(t);
  const runtime = mount(root);
  t.after(() => runtime.dispose());
  const dbFile = path.join(root, 'home/companion/companion-runtime.db');

  const created = runtime.createSchedule({ bound: BOUND, title: '旧计划', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const cancelled = runtime.cancelSchedule({ bound: BOUND, itemId: created.itemId, expectedRevision: created.item.revision });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));

  // Re-arranging the same plan is allowed and must produce a *new* definition id.
  const again = runtime.createSchedule({ bound: BOUND, title: '旧计划', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.notEqual(again.itemId, created.itemId, 'a cancelled definition is never resurrected');
  assert.equal(again.idempotent, false);

  // Every further identical retry must be idempotent instead of minting yet another plan.
  for (let index = 0; index < 5; index += 1) {
    const retry = runtime.createSchedule({ bound: BOUND, title: '旧计划', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.idempotent, true, `retry ${index} must be idempotent`);
    assert.equal(retry.itemId, again.itemId, 'every retry lands on the same active definition');
  }

  const probe = createDb({ file: dbFile, now: () => T0, pragmas: false });
  const actives = activeDefinitions(probe);
  const total = Number(probe.get('SELECT COUNT(*) AS n FROM agenda_items WHERE scope = ?', KEY).n);
  probe.close();
  assert.equal(actives.length, 1, `exactly one active definition (found ${JSON.stringify(actives)})`);
  assert.equal(total, 2, 'one cancelled + one active definition, no unbounded growth');
});

test('BLOCK-1/HH02: an explicit request key reused for a different plan is refused, not duplicated', t => {
  const root = buildRoot(t);
  const runtime = mount(root);
  t.after(() => runtime.dispose());
  const first = runtime.createSchedule({ bound: BOUND, requestKey: 'host-key-1', title: 'A', rule: 'daily', timeZone: 'Asia/Shanghai', time: '08:00' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const same = runtime.createSchedule({ bound: BOUND, requestKey: 'host-key-1', title: 'A', rule: 'daily', timeZone: 'Asia/Shanghai', time: '08:00' });
  assert.equal(same.ok, true);
  assert.equal(same.idempotent, true);
  const conflicting = runtime.createSchedule({ bound: BOUND, requestKey: 'host-key-1', title: 'B', rule: 'daily', timeZone: 'Asia/Shanghai', time: '09:00' });
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.code, 'request-key-conflict');
});

test('BLOCK-2/HH11: a transient reducer failure rolls the whole agenda event back (no orphan row)', t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blocker2-')), 'events.db');
  const db = openRuntimeDb({ file, now: () => T0 });
  t.after(() => db.close());
  const base = {
    kind: 'agenda/created',
    scope: SCOPE,
    occurredAt: T0,
    payload: {
      itemId: 'ag_blocker', requestKey: 'rk-1',
      item: { itemId: 'ag_blocker', revision: 1, createdAt: T0, title: 'x', category: 'plan', source: 'tool', rule: 'daily', timeZone: 'Asia/Shanghai', date: '', time: '09:00', weekdays: [], atUtc: null, validFrom: T0, validUntil: null, authorization: 'plan', goalRef: '', commitmentRef: '', requestKey: 'rk-1', resolution: { localIntent: { date: '', time: '09:00', zone: 'Asia/Shanghai' }, resolution: 'exact', note: '' } },
    },
  };
  const failing = { agenda: () => { throw new Error('injected transient failure'); } };

  // Default behaviour (P1): the append survives, the receipt does not — the orphan that made
  // BLOCK-2 unrecoverable. Asserted so the reason for the flag stays visible.
  const legacy = dispatchEvent(db, base, { handlers: failing });
  assert.equal(legacy.inserted, true);
  assert.equal(legacy.rejected, false);
  const orphanEvents = Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n);
  const orphanReceipts = Number(db.get('SELECT COUNT(*) AS n FROM consumer_receipts').n);
  assert.equal(orphanEvents, 1);
  assert.equal(orphanReceipts, 0, 'the legacy path really does leave an event without a receipt');

  // With the flag the agenda path uses, the same failure rolls back the append entirely.
  const rolled = dispatchEvent(db, { ...base, payload: { ...base.payload, itemId: 'ag_blocker2', requestKey: 'rk-2', item: { ...base.payload.item, itemId: 'ag_blocker2', requestKey: 'rk-2' } } }, { handlers: failing, requireConsumers: true });
  assert.equal(rolled.rejected, true);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n), 1, 'the failed append left no row');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM agenda_items').n), 0, 'and no projection row');

  // A clean retry of the same logical request now lands exactly once.
  const clean = { ...base, payload: { ...base.payload, itemId: 'ag_blocker2', requestKey: 'rk-2', item: { ...base.payload.item, itemId: 'ag_blocker2', requestKey: 'rk-2' } } };
  const ok = dispatchEvent(db, clean, { handlers: { agenda: applyAgendaEvent }, requireConsumers: true });
  assert.equal(ok.inserted, true);
  assert.equal(ok.rejected, false);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM agenda_items').n), 1);

  // Replay of the committed log reproduces the live rows; the orphaned legacy event is the
  // only mismatch source and it is excluded from this scope by construction (different itemId
  // family), so the supported path is clean.
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM consumer_receipts WHERE consumer = ?', 'agenda').n), 1);
});

test('BLOCK-2/HH11: the generic event entry refuses agenda/* so no bypass can forge an instant', t => {
  const root = buildRoot(t);
  const runtime = mount(root);
  t.after(() => runtime.dispose());
  const direct = runtime.recordEvent({
    kind: 'agenda/created',
    bound: BOUND,
    occurredAt: T0 - 999999, // a fabricated instant that would break event identity
    payload: { itemId: 'ag_forged', requestKey: 'forged' },
  });
  assert.equal(direct.ok, false, JSON.stringify(direct));
  assert.equal(direct.code, 'agenda-direct-event-refused');
  const probe = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0, pragmas: false });
  const forged = Number(probe.get("SELECT COUNT(*) AS n FROM domain_events WHERE kind LIKE 'agenda/%'").n);
  probe.close();
  assert.equal(forged, 0, 'no agenda event can reach the log through the generic entry');

  // The supported path still works, so this is a boundary and not a broken feature.
  const created = runtime.createSchedule({ bound: BOUND, title: '正常创建', rule: 'daily', timeZone: 'Asia/Shanghai', time: '06:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
});

test('BLOCK-2/HH11: an end-to-end update survives an injected consumer failure without poisoning replay', t => {
  const root = buildRoot(t);
  const runtime = mount(root);
  t.after(() => runtime.dispose());

  const created = runtime.createSchedule({ bound: BOUND, title: '整理书桌', rule: 'daily', timeZone: 'Asia/Shanghai', time: '21:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(runtime.verifyRecovery({ bound: BOUND }).ok, true);

  // Inject one transient failure into the real reducer through the runtime's handler table.
  const original = runtime.handlers.agenda;
  assert.equal(typeof original, 'function');
  let injected = 0;
  runtime.handlers.agenda = (...args) => { injected += 1; throw new Error('injected transient failure'); };
  const failed = runtime.updateSchedule({ bound: BOUND, itemId: created.itemId, expectedRevision: created.item.revision, patch: { title: '整理书桌（改）' } });
  runtime.handlers.agenda = original;
  assert.equal(injected, 1, 'the injected failure really ran');
  assert.equal(failed.ok, false, JSON.stringify(failed));

  // The failed update must leave no trace at all: no revision bump, no orphan event.
  const afterFailure = runtime.listSchedule({ bound: BOUND });
  assert.equal(afterFailure.items[0].revision, created.item.revision, 'a rolled-back update does not bump the revision');
  assert.equal(afterFailure.items[0].title, '整理书桌');
  const probe = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0, pragmas: false });
  const updateEvents = Number(probe.get("SELECT COUNT(*) AS n FROM domain_events WHERE kind = 'agenda/updated'").n);
  probe.close();
  assert.equal(updateEvents, 0, 'no orphaned agenda/updated event was left in the log');

  // A clean retry with the same expectedRevision now succeeds, and recovery still verifies.
  const retried = runtime.updateSchedule({ bound: BOUND, itemId: created.itemId, expectedRevision: created.item.revision, patch: { title: '整理书桌（改）' } });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.item.title, '整理书桌（改）');
  const recovery = runtime.verifyRecovery({ bound: BOUND });
  assert.equal(recovery.ok, true, JSON.stringify(recovery.mismatches));
});
