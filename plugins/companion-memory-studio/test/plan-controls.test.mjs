import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLife } from '../lib/companion-dashboard.mjs';

// H5 (blocking-7): the plan page must offer lock/skip on slots that are still ahead of us and
// still `planned`, show the lock state of a locked slot, and offer nothing on a slot that has
// already started, ended, expired or been skipped. These assertions run against the exact view
// model the page renders from (`life.next` / `life.ended` / `life.pending`), so a control that
// disappears from the data cannot be re-introduced by the UI.

const NOW = Date.UTC(2026, 9, 30, 6, 0, 0);
const MIN = 60000;
const PLAN = { plan_id: 'plan_v1', day: '2026-10-30', version: 1, status: 'committed', window_start: NOW - 120 * MIN, window_end: NOW + 600 * MIN, summary: '一天' };
const config = { p2: { planning: { enabled: true }, activities: { enabled: true } } };

function slot(overrides) {
  return {
    slot_id: 'slot-x', plan_id: 'plan_v1', start_at: NOW + 60 * MIN, end_at: NOW + 120 * MIN,
    kind: 'activity', activity: 'read', title: '读一段', flexibility: 'soft', status: 'planned', locked: 0,
    ...overrides,
  };
}

function life(slots) {
  return buildLife({ sections: { p2_plan: [PLAN], p2_slots: slots, p2_activities: [], p2_receipts: [] } }, config, NOW);
}

test('H5: an upcoming planned slot offers lock and skip', () => {
  const view = life([slot({ slot_id: 'slot-next' })]);
  const next = view.next.find(s => s.slotId === 'slot-next');
  assert.ok(next, 'the future slot is in the plan');
  assert.equal(next.locked, false);
  assert.deepEqual(next.controls, ['lock', 'skip']);
  assert.equal(view.planControls.enabled, true);
});

test('H5: a locked slot renders its lock state and offers unlock (not lock)', () => {
  const view = life([slot({ slot_id: 'slot-locked', locked: 1 })]);
  const next = view.next.find(s => s.slotId === 'slot-locked');
  assert.equal(next.locked, true, 'the page can render the lock badge');
  assert.deepEqual(next.controls, ['unlock', 'skip']);
});

test('H5: a skipped slot does not render controls', () => {
  const view = life([slot({ slot_id: 'slot-skipped', status: 'skipped', locked: 1 })]);
  const all = [...view.next, ...view.ended, ...view.pending, ...(view.skipped ?? [])];
  const found = all.find(s => s.slotId === 'slot-skipped');
  assert.ok(found, 'the skipped slot is still visible in the day');
  assert.equal(found.controls, null, 'a skipped slot offers no controls');
});

test('H5: a started (or ended) slot does not render controls', () => {
  const view = life([
    slot({ slot_id: 'slot-started', status: 'started', start_at: NOW + 10 * MIN, end_at: NOW + 70 * MIN }),
    slot({ slot_id: 'slot-done', status: 'done', start_at: NOW - 60 * MIN, end_at: NOW - 10 * MIN }),
    slot({ slot_id: 'slot-current', status: 'planned', start_at: NOW - 10 * MIN, end_at: NOW + 20 * MIN }),
  ]);
  const all = [...view.next, ...view.ended, ...view.pending];
  for (const id of ['slot-started', 'slot-done', 'slot-current']) {
    const found = all.find(s => s.slotId === id);
    if (found) assert.equal(found.controls, null, `${id} must not offer lock/skip`);
  }
  assert.equal(view.current.slot?.slotId, 'slot-current', 'the slot already under way is the current one');
  assert.equal(view.current.slot?.controls, null, 'the current slot is not editable');
});

test('H5: an expired slot that never started is not editable either', () => {
  const view = life([slot({ slot_id: 'slot-expired', status: 'expired', start_at: NOW - 90 * MIN, end_at: NOW - 30 * MIN })]);
  const found = [...view.next, ...view.ended, ...view.pending].find(s => s.slotId === 'slot-expired');
  assert.ok(found, 'the missed slot shows up');
  assert.equal(found.controls, null);
});

test('H5: the controls are gated on planning being switched on', () => {
  const off = buildLife({ sections: { p2_plan: [PLAN], p2_slots: [slot({ slot_id: 'slot-next' })], p2_activities: [], p2_receipts: [] } }, { p2: { planning: { enabled: false } } }, NOW);
  assert.equal(off.planControls.enabled, false);
});
