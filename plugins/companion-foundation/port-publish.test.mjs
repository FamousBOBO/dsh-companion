/** 跨插件端口发布与解析的单测（foundation 的 `port-publish.mjs`）。
 *
 * 这一层的失败模式全是**静默**的：键拼错了、裸键被别人占了、服务形状不对——
 * 表现都只是"记忆一直是空的 / 人格一直是降级的"。所以用例集中在这些静默路径上。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPANION_PORTS_SYMBOL,
  publishCompanionService,
  registryKeysFor,
  resolveCompanionService,
} from './port-publish.mjs';

const ROOT = 'D:\\tmp\\suite';
const SYMBOL = Symbol.for('dsh.companion.ports.v1');

/** 清掉本用例写过的键（注册表是进程级的，测试之间必须互不影响）。 */
function cleanup(...keys) {
  const registry = process[SYMBOL];
  if (!(registry instanceof Map)) return;
  for (const key of keys) registry.delete(key);
}

test('symbol 与消费者用的那一枚是同一个（Symbol.for 跨模块身份不变）', () => {
  assert.equal(COMPANION_PORTS_SYMBOL, SYMBOL);
});

test('复合键形如 <name>\u0000<root>，Windows 上还带大小写变体', () => {
  const keys = registryKeysFor('companionGroupMemory', ROOT);
  assert.ok(keys.length >= 1);
  for (const key of keys) {
    assert.ok(key.startsWith('companionGroupMemory\u0000'), key);
    assert.ok(key.includes('tmp'), key);
  }
  if (process.platform === 'win32') {
    // 只用 root 部分比大小写：名字本身按原样拼，不能因为名字里有大写就判失败。
    const roots = keys.map((key) => key.slice('companionGroupMemory\u0000'.length));
    assert.ok(roots.some((part) => part === part.toLowerCase()), 'Windows 上 root 应有小写变体');
  }
});

test('发布后能按复合键解析到自己；释放之后解析不到', () => {
  const port = { query: () => 'ok' };
  const release = publishCompanionService({ root: ROOT, name: 'companionTestPort', service: port });
  assert.equal(resolveCompanionService({ name: 'companionTestPort', root: ROOT }), port);
  release();
  assert.equal(resolveCompanionService({ name: 'companionTestPort', root: ROOT }), null);
  cleanup(ROOT);
});

test('裸键被别人占用时，复合键仍然解析到自己（companion-health 的真实情形）', () => {
  const mine = { query: () => 'group-memory' };
  const health = { qqCareCandidate: () => null };
  const release = publishCompanionService({ root: ROOT, name: 'companionTestPort', service: mine });
  const registry = process[SYMBOL];
  registry.set(ROOT, { service: health, ready: () => true });
  assert.equal(resolveCompanionService({ name: 'companionTestPort', root: ROOT }), mine);
  release();
  cleanup(ROOT);
});

test('release 之后被别的服务占着裸键时，解析结果**不是**那个陌生服务（返回 null）', () => {
  const mine = { query: () => 'group-memory' };
  const health = { qqCareCandidate: () => null };
  const release = publishCompanionService({ root: ROOT, name: 'companionTestPort', service: mine });
  const registry = process[SYMBOL];
  // 模拟 companion-health 后挂载、覆盖裸键（真实发生过的那一次）。
  registry.set(ROOT, { service: health, ready: () => true });
  release();
  // 关键：裸键上没有"我们发布的名字"，所以不认；返回 null 而不是把 health 当端口。
  assert.equal(resolveCompanionService({ name: 'companionTestPort', root: ROOT }), null);
  cleanup(ROOT);
});

test('裸键由我们自己发布时（名字对得上）仍然认，即使没有 accept', () => {
  const mine = { query: () => 'group-memory' };
  const release = publishCompanionService({ root: ROOT, name: 'companionBareTest', service: mine });
  const registry = process[SYMBOL];
  // 抹掉复合键，只留裸键：模拟一个只有裸键可用的部署。
  for (const key of registryKeysFor('companionBareTest', ROOT)) registry.delete(key);
  assert.equal(resolveCompanionService({ name: 'companionBareTest', root: ROOT }), mine);
  release();
  cleanup(ROOT);
});

test('accept 形状检查：裸键上是别的服务时按"没找到"处理', () => {
  const health = { qqCareCandidate: () => null };
  const registry = process[SYMBOL];
  registry.set(ROOT, { service: health, ready: () => true });
  const found = resolveCompanionService({
    name: 'companionTestPort',
    root: ROOT,
    accept: (service) => typeof service?.query === 'function',
  });
  assert.equal(found, null);
  cleanup(ROOT);
});

test('ready() 返回 false 的服务视为不存在（不半坏着用）', () => {
  const release = publishCompanionService({
    root: ROOT,
    name: 'companionTestPort',
    service: { query: () => 'ok' },
    ready: () => false,
  });
  assert.equal(resolveCompanionService({ name: 'companionTestPort', root: ROOT }), null);
  release();
  cleanup(ROOT);
});

test('ctx.get 优先于注册表（同子树时的正规通路）', () => {
  const local = { query: () => 'local' };
  const published = { query: () => 'published' };
  const release = publishCompanionService({ root: ROOT, name: 'companionTestPort', service: published });
  const found = resolveCompanionService({
    name: 'companionTestPort',
    root: ROOT,
    context: () => ({ get: (name) => (name === 'companionTestPort' ? local : undefined) }),
  });
  assert.equal(found, local);
  release();
  cleanup(ROOT);
});

test('没有任何服务时返回 null，且绝不抛', () => {
  assert.equal(resolveCompanionService({ name: 'companionTestPort', root: ROOT }), null);
  assert.equal(resolveCompanionService({ name: '', root: ROOT }), null);
  assert.equal(resolveCompanionService({ name: 'companionTestPort', root: '' }), null);
});

test('发布缺 name / 缺 service 时什么也不写，并返回可调用的释放函数', () => {
  const release = publishCompanionService({ root: ROOT, name: '', service: {} });
  assert.equal(typeof release, 'function');
  release();
  const release2 = publishCompanionService({ root: ROOT, name: 'companionTestPort', service: null });
  assert.equal(typeof release2, 'function');
  release2();
});

test('释放函数幂等（卸载路径会重复调用）', () => {
  const release = publishCompanionService({ root: ROOT, name: 'companionTestPort', service: { query: () => 'ok' } });
  release();
  release();
  cleanup(ROOT);
});
