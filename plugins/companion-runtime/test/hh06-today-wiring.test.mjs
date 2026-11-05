import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';

// HH06 (public-surface half): `todaySchedule` must resolve "today" in each schedule's own
// zone, so a 00:30 Asia/Shanghai plan is tomorrow's plan while the host clock is still on the
// previous UTC day, and a plan in another zone is grouped by its own calendar day.

const BOUND = { userId: 'owner-1' };

function buildRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh06-today-'));
  for (const dir of ['home/companion', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', agenda: { enabled: true }, heartbeat: { enabled: false },
    // The fixtures below jump the injected clock by whole days to age a slot into history. Under
    // P2.5-4A the writer lease is a real time fence (an expired lease cannot be renewed, only
    // taken over), so the fixture gives it a TTL that covers the simulated jumps instead of
    // pretending a lapsed writer may still commit. Same convention as the heartbeat tests.
    leaseTtlMs: 30 * 24 * 3600 * 1000,
  }));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

const identity = () => ({ resolve: sessionId => ({ userId: 'owner-1', persona: 'march7', sessionId }) });

test('HH06: today is computed in the schedule zone, not by the host UTC date', t => {
  // 2026-10-30T16:10Z is 2026-10-31 00:10 Asia/Shanghai: the host UTC date is still the 30th.
  const clock = Date.UTC(2026, 9, 30, 16, 10);
  const runtime = mountRuntime(null, buildRoot(t), { now: () => clock, identity: identity() });
  t.after(() => runtime.dispose());

  const shanghai = runtime.createSchedule({ bound: BOUND, title: '半夜散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '00:30' });
  assert.equal(shanghai.ok, true, JSON.stringify(shanghai));
  // 16:10Z is 09:10 in Los Angeles, so that plan's own 'today' is still the 30th.
  const la = runtime.createSchedule({ bound: BOUND, title: 'la plan', rule: 'daily', timeZone: 'America/Los_Angeles', time: '10:00' });
  assert.equal(la.ok, true, JSON.stringify(la));

  const today = runtime.todaySchedule({ bound: BOUND });
  assert.equal(today.ok, true, JSON.stringify(today));

  // The Shanghai plan's own "today" is 2026-10-31 (it is already the 31st there).
  const shanghaiGroup = today.items.find(group => group.itemId === shanghai.itemId);
  assert.ok(shanghaiGroup, 'the Shanghai definition appears in today');
  assert.equal(shanghaiGroup.localDate, '2026-10-31');
  assert.equal(shanghaiGroup.occurrences.length, 1);
  assert.equal(shanghaiGroup.occurrences[0].scheduledLocal, '2026-10-31 00:30');

  // The Los Angeles plan's own 'today' is 2026-10-30 — a different calendar day in the same call.
  const laGroup = today.items.find(group => group.itemId === la.itemId);
  assert.ok(laGroup, 'the Los Angeles definition appears in today');
  assert.equal(laGroup.localDate, '2026-10-30');
  assert.equal(laGroup.occurrences[0].scheduledLocal, '2026-10-30 10:00');
  assert.deepEqual([...today.localDates].sort(), ['2026-10-30', '2026-10-31']);

  // An explicit date is honoured per definition zone, and a wrong-day query returns nothing.
  const requested = runtime.todaySchedule({ bound: BOUND, date: '2026-10-31' });
  // Both definitions have a 2026-10-31 slot in their own zone; every returned group must be
  // labelled with exactly the requested date.
  assert.deepEqual([...new Set(requested.items.map(group => group.localDate))], ['2026-10-31']);
  assert.equal(requested.items.filter(group => group.occurrences.length).length, 2);
  const empty = runtime.todaySchedule({ bound: BOUND, date: '2026-12-25' });
  assert.equal(empty.ok, true);
  assert.equal(empty.occurrences.length, 0);
  assert.equal(runtime.todaySchedule({ bound: BOUND, date: '31-10-2026' }).ok, false);

  // The occurrence that is "today" in Shanghai really is the one the heartbeat will settle at
  // its own instant: its UTC time is 2026-10-30T16:30Z, not the 30th 00:30 local.
  assert.equal(shanghaiGroup.occurrences[0].scheduledAt, Date.UTC(2026, 9, 30, 16, 30));
  assert.equal(shanghaiGroup.occurrences[0].timeZone, 'Asia/Shanghai');
});

test('HH06: a timezone edit needs the preview handshake and moves only future unexecuted slots', t => {
  let clock = Date.UTC(2026, 9, 30, 1, 0); // 09:00 Shanghai
  const runtime = mountRuntime(null, buildRoot(t), { now: () => clock, identity: identity() });
  t.after(() => runtime.dispose());

  const created = runtime.createSchedule({ bound: BOUND, title: '健身', rule: 'daily', timeZone: 'Asia/Shanghai', time: '18:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const before = created.occurrences.map(row => ({ slot: row.slotKey, at: row.scheduledAt }));
  assert.ok(before.length >= 2);
  const firstInstant = before[0].at;

  // Move the clock past the first slot so it counts as history, then change the zone.
  clock += 24 * 3600 * 1000;
  const listed = runtime.listSchedule({ bound: BOUND });
  const item = listed.items[0];
  const preview = runtime.updateSchedule({ bound: BOUND, itemId: item.itemId, expectedRevision: item.revision, timeZone: 'UTC' });
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'preview-required');
  assert.equal(preview.preview.futurePlanned.length >= 1, true, 'the preview shows the future plan it would create');

  const committed = runtime.updateSchedule({ bound: BOUND, itemId: item.itemId, expectedRevision: item.revision, timeZone: 'UTC', previewToken: preview.preview.previewToken });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(committed.item.timeZone, 'UTC');
  assert.equal(committed.rescheduled + committed.generated >= 1, true);

  const after = runtime.listSchedule({ bound: BOUND });
  const past = after.occurrences.filter(row => row.scheduledAt < clock);
  assert.ok(past.every(row => row.scheduledAt >= firstInstant), 'history is not rewritten by the timezone change');
  const future = after.occurrences.filter(row => row.status === 'scheduled' && row.scheduledAt >= clock);
  assert.ok(future.length >= 1, 'future slots are recomputed');
  assert.ok(future.every(row => row.timeZone === 'UTC'), 'recomputed slots follow the new zone');
  // No duplicate slot keys and no ghost schedule for the same local date.
  const keys = after.occurrences.map(row => `${row.itemId}|${row.slotKey}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicated (item,slot) pair');
});
