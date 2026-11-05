import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Host-boundary test for the P1 cognitive integration: it mounts the real
// foundation plugin with the real tool definitions against a throwaway companion
// root and drives the same hooks the desktop uses. No real model, no real channel.

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const { resolveModuleRoot } = await import('./test-fixtures/module-root.mjs');
const { root: moduleRoot, source: moduleRootSource } = resolveModuleRoot(repositoryRoot);
process.env.DSH_COMPANION_MODULE_ROOT = moduleRoot;
if (moduleRootSource !== 'runtime.local.json') console.log(`[cognitive-mount] host modules from ${moduleRootSource}: ${moduleRoot}`);
const { mountCompanion } = await import('./index.mjs');

function buildRoot(t, { runtime = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-cognitive-'));
  for (const dir of ['workspace', 'logs', 'home/memory', 'home/companion', 'home/channel-qq']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'bot',
    owner: { id: '10001', displayName: '测试', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: '10001' },
    sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), '# bot\n\n测试用角色正文。\n');
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite',
    injection: { budgetChars: 2400 },
    extraction: { enabled: false, minMessages: 3, maxMessages: 20 },
    embedding: { provider: 'local', dimensions: 128 },
    wiki: { enabled: false, dir: 'home/memory/wiki', autoCompile: false, minIntervalMs: 0 },
  }));
  if (runtime) fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify(runtime));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

function mount(t, root) {
  const tools = new Map();
  const hooks = new Map();
  const internals = mountCompanion({
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {} },
    on(name, handler) { hooks.set(name, handler); },
    get() { return undefined; },
  }, root);
  t.after(async () => {
    try { internals.cognitive?.dispose(); } catch { /* already closed */ }
    try { await internals.engine.close(); } catch { /* already closed */ }
  });
  return { tools, hooks, internals };
}

const decision = text => ({ kind: 'enter', startsRequestSeries: true, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }] });
const stepEvent = (sessionId, step = 1) => ({ agent: { session: { id: sessionId } }, step, signal: new AbortController().signal });
const exec = sessionId => ({ agent: { session: { id: sessionId } } });

test('with no runtime config the cognitive layer stays off and injection is unchanged', async t => {
  const root = buildRoot(t);
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  assert.equal(internals.cognitive.mode, 'off');
  const entered = await hooks.get('agent/pre-step')(stepEvent('session-a'), async () => decision('你好'));
  const injected = entered.messages[1].content[0].text;
  assert.match(injected, /当前用户身份绑定/);
  assert.doesNotMatch(injected, /认知连续性|工作记忆/);
  assert.equal(entered.messages[1].source.sections.some(section => section.name === 'companion-working-memory'), false);
});

test('active mode injects a bounded working memory section and keeps the memory budget', async t => {
  const root = buildRoot(t, { runtime: { enabled: true, mode: 'active', injection: { budgetChars: 320 } } });
  const { tools, hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  assert.equal(internals.cognitive.mode, 'active');

  const proposed = JSON.parse(await tools.get('companion_goal_propose').execute({ title: '修屋顶', nextStep: '联系师傅' }, exec('session-a')));
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const [goal] = JSON.parse(await tools.get('companion_goal_list').execute({}, exec('session-a'))).goals;
  const accepted = JSON.parse(await tools.get('companion_goal_transition').execute({ goalId: goal.goalId, to: 'accepted', expectedRevision: goal.revision }, exec('session-a')));
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const started = JSON.parse(await tools.get('companion_goal_transition').execute({ goalId: goal.goalId, to: 'started', expectedRevision: goal.revision + 1 }, exec('session-a')));
  assert.equal(started.ok, true, JSON.stringify(started));

  const entered = await hooks.get('agent/pre-step')(stepEvent('session-a'), async () => decision('我们刚才说到哪了'));
  const sections = entered.messages[1].source.sections;
  const cognitive = sections.find(section => section.name === 'companion-working-memory');
  assert.ok(cognitive, 'the working memory section is injected');
  assert.match(cognitive.text, /修屋顶/);
  assert.ok(cognitive.text.length <= 320, `cognitive section ${cognitive.text.length} chars`);
  const total = entered.messages[1].content[0].text.length;
  assert.ok(total <= 2400, `total injection ${total} chars`);

  const second = await hooks.get('agent/pre-step')(stepEvent('session-a', 2), async () => decision('继续'));
  assert.equal(second.messages.length, 1, 'only the first step injects');
});

test('goal tools report lifecycle state and reject stale revisions instead of overwriting', async t => {
  const root = buildRoot(t, { runtime: { enabled: true, mode: 'active' } });
  const { tools, internals } = mount(t, root);
  await internals.engine.initialize();
  await tools.get('companion_goal_propose').execute({ title: '整理资料', nextStep: '列清单' }, exec('session-a'));
  const listed = JSON.parse(await tools.get('companion_goal_list').execute({}, exec('session-a')));
  assert.equal(listed.goals.length, 1);
  const goal = listed.goals[0];

  const accepted = JSON.parse(await tools.get('companion_goal_transition').execute({ goalId: goal.goalId, to: 'accepted', expectedRevision: goal.revision }, exec('session-a')));
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const started = JSON.parse(await tools.get('companion_goal_transition').execute({ goalId: goal.goalId, to: 'started', expectedRevision: goal.revision + 1 }, exec('session-a')));
  assert.equal(started.ok, true, JSON.stringify(started));
  const stale = JSON.parse(await tools.get('companion_goal_transition').execute({ goalId: goal.goalId, to: 'paused', expectedRevision: goal.revision }, exec('session-a')));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-revision');
  const after = JSON.parse(await tools.get('companion_goal_list').execute({}, exec('session-a')));
  assert.equal(after.goals[0].status, 'running');
});

test('the suite also runs on bundled host stubs when the desktop app is unavailable', async t => {
  const { spawn } = await import('node:child_process');
  const { fixturesRoot } = await import('./test-fixtures/module-root.mjs');
  const root = buildRoot(t);
  const script = `
    import { pathToFileURL } from 'node:url';
    const { mountCompanion } = await import(pathToFileURL(process.env.FOUNDATION_ENTRY).href);
    const internals = mountCompanion({ tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } }, process.env.MOUNT_ROOT);
    if (!internals || internals.backend !== 'sqlite') throw new Error('mount did not start');
    const tools = [];
    mountCompanion({ tools: { register(tool) { tools.push(tool.name); } }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } }, process.env.MOUNT_ROOT);
    if (!tools.includes('companion_runtime_status')) throw new Error('cognitive tools missing: ' + tools.join(','));
    process.exit(0);
  `;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        DSH_COMPANION_MODULE_ROOT: fixturesRoot(),
        FOUNDATION_ENTRY: path.join(repositoryRoot, 'plugins/companion-foundation/index.mjs'),
        MOUNT_ROOT: root,
        NODE_NO_WARNINGS: '1',
      },
      stdio: 'ignore',
    });
    child.on('exit', resolve);
    child.on('error', reject);
  });
  assert.equal(code, 0, 'foundation mounts with the bundled host stand-ins');
});

test('a broken runtime database never breaks the chat turn or the memory injection', async t => {
  const root = buildRoot(t, { runtime: { enabled: true, mode: 'active' } });
  // Point the runtime database at a directory so opening it must fail.
  fs.mkdirSync(path.join(root, 'home/companion/companion-runtime.db'), { recursive: true });
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  const entered = await hooks.get('agent/pre-step')(stepEvent('session-b'), async () => decision('你好'));
  const injected = entered.messages[1].content[0].text;
  assert.match(injected, /当前用户身份绑定/);
  assert.equal(internals.cognitive.mode, 'off');
  const status = internals.cognitive.status({ sessionId: 'session-b' });
  assert.ok(status.errors.some(error => error.code === 'db-unavailable'), JSON.stringify(status.errors));
});

test('session events still reach memory while the cognitive layer observes them best effort', async t => {
  const root = buildRoot(t, { runtime: { enabled: true, mode: 'active' } });
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  const capture = hooks.get('session/event');
  const message = { type: 'user/message', seq: 1, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天去公园了' }] } };
  await capture({ id: 'session-a' }, message);
  const status = await internals.engine.status({ sessionId: 'session-a' });
  assert.equal(status.stats.events, 1, 'memory capture still works');
  const runtimeStatus = internals.cognitive.status({ sessionId: 'session-a' });
  assert.ok(runtimeStatus.eventCount >= 1, 'the impulse event was recorded');

  // A broken cognitive layer must not swallow the memory capture.
  internals.cognitive.setMemory(null);
  await capture({ id: 'session-a' }, { ...message, seq: 2 });
  const after = await internals.engine.status({ sessionId: 'session-a' });
  assert.equal(after.stats.events, 2);
});

test('N3: the pre-step rebinds a reloaded memory engine instead of using a dead handle', async t => {
  const root = buildRoot(t, { runtime: { enabled: true, mode: 'active' } });
  const { tools, hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  await tools.get('companion_goal_propose').execute({ title: '修屋顶', nextStep: '联系师傅' }, exec('session-a'));
  const [goal] = JSON.parse(await tools.get('companion_goal_list').execute({}, exec('session-a'))).goals;
  await tools.get('companion_goal_transition').execute({ goalId: goal.goalId, to: 'accepted', expectedRevision: goal.revision }, exec('session-a'));
  await tools.get('companion_goal_transition').execute({ goalId: goal.goalId, to: 'started', expectedRevision: goal.revision + 1 }, exec('session-a'));

  // Simulate a Studio reload that invalidated the engine reference the runtime held.
  internals.cognitive.setMemory(null);
  assert.equal(internals.cognitive.status({ sessionId: 'session-a' }).memory.available, false);

  const entered = await hooks.get('agent/pre-step')(stepEvent('session-a'), async () => decision('继续'));
  const section = entered.messages[1].source.sections.find(item => item.name === 'companion-working-memory');
  assert.ok(section, 'the engine is re-bound and working memory is injected again');
  assert.match(section.text, /修屋顶/);
  assert.equal(internals.cognitive.status({ sessionId: 'session-a' }).memory.available, true);
});

test('runtime status is exposed as a read tool and stays content free', async t => {
  const root = buildRoot(t, { runtime: { enabled: true, mode: 'active' } });
  const { tools, internals } = mount(t, root);
  await internals.engine.initialize();
  const status = JSON.parse(await tools.get('companion_runtime_status').execute({}, exec('session-a')));
  assert.equal(status.mode, 'active');
  assert.equal(typeof status.eventCount, 'number');
  assert.equal(status.memory.available, true);
  assert.ok(status.injection);
  const text = JSON.stringify(status);
  assert.doesNotMatch(text, /今日|公园|修屋顶/, 'diagnostics carry ids and counts only');
});
