import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 宿主边界测试：用真实 foundation 挂载真实的 Prompt Engine，跑与桌面同一条 `agent/pre-step`，
// 不接真模型、不接真通道。要证明的是"接线对、默认不变、失败不致命"，不是"模型写得好"。

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const { resolveModuleRoot } = await import('./test-fixtures/module-root.mjs');
const { root: moduleRoot } = resolveModuleRoot(repositoryRoot);
process.env.DSH_COMPANION_MODULE_ROOT = moduleRoot;
const { mountCompanion } = await import('./index.mjs');

function buildRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-prompt-'));
  for (const dir of ['workspace', 'logs', 'home/memory', 'home/companion', 'home/channel-qq']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), '# 测试人格\n\n这是测试用的人设正文。\n');
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite',
    injection: { budgetChars: 2400 },
    extraction: { enabled: false, minMessages: 3, maxMessages: 20 },
    embedding: { provider: 'local', dimensions: 128 },
    wiki: { enabled: false, dir: 'home/memory/wiki', autoCompile: false, minIntervalMs: 0 },
  }));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

function writePromptConfig(root, value) {
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/prompt-engine.config.json'), JSON.stringify(value), 'utf8');
}

function mount(t, root) {
  const sections = [];
  const hooks = new Map();
  const internals = mountCompanion({
    tools: { register() {} },
    systemPrompt: { section(value) { sections.push(value); } },
    on(name, handler) { hooks.set(name, handler); },
    get() { return undefined; },
  }, root);
  t.after(async () => {
    try { internals.promptEngine?.dispose(); } catch { /* already closed */ }
    try { internals.cognitive?.dispose(); } catch { /* already closed */ }
    try { await internals.engine.close(); } catch { /* already closed */ }
  });
  return { sections, hooks, internals };
}

const decision = text => ({ kind: 'enter', startsRequestSeries: true, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }] });
const stepEvent = (sessionId, step = 1) => ({ agent: { session: { id: sessionId } }, step, signal: new AbortController().signal });

async function preStep(hooks, sessionId, text, step = 1) {
  const entered = await hooks.get('agent/pre-step')(stepEvent(sessionId, step), async () => decision(text));
  const snapshot = entered.messages.at(-1);
  const sections = snapshot?.source?.sections ?? [];
  return { entered, snapshot, sections, text: snapshot?.content?.[0]?.text ?? '' };
}

test('默认关闭：不注册 prompt-contract，也不追加任何 prompt 内容', async t => {
  const root = buildRoot(t);
  const { sections, hooks, internals } = mount(t, root);
  await internals.engine.initialize();

  assert.equal(internals.promptEngine.mode, 'off');
  assert.equal(sections.some(section => section.name === 'companion:prompt-contract'), false, '关闭时不注册静态 Section');

  const entered = await preStep(hooks, 'session-a', '你好');
  assert.equal(entered.sections.some(section => section.name === 'companion-prompt-profile'), false, '关闭时没有 prompt section');
  assert.match(entered.text, /当前用户身份绑定/, '原有身份注入不变');
  assert.doesNotMatch(entered.text, /【本轮写法】/, '没有任何 prompt 模块文本');
});

test('active 模式：新增独立 section，原有身份/记忆注入保持原样且不抢预算', async t => {
  const root = buildRoot(t);
  writePromptConfig(root, { enabled: true, mode: 'active' });

  // 先测关闭态拿到基线，再测开启态，确保原有段落一字不差。
  const baselineRoot = buildRoot(t);
  const baseline = mount(t, baselineRoot);
  await baseline.internals.engine.initialize();
  const before = await preStep(baseline.hooks, 'session-a', '今天吃了碗面');

  const { sections, hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  assert.equal(internals.promptEngine.mode, 'active');
  assert.equal(sections.some(section => section.name === 'companion:prompt-contract'), true, '开启时注册静态契约 Section');
  const contract = sections.find(section => section.name === 'companion:prompt-contract');
  assert.equal(contract.order, 65, 'order 按任务书 §9 建议取 65');
  // 契约 Section 是惰性文本（配置关闭时返回空串），所以按宿主的方式求值再断言。
  const contractText = typeof contract.text === 'function' ? contract.text({}) : contract.text;
  assert.ok(typeof contractText === 'string' && contractText.length > 0, '开启时契约文本非空');
  assert.ok(contractText.length <= 420, `契约正文 ${contractText.length} 字`);
  assert.doesNotMatch(contractText, /白描|环境描写/, '契约只解释模块规则，不含具体风格内容');
  assert.match(contractText, /动态写法模块/);

  const after = await preStep(hooks, 'session-a', '今天吃了碗面');
  const identityBefore = before.sections.find(section => section.name === 'companion-identity');
  const identityAfter = after.sections.find(section => section.name === 'companion-identity');
  assert.deepEqual(identityAfter, identityBefore, '身份注入一字不差');

  const prompt = after.sections.find(section => section.name === 'companion-prompt-profile');
  assert.ok(prompt, 'prompt section 被追加');
  assert.ok(prompt.text.length > 0);
  assert.match(prompt.text, /【本轮写法】/);

  // Prompt 有自己的预算：它排在最后，memory 段落长度与关闭态一致。
  const memoryBefore = before.sections.find(section => section.name === 'companion-memory');
  const memoryAfter = after.sections.find(section => section.name === 'companion-memory');
  assert.deepEqual(memoryAfter ?? null, memoryBefore ?? null, '记忆段落不受 Prompt Engine 影响');
  assert.ok(after.text.endsWith(prompt.text), 'prompt 文本拼在快照末尾');
});

test('shadow 模式：路由照跑，但消息内容与关闭态完全一致', async t => {
  const root = buildRoot(t);
  writePromptConfig(root, { enabled: true, mode: 'shadow' });
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  const entered = await preStep(hooks, 'session-a', '「你回来了。」');
  assert.equal(entered.sections.some(section => section.name === 'companion-prompt-profile'), false);
  assert.doesNotMatch(entered.text, /【本轮写法】/);
  assert.ok(internals.promptEngine.status().counters.shadowed >= 1, 'shadow 模式下确实算了');
});

test('只在第 1 步注入：后续 step 不重复追加', async t => {
  const root = buildRoot(t);
  writePromptConfig(root, { enabled: true, mode: 'active' });
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  const first = await preStep(hooks, 'session-a', '早', 1);
  assert.equal(first.entered.messages.length, 2, '第一步追加一份快照');
  const second = await preStep(hooks, 'session-a', '继续', 2);
  assert.equal(second.entered.messages.length, 1, '第 2 步不注入');
});

test('reject 与 aborted 保持原有行为：不注入、不报错', async t => {
  const root = buildRoot(t);
  writePromptConfig(root, { enabled: true, mode: 'active' });
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  const rejected = await hooks.get('agent/pre-step')(stepEvent('session-a'), async () => ({ kind: 'reject' }));
  assert.deepEqual(rejected, { kind: 'reject' });

  const controller = new AbortController();
  controller.abort();
  const aborted = await hooks.get('agent/pre-step')({ agent: { session: { id: 'session-a' } }, step: 1, signal: controller.signal }, async () => decision('早'));
  assert.equal(aborted.messages.length, 1);
});

test('RP 场景会切换 profile；不同 session 互不影响', async t => {
  const root = buildRoot(t);
  writePromptConfig(root, { enabled: true, mode: 'active' });
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();

  const scene = await preStep(hooks, 'session-a', '「你今天怎么回来得这么晚。」');
  const chat = await preStep(hooks, 'session-b', '今天吃了碗面');
  const sceneText = scene.sections.find(section => section.name === 'companion-prompt-profile').text;
  const chatText = chat.sections.find(section => section.name === 'companion-prompt-profile').text;

  assert.match(chatText, /【闲聊】/);
  assert.doesNotMatch(chatText, /【叙事】/);
  assert.doesNotMatch(chatText, /白描/);
  assert.match(sceneText, /【轻量叙事】/, '单条场景暗示只到轻度沉浸');
  assert.doesNotMatch(sceneText, /白描/, '轻度沉浸不含白描规则');
});

test('群聊会话不会拿到主人私聊的 prompt 状态，也不会因为群聊改变私聊', async t => {
  const root = buildRoot(t);
  writePromptConfig(root, { enabled: true, mode: 'active' });
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();

  // 主人私聊先把场景建立起来。
  await preStep(hooks, 'desktop-owner', '「你回来了。」');
  const ownerState = internals.promptEngine.status().routes.find(item => item.sessionId === 'desktop-owner');
  assert.ok(ownerState);
  assert.equal(ownerState.mode, 'roleplay');

  // 群聊是另一个 session：拿不到私聊的模式，也不会互相串档。
  // （群聊 preset 用独立的 group session id 前缀，这里用同样的形状。）
  const group = await preStep(hooks, 'group-12345', '大家好');
  const groupPrompt = group.sections.find(section => section.name === 'companion-prompt-profile');
  assert.ok(groupPrompt, '群聊有自己的一份 prompt 段落');
  const groupStatus = internals.promptEngine.status().routes.find(item => item.sessionId === 'group-12345');
  assert.equal(groupStatus.mode, 'chat', '群聊不会被私聊的 RP 状态带进 roleplay');
  assert.equal(internals.promptEngine.status().routes.find(item => item.sessionId === 'desktop-owner').mode, ownerState.mode);
});

test('Prompt Engine 崩溃不影响聊天：engine 抛错时该轮仍然正常返回', async t => {
  const root = buildRoot(t);
  writePromptConfig(root, { enabled: true, mode: 'active' });
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  // 直接把内部快照打成故障，模拟任何未预料的异常。
  internals.promptEngine.snapshot = async () => { throw new Error('boom'); };
  const entered = await preStep(hooks, 'session-a', '你好');
  assert.match(entered.text, /当前用户身份绑定/);
  assert.equal(entered.sections.some(section => section.name === 'companion-prompt-profile'), false);
});

test('运行时数据库坏掉时，Prompt Engine 仍然工作（两条链路互不牵连）', async t => {
  const root = buildRoot(t);
  writePromptConfig(root, { enabled: true, mode: 'active' });
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({ enabled: true, mode: 'active' }));
  fs.mkdirSync(path.join(root, 'home/companion/companion-runtime.db'), { recursive: true });
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  assert.equal(internals.cognitive.mode, 'off', 'runtime 因为数据库不可用而关闭');
  const entered = await preStep(hooks, 'session-a', '今天吃了碗面');
  const prompt = entered.sections.find(section => section.name === 'companion-prompt-profile');
  assert.ok(prompt, 'Prompt Engine 不受 runtime 故障影响');
  assert.ok(prompt.text.length > 0);
});

test('Prompt Engine 不写任何记忆：注入前后记忆库事件数不变', async t => {
  const root = buildRoot(t);
  writePromptConfig(root, { enabled: true, mode: 'active' });
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  const before = await internals.engine.status({ sessionId: 'session-a' });
  await preStep(hooks, 'session-a', '「虚构剧情：她把钥匙放在桌上。」');
  const after = await internals.engine.status({ sessionId: 'session-a' });
  assert.equal(after.stats.events, before.stats.events, 'pre-step 不产生记忆事件');
});

test('配置关闭后再次挂载：既不注册 Section，也不追加内容', async t => {
  const root = buildRoot(t);
  writePromptConfig(root, { enabled: false, mode: 'active' });
  const { sections, hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  assert.equal(internals.promptEngine.mode, 'off');
  assert.equal(sections.some(section => section.name === 'companion:prompt-contract'), false);
  const entered = await preStep(hooks, 'session-a', '早');
  assert.equal(entered.sections.some(section => section.name === 'companion-prompt-profile'), false);
});

test('返回的 mount 结果仍然暴露原有句柄（engine / cognitive / agenda）', async t => {
  const root = buildRoot(t);
  const { internals } = mount(t, root);
  await internals.engine.initialize();
  assert.ok(internals.engine);
  assert.ok(internals.identity);
  assert.ok(internals.agenda);
  assert.equal(typeof internals.promptEngine.snapshot, 'function');
});
