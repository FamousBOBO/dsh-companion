import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLife } from '../lib/companion-dashboard.mjs';

// P2 day view (production defect, 2026-10-31).
//
// The customer's own rows are the fixture: `test/fixtures/p2-dayview-live.json` is the real
// production `p2_plan` / `p2_slots` / `p2_activities` / `p2_receipts` of scope
// `u:1429709395|p:march7|w:world:default` for 2026-10-31. The page used to say 未完成 for a
// slot whose activity really finished, because it rendered `p2_plan_slots.status` instead of
// looking at the evidence. These tests pin the evidence-based outcome, the whole-day timetable
// and the honest state, then assert on the rendered component that the words are right.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'p2-dayview-live.json');
const CONFIG = { p2: { planning: { enabled: true }, activities: { enabled: true } } };
// 2026-10-31 06:14:17 Asia/Shanghai — the instant the production dashboard was captured.
const OBSERVED = Date.UTC(2026, 9, 30, 22, 14, 17);
const FINISHED_SLOT = 'slot_f3615f2ece24697197f366e8';   // 再看一眼《静夜思》 (status 'started')
const REST_SLOT = 'slot_d36106e38885824d731113be';       // 关灯睡觉 (kind 'rest')
const SUPERSEDED_SLOT = 'slot_7716dea1381d6e763f6dfc72'; // belongs to plan_e390… (superseded)

function fixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function productionLife(now = OBSERVED) {
  return buildLife({ sections: fixture().sections, unavailable: [] }, CONFIG, now);
}

function slotOf(life, slotId) {
  return life.today.find(slot => slot.slotId === slotId) ?? null;
}

test('Bilibili day view preserves an unknown round and partial consumption', () => {
  const { sections } = fixture();
  const slot = sections.p2_slots.find(row => row.slot_id === FINISHED_SLOT);
  const activity = sections.p2_activities.find(row => row.plan_slot_id === FINISHED_SLOT || row.started_at === slot.start_at);
  slot.activity = 'bilibili';
  Object.assign(activity, { kind: 'bilibili', status: 'failed', bili_status: 'unknown', bili_watched: 2 });
  sections.p2_receipts = sections.p2_receipts.filter(row => row.activity_id !== activity.activity_id);
  const view = slotOf(buildLife({ sections }, CONFIG, OBSERVED), FINISHED_SLOT);
  assert.equal(view.outcome, 'review');
  assert.deepEqual(view.bilibiliRound, { status: 'unknown', watched: 2 });
});

test('P2 day view: the production day reads 已完成 / 已结束（休息），never 未完成', () => {
  const life = productionLife();
  const finished = slotOf(life, FINISHED_SLOT);
  assert.ok(finished, 'the finished slot is in the timetable');
  assert.equal(finished.status, 'started', 'the raw row status is untouched (debuggable)');
  assert.equal(finished.outcome, 'completed', 'a done activity + finish ok=1 beats the row status');
  assert.equal(finished.outcomeLabel, '已完成');
  assert.notEqual(finished.outcomeLabel, '未完成');
  assert.ok(!life.ended.some(slot => slot.outcome === 'missed'), 'nothing on this day is 未完成');

  const rest = slotOf(life, REST_SLOT);
  assert.equal(rest.kind, 'rest');
  assert.equal(rest.outcome, 'rest-ended', 'a rest window ending is not a failure');
  assert.equal(rest.outcomeLabel, '已结束（休息）');
});

test('P2 day view: a rest slot that ended is rest-ended even with no activity at all', () => {
  const now = OBSERVED;
  const life = buildLife({
    sections: {
      p2_plan: [{ plan_id: 'p1', day: '2026-10-31', version: 1, status: 'committed', window_start: now - 3600000, window_end: now + 6 * 3600000, summary: 's' }],
      p2_slots: [{ slot_id: 's-rest', plan_id: 'p1', start_at: now - 3600000, end_at: now - 1800000, kind: 'rest', activity: '', title: '闭眼', flexibility: 'soft', status: 'planned', locked: 0 }],
      p2_activities: [], p2_receipts: [], agenda: [], occurrences: [],
    },
  }, CONFIG, now);
  assert.equal(slotOf(life, 's-rest').outcome, 'rest-ended');
});

test('P2 day view: an activity slot that ended with nothing really is 未完成', () => {
  const now = OBSERVED;
  const life = buildLife({
    sections: {
      p2_plan: [{ plan_id: 'p1', day: '2026-10-31', version: 1, status: 'committed', window_start: now - 3600000, window_end: now + 6 * 3600000, summary: 's' }],
      p2_slots: [
        { slot_id: 's-gone', plan_id: 'p1', start_at: now - 3600000, end_at: now - 1800000, kind: 'activity', activity: 'read', title: '没读成', flexibility: 'soft', status: 'planned', locked: 0 },
        { slot_id: 's-paused', plan_id: 'p1', start_at: now - 1800000, end_at: now - 600000, kind: 'activity', activity: 'read', title: '读到一半', flexibility: 'soft', status: 'started', locked: 0 },
      ],
      p2_activities: [{ activity_id: 'a-paused', plan_slot_id: 's-paused', kind: 'read', status: 'paused', consumed_prefix: 200, total_units: 1402, started_at: now - 1800000, updated_at: now - 900000 }],
      p2_receipts: [{ activity_id: 'a-paused', operation: 'review', ok: 0, code: 'source-changed', at: now - 900000 }],
      agenda: [], occurrences: [],
    },
  }, CONFIG, now);
  assert.equal(slotOf(life, 's-gone').outcome, 'missed');
  assert.equal(slotOf(life, 's-gone').outcomeLabel, '未完成', 'only a slot with no evidence may read unfinished');
  assert.equal(slotOf(life, 's-paused').outcome, 'review');
  assert.equal(slotOf(life, 's-paused').outcomeLabel, '待复核');
});

test('P2 day view: an empty next still lists the whole day and says why', () => {
  const life = productionLife();
  assert.equal(life.next.length, 0, 'the fixture really has nothing upcoming');
  assert.ok(Array.isArray(life.today) && life.today.length >= 2, 'the timetable survives an empty next');
  assert.deepEqual(life.today.map(slot => slot.slotId).sort(), [FINISHED_SLOT, REST_SLOT].sort());

  assert.equal(life.plan.status, 'committed', 'the plan status survives (it was dropped before)');
  assert.equal(life.planStatus, 'committed');
  assert.equal(life.plan.version, 1);
  assert.ok(String(life.plan.summary).length > 0, 'the plan summary is there to render');

  assert.equal(life.state, 'plan-exhausted', 'a committed plan with nothing left is not "today done"');
  assert.match(life.reason, /还没结束|没有补充/);
  assert.notEqual(life.state, 'today-done');

  // Past the plan's window the honest state is 今天已结束.
  const later = buildLife({ sections: fixture().sections }, CONFIG, Date.UTC(2026, 9, 31, 17, 0, 0));
  assert.equal(later.state, 'today-done');
  assert.match(later.reason, /结束/);
});

test('P2 day view: a superseded plan does not leak into today’s timetable', () => {
  const life = productionLife();
  assert.ok(!life.today.some(slot => slot.slotId === SUPERSEDED_SLOT), 'history of another plan is not today');
  assert.ok(!life.ended.some(slot => slot.slotId === SUPERSEDED_SLOT));
  assert.ok(life.history.some(slot => slot.slotId === SUPERSEDED_SLOT), 'but it is still exposed as history');
});

test('P2 day view: locked slots keep their lock and the whole-day view keeps outcomes', () => {
  const now = OBSERVED;
  const life = buildLife({
    sections: {
      p2_plan: [{ plan_id: 'p1', day: '2026-10-31', version: 2, status: 'committed', window_start: now - 3600000, window_end: now + 6 * 3600000, summary: 's' }],
      p2_slots: [{ slot_id: 's-locked', plan_id: 'p1', start_at: now + 3600000, end_at: now + 5400000, kind: 'activity', activity: 'write', title: '写一段', flexibility: 'firm', status: 'planned', locked: 1 }],
      p2_activities: [], p2_receipts: [], agenda: [], occurrences: [],
    },
  }, CONFIG, now);
  const locked = slotOf(life, 's-locked');
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.controls, ['unlock', 'skip'], 'a locked slot offers unlock, not lock');
  assert.equal(locked.outcome, 'upcoming');
  assert.equal(locked.outcomeLabel, '计划中');
});

test('P2 day view: H1 arrangements are the only 已约好 items, autonomous slots are 自主', () => {
  const now = OBSERVED;
  const life = buildLife({
    sections: {
      p2_plan: [{ plan_id: 'p1', day: '2026-10-31', version: 1, status: 'committed', window_start: now - 3600000, window_end: now + 6 * 3600000, summary: 's' }],
      p2_slots: [{ slot_id: 's1', plan_id: 'p1', start_at: now + 600000, end_at: now + 2400000, kind: 'activity', activity: 'read', title: '读一首诗', flexibility: 'soft', status: 'planned', locked: 0 }],
      p2_activities: [], p2_receipts: [],
      agenda: [{ item_id: 'i1', title: '和她视频', category: 'call', status: 'active' }],
      occurrences: [{ occurrence_id: 'o1', item_id: 'i1', scheduled_at: now + 1200000, status: 'scheduled' }],
    },
  }, CONFIG, now);
  assert.equal(slotOf(life, 's1').origin, 'self', 'an autonomous slot says whose arrangement it is');
  assert.equal(life.arrangements.length, 1);
  assert.equal(life.arrangements[0].title, '和她视频');
  assert.equal(life.arrangements[0].origin, 'h1', 'H1 items are the only arrangements');
});

// ---------------------------------------------------------------------------- component
//
// The page is a plain `(function (P) { … })(P)` module, so it can be executed in Node with a
// tiny element factory instead of a DOM. What matters here is the *words* the user reads:
// 已完成 next to the finished slot and no 未完成 anywhere on this payload.

function stubRuntime() {
  const pages = [];
  const flatten = node => {
    if (node === null || node === undefined || node === false) return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(flatten);
    if (typeof node === 'function') return flatten(node());
    if (typeof node !== 'object') return [];
    const out = [];
    // Title/props that the real components render as text.
    for (const key of ['title', 'label', 'text', 'hint', 'ariaLabel']) {
      if (typeof node.props?.[key] === 'string') out.push(node.props[key]);
    }
    for (const key of ['items', 'side', 'meta']) {
      const value = node.props?.[key];
      if (value) out.push(...flatten(value));
    }
    if (node.children) out.push(...flatten(node.children));
    return out;
  };
  const node = (name, props, children) => ({ type: name, props: props || {}, children: children || [] });
  // `ui.X` stubs are *host* factories (one props object, then children); a function component
  // (`h(BandNow, …)`) is invoked, because that is what rendering means here.
  const ui = new Proxy({}, {
    get: (_target, name) => {
      const factory = (props = {}, ...children) => node(String(name), props, children);
      factory.__host = true;
      return factory;
    },
  });
  const element = (type, props, ...children) => {
    if (type && type.__host) return type(props || {}, ...children);
    if (typeof type === 'function') return type({ ...(props || {}), children });
    return node(String(type ?? 'fragment'), props, children);
  };
  const P = {
    h: element,
    ui,
    css: () => {},
    registerPage: definition => { pages.push(definition); },
    fmt: {
      range: (start, end) => `${new Date(start).toISOString()}–${new Date(end).toISOString()}`,
      number: value => String(value),
      dateTime: at => new Date(at).toISOString(),
      date: at => new Date(at).toISOString().slice(0, 10),
    },
    useApi: loader => ({ data: stubRuntime.payload, error: null, loading: false, reload: () => { stubRuntime.reloads += 1; } }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    api: { get: async () => stubRuntime.payload, post: async () => ({ ok: true }) },
    notice: () => {},
    confirm: () => true,
    failText: error => String(error && error.message),
    lifeTone: () => 'idle',
    TOKENS: {},
    flatten,
  };
  return { P, pages, flatten };
}

/** Every rendered `Row`, as `{ title, text }` (title + side + meta), for per-row assertions. */
function rowsOf(tree, flatten) {
  const out = [];
  const walk = node => {
    if (!node || typeof node !== 'object') {
      if (Array.isArray(node)) node.forEach(walk);
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'Row') {
      out.push({
        title: String(node.props?.title ?? ''),
        text: [node.props?.title, ...flatten(node.props?.side), ...flatten(node.props?.meta), ...flatten(node.props?.ariaLabel)].join(' · '),
      });
    }
    if (node.children) node.children.forEach(walk);
  };
  walk(tree);
  return out;
}

async function renderLifePage(payload) {
  stubRuntime.payload = payload;
  stubRuntime.reloads = 0;
  const runtime = stubRuntime();
  runtime.P.useApi = () => ({ data: payload, error: null, loading: false, reload: () => { stubRuntime.reloads += 1; } });
  globalThis.P = runtime.P;
  const modulePath = new URL('../src/client/pages-life.js', import.meta.url);
  modulePath.search = `?v=${Math.random().toString(36).slice(2)}`;
  await import(modulePath.href);
  const page = runtime.pages.find(definition => definition.id === 'life');
  assert.ok(page, 'the life page registered');
  const tree = page.component();
  return { tree, text: runtime.flatten(tree).join('\n'), rows: rowsOf(tree, runtime.flatten) };
}

test('P2 day view component: the finished slot renders 已完成 and the rest slot is not a failure', async () => {
  const life = productionLife();
  const payload = {
    observedAt: OBSERVED, runtime: { available: true }, unavailable: [],
    sections: { goals: [], commitments: [] }, life,
  };
  const { text, rows } = await renderLifePage(payload);

  const finished = rows.find(row => row.title === '再看一眼《静夜思》');
  assert.ok(finished, 'the finished slot renders as a row');
  assert.match(finished.text, /已完成/, 'and it says 已完成');
  assert.doesNotMatch(finished.text, /未完成/, 'never 未完成');

  const rest = rows.find(row => row.title === '关灯睡觉');
  assert.ok(rest, 'the rest slot renders as a row');
  assert.match(rest.text, /已结束（休息）/, 'a rest window that ended is labelled as rest, not failure');
  assert.doesNotMatch(rest.text, /未完成/);

  // No row on this payload may read 未完成（the 未完成待续 band title is a section name, so the
  // assertion is per row, which is where the defect was).
  assert.ok(!rows.some(row => /未完成/.test(row.text)), `no row reads 未完成: ${JSON.stringify(rows.map(r => r.title))}`);
  assert.match(text, /已结束（休息）/, 'the words reach the rendered page');

  // The plan must stay visible even though `next` is empty.
  assert.match(text, /全天时段/, 'the whole-day timetable is rendered');
  assert.match(text, /第 1 版计划/, 'the plan version is rendered');
  assert.match(text, /已提交/, 'the plan status is rendered');
  assert.match(text, /计划已经排完，今天还没结束/, 'the empty next state tells the truth');
  assert.match(text, /自主/, 'autonomous slots are labelled as her own arrangement');
});

test('P2 day view component: no 未完成 for a slot whose evidence is a finish receipt', async () => {
  // Same payload but with only the finished slot, so a stray 未完成 cannot be hidden by the
  // rest row: the failure mode was per-row, so pin the row itself.
  const life = productionLife();
  const onlyFinished = {
    ...life,
    today: life.today.filter(slot => slot.slotId === FINISHED_SLOT),
    ended: life.ended.filter(slot => slot.slotId === FINISHED_SLOT),
    next: [], pending: [], skipped: [],
  };
  const { rows } = await renderLifePage({
    observedAt: OBSERVED, runtime: { available: true }, unavailable: [], sections: { goals: [], commitments: [] }, life: onlyFinished,
  });
  const finished = rows.find(row => row.title === '再看一眼《静夜思》');
  assert.ok(finished, 'the finished slot renders as a row');
  assert.match(finished.text, /已完成/);
  assert.doesNotMatch(finished.text, /未完成/);
});
