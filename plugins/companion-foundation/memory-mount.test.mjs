import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Integration test for the upgraded memory backend at the host-plugin boundary:
// it mounts the real plugin with the real DSH tool definitions against a
// throwaway companion root, and drives the same entry points the desktop uses.

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const { resolveModuleRoot } = await import('./test-fixtures/module-root.mjs');
process.env.DSH_COMPANION_MODULE_ROOT = resolveModuleRoot(repositoryRoot).root;
const { mountCompanion } = await import('./index.mjs');
// The registry lives in the engine module instance the plugin imports, so the
// specifier (including the cache-busting query) must match the plugin's own import.
const { releaseSharedEngine, shareEngine, sharedEngineFor } = await import('../companion-memory/index.mjs?v=0.4.0');

const IMPORT_ARCHIVE = {
  manifest: { schemaVersion: 1, persona: '三月七', owner: '1429709395', bot: 'bot', exportedAt: '2026-10-25T00:00:00Z' },
  memories: [
    { id: 'astrbot:fact1', sourceId: 'fact1', key: 'core_memory', memoryType: 'core_memory', realityLevel: 'explicit_user_statement',
      value: '他作息偏晚，爱深夜来找我', evidence: '核心记忆块', persona: 'march7', owner: '1429709395', bot: 'bot',
      importance: 0.9, confidence: 1, occurredAt: '2026-10-24T13:44:02+00:00', updatedAt: '2026-10-24T13:44:02+00:00', tags: ['core_memory'] },
    { id: 'astrbot:pref1', sourceId: 'pref1', key: 'user_preference', memoryType: 'user_preference', realityLevel: 'real_user_fact',
      value: '凡博喜欢撒娇，希望Bot多给他发消息', evidence: '让我平时多给他发消息', persona: 'march7', owner: '1429709395', bot: 'bot',
      importance: 0.9, confidence: 0.9, occurredAt: '2026-08-21T05:23:48+00:00', updatedAt: '2026-08-21T05:23:48+00:00', tags: ['user_preference'] },
    { id: 'astrbot:pro1', sourceId: 'pro1', key: 'proactive_message', memoryType: 'proactive_message', realityLevel: 'bot_action',
      value: 'Bot 主动向 凡博 发送：夜深了，还有点闷。', evidence: 'Bot 主动发送', persona: 'march7', owner: '1429709395', bot: 'bot',
      importance: 0.566, confidence: 0.92, occurredAt: '2026-07-13T22:22:31+08:00', updatedAt: '2026-08-19T04:18:11+00:00', tags: ['proactive'] },
  ],
};

function buildRoot(t, { backend = 'sqlite', extraction = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-mount-'));
  for (const dir of ['workspace', 'logs', 'home/memory', 'home/companion']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'march7',
    owner: { id: '1429709395', displayName: '槑', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: '1429709395' },
    sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), '# 三月七\n\n测试用角色正文。\n');
  fs.writeFileSync(path.join(root, 'home/memory/astrbot-import.json'), JSON.stringify(IMPORT_ARCHIVE));
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1,
    backend,
    injection: { budgetChars: 2400 },
    extraction: { enabled: extraction, minMessages: 3, maxMessages: 20 },
    embedding: { provider: 'local', dimensions: 128 },
    wiki: { enabled: true, dir: 'home/memory/wiki', autoCompile: true, minIntervalMs: 0 },
  }));
  return root;
}

function mount(t, root, { llm = null } = {}) {
  const tools = new Map();
  const hooks = new Map();
  const internals = mountCompanion({
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {} },
    on(name, handler) { hooks.set(name, handler); },
    // Mimic the host registry lookups the adapter uses (ctx.get instead of ctx.llm,
    // and the default-model service for the route).
    get(name) {
      if (name === 'llm') return llm ?? undefined;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) };
      return undefined;
    },
    ...(llm ? { llm } : {}),
  }, root);
  // SQLite keeps a file handle open; close it before the temp tree is removed.
  t.after(async () => {
    try { await internals.engine.close(); } catch { /* already closed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  });
  return { tools, hooks, internals };
}

const exec = sessionId => ({ agent: { session: { id: sessionId } } });

test('sqlite backend mounts, migrates nothing by itself, and exposes the new tools', async t => {
  const root = buildRoot(t);
  const { tools, internals } = mount(t, root);
  assert.equal(internals.backend, 'sqlite');
  await internals.engine.initialize();
  const expected = ['companion_status', 'companion_identity', 'companion_recall', 'companion_remember',
    'companion_recent_events', 'companion_record_event', 'companion_wiki_index', 'companion_wiki_get',
    'companion_memory_pending', 'companion_memory_extract', 'companion_memory_forget', 'companion_memory_rebuild'];
  for (const name of expected) assert.ok(tools.has(name), `missing tool ${name}`);
  assert.equal(tools.get('companion_remember').name, 'companion_remember');
});

test('remember then recall works across sessions and returns a receipt', async t => {
  const root = buildRoot(t);
  const { tools, internals } = mount(t, root);
  await internals.engine.initialize();
  const saved = JSON.parse(await tools.get('companion_remember').execute({ key: '饮品偏好', value: '更喜欢喝茶' }, exec('session-a')));
  assert.equal(saved.ok, true);
  assert.match(saved.receipt.id, /^mem_/);
  const recalled = JSON.parse(await tools.get('companion_recall').execute({ query: '我喜欢喝什么', limit: 5 }, exec('session-b')));
  assert.ok(recalled.entries.some(entry => String(entry.value ?? '').includes('喝茶')), JSON.stringify(recalled).slice(0, 400));
  const corrected = JSON.parse(await tools.get('companion_remember').execute({ key: '饮品偏好', value: '现在改喜欢咖啡' }, exec('session-b')));
  assert.equal(corrected.ok, true);
  const afterCorrection = JSON.parse(await tools.get('companion_recall').execute({ query: '我喜欢喝什么', limit: 5 }, exec('session-a')));
  const values = afterCorrection.entries.map(entry => String(entry.value ?? ''));
  assert.ok(values.some(value => value.includes('咖啡')), values.join(' | '));
  assert.ok(!values.some(value => value.includes('更喜欢喝茶')), values.join(' | '));
});

test('first-step injection stays inside the budget and carries the identity section', async t => {
  const root = buildRoot(t);
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  await internals.engine.remember({ sessionId: 'session-a', key: '工作', value: '用户在做独立开发' });
  const decision = { kind: 'enter', startsRequestSeries: true, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '你还记得我吗' }] }] };
  const event = { agent: { session: { id: 'session-a' } }, step: 1, signal: new AbortController().signal };
  const entered = await hooks.get('agent/pre-step')(event, async () => decision);
  assert.equal(entered.messages.length, 2);
  const injected = entered.messages[1].content[0].text;
  assert.match(injected, /当前用户身份绑定/);
  assert.ok(injected.length < 3200, `injected ${injected.length} chars`);
  const second = await hooks.get('agent/pre-step')({ ...event, step: 2 }, async () => decision);
  assert.equal(second.messages.length, 1);
});

test('session events are captured once and injected material is ignored', async t => {
  const root = buildRoot(t);
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  const capture = hooks.get('session/event');
  const userMessage = { type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天去公园了，想喝点热茶' }] } };
  await capture({ id: 'session-a' }, userMessage);
  await capture({ id: 'session-a' }, userMessage);
  await capture({ id: 'session-a' }, { type: 'user/message', seq: 2, time: Date.now(), data: { source: { kind: 'companion-memory' }, content: [{ type: 'text', text: '注入的记忆材料不应该被二次捕获' }] } });
  const status = await internals.engine.status({ sessionId: 'session-a' });
  assert.equal(status.stats.events, 1);
});

test('wiki compiles from confirmed facts and index excludes the index page', async t => {
  const root = buildRoot(t);
  const { tools, internals } = mount(t, root);
  await internals.engine.initialize();
  await internals.engine.remember({ sessionId: 'session-a', key: '工作', value: '用户在杭州做独立开发' });
  const compiled = await internals.engine.compileWiki({ sessionId: 'session-a', force: true });
  assert.equal(compiled.ok, true);
  const profile = path.join(root, 'home/memory/wiki/user/profile.md');
  assert.ok(fs.existsSync(profile));
  assert.match(fs.readFileSync(profile, 'utf8'), /独立开发/);
  const listed = JSON.parse(await tools.get('companion_wiki_index').execute({}, exec('session-a')));
  assert.ok(listed.pages.every(page => page.scope !== 'system'));
  assert.ok(listed.topics.length >= 4);
  const page = JSON.parse(await tools.get('companion_wiki_get').execute({ topicId: 'user-profile' }, exec('session-a')));
  assert.equal(page.ok, true);
});

test('forget retracts without deleting evidence and status reports the backend', async t => {
  const root = buildRoot(t);
  const { tools, internals } = mount(t, root);
  await internals.engine.initialize();
  const saved = JSON.parse(await tools.get('companion_remember').execute({ key: '临时事实', value: '这条之后会被撤回' }, exec('session-a')));
  const forgot = JSON.parse(await tools.get('companion_memory_forget').execute({ id: saved.receipt.id, reason: 'test' }, exec('session-a')));
  assert.equal(forgot.ok, true);
  const recalled = JSON.parse(await tools.get('companion_recall').execute({ query: '撤回', limit: 5 }, exec('session-a')));
  assert.ok(!(recalled.entries ?? []).some(entry => String(entry.value ?? '').includes('之后会被撤回')));
  const status = JSON.parse(await tools.get('companion_status').execute({}, exec('session-a')));
  assert.equal(status.memory.backend, 'sqlite');
  assert.ok(status.memory.stats.memories >= 1);
});

test('a broken database degrades to legacy instead of failing the turn', async t => {
  const root = buildRoot(t);
  const dbFile = path.join(root, 'home/memory/companion-memory.db');
  fs.writeFileSync(dbFile, 'this is not a sqlite database');
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  assert.equal(internals.engine.backend, 'legacy');
  const decision = { kind: 'enter', startsRequestSeries: true, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }] };
  const event = { agent: { session: { id: 'session-a' } }, step: 1, signal: new AbortController().signal };
  const entered = await hooks.get('agent/pre-step')(event, async () => decision);
  assert.equal(entered.messages.length, 2);
  assert.match(entered.messages[1].content[0].text, /当前用户身份绑定/);
});

test('legacy backend keeps the previous tool surface', async t => {
  const root = buildRoot(t, { backend: 'legacy' });
  const { tools, internals } = mount(t, root);
  assert.equal(internals.backend, 'legacy');
  await internals.engine.initialize();
  assert.equal(tools.has('companion_wiki_get'), false);
  const recalled = JSON.parse(await tools.get('companion_recall').execute({ query: '撒娇', limit: 3 }, exec('session-a')));
  assert.ok(Array.isArray(recalled));
  assert.ok(recalled.some(entry => String(entry.value).includes('撒娇')));
});

// A fake host `llm` service that streams a JSON candidate array. The candidate
// echoes the real evidence id parsed out of the extraction prompt, so this test
// covers adapter -> extractBatch -> gate -> jobs -> store without a network call.
function fakeHostLlm({ value = '用户更喜欢喝热茶', seen = [] } = {}) {
  return {
    async prepareCall(config) {
      return {
        config,
        stream: async function* (options) {
          seen.push({ sessionId: options?.sessionId, purpose: options?.purpose, hasSystem: Boolean(options?.system) });
          const prompt = (options?.messages ?? []).flatMap(message => message.content ?? [])
            .filter(part => part.type === 'text').map(part => part.text).join('\n');
          const match = prompt.match(/\[id=([^\]]+)\]/);
          const evidenceId = match ? match[1] : '';
          const payload = JSON.stringify([{
            kind: 'preference',
            scope: 'user_global',
            subject: 'user',
            predicate: 'prefers_drink',
            value,
            evidence_source_ids: [evidenceId],
            confidence: 0.9,
            importance: 0.8,
            validity: 'current',
            suggested_operation: 'upsert',
            mention_policy: 'direct',
          }]);
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: payload };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } };
          yield { type: 'finish', reason: 'stop' };
        },
      };
    },
  };
}

test('explicit extraction runs end to end with a host-like model and stores evidence', async t => {
  const root = buildRoot(t);
  const seen = [];
  const { tools, hooks, internals } = mount(t, root, { llm: fakeHostLlm({ seen }) });
  await internals.engine.initialize();
  const capture = hooks.get('session/event');
  for (let seq = 1; seq <= 3; seq++) {
    await capture({ id: 'session-a' }, { type: 'user/message', seq, time: Date.now(),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: seq === 1 ? '我平时更喜欢喝热茶' : `随便聊聊第${seq}句` }] } });
  }
  const result = JSON.parse(await tools.get('companion_memory_extract').execute({}, exec('session-a')));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok((result.processed ?? 0) >= 1, JSON.stringify(result));
  // The provider rejects a request without a session id header, so the adapter
  // must always send one even for a background call.
  assert.ok(seen.length >= 1, 'the fake model must have been called');
  for (const call of seen) {
    assert.equal(typeof call.sessionId, 'string');
    assert.ok(call.sessionId.length > 0, 'session id must be present');
    assert.equal(call.purpose, 'companion-memory-extract');
  }
  const recalled = JSON.parse(await tools.get('companion_recall').execute({ query: '喜欢喝什么', limit: 5 }, exec('session-a')));
  assert.ok((recalled.entries ?? []).some(entry => String(entry.value).includes('热茶')), JSON.stringify(recalled).slice(0, 500));
  const status = JSON.parse(await tools.get('companion_status').execute({}, exec('session-a')));
  assert.ok(status.memory.stats.confirmedMemories >= 1);
  assert.equal(status.memory.jobs.done >= 1, true, JSON.stringify(status.memory.jobs));
});

test('background extraction batches captured messages and stores them on its own', async t => {
  const root = buildRoot(t, { extraction: true });
  const { hooks, internals } = mount(t, root, { llm: fakeHostLlm() });
  await internals.engine.initialize();
  const capture = hooks.get('session/event');
  for (let seq = 1; seq <= 6; seq++) {
    await capture({ id: 'session-a' }, { type: 'user/message', seq, time: Date.now(),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: seq === 1 ? '我平时更喜欢喝热茶' : `随便聊聊第${seq}句` }] } });
  }
  // Wait for the fire-and-forget batch + drain triggered by capture.
  const deadline = Date.now() + 8000;
  let status = await internals.engine.status({ sessionId: 'session-a' });
  while (Date.now() < deadline && status.stats.confirmedMemories < 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    status = await internals.engine.status({ sessionId: 'session-a' });
  }
  assert.ok(status.stats.confirmedMemories >= 1, JSON.stringify(status.stats));
  assert.ok(status.jobs.done >= 1, JSON.stringify(status.jobs));
});

// The Studio bundle opens the process-wide engine first; a preset session that
// mounts later must reuse that instance instead of opening a second SQLite
// writer and a second extraction drainer.
test('a preset reuses the engine registered by the studio half', async t => {
  const root = buildRoot(t);
  const fakeEngine = {
    backend: 'sqlite',
    config: { backend: 'sqlite', extraction: { enabled: false, minMessages: 3 } },
    initialize: async () => ({ backend: 'sqlite' }),
    close: async () => {},
    status: async () => ({ backend: 'sqlite' }),
    contextFor: async () => '',
    capture: () => ({ captured: false }),
  };
  shareEngine(root, fakeEngine);
  t.after(() => releaseSharedEngine(root, fakeEngine));

  const tools = new Map();
  const internals = mountCompanion({
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {} },
    on() {},
    get: () => undefined,
  }, root);
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

  assert.equal(internals.engine, fakeEngine, 'preset must not create a second engine');
  assert.equal(sharedEngineFor(root), fakeEngine, 'the registry keeps the studio instance');
  assert.ok(tools.size > 0, 'tools are still registered on the preset engine');
});

