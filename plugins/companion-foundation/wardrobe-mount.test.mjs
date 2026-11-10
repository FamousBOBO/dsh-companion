import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Host-boundary test for the wardrobe v2 / visual identity upgrade: it mounts the real
// foundation plugin with the real DSH tool definitions against a throwaway companion root
// and drives the same `agent/pre-step` hook and tools the desktop uses.
//
// What only a mount test can prove:
//   - the `companion:wardrobe` **static** section carries no clothes (it is a rule);
//   - the current outfit arrives once per turn, in the first-step snapshot only;
//   - the snapshot and `companion_wardrobe_detail` return the *same* answer;
//   - an explicit `companion_outfit_set` takes effect on the very next turn.

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const { resolveModuleRoot } = await import('./test-fixtures/module-root.mjs');
process.env.DSH_COMPANION_MODULE_ROOT = resolveModuleRoot(repositoryRoot).root;
const { mountCompanion } = await import('./index.mjs');

/**
 * A throwaway companion root.
 *
 * The wardrobe resolver reads the **real** wall clock, which is the point of it — so a test
 * that asserts "she is in everyday clothes" would pass or fail depending on when CI runs
 * (at 02:00 the night window puts her in sleepwear, correctly). The fix is not to fake the
 * clock inside the plugin: it is to write the documented config file the resolver already
 * honours (`home/companion/wardrobe.config.json`), so the scene is pinned for the test.
 * `nightWindow` is configured per-test where the night behaviour is what is being asserted.
 */
function buildRoot(t, { wardrobeConfig = { nightWindow: { enabled: false }, eveningFrom: '23:59' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-wardrobe-'));
  for (const dir of ['workspace', 'logs', 'home/memory', 'home/companion', 'home/channel-qq']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'bot',
    owner: { id: '10001', displayName: '测试主人', platform: 'qq' },
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
  if (wardrobeConfig) {
    fs.writeFileSync(path.join(root, 'home/companion/wardrobe.config.json'), JSON.stringify(wardrobeConfig), 'utf8');
  }
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

/** Local HH:MM shifted by `offsetMinutes`, for a night window that brackets "now". */
function localClock(offsetMinutes = 0) {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at);
  const pick = type => parts.find(part => part.type === type)?.value ?? '00';
  return `${pick('hour')}:${pick('minute')}`;
}

function mount(t, root) {
  const tools = new Map();
  const hooks = new Map();
  const sections = [];
  const internals = mountCompanion({
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section: descriptor => sections.push(descriptor) },
    // `ctx.on(name, handler, options)` — the wardrobe hook is registered with `prepend`.
    on(name, handler) { hooks.set(name, handler); },
    get() { return undefined; },
  }, root);
  t.after(async () => {
    try { internals.cognitive?.dispose(); } catch { /* already closed */ }
    try { await internals.engine.close(); } catch { /* already closed */ }
  });
  return { tools, hooks, internals, sections };
}

const decision = text => ({ kind: 'enter', startsRequestSeries: true, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }] });
const stepEvent = (sessionId, step = 1) => ({ agent: { session: { id: sessionId } }, step, signal: new AbortController().signal });
const exec = sessionId => ({ agent: { session: { id: sessionId } } });

function wardrobeSection(entered) {
  const sections = entered.messages[1]?.source?.sections ?? [];
  return sections.find(section => section.name === 'companion-wardrobe');
}

test('静态 wardrobe section 只是一条规则，不含任何衣物', async (t) => {
  const root = buildRoot(t);
  const { sections } = mount(t, root);
  const wardrobe = sections.find(section => section.name === 'companion:wardrobe');
  assert.ok(wardrobe, 'companion:wardrobe section 仍然注册');
  const text = typeof wardrobe.text === 'function' ? wardrobe.text() : wardrobe.text;
  assert.match(text, /穿着规则/);
  assert.doesNotMatch(text, /睡衣|卫衣|衬衫|拖鞋/);
  // The old static renderer injected today's rotation here; that must be gone.
  assert.doesNotMatch(text, /今天穿/);
});

test('当前穿着快照每轮注入一次，并且与工具返回一致', async (t) => {
  const root = buildRoot(t);
  const { tools, hooks, internals } = mount(t, root);
  await internals.engine.initialize();

  const entered = await hooks.get('agent/pre-step')(stepEvent('session-a'), async () => decision('你现在穿着什么'));
  const section = wardrobeSection(entered);
  assert.ok(section, '第一轮注入 companion-wardrobe 段落');
  assert.match(section.text, /【当前穿着】/);
  assert.match(section.text, /场景：/);
  assert.match(section.text, /状态来源：/);
  assert.ok(section.text.length <= 480, `快照必须受 480 字符约束，实际 ${section.text.length}`);
  // The text must be inside the injected message, not only in the section metadata.
  assert.ok(entered.messages[1].content[0].text.includes(section.text));

  const detail = JSON.parse(await tools.get('companion_wardrobe_detail').execute({ scope: 'today' }, exec('session-a')));
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.match(section.text, new RegExp(`场景：${detail.contextLabel}`));
  // Every piece in the tool answer must be described in the snapshot. The snapshot uses the
  // description (that is what tells the model what the garment looks like); the tool also
  // returns the short name, so check the description prefix.
  for (const piece of detail.items) {
    const described = String(piece.description ?? '');
    assert.ok(section.text.includes(described) || section.text.includes(piece.name), `快照必须包含 ${piece.name}`);
  }

  // Step 2 of the same turn must not inject again.
  const second = await hooks.get('agent/pre-step')(stepEvent('session-a', 2), async () => decision('继续'));
  assert.equal(second.messages.length, 1, '只有第一步注入');
});

test('三轮对话里服装稳定，不会每轮随机', async (t) => {
  const root = buildRoot(t);
  const { tools, hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  const ids = [];
  for (const text of ['在吗', '今天做什么', '你会冷吗']) {
    const entered = await hooks.get('agent/pre-step')(stepEvent('session-a'), async () => decision(text));
    const detail = JSON.parse(await tools.get('companion_wardrobe_detail').execute({}, exec('session-a')));
    ids.push(detail.items.map(item => item.id).join(','));
    assert.ok(wardrobeSection(entered).text.includes(detail.contextLabel));
  }
  assert.equal(new Set(ids).size, 1, `同一天同一场景必须一致，实际 ${ids.join(' | ')}`);
});

test('夜间窗口开启时，快照换成睡衣且仍然与工具一致', async (t) => {
  // A night window that brackets the current local time, so this test is meaningful
  // whenever it runs and still exercises the real clock path.
  const root = buildRoot(t, {
    wardrobeConfig: { nightWindow: { enabled: true, start: localClock(-5), end: localClock(30) }, eveningFrom: '23:59' },
  });
  const { tools, hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  const detail = JSON.parse(await tools.get('companion_wardrobe_detail').execute({}, exec('session-a')));
  assert.equal(detail.context, 'sleep', `当前时间 ${localClock()} 应落在测试设定的夜间窗口内`);
  assert.equal(detail.reason, 'night-window');
  assert.equal(detail.outfitId, 'sleepwear-default');
  const entered = await hooks.get('agent/pre-step')(stepEvent('session-a'), async () => decision('你困吗'));
  const section = wardrobeSection(entered);
  assert.match(section.text, /场景：睡衣/);
  assert.match(section.text, /睡衣/);
  assert.match(section.text, /不代表已经睡着/);
  assert.doesNotMatch(section.text, /白色连帽卫衣/, '睡衣场景不能带常服');
});

test('显式换装在下一轮立即生效，并写入一条带有效期的覆盖', async (t) => {
  const root = buildRoot(t);
  const { tools, hooks, internals } = mount(t, root);
  await internals.engine.initialize();

  const before = JSON.parse(await tools.get('companion_wardrobe_detail').execute({}, exec('session-a')));
  const wardrobe = JSON.parse(await tools.get('companion_wardrobe_detail').execute({ scope: 'all' }, exec('session-a')));
  const shirt = wardrobe.items.find(item => item.id === 'w-upper-shirt');
  const skirt = wardrobe.items.find(item => item.id === 'w-lower-skirt');
  assert.ok(shirt && skirt, '种子衣柜里应有衬衫与裙子');

  const saved = JSON.parse(await tools.get('companion_outfit_set').execute({
    itemIds: [shirt.id, skirt.id], instruction: '今天想换这身', context: 'everyday',
  }, exec('session-a')));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.ok(saved.until > Date.now(), '覆盖必须带未来的有效期');

  const after = JSON.parse(await tools.get('companion_wardrobe_detail').execute({}, exec('session-a')));
  assert.equal(after.isOverride, true);
  assert.deepEqual(after.items.map(item => item.id), [shirt.id, skirt.id]);
  assert.notDeepEqual(after.items.map(item => item.id), before.items.map(item => item.id));
  assert.match(after.instruction, /换这身/);

  const entered = await hooks.get('agent/pre-step')(stepEvent('session-a'), async () => decision('你真好看'));
  const section = wardrobeSection(entered);
  assert.match(section.text, /衣柜显式覆盖/);
  // The snapshot shows the description (the actual garment), not the short name.
  assert.ok(section.text.includes(shirt.description) || section.text.includes(shirt.name), `快照应包含换上的 ${shirt.name}`);
  assert.match(section.text, /换这身/, '覆盖说明要出现在快照里');

  // Clearing the override returns to the automatic answer.
  const cleared = JSON.parse(await tools.get('companion_outfit_set').execute({ clearOverride: true }, exec('session-a')));
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  const restored = JSON.parse(await tools.get('companion_wardrobe_detail').execute({}, exec('session-a')));
  assert.equal(restored.isOverride, false);
});

test('scope=contexts 报告五个场景的可用性；companion_visual_state 同时给出身份与服装', async (t) => {
  const root = buildRoot(t);
  const { tools, internals } = mount(t, root);
  await internals.engine.initialize();

  const contexts = JSON.parse(await tools.get('companion_wardrobe_detail').execute({ scope: 'contexts' }, exec('session-a')));
  assert.equal(contexts.scope, 'contexts');
  assert.deepEqual(contexts.contexts.map(row => row.context), ['everyday', 'home', 'sleep', 'outdoor', 'special']);
  assert.equal(contexts.ok, true);

  const visual = JSON.parse(await tools.get('companion_visual_state').execute({}, exec('session-a')));
  assert.ok(visual.personaId, '必须绑定当前 persona');
  assert.equal(visual.identity.state, 'not-configured', '这个测试环境没有身份文件');
  assert.match(JSON.stringify(visual.missing), /identity/);
  assert.equal(visual.wardrobe.ok, true);
  assert.match(visual.imageClause, /^wearing /);
  assert.doesNotMatch(visual.imageClause, /[\u4e00-\u9fff]/);
});

test('群聊会话里不注入私聊衣柜的具体衣物', async (t) => {
  const root = buildRoot(t);
  const { hooks, internals } = mount(t, root);
  await internals.engine.initialize();
  // Identity refuses a group session before any injection happens, so the private wardrobe
  // can never reach a group prompt. That refusal is the isolation boundary, not an accident.
  await assert.rejects(async () => {
    await hooks.get('agent/pre-step')(stepEvent('qq-group-123456'), async () => decision('你们在聊什么'));
  }, /Owner memory is unavailable outside the owner QQ private chat/);

  // And the resolver itself answers "unavailable" rather than borrowing the DM wardrobe.
  const { resolveWardrobeState } = await import('./wardrobe-state.mjs');
  const group = resolveWardrobeState({ root, personaId: 'bot', sessionId: 'qq-group-123456' });
  assert.equal(group.ok, false);
  assert.equal(group.code, 'wardrobe-unavailable-in-group');
});
