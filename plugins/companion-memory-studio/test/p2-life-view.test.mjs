import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLife } from '../lib/companion-dashboard.mjs';

// H5 life view (P2-17): four groups, honest state, no plan bodies leaking into the page.
// `buildLife` is a pure function over the read rows, so this is a real unit test of the
// grouping rules rather than a database exercise (the dashboard's own 30-test API suite
// covers the wiring).

const NOW = Date.UTC(2026, 10, 2, 6, 0, 0); // 14:00 Asia/Shanghai
const PLAN = { plan_id: 'plan_1', day: '2026-11-02', version: 2, status: 'committed', window_start: NOW - 5 * 3600e3, window_end: NOW + 5 * 3600e3, summary: '今天想读一点东西，再写一小段。' };

function result(sections = {}) {
  return { sections: { p2_plan: [PLAN], p2_slots: [], p2_activities: [], p2_receipts: [], p2_share: [], p2_interests: [], p2_opportunities: [], ...sections } };
}

test('P2-17: current / next / ended / pending are separated by real instants', () => {
  const life = buildLife(result({
    p2_slots: [
      { slot_id: 's1', plan_id: 'plan_1', start_at: NOW - 3600e3, end_at: NOW + 1800e3, kind: 'activity', activity: 'read', title: '读材料', flexibility: 'soft', status: 'started' },
      { slot_id: 's2', plan_id: 'plan_1', start_at: NOW + 3600e3, end_at: NOW + 7200e3, kind: 'activity', activity: 'write', title: '写一段', flexibility: 'soft', status: 'planned' },
      { slot_id: 's3', plan_id: 'plan_1', start_at: NOW - 7200e3, end_at: NOW - 3600e3, kind: 'open', title: '留白', flexibility: 'soft', status: 'done' },
      { slot_id: 's4', plan_id: 'plan_1', start_at: NOW - 1800e3, end_at: NOW + 600e3, kind: 'activity', activity: 'explore', title: '看看材料', flexibility: 'soft', status: 'planned' },
    ],
    p2_activities: [
      { activity_id: 'a1', kind: 'read', status: 'running', reality: 'actual_tool_activity', target: 'sources/a.md', consumed_prefix: 400, total_units: 1200, artifact_version: 0, source_hash: 'abcdef0123456789', updated_at: NOW },
    ],
  }), { p2: { planning: { enabled: true }, activities: { enabled: true } } }, NOW);

  assert.equal(life.state, 'running');
  assert.equal(life.current.slot?.slotId, 's1', 'the slot covering now is current');
  assert.deepEqual(life.next.map(slot => slot.slotId), ['s2'], 'only future slots are up next');
  assert.deepEqual(life.ended.map(slot => slot.slotId), ['s3'], 'a finished slot is ended');
  assert.deepEqual(life.pending.map(slot => slot.slotId), ['s4'], 'a missed window is unfinished, not done');
  assert.equal(life.current.activities[0].consumed, 400);
  assert.equal(life.current.activities[0].total, 1200);
  assert.equal(life.current.activities[0].reality, 'actual_tool_activity');
  assert.equal(life.current.activities[0].sourceHash.length, 16, 'only a hash prefix is exposed');
});

test('P2-17: "no autonomy" and "no plan yet" are different states', () => {
  // With the switch off there is no plan row at all, so the page must not claim one.
  const off = buildLife({ sections: { p2_plan: [], p2_slots: [], p2_activities: [], p2_receipts: [], p2_share: [], p2_interests: [], p2_opportunities: [] } }, { p2: { planning: { enabled: false } } }, NOW);
  assert.equal(off.state, 'no-autonomy');
  assert.equal(off.switches.planning, false);

  const onButEmpty = buildLife({ sections: { p2_plan: [], p2_slots: [], p2_activities: [], p2_receipts: [], p2_share: [], p2_interests: [], p2_opportunities: [] } }, { p2: { planning: { enabled: true } } }, NOW);
  assert.equal(onButEmpty.state, 'no-plan');
  assert.equal(onButEmpty.plan, null);
});

test('P2-17/28: the life view carries no plan body and no artifact text', () => {
  const longSummary = '这是一段非常长的计划说明'.repeat(40);
  const life = buildLife({
    sections: {
      p2_plan: [{ ...PLAN, summary: longSummary }],
      p2_slots: [{ slot_id: 's1', plan_id: 'plan_1', start_at: NOW, end_at: NOW + 600e3, kind: 'activity', activity: 'write', title: '写一段', flexibility: 'soft', status: 'planned' }],
      p2_activities: [], p2_receipts: [], p2_share: [], p2_interests: [], p2_opportunities: [],
    },
  }, { p2: { planning: { enabled: true } } }, NOW);
  assert.ok(life.plan.summary.length <= 300);
  const serialized = JSON.stringify(life);
  assert.ok(!serialized.includes('正文'), 'no artifact body is exposed');
  assert.ok(!serialized.includes('checkpoint'), 'no checkpoint payload is exposed');
});

test('P2-18: share pending count only counts pending candidates and the switch is reported', () => {
  const life = buildLife(result({
    p2_share: [
      { candidate_id: 'c1', title: '分享一', status: 'pending', created_at: NOW },
      { candidate_id: 'c2', title: '分享二', status: 'submitted', created_at: NOW },
    ],
  }), { p2: { planning: { enabled: true }, share: { enabled: true } } }, NOW);
  assert.equal(life.share.pending, 1);
  assert.equal(life.share.enabled, true);
  assert.equal(life.switches.share, true);
});

test('P2-14: a simulated activity is labelled in the life view, never as real', () => {
  const life = buildLife(result({
    p2_activities: [
      { activity_id: 'a2', kind: 'read', status: 'paused', reality: 'simulated_world', target: '模拟的一段', consumed_prefix: 10, total_units: 100, artifact_version: 0, source_hash: '', updated_at: NOW },
    ],
  }), { p2: { planning: { enabled: true }, activities: { enabled: true } } }, NOW);
  assert.equal(life.current.activities[0].reality, 'simulated_world');
});
