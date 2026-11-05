// C2 working memory — A03 (10 fixed interruption/switch/return cases), A04 (budget
// compression, restart, cross-scope isolation) and the A06 commitment half, plus the
// focus/checkpoint/render contracts. Every test uses :memory: or a temp file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey } from '../lib/scope.mjs';
import { StaleRevisionError } from '../lib/errors.mjs';
import { applyEvent, consumersFor, dispatchEvent, listEvents, receiptFor } from '../lib/events.mjs';
import {
  applyGoalEvent,
  closeCommitment,
  createCommitment,
  getGoal,
  listCommitments,
  listGoals,
  markOverdue,
  proposeGoal,
  recordStep,
  transitionGoal,
  updateGoal,
} from '../lib/goals.mjs';
import {
  applyWorkingMemoryEvent,
  checkpointGoal,
  currentFocus,
  focusGoal,
  renderWorkingMemory,
  renderWorkingMemoryDetailed,
  resumeGoal,
  switchGoal,
  workingMemoryState,
} from '../lib/working-memory.mjs';

const SCOPE = { userId: 'u-wm', personaId: 'bot', worldId: 'w-wm' };
const OTHER = { userId: 'u-wm-other', personaId: 'bot', worldId: 'w-wm-other' };
const DAY = 86400000;
const HANDLERS = { goals: applyGoalEvent, 'working-memory': applyWorkingMemoryEvent };

function makeClock(start = 1_760_000_000_000) {
  const clock = {
    value: start,
    tick(ms = 60000) { clock.value += ms; return clock.value; },
  };
  return clock;
}

function openMemory(clock) {
  return openRuntimeDb({ file: ':memory:', now: () => clock.value });
}

function createRunning(db, clock, scope, options = {}) {
  const key = scopeKey(scope);
  const collection = listGoals(db, { scopeKey: key, includeClosed: true });
  const created = proposeGoal(db, {
    scope,
    title: options.title ?? '目标',
    source: options.source ?? 'test',
    authorization: options.authorization ?? 'none',
    deadlineAt: options.deadlineAt ?? null,
    nextStep: options.nextStep ?? '',
    now: clock.tick(),
    expectedRevision: collection.revision,
  });
  for (const to of ['accepted', 'running']) {
    transitionGoal(db, { scope, goalId: created.goalId, to, expectedRevision: getGoal(db, key, created.goalId).revision, now: clock.tick() });
  }
  if (options.waitingOn) {
    updateGoal(db, {
      scope, goalId: created.goalId, patch: { waitingOn: options.waitingOn },
      expectedRevision: getGoal(db, key, created.goalId).revision, now: clock.tick(),
    });
  }
  for (const step of options.steps ?? []) {
    recordStep(db, { scope, goalId: created.goalId, step, expectedRevision: getGoal(db, key, created.goalId).revision, now: clock.tick() });
  }
  return created.goalId;
}

function checkpointRows(db, key) {
  return db.all('SELECT rowid AS row_id, * FROM wm_checkpoints WHERE scope = ? ORDER BY created_at ASC, row_id ASC', key);
}

function focusRevision(db, key) {
  return currentFocus(db, key).revision;
}

// ------------------------------------------------------------------ A03 driver

function applyOp(ctx, op) {
  const { db, clock, scope, key, ids, results } = ctx;
  const revisionOfGoal = name => getGoal(db, key, ids[name]).revision;
  switch (op.op) {
    case 'goal': {
      const created = proposeGoal(db, {
        scope,
        title: op.title,
        source: 'A03',
        authorization: 'none',
        deadlineAt: op.deadlineOffset === undefined ? null : clock.value + op.deadlineOffset,
        nextStep: op.nextStep ?? '',
        now: clock.tick(),
        expectedRevision: listGoals(db, { scopeKey: key, includeClosed: true }).revision,
      });
      ids[op.id] = created.goalId;
      for (const to of ['accepted', 'running']) {
        transitionGoal(db, { scope, goalId: created.goalId, to, expectedRevision: revisionOfGoal(op.id), now: clock.tick() });
      }
      if (op.waitingOn) {
        updateGoal(db, { scope, goalId: created.goalId, patch: { waitingOn: op.waitingOn }, expectedRevision: revisionOfGoal(op.id), now: clock.tick() });
      }
      for (const step of op.steps ?? []) {
        recordStep(db, { scope, goalId: created.goalId, step, expectedRevision: revisionOfGoal(op.id), now: clock.tick() });
      }
      return;
    }
    case 'focus':
    case 'keep':
      results[op.store ?? 'last'] = focusGoal(db, {
        scope, goalId: ids[op.goal], expectedRevision: focusRevision(db, key), now: clock.tick(),
      });
      return;
    case 'switch':
      results[op.store ?? 'last'] = switchGoal(db, {
        scope, goalId: ids[op.goal], expectedRevision: focusRevision(db, key), now: clock.tick(),
      });
      return;
    case 'resume':
      results[op.store ?? 'last'] = resumeGoal(db, {
        scope,
        ...(op.goal ? { goalId: ids[op.goal] } : {}),
        expectedRevision: focusRevision(db, key),
        now: clock.tick(),
      });
      return;
    case 'pause':
    case 'complete':
    case 'cancel':
      transitionGoal(db, {
        scope,
        goalId: ids[op.goal],
        to: op.op === 'pause' ? 'paused' : op.op === 'complete' ? 'completed' : 'cancelled',
        expectedRevision: revisionOfGoal(op.goal),
        reason: 'a03',
        now: clock.tick(),
      });
      return;
    case 'step':
      recordStep(db, { scope, goalId: ids[op.goal], step: op.text, expectedRevision: revisionOfGoal(op.goal), now: clock.tick() });
      return;
    case 'interject':
      dispatchEvent(db, {
        kind: 'topic/interjection', scope, occurredAt: clock.tick(), payload: { note: op.note },
      }, { handlers: HANDLERS });
      return;
    case 'overdue':
      markOverdue(db, { scopeKey: key, now: clock.tick() });
      return;
    default:
      throw new Error(`unknown A03 op: ${op.op}`);
  }
}

function assertRecovered(ctx) {
  const { db, clock, scope, key, ids, results, spec } = ctx;
  const expect = spec.expect;
  const state = workingMemoryState(db, { scopeKey: key, now: clock.value });

  if (expect.focus === null) {
    assert.equal(state.focusGoalId, '', `${spec.id}: expected no focus`);
    assert.equal(state.goal, null, `${spec.id}: expected no focused goal`);
  } else {
    assert.equal(state.focusGoalId, ids[expect.focus], `${spec.id}: wrong restored focus`);
    assert.equal(state.goal.goalId, ids[expect.focus]);
    assert.equal(state.goal.title, expect.title, `${spec.id}: wrong title`);
    assert.equal(state.goal.status, expect.status, `${spec.id}: wrong status`);
    assert.deepEqual(state.goal.doneSteps, expect.doneSteps, `${spec.id}: wrong completed steps`);
    assert.equal(state.goal.nextStep, expect.nextStep ?? '', `${spec.id}: wrong next step`);
    assert.equal(state.goal.waitingOn, expect.waitingOn ?? '', `${spec.id}: wrong waiting condition`);
    if ('overdue' in expect) assert.equal(state.goal.overdue, expect.overdue, `${spec.id}: wrong overdue flag`);
  }
  if (expect.statuses) {
    for (const [name, status] of Object.entries(expect.statuses)) {
      assert.equal(getGoal(db, key, ids[name]).status, status, `${spec.id}: ${name} should stay ${status}`);
    }
  }
  if (expect.checkpoints) {
    assert.deepEqual(
      checkpointRows(db, key).map(row => row.goal_id),
      expect.checkpoints.map(name => ids[name]),
      `${spec.id}: checkpoint order`,
    );
  }
  if (expect.checkpointPayload) {
    const rows = checkpointRows(db, key);
    for (const [name, wanted] of Object.entries(expect.checkpointPayload)) {
      const payload = JSON.parse(rows.find(row => row.goal_id === ids[name]).payload);
      for (const [field, value] of Object.entries(wanted)) {
        assert.deepEqual(payload[field], value, `${spec.id}: checkpoint ${name}.${field}`);
      }
    }
  }
  if (expect.ambiguous) {
    const ambiguous = results.ambiguous;
    assert.equal(ambiguous.ok, false, `${spec.id}: ambiguous resume must not guess`);
    assert.equal(ambiguous.code, expect.ambiguous.code);
    assert.equal(ambiguous.candidates.length, expect.ambiguous.candidates);
    for (const candidate of ambiguous.candidates) {
      assert.ok(candidate.goalId && candidate.title && candidate.status, `${spec.id}: candidate carries id, title, status`);
    }
  }
  if (expect.kept !== undefined) assert.equal(results.last.kept, expect.kept, `${spec.id}: keep must not move anything`);

  // Already-confirmed steps are never redone.
  if (state.focusGoalId) {
    const goal = getGoal(db, key, state.focusGoalId);
    const first = goal.completedSteps[0];
    if (first) {
      const again = recordStep(db, { scope, goalId: goal.goalId, step: first, expectedRevision: goal.revision, now: clock.tick() });
      assert.equal(again.duplicated, true, `${spec.id}: a confirmed step is a duplicate`);
      const after = getGoal(db, key, goal.goalId);
      assert.equal(after.revision, goal.revision, `${spec.id}: re-confirming a step must not advance the revision`);
      assert.deepEqual(after.completedSteps, goal.completedSteps, `${spec.id}: confirmed steps must not be redone`);
    }
  }
  const rendered = renderWorkingMemory(db, { scopeKey: key, budgetChars: 320, now: clock.value });
  assert.ok(rendered.length <= 320, `${spec.id}: render stays inside the budget`);
}

const A03_CASES = [
  {
    id: 'A03-01',
    name: '插话只做局部更新，返回时目标、进度、下一步与等待条件都不变',
    actions: [
      { op: 'goal', id: 'A', title: '整理旅行清单', nextStep: '确认机票日期', waitingOn: '她确认周末时间', steps: ['查天气', '列装备'] },
      { op: 'focus', goal: 'A' },
      { op: 'interject', note: '顺便看看快递到哪了' },
    ],
    expect: {
      focus: 'A', title: '整理旅行清单', status: 'running', doneSteps: ['查天气', '列装备'],
      nextStep: '确认机票日期', waitingOn: '她确认周末时间', overdue: false, checkpoints: [],
    },
  },
  {
    id: 'A03-02',
    name: '切到新任务后关注新目标，旧目标先存检查点',
    actions: [
      { op: 'goal', id: 'A', title: '写周报', nextStep: '补数据', steps: ['列提纲'] },
      { op: 'focus', goal: 'A' },
      { op: 'goal', id: 'B', title: '回邮件', nextStep: '发出去', steps: ['读邮件'] },
      { op: 'switch', goal: 'B' },
    ],
    expect: { focus: 'B', title: '回邮件', status: 'running', doneSteps: ['读邮件'], nextStep: '发出去', waitingOn: '', checkpoints: ['A'] },
  },
  {
    id: 'A03-03',
    name: '新任务做一步后切回旧任务，两边已确认步骤都不重做',
    actions: [
      { op: 'goal', id: 'A', title: '整理旅行清单', nextStep: '确认机票日期', steps: ['查天气', '列装备'] },
      { op: 'focus', goal: 'A' },
      { op: 'goal', id: 'B', title: '回邮件', nextStep: '发出去' },
      { op: 'switch', goal: 'B' },
      { op: 'step', goal: 'B', text: '读邮件' },
      { op: 'switch', goal: 'A' },
    ],
    expect: {
      focus: 'A', title: '整理旅行清单', status: 'running', doneSteps: ['查天气', '列装备'],
      nextStep: '确认机票日期', waitingOn: '', checkpoints: ['A', 'B'],
    },
  },
  {
    id: 'A03-04',
    name: '暂停不是结束：返回只改焦点，不自动改生命周期',
    actions: [
      { op: 'goal', id: 'A', title: '整理旅行清单', nextStep: '确认机票日期', steps: ['查天气'] },
      { op: 'focus', goal: 'A' },
      { op: 'pause', goal: 'A' },
      { op: 'interject', note: '先回个微信' },
      { op: 'resume' },
    ],
    expect: {
      focus: 'A', title: '整理旅行清单', status: 'paused', doneSteps: ['查天气'],
      nextStep: '确认机票日期', waitingOn: '', checkpoints: [],
    },
  },
  {
    id: 'A03-05',
    name: '两个候选先消歧，指定目标后再恢复',
    actions: [
      { op: 'goal', id: 'A', title: '整理旅行清单', steps: ['查天气'] },
      { op: 'focus', goal: 'A' },
      { op: 'goal', id: 'B', title: '回邮件' },
      { op: 'switch', goal: 'B' },
      { op: 'resume', store: 'ambiguous' },
      { op: 'resume', goal: 'A' },
    ],
    expect: {
      focus: 'A', title: '整理旅行清单', status: 'running', doneSteps: ['查天气'], nextStep: '', waitingOn: '',
      ambiguous: { code: 'ambiguous-resume', candidates: 2 }, checkpoints: ['A', 'B'],
    },
  },
  {
    id: 'A03-06',
    name: '完成一个目标后返回，只剩另一个候选，不复活终态目标',
    actions: [
      { op: 'goal', id: 'A', title: '整理旅行清单', steps: ['查天气'] },
      { op: 'focus', goal: 'A' },
      { op: 'goal', id: 'C', title: '买演出票', steps: ['挑座位'] },
      { op: 'complete', goal: 'A' },
      { op: 'resume' },
    ],
    expect: {
      focus: 'C', title: '买演出票', status: 'running', doneSteps: ['挑座位'],
      statuses: { A: 'completed' }, checkpoints: [],
    },
  },
  {
    id: 'A03-07',
    name: '再次确认当前目标（keep）不产生任何移动',
    actions: [
      { op: 'goal', id: 'A', title: '写周报', steps: ['列提纲'] },
      { op: 'focus', goal: 'A' },
      { op: 'interject', note: '在忙' },
      { op: 'keep', goal: 'A' },
    ],
    expect: { focus: 'A', title: '写周报', status: 'running', doneSteps: ['列提纲'], kept: true, checkpoints: [] },
  },
  {
    id: 'A03-08',
    name: '等待条件跨切换保留',
    actions: [
      { op: 'goal', id: 'A', title: '取快递', nextStep: '去取快递', waitingOn: '等确认快递到货', steps: ['查物流'] },
      { op: 'focus', goal: 'A' },
      { op: 'goal', id: 'B', title: '回邮件' },
      { op: 'switch', goal: 'B' },
      { op: 'switch', goal: 'A' },
    ],
    expect: {
      focus: 'A', title: '取快递', status: 'running', doneSteps: ['查物流'],
      nextStep: '去取快递', waitingOn: '等确认快递到货', checkpoints: ['A', 'B'],
    },
  },
  {
    id: 'A03-09',
    name: '检查点保存切换到那一刻的进度与下一步',
    actions: [
      { op: 'goal', id: 'A', title: '整理旅行清单', nextStep: '确认机票日期', steps: ['查天气', '列装备'] },
      { op: 'focus', goal: 'A' },
      { op: 'goal', id: 'B', title: '回邮件' },
      { op: 'switch', goal: 'B' },
    ],
    expect: {
      focus: 'B', title: '回邮件', status: 'running', doneSteps: [], nextStep: '',
      checkpoints: ['A'],
      checkpointPayload: { A: { doneSteps: ['查天气', '列装备'], nextStep: '确认机票日期', status: 'running' } },
    },
  },
  {
    id: 'A03-10',
    name: '超期只标超期，返回后进度与生命周期不变',
    actions: [
      { op: 'goal', id: 'A', title: '整理旅行清单', nextStep: '确认机票日期', steps: ['查天气'], deadlineOffset: -3600000 },
      { op: 'focus', goal: 'A' },
      { op: 'overdue' },
      { op: 'interject', note: '顺便看下天气' },
    ],
    expect: {
      focus: 'A', title: '整理旅行清单', status: 'running', doneSteps: ['查天气'],
      nextStep: '确认机票日期', overdue: true, checkpoints: [],
    },
  },
];

test('A03: ten fixed interruption/switch/return cases recover the right state', () => {
  assert.equal(A03_CASES.length, 10);
  for (const spec of A03_CASES) {
    const clock = makeClock();
    const db = openMemory(clock);
    const ctx = {
      spec,
      db,
      clock,
      scope: { userId: `u-${spec.id}`, personaId: 'bot', worldId: `w-${spec.id}` },
      key: '',
      ids: {},
      results: {},
    };
    ctx.key = scopeKey(ctx.scope);
    try {
      for (const action of spec.actions) applyOp(ctx, action);
      assertRecovered(ctx);
    } finally {
      db.close();
    }
  }
});

test('A03: a fresh session recovers from rows, not from an in-process summary', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '整理旅行清单', nextStep: '确认机票日期', waitingOn: '她确认周末时间', steps: ['查天气'] });
  focusGoal(db, { scope: SCOPE, goalId, expectedRevision: 0, now: clock.tick() });
  // A new "session" only re-reads persisted rows; the module keeps no cache.
  const state = workingMemoryState(db, { scopeKey: key, now: clock.tick() });
  assert.equal(state.focusGoalId, goalId);
  assert.deepEqual(state.goal.doneSteps, ['查天气']);
  assert.equal(state.goal.waitingOn, '她确认周末时间');
  assert.equal(currentFocus(db, key).focusGoalId, goalId);
  db.close();
});

// ------------------------------------------------------------------ A04 budget

test('A04: budget compression keeps every active commitment and the fixed section order', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, {
    title: '整理旅行清单', nextStep: '确认机票日期', waitingOn: '她确认周末时间',
    steps: ['查天气', '列装备', '订酒店', '看机票', '确认预算', '请假'],
  });
  const texts = ['周末回她消息', '寄出快递', '买演出票'];
  createCommitment(db, { scope: SCOPE, text: texts[0], dueAt: clock.value + 2 * DAY, goalId, now: clock.tick() });
  createCommitment(db, { scope: SCOPE, text: texts[1], dueAt: clock.value + 3 * DAY, now: clock.tick() });
  createCommitment(db, { scope: SCOPE, text: texts[2], now: clock.tick() });
  focusGoal(db, { scope: SCOPE, goalId, expectedRevision: 0, now: clock.tick() });

  const full = renderWorkingMemory(db, { scopeKey: key, budgetChars: 320, now: clock.value });
  assert.ok(full.length <= 320, 'render never exceeds the budget');
  const positions = ['【承诺】', '【目标】', '下一步：', '【等待】', '【已完成】'].map(label => full.indexOf(label));
  assert.ok(positions.every(position => position >= 0), 'all sections present with a generous budget');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'section order is fixed');
  for (const text of texts) assert.ok(full.includes(text));

  // Steps are the first thing trimming gives up; these three commitments are short
  // enough to survive every budget below, and a kept commitment is kept verbatim.
  for (const budget of [40, 60, 100, 160, 240]) {
    const rendered = renderWorkingMemory(db, { scopeKey: key, budgetChars: budget, now: clock.value });
    assert.ok(rendered.length <= budget, `budget ${budget}: got ${rendered.length}`);
    for (const text of texts) assert.ok(rendered.includes(text), `budget ${budget}: commitment "${text}" must stay`);
  }
  const truncatedSteps = renderWorkingMemory(db, { scopeKey: key, budgetChars: 100, now: clock.value });
  assert.ok(truncatedSteps.length <= 100);
  assert.ok(truncatedSteps.includes('【已完成】') && !truncatedSteps.includes('请假'), 'only the tail of the step list is cut');
  assert.ok(truncatedSteps.includes('【等待】'), 'the waiting condition outlives the step list');
  const withoutSteps = renderWorkingMemory(db, { scopeKey: key, budgetChars: 80, now: clock.value });
  assert.ok(withoutSteps.length <= 80);
  assert.ok(!withoutSteps.includes('【已完成】') && withoutSteps.includes('【等待】'), 'steps are dropped before the waiting condition');
  const tight = renderWorkingMemory(db, { scopeKey: key, budgetChars: 40, now: clock.value });
  assert.ok(tight.length <= 40);
  assert.ok(!tight.includes('【目标】') && !tight.includes('【等待】'), 'tighter budgets drop the goal view, never the commitments');
  assert.equal(renderWorkingMemory(db, { scopeKey: key, budgetChars: 0, now: clock.value }), '', 'a zero budget renders nothing');
  // Empty state renders empty, not a broken line.
  assert.equal(renderWorkingMemory(db, { scopeKey: scopeKey(OTHER), budgetChars: 320, now: clock.value }), '');
  db.close();
});

// B5: the injection budget is a hard cap for every budget, and a commitment is either
// rendered whole or replaced by the explicit "（另有N条承诺）" marker — never clipped.

const RENDER_BUDGETS = [0, 20, 40, 60, 80, 160, 320];

function commitmentText(index) {
  return `第${String(index).padStart(2, '0')}条承诺：周末回她消息`;
}

function openRenderFixture(count) {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, {
    title: '整理旅行清单', nextStep: '确认机票日期', waitingOn: '她确认周末时间',
    steps: ['查天气', '列装备', '订酒店'],
  });
  focusGoal(db, { scope: SCOPE, goalId, expectedRevision: 0, now: clock.tick() });
  const texts = [];
  for (let index = 1; index <= count; index += 1) {
    const text = commitmentText(index);
    texts.push(text);
    createCommitment(db, { scope: SCOPE, text, now: clock.tick() });
  }
  return { db, clock, key, texts };
}

/** Parse the first line back into whole entries plus the optional overflow marker. */
function parseCommitmentBlock(rendered) {
  assert.ok(rendered.startsWith('【承诺】'), 'commitments are the first section');
  const block = rendered.split('\n')[0];
  const body = block.slice('【承诺】'.length);
  const marker = /（另有(\d+)条承诺）$/.exec(body);
  const entries = (marker ? body.slice(0, marker.index) : body).split('；').filter(Boolean);
  return {
    block,
    entries,
    omitted: marker ? Number(marker[1]) : 0,
    hasMarker: Boolean(marker),
  };
}

test('A04/B5: every budget 0/20/40/60/80/160/320 is a hard cap, with 0, 1, 12 or 40 commitments', () => {
  // 40 commitments is the shape that used to overflow a 40-char budget (each entry was
  // forced to at least two characters, so the total grew past the budget).
  for (const count of [0, 1, 12, 40]) {
    const { db, clock, key, texts } = openRenderFixture(count);
    try {
      for (const budget of RENDER_BUDGETS) {
        const detailed = renderWorkingMemoryDetailed(db, { scopeKey: key, budgetChars: budget, now: clock.value });
        const rendered = detailed.text;
        assert.equal(rendered, renderWorkingMemory(db, { scopeKey: key, budgetChars: budget, now: clock.value }),
          `count ${count} budget ${budget}: the string API mirrors the detailed result`);
        assert.equal(detailed.chars, rendered.length, 'chars matches the string');
        assert.ok(rendered.length <= budget, `count ${count} budget ${budget}: ${rendered.length} chars > ${budget}`);
        if (budget < 40) {
          assert.equal(rendered, '', `count ${count} budget ${budget}: nothing is rendered below the minimum`);
          assert.equal(detailed.state, 'budget-too-small');
          continue;
        }
        // Fixed section order: 承诺 → 目标 → 下一步 → 等待 → 已完成.
        const positions = ['【承诺】', '【目标】', '下一步：', '【等待】', '【已完成】']
          .map(label => rendered.indexOf(label))
          .filter(position => position >= 0);
        assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `count ${count} budget ${budget}: section order`);
        if (count === 0) {
          assert.ok(!rendered.includes('【承诺】'), 'no commitments, no commitment section');
          assert.equal(detailed.omittedCommitments, 0);
          continue;
        }
        const parsed = parseCommitmentBlock(rendered);
        // Every rendered entry is exactly one of the formatted commitments, in order.
        assert.deepEqual(parsed.entries, texts.slice(0, parsed.entries.length),
          `count ${count} budget ${budget}: entries are whole and ordered`);
        assert.equal(parsed.entries.length + parsed.omitted, count,
          `count ${count} budget ${budget}: shown + omitted accounts for every commitment`);
        assert.equal(detailed.shownCommitments, parsed.entries.length);
        assert.equal(detailed.omittedCommitments, parsed.omitted);
        // A commitment that cannot fit whole never leaks a fragment of itself.
        for (const text of texts.slice(parsed.entries.length)) {
          assert.ok(!rendered.includes(text.slice(0, 7)), `count ${count} budget ${budget}: "${text}" is not partially rendered`);
        }
        if (parsed.omitted > 0) assert.equal(detailed.state, 'commitments-omitted');
        else assert.ok(detailed.state === 'full' || detailed.state === 'trimmed', `state ${detailed.state}`);
      }
    } finally {
      db.close();
    }
  }
});

test('A04/B5: whole commitments win the budget, then the goal view uses what is left', () => {
  const { db, clock, key, texts } = openRenderFixture(12);
  try {
    const tight = renderWorkingMemoryDetailed(db, { scopeKey: key, budgetChars: 40, now: clock.value });
    // 12 entries cannot fit; whole entries stay, the rest is counted explicitly.
    const parsed = parseCommitmentBlock(tight.text);
    assert.ok(parsed.hasMarker && parsed.omitted > 0, 'a dropped commitment is reported by the marker');
    assert.equal(parsed.entries.length + parsed.omitted, 12);
    assert.ok(tight.text.length <= 40);
    assert.ok(tight.text.includes('（另有'), tight.text);
    const roomy = renderWorkingMemoryDetailed(db, { scopeKey: key, budgetChars: 320, now: clock.value });
    const roomyParsed = parseCommitmentBlock(roomy.text);
    assert.equal(roomyParsed.omitted, 0, 'with a wide budget every commitment fits');
    assert.deepEqual(roomyParsed.entries, texts);
    assert.equal(roomy.state, 'full');
  } finally {
    db.close();
  }
});

test('A04/B5: a commitment longer than the budget is dropped whole, never cut mid-sentence', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '长承诺', nextStep: '等回复' });
  focusGoal(db, { scope: SCOPE, goalId, expectedRevision: 0, now: clock.tick() });
  const long = '把周末旅行的所有细节整理成一份可以直接照着走的清单' + '，包括交通、住宿、吃饭和备用方案'.repeat(5);
  assert.ok(long.length > 100 && long.length <= 300, `fixture length ${long.length}`);
  createCommitment(db, { scope: SCOPE, text: long, now: clock.tick() });
  try {
    // Too tight for the whole entry: it disappears and the marker says so.
    for (const budget of [40, 60, 80, 100]) {
      const detailed = renderWorkingMemoryDetailed(db, { scopeKey: key, budgetChars: budget, now: clock.value });
      assert.ok(detailed.text.length <= budget, `budget ${budget}: ${detailed.text.length} chars`);
      assert.equal(detailed.shownCommitments, 0);
      assert.equal(detailed.omittedCommitments, 1);
      assert.ok(detailed.text.startsWith('【承诺】（另有1条承诺）'), `budget ${budget}: ${detailed.text}`);
      assert.ok(!detailed.text.includes(long.slice(0, 10)), 'no fragment of the dropped commitment leaks into the text');
    }
    // Wide enough: the entry is rendered whole, never with an ellipsis.
    for (const budget of [160, 320]) {
      const detailed = renderWorkingMemoryDetailed(db, { scopeKey: key, budgetChars: budget, now: clock.value });
      assert.ok(detailed.text.length <= budget);
      const parsed = parseCommitmentBlock(detailed.text);
      assert.deepEqual(parsed.entries, [long], `budget ${budget}: the commitment is verbatim`);
      assert.equal(parsed.hasMarker, false);
    }
    assert.equal(renderWorkingMemory(db, { scopeKey: key, budgetChars: 0, now: clock.value }), '');
    assert.equal(renderWorkingMemory(db, { scopeKey: key, budgetChars: 39, now: clock.value }), '', 'below 40 nothing is rendered');
    assert.equal(renderWorkingMemoryDetailed(db, { scopeKey: key, budgetChars: 39, now: clock.value }).state, 'budget-too-small');
  } finally {
    db.close();
  }
});

test('A04: a process restart recovers focus, progress and commitments from the file', () => {
  const clock = makeClock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wm-restart-'));
  const file = path.join(dir, 'runtime.db');
  let db = openRuntimeDb({ file, now: () => clock.value });
  try {
    const key = scopeKey(SCOPE);
    const first = createRunning(db, clock, SCOPE, { title: '整理旅行清单', nextStep: '确认机票日期', waitingOn: '她确认周末时间', steps: ['查天气', '列装备'] });
    const second = createRunning(db, clock, SCOPE, { title: '回邮件', nextStep: '发出去', steps: ['读邮件'] });
    focusGoal(db, { scope: SCOPE, goalId: first, expectedRevision: 0, now: clock.tick() });
    switchGoal(db, { scope: SCOPE, goalId: second, expectedRevision: focusRevision(db, key), now: clock.tick() });
    recordStep(db, { scope: SCOPE, goalId: second, step: '写回信', expectedRevision: getGoal(db, key, second).revision, now: clock.tick() });
    const openCommitment = createCommitment(db, { scope: SCOPE, text: '周末回她消息', dueAt: clock.value + DAY, goalId: second, now: clock.tick() });
    const closedCommitment = createCommitment(db, { scope: SCOPE, text: '已回复的旧承诺', now: clock.tick() });
    closeCommitment(db, { scope: SCOPE, commitmentId: closedCommitment.commitmentId, reason: 'done', now: clock.tick() });

    const snapshot = db => ({
      state: workingMemoryState(db, { scopeKey: key, now: clock.value }),
      focus: currentFocus(db, key),
      goal: getGoal(db, key, second),
      firstGoal: getGoal(db, key, first),
      goals: listGoals(db, { scopeKey: key }).map(goal => goal.goalId),
      commitments: listCommitments(db, { scopeKey: key }),
      checkpoints: checkpointRows(db, key).map(row => ({ goalId: row.goal_id, reason: row.reason, payload: row.payload })),
    });
    const before = snapshot(db);
    assert.equal(before.state.focusGoalId, second);
    assert.equal(before.checkpoints.length, 1);
    db.close();

    db = openRuntimeDb({ file, now: () => clock.value });
    const after = snapshot(db);
    assert.deepEqual(after, before, 'every read after restart comes from persisted rows');
    assert.equal(after.state.goal.title, '回邮件');
    assert.deepEqual(after.state.goal.doneSteps, ['读邮件', '写回信']);
    assert.equal(after.state.commitments.length, 1);
    assert.equal(after.state.commitments[0].text, '周末回她消息');
    assert.equal(after.checkpoints[0].goalId, first, 'the switch checkpoint survived the restart');
    // Recovery keeps working: resume the other goal with the recovered revision.
    const resumed = resumeGoal(db, { scope: SCOPE, goalId: first, expectedRevision: currentFocus(db, key).revision, now: clock.tick() });
    assert.equal(resumed.ok, true);
    assert.equal(currentFocus(db, key).focusGoalId, first);
    db.close();
  } finally {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('A04: two users/worlds in one database never leak goals, commitments or focus', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const keyA = scopeKey(SCOPE);
  const keyB = scopeKey(OTHER);
  const goalA = createRunning(db, clock, SCOPE, { title: 'A 的旅行清单', nextStep: 'A 的下一步' });
  const goalB = createRunning(db, clock, OTHER, { title: 'B 的周报', nextStep: 'B 的下一步' });
  focusGoal(db, { scope: SCOPE, goalId: goalA, expectedRevision: 0, now: clock.tick() });
  focusGoal(db, { scope: OTHER, goalId: goalB, expectedRevision: 0, now: clock.tick() });
  const commitmentA = createCommitment(db, { scope: SCOPE, text: 'A 的承诺', now: clock.tick() });
  createCommitment(db, { scope: OTHER, text: 'B 的承诺', now: clock.tick() });

  const stateA = workingMemoryState(db, { scopeKey: keyA, now: clock.value });
  const stateB = workingMemoryState(db, { scopeKey: keyB, now: clock.value });
  assert.equal(stateA.focusGoalId, goalA);
  assert.equal(stateB.focusGoalId, goalB);
  assert.deepEqual(stateA.commitments.map(commitment => commitment.text), ['A 的承诺']);
  assert.deepEqual(stateB.commitments.map(commitment => commitment.text), ['B 的承诺']);
  assert.deepEqual(listGoals(db, { scopeKey: keyB }).map(goal => goal.goalId), [goalB]);
  assert.equal(getGoal(db, keyB, goalA), null);

  const renderA = renderWorkingMemory(db, { scopeKey: keyA, budgetChars: 320, now: clock.value });
  const renderB = renderWorkingMemory(db, { scopeKey: keyB, budgetChars: 320, now: clock.value });
  assert.ok(renderA.includes('A 的旅行清单') && !renderA.includes('B 的周报') && !renderA.includes('B 的承诺'));
  assert.ok(renderB.includes('B 的周报') && !renderB.includes('A 的旅行清单') && !renderB.includes('A 的承诺'));

  assert.throws(
    () => switchGoal(db, { scope: SCOPE, goalId: goalB, expectedRevision: focusRevision(db, keyA), now: clock.tick() }),
    error => error.code === 'unknown-goal',
  );
  assert.deepEqual(resumeGoal(db, { scope: OTHER, goalId: goalA, now: clock.tick() }), { ok: false, code: 'unknown-goal', goalId: goalA });
  assert.throws(
    () => checkpointGoal(db, { scope: OTHER, goalId: goalA, reason: 'cross-scope', now: clock.tick() }),
    error => error.code === 'unknown-goal',
  );
  assert.throws(
    () => closeCommitment(db, { scope: OTHER, commitmentId: commitmentA.commitmentId, now: clock.tick() }),
    error => error.code === 'unknown-commitment',
  );
  assert.equal(currentFocus(db, keyA).focusGoalId, goalA, 'rejected cross-scope writes leave the focus untouched');
  db.close();
});

// --------------------------------------------------------------------- A06 half

test('A06: no reply and no TTL closes a commitment; render keeps it through silence', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '约定', steps: ['约时间'] });
  focusGoal(db, { scope: SCOPE, goalId, expectedRevision: 0, now: clock.tick() });
  const due = createCommitment(db, { scope: SCOPE, text: '周末回她消息', dueAt: clock.value - DAY, goalId, now: clock.tick() });
  createCommitment(db, { scope: SCOPE, text: '寄出快递', now: clock.tick() });
  const before = db.get('SELECT * FROM commitments WHERE commitment_id = ?', due.commitmentId);

  // Six rounds of silence: only interjections, time passing and deadline sweeps.
  for (let round = 0; round < 6; round += 1) {
    dispatchEvent(db, {
      kind: 'topic/interjection', scope: SCOPE, occurredAt: clock.tick(), payload: { note: `第${round + 1}次插话` },
    }, { handlers: HANDLERS });
    clock.tick(5 * DAY);
    markOverdue(db, { scopeKey: key, now: clock.value });
  }
  const after = db.get('SELECT * FROM commitments WHERE commitment_id = ?', due.commitmentId);
  assert.deepEqual(after, before, 'silence must not touch a commitment row');
  const state = workingMemoryState(db, { scopeKey: key, now: clock.value });
  assert.equal(state.commitments.length, 2, 'both commitments are still active');
  assert.deepEqual(state.commitments.map(commitment => commitment.status), ['open', 'open']);
  const rendered = renderWorkingMemory(db, { scopeKey: key, budgetChars: 320, now: clock.value });
  assert.ok(rendered.includes('周末回她消息') && rendered.includes('寄出快递'));

  // Only an explicit close ends one.
  closeCommitment(db, { scope: SCOPE, commitmentId: due.commitmentId, reason: 'user-confirmed', now: clock.tick() });
  const remaining = workingMemoryState(db, { scopeKey: key, now: clock.value });
  assert.deepEqual(remaining.commitments.map(commitment => commitment.text), ['寄出快递']);
  const renderedAgain = renderWorkingMemory(db, { scopeKey: key, budgetChars: 320, now: clock.value });
  assert.ok(!renderedAgain.includes('周末回她消息') && renderedAgain.includes('寄出快递'));
  db.close();
});

// ------------------------------------------------------------ focus / checkpoint

test('working memory: focus mutations require expectedRevision and reject stale writes', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const first = createRunning(db, clock, SCOPE, { title: 'A' });
  const second = createRunning(db, clock, SCOPE, { title: 'B' });
  const focused = focusGoal(db, { scope: SCOPE, goalId: first, expectedRevision: 0, now: clock.tick() });
  assert.equal(focused.revision, 1);
  assert.throws(
    () => focusGoal(db, { scope: SCOPE, goalId: second, expectedRevision: 0, now: clock.tick() }),
    error => error instanceof StaleRevisionError && error.code === 'stale-revision',
  );
  assert.throws(() => focusGoal(db, { scope: SCOPE, goalId: second, now: clock.tick() }), error => error.code === 'invalid-input');
  const kept = focusGoal(db, { scope: SCOPE, goalId: first, expectedRevision: 1, now: clock.tick() });
  assert.deepEqual([kept.kept, kept.revision], [true, 1], 'keep does not bump the revision');
  assert.equal(currentFocus(db, key).revision, 1);
  // Clearing the focus is explicit too.
  const cleared = focusGoal(db, { scope: SCOPE, goalId: '', expectedRevision: 1, now: clock.tick() });
  assert.deepEqual([cleared.focusGoalId, cleared.revision], ['', 2]);
  assert.equal(currentFocus(db, key).focusGoalId, '');
  assert.equal(workingMemoryState(db, { scopeKey: key, now: clock.value }).goal, null);
  db.close();
});

test('working memory: switch checkpoints the previous goal before moving', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const first = createRunning(db, clock, SCOPE, { title: '写周报', nextStep: '补数据', steps: ['列提纲'] });
  const second = createRunning(db, clock, SCOPE, { title: '回邮件' });
  focusGoal(db, { scope: SCOPE, goalId: first, expectedRevision: 0, now: clock.tick() });

  const switched = switchGoal(db, { scope: SCOPE, goalId: second, expectedRevision: currentFocus(db, key).revision, now: clock.tick() });
  assert.equal(switched.focusGoalId, second);
  assert.ok(switched.checkpointId);
  const rows = checkpointRows(db, key);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].goal_id, first);
  const payload = JSON.parse(rows[0].payload);
  assert.deepEqual([payload.goalId, payload.status, payload.nextStep], [first, 'running', '补数据']);
  assert.deepEqual(payload.doneSteps, ['列提纲']);
  assert.equal(rows[0].reason, 'switch');
  assert.equal(currentFocus(db, key).lastCheckpointId, switched.checkpointId);
  // Switching again to the same goal is a keep, not another checkpoint.
  const kept = switchGoal(db, { scope: SCOPE, goalId: second, expectedRevision: currentFocus(db, key).revision, now: clock.tick() });
  assert.equal(kept.kept, true);
  assert.equal(checkpointRows(db, key).length, 1);
  db.close();
});

test('working memory: checkpoints keep creation order even inside one millisecond', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '检查点', steps: ['一步'] });
  const sameInstant = clock.value;
  const first = checkpointGoal(db, { scope: SCOPE, goalId, reason: 'manual-1', now: sameInstant });
  const second = checkpointGoal(db, { scope: SCOPE, goalId, reason: 'manual-2', now: sameInstant });
  const rows = checkpointRows(db, key);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.reason), ['manual-1', 'manual-2']);
  assert.equal(rows[0].created_at, rows[1].created_at);
  assert.ok(rows[0].row_id < rows[1].row_id, 'insertion order breaks the tie');
  assert.deepEqual(rows.map(row => row.checkpoint_id), [first.checkpointId, second.checkpointId]);
  assert.deepEqual(JSON.parse(rows[0].payload).doneSteps, ['一步']);
  db.close();
});

// B4: checkpoint rows must be a pure function of the event log. Two runs of the same
// log — even with a completely different wall clock — produce byte-identical rows, so a
// clean recovery replay can no longer report a projection mismatch.
test('B4: replaying the same event log produces byte-identical wm_checkpoints rows', () => {
  const clock = makeClock();
  const live = openMemory(clock);
  const key = scopeKey(SCOPE);
  const replayGoalId = 'goal_replay_a';
  const otherGoalId = 'goal_replay_b';
  const thirdGoalId = 'goal_replay_c';
  const revisionOf = goalId => getGoal(live, key, goalId).revision;
  const emit = (kind, payload) => {
    const outcome = dispatchEvent(live, { kind, scope: SCOPE, occurredAt: clock.tick(), payload }, { handlers: HANDLERS });
    assert.equal(outcome.rejected, false, `${kind} must be accepted into the log`);
    return outcome;
  };
  const rowsOf = db => db.all(
    'SELECT rowid AS row_id, checkpoint_id, scope, goal_id, revision, reason, created_at, payload FROM wm_checkpoints WHERE scope = ? ORDER BY checkpoint_id',
    key,
  );

  try {
    // The whole scenario travels through the log: no API-only checkpoint writes.
    emit('goal/proposed', { goalId: replayGoalId, title: '写周报', nextStep: '补数据' });
    emit('goal/accepted', { goalId: replayGoalId, expectedRevision: revisionOf(replayGoalId) });
    emit('goal/started', { goalId: replayGoalId, expectedRevision: revisionOf(replayGoalId) });
    emit('goal/proposed', { goalId: otherGoalId, title: '回邮件', nextStep: '发出去' });
    emit('goal/accepted', { goalId: otherGoalId, expectedRevision: revisionOf(otherGoalId) });
    emit('commitment/made', {
      commitmentId: 'cm_replay_1', text: '周末回她消息', dueAt: clock.value + DAY, goalId: replayGoalId,
    });
    emit('topic/interjection', { note: '顺便看看快递' });
    emit('topic/switch', { goalId: replayGoalId });
    emit('goal/step', { goalId: replayGoalId, step: '列装备', expectedRevision: revisionOf(replayGoalId) });
    emit('goal/completed', { goalId: replayGoalId, expectedRevision: revisionOf(replayGoalId), reason: 'user-confirmed' });
    emit('goal/proposed', { goalId: thirdGoalId, title: '买演出票', nextStep: '挑座位' });
    emit('goal/accepted', { goalId: thirdGoalId, expectedRevision: revisionOf(thirdGoalId) });
    // The last checkpoint is a switch: it is the id the slice publishes, which is
    // exactly the value that used to make verifyRecovery report a projection mismatch.
    emit('topic/switch', { goalId: otherGoalId });

    const liveRows = rowsOf(live);
    assert.equal(liveRows.length, 4, 'accepted, switch, completed and switch each stored one checkpoint');
    assert.deepEqual(liveRows.map(row => row.goal_id).sort(), [replayGoalId, otherGoalId, replayGoalId, thirdGoalId].sort());
    assert.deepEqual(liveRows.map(row => row.reason).sort(), ['goal/accepted', 'goal/completed', 'switch', 'switch']);
    for (const row of liveRows) {
      assert.match(row.checkpoint_id, /^wmc_[0-9a-f]{32}$/, 'ids are content-addressed, not random UUIDs');
      const payload = JSON.parse(row.payload);
      assert.deepEqual(Object.keys(payload).sort(), ['doneSteps', 'goalId', 'nextStep', 'overdue', 'revision', 'status', 'title', 'waitingOn'].sort());
      assert.equal(typeof payload.overdue, 'boolean');
      assert.equal(payload.goalId.length > 0, true);
    }
    const liveSlice = live.projection(key).payload['working-memory'];
    assert.ok(liveRows.some(row => row.checkpoint_id === liveSlice.lastCheckpointId),
      'the published checkpoint id is one of the stored rows');

    // Second run of the same log, in a second in-memory database, under a different clock.
    const scratch = openRuntimeDb({ file: ':memory:', now: () => 42 });
    try {
      for (const event of listEvents(live, { scopeKey: key, limit: 1000 })) {
        for (const consumer of consumersFor(event.kind)) {
          const handler = HANDLERS[consumer];
          if (handler) applyEvent(scratch, { consumer, event, apply: handler });
        }
      }
      assert.deepEqual(rowsOf(scratch), liveRows, 'the replayed checkpoint rows are byte-identical');
      assert.deepEqual(scratch.projection(key).payload['working-memory'], liveSlice,
        'the replayed slice carries the same lastCheckpointId, so the projection matches');

      // And once more, to prove the ids are not a one-off of this process.
      const again = openRuntimeDb({ file: ':memory:', now: () => 999 });
      try {
        for (const event of listEvents(live, { scopeKey: key, limit: 1000 })) {
          for (const consumer of consumersFor(event.kind)) {
            const handler = HANDLERS[consumer];
            if (handler) applyEvent(again, { consumer, event, apply: handler });
          }
        }
        assert.deepEqual(rowsOf(again), liveRows, 'a third run agrees too');
      } finally {
        again.close();
      }
    } finally {
      scratch.close();
    }
  } finally {
    live.close();
  }
});

test('working memory: resume disambiguates, never guesses, and rejects closed targets', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const first = createRunning(db, clock, SCOPE, { title: 'A' });
  const second = createRunning(db, clock, SCOPE, { title: 'B' });
  focusGoal(db, { scope: SCOPE, goalId: first, expectedRevision: 0, now: clock.tick() });

  const ambiguous = resumeGoal(db, { scope: SCOPE, expectedRevision: currentFocus(db, key).revision, now: clock.tick() });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, 'ambiguous-resume');
  assert.equal(ambiguous.candidates.length, 2);
  assert.deepEqual(ambiguous.candidates.map(candidate => candidate.goalId).sort(), [first, second].sort());
  assert.equal(currentFocus(db, key).focusGoalId, first, 'an ambiguous resume changes nothing');
  assert.equal(checkpointRows(db, key).length, 0);

  const resumed = resumeGoal(db, { scope: SCOPE, goalId: second, expectedRevision: currentFocus(db, key).revision, now: clock.tick() });
  assert.deepEqual([resumed.ok, resumed.focusGoalId], [true, second]);
  assert.equal(checkpointRows(db, key).length, 1, 'resume also checkpoints the previous goal');

  assert.deepEqual(resumeGoal(db, { scope: SCOPE, goalId: 'goal_missing', now: clock.tick() }), { ok: false, code: 'unknown-goal', goalId: 'goal_missing' });
  transitionGoal(db, { scope: SCOPE, goalId: second, to: 'completed', expectedRevision: getGoal(db, key, second).revision, now: clock.tick() });
  const terminal = resumeGoal(db, { scope: SCOPE, goalId: second, now: clock.tick() });
  assert.deepEqual([terminal.ok, terminal.code, terminal.status], [false, 'terminal-goal', 'completed']);

  transitionGoal(db, { scope: SCOPE, goalId: first, to: 'completed', expectedRevision: getGoal(db, key, first).revision, now: clock.tick() });
  const none = resumeGoal(db, { scope: SCOPE, now: clock.tick() });
  assert.deepEqual([none.ok, none.code], [false, 'no-candidate']);
  db.close();
});

test('working memory: currentFocus drops a focus that points at a closed goal', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '会被完成的目标', steps: ['一步'] });
  focusGoal(db, { scope: SCOPE, goalId, expectedRevision: 0, now: clock.tick() });
  transitionGoal(db, { scope: SCOPE, goalId, to: 'completed', expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick() });
  const focus = currentFocus(db, key);
  assert.equal(focus.focusGoalId, '');
  assert.equal(focus.storedFocusGoalId, goalId);
  const state = workingMemoryState(db, { scopeKey: key, now: clock.value });
  assert.equal(state.goal, null);
  assert.ok(!renderWorkingMemory(db, { scopeKey: key, budgetChars: 320, now: clock.value }).includes('会被完成的目标'));
  db.close();
});

test('working memory: workingMemoryState keeps the frozen shape', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '形状', nextStep: '下一步', waitingOn: '等待', steps: ['一步'] });
  focusGoal(db, { scope: SCOPE, goalId, expectedRevision: 0, now: clock.tick() });
  createCommitment(db, { scope: SCOPE, text: '承诺', dueAt: clock.value + DAY, goalId, now: clock.tick() });
  const state = workingMemoryState(db, { scopeKey: key, now: clock.value });
  assert.deepEqual(Object.keys(state).sort(), ['commitments', 'focusGoalId', 'goal', 'lastEventAt', 'revision']);
  assert.deepEqual(Object.keys(state.goal).sort(), ['doneSteps', 'goalId', 'nextStep', 'overdue', 'status', 'title', 'waitingOn']);
  assert.deepEqual(Object.keys(state.commitments[0]).sort(), ['dueAt', 'status', 'text']);
  assert.equal(typeof state.lastEventAt, 'number');
  db.close();
});

// -------------------------------------------------------------- consumer reducer

test('working memory reducer: an interjection is a partial update that never moves the focus', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '整理旅行清单', nextStep: '确认机票日期', steps: ['查天气'] });
  focusGoal(db, { scope: SCOPE, goalId, expectedRevision: 0, now: clock.tick() });
  const revision = currentFocus(db, key).revision;

  dispatchEvent(db, { kind: 'topic/interjection', scope: SCOPE, occurredAt: clock.tick(), payload: { note: '顺便看看快递' } }, { handlers: HANDLERS });
  const focus = currentFocus(db, key);
  assert.equal(focus.focusGoalId, goalId, 'interjection must not switch the focus');
  assert.equal(focus.pending.kind, 'interjection');
  assert.equal(focus.pending.note, '顺便看看快递');
  assert.equal(focus.revision, revision + 1);

  // A following goal/step event updates the plan but leaves the pending note alone.
  dispatchEvent(db, {
    kind: 'goal/step', scope: SCOPE, occurredAt: clock.tick(),
    payload: { goalId, step: '列装备', expectedRevision: getGoal(db, key, goalId).revision },
  }, { handlers: HANDLERS });
  const after = workingMemoryState(db, { scopeKey: key, now: clock.value });
  assert.equal(after.focusGoalId, goalId);
  assert.deepEqual(after.goal.doneSteps, ['查天气', '列装备']);
  assert.equal(currentFocus(db, key).pending.kind, 'interjection');
  assert.equal(checkpointRows(db, key).length, 0, 'a partial update does not checkpoint');
  db.close();
});

test('working memory reducer: goal/completed clears the focus and checkpoints the finished goal', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '完成的目标', steps: ['一步', '两步'] });
  focusGoal(db, { scope: SCOPE, goalId, expectedRevision: 0, now: clock.tick() });
  dispatchEvent(db, {
    kind: 'goal/completed', scope: SCOPE, occurredAt: clock.tick(),
    payload: { goalId, expectedRevision: getGoal(db, key, goalId).revision, reason: 'user-confirmed' },
  }, { handlers: HANDLERS });
  assert.equal(getGoal(db, key, goalId).status, 'completed');
  assert.equal(currentFocus(db, key).focusGoalId, '');
  const rows = checkpointRows(db, key);
  assert.equal(rows.length, 1);
  const payload = JSON.parse(rows[0].payload);
  assert.deepEqual([payload.status, payload.doneSteps], ['completed', ['一步', '两步']]);
  assert.equal(rows[0].reason, 'goal/completed');
  db.close();
});

test('working memory reducer: topic/switch checkpoints, topic/resume still disambiguates', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const first = createRunning(db, clock, SCOPE, { title: 'A', steps: ['一步'] });
  const second = createRunning(db, clock, SCOPE, { title: 'B' });
  focusGoal(db, { scope: SCOPE, goalId: first, expectedRevision: 0, now: clock.tick() });

  dispatchEvent(db, { kind: 'topic/switch', scope: SCOPE, occurredAt: clock.tick(), payload: { goalId: second } }, { handlers: HANDLERS });
  assert.equal(currentFocus(db, key).focusGoalId, second);
  assert.equal(checkpointRows(db, key).length, 1);

  dispatchEvent(db, { kind: 'topic/resume', scope: SCOPE, occurredAt: clock.tick(), payload: {} }, { handlers: HANDLERS });
  const focus = currentFocus(db, key);
  assert.equal(focus.focusGoalId, second, 'an ambiguous topic/resume keeps the current focus');
  assert.equal(focus.pending.kind, 'ambiguous-resume');
  assert.equal(focus.pending.candidates.length, 2);

  dispatchEvent(db, { kind: 'topic/resume', scope: SCOPE, occurredAt: clock.tick(), payload: { goalId: first } }, { handlers: HANDLERS });
  assert.equal(currentFocus(db, key).focusGoalId, first);
  assert.deepEqual(checkpointRows(db, key).map(row => row.goal_id), [first, second]);
  db.close();
});

test('working memory reducer: replay is a no-op and foreign kinds are ignored', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '重放' });
  focusGoal(db, { scope: SCOPE, goalId, expectedRevision: 0, now: clock.tick() });
  const event = {
    eventId: 'evt_wm_replay', kind: 'topic/interjection', scope: SCOPE, scopeKey: key,
    payload: { note: '同一句插话' },
  };
  db.tx(() => {
    applyWorkingMemoryEvent({ db, event, slice: {}, now: clock.tick() }).extra(db, event);
    applyWorkingMemoryEvent({ db, event, slice: {}, now: clock.tick() }).extra(db, event);
  });
  const focus = currentFocus(db, key);
  assert.equal(focus.pending.note, '同一句插话');
  assert.equal(focus.revision, 2, 'the replayed event bumped the revision only once');
  assert.equal(checkpointRows(db, key).length, 0);

  for (const kind of ['state/impulse', 'belief/asserted', 'goal/overdue', 'memory/ingest-request']) {
    assert.deepEqual(applyWorkingMemoryEvent({ db, event: { kind, scopeKey: key, eventId: `evt_${kind}`, payload: {} }, slice: {}, now: clock.value }), {});
  }
  db.close();
});

test('working memory reducer: applyEvent commits the working-memory slice with the focus', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '切片' });
  const event = {
    eventId: 'evt_wm_slice', kind: 'goal/started', scope: SCOPE, scopeKey: key,
    occurredAt: clock.tick(), payload: { goalId },
  };
  const outcome = applyEvent(db, { consumer: 'working-memory', event, apply: applyWorkingMemoryEvent });
  assert.equal(outcome.applied, true);
  assert.equal(outcome.result.focusGoalId, goalId);
  const slice = db.projection(key).payload['working-memory'];
  assert.equal(slice.focusGoalId, goalId);
  assert.equal(slice.lastEventId, 'evt_wm_slice');
  assert.equal(slice.revision, 1);
  assert.ok(receiptFor(db, 'working-memory', 'evt_wm_slice'));
  // focusGoal reads the same revision the slice publishes.
  assert.equal(currentFocus(db, key).revision, slice.revision);
  db.close();
});

test('working memory: a proposal event may carry nextStep and waitingOn', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  dispatchEvent(db, {
    kind: 'goal/proposed', scope: SCOPE, occurredAt: clock.tick(),
    payload: { title: '整理旅行清单', nextStep: '确认机票日期', waitingOn: '她确认周末时间' },
  }, { handlers: HANDLERS });
  const goals = listGoals(db, { scopeKey: key });
  assert.equal(goals.length, 1, 'the proposal is persisted');
  assert.equal(goals[0].nextStep, '确认机票日期');
  assert.equal(goals[0].waitingOn, '她确认周末时间');
  assert.equal(currentFocus(db, key).focusGoalId, '', 'a proposal does not grab the focus');
  // The lifecycle is strict (B7): proposed → accepted → running, each step carrying the
  // revision it expects. The old proposed → running shortcut is gone.
  dispatchEvent(db, {
    kind: 'goal/accepted', scope: SCOPE, occurredAt: clock.tick(),
    payload: { goalId: goals[0].goalId, expectedRevision: goals[0].revision },
  }, { handlers: HANDLERS });
  dispatchEvent(db, {
    kind: 'goal/started', scope: SCOPE, occurredAt: clock.tick(),
    payload: { goalId: goals[0].goalId, expectedRevision: getGoal(db, key, goals[0].goalId).revision },
  }, { handlers: HANDLERS });
  const state = workingMemoryState(db, { scopeKey: key, now: clock.value });
  assert.equal(getGoal(db, key, goals[0].goalId).status, 'running', 'only the legal path reaches running');
  assert.equal(state.focusGoalId, goals[0].goalId);
  assert.equal(state.goal.waitingOn, '她确认周末时间');
  db.close();
});

test('working memory: render labels the overdue goal without completing it', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '过期目标', deadlineAt: clock.value - 3600000, steps: ['一步'] });
  focusGoal(db, { scope: SCOPE, goalId, expectedRevision: 0, now: clock.tick() });
  const rendered = renderWorkingMemory(db, { scopeKey: key, budgetChars: 320, now: clock.value });
  assert.ok(rendered.includes('超期'));
  assert.ok(rendered.includes('进行中'));
  assert.equal(getGoal(db, key, goalId).status, 'running');
  assert.equal(getGoal(db, key, goalId).overdue, false, 'the read-time flag never writes itself');
  db.close();
});
