/**
 * planner.mjs 的离线测试（E2 §6.3）。
 *
 * 证明的重点是那句产品要求：**parts 在第一条文本发送前就已全部生成**。所以这里断言的不是
 * 「函数被调用过」，而是「计划对象在返回时就完整、顺序固定、可复算」：
 *   - text_then_sticker 的 parts 是 [text, sticker]，且此刻两张都在；
 *   - 单轮最多 1 张图（超过就是非法计划）；
 *   - 幂等键 = sha256(planId:index)，同一计划重放算出同一个键；
 *   - 过期计划不投递；非法计划退化成 text_only 并保留原因码；
 *   - part 里出现路径类字段一律拒绝（模型永远不构造路径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  DEFAULT_PLAN_TTL_MS, MAX_STICKER_PARTS, MODES, NOT_IMPLEMENTED_MODES, PART_KINDS,
  plan, planIdFor, idempotencyKeyFor, modeFor, partsFor, validatePlan, isExpired, partJobs, describePlan,
} from '../src/planner.mjs';
import { ALLOWED_KEYS, FORBIDDEN_KEYS, TOOL_SPECS, createToolHandlers, validateArgs } from '../src/tools.mjs';
import { PORT_SYMBOL, apply, moduleGate } from '../src/index.mjs';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NOW = 1_700_000_000_000;
const TARGET = { kind: 'dm', id: '10001' };

const sha = text => createHash('sha256').update(String(text)).digest('hex');

test('模式集合：文档的五个可投递模式 + 明确不做 qq_face', () => {
  assert.deepEqual([...MODES], ['silent', 'text_only', 'sticker_only', 'text_then_sticker', 'sticker_then_text']);
  assert.ok(NOT_IMPLEMENTED_MODES.includes('qq_face'));
  assert.ok(!MODES.includes('qq_face'), 'qq_face 不在可投递模式里');
  assert.deepEqual([...PART_KINDS], ['text', 'sticker']);
});

test('parts 在生成计划的那一刻就已全部存在（不是边发边算）', () => {
  const p = plan({ turnId: 'turn-1', target: TARGET, draft: '哈哈这也太离谱了', assetId: 'ast_abc123456', mode: 'text_then_sticker', now: NOW });
  assert.equal(p.mode, 'text_then_sticker');
  assert.equal(p.parts.length, 2, '文字与图在同一份计划里');
  assert.deepEqual(p.parts.map(part => part.kind), ['text', 'sticker']);
  assert.equal(p.parts[0].content, '哈哈这也太离谱了');
  assert.equal(p.parts[1].assetId, 'ast_abc123456');
  // 计划里没有路径类字段：投递层自己 stage。
  for (const part of p.parts) {
    for (const key of Object.keys(part)) assert.ok(!['file', 'path', 'url', 'filePath'].includes(key), `part 不该有 ${key}`);
  }
});

test('sticker_then_text 的顺序是图在前、文字在后', () => {
  const p = plan({ turnId: 'turn-2', target: TARGET, draft: '好耶', assetId: 'ast_abc123456', mode: 'sticker_then_text', now: NOW });
  assert.deepEqual(p.parts.map(part => part.kind), ['sticker', 'text']);
  assert.deepEqual(partJobs(p).map(job => job.kind), ['sticker', 'text']);
});

test('没有文字就是 sticker_only；什么都没有就是 silent（且 silent 不带 parts）', () => {
  const stickerOnly = plan({ turnId: 'turn-3', target: TARGET, draft: '   ', assetId: 'ast_abc123456', mode: 'sticker_only', now: NOW });
  assert.equal(stickerOnly.mode, 'sticker_only');
  assert.deepEqual(stickerOnly.parts.map(part => part.kind), ['sticker']);
  const silent = plan({ turnId: 'turn-4', target: TARGET, draft: '', assetId: null, mode: 'silent', now: NOW });
  assert.equal(silent.mode, 'silent');
  assert.equal(silent.parts.length, 0);
  assert.equal(silent.reasonCode, 'silent');
});

test('modeFor 是纯推导：文字/图的组合决定模式', () => {
  assert.equal(modeFor({ text: 'a', hasSticker: true }), 'text_then_sticker');
  assert.equal(modeFor({ text: 'a', hasSticker: true, stickerFirst: true }), 'sticker_then_text');
  assert.equal(modeFor({ text: 'a', hasSticker: false }), 'text_only');
  assert.equal(modeFor({ text: '', hasSticker: true }), 'sticker_only');
  assert.equal(modeFor({ text: '  ', hasSticker: false }), 'silent');
  assert.deepEqual(partsFor({ mode: 'text_only', text: 'hi' }), [{ kind: 'text', content: 'hi' }]);
  assert.deepEqual(partsFor({ mode: 'silent', text: 'hi' }), []);
});

test('单轮最多 1 张：两个 sticker part 的计划直接非法', () => {
  const bad = {
    planId: 'p1', turnId: 't', target: TARGET, mode: 'text_then_sticker',
    parts: [{ kind: 'sticker', assetId: 'ast_a' }, { kind: 'sticker', assetId: 'ast_b' }],
    expiresAt: NOW, reasonCode: 'x',
  };
  const checked = validatePlan(bad);
  assert.equal(checked.ok, false);
  assert.equal(checked.reasonCode, 'too-many-stickers');
  assert.equal(MAX_STICKER_PARTS, 1);

  // plan() 也不允许你构造出两张：只接受一个 assetId。
  const p = plan({ turnId: 't', target: TARGET, draft: 'x', assetId: 'ast_a', mode: 'text_then_sticker', now: NOW });
  assert.equal(p.parts.filter(part => part.kind === 'sticker').length, 1);
});

test('幂等键 = sha256(planId:index)，重放同一计划得到同一串键', () => {
  const p = plan({ turnId: 'turn-5', target: TARGET, draft: '嘿', assetId: 'ast_abc123456', now: NOW });
  const jobs = partJobs(p);
  assert.deepEqual(jobs.map(job => job.index), [0, 1]);
  for (const job of jobs) {
    assert.equal(job.idempotencyKey, sha(`${p.planId}:${job.index}`));
    assert.equal(job.idempotencyKey, idempotencyKeyFor(p.planId, job.index));
  }
  // 重建一次（同一 turnId/目标/seq）→ planId 相同 → 键全部相同。
  const again = plan({ turnId: 'turn-5', target: TARGET, draft: '嘿', assetId: 'ast_abc123456', now: NOW });
  assert.equal(again.planId, p.planId);
  assert.deepEqual(partJobs(again).map(job => job.idempotencyKey), jobs.map(job => job.idempotencyKey));
  // 不同 seq 的计划是另一份计划。
  assert.notEqual(planIdFor({ turnId: 'turn-5', target: TARGET, seq: 1 }), p.planId);
});

test('过期计划：isExpired 只认 expiresAt，配置的 TTL 决定默认值', () => {
  const p = plan({ turnId: 'turn-6', target: TARGET, draft: 'x', assetId: 'ast_a', now: NOW });
  assert.equal(p.expiresAt, NOW + DEFAULT_PLAN_TTL_MS);
  assert.equal(isExpired(p, NOW + 1000), false);
  assert.equal(isExpired(p, p.expiresAt), true);
  assert.equal(isExpired({ ...p, expiresAt: 0 }, NOW), true, '没有 expiresAt 视为已过期（fail closed）');
});

test('非法计划退化成 text_only 并保留原因码，而不是抛', () => {
  const bad = plan({ turnId: 'turn-7', target: { kind: 'channel', id: '' }, draft: '文字还在', mode: 'text_then_sticker', now: NOW });
  assert.equal(bad.mode, 'text_only', '目标非法时退回纯文字');
  assert.equal(bad.parts.length, 1);
  assert.ok(bad.reasonCode && bad.reasonCode !== 'planned', `原因码要可读，实际 ${bad.reasonCode}`);

  const pathPart = validatePlan({
    planId: 'p2', turnId: 't', target: TARGET, mode: 'text_then_sticker',
    parts: [{ kind: 'sticker', assetId: 'ast_a', file: '/etc/passwd' }], expiresAt: NOW,
  });
  assert.equal(pathPart.ok, false);
  assert.equal(pathPart.reasonCode, 'path-key-forbidden');
});

test('wantSticker 但没有 assetId：不会凭空造一张图', () => {
  const p = plan({ turnId: 'turn-8', target: TARGET, draft: '只发文字', mode: 'sticker_only', assetId: null, now: NOW });
  assert.equal(p.mode, 'text_only');
  assert.equal(p.parts.length, 1);
  assert.equal(p.parts[0].kind, 'text');
});

test('describePlan 只说模式/段数与 assetId，不含路径', () => {
  const p = plan({ turnId: 'turn-9', target: TARGET, draft: '好', assetId: 'ast_abc123456', now: NOW });
  const line = describePlan(p);
  assert.match(line, /text_then_sticker/);
  assert.match(line, /ast_abc123456/);
  assert.ok(!line.includes('/'), '摘要里不该出现路径分隔符');
  assert.equal(describePlan(null), '无计划');
});

/* ───────── 工具契约与插件入口的两道开关（AGENTS.md 硬规则 2） ───────── */

test('四个工具：参数只有白名单里的键，路径类键连「被忽略」的机会都没有', () => {
  assert.equal(TOOL_SPECS.length, 4);
  assert.deepEqual(TOOL_SPECS.map(spec => spec.name), [
    'expression_candidates', 'expression_reply', 'expression_feedback', 'expression_library_stats',
  ]);
  for (const spec of TOOL_SPECS) {
    for (const key of Object.keys(spec.parameters)) assert.ok(ALLOWED_KEYS.includes(key), `${spec.name}.${key} 不在白名单`);
    assert.ok(!JSON.stringify(spec.parameters).includes('"file"'), `${spec.name} 不该有 file 参数`);
  }
  for (const key of FORBIDDEN_KEYS) {
    const denied = validateArgs({ [key]: '/etc/passwd' });
    assert.equal(denied.ok, false, `${key} 必须被拒绝`);
    assert.equal(denied.reasonCode, 'path-argument-forbidden');
  }
  assert.equal(validateArgs({ assetId: '/tmp/x.png' }).ok, false, 'assetId 不是路径');
  assert.equal(validateArgs({ limit: 9 }).ok, false, 'limit 只到 5（给模型 3–5 个候选）');
  assert.equal(validateArgs({ assetId: 'ast_abc123456', action: 'send', target: '90001' }).ok, true);

  // handler 拒绝路径参数时，service 一次都不该被调用。
  const seen = [];
  const handlers = createToolHandlers({
    service: { reply: async args => { seen.push(args); return { ok: true }; } },
  });
  return handlers.expression_reply({ assetId: 'ast_abc123456', file: '/etc/passwd' }, {})
    .then(result => {
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, 'path-argument-forbidden');
      assert.equal(seen.length, 0, '被拒绝的请求不得到达 service');
    });
});

test('模块级开关默认关闭；apply 在关闭时不注册工具、不发布端口', async () => {
  assert.equal(moduleGate({ env: {}, suiteRoot: '/nonexistent' }).enabled, false, '没有任何配置时默认关闭');
  assert.equal(moduleGate({ env: { DSH_COMPANION_MODULES_EXPRESSION: '1' }, suiteRoot: '/nonexistent' }).enabled, true);
  assert.equal(moduleGate({ env: { DSH_COMPANION_MODULES_EXPRESSION: '0' }, suiteRoot: '/nonexistent' }).enabled, false);

  const registered = [];
  const ctx = { tools: { register: tool => registered.push(tool) }, provide: () => {}, effect: () => {}, on: () => {} };
  const closed = await apply(ctx, { env: { DSH_COMPANION_MODULES_EXPRESSION: '0' } });
  assert.equal(closed, undefined);
  assert.equal(registered.length, 0);
  assert.equal(process[PORT_SYMBOL], undefined, '关闭时不发布入站端口');
});

test('打开模块后：注册四个工具、发布端口，且 delivery.enabled 仍是第二道闸', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-idx-'));
  const registered = [];
  const ctx = { tools: { register: tool => registered.push(tool) }, provide: () => {}, effect: () => {}, on: () => {} };
  try {
    const dispose = await apply(ctx, {
      env: {
        DSH_COMPANION_MODULES_EXPRESSION: '1',
        DSH_COMPANION_DATA_DIR: dir,
        DSH_COMPANION_SUITE_ROOT: path.resolve(PLUGIN_DIR, '..', '..'),
      },
      qqSender: { sendText: async () => ({ ok: true, messageId: 1 }), sendSticker: async () => ({ ok: true, messageId: 2 }) },
    });
    assert.equal(typeof dispose, 'function', 'apply 必须返回 disposer');
    assert.equal(registered.length, 4, `应注册 4 个工具，实际 ${registered.length}`);
    assert.equal(typeof process[PORT_SYMBOL]?.observe, 'function', '端口只提供同步的 observe');
    const replyTool = registered.find(tool => tool.name === 'expression_reply');
    const replyOut = JSON.parse(await replyTool.execute({ assetId: 'ast_abc123456', action: 'send' }, {}));
    assert.equal(replyOut.ok, false, 'delivery.enabled 默认 false：不会真发');
    assert.equal(replyOut.reasonCode, 'delivery-disabled');
    dispose();
    assert.equal(process[PORT_SYMBOL], undefined, 'disposer 释放端口');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
