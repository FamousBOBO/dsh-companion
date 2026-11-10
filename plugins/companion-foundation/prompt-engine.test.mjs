import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPromptEngine, historyFromSession, latestUserText, MAX_SESSIONS } from './prompt-engine.mjs';
import { promptConfigFile } from './prompt-config.mjs';

// Planner 走 `host-llm.mjs`，后者需要宿主模组根。这里用包里自带的 host 替身
// （`test-fixtures/module-root`），所以测试在没有安装桌面的机器上也能跑。
const here = path.dirname(fileURLToPath(import.meta.url));
const { resolveModuleRoot } = await import('./test-fixtures/module-root.mjs');
process.env.DSH_COMPANION_MODULE_ROOT = resolveModuleRoot(path.resolve(here, '../..')).root;

// 引擎是纯编排层：读配置、路由、组合、可选规划、可选文风统计。
// 这里不挂宿主、不调模型：Planner 用假的 ctx.get('llm') 替身，验证的是编排与降级。

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  return root;
}

function writeConfig(root, value) {
  fs.writeFileSync(promptConfigFile(root), JSON.stringify(value), 'utf8');
}

const ACTIVE = { enabled: true, mode: 'active' };

test('关闭时完全惰性：不路由、不组合、没有文本', async t => {
  const root = tempRoot(t);
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  assert.equal(engine.mode, 'off');
  assert.equal(engine.enabled, false);
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '早啊' });
  assert.equal(snapshot.text, '');
  assert.equal(snapshot.chars, 0);
  assert.equal(snapshot.planState, 'disabled');
  // 关闭时连路由计数都不该增加：没有任何东西被执行。
  assert.equal(engine.status().counters.routes, 0);
});

test('没有配置文件时引擎不创建文件，也不改变任何行为', async t => {
  const root = tempRoot(t);
  const engine = createPromptEngine({ root, env: {} });
  await engine.snapshot({ sessionId: 's1', message: '你好' });
  assert.equal(fs.existsSync(promptConfigFile(root)), false);
  assert.equal(engine.mode, 'off');
});

test('active 模式产出对话模块文本，且有独立预算', async t => {
  const root = tempRoot(t);
  writeConfig(root, ACTIVE);
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  assert.equal(engine.mode, 'active');
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '今天吃了碗面' });
  assert.equal(snapshot.mode, 'chat');
  assert.equal(snapshot.intensity, 'normal');
  assert.equal(snapshot.profile, 'chat');
  assert.ok(snapshot.text.length > 0);
  assert.ok(snapshot.chars <= snapshot.budgetChars, `${snapshot.chars} > ${snapshot.budgetChars}`);
  assert.equal(snapshot.budgetChars, 600);
  assert.equal(snapshot.shadowed, false);
});

test('shadow 模式：照常路由与组合，但绝不改变消息', async t => {
  const root = tempRoot(t);
  writeConfig(root, { enabled: true, mode: 'shadow' });
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '「你回来了。」' });
  assert.equal(snapshot.text, '', 'shadow 不得注入任何文本');
  assert.equal(snapshot.chars, 0);
  assert.equal(snapshot.shadowed, true);
  assert.ok(snapshot.wouldInjectChars > 0, '但仍然算出了“本来会注入多少”');
  assert.equal(snapshot.mode, 'roleplay', '路由照样执行');
  assert.ok(snapshot.selectedModules.length > 0);
});

test('各档预算取自配置，且越界被夹住', async t => {
  const root = tempRoot(t);
  writeConfig(root, { ...ACTIVE, budgets: { chat: 5, companion: 800, roleplay: 1300, task: 500 } });
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '早' });
  assert.equal(snapshot.budgetChars, 120, '配置里的 5 被夹到下限');
});

test('会话状态隔离：一个 session 进 RP 不影响另一个', async t => {
  const root = tempRoot(t);
  writeConfig(root, ACTIVE);
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  const a = await engine.snapshot({ sessionId: 'qq-dm-1', message: '「你回来了。」' });
  const b = await engine.snapshot({ sessionId: 'desktop-2', message: '今天吃了碗面' });
  assert.equal(a.mode, 'roleplay');
  assert.equal(b.mode, 'chat');
  assert.equal(engine.status().sessions, 2);
});

test('显式模式覆盖自主判断，clearSession 之后回到自主判断', async t => {
  const root = tempRoot(t);
  writeConfig(root, ACTIVE);
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  assert.equal(engine.setExplicit('s1', { mode: 'chat' }).ok, true);
  const forced = await engine.snapshot({ sessionId: 's1', message: '解释一下这个函数报错' });
  assert.equal(forced.mode, 'chat');
  engine.clearSession('s1');
  const auto = await engine.snapshot({ sessionId: 's1', message: '解释一下这个函数报错' });
  assert.equal(auto.mode, 'task');
});

test('配置 interactionMode 强制档位同样生效', async t => {
  const root = tempRoot(t);
  writeConfig(root, { ...ACTIVE, interactionMode: 'companion' });
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '这个报错怎么修' });
  assert.equal(snapshot.mode, 'companion');
  assert.equal(snapshot.profile, 'companion');
});

test('Session 上限是 LRU：超过 MAX_SESSIONS 后老的被淘汰', async t => {
  const root = tempRoot(t);
  writeConfig(root, ACTIVE);
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  for (let index = 0; index < MAX_SESSIONS + 20; index += 1) {
    await engine.snapshot({ sessionId: `s-${index}`, message: '嗯' });
  }
  assert.equal(engine.status().sessions, MAX_SESSIONS);
  // 淘汰是有效的：老会话重新出现时按新会话处理，不会累积。
  await engine.snapshot({ sessionId: 's-0', message: '嗯' });
  assert.equal(engine.status().sessions, MAX_SESSIONS);
});

test('模块黑名单来自配置：被禁的模块不出现在注入文本里', async t => {
  const root = tempRoot(t);
  writeConfig(root, { ...ACTIVE, modules: { disabled: ['style.anti-ai-chat', 'style.universal'] } });
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '今天吃了碗面' });
  assert.equal(snapshot.selectedModules.some(item => item.id === 'style.anti-ai-chat'), false);
  assert.ok(snapshot.skippedModules.some(item => item.id === 'style.anti-ai-chat' && item.reason === 'disabled'));
});

test('普通聊天永远不会被自动拉进 strict（即使配置写了 strict）', async t => {
  const root = tempRoot(t);
  writeConfig(root, { ...ACTIVE, thinkingMode: { chat: 'strict', companion: 'strict', roleplay: 'strict', task: 'strict' } });
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  const plain = await engine.snapshot({ sessionId: 's1', message: '早啊' });
  assert.equal(plain.thinkingMode, 'guided', '普通聊天强制 guided');
  const scene = await engine.snapshot({ sessionId: 's2', message: '「你回来了。」', history: [] });
  assert.equal(scene.thinkingMode, 'strict', '其它档位照配置走（strict 只影响注入的思考模块）');
});

test('structured 但 planner 未启用时降级为 guided，且不调用模型', async t => {
  const root = tempRoot(t);
  writeConfig(root, { ...ACTIVE, thinkingMode: { chat: 'structured', companion: 'guided', roleplay: 'structured', task: 'guided' } });
  let called = 0;
  const ctx = { get: () => { called += 1; return null; } };
  const engine = createPromptEngine({ root, ctx, env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '「你回来了。」' });
  assert.equal(snapshot.thinkingMode, 'structured');
  assert.equal(snapshot.planState, 'planner-not-enabled');
  assert.equal(called, 0, '没有 planner 就不该碰宿主 LLM');
});

test('planner 不可用时降级：snapshot 仍然产出模块文本，planState 说明原因', async t => {
  const root = tempRoot(t);
  writeConfig(root, {
    ...ACTIVE,
    thinkingMode: { chat: 'guided', companion: 'guided', roleplay: 'structured', task: 'guided' },
    planner: { enabled: true },
  });
  // 宿主没有 llm 服务：adapter 构造必然失败。
  const ctx = { get: () => undefined };
  const engine = createPromptEngine({ root, ctx, env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '「你回来了。」' });
  assert.match(snapshot.planState, /^degraded:/);
  assert.ok(snapshot.text.length > 0, '降级后仍然有模块文本');
  assert.equal(snapshot.plan, null);
});

test('auditReply 只产出统计：关闭时不统计，开启时不含原文', async t => {
  const root = tempRoot(t);
  const off = createPromptEngine({ root, env: {}, now: () => 1 });
  assert.equal(off.auditReply({ sessionId: 's1', text: '不是不爱，而是不敢。' }), null);

  writeConfig(root, ACTIVE);
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  await engine.snapshot({ sessionId: 's1', message: '早啊' });
  const report = engine.auditReply({ sessionId: 's1', text: '不是不爱，而是不敢。不是不想，而是不能。不是不会，而是不愿。' });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some(finding => finding.code === 'contrastive-template'));
  const status = engine.status();
  assert.equal(status.counters.lintRuns, 1);
  assert.equal(status.lint, 1);
  assert.equal(JSON.stringify(status).includes('不敢'), false, '诊断里没有原文');
});

test('status() 只含档位、计数与码，不含任何对话正文', async t => {
  const root = tempRoot(t);
  writeConfig(root, ACTIVE);
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  await engine.snapshot({ sessionId: 's1', message: '「你今天怎么回来得这么晚。」' });
  const status = engine.status();
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes('回来得这么晚'), false);
  assert.equal(status.mode, 'active');
  assert.equal(typeof status.counters.routes, 'number');
  assert.ok(Array.isArray(status.routes));
  assert.ok(status.routes[0].mode);
  assert.ok(status.routes[0].evidence.length >= 0);
});

test('配置坏掉时引擎仍然可用：mode=off，snapshot 返回空文本而不是抛错', async t => {
  const root = tempRoot(t);
  fs.writeFileSync(promptConfigFile(root), '{ not json', 'utf8');
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '早' });
  assert.equal(snapshot.text, '');
  assert.equal(engine.mode, 'off');
  assert.ok(engine.status().configError.length > 0);
});

test('dispose 之后不再产出任何文本', async t => {
  const root = tempRoot(t);
  writeConfig(root, ACTIVE);
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  const before = await engine.snapshot({ sessionId: 's1', message: '早' });
  assert.ok(before.text.length > 0);
  engine.dispose();
  const after = await engine.snapshot({ sessionId: 's1', message: '早' });
  assert.equal(after.text, '');
  assert.equal(after.planState, 'disposed');
  assert.equal(engine.status().sessions, 0);
});

test('historyFromSession 只取用户与助手文本，忽略 companion 快照消息', () => {
  const agent = {
    session: {
      log: [
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '「你回来了。」' }] } },
        { type: 'assistant/message', data: { content: [{ type: 'text', text: '「路上耽搁了。」' }] } },
        { type: 'user/message', data: { source: { kind: 'companion-memory' }, content: [{ type: 'text', text: '【当前用户身份绑定】…' }] } },
        { type: 'tool/call', data: {} },
      ],
    },
  };
  const history = historyFromSession(agent, 10);
  assert.deepEqual(history, [
    { role: 'user', text: '「你回来了。」' },
    { role: 'assistant', text: '「路上耽搁了。」' },
  ]);
  assert.deepEqual(historyFromSession({}, 10), []);
  assert.deepEqual(historyFromSession(null, 10), []);
});

test('historyFromSession 遵守 limit：只保留最近若干轮', () => {
  const log = Array.from({ length: 20 }, (_, index) => ({
    type: index % 2 ? 'assistant/message' : 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${index}句` }] },
  }));
  const history = historyFromSession({ session: { log } }, 4);
  assert.equal(history.length, 4);
  assert.equal(history.at(-1).text, '第19句');
});

test('latestUserText 取本轮用户原文，取不到返回空串', () => {
  const decision = {
    messages: [
      { source: { kind: 'user' }, content: [{ type: 'text', text: '第一句' }] },
      { source: { kind: 'companion-memory' }, content: [{ type: 'text', text: '快照' }] },
      { source: { kind: 'user' }, content: [{ type: 'text', text: '最后一句' }] },
    ],
  };
  assert.equal(latestUserText(decision), '最后一句');
  assert.equal(latestUserText({ messages: [] }), '');
  assert.equal(latestUserText(null), '');
});

test('describe() 暴露档位与配置摘要，不含提示词正文', async t => {
  const root = tempRoot(t);
  writeConfig(root, ACTIVE);
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  const described = engine.describe();
  assert.equal(described.mode, 'active');
  assert.equal(described.interactionMode, 'auto');
  assert.deepEqual({ ...described.budgets }, { chat: 600, companion: 800, roleplay: 1300, task: 500 });
  assert.equal(JSON.stringify(described).includes('【'), false);
});

test('每轮重读配置：改了文件下一次快照就生效，不必重启', async t => {
  const root = tempRoot(t);
  const engine = createPromptEngine({ root, env: {}, now: () => 1 });
  assert.equal(engine.mode, 'off');
  writeConfig(root, ACTIVE);
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '早' });
  assert.equal(engine.mode, 'active');
  assert.ok(snapshot.text.length > 0);
  writeConfig(root, { enabled: false, mode: 'off' });
  const after = await engine.snapshot({ sessionId: 's1', message: '早' });
  assert.equal(after.text, '');
  assert.equal(engine.mode, 'off');
});

/* ─────────────── Structured / Strict 的 Planner 路径（假宿主，不碰真模型） ─────────────── */

const VALID_PLAN_JSON = JSON.stringify({
  schemaVersion: 1,
  taskType: 'roleplay',
  intent: { goal: '接住他刚回来这件事', constraints: ['不要追问晚归原因'] },
  scene: { time: '深夜', location: '门口', participants: ['bot', 'user'], knownFacts: ['他刚回来'], unknowns: ['为什么这么晚'] },
  characters: [{ id: 'bot', intention: '先不追问', attitude: '克制', knowledgeBoundary: ['不知道他今晚去了哪'] }],
  operators: {
    DIG: { status: 'done', summary: '回应他的近况' },
    LORE: { status: 'done', summary: '深夜、门口' },
    ARC: { status: 'done', nextBeat: '把茶放在桌上' },
    REVIEW: { status: 'done', issues: [], corrections: [] },
  },
  styleProfile: 'roleplay-narrative',
  outputContract: { format: 'natural_prose' },
});

/**
 * 假的宿主 LLM 服务：只实现 host-llm.mjs 用到的那一小块协议。
 *
 * 这是**替身**，不是真模型：它证明 Planner 的编排、Schema 校验、降级与调用次数，
 * 不证明"模型能正确规划"。真实调用仍是 real-api 未验证项。
 */
function fakeLlm(replies) {
  const calls = [];
  const streams = [];
  const queue = Array.isArray(replies) ? replies.slice() : [replies];
  return {
    calls,
    streams,
    service: {
      prepareCall(config, _signal, controls) {
        const index = calls.length;
        calls.push({ config, reasoningEffort: typeof controls === 'function' ? controls({})?.reasoningEffort : undefined });
        const text = queue[Math.min(index, queue.length - 1)] ?? '';
        return Promise.resolve({
          config: { ...config },
          async *stream(options) {
            streams.push(options ?? {});
            yield { type: 'block-start', blockType: 'text' };
            yield { type: 'text-delta', text };
            yield { type: 'block-end', block: { type: 'text', text } };
            yield { type: 'finish', kind: 'done' };
          },
        });
      },
    },
  };
}

function plannerCtx(llm) {
  return {
    get(name) {
      if (name === 'llm') return llm.service;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) };
      return undefined;
    },
  };
}

const STRUCTURED = {
  ...ACTIVE,
  thinkingMode: { chat: 'guided', companion: 'guided', roleplay: 'structured', task: 'guided' },
  planner: { enabled: true, provider: 'fake-provider', model: 'fake-model', maxCallsPerTurn: 1 },
};

test('Structured：合法规划进入 Writer 指导，且只调用一次模型', async t => {
  const root = tempRoot(t);
  writeConfig(root, STRUCTURED);
  const { calls, service } = fakeLlm(VALID_PLAN_JSON);
  const engine = createPromptEngine({ root, ctx: plannerCtx({ service }), env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '「我回来了。」' });

  assert.equal(snapshot.thinkingMode, 'structured');
  assert.equal(snapshot.planState, 'planned');
  assert.equal(snapshot.plan.intent.goal, '接住他刚回来这件事');
  assert.equal(calls.length, 1, '每轮最多一次 Planner');
  assert.match(snapshot.text, /【本轮规划】/, '规划作为内部指导并入注入文本');
  assert.match(snapshot.text, /下一步 把茶放在桌上/);
  // 规划是内部产物：注入文本里不能出现裸 JSON 或围栏。
  assert.doesNotMatch(snapshot.text, /"schemaVersion"/);
  assert.doesNotMatch(snapshot.text, /```/);
});

test('Planner 调用带着独立 purpose 与独立 session 标识，且关掉隐藏重试', async t => {
  const root = tempRoot(t);
  writeConfig(root, { ...STRUCTURED, planner: { ...STRUCTURED.planner, maxCallsPerTurn: 2 } });
  const { calls, streams, service } = fakeLlm(VALID_PLAN_JSON);
  const engine = createPromptEngine({ root, ctx: plannerCtx({ service }), env: {}, now: () => 1 });
  await engine.snapshot({ sessionId: 'qq-dm-1', message: '「我回来了。」' });
  assert.equal(calls[0].config.maxTokens, 800, 'maxOutputTokens 被传给 prepareCall');
  assert.equal(engine.status().counters.plannerCalls, 1);
  assert.equal(engine.status().counters.plannerFailures, 0);
  // 一次预算 = 一次物理生成：适配器不许在背后重试。
  assert.equal(calls.length, 1, '关掉隐藏重试后只有一次物理生成');
  // 独立 purpose 与独立 session 标识（规划调用必须可归因，且不混进对话的 session）。
  assert.equal(streams[0].purpose, 'companion-prompt-plan');
  assert.equal(streams[0].sessionId, 'qq-dm-1:plan');
});

test('Structured：坏 JSON 会被一次格式修复救回来，调用上限为 2', async t => {
  const root = tempRoot(t);
  writeConfig(root, { ...STRUCTURED, planner: { ...STRUCTURED.planner, maxCallsPerTurn: 2 } });
  const { calls, service } = fakeLlm(['这不是 JSON', VALID_PLAN_JSON]);
  const engine = createPromptEngine({ root, ctx: plannerCtx({ service }), env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '「我回来了。」' });
  assert.equal(snapshot.planState, 'planned');
  assert.equal(calls.length, 2, '一次规划 + 一次格式修复');
});

test('Structured：两次都失败则降级 guided，正文照常生成，绝不多调', async t => {
  const root = tempRoot(t);
  writeConfig(root, { ...STRUCTURED, planner: { ...STRUCTURED.planner, maxCallsPerTurn: 2 } });
  const { calls, service } = fakeLlm(['还是不是 JSON', '依然不是']);
  const engine = createPromptEngine({ root, ctx: plannerCtx({ service }), env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '「我回来了。」' });
  assert.equal(calls.length, 2, '不会无限重试');
  assert.match(snapshot.planState, /^degraded:/);
  assert.equal(snapshot.plan, null);
  assert.ok(snapshot.text.length > 0, '降级后仍有模块文本，用户消息不会失败');
  assert.doesNotMatch(snapshot.text, /【本轮规划】/);
});

test('Structured：规划字段越界被截断后仍然可用', async t => {
  const root = tempRoot(t);
  writeConfig(root, STRUCTURED);
  const overflow = { ...JSON.parse(VALID_PLAN_JSON), intent: { goal: 'g'.repeat(2000), constraints: [] } };
  const { service } = fakeLlm(JSON.stringify(overflow));
  const engine = createPromptEngine({ root, ctx: plannerCtx({ service }), env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '「我回来了。」' });
  assert.equal(snapshot.planState, 'planned');
  assert.equal(snapshot.plan.intent.goal.length, 240);
});

test('Guided 档永不调用 Planner（即使 planner.enabled 为 true）', async t => {
  const root = tempRoot(t);
  writeConfig(root, { ...ACTIVE, planner: { enabled: true } });
  const { calls, service } = fakeLlm(VALID_PLAN_JSON);
  const engine = createPromptEngine({ root, ctx: plannerCtx({ service }), env: {}, now: () => 1 });
  const snapshot = await engine.snapshot({ sessionId: 's1', message: '早' });
  assert.equal(snapshot.planState, 'guided');
  assert.equal(calls.length, 0, '普通聊天不花第二次调用');
});

test('Strict 需要显式开启：配置 strict + planner 才会走规划，聊天档仍被压回 guided', async t => {
  const root = tempRoot(t);
  writeConfig(root, {
    ...ACTIVE,
    thinkingMode: { chat: 'strict', companion: 'guided', roleplay: 'strict', task: 'guided' },
    planner: { enabled: true, provider: 'fake-provider', model: 'fake-model', maxCallsPerTurn: 2 },
  });
  const { calls, service } = fakeLlm(VALID_PLAN_JSON);
  const engine = createPromptEngine({ root, ctx: plannerCtx({ service }), env: {}, now: () => 1 });
  const plain = await engine.snapshot({ sessionId: 's-chat', message: '早啊' });
  assert.equal(plain.thinkingMode, 'guided', '普通聊天不自动进 strict');
  const before = calls.length;
  const scene = await engine.snapshot({ sessionId: 's-scene', message: '「我回来了。」' });
  assert.equal(scene.thinkingMode, 'strict');
  assert.equal(scene.planState, 'planned');
  assert.equal(calls.length, before + 1, 'strict 也只调一次 Planner');
});
