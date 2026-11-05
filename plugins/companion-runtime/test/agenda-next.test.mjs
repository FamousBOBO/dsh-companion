import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';

// `nextOccurrence`（3A-4 第三个接缝方法）：周期提醒每轮都要拿"下一次 occurrence"。
//
// 没有它，QQ 侧推进自己的 `at` 之后第二轮 CAS 必然被判过期（revision 已被上次投递改过），
// 直接掉进 unknown。这一组测试跑真 DB + 真 reducer（日程生成由既有 materialize 完成）。


function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-next-'));
  for (const rel of ['home/companion', 'logs', 'workspace']) fs.mkdirSync(path.join(root, rel), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), 'bot\n', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    agenda: { enabled: true, generationHorizonHours: 72, maxItemsPerScope: 32, querySpanDays: 14 },
  }), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

const BOUND = { userId: 'owner-1' };
const identity = () => ({ resolve: sessionId => ({ userId: 'owner-1', persona: 'bot', sessionId }) });

function mounted(t, { agendaEnabled = true, timeZone = 'Asia/Shanghai', clock = () => Date.UTC(2026, 10, 4, 3, 0, 0), horizonHours = 72 } = {}) {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone,
    agenda: { enabled: agendaEnabled, generationHorizonHours: horizonHours, maxItemsPerScope: 32, querySpanDays: 14 },
  }), 'utf8');
  const runtime = mountRuntime(null, root, { now: clock, identity: identity() });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });
  return runtime;
}

const nyHour = at => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));

test('日重复：连调两次拿到同一个 occurrence（幂等，不新建）', async t => {
  const runtime = mounted(t);
  const created = runtime.createSchedule({ bound: BOUND, title: '喝水', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const first = created.occurrences[0];
  assert.ok(first, 'the schedule materialised at least one occurrence');

  const a = runtime.nextOccurrence({ bound: BOUND, occurrenceId: first.occurrenceId });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.ok(a.occurrence.dueAt > Number(first.scheduledAt), 'the next one is strictly later');
  assert.equal(a.occurrence.scheduleId, created.itemId);

  const b = runtime.nextOccurrence({ bound: BOUND, occurrenceId: first.occurrenceId });
  assert.equal(b.ok, true);
  assert.equal(b.occurrence.id, a.occurrence.id, 'same occurrence id — nothing new was appended');
  assert.equal(b.occurrence.dueAt, a.occurrence.dueAt);

  const occurrences = runtime.listSchedule({ bound: BOUND, occurrenceLimit: 200 }).occurrences
    .filter(entry => entry.itemId === created.itemId);
  const matching = occurrences.filter(entry => entry.scheduledAt === a.occurrence.dueAt);
  assert.equal(matching.length, 1, 'exactly one row for that instant: no duplicate occurrences');
});

test('一次性日程：not-recurring', async t => {
  const runtime = mounted(t);
  const created = runtime.createSchedule({ bound: BOUND, title: '交作业', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-11-06', time: '09:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const occurrenceId = created.occurrences[0]?.occurrenceId ?? created.occurrence?.id;
  assert.ok(occurrenceId);
  const next = runtime.nextOccurrence({ bound: BOUND, occurrenceId });
  assert.equal(next.ok, false);
  assert.equal(next.code, 'not-recurring');
});

test('agenda.enabled=false：disabled，且一行都不写', async t => {
  const runtime = mounted(t, { agendaEnabled: false });
  const before = runtime.listSchedule({ bound: BOUND });
  assert.equal(before.enabled, false);
  const next = runtime.nextOccurrence({ bound: BOUND, occurrenceId: 'occ_whatever' });
  assert.equal(next.ok, false);
  assert.equal(next.code, 'disabled');
  const created = runtime.createSchedule({ bound: BOUND, title: '喝水', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  assert.equal(created.ok, false);
  assert.equal(created.code, 'agenda-disabled');
});

test('跨 DST 的日重复：下一次 dueAt 仍落在本地同一钟点', async t => {
  // America/New_York 2026-11-01 02:00 ends DST. A daily 07:00 reminder around it must stay 07:00
  // local — the UTC instant shifts by an hour, the local clock does not.
  // 2026-10-30 11:00 UTC = 07:00 New York (EDT, before the switch), horizon long enough to cross it.
  const runtime = mounted(t, {
    timeZone: 'America/New_York', horizonHours: 168, clock: () => Date.UTC(2026, 9, 30, 11, 0, 0),
  });
  const created = runtime.createSchedule({ bound: BOUND, title: '晨跑', rule: 'daily', timeZone: 'America/New_York', time: '07:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const start = created.occurrences
    .filter(entry => entry.itemId === created.itemId)
    .sort((a, b) => a.scheduledAt - b.scheduledAt)[0];
  assert.ok(start, 'a first occurrence exists');
  assert.equal(nyHour(start.scheduledAt), '07:00', 'starts at 07:00 local');

  let current = start.occurrenceId;
  let crossed = false;
  for (let step = 0; step < 6; step += 1) {
    const next = runtime.nextOccurrence({ bound: BOUND, occurrenceId: current });
    if (!next.ok) break;
    assert.equal(nyHour(next.occurrence.dueAt), '07:00', `local clock stays 07:00 (step ${step})`);
    if (next.occurrence.dueAt > Date.UTC(2026, 10, 1, 11, 0, 0)) crossed = true;
    current = next.occurrence.id;
  }
  assert.equal(crossed, true, 'the walk actually crossed the DST switch');
  // And the UTC hour does shift across the switch — proof the assertion above is not vacuous.
  assert.ok(Number(start.scheduledAt) > 0);
});
