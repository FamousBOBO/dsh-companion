/**
 * 外部 B 站模块 × 运行期 provider 注册表的集成测试（non-ui-audit-plan-20261116 P2）。
 *
 * 两边各自有测试，但中间那条缝没人验：指纹通过的那一份能不能真的把 provider 注册进进程级
 * 注册表、`ready()` 转身后端口是否如实变化、卸载（删掉条目）之后是否回到不可用。这里用一份
 * 合成的外部模块（源码里真的含 `process[Symbol.for(...)].set(...)`）把整条链接上：
 * 指纹校验 → 动态 import 注册 → 端口 available/run → ready 变化 → 卸载与重挂。
 *
 * 全程只读：临时目录在 os.tmpdir()，不 import 本机装的那一份，不联网，不碰 data/。
 * 每个用例用独立的 state 目录（realpath 做键），所以注册表条目互不串台。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { verifyModule } from './verify-external-modules.mjs';

const SUITE_MODULE = new URL('../plugins/companion-runtime/lib/bilibili-provider.mjs', import.meta.url);
const PROVIDERS = Symbol.for('dsh.companion.bilibili.providers.v1');

/** 合规模块：形状与验收过的那一份一致（ready/run + 注册表 set）。key 从环境变量读，便于测试。 */
const MODULE_SOURCE = `
const key = process.env.BILI_TEST_KEY;
const providers = process[Symbol.for('dsh.companion.bilibili.providers.v1')] ??= new Map();
const state = { ready: true, runs: 0 };
providers.set(key, {
  ready: () => state.ready,
  run(request) {
    state.runs += 1;
    request.record({ kind: 'report', written: true });
    return Promise.resolve({ status: 'completed' });
  },
});
export const handle = state;
`;

function pinFor(source, version = '2.4.0') {
  return {
    'dsh-bili-scroll': {
      version,
      indexSha256: crypto.createHash('sha256').update(source).digest('hex'),
      expectedBytes: Buffer.byteLength(source),
      requiresProviderPublish: true,
    },
  };
}

/** 一个合成安装副本 + 一个属于它的 state 目录；两样都在 t.after 里清干净。 */
function fixture(t, { bytes = MODULE_SOURCE } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-ext-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-state-'));
  const dir = path.join(root, 'dsh-bili-scroll');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), bytes);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-bili-scroll', version: '2.4.0' }));
  const key = fs.realpathSync(stateDir);
  t.after(() => {
    process[PROVIDERS]?.delete?.(key);
    for (const target of [root, stateDir]) {
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
    }
  });
  return { root, dir, entry: path.join(dir, 'index.js'), stateDir, key };
}

/** import 一份合成模块，让它把 provider 注册进进程注册表。 */
async function mount(entry, key, tag) {
  process.env.BILI_TEST_KEY = key;
  const mod = await import(`${pathToFileURL(entry).href}?mount=${tag}`);
  return mod;
}

async function portFor(t, stateDir) {
  const { createBilibiliProviderPort } = await import(SUITE_MODULE.href);
  return createBilibiliProviderPort(stateDir, { now: () => 1000 });
}

test('版本兼容 + 注册：指纹通过的那一份真的把 provider 注册进进程注册表', async t => {
  const fx = fixture(t);
  const verdict = verifyModule({ moduleRoot: fx.root, pins: pinFor(MODULE_SOURCE) });
  assert.equal(verdict.ok, true, `fingerprint gate must pass for the synthetic copy: ${verdict.code}`);
  assert.equal(verdict.version, '2.4.0', '版本来自被校验目录自己的 package.json');
  assert.equal(verdict.bytes, Buffer.byteLength(MODULE_SOURCE));

  const port = await portFor(t, fx.stateDir);
  assert.equal(port.available(), false, '还没 import 模块时，端口必须不可用');

  await mount(fx.entry, fx.key, 'first');
  assert.equal(port.available(), true, '注册之后 available() 才是真的就绪');
  assert.deepEqual(
    await port({ roundId: 'round-1', deadlineAt: 5000 }),
    { roundId: 'round-1', status: 'completed', evidence: [{ kind: 'report', written: true }] },
  );
});

test('ready 状态变化：provider 自己说不 ready 时端口立刻回到不可用', async t => {
  const fx = fixture(t);
  const port = await portFor(t, fx.stateDir);
  const mod = await mount(fx.entry, fx.key, 'ready-toggle');
  assert.equal(port.available(), true);

  mod.handle.ready = false; // 例如配置开关被关掉、或者额度用尽
  assert.equal(port.available(), false, 'ready 一转身，端口必须如实报不可用');

  mod.handle.ready = true;
  assert.equal(port.available(), true, '恢复 ready 后端口也跟着恢复');
});

test('卸载清理：删掉注册条目之后端口回到不可用，重新挂载又能恢复', async t => {
  const fx = fixture(t);
  const port = await portFor(t, fx.stateDir);
  await mount(fx.entry, fx.key, 'unmount-a');
  assert.equal(port.available(), true);

  process[PROVIDERS].delete(fx.key);
  assert.equal(port.available(), false, '卸载后不能再 available');

  await mount(fx.entry, fx.key, 'unmount-b');
  assert.equal(port.available(), true, '重新挂载后必须重新可用（注册表不被缓存）');
});

test('未就绪的 provider 不会被 run 伪装成成功：run 直接返回 failed，且不产证据', async t => {
  const fx = fixture(t);
  const port = await portFor(t, fx.stateDir);
  const mod = await mount(fx.entry, fx.key, 'not-ready-run');
  mod.handle.ready = false;

  const result = await port({ roundId: 'round-2', deadlineAt: 5000 });
  assert.equal(result.status, 'failed', 'provider 不 ready 时 run 必须返回 failed');
  assert.deepEqual(result.evidence, [], '没有执行就没有证据');
  assert.equal(mod.handle.runs, 0, '不 ready 就不该真的跑');
});

test('指纹不通过的副本即便能注册，也不该被当作已验收的安装', async t => {
  const fx = fixture(t, { bytes: 'export const x = 1;\n' });
  const verdict = verifyModule({ moduleRoot: fx.root, pins: pinFor(MODULE_SOURCE) });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'hash-mismatch');
  assert.match(verdict.note, /同版本号不等于同一份代码/);
  assert.equal(verdict.version, '2.4.0', '版本号相同恰好说明"同版本号"这条判据不可用');
});
