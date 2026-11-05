import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgendaPort, provideAgendaService } from '../agenda-port.mjs';

// `companion:agenda` 端口（P2.5 3A-4/3A-5）：转发语义 + 诚实降级 + 绝不抛错。
// 这是 QQ 提醒侧唯一会看到的形状，所以这里只测端口本身，不重复测 runtime 的 CAS（真跑 DB 的
// 六条在 `plugins/companion-runtime/test/agenda-cas.test.mjs`）。

const T0 = Date.UTC(2026, 10, 4, 23, 0, 0); // 2026-11-05 07:00 Asia/Shanghai

function runtimeStub(overrides = {}) {
  const calls = [];
  return {
    calls,
    createSchedule(input) {
      calls.push(['createSchedule', input]);
      return {
        ok: true,
        itemId: 'item-1',
        occurrences: [
          { occurrenceId: 'occ-earlier', scheduledAt: T0 - 3600000, revision: 1, status: 'scheduled' },
          { occurrenceId: 'occ-1', scheduledAt: T0, revision: 2, status: 'scheduled' },
        ],
        occurrence: { id: 'occ-1', revision: 2, dueAt: T0 },
        chosen: 'slot',
      };
    },
    casOccurrence(input) {
      calls.push(['casOccurrence', input]);
      if (overrides.cas) return overrides.cas(input);
      return { ok: true, revision: input.revision, occurrence: { id: input.occurrenceId, scheduleId: 'item-1', dueAt: T0, revision: input.revision, status: 'scheduled' } };
    },
    markOccurrenceDispatched(input) {
      calls.push(['markOccurrenceDispatched', input]);
      if (overrides.mark) return overrides.mark(input);
      return { ok: true, revision: input.revision + 1 };
    },
  };
}

test('转发：建日程会把它做成一条 once 计划，并绑定到同一时刻的 occurrence', () => {
  const cognitive = runtimeStub();
  const port = createAgendaPort({ cognitive, timeZone: 'Asia/Shanghai', now: () => T0 });
  const created = port.createSchedule({ text: '起床', at: T0, room: 'dm', target: 123, createdBy: 123 });
  assert.equal(created.ok, true);
  assert.equal(created.occurrenceId, 'occ-1', 'the occurrence that stands for this instant, not a neighbour');
  assert.equal(created.revision, 2);
  assert.deepEqual(created.occurrence, { id: 'occ-1', revision: 2, dueAt: T0 });
  assert.equal(created.chosen, 'slot', 'the runtime says which occurrence this call created');
  assert.equal(created.reminderDelivery, 'not-wired', 'creating a plan never claims delivery');
  const [, input] = cognitive.calls[0];
  assert.equal(input.rule, 'once');
  assert.equal(input.timeZone, 'Asia/Shanghai');
  assert.equal(input.date, '2026-11-05', 'local date in the schedule time zone');
  assert.equal(input.time, '07:00', 'local time in the schedule time zone');
  assert.equal(input.authorization, 'reminder');
});

test('转发：CAS 成功时把富签名收窄成提醒侧要的形状，并带上 dueAt/status', () => {
  const port = createAgendaPort({ cognitive: runtimeStub(), now: () => T0 });
  const out = port.casOccurrence({ occurrenceId: 'occ-1', revision: 2, at: T0 + 10 });
  assert.deepEqual(out, { ok: true, revision: 2, occurrenceId: 'occ-1', dueAt: T0, status: 'scheduled' });
});

test('转发：revision-changed 透传 actualRevision（提醒侧要能重读而不是猜）', () => {
  const port = createAgendaPort({
    cognitive: runtimeStub({ cas: () => ({ ok: false, code: 'revision-changed', actualRevision: 7 }) }),
  });
  const out = port.casOccurrence({ occurrenceId: 'occ-1', revision: 2, at: T0 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'revision-changed');
  assert.equal(out.actualRevision, 7);
});

test('转发：cancelled / not-found / disabled 原样透传，不粉饰', () => {
  const cases = ['cancelled', 'not-found', 'disabled'];
  for (const code of cases) {
    const port = createAgendaPort({ cognitive: runtimeStub({ cas: () => ({ ok: false, code }) }) });
    assert.equal(port.casOccurrence({ occurrenceId: 'occ-1', revision: 1, at: T0 }).code, code);
    const markPort = createAgendaPort({ cognitive: runtimeStub({ mark: () => ({ ok: false, code: code === 'cancelled' ? 'revision-changed' : code }) }) });
    assert.equal(markPort.markOccurrenceDispatched({ occurrenceId: 'occ-1', revision: 1, at: T0, receipt: 'r' }).code, code === 'cancelled' ? 'revision-changed' : code);
  }
});

test('转发：runtime 的 agenda-disabled 映射成 disabled（对外只有一个说法）', () => {
  const port = createAgendaPort({
    cognitive: runtimeStub({
      cas: () => ({ ok: false, code: 'agenda-disabled' }),
      mark: () => ({ ok: false, code: 'agenda-disabled' }),
    }),
  });
  assert.equal(port.casOccurrence({ occurrenceId: 'occ-1', revision: 1, at: T0 }).code, 'disabled');
  assert.equal(port.markOccurrenceDispatched({ occurrenceId: 'occ-1', revision: 1, at: T0, receipt: 'r' }).code, 'disabled');
});

test('记账：markOccurrenceDispatched 成功返回新 revision，且 receipt 被序列化成字符串', () => {
  const cognitive = runtimeStub();
  const port = createAgendaPort({ cognitive, now: () => T0 });
  const out = port.markOccurrenceDispatched({ occurrenceId: 'occ-1', revision: 2, at: T0, receipt: { messageId: 99 } });
  assert.deepEqual(out, { ok: true, revision: 3 });
  const [, input] = cognitive.calls[0];
  assert.equal(input.consumer, 'reminders');
  assert.equal(typeof input.receipt, 'string');
  assert.equal(input.receipt.includes('99'), true);
});

test('绝不抛错：runtime 未挂载 / 方法缺失 / 抛异常的三种情况都返回码', () => {
  for (const cognitive of [null, {}, { casOccurrence() { throw new Error('boom'); } }]) {
    const port = createAgendaPort({ cognitive, now: () => T0 });
    const cas = port.casOccurrence({ occurrenceId: 'occ-1', revision: 1, at: T0 });
    assert.equal(cas.ok, false, 'never throws');
    assert.ok(['runtime-not-mounted', 'agenda-failed'].includes(cas.code), cas.code);
    const marked = port.markOccurrenceDispatched({ occurrenceId: 'occ-1', revision: 1, at: T0, receipt: 'r' });
    assert.equal(marked.ok, false);
  }
});

test('诚实：describe() 明说 reminderDelivery 仍是 not-wired，且说明它不发送', () => {
  const port = createAgendaPort({ cognitive: runtimeStub(), timeZone: 'Asia/Shanghai' });
  const described = port.describe();
  assert.equal(described.service, 'companion:agenda');
  assert.equal(described.reminderDelivery, 'not-wired', 'implementing the seam does not wire delivery');
  assert.equal(described.mounted, true);
  assert.deepEqual(described.methods, ['createSchedule', 'casOccurrence', 'markOccurrenceDispatched', 'nextOccurrence']);
  assert.equal(port.describe().note.includes('never sends') || described.note.includes('delivery stays'), true);
});

test('建不成或找不到 occurrence 时如实说"没有绑定"，不编一个 id', () => {
  const noOccurrence = createAgendaPort({
    cognitive: { createSchedule: () => ({ ok: true, itemId: 'item-9', occurrences: [], occurrence: null, chosen: 'none' }) },
  });
  const created = noOccurrence.createSchedule({ text: '喝水', at: T0 });
  assert.equal(created.ok, true);
  assert.equal(created.occurrenceId, undefined, 'no invented binding');
  assert.equal(created.occurrence, null, 'no occurrence means null, never a guess');
  assert.equal(created.chosen, 'none');
  assert.equal(created.reminderDelivery, 'not-wired');

  const disabled = createAgendaPort({ cognitive: { createSchedule: () => ({ ok: false, code: 'agenda-disabled' }) } });
  assert.equal(disabled.createSchedule({ text: '喝水', at: T0 }).code, 'disabled');
});

// ---------------------------------------------------------------------------
// #1 `ctx.provide('companionAgenda', …)` —— 接缝生效的唯一途径
// ---------------------------------------------------------------------------

function fakeCtx(kind) {
  const calls = [];
  // A realistic host: what was provided is readable through `ctx.get` (round-3 B1 requires the publish
  // to be *verified* by reading it back, so the fake must be able to answer).
  const bag = {};
  const ctx = { calls, __bag: bag, get: name => bag[name] };
  if (kind === 'provide') ctx.provide = (name, value) => { calls.push(['provide', name, value]); bag[name] = value; };
  if (kind === 'set') ctx.set = (name, value) => { calls.push(['set', name, value]); bag[name] = value; };
  return ctx;
}

test('provide：通过 ctx.provide 暴露 companionAgenda，QQ 侧才取得到', () => {
  const ctx = fakeCtx('provide');
  const port = createAgendaPort({ cognitive: runtimeStub() });
  const out = provideAgendaService(ctx, port, { logger: () => {} });
  assert.deepEqual(out, { ok: true, via: 'provide', verified: true });
  const [, name, value] = ctx.calls[0];
  assert.equal(name, 'companionAgenda', 'the name the reminder channel asks for');
  assert.equal(value, port);
  for (const method of ['casOccurrence', 'markOccurrenceDispatched', 'describe']) {
    assert.equal(typeof value[method], 'function', `provided object has ${method}`);
  }
  assert.equal(value.describe().reminderDelivery, 'not-wired', 'providing it does not wire delivery');
});

test('provide：没有 ctx.provide 时回退 ctx.set，再没有就退属性赋值，且都记一行日志', () => {
  const logs = [];
  const setCtx = fakeCtx('set');
  assert.deepEqual(provideAgendaService(setCtx, createAgendaPort(), { logger: line => logs.push(line) }), { ok: true, via: 'set', verified: true });
  assert.equal(setCtx.calls[0][1], 'companionAgenda');

  const bare = {};
  assert.deepEqual(provideAgendaService(bare, createAgendaPort(), { logger: line => logs.push(line) }), { ok: true, via: 'property', verified: true });
  assert.equal(typeof bare.companionAgenda.casOccurrence, 'function');

  assert.equal(logs.some(line => line.includes('tier=set') && line.includes('read-back=hit')), true, 'the set tier ran and was verified');
  assert.equal(logs.some(line => line.includes('tier=property') && line.includes('read-back=hit')), true, 'the property tier ran and was verified');
});

test('B1：provide 抛错 → 降档重试（不再直接失败），且回读必须命中', () => {
  const logs = [];
  const exploding = { provide() { throw new Error('host exploded'); } };
  const out = provideAgendaService(exploding, createAgendaPort(), { logger: line => logs.push(line) });
  assert.deepEqual(out, { ok: true, via: 'property', verified: true }, 'a refused tier must not end the publish');
  assert.equal(typeof exploding.companionAgenda.casOccurrence, 'function');
  assert.equal(logs.some(line => line.includes('tier=provide') && line.includes('refused')), true);
  assert.equal(logs.some(line => line.includes('read-back=hit')), true);

  const none = [];
  assert.deepEqual(provideAgendaService(null, createAgendaPort(), { logger: line => none.push(line) }), { ok: false, via: 'none', verified: false });
  assert.equal(none.length, 1);
});

test('绑定歧义已消除：同一分钟建两条提醒 → 两条各自拿到不同的 occurrence id', () => {
  // A stub that behaves like the runtime: each call creates its own item+occurrence, so the ids
  // differ even though the instant is identical.
  let n = 0;
  const cognitive = {
    createSchedule(input) {
      n += 1;
      return {
        ok: true,
        itemId: `item-${n}`,
        occurrences: [{ occurrenceId: `occ-${n}`, scheduledAt: T0, revision: 1, status: 'scheduled' }],
        occurrence: { id: `occ-${n}`, revision: 1, dueAt: T0 },
        chosen: 'slot',
      };
    },
  };
  const port = createAgendaPort({ cognitive, timeZone: 'Asia/Shanghai', now: () => T0 });
  const first = port.createSchedule({ text: '起床', at: T0 });
  const second = port.createSchedule({ text: '喝水', at: T0 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.occurrence.id, 'occ-1');
  assert.equal(second.occurrence.id, 'occ-2');
  assert.notEqual(first.occurrence.id, second.occurrence.id, 'same minute, different reminders, different bindings');
  assert.equal(first.itemId, 'item-1');
  assert.equal(second.itemId, 'item-2');
});

test('无法确定时返回 occurrence: null（不许猜）', () => {
  const ambiguous = createAgendaPort({
    cognitive: {
      createSchedule: () => ({
        ok: true, itemId: 'item-x',
        occurrences: [
          { occurrenceId: 'occ-a', scheduledAt: T0, revision: 1 },
          { occurrenceId: 'occ-b', scheduledAt: T0 + 1000, revision: 1 },
        ],
        occurrence: null,
        chosen: 'none',
      }),
    },
  });
  const created = ambiguous.createSchedule({ text: '甲', at: T0 });
  assert.equal(created.ok, true);
  assert.equal(created.occurrence, null);
  assert.equal(created.occurrenceId, undefined);
  assert.equal(created.chosen, 'none', 'the caller can tell "unbound" from "bound"');
});

test('B1：回读拿不到本次发布的对象 → 明确失败，不是静默成功', () => {
  const logs = [];
  // A host that accepts the write and then answers `get` with something *else*.
  const liar = { provide() { /* accepts, stores nothing */ }, get: () => undefined };
  const out = provideAgendaService(liar, createAgendaPort(), { logger: line => logs.push(line) });
  assert.equal(out.verified, false, `an unverified publish must not report success (got ${JSON.stringify(out)})`);
  assert.equal(out.ok, false);
  assert.equal(logs.some(line => line.includes('read-back=MISS')), true, 'and it says so in the log');
});

test('B1：host 用 proxy 包装 → 回读仍命中（身份法会误判 MISS）', () => {
  const port = createAgendaPort();
  const bag = {};
  const ctx = {
    provide(name, value) { bag[name] = new Proxy(value, {}); },   // property access is forwarded
    get(name) { return bag[name]; },
  };
  const out = provideAgendaService(ctx, port, { logger: () => {} });
  assert.equal(out.verified, true, 'a proxy still exposes the publication marker');
  assert.equal(out.via, 'provide');
});

test('B1：host 深拷贝（丢标记）→ MISS，且明确失败', () => {
  const logs = [];
  const port = createAgendaPort();
  const bag = {};
  const ctx = {
    provide(name, value) { bag[name] = { ...value }; },           // deep-ish copy: no marker, not the same object
    get(name) { return bag[name]; },
  };
  const out = provideAgendaService(ctx, port, { logger: line => logs.push(line) });
  assert.equal(out.verified, false, 'a copy that lost the marker is not a working publish');
  assert.equal(out.ok, false);
  assert.equal(logs.some(line => line.includes('read-back=MISS')), true);
});

test('B6：名字已被别人占用 → 不覆盖、返回 name-taken、对方服务仍可读', () => {
  const logs = [];
  const theirs = { submitShareCandidate() { return { ok: true }; }, owner: 'someone-else' };
  const bag = { companionAgenda: theirs };
  const ctx = {
    provide() { throw new Error('service already published'); },   // the host refuses the name
    set(name, value) { bag[name] = value; },                        // a downgrade would clobber it
    get: name => bag[name],
  };
  const out = provideAgendaService(ctx, createAgendaPort(), { logger: line => logs.push(line) });
  assert.equal(out.ok, false, 'a taken name must not be reported as published');
  assert.equal(out.reason, 'name-taken');
  assert.equal(bag.companionAgenda, theirs, 'the other service is untouched');
  assert.equal(logs.some(line => line.includes('already taken')), true, 'and it says so');
});
