import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MODULES,
  SKIP_REASONS,
  budgetFor,
  capModuleCount,
  compareModules,
  composePrompt,
  dedupeModules,
  disabledList,
  renderModuleText,
  trimModulesToBudget,
} from './prompt-compose.mjs';
import { MODULES, MODULE_IDS, moduleOrder } from './prompt-modules.mjs';

/** 合同 §4.2 的算子激活表；测试只用这一份，避免各文件各写一套。 */
const ROUTE = {
  chat: { mode: 'chat', intensity: 'normal', profile: 'chat', thinkingMode: 'guided',
    operators: { DIG: 'on', LORE: 'off', ARC: 'off', REVIEW: 'optional' } },
  companion: { mode: 'companion', intensity: 'normal', profile: 'companion', thinkingMode: 'guided',
    operators: { DIG: 'on', LORE: 'optional', ARC: 'off', REVIEW: 'optional' } },
  'implicit-roleplay': { mode: 'roleplay', intensity: 'subtle', profile: 'implicit-roleplay', thinkingMode: 'guided',
    operators: { DIG: 'on', LORE: 'optional', ARC: 'light', REVIEW: 'optional' } },
  'roleplay-narrative': { mode: 'roleplay', intensity: 'immersive', profile: 'roleplay-narrative', thinkingMode: 'strict',
    operators: { DIG: 'on', LORE: 'on', ARC: 'on', REVIEW: 'on' } },
  task: { mode: 'task', intensity: 'normal', profile: 'task', thinkingMode: 'guided',
    operators: { DIG: 'on', LORE: 'optional', ARC: 'off', REVIEW: 'optional' } },
};

const compose = (profile, config = {}, extra = {}) => composePrompt({ route: ROUTE[profile], config, ...extra });

/** 某个模块在当前档位下的正文（compose 里 render 收到的 ctx 与这里同形）。 */
const bodyOf = (id, profile) => {
  const module = MODULES.find(entry => entry.id === id);
  return module.render({ route: ROUTE[profile], config: {}, personaPresent: false }).trim();
};

test('默认预算：chat 600 / companion 800 / roleplay 1300 / task 500；缺失回落、越界钳制', () => {
  assert.equal(budgetFor({ config: {}, mode: 'chat' }), 600);
  assert.equal(budgetFor({ config: {}, mode: 'companion' }), 800);
  assert.equal(budgetFor({ config: {}, mode: 'roleplay' }), 1300);
  assert.equal(budgetFor({ config: {}, mode: 'task' }), 500);
  assert.equal(budgetFor({ config: { budgets: { chat: 900 } }, mode: 'chat' }), 900);
  assert.equal(budgetFor({ config: { budgets: { chat: 50 } }, mode: 'chat' }), 120, '低于 120 应钳到 120');
  assert.equal(budgetFor({ config: { budgets: { chat: 99999 } }, mode: 'chat' }), 4000, '高于 4000 应钳到 4000');
  assert.equal(budgetFor({ config: { budgets: { chat: 'abc' } }, mode: 'chat' }), 600, '非法值回落默认');
  assert.equal(budgetFor({ config: { budgets: { chat: 612.9 } }, mode: 'chat' }), 612, '取整向下');
  assert.equal(budgetFor({ config: null, mode: 'chat' }), 600);
  assert.equal(budgetFor({}), 600);
});

test('稳定排序：priority 降序，同优先级按目录声明顺序；文本用 \\n 连接', () => {
  const result = compose('chat');
  const priorities = result.selectedModules.map(entry => entry.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a), 'priority 必须降序');
  for (let index = 1; index < result.selectedModules.length; index += 1) {
    const prev = result.selectedModules[index - 1];
    const next = result.selectedModules[index];
    if (prev.priority === next.priority) {
      assert.ok(moduleOrder(prev.id) < moduleOrder(next.id), `${prev.id} 与 ${next.id} 同优先级时顺序应稳定`);
    }
  }
  const expected = result.selectedModules.map(entry => bodyOf(entry.id, 'chat')).join('\n');
  assert.equal(result.text, expected, 'text 必须是各模块正文用 \\n 连接');
  assert.equal(result.chars, result.text.length);
  assert.ok(!result.text.startsWith('\n') && !result.text.endsWith('\n'));
});

test('chat 档：8 个模块、合计 ≤450 字，且不带白描/环境描写/小说等叙事要求', () => {
  const result = compose('chat');
  assert.equal(result.budgetChars, 600);
  assert.ok(result.chars <= 450, `chat 档 ${result.chars} 字，超过 450`);
  assert.ok(result.chars <= result.budgetChars, 'chars 必须 ≤ budgetChars');
  assert.equal(result.selectedModules.length, 8);
  assert.deepEqual(result.selectedModules.map(entry => entry.id), [
    'route.header',
    'mode.chat-frame',
    'operator.dig',
    'operator.review',
    'thinking.guided',
    'style.anti-ai-chat',
    'style.anti-deepseek',
    'style.universal',
  ]);
  for (const word of ['白描', '环境描写', '小说']) {
    assert.ok(!result.text.includes(word), `chat 档不应出现「${word}」`);
  }
  assert.equal(result.state.trimmed.length, 0, '默认预算下 chat 档不需要裁剪');
  assert.equal(result.profile, 'chat');
});

test('task 档：合计 ≤480 字，直接回答，不含扮演与叙事规则', () => {
  const result = compose('task');
  assert.equal(result.budgetChars, 500);
  assert.ok(result.chars <= 480, `task 档 ${result.chars} 字，超过 480`);
  assert.ok(result.chars <= result.budgetChars, 'chars 必须 ≤ budgetChars');
  assert.ok(result.selectedModules.every(entry => entry.id !== 'style.anti-ai-chat'));
  for (const word of ['白描', '环境描写', '小说', '有限视角', '旁白', '扮演']) {
    assert.ok(!result.text.includes(word), `task 档不应出现「${word}」`);
  }
  // anti-deepseek 在 task 档用精简版
  const anti = result.selectedModules.find(entry => entry.id === 'style.anti-deepseek');
  assert.ok(anti, 'task 档仍应包含 anti-deepseek');
  assert.ok(anti.chars < 100, `task 档 anti-deepseek 应是精简版，实际 ${anti.chars} 字`);
});

test('roleplay-narrative 档：注入白描/有限视角/知识边界等叙事规则', () => {
  const result = compose('roleplay-narrative');
  for (const word of ['白描', '有限视角', '知识边界', '旁白']) {
    assert.ok(result.text.includes(word), `roleplay-narrative 档缺少叙事规则「${word}」`);
  }
  assert.ok(result.selectedModules.some(entry => entry.id === 'mode.roleplay-frame'));
  assert.ok(result.selectedModules.some(entry => entry.id === 'style.roleplay-narrative'));
  assert.ok(result.selectedModules.some(entry => entry.id === 'thinking.strict'));
  assert.ok(result.chars <= result.budgetChars);
});

test('模块数量上限 10：所有档位的候选模块都装得下，不靠数量上限裁模块', () => {
  // 数量上限的作用是防病态膨胀，而不是裁掉"不编造事实"这种行为红线模块：
  // 目录里最大的一档候选正好 10 个（implicit / immersive），上限取 10 时一档都不会被砍。
  assert.equal(MAX_MODULES, 10);
  for (const profile of ['chat', 'companion', 'task', 'implicit-roleplay', 'roleplay-narrative']) {
    const result = compose(profile);
    assert.ok(result.selectedModules.length <= MAX_MODULES, `${profile} 模块数超限`);
    assert.equal(result.selectedModules.some(entry => entry.id === 'style.universal'), true, `${profile} 丢了 style.universal`);
  }
});

test('数量上限本身仍然生效：把上限调到 2 时按顺序整模块丢弃，理由记为 budget', () => {
  // capModuleCount 是数量上限的落地点：这里直接验它，不依赖 MAX_MODULES 的常量取值。
  const entries = ['route.header', 'mode.chat-frame', 'operator.dig']
    .map(id => ({ module: MODULES.find(item => item.id === id), text: bodyOf(id, 'chat') }));
  const capped = capModuleCount(entries, 2);
  assert.equal(capped.kept.length, 2);
  assert.deepEqual(capped.dropped, ['operator.dig']);
  const truncated = trimModulesToBudget(entries, 10);
  assert.ok(truncated.chars <= 10);
  assert.ok(truncated.dropped.length >= 1);
  // 保留的模块正文必须完整，不是被截断的片段
  for (const entry of truncated.kept) assert.ok(entry.text === bodyOf(entry.module.id, 'chat'));
});

test('预算裁剪：按优先级从低到高整模块丢弃，正文绝不被截断', () => {
  // 160 字预算下，前三个整模块（32 + 1 + 31 + 1 + 54 = 119）装得下，第四个就超了。
  const tight = compose('chat', { budgets: { chat: 160 } });
  assert.equal(tight.budgetChars, 160);
  assert.ok(tight.chars <= 160, `裁剪后 ${tight.chars} 字仍超预算 160`);
  const kept = tight.selectedModules.map(entry => entry.id);
  assert.deepEqual(kept, ['route.header', 'mode.chat-frame', 'operator.dig'], '只保留装得下的整模块');
  assert.equal(tight.chars, 119);
  assert.equal(
    tight.text,
    ['route.header', 'mode.chat-frame', 'operator.dig'].map(id => bodyOf(id, 'chat')).join('\n'),
  );
  for (const entry of tight.selectedModules) {
    assert.ok(tight.text.includes(bodyOf(entry.id, 'chat')), `${entry.id} 正文被截断`);
  }
  const dropped = tight.skippedModules.filter(entry => entry.reason === 'budget').map(entry => entry.id);
  assert.deepEqual(dropped, [
    'style.universal', 'style.anti-deepseek', 'style.anti-ai-chat',
    'thinking.guided', 'operator.review',
  ]);
  assert.deepEqual(tight.state.trimmed, dropped);
  // 每个被丢的模块都在 skippedModules 里，且 text 里没有半个模块
  for (const id of dropped) {
    assert.ok(!tight.text.includes(bodyOf(id, 'chat')), `${id} 不应残留在 text 里`);
  }
});

test('预算极小时也存在合法结果：只保留装得下的整模块，绝不返回半个模块', () => {
  const result = compose('chat', { budgets: { chat: 60 } });
  assert.equal(result.budgetChars, 120, '预算下限 120 由钳制保证');
  // header 32 + '\n' + chat-frame 31 + '\n' + dig 54 = 119 ≤ 120；再多一个模块就超了
  assert.deepEqual(result.selectedModules.map(entry => entry.id), ['route.header', 'mode.chat-frame', 'operator.dig']);
  assert.equal(result.text, ['route.header', 'mode.chat-frame', 'operator.dig'].map(id => bodyOf(id, 'chat')).join('\n'));
  assert.equal(result.chars, 119);
  assert.ok(result.chars <= result.budgetChars);
  // 单模块也装不下时返回空文本，而不是切一半
  const single = trimModulesToBudget([{ module: { id: 'only' }, text: 'x'.repeat(200) }], 120);
  assert.deepEqual(single.kept, []);
  assert.equal(single.chars, 0);
});

test('skippedModules 覆盖 scene / operator / disabled，reason 取值受合同约束且 ID 不重复', () => {
  const result = compose('chat');
  const reasons = new Set(result.skippedModules.map(entry => entry.reason));
  assert.ok(reasons.has('scene'), 'chat 档应记录 scene 跳过');
  assert.ok(reasons.has('operator'), 'chat 档应记录 operator 跳过（LORE/ARC off）');
  for (const entry of result.skippedModules) {
    assert.ok(SKIP_REASONS.includes(entry.reason), `非法 reason: ${entry.reason}`);
    assert.ok(MODULE_IDS.includes(entry.id), `非法模块 ID: ${entry.id}`);
  }
  const ids = result.skippedModules.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length, '同一模块只能出现一次');

  // 选中 + 跳过 = 整个目录
  const all = [...result.selectedModules.map(entry => entry.id), ...ids].sort();
  assert.deepEqual(all, [...MODULE_IDS].sort());

  const disabled = compose('chat', { modules: { disabled: ['style.anti-deepseek'] } });
  const entry = disabled.skippedModules.find(item => item.id === 'style.anti-deepseek');
  assert.equal(entry?.reason, 'disabled');
  assert.ok(!disabled.text.includes(bodyOf('style.anti-deepseek', 'chat')));
  const entered = disabled.skippedModules.find(item => item.id === 'style.universal');
  assert.notEqual(entered?.reason, 'disabled');
});

test('黑名单：config.modules.disabled 与 extraDisabled 合并去重，都生效', () => {
  assert.deepEqual(disabledList({ config: {} }), []);
  assert.deepEqual(
    disabledList({ config: { modules: { disabled: ['a', 'b', 'a'] } }, extraDisabled: ['b', 'c', '', null, 7] }),
    ['a', 'b', 'c'],
  );
  const result = compose('chat', { modules: { disabled: [] } }, { extraDisabled: ['style.anti-ai-chat'] });
  assert.ok(!result.selectedModules.some(entry => entry.id === 'style.anti-ai-chat'));
  assert.equal(
    result.skippedModules.find(item => item.id === 'style.anti-ai-chat')?.reason,
    'disabled',
  );
  // 全部禁用 ⇒ 空文本、零字符，仍然合法
  const empty = compose('chat', { modules: { disabled: [...MODULE_IDS] } });
  assert.equal(empty.text, '');
  assert.equal(empty.chars, 0);
  assert.deepEqual(empty.selectedModules, []);
  assert.equal(empty.skippedModules.length, MODULE_IDS.length);
  assert.ok(empty.skippedModules.every(item => item.reason === 'disabled'));
});

test('去重：dedupeKey 相同只留优先级最高的一条；正文完全相同只留一条', () => {
  const synthetic = [
    { id: 'b-low', priority: 10, dedupeKey: 'k', render: () => '低' },
    { id: 'a-high', priority: 50, dedupeKey: 'k', render: () => '高' },
    { id: 'c-other', priority: 40, dedupeKey: '', render: () => '其它' },
  ];
  const { kept, deduped } = dedupeModules([...synthetic].sort(compareModules));
  assert.deepEqual(kept.map(module => module.id), ['a-high', 'c-other']);
  assert.deepEqual(deduped, ['b-low']);

  // 模块目录里 mode/thinking 是互斥 key，真实场景不会重复出现
  const result = compose('roleplay-narrative');
  const dedupedKeys = result.selectedModules.map(entry => MODULES.find(module => module.id === entry.id).dedupeKey)
    .filter(key => key);
  assert.equal(new Set(dedupedKeys).size, dedupedKeys.length, '同 dedupeKey 不应同时入选');
  assert.deepEqual(result.state.deduped, []);

  assert.deepEqual(dedupeModules([]).kept, []);
  assert.deepEqual(dedupeModules(null).deduped, []);
});

test('render 抛错或返回非字符串 ⇒ 记为 empty，不影响其它模块', () => {
  const broken = [
    { id: 'throws', priority: 90, dedupeKey: '', render: () => { throw new Error('boom'); } },
    { id: 'nullish', priority: 80, dedupeKey: '', render: () => null },
    { id: 'blank', priority: 70, dedupeKey: '', render: () => '   ' },
    { id: 'good', priority: 60, dedupeKey: '', render: () => '正文' },
  ];
  for (const module of broken) {
    const text = renderModuleText(module, {});
    assert.equal(text, module.id === 'good' ? '正文' : '');
  }
  assert.equal(renderModuleText(null, {}), '');
  assert.equal(renderModuleText({}, {}), '');
});

test('composePrompt 是纯函数：不改输入、同输入同输出、无副作用', () => {
  const config = { budgets: { chat: 600 }, modules: { disabled: ['style.universal'] } };
  const snapshot = JSON.stringify(config);
  const first = compose('chat', config);
  const second = compose('chat', config);
  assert.equal(JSON.stringify(config), snapshot, 'config 不得被修改');
  assert.equal(first.text, second.text);
  assert.deepEqual(first.selectedModules, second.selectedModules);
  assert.deepEqual(first.skippedModules, second.skippedModules);
  assert.deepEqual(first.state, second.state);
  // 无参数调用也不抛错
  const bare = composePrompt();
  assert.equal(typeof bare.text, 'string');
  assert.equal(bare.profile, 'chat');
  assert.equal(bare.budgetChars, 600);
});

test('composePrompt 的返回结构与合同 §2.3 一致，不受 person/memory 输入影响正文', () => {
  const result = composePrompt({
    route: ROUTE.chat,
    config: {},
    persona: '人格正文不该被复制进模块文本',
    memoryContext: '记忆片段不该被复制',
    workingMemory: '工作记忆片段不该被复制',
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'budgetChars', 'chars', 'profile', 'selectedModules', 'skippedModules', 'state', 'text',
  ]);
  assert.deepEqual(Object.keys(result.state).sort(), [
    'budgetChars', 'deduped', 'intensity', 'mode', 'thinkingMode', 'trimmed',
  ]);
  assert.deepEqual(Object.keys(result.selectedModules[0]).sort(), ['chars', 'id', 'priority']);
  assert.deepEqual(Object.keys(result.skippedModules[0]).sort(), ['id', 'reason']);
  assert.equal(result.state.mode, 'chat');
  assert.equal(result.state.intensity, 'normal');
  assert.equal(result.state.thinkingMode, 'guided');
  assert.equal(result.state.budgetChars, result.budgetChars);
  assert.ok(!result.text.includes('人格正文不该被复制进模块文本'));
  assert.ok(!result.text.includes('记忆片段不该被复制'));
});

test('capModuleCount / trimModulesToBudget 的边界行为', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    module: { id: `m${index}`, priority: 100 - index },
    text: 'x'.repeat(10),
  }));
  const capped = capModuleCount(entries, 8);
  assert.equal(capped.kept.length, 8);
  assert.deepEqual(capped.dropped, ['m8', 'm9']);
  assert.deepEqual(capModuleCount(entries.slice(0, 3), 8).dropped, []);
  assert.deepEqual(capModuleCount(null).kept, []);

  const trimmed = trimModulesToBudget(entries.slice(0, 3), 12);
  assert.deepEqual(trimmed.kept.map(entry => entry.module.id), ['m0'], '只剩第一个 10 字模块（+\\n 会超）');
  assert.deepEqual(trimmed.dropped, ['m2', 'm1']);
  assert.equal(trimmed.chars, 10);

  const none = trimModulesToBudget(entries.slice(0, 2), 0);
  assert.deepEqual(none.kept, []);
  assert.deepEqual(none.dropped, ['m1', 'm0']);
  assert.equal(none.chars, 0);
});

test('五档 profile 都产出合法组合：chars ≤ budgetChars，模块数 ≤8，无空正文', () => {
  for (const profile of Object.keys(ROUTE)) {
    const result = compose(profile);
    assert.equal(result.profile, profile);
    assert.ok(result.chars <= result.budgetChars, `${profile} 超预算`);
    assert.ok(result.selectedModules.length <= MAX_MODULES, `${profile} 模块数超限`);
    assert.ok(result.selectedModules.length > 0, `${profile} 至少应有一个模块`);
    for (const entry of result.selectedModules) {
      assert.ok(entry.chars > 0, `${profile}/${entry.id} 正文为空`);
      assert.equal(entry.chars, bodyOf(entry.id, profile).length, `${profile}/${entry.id} 字数与正文不一致`);
    }
    assert.equal(result.text.length, result.chars);
  }
});
