import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerHealthTools, stripPrivate, HEALTH_TOOL_NAMES, TREND_METRICS, DAYS_DEFAULT, HEALTH_FAILURES,
} from '../health-tools.mjs';

// §14 owner-only read tools. This file proves four things and nothing else:
//   1. the five names/kinds/declarations match the frozen contract,
//   2. a working service facade is forwarded and its answer is scrubbed,
//   3. a missing service or a disabled `health.read.on_demand` consent degrades to a
//      fixed code instead of throwing or leaking a stack,
//   4. an empty sleep record says so in words and never becomes "0 minutes slept".
// Owner identity lives in `index.mjs`'s `register()` wrapper (`identity.resolve`), so it is
// deliberately *not* re-tested (or re-implemented) here.

const NOW = Date.UTC(2026, 10, 3, 13, 30, 0); // 2026-11-03 21:30 Asia/Shanghai
const OWNER = { userId: '1429709395', displayName: 'owner', persona: 'march7', sessionId: 'session-health' };

/** Mirror `index.mjs`: identity gate first, then a JSON string. */
function harness({ service = null, now = () => NOW } = {}) {
  const declarations = new Map();
  const register = (name, description, parameters, execute, kind = 'read') => {
    declarations.set(name, {
      name, description, parameters, kind,
      execute: async (args = {}, exec = { agent: { session: { id: 'session-health' } } }) => {
        if (!exec?.agent?.session?.id) throw new Error('A runtime session is required for user binding.');
        return JSON.stringify(await execute(args, OWNER, exec));
      },
    });
  };
  const result = registerHealthTools({ register, getService: () => service ?? null, now });
  return {
    declarations, result,
    call: async (name, args = {}) => {
      const tool = declarations.get(name);
      assert.ok(tool, `tool ${name} is registered`);
      return JSON.parse(await tool.execute(args));
    },
  };
}

const DEFAULT_CONSENTS = Object.freeze({ 'health.connect': true, 'health.read.on_demand': true,
  'health.dashboard': true, 'health.sleep.read': true });

function stubService(overrides = {}) {
  const calls = [];
  const service = {
    calls,
    consents: () => ({ ...DEFAULT_CONSENTS }),
    status: () => {
      calls.push(['status', undefined]);
      // Deliberately leaky: the tool layer must scrub this before it reaches the model.
      return {
        ok: true, schemaVersion: 1, generatedAt: '2026-11-03T13:30:00.000Z',
        source: { id: 'huawei-cn', provider: 'huawei_cn_cloud', displayName: '华为运动健康（CN 云）', enabled: true,
          uid: '1234567890',
          auth: { status: 'valid', expiresAt: '2026-11-03T14:25:00.000Z', refreshExpiresAt: null, minutesLeft: 55, rotated: false,
            token: 'SECRET-ACCESS', rawRef: 'ref-1' },
          lastSuccessAt: '2026-11-03T13:27:00.000Z', lastErrorCode: null,
          freshness: { status: 'fresh', newestSampleAt: '2026-11-03T13:27:00.000Z', ageMinutes: 3 } },
        collector: { mode: 'local_http', baseUrl: 'http://127.0.0.1:8765', pollMinutes: 15, windowDays: 7, running: true,
          singleFlight: true, lastRunAt: '2026-11-03T13:27:00.000Z', nextAllowedAt: null, consecutiveFailures: 0,
          cooldownUntil: null, rateLimitedUntil: null },
        db: { path: 'home/health/health.db', journalMode: 'wal', integrity: 'ok', sizeBytes: 131072,
          observations: 12, workouts: 2, devices: 9, dailySummaries: 7, sleepSessions: 0, sleepStages: 0 },
        sleep: { availability: 'awaiting_first_night', sessions: 0, lastSessionAt: null, stageFidelity: null, firstNightPending: true },
        consents: { 'health.connect': true, 'health.read.on_demand': true },
        devices: [{ id: 'dev-1', name: 'Watch', uniqueId: 'abc123', devId: 'def456', unique_id_hash: 'h1', dev_id_hash: 'h2', raw_ref: 'r' }],
        faults: [],
      };
    },
    sources: () => {
      calls.push(['sources', undefined]);
      return [{
        id: 'huawei-cn', name: '华为运动健康（CN 云）', kind: 'wearable-cloud', provider: 'huawei_cn_cloud',
        ownerScope: 'owner-only', enabled: true,
        capabilities: { activity: 'supported', sport: 'supported', heart_rate: 'supported', stress: 'supported',
          spo2: 'supported', device: 'supported', sleep: { supported: true, status: 'no_data', stageFidelity: 'unknown' } },
        auth: { status: 'valid', expiresAt: '2026-11-03T14:25:00.000Z', refreshExpiresAt: null, minutesLeft: 55, rotated: false },
        freshness: { status: 'fresh', newestSampleAt: '2026-11-03T13:27:00.000Z', ageMinutes: 3 },
        lastSuccessAt: '2026-11-03T13:27:00.000Z', lastErrorCode: null,
        notes: ['睡眠尚未同步'],
      }];
    },
    today: query => {
      calls.push(['today', query]);
      return {
        ok: true, date: query?.date ?? '2026-11-03', timezone: 'Asia/Shanghai',
        activity: { steps: 1112, distanceM: 812, kcal: 45, activeHours: 3, exerciseMin: 11, stepGoal: 8000,
          quality: 'fresh', observedAt: '2026-11-03T13:27:00.000Z' },
        metrics: { heartRate: { avg: 95, max: 112, min: 58, resting: 79 }, stress: { avg: 65, max: 69, min: 61, last: 66, measurements: 4 },
          spo2: { avg: 97.11, min: 95, max: 99, last: 97 }, intensity: { moderateHighMinutes: 22 } },
        realtime: { heartRate: { value: 95, unit: 'bpm', at: '2026-11-03T13:27:00.000Z', source: 'cloud-last-uploaded' },
          stress: null, spo2: null },
        workouts: [{ sportTypeRaw: 2, sportTypeLabel: 'hill', sportTypeMapping: 'upstream_const', startAt: '2026-11-03T09:00:00+08:00',
          endAt: '2026-11-03T09:22:00+08:00', durationMin: 22, steps: 2100, distanceM: 2400, kcal: 130, quality: 'fresh' }],
        sleep: { availability: 'awaiting_first_night', session: null },
        freshness: { status: 'fresh', newestSampleAt: '2026-11-03T13:27:00.000Z', ageMinutes: 3 },
      };
    },
    trend: query => {
      calls.push(['trend', query]);
      return {
        ok: true, metric: query.metric, days: query.days, unit: query.metric === 'steps' ? '步' : '', supported: true,
        points: [{ date: '2026-11-02', value: 4210, quality: 'fresh', observedAt: '2026-11-02T15:00:00.000Z' },
          { date: '2026-11-03', value: 1112, quality: 'fresh', observedAt: '2026-11-03T13:27:00.000Z' }],
        aggregate: { count: 2, mean: 2661, min: 1112, max: 4210, coveredDays: 2, missingDays: query.days - 2 },
      };
    },
    sleep: query => {
      calls.push(['sleep', query]);
      return {
        ok: true, availability: 'awaiting_first_night', timezone: 'Asia/Shanghai',
        range: { from: '2026-10-28', to: '2026-11-03' },
        sessions: [], trend: [], notes: [],
      };
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'consents') {
      // A consent table that throws/rejects is a real drift case, so a function override wins;
      // a plain object merges over the defaults.
      service.consents = typeof value === 'function' ? value : () => ({ ...DEFAULT_CONSENTS, ...(value ?? {}) });
      continue;
    }
    service[key] = value;
  }
  return service;
}

test('§14：五个 owner-only 只读工具注册一次，name/kind/参数声明与契约一致', () => {
  const { declarations, result } = harness({ service: stubService() });
  assert.deepEqual(result.registered, [...HEALTH_TOOL_NAMES]);
  assert.deepEqual([...declarations.keys()], [...HEALTH_TOOL_NAMES]);
  for (const name of HEALTH_TOOL_NAMES) assert.equal(declarations.get(name).kind, 'read', `${name} must be a read tool`);

  // §11.4 enum copied verbatim, and `days` documented as 1..30.
  assert.deepEqual([...TREND_METRICS],
    ['steps', 'distance_m', 'kcal', 'heart_rate', 'resting_heart_rate', 'stress', 'spo2', 'intensity']);
  const trend = declarations.get('companion_health_trend');
  assert.deepEqual(trend.parameters.metric.enum, [...TREND_METRICS]);
  assert.equal(trend.parameters.metric.required, true);
  assert.equal(trend.parameters.days.type, 'integer');
  assert.match(trend.parameters.days.description, /1\.\.30/);
  const sleep = declarations.get('companion_health_sleep');
  assert.equal(sleep.parameters.days.type, 'integer');
  assert.match(sleep.parameters.days.description, /1\.\.30/);
  assert.equal(sleep.parameters.includeStages.type, 'boolean');
  assert.equal(DAYS_DEFAULT, 7);
});

test('描述必须写明华为 CN 云、设备/云端指标记录、不是医学结论，并能回答同步时间/新鲜度', () => {
  const { declarations } = harness({ service: stubService() });
  for (const name of HEALTH_TOOL_NAMES) {
    const text = declarations.get(name).description;
    assert.match(text, /Huawei Health CN cloud/, `${name} must name the Huawei CN cloud source`);
    assert.match(text, /not (a )?medical (conclusion|assessment)/, `${name} must deny being a medical conclusion`);
    assert.match(text, /device\/cloud (metric )?record/, `${name} must say these are device/cloud records`);
    assert.match(text, /Read-only/, `${name} must say it is read-only`);
  }
  assert.match(declarations.get('companion_health_status').description, /last sync|fresh/i,
    'status must advertise last-sync/freshness');
});

test('正常返回：execute 回 JSON 字符串，能 parse 回来且 ok:true', async () => {
  const service = stubService();
  const { declarations, call } = harness({ service });

  const tool = declarations.get('companion_health_status');
  const raw = await tool.execute({});
  assert.equal(typeof raw, 'string');
  const status = JSON.parse(raw);
  assert.equal(status.ok, true);
  assert.equal(status.source.displayName, '华为运动健康（CN 云）');
  assert.equal(status.schemaVersion, 1);

  const today = await call('companion_health_today', {});
  assert.equal(today.ok, true);
  assert.equal(today.date, '2026-11-03', 'default day is today in Asia/Shanghai');
  assert.equal(today.sleep.session, null);

  const sources = await call('companion_health_sources', {});
  assert.equal(sources.ok, true);
  assert.equal(sources.sources[0].capabilities.sleep.status, 'no_data');
  assert.deepEqual(sources.sources[0].notes, ['睡眠尚未同步']);

  const trend = await call('companion_health_trend', { metric: 'steps' });
  assert.equal(trend.ok, true);
  assert.equal(trend.days, 7);
  assert.equal(trend.points.length, 2);
});

test('脱敏：工具返回里不留 uid/token/uniqueId/devId/raw_ref，且不改动 service 的原对象', async () => {
  const service = stubService();
  const original = service.status();
  const { call } = harness({ service });
  const status = await call('companion_health_status');
  const text = JSON.stringify(status);
  for (const needle of ['SECRET-ACCESS', 'ref-1', 'abc123', 'def456', 'h1', 'h2', '1234567890']) {
    assert.ok(!text.includes(needle), `private value ${needle} must not survive`);
  }
  for (const key of ['uid', 'token', 'rawRef', 'raw_ref', 'uniqueId', 'devId', 'unique_id_hash', 'dev_id_hash']) {
    assert.ok(!text.includes(`"${key}"`), `private key ${key} must not survive`);
  }
  // The service object itself is untouched: stripping is a copy, not a mutation.
  assert.equal(original.source.uid, '1234567890');
  assert.equal(original.devices[0].uniqueId, 'abc123');
});

test('服务缺失 → health-not-mounted；工具不抛', async () => {
  const { call } = harness({ service: null });
  for (const name of HEALTH_TOOL_NAMES) {
    const result = await call(name, { metric: 'steps' });
    assert.equal(result.ok, false, `${name} must not pretend to have data`);
    assert.equal(result.code, 'health-not-mounted');
    assert.equal(result.message, '健康模块尚未挂载。');
  }
});

test('health.read.on_demand=false → health-read-denied，且完全不去读数据', async () => {
  const service = stubService({ consents: { 'health.read.on_demand': false } });
  const { call } = harness({ service });
  for (const name of HEALTH_TOOL_NAMES) {
    const result = await call(name, { metric: 'steps' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'health-read-denied');
    assert.equal(result.message, '主人尚未授权按需读取健康数据。');
  }
  assert.deepEqual(service.calls, [], 'a denied read must not touch the store');
});

test('授权闸是白名单：裸 map 明确 true 才放行，且确实读到了数据', async () => {
  const service = stubService({ consents: { 'health.read.on_demand': true } });
  const { call } = harness({ service });
  const status = await call('companion_health_status');
  assert.equal(status.ok, true);
  assert.equal(status.source.id, 'huawei-cn');
  assert.deepEqual(service.calls.map(entry => entry[0]), ['status'], 'the read really happened');
});

test('授权闸：真实 service 的包装形状 {ok,consents:{…}} 关闭 → denied（不是"看不见就放行"）', async () => {
  // This is the shape the live facade returns; the top level has no
  // `health.read.on_demand` key at all, which is exactly how a `=== false` blacklist
  // fails open. Closed must deny …
  const closed = stubService({
    consents: () => ({
      ok: true,
      consents: { 'health.connect': true, 'health.read.on_demand': false },
      capabilities: ['health.connect', 'health.read.on_demand'],
      notEnforced: ['health.care.proactive'],
      seed: 'default',
    }),
  });
  const h = harness({ service: closed });
  for (const name of HEALTH_TOOL_NAMES) {
    const result = await h.call(name, { metric: 'steps' });
    assert.equal(result.ok, false, `${name} must not read with the owner's consent off`);
    assert.equal(result.code, 'health-read-denied');
  }
  assert.deepEqual(closed.calls, [], 'a wrapped denial must not touch the store either');

  // … and the same wrapper with the flag on must still work (no false lock-out).
  const open = stubService({ consents: () => ({ ok: true, consents: { 'health.read.on_demand': true } }) });
  assert.equal((await harness({ service: open }).call('companion_health_status')).ok, true);
  // A Promise of the wrapped shape takes the same path.
  const asyncOpen = stubService({ consents: async () => ({ ok: true, consents: { 'health.read.on_demand': true } }) });
  assert.equal((await harness({ service: asyncOpen }).call('companion_health_today')).ok, true);
  const asyncClosed = stubService({ consents: async () => ({ ok: true, consents: { 'health.read.on_demand': false } }) });
  assert.equal((await harness({ service: asyncClosed }).call('companion_health_today')).code, 'health-read-denied');
});

test('授权闸：拿不准就拒绝（{} / null / 非对象 / 键缺失 / 非布尔 / 缺方法）', async () => {
  const unclear = [
    ['empty object', () => ({})],
    ['null', () => null],
    ['undefined', () => undefined],
    ['string', () => 'yes'],
    ['number', () => 1],
    ['array', () => []],
    ['promise of undefined', async () => undefined],
    ['empty nested consents', () => ({ ok: true, consents: {} })],
    ['other capabilities only', () => ({ 'health.connect': true, 'health.dashboard': true })],
    ['string "true" is not boolean true', () => ({ 'health.read.on_demand': 'true' })],
    ['numeric 1 is not boolean true', () => ({ 'health.read.on_demand': 1 })],
    ['no consents method at all', undefined],
  ];
  for (const [label, factory] of unclear) {
    const service = stubService();
    if (factory === undefined) delete service.consents;
    else service.consents = factory;
    const h = harness({ service });
    for (const name of HEALTH_TOOL_NAMES) {
      const result = await h.call(name, { metric: 'steps' });
      assert.equal(result.ok, false, `${label}: ${name} must not read`);
      assert.equal(result.code, 'health-read-denied', `${label}: ${name} must deny, not fail open`);
      assert.equal(result.message, '主人尚未授权按需读取健康数据。');
    }
    assert.deepEqual(service.calls, [], `${label}: nothing may be read before consent`);
  }
});

test('服务方法缺失或抛错时也是固定 code，不把 exception message 交给模型', async () => {
  const broken = stubService({
    today: () => { throw new Error('SQLITE_BUSY at C:\\Users\\bobo\\home\\health\\health.db'); },
    trend: undefined,
  });
  const { call } = harness({ service: broken });
  const today = await call('companion_health_today', {});
  assert.equal(today.ok, false);
  assert.equal(today.code, 'health-read-failed');
  assert.ok(!JSON.stringify(today).includes('SQLITE_BUSY'), 'no stack/driver text leaks');
  const trend = await call('companion_health_trend', { metric: 'steps' });
  assert.equal(trend.ok, false);
  assert.equal(trend.code, 'health-method-missing');
});

test('stripPrivate：递归删除匹配键（嵌套对象/数组、驼峰 rawRef、token、uid）', () => {
  const input = {
    ok: true,
    uid: '1234567890',
    token: { accessToken: 'a', refreshToken: 'r' },
    rawRef: 'ref-camel',
    raw_ref: 'ref-snake',
    uniqueId: 'u1',
    unique_id_hash: 'h1',
    devId: 'd1',
    dev_id_hash: 'h2',
    payload_json: '{"a":1}',
    keep: 'visible',
    nested: { deeper: { token: 'x', note: 'kept' }, list: [{ uid: 1, name: 'a' }, { name: 'b', rawRef: 'r' }] },
    numbers: [1, 2, 3],
    nothing: null,
    at: new Date('2026-11-03T00:00:00.000Z'),
  };
  const clean = stripPrivate(input);
  assert.deepEqual(clean, {
    ok: true,
    keep: 'visible',
    nested: { deeper: { note: 'kept' }, list: [{ name: 'a' }, { name: 'b' }] },
    numbers: [1, 2, 3],
    nothing: null,
    at: '2026-11-03T00:00:00.000Z',
  });
  assert.equal(input.uid, '1234567890', 'the input object is not mutated');
  assert.equal(input.nested.list[0].uid, 1);
  assert.deepEqual(stripPrivate(['a', null, { token: 't', ok: 1 }]), ['a', null, { ok: 1 }]);
  assert.equal(stripPrivate('plain'), 'plain');
});

test('sleep 空态：透传 availability、有中文 message、session=null，且没有 0 分钟睡眠', async () => {
  const { call } = harness({ service: stubService() });
  const result = await call('companion_health_sleep', { date: '2026-11-03' });
  assert.equal(result.ok, true);
  assert.equal(result.availability, 'awaiting_first_night');
  assert.equal(result.session, null);
  assert.deepEqual(result.sessions, []);
  assert.match(result.message, /尚无睡眠记录/, 'the empty state is spelled out in Chinese');
  assert.ok(result.notes.includes(result.message), 'the message also rides in notes');
  const text = JSON.stringify(result);
  for (const field of ['asleepMinutes', 'awakeMinutes', 'inBedMinutes', 'sourceScore', 'deepMinutes', 'remMinutes']) {
    assert.ok(!text.includes(field), `no fabricated ${field} on an empty night`);
  }
});

test('sleep 有数据时：session 取当天会话，不加空态 message', async () => {
  const session = { sleepDate: '2026-11-03', startAt: '2026-11-02T23:10:00+08:00', endAt: '2026-11-03T07:05:00+08:00',
    asleepMinutes: 431, awakeMinutes: 18, inBedMinutes: 475, stageFidelity: 'exact', sessionQuality: 'origin-confirmed',
    status: 'confirmed', isNap: false, sourceScore: 82, sourceScoreLabel: '良好', stages: null, rawRef: 'ref-sleep' };
  const sleep = query => ({ ok: true, availability: 'present', timezone: 'Asia/Shanghai',
    range: { from: query.date ?? '2026-10-28', to: query.date ?? '2026-11-03' },
    sessions: [session], trend: [{ sleepDate: '2026-11-03', asleepMinutes: 431, startAt: session.startAt, endAt: session.endAt, quality: 'fresh' }],
    notes: [] });
  const { call } = harness({ service: stubService({ sleep }) });
  const result = await call('companion_health_sleep', { date: '2026-11-03', includeStages: true });
  assert.equal(result.availability, 'present');
  assert.equal(result.session.asleepMinutes, 431);
  assert.equal(result.message, undefined, 'a present night needs no empty-state message');
  assert.ok(!JSON.stringify(result).includes('ref-sleep'), 'rawRef is stripped');
});

test('参数收敛：days 缺省 7 并 clamp 到 1..30，date 非法回退今天并带 note', async () => {
  const service = stubService();
  const { call } = harness({ service });

  await call('companion_health_trend', { metric: 'steps' });
  assert.deepEqual(service.calls.at(-1), ['trend', { metric: 'steps', days: 7 }]);

  await call('companion_health_trend', { metric: 'steps', days: 999 });
  assert.deepEqual(service.calls.at(-1), ['trend', { metric: 'steps', days: 30 }]);

  await call('companion_health_trend', { metric: 'steps', days: 0 });
  assert.deepEqual(service.calls.at(-1), ['trend', { metric: 'steps', days: 1 }]);

  await call('companion_health_trend', { metric: 'stress', days: -5 });
  assert.deepEqual(service.calls.at(-1), ['trend', { metric: 'stress', days: 1 }]);

  await call('companion_health_trend', { metric: 'spo2', days: '11' });
  assert.deepEqual(service.calls.at(-1), ['trend', { metric: 'spo2', days: 11 }]);

  await call('companion_health_sleep', { days: 90 });
  assert.deepEqual(service.calls.at(-1), ['sleep', { days: 30, includeStages: false }],
    'no date given → keep the service default range');

  // Invalid date: today is used and the substitution is disclosed.
  const bad = await call('companion_health_today', { date: '2026-13-40' });
  assert.deepEqual(service.calls.at(-1), ['today', { date: '2026-11-03' }]);
  assert.match(bad.note, /2026-11-03/);

  // A real date is forwarded untouched, with no note.
  const good = await call('companion_health_today', { date: '2026-10-30' });
  assert.deepEqual(service.calls.at(-1), ['today', { date: '2026-10-30' }]);
  assert.equal(good.note, undefined);
});

test('metric 不在白名单 → 固定 code，不转发给 service', async () => {
  const service = stubService();
  const { call } = harness({ service });
  const result = await call('companion_health_trend', { metric: 'blood_pressure' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'health-metric-unsupported');
  assert.match(result.message, /steps/);
  assert.deepEqual(service.calls, []);
});

test('getService 晚挂载：restart 前返回 not-mounted，挂载后立刻可用', async () => {
  let service = null;
  const declarations = new Map();
  const register = (name, description, parameters, execute, kind = 'read') => declarations.set(name,
    { name, description, parameters, kind,
      execute: async (args = {}) => JSON.stringify(await execute(args, OWNER, { agent: { session: { id: 'session-health' } } })) });
  registerHealthTools({ register, getService: () => service });
  const call = async (name, args = {}) => JSON.parse(await declarations.get(name).execute(args));

  assert.equal((await call('companion_health_status')).code, 'health-not-mounted');
  service = stubService();
  const after = await call('companion_health_status');
  assert.equal(after.ok, true, 'the lazy lookup sees a service mounted later');
  assert.equal((await call('companion_health_today')).ok, true);
});

test('接线：index.mjs 只 import 一次、只调用一次，且在全部既有 register 之后', async () => {
  // Deliberately static: mounting the whole foundation inside this file would drag the host
  // runtime and a real SQLite store into a pure interface test. The mount itself is covered by
  // the foundation integration tests; this only guards "someone deleted/duplicated the one line".
  const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8'));
  assert.equal(source.split("from './health-tools.mjs'").length - 1, 1, 'exactly one import');
  assert.equal(source.split('registerHealthTools({').length - 1, 1, 'exactly one wiring call');
  // Lazy, never captured at mount time. Two legitimate resolvers are accepted:
  //   * `resolveHealthService(ctx, root)` — current form. It tries `ctx.get` first and then the
  //     process-wide bridge, because `ctx.provide` is scoped to the providing row's subtree while
  //     the consumers are siblings (that scoping is exactly why production answered
  //     `health-not-mounted` even though the plugin was running).
  //   * a bare `ctx.get('companionHealth')` thunk — the original form.
  // What must never come back is a captured instance or a value read at mount time.
  const getService = source.match(/getService:\s*(\(\)\s*=>\s*[^,\n]+)/);
  assert.ok(getService, 'exactly one getService thunk');
  assert.match(getService[1], /resolveHealthService|ctx\.get\('companionHealth'\)/,
    `getService must resolve the service lazily (got: ${getService[1]})`);
  assert.doesNotMatch(getService[1], /\bservice\b/,
    'getService must not capture a service object; it has to re-resolve on every call');
  const wiringAt = source.indexOf('registerHealthTools({');
  const lastRegisterAt = source.lastIndexOf("register('companion_");
  assert.ok(lastRegisterAt > 0 && wiringAt > lastRegisterAt, 'wiring comes after the existing tool registrations');
  const applyEnd = source.lastIndexOf('engine.initialize()');
  assert.ok(wiringAt < applyEnd, 'wiring happens before apply finishes');
  assert.ok(!/catch\s*[({]?\s*(error|err|e)?\s*\)\s*\{[^}]*identity\.resolve/.test(source),
    'identity.resolve must never be wrapped in a catch');
});

test('失败码全部集中在顶部 HEALTH_FAILURES 表，没有内联自造', () => {
  assert.deepEqual(Object.keys(HEALTH_FAILURES).sort(),
    ['health-method-missing', 'health-metric-unsupported', 'health-not-mounted', 'health-read-denied', 'health-read-failed']);
  for (const [code, message] of Object.entries(HEALTH_FAILURES)) {
    assert.match(code, /^health-[a-z-]+$/, `${code} keeps the health- prefix`);
    assert.match(message, /。$/, `${code} must carry a finished Chinese sentence`);
    assert.ok(!/Error|ECONN|SQLITE|at \w+ \(/.test(message), `${code} must not embed stack/driver text`);
  }
});

test('宿主版本漂移：service 在但方法缺失 → 五个工具各自回 health-method-missing，绝不冒 TypeError', async () => {
  const methods = [
    ['companion_health_status', 'status'],
    ['companion_health_today', 'today'],
    ['companion_health_trend', 'trend'],
    ['companion_health_sleep', 'sleep'],
    ['companion_health_sources', 'sources'],
  ];
  // (a) an older/wrong facade where none of the read methods exist yet
  const bare = harness({ service: stubService({ status: undefined, today: undefined, trend: undefined, sleep: undefined, sources: undefined }) });
  for (const name of HEALTH_TOOL_NAMES) {
    const result = await bare.call(name, { metric: 'steps' });
    assert.equal(result.ok, false, `${name} must not claim data it cannot read`);
    assert.equal(result.code, 'health-method-missing');
    assert.equal(result.message, '健康模块未提供该读取能力。');
  }
  // (b) one method drifts away: only that tool degrades, its neighbours keep working
  for (const [toolName, methodName] of methods) {
    const partial = harness({ service: stubService({ [methodName]: undefined }) });
    const drifted = await partial.call(toolName, { metric: 'steps' });
    assert.equal(drifted.code, 'health-method-missing', `${toolName} degrades when service.${methodName} is gone`);
    for (const [otherTool] of methods) {
      if (otherTool === toolName) continue;
      const fine = await partial.call(otherTool, { metric: 'steps' });
      assert.equal(fine.ok, true, `${otherTool} still works while service.${methodName} is missing`);
    }
  }
});

test('consents() 自身抛错 → 五个工具都回 health-read-failed（不是 denied，也不冒泡）', async () => {
  const throwing = stubService({ consents: () => { throw new Error('consent table locked (health.db wal)'); } });
  const h = harness({ service: throwing });
  for (const name of HEALTH_TOOL_NAMES) {
    const result = await h.call(name, { metric: 'steps' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'health-read-failed', `${name} must not bubble the consent failure`);
    assert.notEqual(result.code, 'health-read-denied', 'an unreadable consent table is not a denial');
    assert.equal(result.message, '读取健康数据时出错。');
    assert.ok(!JSON.stringify(result).includes('consent table locked'), 'no driver text leaks');
  }
  assert.deepEqual(throwing.calls, [], 'a throwing consent gate never reaches the store');

  // A rejected async consents() takes the same path.
  const rejecting = stubService({ consents: async () => { throw new Error('async consent boom'); } });
  const h2 = harness({ service: rejecting });
  for (const name of HEALTH_TOOL_NAMES) {
    assert.equal((await h2.call(name, { metric: 'steps' })).code, 'health-read-failed');
  }
});
