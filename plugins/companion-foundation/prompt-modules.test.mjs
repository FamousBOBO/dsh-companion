import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODULES,
  MODULE_IDS,
  PROMPT_PROFILES,
  THINKING_MODES,
  moduleOrder,
  moduleSkipReason,
  modulesFor,
  promptContractSection,
  styleProfileOf,
} from './prompt-modules.mjs';

/**
 * 合同 §2.4 的模块表，逐字抄下来当断言基线。任何 ID / kind / priority / scenes 的漂移
 * 都必须先改合同再改这里 —— 配置黑名单与其它模块的测试都依赖这些字符串。
 */
const CONTRACT_TABLE = [
  { id: 'route.header', kind: 'header', priority: 95, scenes: [...PROMPT_PROFILES] },
  { id: 'mode.chat-frame', kind: 'mode', priority: 90, scenes: ['chat'] },
  { id: 'mode.companion-frame', kind: 'mode', priority: 90, scenes: ['companion'] },
  { id: 'mode.implicit-frame', kind: 'mode', priority: 90, scenes: ['implicit-roleplay'] },
  { id: 'mode.roleplay-frame', kind: 'mode', priority: 90, scenes: ['roleplay-narrative'] },
  { id: 'mode.task-frame', kind: 'mode', priority: 90, scenes: ['task'] },
  { id: 'thinking.guided', kind: 'thinking', priority: 70, scenes: [...PROMPT_PROFILES] },
  { id: 'thinking.structured', kind: 'thinking', priority: 70, scenes: [...PROMPT_PROFILES] },
  { id: 'thinking.strict', kind: 'thinking', priority: 70, scenes: [...PROMPT_PROFILES] },
  { id: 'operator.dig', kind: 'operator', priority: 80, scenes: [...PROMPT_PROFILES] },
  { id: 'operator.lore', kind: 'operator', priority: 78, scenes: [...PROMPT_PROFILES] },
  { id: 'operator.arc', kind: 'operator', priority: 76, scenes: [...PROMPT_PROFILES] },
  { id: 'operator.review', kind: 'operator', priority: 74, scenes: [...PROMPT_PROFILES] },
  { id: 'style.anti-ai-chat', kind: 'style', priority: 62, scenes: ['chat'] },
  { id: 'style.emotional-companion', kind: 'style', priority: 62, scenes: ['companion'] },
  { id: 'style.implicit-roleplay', kind: 'style', priority: 62, scenes: ['implicit-roleplay'] },
  { id: 'style.roleplay-narrative', kind: 'style', priority: 62, scenes: ['roleplay-narrative'] },
  { id: 'style.task-clear', kind: 'style', priority: 62, scenes: ['task'] },
  { id: 'style.anti-deepseek', kind: 'style', priority: 50, scenes: [...PROMPT_PROFILES] },
  { id: 'style.universal', kind: 'style', priority: 40, scenes: [...PROMPT_PROFILES] },
];

/** §4.2 的算子激活表：本轮 mode/intensity 下哪些模块应当出现在候选里。 */
const OPERATORS = {
  chat: { DIG: 'on', LORE: 'off', ARC: 'off', REVIEW: 'optional' },
  companion: { DIG: 'on', LORE: 'optional', ARC: 'off', REVIEW: 'optional' },
  'implicit-roleplay': { DIG: 'on', LORE: 'optional', ARC: 'light', REVIEW: 'optional' },
  'roleplay-narrative': { DIG: 'on', LORE: 'on', ARC: 'on', REVIEW: 'on' },
  task: { DIG: 'on', LORE: 'optional', ARC: 'off', REVIEW: 'optional' },
};

const THINKING_FOR = {
  chat: 'guided',
  companion: 'guided',
  'implicit-roleplay': 'guided',
  'roleplay-narrative': 'strict',
  task: 'guided',
};

const rendered = (module, profile = 'chat') => module.render({ route: { profile }, config: {}, personaPresent: false });

const totalChars = (profile, thinkingMode = THINKING_FOR[profile]) =>
  moduleListFor(profile, thinkingMode).reduce((sum, module) => sum + rendered(module, profile).length, 0);

function moduleListFor(profile, thinkingMode = THINKING_FOR[profile]) {
  return modulesFor({ profile, operators: OPERATORS[profile], thinkingMode, disabled: [] });
}

test('模块表与合同 §2.4 逐字一致（id / kind / priority / scenes）', () => {
  assert.equal(MODULES.length, CONTRACT_TABLE.length);
  for (let index = 0; index < CONTRACT_TABLE.length; index += 1) {
    const expected = CONTRACT_TABLE[index];
    const actual = MODULES[index];
    assert.equal(actual.id, expected.id, `声明顺序第 ${index} 项 ID 漂移`);
    assert.equal(actual.kind, expected.kind, `${expected.id} 的 kind 漂移`);
    assert.equal(actual.priority, expected.priority, `${expected.id} 的 priority 漂移`);
    assert.deepEqual([...actual.scenes], expected.scenes, `${expected.id} 的 scenes 漂移`);
    assert.equal(typeof actual.label, 'string');
    assert.ok(actual.label.length > 0);
    assert.equal(typeof actual.dedupeKey, 'string');
    assert.ok(Array.isArray(actual.operators));
    assert.equal(typeof actual.charBudget, 'number');
    assert.equal(typeof actual.render, 'function');
    assert.equal(moduleOrder(actual.id), index, `${expected.id} 的稳定顺序漂移`);
  }
});

test('MODULE_IDS 唯一、与 MODULES 同序，且五个思考等级与 profile 常量稳定', () => {
  assert.deepEqual([...MODULE_IDS], CONTRACT_TABLE.map(entry => entry.id));
  assert.equal(new Set(MODULE_IDS).size, MODULE_IDS.length);
  assert.deepEqual([...PROMPT_PROFILES], ['chat', 'companion', 'implicit-roleplay', 'roleplay-narrative', 'task']);
  assert.deepEqual([...THINKING_MODES], ['guided', 'structured', 'strict']);
  assert.equal(moduleOrder('not-a-module'), Number.MAX_SAFE_INTEGER);
});

test('modulesFor 按场景 + 算子 + 思考等级过滤（chat 档）', () => {
  const ids = moduleListFor('chat').map(module => module.id);
  // modulesFor 保持目录声明顺序（排序是 compose 的职责）
  assert.deepEqual(ids, [
    'route.header',
    'mode.chat-frame',
    'thinking.guided',
    'operator.dig',
    'operator.review',
    'style.anti-ai-chat',
    'style.anti-deepseek',
    'style.universal',
  ]);
  // chat 档不得混入别的场景 frame / 别的档位 style
  assert.ok(!ids.includes('mode.companion-frame'));
  assert.ok(!ids.includes('style.roleplay-narrative'));
  assert.ok(!ids.includes('thinking.strict'));
});

test('modulesFor 的算子门控：ARC 为 light 才算激活，off 一律不出现', () => {
  const light = modulesFor({ profile: 'implicit-roleplay', operators: OPERATORS['implicit-roleplay'], thinkingMode: 'guided' })
    .map(module => module.id);
  assert.ok(light.includes('operator.arc'), 'ARC=light 应当激活');
  const off = modulesFor({ profile: 'implicit-roleplay', operators: { ...OPERATORS['implicit-roleplay'], ARC: 'off' }, thinkingMode: 'guided' })
    .map(module => module.id);
  assert.ok(!off.includes('operator.arc'), 'ARC=off 不应当出现');
  const loreOff = modulesFor({ profile: 'chat', operators: { DIG: 'on', LORE: 'off', ARC: 'off', REVIEW: 'off' }, thinkingMode: 'guided' })
    .map(module => module.id);
  assert.ok(!loreOff.includes('operator.lore'));
  assert.ok(!loreOff.includes('operator.review'));
});

test('moduleSkipReason 优先级：disabled > scene > operator', () => {
  const dig = MODULES.find(module => module.id === 'operator.dig');
  assert.equal(moduleSkipReason(dig, { profile: 'chat', operators: OPERATORS.chat, thinkingMode: 'guided', disabled: [] }), '');
  assert.equal(moduleSkipReason(dig, { profile: 'chat', operators: OPERATORS.chat, thinkingMode: 'guided', disabled: ['operator.dig'] }), 'disabled');
  assert.equal(moduleSkipReason(dig, { profile: 'chat', operators: { DIG: 'off' }, thinkingMode: 'guided', disabled: ['operator.dig'] }), 'disabled');
  const chatStyle = MODULES.find(module => module.id === 'style.task-clear');
  assert.equal(moduleSkipReason(chatStyle, { profile: 'chat', operators: OPERATORS.chat, thinkingMode: 'guided' }), 'scene');
  const strict = MODULES.find(module => module.id === 'thinking.strict');
  assert.equal(moduleSkipReason(strict, { profile: 'chat', operators: OPERATORS.chat, thinkingMode: 'guided' }), 'operator');
  assert.equal(moduleSkipReason(strict, { profile: 'chat', operators: OPERATORS.chat, thinkingMode: 'strict' }), '');
});

test('模块正文长度符合合同目标上限（header/mode/thinking/operator/style/anti-deepseek）', () => {
  for (const module of MODULES) {
    const text = rendered(module, 'roleplay-narrative');
    assert.ok(text.length > 0, `${module.id} 渲染为空`);
    if (module.id === 'style.anti-deepseek') {
      assert.ok(text.length <= 170, `${module.id} 超出合同 170 字：${text.length}`);
    } else {
      assert.ok(text.length <= module.charBudget, `${module.id} 超出自身 charBudget ${module.charBudget}：${text.length}`);
    }
  }
});

test('chat 档全部模块合计 ≤450 字，task 档 ≤430 字（P3 §5.4 减重目标）', () => {
  const chatChars = totalChars('chat');
  const taskChars = totalChars('task');
  // 计划 §5.4 的目标是 chat 档 250–350 字。首轮落在 404 字（模块边界不可再拆，见
  // docs/10-prompt-layers.md §8），因此把上限钉在 450 以免悄悄长回去；再往下压需要
  // 调模块目录本身，不属于"清理"范围。
  assert.ok(chatChars <= 450, `chat 档合计 ${chatChars} 字，超过 450`);
  assert.ok(taskChars <= 430, `task 档合计 ${taskChars} 字，超过 430`);
  assert.ok(chatChars > 0 && taskChars > 0);
  // 相对改动前的 512 必须真的降下来
  assert.ok(chatChars < 512, `chat 档没有变短：${chatChars}`);
});

test('chat 档正文不含白描 / 环境描写 / 小说等小说写作要求', () => {
  const text = moduleListFor('chat').map(module => rendered(module, 'chat')).join('\n');
  for (const word of ['白描', '环境描写', '小说']) {
    assert.ok(!text.includes(word), `chat 档不应出现「${word}」`);
  }
  assert.ok(!text.includes('有限视角'));
  assert.ok(!text.includes('叙事'));
});

test('companion 档不出现心理咨询报告口吻，也不混入小说规则', () => {
  const text = moduleListFor('companion').map(module => rendered(module, 'companion')).join('\n');
  for (const word of ['白描', '环境描写', '小说', '有限视角']) {
    assert.ok(!text.includes(word), `companion 档不应出现「${word}」`);
  }
  // 用描述性口径说明"不要报告腔"，而不是把报告腔的词写进提示词
  assert.ok(text.includes('口语'));
  const style = MODULES.find(module => module.id === 'style.emotional-companion');
  const styleText = rendered(style, 'companion');
  assert.ok(styleText.includes('不') && styleText.includes('讲课'));
  assert.ok(styleProfileOf('companion').forbidden.includes('心理咨询报告口吻'));
});

test('implicit-roleplay 档是轻量叙事：自然对白为主、少量动作、不宣布切换、不要用户声明开始', () => {
  const text = moduleListFor('implicit-roleplay').map(module => rendered(module, 'implicit-roleplay')).join('\n');
  assert.ok(text.includes('对白'));
  assert.ok(text.includes('动作'));
  assert.ok(text.includes('不宣布') || text.includes('不要求'));
  assert.ok(text.includes('角色扮演'));
  // 轻量档不得升级成叙事档的硬规则
  assert.ok(!text.includes('白描'));
  assert.ok(!text.includes('有限视角'));
  assert.equal(styleProfileOf('implicit-roleplay').narration, 'light');
});

test('roleplay-narrative 档注入叙事规则关键词；task 档不含扮演规则', () => {
  const rp = moduleListFor('roleplay-narrative').map(module => rendered(module, 'roleplay-narrative')).join('\n');
  for (const word of ['白描', '有限视角', '知识边界', '旁白', '升华']) {
    assert.ok(rp.includes(word), `roleplay-narrative 档缺少叙事规则「${word}」`);
  }
  assert.ok(rp.includes('不强行升华总结') || rp.includes('不在段尾升华总结') || rp.includes('不替读者升华总结'));
  assert.equal(styleProfileOf('roleplay-narrative').narration, true);

  const task = moduleListFor('task').map(module => rendered(module, 'task')).join('\n');
  for (const word of ['白描', '环境描写', '小说', '有限视角', '旁白']) {
    assert.ok(!task.includes(word), `task 档不应出现「${word}」`);
  }
  assert.ok(task.includes('直接') || task.includes('结论'));
});

test('四种算子各有边界，LORE 与 ARC 明确支持跳过', () => {
  // P3 §5.4-1：DIG 只负责「听懂他到底在说什么」，「不复述原话」统一归 style.anti-ai-chat。
  // 这条断言把唯一归属钉住，避免两边各写一份又互相矛盾。
  const dig = rendered(MODULES.find(module => module.id === 'operator.dig'));
  assert.ok(!dig.includes('不复述'), 'DIG 不再重复「不复述」，该规则归 style.anti-ai-chat');
  assert.ok(dig.includes('不替他补全') && dig.includes('不把猜测当事实'));
  const antiAi = rendered(MODULES.find(module => module.id === 'style.anti-ai-chat'), 'chat');
  assert.ok(antiAi.includes('别复述他的话'), '「不复述」必须有一个唯一归属');

  const lore = rendered(MODULES.find(module => module.id === 'operator.lore'));
  assert.ok(lore.includes('跳过'));
  assert.ok(lore.includes('不编') || lore.includes('没有依据'));
  assert.ok(!lore.includes('推动剧情'));

  const arc = rendered(MODULES.find(module => module.id === 'operator.arc'));
  assert.ok(arc.includes('跳过') || arc.includes('不推进'));
  assert.ok(arc.includes('不催剧情') || arc.includes('不推动'));
  assert.ok(arc.includes('不靠制造冲突'));
  assert.ok(arc.includes('本轮不推进也完全可以'));

  // P3 §5.4-2：REVIEW 只留「按需自检」的行为，真实性约束归 Foundation 与 style.universal。
  const review = rendered(MODULES.find(module => module.id === 'operator.review'));
  assert.ok(!review.includes('编造事实'), 'REVIEW 不再重复真实性检查，该约束归 Foundation');
  assert.ok(review.includes('不输出检查清单'));
  assert.ok(review.includes('不拖长回复'));
  assert.ok(review.includes('拖长') || review.includes('冗长'));
});

test('thinking 三个等级只讲执行等级，不描述算子内容', () => {
  const guided = rendered(MODULES.find(module => module.id === 'thinking.guided'));
  const structured = rendered(MODULES.find(module => module.id === 'thinking.structured'));
  const strict = rendered(MODULES.find(module => module.id === 'thinking.strict'));
  for (const text of [guided, structured, strict]) {
    for (const word of ['DIG', 'LORE', 'ARC', 'REVIEW', '白描', '算子']) {
      assert.ok(!text.includes(word), `thinking 模块不应描述「${word}」`);
    }
  }
  assert.ok(guided.includes('不外露'));
  assert.ok(structured.includes('规划'));
  assert.ok(strict.includes('一次'));
});

test('anti-deepseek 只降低频率，不把「不是」「没有」「其实」设为禁词', () => {
  const module = MODULES.find(entry => entry.id === 'style.anti-deepseek');
  const text = rendered(module, 'chat');
  assert.ok(text.includes('不是禁词'));
  assert.ok(text.includes('降频') && text.includes('靠风格指导降频'));
  assert.ok(text.includes('不破坏正常中文表达'));
  assert.ok(text.includes('不是') && text.includes('没有') && text.includes('其实'));
  for (const word of ['微微', '一瞬', '一拍', '抽象比喻', '连续并列短句', '段尾强行总结', '固定转折词']) {
    assert.ok(text.includes(word), `anti-deepseek 应点名「${word}」`);
  }
  assert.ok(text.includes('不是X，而是Y') && text.includes('不像X，更像Y'));
  assert.ok(!/禁止使用|禁用词|不许写/.test(text), '不得把词设成绝对禁词');
  // task 档用精简版正文，篇幅更短
  const taskText = rendered(module, 'task');
  assert.ok(taskText.length < text.length);
  assert.ok(taskText.includes('不是禁词'));
});

test('promptContractSection 只解释动态模块规则：order 65、≤420 字、无具体风格内容', () => {
  const section = promptContractSection();
  assert.equal(section.name, 'companion:prompt-contract');
  assert.equal(section.order, 65);
  assert.equal(typeof section.text, 'string');
  assert.ok(section.text.length > 0);
  assert.ok(section.text.length <= 420, `合同 section 文本 ${section.text.length} 字，超过 420`);
  for (const word of ['白描', '环境描写', '小说', '微微', '对偶', '有限视角', '第一人称', 'DIG']) {
    assert.ok(!section.text.includes(word), `合同 section 不应包含具体风格内容「${word}」`);
  }
  assert.ok(section.text.includes('不出现') || section.text.includes('没出现'));
  assert.ok(section.text.includes('不要宣布模式切换'));
  assert.ok(section.text.includes('认知边界'));
  assert.ok(section.text.includes('人格'));
});

test('styleProfileOf 五档齐全、互不污染，未知档位 inert 不回落成 chat', () => {
  for (const profile of PROMPT_PROFILES) {
    const meta = styleProfileOf(profile);
    assert.equal(meta.id, profile);
    assert.equal(meta.fallback, undefined);
    assert.ok(typeof meta.label === 'string' && meta.label.length > 0);
    assert.ok(Array.isArray(meta.forbidden) && meta.forbidden.length > 0);
    assert.ok(MODULE_IDS.includes(meta.styleModule), `${profile} 的 styleModule 不在目录里`);
  }
  assert.deepEqual(styleProfileOf('chat').forbidden.includes('白描'), true);
  assert.deepEqual(styleProfileOf('task').forbidden.includes('扮演描写'), true);
  assert.equal(styleProfileOf('chat').narration, false);
  assert.equal(styleProfileOf('companion').narration, false);
  assert.equal(styleProfileOf('task').narration, false);
  const unknown = styleProfileOf('no-such-profile');
  assert.equal(unknown.fallback, true);
  assert.equal(unknown.styleModule, null);
  assert.equal(styleProfileOf(undefined).fallback, true);
});

test('目录是冻结的、渲染是纯函数（同输入同输出，不读时钟或随机数）', () => {
  assert.ok(Object.isFrozen(MODULES));
  for (const module of MODULES) {
    assert.ok(Object.isFrozen(module.scenes));
    assert.ok(Object.isFrozen(module.operators));
    const first = module.render({ route: { profile: 'chat' }, config: {}, personaPresent: true });
    const second = module.render({ route: { profile: 'chat' }, config: {}, personaPresent: true });
    assert.equal(first, second, `${module.id} 渲染不稳定`);
    // 传空 ctx 也不能抛错（引擎降级路径会这么调）
    assert.equal(typeof module.render({}), 'string');
  }
});
