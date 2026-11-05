// 记忆档案 Studio · 健康接口（`/api/companion-health/*`）测试。
//
// 全部离线：健康服务是 stub（`{ health: () => stub }`），不启 sidecar、不碰真实
// `home/health/health.db`、不装依赖。这里要证明的四件事：
//   1. 健康路由的注册形状（同路径 GET/POST 合成一条 group、方法不匹配是 405 不是 404）；
//      —— 心跳共振（contract design/pulse-bond-20261103.md §7）追加的 `GET/POST /pulse`
//      只在这里做"表里在、既有 7 条没挪位"的断言，它的行为由 health-pulse-api.test.mjs 覆盖；
//   2. 服务缺失/服务报错时仍是 `health-unavailable` 信封（HTTP 200），绝不 404、绝不崩；
//   3. 参数收敛（days / metric / date / includeStages）与 5 分钟同步冷却；
//   4. 隐私：uid / token / uniqueId / rawRef / payload 一个字节都出不去。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  ALL_ROUTES, HEALTH_ROUTES, ROUTES, createStudioHandlers, groupRoutesByPath, registerStudioApi,
} from '../server.mjs';
import {
  HEALTH_PREFIX, MAINTENANCE_ACTIONS, SYNC_COOLDOWN_MS, TREND_METRICS, stripPrivate,
} from '../lib/health.mjs';

const P = HEALTH_PREFIX; // '/api/companion-health'
const GETS = ['status', 'sources', 'today', 'trends', 'sleep', 'care'];
const POSTS = ['sync', 'maintenance'];

// ---------------------------------------------------------------------------
// stub 健康服务（形状照契约 §11/§12，不含任何私有字段）
// ---------------------------------------------------------------------------

function makeService(overrides = {}) {
  const calls = [];
  const service = {
    status: () => ({
      ok: true,
      schemaVersion: 1,
      generatedAt: '2026-11-03T12:58:00.000Z',
      source: {
        id: 'huawei-cn',
        provider: 'huawei_cn_cloud',
        displayName: '华为运动健康（CN 云）',
        enabled: true,
        auth: { status: 'valid', minutesLeft: 3060, rotated: false },
      },
      db: { path: 'home/health/health.db', journalMode: 'wal', integrity: 'ok', sizeBytes: 40960, observations: 3 },
      sleep: { availability: 'awaiting_first_night', sessions: 0, lastSessionAt: null, stageFidelity: null, firstNightPending: true },
      consents: { 'health.connect': true, 'health.dashboard': true },
      faults: [],
    }),
    sources: () => [{
      id: 'huawei-cn',
      name: '华为运动健康（CN 云）',
      kind: 'wearable-cloud',
      capabilities: { activity: 'supported', sleep: { supported: false, status: 'awaiting_first_night', stageFidelity: 'unknown' } },
      notes: ['来源还没有上传睡眠数据。'],
    }],
    today: input => {
      calls.push(['today', input]);
      return {
        ok: true,
        date: input?.date ?? '2026-11-03',
        timezone: 'Asia/Shanghai',
        activity: { steps: 1112, distanceM: 810, kcal: 43 },
        metrics: { heartRate: { avg: 88, max: 112, min: 58, resting: 79 } },
        workouts: [],
        sleep: { availability: 'awaiting_first_night', session: null },
      };
    },
    trend: input => {
      calls.push(['trend', input]);
      return {
        ok: true, metric: input.metric, days: input.days, unit: '步', supported: true,
        points: [{ date: '2026-11-03', value: 1112, quality: 'fresh', observedAt: '2026-11-03T12:00:00.000Z' }],
        aggregate: { count: 1, mean: 1112, min: 1112, max: 1112, coveredDays: 1, missingDays: 0 },
      };
    },
    sleep: input => {
      calls.push(['sleep', input]);
      return {
        ok: true,
        availability: 'awaiting_first_night',
        timezone: 'Asia/Shanghai',
        range: { from: '2026-10-28', to: '2026-11-03' },
        sessions: [],
        trend: [],
        notes: ['还没有可信的一夜数据，等第一晚。'],
      };
    },
    care: () => {
      calls.push(['care']);
      return {
        ok: true,
        enabled: false,
        items: [],
        delivered: [],
        channel: 'conversation-inject',
        rules: { maxAgeHours: 18, maxChars: 160 },
        note: '主动关怀只把来源报过的事实说一遍，不外发到任何平台，也不给建议。',
      };
    },
    syncNow: async input => {
      calls.push(['syncNow', input]);
      return { ok: true, runId: 'run-1', status: 'ok', itemsSeen: 7, inserted: 7, updated: 0, skipped: 0 };
    },
    setConsent: async (capability, enabled) => {
      calls.push(['setConsent', capability, enabled]);
      return { ok: true, consents: { [capability]: enabled } };
    },
    start: async () => { calls.push(['start']); },
    stop: async () => { calls.push(['stop']); },
    isRunning: () => false,
    consents: () => ({ 'health.connect': true }),
  };
  return { service: { ...service, ...overrides }, calls };
}

function handlersWith(service, extra = {}) {
  return createStudioHandlers({ engine: null, identity: null, root: 'C:/tmp/studio', log: null, health: () => service, ...extra });
}

function url(pathAndQuery) {
  return `http://studio.local${pathAndQuery}`;
}

async function callGet(handlers, name, query = '') {
  const handler = handlers[`GET ${P}/${name}`];
  assert.equal(typeof handler, 'function', `缺少处理器：GET ${P}/${name}`);
  const response = await handler(new Request(url(`${P}/${name}${query}`)));
  return { status: response.status, headers: response.headers, json: await response.json() };
}

async function callPost(handlers, name, body) {
  const handler = handlers[`POST ${P}/${name}`];
  assert.equal(typeof handler, 'function', `缺少处理器：POST ${P}/${name}`);
  const init = { method: 'POST', headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const response = await handler(new Request(url(`${P}/${name}`), init));
  return { status: response.status, headers: response.headers, json: await response.json() };
}

// ---------------------------------------------------------------------------
// 1. 路由表与处理器表
// ---------------------------------------------------------------------------

test('1a. 处理器表里 6 个 GET + 2 个 POST 健康路由都在，且记忆路由一条没少', () => {
  const { service } = makeService();
  const handlers = handlersWith(service);
  for (const name of GETS) assert.equal(typeof handlers[`GET ${P}/${name}`], 'function', `缺 GET ${P}/${name}`);
  for (const name of POSTS) assert.equal(typeof handlers[`POST ${P}/${name}`], 'function', `缺 POST ${P}/${name}`);
  assert.equal(Object.keys(handlers).length, ROUTES.length + HEALTH_ROUTES.length);
  // 既有 7 条 + 心跳的 GET/POST /pulse 两条（契约 §7）+ 主动关怀 GET /care。
  assert.equal(HEALTH_ROUTES.length, 10);
  assert.deepEqual(HEALTH_ROUTES.map(route => `${route.method} ${route.path}`).sort(), [
    `GET ${P}/care`, `GET ${P}/pulse`,
    `GET ${P}/sleep`, `GET ${P}/sources`, `GET ${P}/status`, `GET ${P}/today`, `GET ${P}/trends`,
    `POST ${P}/maintenance`, `POST ${P}/pulse`, `POST ${P}/sync`,
  ].sort());
  // 既有 7 条的名字与顺序没被动过（心跳追加在末尾）。
  assert.deepEqual(HEALTH_ROUTES.slice(0, 7).map(route => route.name), [
    'health-status', 'health-sources', 'health-today', 'health-trends', 'health-sleep', 'health-sync',
    'health-maintenance',
  ]);
  // 既有记忆路由逐条都还在（不能被健康路由挤掉）。
  for (const route of ROUTES) assert.equal(typeof handlers[`${route.method} ${route.path}`], 'function', route.path);
});

test('1b. 同路径只有一条 group：/sync 只有 POST，/status 只有 GET', () => {
  const groups = groupRoutesByPath();
  const sync = groups.filter(group => group.path === `${P}/sync`);
  assert.equal(sync.length, 1, '/sync 只能有一条 group（Exact Fetch 按 path 去重）');
  assert.deepEqual(sync[0].methods, ['POST']);
  assert.deepEqual(sync[0].names, ['health-sync']);

  const status = groups.filter(group => group.path === `${P}/status`);
  assert.equal(status.length, 1);
  assert.deepEqual(status[0].methods, ['GET']);

  // 健康前缀一共 9 条路径（7 条数据路由 + 心跳的 GET/POST 合成 1 条），每条一条 group，且没有任何路径重复。
  const healthGroups = groups.filter(group => group.path.startsWith(`${P}/`));
  assert.equal(healthGroups.length, 9);
  assert.equal(new Set(healthGroups.map(group => group.path)).size, 9);
  // 每条路径的 methods 与路由表一致。
  for (const group of healthGroups) {
    const expected = HEALTH_ROUTES.filter(route => route.path === group.path).map(route => route.method);
    assert.deepEqual([...group.methods].sort(), [...expected].sort(), group.path);
  }
  // 默认输入 = 全部路由；显式传 ROUTES 时仍然只给记忆路由（plan-slot 测试依赖这一点）。
  assert.equal(groups.length, new Set(ALL_ROUTES.map(route => route.path)).size);
  assert.equal(groupRoutesByPath(ROUTES).length, new Set(ROUTES.map(route => route.path)).size);
});

// ---------------------------------------------------------------------------
// 2. 正常 GET：信封 + 透传
// ---------------------------------------------------------------------------

test('2. 正常 GET → ok:true、meta.source=companion-health、data 原样透传', async () => {
  const { service } = makeService();
  const handlers = handlersWith(service);

  const status = await callGet(handlers, 'status');
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal(status.json.ok, true);
  assert.equal(status.json.meta.source, 'companion-health');
  assert.equal(status.json.meta.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(status.json.meta.observedAt)));
  // 透传：stub 里没有私有键，所以 data 必须与 stub 返回值逐字相等。
  assert.deepEqual(status.json.data, service.status());
  assert.equal(status.json.data.sleep.availability, 'awaiting_first_night', 'awaiting_first_night 必须原样透传');
  assert.equal(status.json.data.sleep.firstNightPending, true);

  const sources = await callGet(handlers, 'sources');
  assert.equal(sources.json.ok, true);
  assert.equal(sources.json.meta.source, 'companion-health');
  assert.deepEqual(sources.json.data, service.sources());

  const today = await callGet(handlers, 'today', '?date=2026-11-01');
  assert.equal(today.json.ok, true);
  assert.equal(today.json.data.date, '2026-11-01');
  assert.equal(today.json.data.activity.steps, 1112);
  assert.equal(today.json.data.sleep.session, null);

  const sleep = await callGet(handlers, 'sleep');
  assert.equal(sleep.json.ok, true);
  assert.equal(sleep.json.data.availability, 'awaiting_first_night');
  assert.deepEqual(sleep.json.data.sessions, [], '没有睡眠数据时绝不编会话');
  assert.ok(sleep.json.data.notes.length > 0);
  assert.equal(sleep.json.meta.source, 'companion-health');

  const trends = await callGet(handlers, 'trends', '?metric=steps&days=7');
  assert.equal(trends.json.ok, true);
  assert.equal(trends.json.data.metric, 'steps');
  assert.equal(trends.json.data.days, 7);
});

// ---------------------------------------------------------------------------
// 3. 服务缺失 / 服务自己报错：都是 HTTP 200 的 health-unavailable
// ---------------------------------------------------------------------------

test('3. 健康服务没挂载 → 健康路由全部 ok:false + health-unavailable，HTTP 200（不是 404）', async () => {
  for (const service of [null, undefined]) {
    const handlers = handlersWith(service);
    for (const name of GETS) {
      const { status, json } = await callGet(handlers, name);
      assert.equal(status, 200, `GET ${name} 必须是 200`);
      assert.equal(json.ok, false, `GET ${name}`);
      assert.equal(json.error.code, 'health-unavailable', `GET ${name}`);
      assert.equal(json.meta.source, 'companion-health', `GET ${name} 的失败信封也带健康来源`);
      assert.ok(json.error.message.length > 0);
    }
    const sync = await callPost(handlers, 'sync', { days: 7 });
    assert.equal(sync.status, 200);
    assert.equal(sync.json.error.code, 'health-unavailable');
    const maintenance = await callPost(handlers, 'maintenance', { action: 'integrity' });
    assert.equal(maintenance.status, 200);
    assert.equal(maintenance.json.error.code, 'health-unavailable');
  }

  // 连 health 依赖都没传（`createStudioHandlers({})`）也一样，不抛、不 404。
  const bare = createStudioHandlers({});
  for (const name of GETS) {
    const response = await bare[`GET ${P}/${name}`](new Request(url(`${P}/${name}`)));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).error.code, 'health-unavailable');
  }
});

test('3b. 服务初始化失败（ok:false + health-db-unavailable）原样透出，不翻译、不 500', async () => {
  const { service } = makeService({
    status: () => ({ ok: false, code: 'health-db-unavailable', message: '健康库当前打不开。' }),
  });
  const handlers = handlersWith(service);
  const { status, json } = await callGet(handlers, 'status');
  assert.equal(status, 200);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'health-db-unavailable');
  assert.equal(json.error.message, '健康库当前打不开。');
  assert.equal(json.meta.source, 'companion-health');
});

test('3c. 服务方法抛异常 → internal 信封 + HTTP 200，宿主不崩', async () => {
  const { service } = makeService({ status: () => { throw new Error('boom with secrets'); } });
  const handlers = handlersWith(service);
  const { status, json } = await callGet(handlers, 'status');
  assert.equal(status, 200);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'internal');
  assert.equal(JSON.stringify(json).includes('boom with secrets'), false, '异常正文不得外泄');
});

// ---------------------------------------------------------------------------
// 4. 方法不匹配 → 405（沿用既有 methodNotAllowed），不是 404
// ---------------------------------------------------------------------------

async function registerWith(overrides = {}) {
  const registered = [];
  const labels = [];
  const ctx = {
    get: name => {
      if (name === 'connection') return { fetch: { register: route => { registered.push(route); return () => {}; } } };
      return overrides.services?.[name];
    },
    effect: (runner, label) => { labels.push(label); return runner(); },
    ...(overrides.inject === false ? {} : { inject: () => {} }),
  };
  const result = await registerStudioApi(ctx, { engine: null, identity: null, root: 'C:/tmp/studio', ...overrides.deps });
  return { result, registered, labels, ctx };
}

test('4. 同路径方法不匹配返回 405 信封：GET /sync → 405，POST /status → 405', async () => {
  const { service } = makeService();
  const { result, registered, labels } = await registerWith({
    services: { companionHealth: service },
    deps: {},
  });
  assert.equal(result.registered, new Set(ALL_ROUTES.map(route => route.path)).size);
  assert.equal(labels.length, registered.length);
  assert.ok(labels.every(label => label.startsWith('companion-memory-studio:')));

  const sync = registered.find(route => route.path === `${P}/sync`);
  assert.ok(sync, '/sync 必须注册到宿主');
  assert.deepEqual(sync.methods, ['POST']);
  const wrongMethod = await sync.fetch(new Request(url(`${P}/sync`), { method: 'GET' }));
  assert.equal(wrongMethod.status, 405, 'GET /sync 必须是 405，不能落进 404');
  const wrongBody = await wrongMethod.json();
  assert.equal(wrongBody.ok, false);
  assert.equal(wrongBody.error.code, 'bad-request');

  const status = registered.find(route => route.path === `${P}/status`);
  assert.deepEqual(status.methods, ['GET']);
  const statusPost = await status.fetch(new Request(url(`${P}/status`), { method: 'POST' }));
  assert.equal(statusPost.status, 405);

  // 正常方法仍然通：POST /sync 真的走到 service。
  const syncOk = await sync.fetch(new Request(url(`${P}/sync`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: 3 }),
  }));
  assert.equal(syncOk.status, 200);
  assert.equal((await syncOk.json()).ok, true);
});

test('4b. 无条件挂载（契约 §13）：宿主里没有健康服务也照样注册全部健康路径，回 health-unavailable 不 404', async () => {
  // 没有任何健康服务、连 ctx.inject 也没有（既有 api.test 的单测桩形状）：仍然挂满。
  const bare = await registerWith({ inject: false, deps: {} });
  assert.equal(bare.result.registered, new Set(ALL_ROUTES.map(route => route.path)).size);
  const bareHealth = bare.registered.filter(route => route.path.startsWith(P));
  assert.equal(bareHealth.length, 9, '服务不在场也必须注册 9 条健康路径（7 条数据 + /pulse + /care）');
  for (const route of bareHealth) {
    const response = await route.fetch(new Request(url(route.path), route.methods.includes('POST')
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
      : {}));
    assert.equal(response.status, 200, `${route.path} 不能是 404`);
    assert.equal((await response.json()).error.code, 'health-unavailable', route.path);
  }

  // 服务在场：同一条路径立刻能用（惰性 getter 每次现取，不需要重挂路由）。
  const { service } = makeService();
  const live = await registerWith({ inject: false, services: { companionHealth: service }, deps: {} });
  const status = live.registered.find(route => route.path === `${P}/status`);
  const response = await status.fetch(new Request(url(`${P}/status`)));
  assert.equal((await response.json()).ok, true);

  // 注册数永远是"完整路由表的唯一路径数"，与宿主能力、挂载顺序无关。
  const expected = new Set(ALL_ROUTES.map(route => route.path)).size;
  for (const variant of [{ inject: false }, { inject: true }]) {
    const { result } = await registerWith({ ...variant, deps: {} });
    assert.equal(result.registered, expected);
    assert.deepEqual([...result.paths].sort(), [...new Set(ALL_ROUTES.map(route => route.path))].sort());
  }
});

// ---------------------------------------------------------------------------
// 5. 参数收敛
// ---------------------------------------------------------------------------

test('5a. trends 的 days/metric 收敛：越界夹住、非数字回默认、非白名单回退但不静默', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);
  const lastTrend = () => calls.filter(call => call[0] === 'trend').at(-1)[1];

  await callGet(handlers, 'trends', '?days=999');
  assert.equal(lastTrend().days, 30, 'days 上限 30');
  await callGet(handlers, 'trends', '?days=0');
  assert.equal(lastTrend().days, 1, 'days 下限 1');
  await callGet(handlers, 'trends', '?days=abc');
  assert.equal(lastTrend().days, 7, '非数字回默认 7');
  await callGet(handlers, 'trends');
  assert.equal(lastTrend().days, 7, '缺省 7');

  await callGet(handlers, 'trends', '?metric=spo2');
  assert.equal(lastTrend().metric, 'spo2');
  await callGet(handlers, 'trends', '?metric=resting_heart_rate&days=30');
  assert.equal(lastTrend().metric, 'resting_heart_rate');
  const explicit = await callGet(handlers, 'trends', '?metric=spo2');
  assert.equal(explicit.json.data.metric, 'spo2');
  assert.equal('metricFallback' in explicit.json.data, false, '合法指标不得带回退标记');
  assert.equal('requestedMetric' in explicit.json.data, false);

  // 非白名单（拼错/未知）：回退到 steps，但必须**说出来** —— metricFallback + requestedMetric + note。
  for (const bogus of ['foo', '__proto__', 'heartRate', 'spo2x']) {
    const { json } = await callGet(handlers, 'trends', `?metric=${encodeURIComponent(bogus)}`);
    assert.equal(json.data.metric, 'steps', `回退到默认指标：${bogus}`);
    assert.equal(json.data.metricFallback, true, `回退必须标出来：${bogus}`);
    assert.equal(json.data.requestedMetric, bogus, `原值必须回显：${bogus}`);
    assert.ok(String(json.data.note).includes(bogus), `note 必须点出原值：${bogus}`);
    assert.match(json.data.note, /步数/, 'note 用中文说明回退到了什么');
    assert.equal(json.meta.source, 'companion-health');
  }
  assert.equal(lastTrend().metric, 'steps');

  // 参数缺失/空串不算"回退"（那是走默认值），不带这几个字段。
  const missing = await callGet(handlers, 'trends');
  assert.equal(missing.json.data.metric, 'steps');
  assert.equal('metricFallback' in missing.json.data, false);
  const blank = await callGet(handlers, 'trends', '?metric=');
  assert.equal('metricFallback' in blank.json.data, false);

  // 回显的是用户输入：必须限长、压成一行（绝不原样塞回去）。
  const long = await callGet(handlers, 'trends', `?metric=${encodeURIComponent(`x${'y'.repeat(500)}`)}`);
  assert.equal(long.json.data.metricFallback, true);
  assert.equal(long.json.data.requestedMetric.length, 40, '回显参数限长 40');
  const controls = await callGet(handlers, 'trends', `?metric=${encodeURIComponent('a\nb\tc')}`);
  assert.equal(/[\r\n\t]/.test(controls.json.data.requestedMetric), false, '回显参数必须压成一行');

  assert.deepEqual(TREND_METRICS, [
    'steps', 'distance_m', 'kcal', 'heart_rate', 'resting_heart_rate', 'stress', 'spo2', 'intensity',
  ]);
});

test('5b. sleep 的 date/days/includeStages 收敛，非法 date 直接忽略', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);
  const lastSleep = () => calls.filter(call => call[0] === 'sleep').at(-1)[1];

  await callGet(handlers, 'sleep', '?date=2026-11-01&days=31&includeStages=1');
  assert.deepEqual(lastSleep(), { date: '2026-11-01', days: 30, includeStages: true });

  await callGet(handlers, 'sleep', '?includeStages=true');
  assert.deepEqual(lastSleep(), { days: 7, includeStages: true });

  await callGet(handlers, 'sleep', '?includeStages=yes');
  assert.deepEqual(lastSleep(), { days: 7, includeStages: false }, "includeStages 只认 '1'/'true'");

  // 非法日期一律忽略（不带 date 键），由 service 用"今天"兜底。
  for (const bad of ['2026-11-3', '20261101', '2026-11-01T10:00:00', 'tomorrow', '']) {
    await callGet(handlers, 'sleep', `?date=${encodeURIComponent(bad)}`);
    assert.equal(Object.hasOwn(lastSleep(), 'date'), false, `非法日期必须被忽略：${bad}`);
  }
});

test('5c. today 的 date 同一套规则', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);

  await callGet(handlers, 'today', '?date=2026-10-30');
  assert.deepEqual(calls.filter(call => call[0] === 'today').at(-1)[1], { date: '2026-10-30' });
  await callGet(handlers, 'today', '?date=2026-13-45x');
  assert.deepEqual(calls.filter(call => call[0] === 'today').at(-1)[1], {}, '非法日期 → 传空对象');
  await callGet(handlers, 'today');
  assert.deepEqual(calls.filter(call => call[0] === 'today').at(-1)[1], {});
});

// ---------------------------------------------------------------------------
// 6. POST /sync：冷却 5 分钟（force 也不豁免）
// ---------------------------------------------------------------------------

test('6. POST /sync 冷却：第一次真跑，冷却内第二次 sync-cooldown，force 也不放过', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);

  const first = await callPost(handlers, 'sync', { days: 3, reason: 'manual' });
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.meta.source, 'companion-health');
  assert.equal(first.json.data.runId, 'run-1');
  const syncCalls = () => calls.filter(call => call[0] === 'syncNow');
  assert.equal(syncCalls().length, 1);
  assert.deepEqual(syncCalls()[0][1], { days: 3, force: false, reason: 'manual' });

  const second = await callPost(handlers, 'sync', { days: 3 });
  assert.equal(second.status, 200, '冷却不是 HTTP 错误');
  assert.equal(second.json.ok, false);
  assert.equal(second.json.error.code, 'sync-cooldown');
  assert.equal(second.json.meta.source, 'companion-health');
  const nextAllowedAt = Date.parse(second.json.data.nextAllowedAt);
  assert.ok(Number.isFinite(nextAllowedAt), '冷却响应必须给出 nextAllowedAt（ISO）');
  assert.ok(second.json.data.retryAfterMs > 0 && second.json.data.retryAfterMs <= SYNC_COOLDOWN_MS);
  assert.ok(nextAllowedAt > Date.now(), 'nextAllowedAt 必须在将来');
  assert.equal(syncCalls().length, 1, '冷却期内不许再打 service（也就不会发网络请求）');

  // force:true 不是冷却的免死金牌。
  const forced = await callPost(handlers, 'sync', { force: true, days: 7 });
  assert.equal(forced.json.error.code, 'sync-cooldown');
  assert.equal(syncCalls().length, 1);

  // 冷却按 service 实例隔离：换一个实例（重新挂载）就能立刻同步。
  const other = makeService();
  const otherHandlers = handlersWith(other.service);
  const fresh = await callPost(otherHandlers, 'sync', { days: 7 });
  assert.equal(fresh.json.ok, true);
  assert.equal(other.calls.filter(call => call[0] === 'syncNow').length, 1);
});

test('6b. POST /sync 参数收敛与坏请求', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);

  await callPost(handlers, 'sync', { days: 999, force: true, reason: 'manual' });
  assert.deepEqual(calls.filter(call => call[0] === 'syncNow')[0][1], { days: 30, force: true, reason: 'manual' });

  const badJson = await callPost(handlers, 'sync', '{not json');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, 'bad-request');
  assert.equal(badJson.json.meta.source, 'companion-health');

  // studio-ui 的按钮发的是 reason:'studio-ui'（见 src/client/pages-health.js），必须原样传给 service；
  // 未知 reason 才回退成 'manual'。
  const ui = makeService();
  await callPost(handlersWith(ui.service), 'sync', { days: 7, reason: 'studio-ui' });
  assert.equal(ui.calls.filter(call => call[0] === 'syncNow')[0][1].reason, 'studio-ui');
  const unknownReason = makeService();
  await callPost(handlersWith(unknownReason.service), 'sync', { days: 7, reason: 'whatever' });
  assert.equal(unknownReason.calls.filter(call => call[0] === 'syncNow')[0][1].reason, 'manual');
});

test('6c. POST /sync 失败也消耗配额（避免失败变成"可以一直点"），且不抛', async () => {
  let attempts = 0;
  const { service } = makeService({
    syncNow: async () => { attempts += 1; throw new Error('sidecar down'); },
  });
  const handlers = handlersWith(service);
  const first = await callPost(handlers, 'sync', { days: 7 });
  assert.equal(first.status, 200);
  assert.equal(first.json.error.code, 'internal');
  assert.equal(JSON.stringify(first.json).includes('sidecar down'), false);
  const second = await callPost(handlers, 'sync', { days: 7 });
  assert.equal(second.json.error.code, 'sync-cooldown');
  assert.equal(attempts, 1, '冷却期内不再调用');
});

// ---------------------------------------------------------------------------
// 7. POST /maintenance：pause / resume / integrity / backup / 未知动作
// ---------------------------------------------------------------------------

test('7a. pause/resume 走 `health.connect` consent（先落 consent 再启停采集）', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);

  const paused = await callPost(handlers, 'maintenance', { action: 'pause' });
  assert.equal(paused.status, 200);
  assert.equal(paused.json.ok, true);
  assert.equal(paused.json.data.action, 'pause');
  assert.equal(paused.json.data.capability, 'health.connect');
  assert.equal(paused.json.data.enabled, false);
  assert.deepEqual(calls.slice(0, 2), [['setConsent', 'health.connect', false], ['stop']]);

  calls.length = 0;
  const resumed = await callPost(handlers, 'maintenance', { action: 'resume' });
  assert.equal(resumed.json.ok, true);
  assert.equal(resumed.json.data.enabled, true);
  assert.deepEqual(calls.slice(0, 2), [['setConsent', 'health.connect', true], ['start']]);
});

test('7b. pause 在没有采集开关接口时回 unsupported-action（不假装成功）', async () => {
  const { service, calls } = makeService();
  delete service.setConsent;
  const handlers = handlersWith(service);
  const result = await callPost(handlers, 'maintenance', { action: 'pause' });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.code, 'unsupported-action');
  assert.equal(calls.filter(call => call[0] === 'stop').length, 0, 'consent 落不下去时不许启停采集');
});

test('7c. integrity 只读 service.status() 里已有的 db.integrity，不新开 DB 句柄', async () => {
  const { service } = makeService();
  const handlers = handlersWith(service);
  const { status, json } = await callPost(handlers, 'maintenance', { action: 'integrity' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.data.action, 'integrity');
  assert.equal(json.data.integrity, 'ok');
  assert.equal(json.data.journalMode, 'wal');
  assert.equal(json.data.sizeBytes, 40960);
  assert.ok(Number.isFinite(Date.parse(json.data.checkedAt)));

  const failed = makeService({ status: () => ({ ok: true, db: { integrity: 'failed' } }) });
  const failedResult = await callPost(handlersWith(failed.service), 'maintenance', { action: 'integrity' });
  assert.equal(failedResult.json.data.integrity, 'failed');

  const noStatus = makeService();
  delete noStatus.service.status;
  const result = await callPost(handlersWith(noStatus.service), 'maintenance', { action: 'integrity' });
  assert.equal(result.json.error.code, 'unsupported-action');
});

test('7d. backup：service 没暴露备份能力 → unsupported-action；暴露了（backup / backupTo）才真调', async () => {
  const plain = makeService();
  const unsupported = await callPost(handlersWith(plain.service), 'maintenance', { action: 'backup' });
  assert.equal(unsupported.status, 200);
  assert.equal(unsupported.json.ok, false);
  assert.equal(unsupported.json.error.code, 'unsupported-action');
  assert.match(unsupported.json.error.message, /备份/);

  // companion-health 门面的真实形状：backup() → { ok:true, path, bytes, at }。
  const real = makeService({
    backup: async () => ({ ok: true, path: 'home/health/backups/health-20261103.db', bytes: 40960, at: '2026-11-03T13:00:00.000Z' }),
  });
  const done = await callPost(handlersWith(real.service), 'maintenance', { action: 'backup' });
  assert.equal(done.status, 200);
  assert.equal(done.json.ok, true);
  assert.equal(done.json.data.action, 'backup');
  assert.equal(done.json.data.path, 'home/health/backups/health-20261103.db');
  assert.equal(done.json.data.bytes, 40960);
  assert.equal(done.json.data.at, '2026-11-03T13:00:00.000Z');

  // 服务自己的类型化拒绝（只读实例）原样透出，不当成成功。
  const readOnly = makeService({
    backup: async () => ({ ok: false, code: 'health-readonly', message: '只读实例不允许备份' }),
  });
  const refused = await callPost(handlersWith(readOnly.service), 'maintenance', { action: 'backup' });
  assert.equal(refused.status, 200);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.error.code, 'health-readonly');
  assert.equal(refused.json.error.message, '只读实例不允许备份');

  // 退路：只有 backupTo 的实现也认。
  const withBackupTo = makeService({ backupTo: async () => ({ path: 'home/health/health.db.bak', bytes: 40960, at: '2026-11-03T13:00:00.000Z' }) });
  const legacy = await callPost(handlersWith(withBackupTo.service), 'maintenance', { action: 'backup' });
  assert.equal(legacy.json.ok, true);
  assert.deepEqual(legacy.json.data.result, { path: 'home/health/health.db.bak', bytes: 40960, at: '2026-11-03T13:00:00.000Z' });
});

test('7e. 未知维护动作 → bad-request（400），坏 JSON 同样 400，且都带健康 meta', async () => {
  const { service } = makeService();
  const handlers = handlersWith(service);

  const unknown = await callPost(handlers, 'maintenance', { action: 'nope' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.ok, false);
  assert.equal(unknown.json.error.code, 'bad-request');
  assert.equal(unknown.json.meta.source, 'companion-health');

  const missing = await callPost(handlers, 'maintenance', {});
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'bad-request');

  const badJson = await callPost(handlers, 'maintenance', 'not-json');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, 'bad-request');

  assert.deepEqual(MAINTENANCE_ACTIONS, ['pause', 'resume', 'integrity', 'backup']);
  // 其它动作（例如 rebuild / sync）不能借道 maintenance。
  for (const action of ['rebuild', 'sync', 'delete']) {
    const result = await callPost(handlers, 'maintenance', { action });
    assert.equal(result.json.error.code, 'bad-request', action);
  }
});

// ---------------------------------------------------------------------------
// 8. stripPrivate 单元测试
// ---------------------------------------------------------------------------

test('8. stripPrivate 递归删掉 uid/token/uniqueId/devId/rawRef/payload，其它字段原样保留', () => {
  const input = {
    ok: true,
    source: {
      id: 'huawei-cn',
      token: 'sk-live-should-not-leak',
      auth: { status: 'valid', uid: '123456789', minutesLeft: 3060 },
    },
    devices: [
      { name: 'Watch', device_class: 'watch', uniqueId: 'A8:C8:3A:00:00:01', devId: 'dev-1', priority: 3 },
      { name: 'Band', device_class: 'band', nested: { raw_ref: 'ref-1', keep: 'yes' } },
    ],
    sleep: { sessions: [{ sleepDate: '2026-11-02', rawRef: 'r1', asleepMinutes: 405, stageFidelity: 'partial' }] },
    payload: { anything: 'raw upstream json' },
    counts: { observations: 3, workouts: 2 },
    nullish: null,
    text: 'ok',
    numbers: [1, 2, 3],
  };

  const cleaned = stripPrivate(input);
  // 命中键名的一律消失。
  assert.equal(Object.hasOwn(cleaned.source, 'token'), false);
  assert.equal(Object.hasOwn(cleaned.source.auth, 'uid'), false);
  assert.equal(Object.hasOwn(cleaned.devices[0], 'uniqueId'), false);
  assert.equal(Object.hasOwn(cleaned.devices[0], 'devId'), false);
  assert.equal(Object.hasOwn(cleaned.devices[1].nested, 'raw_ref'), false);
  assert.equal(Object.hasOwn(cleaned.sleep.sessions[0], 'rawRef'), false);
  assert.equal(Object.hasOwn(cleaned, 'payload'), false);
  // 其它一律保留（含数组、嵌套对象、null、数字）。
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.source.id, 'huawei-cn');
  assert.equal(cleaned.source.auth.status, 'valid');
  assert.equal(cleaned.source.auth.minutesLeft, 3060);
  assert.equal(cleaned.devices[0].name, 'Watch');
  assert.equal(cleaned.devices[0].priority, 3);
  assert.equal(cleaned.devices[1].nested.keep, 'yes');
  assert.equal(cleaned.sleep.sessions[0].asleepMinutes, 405);
  assert.equal(cleaned.counts.observations, 3);
  assert.equal(cleaned.nullish, null);
  assert.equal(cleaned.text, 'ok');
  assert.deepEqual(cleaned.numbers, [1, 2, 3]);
  // 原对象不被改写（只洗不改）。
  assert.equal(input.source.token, 'sk-live-should-not-leak');
  // 大小写与下划线变体同样拦。
  assert.equal(stripPrivate({ Token: 'x', UNIQUEID: 'y', RAW_REF: 'z', RawRef: 'w', Payload: 'p' }).Token, undefined);
  assert.deepEqual(stripPrivate({ Token: 'x', unique_id_hash: 'abc' }), { unique_id_hash: 'abc' });
  // 原始值与非对象输入不炸。
  assert.equal(stripPrivate('plain'), 'plain');
  assert.equal(stripPrivate(7), 7);
  assert.equal(stripPrivate(null), null);
  assert.deepEqual(stripPrivate([{ token: 'x', keep: 1 }]), [{ keep: 1 }]);
});

// ---------------------------------------------------------------------------
// 9. 隐私回归：响应 JSON 字符串里不得出现任何私有值
// ---------------------------------------------------------------------------

test('9. 隐私回归：stub 塞进去的 token/uid/uniqueId/rawRef/payload 一个都不能出现在响应里', async () => {
  const secrets = {
    token: 'tk-ACCESS-DO-NOT-LEAK',
    uid: '123456789',
    uniqueId: 'A8:C8:3A:11:22:33',
    devId: 'DEV-SECRET-42',
    rawRef: 'raw-ref-abc123',
  };
  const poison = () => ({
    ok: true,
    source: {
      id: 'huawei-cn',
      auth: { status: 'valid', token: secrets.token, uid: secrets.uid, minutesLeft: 10 },
    },
    devices: [{ name: 'Watch', uniqueId: secrets.uniqueId, devId: secrets.devId }],
    sleep: { availability: 'present', sessions: [{ sleepDate: '2026-11-02', rawRef: secrets.rawRef }] },
    payload: { upstream: 'verbatim cloud json', accessToken: secrets.token },
    faults: [],
  });
  const { service } = makeService({
    status: poison,
    sources: () => [poison()],
    today: () => poison(),
    trend: () => poison(),
    sleep: () => poison(),
    // /care 是一条**真会被调用**的 GET 路由（不是 poison）：只读路由必须能在没有任何
    // 网络/数据库副作用的条件下回答，所以给它一个具体的形状，而不是"一调就炸"。
    care: () => ({
      ok: true,
      enabled: false,
      items: [],
      delivered: [],
      channel: 'conversation-inject',
      rules: { maxAgeHours: 18, maxChars: 160 },
      note: '主动关怀只把来源报过的事实说一遍，不外发到任何平台，也不给建议。',
    }),
    syncNow: async () => poison(),
    backup: async () => poison(),
  });
  const handlers = handlersWith(service);

  const bodies = [];
  for (const name of GETS) bodies.push([name, (await callGet(handlers, name)).json]);
  bodies.push(['sync', (await callPost(handlers, 'sync', { days: 7 })).json]);
  bodies.push(['maintenance-integrity', (await callPost(handlers, 'maintenance', { action: 'integrity' })).json]);
  bodies.push(['maintenance-backup', (await callPost(handlers, 'maintenance', { action: 'backup' })).json]);

  for (const [name, json] of bodies) {
    const text = JSON.stringify(json);
    for (const [key, value] of Object.entries(secrets)) {
      assert.equal(text.includes(value), false, `${name} 的响应里出现了 ${key} 的值`);
    }
    assert.equal(text.includes('verbatim cloud json'), false, `${name} 不许带原始 payload`);
    assert.equal(/"(token|uid|uniqueId|devId|rawRef|raw_ref|payload)"/.test(text), false, `${name} 不许出现这些键名`);
    assert.equal(json.meta.source, 'companion-health');
  }

  // 洗掉私有字段后，正常字段仍然在（不是把整个对象扔了）。
  const status = await callGet(handlers, 'status');
  assert.equal(status.json.data.source.id, 'huawei-cn');
  assert.equal(status.json.data.source.auth.status, 'valid');
  assert.equal(status.json.data.devices[0].name, 'Watch');
  assert.equal(status.json.data.sleep.sessions[0].sleepDate, '2026-11-02');
});

// ---------------------------------------------------------------------------
// 10. 硬约束：只读路由绝不发网络请求、绝不自己开 SQLite
// ---------------------------------------------------------------------------

test('10a. 6 条 GET 路由在 fetch 被换成"一调就炸"时仍然全部成功（证明不发网络请求）', async () => {
  const { service } = makeService();
  const handlers = handlersWith(service, {
    fetchImpl: () => { throw new Error('GET 路由不许发网络请求'); },
  });
  const original = globalThis.fetch;
  let opened = 0;
  globalThis.fetch = () => { opened += 1; throw new Error('GET 路由不许发网络请求'); };
  try {
    for (const name of GETS) {
      const { status, json } = await callGet(handlers, name);
      assert.equal(status, 200, name);
      assert.equal(json.ok, true, `${name}：${JSON.stringify(json)}`);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(opened, 0, '只读路由一次网络请求都不许发');
});

test('10b. 源码护栏：lib/health.mjs 不碰 fetch、不碰 SQLite、不碰 sidecar 地址', () => {
  const source = fs.readFileSync(new URL('../lib/health.mjs', import.meta.url), 'utf8');
  assert.equal(/globalThis\.fetch|\bfetch\s*\(/.test(source), false, 'health.mjs 不得调用 fetch');
  assert.equal(/node:sqlite|DatabaseSync|\.prepare\s*\(|SELECT\s/i.test(source), false, 'health.mjs 不得自己开 SQLite / 写 SQL');
  assert.equal(/127\.0\.0\.1|8765|localhost/.test(source), false, 'health.mjs 不得直连 sidecar');
  assert.equal(/api\/data/.test(source), false, 'health.mjs 不得拼 sidecar 接口');
  // 只读手段：GET 处理函数里不许出现 syncNow。
  const gets = source.slice(source.indexOf('GET · 只读'), source.indexOf('POST /sync'));
  assert.equal(/syncNow/.test(gets), false, 'GET 段落里不得出现 syncNow');
});
