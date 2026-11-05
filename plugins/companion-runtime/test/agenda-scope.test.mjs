import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent, normalizeEvent } from '../lib/events.mjs';
import { normalizeScope, scopeKey } from '../lib/scope.mjs';
import {
  activeAgendaItems,
  agendaCounts,
  applyAgendaEvent,
  dueAgendaOccurrences,
  getAgendaItem,
  listAgendaItems,
  listAgendaOccurrences,
  normalizeDefinition,
  occurrenceIdFor,
  planWindow,
} from '../lib/agenda.mjs';

// HH04: scope isolation and forged arguments. The reducer addresses rows by
// `event.scopeKey` only; identity fields inside a payload are inert data, never an
// address. Two users/personas/worlds in one database must not see each other.

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0); // 2026-10-30T00:00Z = 08:00 Asia/Shanghai
const OWNER_A = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: '' });
const OWNER_B = Object.freeze({ userId: 'owner-2', personaId: 'bot', worldId: 'world:game' });
const OWNER_C = Object.freeze({ userId: 'owner-1', personaId: 'other-persona', worldId: 'world:game' });
const KEY_A = scopeKey(OWNER_A);
const KEY_B = scopeKey(OWNER_B);
const KEY_C = scopeKey(OWNER_C);
const HANDLERS = Object.freeze({ agenda: applyAgendaEvent });

function newDb(t) {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  t.after(() => db.close());
  return db;
}

function fire(db, kind, payload, { at = T0, scope = OWNER_A } = {}) {
  return dispatchEvent(db, normalizeEvent({ kind, scope, occurredAt: at, payload }), { handlers: HANDLERS, generation: 'gen-1' });
}

function createItem(db, input, { itemId, at = T0, scope = OWNER_A, extra = {} } = {}) {
  const definition = normalizeDefinition(input, { now: at });
  return fire(db, 'agenda/created', {
    item: { ...definition, itemId, revision: 1, createdAt: at, ...extra },
    requestKey: definition.requestKey,
  }, { at, scope });
}

function generate(db, { itemId, slot, at = slot.scheduledAt, scope = OWNER_A }) {
  return fire(db, 'agenda/occurrence-generated', {
    itemId,
    slotKey: slot.slotKey,
    definitionRevision: slot.definitionRevision,
    scheduledAt: slot.scheduledAt,
    slotEndAt: slot.slotEndAt,
    resolution: slot.resolution,
    occurrenceId: occurrenceIdFor(scopeKey(scope), itemId, slot.slotKey),
  }, { at, scope });
}

function plan(db, { scope = OWNER_A, itemId, from = T0, to = T0 + 2 * 86400000, limit = 4, now = T0 } = {}) {
  return planWindow({ item: getAgendaItem(db, scopeKey(scope), itemId), from, to, limit, now });
}

const DAILY = { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' };

test('HH04: two users, personas and worlds never see each other', t => {
  const db = newDb(t);
  // The same semantic request in two scopes is two definitions, not one shared row.
  assert.equal(createItem(db, DAILY, { itemId: 'item-a' }).inserted, true);
  assert.equal(createItem(db, DAILY, { itemId: 'item-b', scope: OWNER_B }).inserted, true);
  assert.equal(createItem(db, DAILY, { itemId: 'item-c', scope: OWNER_C }).inserted, true);

  for (const [scope, own, others] of [
    [OWNER_A, 'item-a', ['item-b', 'item-c']],
    [OWNER_B, 'item-b', ['item-a', 'item-c']],
    [OWNER_C, 'item-c', ['item-a', 'item-b']],
  ]) {
    const key = scopeKey(scope);
    const items = listAgendaItems(db, { scopeKey: key });
    assert.deepEqual(items.map(item => item.itemId), [own]);
    for (const other of others) assert.equal(getAgendaItem(db, key, other), null, `${key} must not read ${other}`);
  }

  // Occurrences stay inside their own scope too.
  const [slot] = plan(db, { itemId: 'item-a' });
  assert.equal(generate(db, { itemId: 'item-a', slot }).inserted, true);
  const occurrenceId = occurrenceIdFor(KEY_A, 'item-a', slot.slotKey);
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY_B }).length, 0);
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY_C }).length, 0);
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY_A }).length, 1);
  assert.equal(dueAgendaOccurrences(db, { scopeKey: KEY_B, at: T0 + 10 * 86400000 }).length, 0);
  assert.equal(dueAgendaOccurrences(db, { scopeKey: KEY_A, at: T0 + 10 * 86400000 }).length, 1);
  assert.equal(activeAgendaItems(db, { scopeKey: KEY_B, at: T0 }).length, 1, 'B has its own active item');
  assert.equal(agendaCounts(db, KEY_B).occurrences.scheduled, 0);

  // A state event addressed by another scope's occurrence id is refused, not applied.
  const crossScope = fire(db, 'agenda/occurrence-due', { occurrenceId, expectedRevision: 1 }, { at: slot.scheduledAt, scope: OWNER_B });
  assert.equal(crossScope.rejected, true);
  assert.equal(crossScope.results[0].code, 'occurrence-not-found');
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY_A })[0].status, 'scheduled', 'A was untouched');

  // Whole-database diagnostics still see everything, which is the only allowed overlap.
  assert.equal(agendaCounts(db).items, 3);
  assert.equal(agendaCounts(db).occurrences.scheduled, 1);
});

test('HH04: an empty world normalises to world:default, and only there', t => {
  assert.equal(normalizeScope({ userId: 'owner-1' }).worldId, 'world:default');
  assert.equal(KEY_A, 'u:owner-1|p:bot|w:world:default');
  const db = newDb(t);
  assert.equal(createItem(db, DAILY, { itemId: 'item-a', scope: { userId: 'owner-1' } }).inserted, true);
  // The explicit spelling of the default world addresses the very same row.
  const explicit = getAgendaItem(db, 'u:owner-1|p:bot|w:world:default', 'item-a');
  assert.ok(explicit);
  assert.equal(explicit.scopeKey, KEY_A);
  assert.equal(getAgendaItem(db, scopeKey({ userId: 'owner-1', worldId: 'world:game' }), 'item-a'), null);
  assert.equal(listAgendaItems(db, { scopeKey: scopeKey({ userId: 'owner-1', worldId: 'world:game' }) }).length, 0);
});

test('HH04: a forged userId/personaId/worldId/scopeKey in the payload is inert', t => {
  const db = newDb(t);
  const forgedScope = scopeKey({ userId: 'attacker', personaId: 'attacker', worldId: 'world:evil' });
  const forged = {
    userId: 'attacker',
    personaId: 'attacker',
    worldId: 'world:evil',
    scopeKey: forgedScope,
    scope: { userId: 'attacker' },
  };
  const created = createItem(db, DAILY, { itemId: 'item-a', extra: forged });
  assert.equal(created.inserted, true, JSON.stringify(created.results));

  const item = getAgendaItem(db, KEY_A, 'item-a');
  assert.equal(item.scopeKey, KEY_A, 'the row belongs to the trusted event scope');
  assert.equal(db.get('SELECT scope FROM agenda_items WHERE item_id = ?', 'item-a').scope, KEY_A);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM agenda_items WHERE scope = ?', forgedScope).n, 0);
  assert.equal(getAgendaItem(db, forgedScope, 'item-a'), null);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM scope_snapshots WHERE scope = ?', forgedScope).n, 0,
    'the forged scope never gets a projection');
  assert.ok(db.projection(KEY_A).payload.agenda, 'the trusted scope owns the projection');

  // A payload field called `scope`/`scopeKey` cannot redirect an occurrence either.
  const [slot] = plan(db, { itemId: 'item-a' });
  const generated = fire(db, 'agenda/occurrence-generated', {
    itemId: 'item-a',
    slotKey: slot.slotKey,
    definitionRevision: 1,
    scheduledAt: slot.scheduledAt,
    slotEndAt: slot.slotEndAt,
    scopeKey: forgedScope,
    scope: { userId: 'attacker' },
  }, { at: slot.scheduledAt });
  assert.equal(generated.inserted, true);
  assert.equal(db.get('SELECT scope FROM agenda_occurrences WHERE item_id = ?', 'item-a').scope, KEY_A);
  assert.equal(listAgendaOccurrences(db, { scopeKey: forgedScope }).length, 0);
});

test('HH04: an itemId is globally unique, so one scope cannot hijack another row', t => {
  const db = newDb(t);
  assert.equal(createItem(db, DAILY, { itemId: 'item-shared' }).inserted, true);
  const hijack = createItem(db, { ...DAILY, title: 'other' }, { itemId: 'item-shared', scope: OWNER_B });
  assert.equal(hijack.rejected, true, 'a duplicate primary key is refused instead of overwriting');
  assert.equal(hijack.results[0].code, 'duplicate-request');
  assert.equal(getAgendaItem(db, KEY_A, 'item-shared').title, '散步', 'the original row is untouched');
  assert.equal(getAgendaItem(db, KEY_B, 'item-shared'), null);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM agenda_items').n, 1);
});

test('HH04: queries are always scope-scoped and bounded', t => {
  const db = newDb(t);
  for (const [scope, itemId] of [[OWNER_A, 'item-a'], [OWNER_B, 'item-b'], [OWNER_C, 'item-c']]) {
    createItem(db, DAILY, { itemId, scope });
    const [slot] = plan(db, { scope, itemId });
    generate(db, { itemId, slot, scope });
  }
  const all = new Set(['item-a', 'item-b', 'item-c']);
  for (const scope of [OWNER_A, OWNER_B, OWNER_C]) {
    const key = scopeKey(scope);
    const items = listAgendaItems(db, { scopeKey: key });
    assert.equal(items.length, 1);
    const occurrences = listAgendaOccurrences(db, { scopeKey: key });
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0].itemId, items[0].itemId);
    assert.equal(occurrences[0].scopeKey, key);
    for (const row of [...items, ...occurrences]) {
      assert.equal(row.scopeKey, key);
      assert.ok(all.has(row.itemId));
    }
    assert.equal(activeAgendaItems(db, { scopeKey: key, at: T0 }).length, 1);
    assert.equal(dueAgendaOccurrences(db, { scopeKey: key, at: T0 + 5 * 86400000 }).length, 1);
    assert.equal(listAgendaOccurrences(db, { scopeKey: key, limit: 1 }).length, 1, 'the limit is honoured');
  }
  assert.throws(() => getAgendaItem(db, '', 'item-a'), /scopeKey is required/);
  // An unknown or malformed scope key is empty, never a wildcard.
  assert.deepEqual(listAgendaOccurrences(db, { scopeKey: 'u:owner-1' }), []);
  assert.deepEqual(listAgendaItems(db, { scopeKey: 'u:nobody|p:nobody|w:nowhere' }), []);
  assert.equal(getAgendaItem(db, 'u:nobody|p:nobody|w:nowhere', 'item-a'), null);
});
