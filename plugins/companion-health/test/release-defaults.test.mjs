// 发布默认值 + 三通道诚实状态（「未配置 / 不可用 / 未启用 / 正常」）。
//
// 这个文件锁的是团队公约里的两条硬规矩，而不是某个功能的细节：
//   1. **安全默认值**：健康采集与 BLE 心率默认关闭；关着的时候不建库、不轮询、不发起任何请求
//      （连回环 sidecar 都不碰）。"我没配置" 绝不能变成 "它在后台偷偷跑"。
//   2. **不许伪造成功**：状态必须能把「未配置」「不可用」「未启用」「正常」分开。没有账号登录
//      记录就是「未配置」，没有 BLE 设备就是「不可用」，而不是空白、不是绿灯。
//
// **所有数据库都在 os.tmpdir() 下**，绝不碰 `<repo>/home/health/health.db`。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, defaultConfig, loadConfig } from '../lib/config.mjs';
import { buildReadiness, LABELS } from '../lib/readiness.mjs';
import { createHealthService } from '../lib/service.mjs';
import { openHealthDb } from '../lib/db.mjs';

function tempHome(t, { withDb = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-release-'));
  fs.mkdirSync(path.join(dir, 'health'), { recursive: true });
  if (withDb) {
    const db = openHealthDb({ file: path.join(dir, 'health', 'health.db') });
    db.close();
  }
  t.after(() => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* WAL 句柄 */ }
    }
  });
  return dir;
}

/** 记账式 fetch：任何一次真正的请求都会留下痕迹（测试要证明的是「一次都没有」）。 */
function countingFetch(answer = () => { throw new Error('offline'); }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    return answer(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

test('来源未提供 token 到期信息时，真实同步与探测均保持未知，不虚构过期时间', async t => {
  const home = tempHome(t);
  const fetchImpl = countingFetch(() => new Response(JSON.stringify({token: {},daily:[],health:[],sessions:[],devices:[],sources:[],errors:[]})));
  const service = createHealthService({home,fetchImpl,log:()=>{},config:{enabled:true}});
  t.after(()=>service.close());
  assert.equal((await service.initialize()).ok,true);
  await service.syncNow();
  const status = await service.status();
  assert.equal(status.source.auth.status,'unknown');
  assert.equal(status.source.auth.minutesLeft,null);
  assert.equal(status.source.auth.expiresAt,null);
  assert.equal(status.source.auth.refreshExpiresAt,null);
  const probe=await service.probeSource();
  assert.equal(probe.token.minutesLeft,null);
  assert.equal(probe.token.status,'unknown');
});

test('默认配置：采集关闭、BLE 关闭（安全默认值，不是"贴心地"开着）', () => {
  const config = defaultConfig();
  assert.equal(config.enabled, false, '健康采集必须默认关闭');
  assert.equal(config.pulse.enabled, false, 'BLE 心率必须默认关闭');
  // 其余隐私闸保持原样：只读能力可以留着，外发与注入类本轮无代码路径。
  assert.equal(config.privacy.ownerOnly, true);
  assert.equal(config.privacy.exposeToGroup, false);
  assert.equal(config.privacy.exposeToBili, false);
  // 冻结常量本身也要是同一个值（别处若直接读 DEFAULT_CONFIG 会看到同样的结论）。
  assert.equal(DEFAULT_CONFIG.enabled, false);
  assert.equal(DEFAULT_CONFIG.pulse.enabled, false);
});

test('没有配置文件时，落盘的就是"关闭"那一版', async t => {
  const home = tempHome(t);
  const loaded = loadConfig({ home, writeDefaults: true });
  assert.equal(loaded.created, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'health', 'config.json'), 'utf8'));
  assert.equal(onDisk.enabled, false);
  assert.equal(onDisk.pulse.enabled, false);
});

test('采集关着：start()/syncNow() 立刻拒绝，不建库、不轮询、一次请求都不发', async t => {
  const home = tempHome(t, { withDb: false });
  const fetchImpl = countingFetch();
  const service = createHealthService({ home, fetchImpl, log: () => {} });
  t.after(async () => { try { await service.close(); } catch { /* 已关闭 */ } });

  const init = await service.initialize();
  // 没有库 + 采集关着 = "还没初始化"，不是错误页：插件照样挂载，只是没有数据。
  assert.equal(init.ok, false);
  assert.equal(init.code, 'health-db-unavailable');

  const started = await service.start();
  assert.equal(started.ok, false);
  assert.ok(['health-disabled', 'health-db-unavailable'].includes(started.code), `start: ${started.code}`);
  assert.equal(service.isRunning(), false);

  const synced = await service.syncNow({ reason: 'test' });
  assert.equal(synced.ok, false);

  const pulse = await service.pulse();
  assert.equal(pulse.ok, false);
  // 没初始化时所有门面都走同一个 typed 拒绝（`health-db-unavailable`）；面板要看的
  // 「未启用 / 未配置」在 readiness() 里，而不是靠猜错误码。
  assert.ok(['pulse-disabled', 'health-pulse-unavailable', 'health-db-unavailable'].includes(pulse.code), `pulse: ${pulse.code}`);
  const prompt = await service.pulsePrompt();
  assert.equal(prompt.text, '');

  const readiness = service.readiness();
  assert.equal(readiness.collection.state, 'disabled');
  assert.equal(readiness.collection.label, '未启用');
  assert.equal(readiness.account.label, '未配置');
  assert.equal(readiness.ble.label, '未启用');

  // 收尾：初始化失败不会建数据库。
  assert.equal(fs.existsSync(path.join(home, 'health', 'health.db')), false, '关着的时候不许建库');
  assert.deepEqual(fetchImpl.calls, [], '未授权/未启用时不得发起任何外部请求');
});

test('采集开启但 sidecar 不通：判定「不可用」，不是「正常」也不是「未配置」', async t => {
  const home = tempHome(t);
  const fetchImpl = countingFetch();
  const service = createHealthService({
    home,
    fetchImpl,
    log: () => {},
    config: { enabled: true, collector: { baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 400 } },
  });
  t.after(async () => { try { await service.close(); } catch { /* 已关闭 */ } });
  assert.equal((await service.initialize()).ok, true);

  const readiness = service.readiness();
  assert.equal(readiness.collection.state, 'unconfigured');
  assert.equal(readiness.collection.label, '未配置');
  assert.equal(readiness.account.state, 'unconfigured');
  assert.equal(readiness.account.label, '未配置');
  assert.equal(readiness.ble.state, 'disabled');
  assert.match(readiness.summary, /采集：未配置/);

  // 真的跑一轮采集（连不上）→ 采集与账号都变成「不可用」。
  const synced = await service.syncNow({ reason: 'test' });
  assert.equal(synced.ok, false);
  const after = service.readiness();
  assert.equal(after.collection.state, 'unavailable');
  assert.equal(after.collection.label, '不可用');
  assert.equal(after.account.state, 'unavailable');
  assert.equal(after.account.label, '不可用');
  // 「没连上 sidecar」不等于「账号没登录」：这里不许把结论升级成「需要重新登录」。
  assert.notEqual(after.account.state, 'reauthorize');
});

test('BLE 开启但 sidecar 不通：判定「不可用」，不显示任何假读数', async t => {
  const home = tempHome(t);
  const fetchImpl = countingFetch();
  const service = createHealthService({
    home,
    fetchImpl,
    log: () => {},
    config: { enabled: false, pulse: { enabled: true, pollMs: 250 } },
  });
  t.after(async () => { try { await service.close(); } catch { /* 已关闭 */ } });
  assert.equal((await service.initialize()).ok, true);

  // 功能开着、还没读过一次：状态是"未知"，不是"正常"。
  assert.equal(service.readiness().ble.state, 'unknown');

  const polled = await service.pulsePollNow();
  assert.equal(polled.ok, true);
  const readiness = service.readiness();
  assert.equal(readiness.ble.state, 'unavailable');
  assert.equal(readiness.ble.label, '不可用');
  assert.match(readiness.ble.hint, /BLE sidecar|扫描/);
  // 一次真实请求（正好一次），而且没有拿到任何读数。
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal((await service.pulse()).bpm, null);
});

test('三通道判定表：未配置 / 不可用 / 未启用 / 正常 各自有独立证据', () => {
  const base = { config: { enabled: false, pulse: { enabled: false } } };

  const off = buildReadiness(base);
  assert.equal(off.collection.state, 'disabled');
  assert.equal(off.account.state, 'unconfigured');
  assert.equal(off.account.label, '未配置');
  assert.equal(off.ble.state, 'disabled');
  assert.equal(off.summary, '采集：未启用 · 账号：未配置 · 心率：未启用');

  const ok = buildReadiness({
    config: { enabled: true, pulse: { enabled: true } },
    phase: 'ready',
    auth: { status: 'valid', expiresAt: Date.now() + 3600_000 },
    lastRun: { status: 'ok', errorCode: null },
    hasDatabase: true,
    pulse: { enabled: true, ready: true, lastPollCode: null, sessionActive: true, bpm: 88 },
  });
  assert.equal(ok.collection.state, 'ready');
  assert.equal(ok.account.state, 'authorized');
  assert.equal(ok.ble.state, 'ready');
  assert.equal(ok.ble.label, '正常');

  const noDevice = buildReadiness({
    config: { enabled: true, pulse: { enabled: true } },
    phase: 'ready',
    auth: { status: 'valid' },
    lastRun: { status: 'ok' },
    pulse: { enabled: true, ready: true, lastPollCode: 'device-not-found', sessionActive: false, bpm: null },
  });
  assert.equal(noDevice.ble.state, 'unavailable');
  assert.equal(noDevice.ble.label, '不可用');

  const transport = buildReadiness({
    config: { enabled: true, pulse: { enabled: false } },
    phase: 'ready',
    auth: null,
    lastRun: { status: 'error', errorCode: 'unreachable' },
  });
  assert.equal(transport.collection.state, 'unavailable');
  assert.equal(transport.account.state, 'unavailable');

  const rejected = buildReadiness({
    config: { enabled: true, pulse: { enabled: false } },
    phase: 'ready',
    auth: { status: 'valid' },
    lastRun: { status: 'error', errorCode: '1002' },
  });
  assert.equal(rejected.account.state, 'reauthorize');
  assert.equal(rejected.account.label, '需要重新登录');

  // 每个状态都必须在 LABELS 里有中文标签：UI 不允许自己再拼一套文案。
  for (const channel of [off, ok, noDevice, transport, rejected]) {
    for (const key of ['collection', 'account', 'ble']) {
      assert.equal(typeof channel[key].label, 'string');
      assert.ok(channel[key].label.length > 0, `${key} 缺中文标签`);
      assert.equal(channel[key].label, LABELS[`${key}.${channel[key].state}`]);
      assert.equal(typeof channel[key].hint, 'string');
      assert.ok(channel[key].hint.length > 0, `${key} 缺一句为什么`);
    }
  }
});

test('只读实例：关着说「未启用」，开着也只说「未检测」（不替宿主断言轮询在跑）', () => {
  const off = buildReadiness({ config: { enabled: false, pulse: { enabled: false } }, readOnly: true });
  assert.equal(off.collection.state, 'disabled');
  assert.equal(off.collection.label, '未启用');
  const on = buildReadiness({ config: { enabled: true, pulse: { enabled: false } }, readOnly: true });
  assert.equal(on.collection.state, 'unchecked');
  assert.equal(on.collection.label, '未检测');
  assert.match(on.collection.hint, /只有宿主进程知道/);
});

test('status() 与 describe() 都带上三通道状态（面板读同一份结论）', async t => {
  const home = tempHome(t);
  const service = createHealthService({
    home, fetchImpl: countingFetch(), log: () => {},
    config: { enabled: true, collector: { baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 300 } },
  });
  t.after(async () => { try { await service.close(); } catch { /* 已关闭 */ } });
  assert.equal((await service.initialize()).ok, true);

  const status = service.status();
  assert.equal(status.ok, true);
  assert.ok(status.readiness, 'status() 必须带 readiness');
  assert.equal(status.readiness.collection.state, 'unconfigured');
  assert.equal(status.readiness.account.label, '未配置');

  const described = service.describe();
  assert.equal(described.readiness.collection.label, '未配置');
  assert.equal(described.config.enabled, true, 'describe 报告的是配置值，不是运行结论');
});
