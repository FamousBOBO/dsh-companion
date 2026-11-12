/** Life-evidence reader: a plan is never an occurrence.
 *
 * The brief (§5.2 / §10) is explicit that `companion_schedule_*` and the P2 plan are
 * *plans*, and that treating a plan as something that already happened is a correctness
 * bug. These tests pin that, plus the two properties that keep the wardrobe from breaking a
 * chat turn: every runtime call degrades instead of throwing, and a missing/disabled
 * runtime yields no evidence rather than an invented one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeEntry } from './wardrobe-context.mjs';
import { collectLifeEvidence, hasLiveEvidence, reminderDelivery } from './wardrobe-evidence.mjs';

const NOW = new Date('2026-11-10T22:40:00+08:00').getTime();
const around = (beforeMs = 60_000, afterMs = 60_000) => ({ startAt: NOW - beforeMs, endAt: NOW + afterMs });

function runtime({ activities = [], slots = [], occurrences = [], agendaItems = [], agendaEnabled = true } = {}) {
  return {
    listActivities: () => ({ ok: true, activities }),
    listPlan: () => ({ ok: true, slots }),
    todaySchedule: () => ({ ok: true, enabled: agendaEnabled, state: agendaEnabled ? 'active' : 'disabled', occurrences, items: agendaItems }),
  };
}

test('没有 runtime、runtime 抛异常、runtime 返回 Promise 都不抛出去', () => {
  assert.equal(collectLifeEvidence({ runtime: null }).state, 'inactive');
  assert.equal(hasLiveEvidence(collectLifeEvidence({ runtime: null })), false);

  const throwing = collectLifeEvidence({
    runtime: { listActivities() { throw new Error('boom'); }, listPlan() { throw new Error('boom'); }, todaySchedule() { throw new Error('boom'); } },
  });
  assert.equal(throwing.state, 'inactive');
  assert.equal(throwing.activity, null);
  assert.equal(throwing.schedule, null);
  assert.ok(throwing.reasons.every(reason => /call-failed/.test(reason)), JSON.stringify(throwing.reasons));

  // An async implementation would silently be a floating promise; it is refused, not awaited.
  const asyncRuntime = collectLifeEvidence({ runtime: { listActivities: async () => ({ ok: true, activities: [] }) } });
  assert.match(asyncRuntime.reasons.join(' '), /async-unexpected/);
});

test('正在运行的 P2 活动是证据；只有 planned 的计划槽位不是', () => {
  const running = collectLifeEvidence({
    runtime: runtime({
      activities: [{ activityId: 'a1', kind: 'read', status: 'running', target: '读《春晓》', startedAt: NOW - 120_000, updatedAt: NOW }],
      // A slot planned for *later tonight*: its window does not contain now.
      slots: [{ slotId: 's1', startAt: NOW + 3_600_000, endAt: NOW + 7_200_000, kind: 'activity', activity: 'explore', title: '晚饭后散步', status: 'planned' }],
    }),
    now: NOW,
  });
  assert.equal(running.activity.kind, 'read');
  assert.equal(running.plan, null, '未来的 planned 槽位不能当成正在发生');
  assert.match(running.reasons.join(' '), /p2-slot-planned-not-happening/);

  const paused = collectLifeEvidence({
    runtime: runtime({ activities: [{ activityId: 'a2', kind: 'write', status: 'paused', target: '写日记', startedAt: NOW - 300_000, updatedAt: NOW }] }),
    now: NOW,
  });
  assert.equal(paused.activity.kind, 'write', 'paused 仍然是当前活动');
});

test('窗口包含现在的计划槽位可以作为日程证据', () => {
  // `planned` is the P2 vocabulary for "not started yet". A slot whose *window* contains now
  // but whose status is still `planned` is ambiguous — the plan says it should be happening,
  // not that it is — so it is deliberately NOT used as an activity. What may be used is an
  // occurrence the agenda actually marked current (`due`).
  const plannedNow = collectLifeEvidence({
    runtime: runtime({
      slots: [{ ...around(), slotId: 's2', kind: 'activity', activity: 'explore', title: '出门散步', status: 'planned' }],
    }),
    now: NOW,
  });
  assert.equal(plannedNow.activity, null, 'planned 不是运行中的活动');
  assert.match(plannedNow.reasons.join(' '), /p2-slot-current|p2-slot-planned-not-happening/);

  const startedSlot = collectLifeEvidence({
    runtime: runtime({
      slots: [{ ...around(), slotId: 's3', kind: 'activity', activity: 'explore', title: '出门散步', status: 'started' }],
    }),
    now: NOW,
  });
  assert.ok(startedSlot.schedule, 'started 的槽位是正在发生的证据');
  assert.equal(startedSlot.schedule.title, '出门散步');
  assert.equal(startedSlot.schedule.source, 'p2-plan');
});

test('H1 日程：只有未终结、且窗口包含现在的 occurrence 才算', () => {
  const live = collectLifeEvidence({
    runtime: runtime({
      occurrences: [{ occurrenceId: 'o1', itemId: 'i1', scheduledAt: NOW - 1000, slotEndAt: NOW + 600_000, status: 'due' }],
      agendaItems: [{ itemId: 'i1', title: '看书', category: 'plan' }],
    }),
    now: NOW,
  });
  assert.equal(live.schedule.title, '看书');
  assert.equal(live.schedule.source, 'h1-agenda');

  const terminal = collectLifeEvidence({
    runtime: runtime({
      occurrences: [{ occurrenceId: 'o2', itemId: 'i1', scheduledAt: NOW - 1000, slotEndAt: NOW + 600_000, status: 'dispatched' }],
      agendaItems: [{ itemId: 'i1', title: '看书', category: 'plan' }],
    }),
    now: NOW,
  });
  assert.equal(terminal.schedule, null, 'dispatched 是终结状态');

  const future = collectLifeEvidence({
    runtime: runtime({
      occurrences: [{ occurrenceId: 'o3', itemId: 'i1', scheduledAt: NOW + 3_600_000, slotEndAt: NOW + 7_200_000, status: 'scheduled' }],
      agendaItems: [{ itemId: 'i1', title: '晚上出门吃饭', category: 'plan' }],
    }),
    now: NOW,
  });
  assert.equal(future.schedule, null);
});

test('日程开关关闭时如实报告，不伪造活动', () => {
  const evidence = collectLifeEvidence({
    runtime: runtime({ agendaEnabled: false, occurrences: [{ occurrenceId: 'o1', itemId: 'i1', scheduledAt: NOW - 1, slotEndAt: NOW + 1000, status: 'due' }] }),
    now: NOW,
  });
  assert.equal(evidence.schedule, null);
  assert.match(evidence.reasons.join(' '), /agenda-disabled/);
});

test('activeEntry 拒绝缺窗口与终结状态', () => {
  assert.equal(activeEntry({ status: 'running' }, NOW), null, '没有时间窗口不是证据');
  assert.equal(activeEntry({ status: 'done', startAt: NOW - 1, endAt: NOW + 1 }, NOW), null);
  assert.equal(activeEntry({ status: 'skipped', startAt: NOW - 1, endAt: NOW + 1 }, NOW), null);
  assert.equal(activeEntry({ status: 'cancelled', startAt: NOW - 1, endAt: NOW + 1 }, NOW), null);
  assert.equal(activeEntry({ status: 'expired', startAt: NOW - 1, endAt: NOW + 1 }, NOW), null);
  assert.equal(activeEntry({ status: 'superseded', startAt: NOW - 1, endAt: NOW + 1 }, NOW), null);
  assert.equal(activeEntry({ status: 'running', startAt: NOW - 1, endAt: NOW + 1 }, NOW).status, 'running');
  assert.equal(activeEntry({ status: 'running', startAt: NOW + 1, endAt: NOW + 2 }, NOW), null, '还没开始');
});

test('reminderDelivery 恒为 not-wired（衣柜升级不引入投递路径）', () => {
  assert.equal(reminderDelivery, 'not-wired');
});
