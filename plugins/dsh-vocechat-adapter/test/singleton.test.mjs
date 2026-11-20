// 单例闸：同一个 dataRoot + namespace 只允许一份适配层在跑。
//
// 这一组守的是一个**实测出来的重复驱动**（2026-11-19 03:30，生产宿主）：
//
//   一个 boot 内 `vocechat-adapter mounted:` 出现 2 次
//   `已订阅 companionVoceChat` 2 次，而 `companionVoceChat published` 只有 1 次
//
// 两次挂载各自订阅同一个端口 → 每条入站事件被驱动两遍。账本里能直接数出来：
//
//   mid 1246 → turn-start / undelivered(agent-has-no-inject-or-followup) / turn-start
//   mid 1248、1249、1250 → 每条的 `sent` 与 `skipped` 都成对出现
//
// 表面症状只是"偶尔回两遍"，实际是两个回合在抢同一个 agent：第一个拿到 agent 时它还在
// create/resume（`deliverTo` 找不到接缝），第二个才真的交付。于是**每一轮都被跑两遍**，
// 模型调用翻倍，而「一轮一次纠正 / 一轮一次沉默 / 水位只推进一次」这些保证全部失效。
//
// 判据只有一条但要精确：`dataRoot + namespace` 是身份。
//   - G5 多实例是**两个进程**、各有自己的 dataRoot → 不该互相挡；
//   - 同进程同 key 的第二份 → 必须让路。
//
// 五组：
//   1. 第一次拿到，第二次拿不到
//   2. 释放之后能再拿到（reload 不被残留挡住）
//   3. 不同 namespace / 不同 dataRoot 互不干扰
//   4. 锁真的落在 process 级（跨模块实例也拦得住）
//   5. 释放只删自己那一条

import test from 'node:test';
import assert from 'node:assert/strict';

import { claimInstance } from '../index.mjs';

const KEY = Symbol.for('companion.vocechat-adapter.instance.v1');

function cleanProcessRegistry() {
  // 这条闸是 process 级的全局状态，测试之间必须互相隔离。
  try { delete process[KEY]; } catch { /* frozen */ }
}

// ── 1. 互斥 ─────────────────────────────────────────────────────────────

test('第一次拿到锁，第二次拿到 null（同 dataRoot + 同 namespace）', () => {
  const registry = new Map();
  const first = claimInstance('D:/data', '', { registry });
  assert.equal(typeof first, 'function');
  const second = claimInstance('D:/data', '', { registry });
  assert.equal(second, null, '第二份必须让路，否则每条入站被驱动两次');
  first?.();
});

test('空 namespace 与字符串 namespace 是两个不同的身份', () => {
  const registry = new Map();
  const a = claimInstance('D:/data', '', { registry });
  const b = claimInstance('D:/data', 'vcb', { registry });
  assert.equal(typeof a, 'function');
  assert.equal(typeof b, 'function', 'G5 实例不该被另一个实例挡掉');
  a?.(); b?.();
});

test('不同 dataRoot 互不干扰（两个独立部署同机共存）', () => {
  const registry = new Map();
  const a = claimInstance('D:/dsh-production/data', '', { registry });
  const b = claimInstance('D:/dsh-companion-2/suite/data', 'vcb', { registry });
  assert.equal(typeof a, 'function');
  assert.equal(typeof b, 'function');
  a?.(); b?.();
});

// ── 2. 释放 ─────────────────────────────────────────────────────────────

test('释放之后能再拿到（cordis reload 不被上一份的残留挡住）', () => {
  const registry = new Map();
  const first = claimInstance('D:/data', '', { registry });
  assert.equal(typeof first, 'function');
  first?.();
  const again = claimInstance('D:/data', '', { registry });
  assert.equal(typeof again, 'function', '不释放会让"重启插件改配置"看起来没生效');
  again?.();
});

test('释放是幂等的（dispose 被调两次不该抛，也不该删掉别人的锁）', () => {
  const registry = new Map();
  const release = claimInstance('D:/data', '', { registry });
  release?.();
  release?.();
  const next = claimInstance('D:/data', '', { registry });
  assert.equal(typeof next, 'function');
  next?.();
});

// ── 3. 进程级 vs 注入 ───────────────────────────────────────────────────

test('不注入 registry 时用的是 process 级注册表（跨模块实例也拦得住）', () => {
  cleanProcessRegistry();
  const first = claimInstance('D:/proc-level', '');
  assert.equal(typeof first, 'function');
  // 模拟"另一个模块实例"：再调一次，它读的是同一张 process 表。
  const second = claimInstance('D:/proc-level', '');
  assert.equal(second, null, '模块级变量挡不住这种情况，必须用 process');
  first?.();
  cleanProcessRegistry();
});

test('注入的 registry 与 process 级互不污染', () => {
  cleanProcessRegistry();
  const injected = new Map();
  const a = claimInstance('D:/data', '', { registry: injected });
  const b = claimInstance('D:/data', '');
  assert.equal(typeof a, 'function');
  assert.equal(typeof b, 'function', '注入的 Map 只影响那一次调用');
  a?.(); b?.();
  cleanProcessRegistry();
});

// ── 4. 键的形状 ─────────────────────────────────────────────────────────

test('锁记录带 pid 与时间（运维能从 Map 里看出是谁占着）', () => {
  const registry = new Map();
  claimInstance('D:/data', '', { registry });
  const entry = [...registry.values()][0];
  assert.equal(entry.pid, process.pid);
  assert.equal(Number.isInteger(entry.at), true);
  assert.equal(entry.at > 0, true);
});

test('key 用 \\u0000 分隔 dataRoot 与 namespace（不会与路径里的字符混淆）', () => {
  const registry = new Map();
  claimInstance('D:/a', 'b', { registry });
  const key = [...registry.keys()][0];
  assert.equal(key.includes('\u0000'), true);
  assert.equal(key, 'D:/a\u0000b');
});
