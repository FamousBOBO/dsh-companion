// 记忆档案 Studio · 心跳共振接口（`/api/companion-health/pulse`）测试。
//
// 契约：design/pulse-bond-20261103.md §4.4（facade 形状）、§7（studio 路由）、§10（写入范围）。
//
// 全部离线：健康服务是 stub（`{ health: () => stub }`），不启 sidecar、不碰 BLE、不碰真实
// `home/health/health.db`。这里要证明的六件事：
//   1. 路由表：GET/POST 同一条路径合成一条 group，既有 7 条健康路由一条没动、顺序也没动；
//   2. GET 正常信封：`meta.source === 'companion-health'`，data 就是 `pulse()` 那一份视图；
//   3. POST 三个会话动作真的落到 `pulseSession()`，参数（minutes / label）先收敛再发；
//   4. `consent` 动作只能改 `health.pulse.live`（不接受任意 capability），写不过去就原样透出；
//   5. 服务缺失 → `health-unavailable`；服务缺方法 → `health-method-missing`；都没挂 → 也不抛；
//   6. facade 抛异常 / 返回 `{ok:false}` 一律 HTTP 200 的信封，未知 action 才是 400。
//
// 硬约束（也是契约要求）：心跳数据不外流 —— 不写库、不进日志、不进 meta；这一层永远不 500。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  ALL_ROUTES, HEALTH_ROUTES, ROUTES, createStudioHandlers, groupRoutesByPath, registerStudioApi,
} from '../server.mjs';
import {
  HEALTH_PREFIX, PULSE_ACTIONS, PULSE_CONSENT_CAPABILITY, PULSE_SESSION_ACTIONS,
} from '../lib/health.mjs';

const P = HEALTH_PREFIX; // '/api/companion-health'
const PATH = `${P}/pulse`;

// ---------------------------------------------------------------------------
// stub 健康服务：形状照契约 §4.4 的四个 facade 方法
// ---------------------------------------------------------------------------

/** 契约 §4.4 里 `pulse()` 的那一份视图（含真实形状里最容易踩的两个 null）。 */
function pulseView(overrides = {}) {
  return {
    ok: true,
    enabled: true,
    sidecar: { reachable: true, baseUrl: 'http://127.0.0.1:8151' },
    connected: true,
    deviceLabel: 'FIXTURE-STRAP',
    bpm: 118,
    sampleAgeMs: 900,
    quality: 'ok',
    zone: 'racing',
    trend: 'up',
    baseline: 92,
    peak: { bpm: 137, at: 1793731234567 },
    session: {
      active: true,
      id: 'pulse-1',
      startedAt: 1793731200000,
      endsAt: 1793733000000,
      minutes: 30,
    },
    series: [{ t: 1793731230000, bpm: 112 }, { t: 1793731231000, bpm: 115 }, { t: 1793731232000, bpm: 118 }],
    safety: null,
    note: '',
    ...overrides,
  };
}

function makeService(overrides = {}) {
  const calls = [];
  const service = {
    pulse: () => {
      calls.push(['pulse']);
      return pulseView();
    },
    pulseSession: async input => {
      calls.push(['pulseSession', input]);
      if (input.action === 'start') {
        return { ok: true, session: { active: true, id: 'pulse-2', startedAt: 1793731300000, endsAt: 1793733100000, minutes: 30 }, baseline: null };
      }
      if (input.action === 'stop') {
        return { ok: true, session: null, summary: { id: 'pulse-2', baselineBpm: 92, peakBpm: 141, samples: 180 } };
      }
      return { ok: true, mark: { at: 1793731400000, label: input.label || '', bpm: 138 } };
    },
    setConsent: async (capability, enabled) => {
      calls.push(['setConsent', capability, enabled]);
      return {
        ok: true,
        capability,
        enabled,
        enforced: true,
        consents: { 'health.connect': true, [capability]: enabled },
      };
    },
    pulseHistory: () => ({ ok: true, sessions: [] }),
    pulseDevices: () => ({ ok: true, scannedAt: 1793731200000, devices: [] }),
  };
  return { service: { ...service, ...overrides }, calls };
}

function handlersWith(service, extra = {}) {
  return createStudioHandlers({ engine: null, identity: null, root: 'C:/tmp/studio', log: null, health: () => service, ...extra });
}

const url = pathAndQuery => `http://studio.local${pathAndQuery}`;

async function callGet(handlers, pathAndQuery = PATH) {
  const handler = handlers[`GET ${PATH}`];
  assert.equal(typeof handler, 'function', `缺少处理器：GET ${PATH}`);
  const response = await handler(new Request(url(pathAndQuery)));
  return { status: response.status, headers: response.headers, json: await response.json() };
}

async function callPost(handlers, body) {
  const handler = handlers[`POST ${PATH}`];
  assert.equal(typeof handler, 'function', `缺少处理器：POST ${PATH}`);
  const init = { method: 'POST', headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const response = await handler(new Request(url(PATH), init));
  return { status: response.status, json: await response.json() };
}

// ---------------------------------------------------------------------------
// 1. 路由表
// ---------------------------------------------------------------------------

test('1a. /pulse 的 GET 与 POST 都在 HEALTH_ROUTES 里，既有 7 条健康路由一条没动、顺序也没动', () => {
  const { service } = makeService();
  const handlers = handlersWith(service);
  assert.equal(typeof handlers[`GET ${PATH}`], 'function');
  assert.equal(typeof handlers[`POST ${PATH}`], 'function');
  assert.equal(Object.keys(handlers).length, ROUTES.length + HEALTH_ROUTES.length);

  // 心跳是追加在末尾的两条，不是插进既有的 7 条里。
  assert.deepEqual(HEALTH_ROUTES.slice(0, 7).map(route => route.name), [
    'health-status', 'health-sources', 'health-today', 'health-trends', 'health-sleep', 'health-sync',
    'health-maintenance',
  ]);
  assert.deepEqual(HEALTH_ROUTES.slice(7).map(route => `${route.method} ${route.path}`), [
    `GET ${PATH}`, `POST ${PATH}`,
    // 主动关怀是第三条追加（2026-11-04）：只读 GET，没有 POST —— 开关走 /pulse 的 consent 动作。
    `GET ${P}/care`,
  ]);
  // 既有的记忆路由一条没少。
  for (const route of ROUTES) assert.equal(typeof handlers[`${route.method} ${route.path}`], 'function', route.path);
});

test('1b. 同一条路径只有一条 group，methods 是 GET + POST；不给任何路径制造重复', () => {
  const groups = groupRoutesByPath();
  const pulse = groups.filter(group => group.path === PATH);
  assert.equal(pulse.length, 1, 'Exact Fetch 按 path 去重：GET/POST 必须合成一条 group');
  assert.deepEqual([...pulse[0].methods].sort(), ['GET', 'POST']);
  assert.deepEqual(pulse[0].names, ['health-pulse', 'health-pulse-action']);

  const paths = ALL_ROUTES.map(route => route.path);
  // 路由表本身允许同路径多种方法（记忆库那几条也是 GET/POST 成对），
  // 但**路径去重后**必须等于 group 数：一条路径只能有一条 group。
  assert.equal(groups.length, new Set(paths).size);
  assert.equal(groups.filter(group => group.path === PATH).length, 1);
});

test('1c. 宿主注册：没有健康服务也照样注册 /pulse（不 404、不崩），服务一挂上立刻能用', async () => {
  const registered = [];
  const makeCtx = services => ({
    get: name => (name === 'connection'
      ? { fetch: { register: route => { registered.push(route); return () => {}; } } }
      : services?.[name]),
    effect: runner => runner(),
  });

  await registerStudioApi(makeCtx(undefined), { engine: null, identity: null, root: 'C:/tmp/studio' });
  const pulseRoute = registered.find(route => route.path === PATH);
  assert.ok(pulseRoute, '/pulse 必须无条件注册到宿主');
  assert.deepEqual([...pulseRoute.methods].sort(), ['GET', 'POST']);

  const empty = await pulseRoute.fetch(new Request(url(PATH)));
  assert.equal(empty.status, 200, '没有健康服务时 /pulse 也不能是 404');
  assert.equal((await empty.json()).error.code, 'health-unavailable');

  const { service } = makeService();
  registered.length = 0;
  await registerStudioApi(makeCtx({ companionHealth: service }), { engine: null, identity: null, root: 'C:/tmp/studio' });
  const live = registered.find(route => route.path === PATH);
  const response = await live.fetch(new Request(url(PATH)));
  assert.equal((await response.json()).ok, true);

  // GET 走 /pulse 的 handler；同一路径上的其它方法（PUT/DELETE）仍然是 405。
  const wrong = await live.fetch(new Request(url(PATH), { method: 'DELETE' }));
  assert.equal(wrong.status, 405);
});

// ---------------------------------------------------------------------------
// 2. GET 正常信封
// ---------------------------------------------------------------------------

test('2. GET /pulse → ok:true、meta.source=companion-health，data 就是 pulse() 那一份视图', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);
  const { status, headers, json } = await callGet(handlers);

  assert.equal(status, 200);
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(headers.get('cache-control'), 'no-store', '心跳读数不许被宿主或浏览器缓存');
  assert.equal(json.ok, true);
  assert.equal(json.meta.source, 'companion-health');
  assert.equal(json.meta.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(json.meta.observedAt)));

  // 逐字透传（stub 里没有私有键）：这一层不拼字段、不改写、不补默认值。
  assert.deepEqual(json.data, pulseView());
  assert.deepEqual(calls, [['pulse']], 'GET 只调一次 pulse()，不顺手调 history / devices');

  // 契约里最容易踩的两个 null：原样留着，由 UI 决定显示「—」。
  const dark = makeService({ pulse: () => pulseView({ bpm: null, sampleAgeMs: null, quality: 'no-contact', zone: null, baseline: null, session: { active: false } }) });
  const darkJson = await callGet(handlersWith(dark.service));
  assert.equal(darkJson.json.ok, true);
  assert.equal(darkJson.json.data.bpm, null, '没有读数时必须是 null，绝不能变成 0');
  assert.equal(darkJson.json.data.sampleAgeMs, null);
  assert.equal(darkJson.json.data.session.active, false);
});

// ---------------------------------------------------------------------------
// 2b. 会话语义（2026-11-04 起默认跟随设备）：Studio 只转发，绝不自己造倒计时
// ---------------------------------------------------------------------------

test('2b. mode=device 的会话原样透出（endsAt/minutes 是 null，Studio 不补「剩余 N 分钟」）', async () => {
  const deviceSession = {
    active: true, id: 'pulse-device', startedAt: 1793731200000,
    endsAt: null, minutes: null, mode: 'device', remainingMs: null, deviceOffMs: 30000,
  };
  const { service } = makeService({
    pulse: () => pulseView({
      session: deviceSession, peak: null, baseline: null, series: [], zone: null, trend: 'flat',
    }),
  });
  const { status, json } = await callGet(handlersWith(service));
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  // 逐字相等：倒计时字段全是 null，Studio 没有偷偷算一个 remainingMinutes 出来。
  assert.deepEqual(json.data.session, deviceSession);
  assert.equal(json.data.session.endsAt, null);
  assert.equal(json.data.session.minutes, null);
  assert.equal(json.data.session.remainingMs, null);
  for (const invented of ['remainingMinutes', 'remaining', 'countdown', 'endsAtIso']) {
    assert.equal(Object.hasOwn(json.data.session, invented), false, `Studio 不许自己造 ${invented}`);
  }
  assert.equal(Object.hasOwn(json.data, 'remainingMinutes'), false);

  // timer 模式（主人显式给了 minutes）才该有 endsAt/remainingMs —— 也是原样透出。
  const timerSession = {
    active: true, id: 'pulse-timer', startedAt: 1793731200000,
    endsAt: 1793733000000, minutes: 30, mode: 'timer', remainingMs: 1764000, deviceOffMs: 30000,
  };
  const timer = await callGet(handlersWith(makeService({ pulse: () => pulseView({ session: timerSession }) }).service));
  assert.deepEqual(timer.json.data.session, timerSession);
  assert.equal(timer.json.data.session.mode, 'timer');
});

test('2c. 设备关掉（disconnected / sampleAgeMs > deviceOffMs）的事实原样透出，Studio 不吞不改', async () => {
  // 后端自动收口后的那一份视图：会话 inactive、connected:false、lastErrorCode:'disconnected'。
  const offView = pulseView({
    connected: false,
    bpm: 118, // 最后一拍留着 —— 但 sampleAgeMs 已经超过 deviceOffMs
    sampleAgeMs: 45000,
    quality: 'sparse',
    zone: null,
    baseline: null,
    peak: null,
    series: [],
    session: {
      active: false, id: null, startedAt: null, endsAt: null, minutes: null,
      mode: 'device', remainingMs: null, deviceOffMs: 30000,
    },
    lastErrorCode: 'disconnected',
  });
  const { status, json } = await callGet(handlersWith(makeService({ pulse: () => offView }).service));
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  // UI 判定「设备已关闭，会话随之结束」需要的四个事实一个都不能被 Studio 抹掉。
  assert.equal(json.data.connected, false);
  assert.equal(json.data.lastErrorCode, 'disconnected');
  assert.equal(json.data.session.active, false);
  assert.equal(json.data.session.deviceOffMs, 30000);
  assert.ok(json.data.sampleAgeMs > json.data.session.deviceOffMs, '读数比 deviceOffMs 旧 —— UI 据此隐藏数字');
  // bpm 保留（后端语义），但 Studio 绝不把陈旧读数伪装成实时：quality 已经降级。
  assert.equal(json.data.bpm, 118);
  assert.equal(json.data.quality, 'sparse');
});

// ---------------------------------------------------------------------------
// 3. POST 三个会话动作
// ---------------------------------------------------------------------------

test('3a. POST /pulse {action:start|stop|mark} → 落到 pulseSession()，参数先收敛再发', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);

  const started = await callPost(handlers, { action: 'start', minutes: 45 });
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.meta.source, 'companion-health');
  assert.equal(started.json.data.session.active, true);
  assert.equal(started.json.data.baseline, null);
  assert.deepEqual(calls.at(-1), ['pulseSession', { action: 'start', minutes: 45 }]);

  const stopped = await callPost(handlers, { action: 'stop' });
  assert.equal(stopped.json.ok, true);
  assert.equal(stopped.json.data.session, null);
  assert.equal(stopped.json.data.summary.peakBpm, 141);
  assert.deepEqual(calls.at(-1), ['pulseSession', { action: 'stop' }], 'stop 不带 minutes/label');

  const marked = await callPost(handlers, { action: 'mark', label: '这句要记一下' });
  assert.equal(marked.json.ok, true);
  assert.equal(marked.json.data.mark.bpm, 138);
  assert.deepEqual(calls.at(-1), ['pulseSession', { action: 'mark', label: '这句要记一下' }]);
});

test('3b. minutes 夹在 1..120、非数字回缺失；label 压成一行并截到 40 字；start 不收 label', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);
  const lastInput = () => calls.at(-1)[1];

  await callPost(handlers, { action: 'start', minutes: 999 });
  assert.deepEqual(lastInput(), { action: 'start', minutes: 120 }, '上限 120');

  await callPost(handlers, { action: 'start', minutes: 0 });
  assert.deepEqual(lastInput(), { action: 'start', minutes: 1 }, '下限 1');

  await callPost(handlers, { action: 'start', minutes: 'abc' });
  assert.deepEqual(lastInput(), { action: 'start' }, '非数字等于没给，交给 service 的默认 30');

  await callPost(handlers, { action: 'start', label: '不该在这里出现' });
  assert.deepEqual(lastInput(), { action: 'start' }, 'start 不发 label');

  await callPost(handlers, { action: 'mark', label: 'x'.repeat(200) });
  assert.equal(lastInput().label.length, 40, 'label 上限 40 字');

  await callPost(handlers, { action: 'mark', label: '换行\n和\t制表' });
  assert.equal(/[\r\n\t]/.test(lastInput().label), false, 'label 必须压成一行');

  await callPost(handlers, { action: 'mark' });
  assert.deepEqual(lastInput(), { action: 'mark' }, '没给 label 就不带这个键');
});

test('3c. action 大小写与空白不算错（START / Stop / " mark "），未知值才 400', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);

  for (const [raw, expected] of [['START', 'start'], ['Stop', 'stop'], ['  mark  ', 'mark']]) {
    const { status, json } = await callPost(handlers, { action: raw });
    assert.equal(status, 200, `${raw} 是合法动作`);
    assert.equal(json.ok, true);
    assert.equal(calls.at(-1)[1].action, expected);
  }

  for (const bogus of ['nope', '', 'history', 'pulse', '__proto__', 42, null]) {
    const { status, json } = await callPost(handlers, { action: bogus });
    assert.equal(status, 400, `未知动作必须是 400：${JSON.stringify(bogus)}`);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'bad-request');
    assert.equal(json.meta.source, 'companion-health');
    assert.match(json.error.message, /start/, '错误里要写清支持哪些动作');
  }
  // 缺 action、坏 JSON 同样是 400（不是 500）。
  assert.equal((await callPost(handlers, {})).status, 400);
  assert.equal((await callPost(handlers, 'not-json')).status, 400);
  assert.equal((await callPost(handlers, undefined)).status, 400);
});

// ---------------------------------------------------------------------------
// 4. consent 动作：只改 health.pulse.live
// ---------------------------------------------------------------------------

test('4a. POST /pulse {action:consent, consent:true} → setConsent(health.pulse.live, true)', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);

  const on = await callPost(handlers, { action: 'consent', consent: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.ok, true);
  assert.equal(on.json.meta.source, 'companion-health');
  assert.deepEqual(calls.at(-1), ['setConsent', PULSE_CONSENT_CAPABILITY, true]);
  assert.equal(on.json.data.capability, 'health.pulse.live');
  assert.equal(on.json.data.enabled, true);
  assert.equal(on.json.data.consents[PULSE_CONSENT_CAPABILITY], true);

  // 大小写、字符串真假、1/0 都收；线上一律写成真正的布尔。
  for (const [raw, expected] of [['false', false], [0, false], ['on', true], [1, true]]) {
    await callPost(handlers, { action: 'Consent', consent: raw });
    assert.deepEqual(calls.at(-1), ['setConsent', PULSE_CONSENT_CAPABILITY, expected]);
  }
  assert.equal(PULSE_CONSENT_CAPABILITY, 'health.pulse.live');
});

test('4b. consent 不接受任意 capability；缺值 400；服务的类型化拒绝原样透出（HTTP 200）', async () => {
  const { service, calls } = makeService();
  const handlers = handlersWith(service);

  // 别的 capability 一律坏请求，且**一次都不许**调到 setConsent（否则就是任意授权写入口）。
  for (const capability of ['health.export', 'health.delete', 'health.connect', 'health.pulse.memory']) {
    const { status, json } = await callPost(handlers, { action: 'consent', consent: true, capability });
    assert.equal(status, 400, capability);
    assert.equal(json.error.code, 'bad-request');
  }
  assert.equal(calls.filter(call => call[0] === 'setConsent').length, 0);

  // 显式传同一个 capability 是合法的（幂等写法）。
  await callPost(handlers, { action: 'consent', consent: true, capability: 'health.pulse.live' });
  assert.deepEqual(calls.at(-1), ['setConsent', PULSE_CONSENT_CAPABILITY, true]);

  // 没给 consent：400，不猜"那就打开吧"。
  const missing = await callPost(handlers, { action: 'consent' });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'bad-request');

  // 服务自己的拒绝是业务失败，不是请求错误：HTTP 200 + 原 code。
  for (const code of ['health-readonly', 'health-consent-unknown', 'health-consent-failed', 'health-db-unavailable']) {
    const refused = makeService({ setConsent: async () => ({ ok: false, code, message: `${code} 的说明` }) });
    const { status, json } = await callPost(handlersWith(refused.service), { action: 'consent', consent: false });
    assert.equal(status, 200, `${code} 不许变成 4xx/5xx`);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, code, '错误码原样透出，不翻译成 Studio 的码');
    assert.equal(json.error.message, `${code} 的说明`);
    assert.equal(json.meta.source, 'companion-health');
  }

  // 服务没有 setConsent：如实说没有这个开关。
  const noSwitch = makeService();
  delete noSwitch.service.setConsent;
  const unsupported = await callPost(handlersWith(noSwitch.service), { action: 'consent', consent: true });
  assert.equal(unsupported.status, 200);
  assert.equal(unsupported.json.error.code, 'unsupported-action');
});

// ---------------------------------------------------------------------------
// 5. 服务缺失 / 缺方法 / 抛异常：一律 HTTP 200 的信封，绝不 500
// ---------------------------------------------------------------------------

test('5a. 健康服务没挂载 → GET/POST /pulse 都是 health-unavailable、HTTP 200', async () => {
  for (const service of [null, undefined]) {
    const handlers = handlersWith(service);
    const get = await callGet(handlers);
    assert.equal(get.status, 200);
    assert.equal(get.json.ok, false);
    assert.equal(get.json.error.code, 'health-unavailable');
    assert.equal(get.json.meta.source, 'companion-health');

    const post = await callPost(handlers, { action: 'start' });
    assert.equal(post.status, 200);
    assert.equal(post.json.error.code, 'health-unavailable');
  }

  // 连 health 依赖都没传，也一样不抛、不 404。
  const bare = createStudioHandlers({});
  const bareGet = await bare[`GET ${PATH}`](new Request(url(PATH)));
  assert.equal(bareGet.status, 200);
  assert.equal((await bareGet.json()).error.code, 'health-unavailable');
  const barePost = await bare[`POST ${PATH}`](new Request(url(PATH), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start' }),
  }));
  assert.equal(barePost.status, 200);
  assert.equal((await barePost.json()).error.code, 'health-unavailable');

  // 访问器自身抛错也只当"没挂载"。
  const throwing = createStudioHandlers({ health: () => { throw new Error('getter boom'); } });
  const thrown = await throwing[`GET ${PATH}`](new Request(url(PATH)));
  assert.equal(thrown.status, 200);
  assert.equal((await thrown.json()).error.code, 'health-unavailable');
});

test('5b. 服务在场但没有 pulse / pulseSession 方法 → health-method-missing（不是假装空数据、不是 500）', async () => {
  const noPulse = makeService();
  delete noPulse.service.pulse;
  const get = await callGet(handlersWith(noPulse.service));
  assert.equal(get.status, 200);
  assert.equal(get.json.ok, false);
  assert.equal(get.json.error.code, 'health-method-missing');
  assert.match(get.json.error.message, /pulse/);
  assert.equal(get.json.meta.source, 'companion-health');

  const noSession = makeService();
  delete noSession.service.pulseSession;
  const post = await callPost(handlersWith(noSession.service), { action: 'start' });
  assert.equal(post.status, 200);
  assert.equal(post.json.error.code, 'health-method-missing');
  assert.match(post.json.error.message, /pulseSession/);
});

test('5c. facade 抛异常 → internal 信封 + HTTP 200（GET 与 POST 都是），异常正文不外泄', async () => {
  const boom = () => { throw new Error('sidecar secret address AA:BB:CC'); };
  const handlers = handlersWith(makeService({ pulse: boom }).service);
  const get = await callGet(handlers);
  assert.equal(get.status, 200);
  assert.equal(get.json.ok, false);
  assert.equal(get.json.error.code, 'internal');
  assert.equal(JSON.stringify(get.json).includes('AA:BB:CC'), false, '异常正文不得进响应');

  const asyncThrow = makeService({ pulse: async () => { throw new Error('adapter boom'); } });
  const asyncJson = await callGet(handlersWith(asyncThrow.service));
  assert.equal(asyncJson.status, 200);
  assert.equal(asyncJson.json.error.code, 'internal');

  for (const action of ['start', 'stop', 'mark']) {
    const failing = makeService({ pulseSession: async () => { throw new Error('state machine boom'); } });
    const { status, json } = await callPost(handlersWith(failing.service), { action });
    assert.equal(status, 200, `${action} 抛异常也不能 500`);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'internal');
    assert.equal(JSON.stringify(json).includes('state machine boom'), false);
  }

  const consentThrow = makeService({ setConsent: () => { throw new Error('consent table boom'); } });
  const consent = await callPost(handlersWith(consentThrow.service), { action: 'consent', consent: true });
  assert.equal(consent.status, 200);
  assert.equal(consent.json.error.code, 'internal');
  assert.equal(JSON.stringify(consent.json).includes('consent table boom'), false);
});

test('5d. facade 自己报 {ok:false,code,message} → 原码透出（HTTP 200），不翻译成 internal', async () => {
  const cases = [
    ['pulse-denied', '主人尚未授权读取实时心率。'],
    ['pulse-disabled', '实时心率功能未启用（配置 pulse.enabled=false）。'],
    ['pulse-unreachable', '心率广播接收端未运行，拿不到读数。'],
    ['pulse-failed', '读取实时心率时出错。'],
  ];
  for (const [code, message] of cases) {
    const { service } = makeService({ pulse: () => ({ ok: false, code, message }) });
    const { status, json } = await callGet(handlersWith(service));
    assert.equal(status, 200, code);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, code);
    assert.equal(json.error.message, message);
    assert.equal(json.meta.source, 'companion-health');
    // 服务没给 errorCode 时信封里不许凭空多出这个键（既有 7 条路由的形状不变）。
    assert.equal(Object.hasOwn(json.error, 'errorCode'), false, `${code} 不该凭空带 errorCode`);
  }

  const noSession = makeService({ pulseSession: async () => ({ ok: false, code: 'pulse-no-session', message: '当前没有正在进行的心跳会话。' }) });
  const { status, json } = await callPost(handlersWith(noSession.service), { action: 'stop' });
  assert.equal(status, 200);
  assert.equal(json.error.code, 'pulse-no-session');
});

test('5e. start 连不上设备：`pulse-unreachable` + errorCode 原样透出（页面据此给不同建议）', async () => {
  // 契约：`start` 先按需扫码并连设备，连不上直接失败，**不会**开一个空会话。
  for (const errorCode of ['device-not-found', 'connect-timeout', 'http-error']) {
    const recorded = [];
    const { service } = makeService({
      pulseSession: async input => {
        recorded.push(input);
        return {
          ok: false,
          code: 'pulse-unreachable',
          message: '心率广播接收端未运行，拿不到读数。',
          errorCode,
        };
      },
    });
    const { status, json } = await callPost(handlersWith(service), { action: 'start' });
    assert.equal(status, 200, '业务失败仍是 HTTP 200');
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'pulse-unreachable', 'code 不变');
    assert.equal(json.error.errorCode, errorCode, 'errorCode 必须原样透出');
    assert.equal(json.error.message, '心率广播接收端未运行，拿不到读数。', 'message 也不改写');
    assert.equal(json.meta.source, 'companion-health');
    assert.deepEqual(recorded, [{ action: 'start' }], '失败也要真的调过 pulseSession');
    // 失败时不能顺带造出一个"空会话"。
    assert.equal(Object.hasOwn(json, 'data'), false);
  }

  // 其它失败（例如 pulse-denied）没有 errorCode：信封里也同样不出现这个键。
  const denied = makeService({ pulseSession: async () => ({ ok: false, code: 'pulse-denied', message: '主人尚未授权读取实时心率。' }) });
  const json = (await callPost(handlersWith(denied.service), { action: 'start' })).json;
  assert.equal(json.error.code, 'pulse-denied');
  assert.equal(Object.hasOwn(json.error, 'errorCode'), false);
});

// ---------------------------------------------------------------------------
// 6. 隐私与护栏：这一层不缓存、不落库、不写日志、不自己碰网络
// ---------------------------------------------------------------------------

test('6a. 心跳数据不进 meta、不进日志：log 回调一次都没被喂正文', async () => {
  const logs = [];
  const { service } = makeService();
  const handlers = createStudioHandlers({
    engine: null,
    identity: null,
    root: 'C:/tmp/studio',
    log: (code, detail) => logs.push([code, detail]),
    health: () => service,
  });

  const get = await callGet(handlers);
  assert.equal(get.json.ok, true);
  const serialized = JSON.stringify(get.json);
  assert.equal(serialized.includes('118 bpm'), false, '读数只出现在 data 里，不许被复制进 meta/message');
  assert.equal(Object.hasOwn(get.json.meta, 'bpm'), false);

  // 正常路径（200）一条日志都不该产生。
  assert.deepEqual(logs, []);

  // facade 抛异常也被 callService 收敛成 internal 信封：既不上抛宿主，也不写异常正文进日志。
  const boom = createStudioHandlers({
    engine: null, identity: null, root: 'C:/tmp/studio',
    log: (code, detail) => logs.push([code, detail]),
    health: () => makeService({ pulse: () => { throw new Error('raw reason with secrets'); } }).service,
  });
  const failed = await boom[`GET ${PATH}`](new Request(url(PATH)));
  assert.equal(failed.status, 200);
  assert.equal((await failed.json()).error.code, 'internal');
  assert.equal(JSON.stringify(logs).includes('raw reason with secrets'), false, '异常正文不得进日志');
  assert.deepEqual(logs, [], '可预期的读取失败按信封回答，不写日志（也没有正文可写）');
});

test('6b. 源码护栏：lib/health.mjs 的 pulse 段落不碰 fetch / SQLite / sidecar 地址 / 计时器', () => {
  const source = fs.readFileSync(new URL('../lib/health.mjs', import.meta.url), 'utf8');
  const pulse = source.slice(source.indexOf('心跳共振'), source.length);
  assert.ok(pulse.length > 0, '找不到 pulse 段落');
  assert.equal(/globalThis\.fetch|\bfetch\s*\(/.test(pulse), false, '不许自己发网络请求（读数由 service 拉）');
  assert.equal(/node:sqlite|DatabaseSync|\.prepare\s*\(|INSERT\s|UPDATE\s/i.test(pulse), false, '不许自己开 SQLite / 写 SQL');
  assert.equal(/127\.0\.0\.1|8151|localhost/.test(pulse), false, '不许直连 sidecar');
  assert.equal(/setInterval|setTimeout/.test(pulse), false, '这一层不做轮询或缓存定时器');
  assert.equal(/readFile|writeFile|appendFile/.test(pulse), false, '心跳数据不落盘');
});

test('6c. 契约常量：会话动作就是 start / stop / mark，consent 是第 4 个（不新增 pulse.memory）', () => {
  assert.deepEqual(PULSE_SESSION_ACTIONS, ['start', 'stop', 'mark']);
  assert.deepEqual(PULSE_ACTIONS, ['start', 'stop', 'mark', 'consent']);
  assert.equal(PULSE_ACTIONS.includes('history'), false, 'pulseHistory 没有路由，只有工具能读');
  assert.equal(PULSE_ACTIONS.includes('pulse.memory'), false);
});
