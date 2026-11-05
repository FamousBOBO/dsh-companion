// Cordis 装载契约：apply() 的返回值**必须是 undefined**。
//
// 这组用例锁的是一次真实的宿主崩溃（2026-11-04 00:4x）：`apply()` 曾 `return service;`，
// 而 Cordis 把「apply 的返回值」当成**清理函数**去登记，于是加载时抛 `Invalid effect`，
// 整台桌面起不来 —— 表现是 GUI 端口反复变化、插件看起来"没挂上"。
//
// 同一个坑还有第二种形态：`ctx.effect(fn)` 里 `fn` 也必须返回函数（或 undefined），
// 返回对象同样会被判为非法清理器。这条也一起钉住。
//
// 注意：本机 `os.tmpdir()` 指向工作区的 tmp/，Windows 下 SQLite 句柄未关时 rmSync 会 EPERM，
// 所以每个用例都先 `service.close()` 再带重试删除。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../index.mjs');
const { resolveHealthService } = await import('../../companion-foundation/health-service-ref.mjs');

/** 每个 effect 回调的返回值都必须可被 Cordis 接受：函数或 undefined。 */
function assertDisposerLike(label, value) {
  assert.ok(
    value === undefined || typeof value === 'function',
    `${label} 返回了 ${value === null ? 'null' : typeof value}（${String(value).slice(0, 40)}）——`
    + 'Cordis 会把它当清理函数，加载时抛 Invalid effect。只允许 undefined 或函数。',
  );
}

/**
 * 一个**会校验装载契约**的桩 ctx：Cordis 的两个硬性要求都被强制。
 * 配置里的 baseUrl 指向必然连不上的回环端口，所以 start() 的首次同步会快速失败：
 * 测试走真实代码路径，但绝不碰真实 8765 sidecar，也不写真实 home/health。
 */
function makeCtx({ withProvide = true, withEffect = true } = {}) {
  const provided = new Map();
  const effects = [];
  const ctx = { get: () => undefined, inject: () => {} };
  if (withProvide) ctx.provide = (name, value) => provided.set(name, value);
  if (withEffect) {
    ctx.effect = (factory, label) => {
      const disposer = factory();
      assertDisposerLike(`ctx.effect(${label ?? 'anonymous'}) 的工厂`, disposer);
      effects.push(disposer);
      return disposer;
    };
  }
  return { ctx, provided, effects };
}

function makeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-apply-'));
  fs.mkdirSync(path.join(root, 'home', 'health'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', 'health', 'config.json'), JSON.stringify({
    enabled: true,
    collector: { baseUrl: 'http://127.0.0.1:1', pollMinutes: 15, windowDays: 7, requestTimeoutMs: 500 },
    pulse: { enabled: false },
  }, null, 2));
  return root;
}

function removeTree(dir) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 11) throw error;
      const until = Date.now() + 60;
      while (Date.now() < until) { /* 让 SQLite 释放句柄 */ }
    }
  }
}

/** 统一收尾：关掉本次激活发布的服务 → 还原 env → 删临时 home（带重试）。 */
async function withHome(run) {
  const home = makeHome();
  const previous = process.env.DSH_COMPANION_HEALTH_HOME;
  process.env.DSH_COMPANION_HEALTH_HOME = home;
  const opened = [];
  try {
    return await run({ home, track: service => { if (service) opened.push(service); } });
  } finally {
    // 没走 provide 的用例（最贫瘠 composition）从**进程级服务桥**把实例取回来关掉，
    // 否则 SQLite 句柄会让临时目录删不掉（Windows EPERM）。
    try {
      const viaBridge = resolveHealthService({ get: () => undefined }, mod.WORKSPACE_ROOT);
      if (viaBridge) opened.push(viaBridge);
    } catch { /* 桥没发布也不影响清理 */ }
    for (const service of opened) {
      try { await service.close(); } catch { /* close 从不 reject；这里只防御 */ }
    }
    if (previous === undefined) delete process.env.DSH_COMPANION_HEALTH_HOME;
    else process.env.DSH_COMPANION_HEALTH_HOME = previous;
    removeTree(home);
  }
}

test('name/version 是插件元数据，inject 不依赖任何服务', () => {
  assert.equal(mod.name, 'companion-health');
  assert.deepEqual(mod.inject, []);
  assert.equal(typeof mod.version, 'string');
});

test('apply() 返回 undefined —— 返回对象会让 Cordis 抛 Invalid effect（宿主崩溃的成因）', async () => {
  await withHome(async ({ track }) => {
    const { ctx, provided } = makeCtx();
    const returned = await mod.apply(ctx);
    track(provided.get('companionHealth'));
    assert.equal(returned, undefined,
      'apply() 的返回值会被 Cordis 当清理函数；返回 service 对象会直接让宿主加载失败');
  });
});

test('每个 ctx.effect 工厂都只返回函数或 undefined（返回对象同样是 Invalid effect）', async () => {
  await withHome(async ({ track }) => {
    const { ctx, provided, effects } = makeCtx();
    await mod.apply(ctx);
    track(provided.get('companionHealth'));
    assert.ok(effects.length >= 1, '至少要登记一个生命周期 disposer');
    for (const disposer of effects) {
      assertDisposerLike('disposer', disposer);
      if (typeof disposer === 'function') assert.equal(await disposer(), undefined, '清理函数自己也不许返回值');
    }
  });
});

test('第二次 apply 复用同一个 singleton，且仍然返回 undefined', async () => {
  await withHome(async ({ track }) => {
    const first = makeCtx();
    assert.equal(await mod.apply(first.ctx), undefined);
    const second = makeCtx();
    assert.equal(await mod.apply(second.ctx), undefined);
    track(second.provided.get('companionHealth') ?? first.provided.get('companionHealth'));
    assert.equal(first.provided.size, 1, '第一次激活应发布服务');
    assert.equal(second.provided.size, 1, '第二次激活也应重新发布');
    assert.equal(first.provided.get('companionHealth'), second.provided.get('companionHealth'),
      '必须是同一个实例（一个 SQLite 句柄、一个定时器）');
  });
});

test('宿主没有 provide/effect 时也不抛、也返回 undefined（最贫瘠的 composition 也要能挂）', async () => {
  await withHome(async () => {
    const { ctx, provided } = makeCtx({ withProvide: false, withEffect: false });
    assert.equal(await mod.apply(ctx), undefined);
    assert.equal(provided.size, 0);
  });
});
