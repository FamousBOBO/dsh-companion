import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractJsonObject,
  validatePlan,
  buildPlannerPrompt,
  buildRepairPrompt,
  renderPlanForWriter,
  PLAN_SCHEMA_VERSION,
  PLAN_LIMITS,
  PLAN_ENUMS,
} from './prompt-plan.mjs';

// 结构化规划的验收点（任务书 §4.3 / §8 / §14.5）：
// 合法 JSON 通过、非法与缺字段被拒、超长被限制、提示词不超输入上限、规划与正文分离。

const validPlan = () => ({
  schemaVersion: 1,
  taskType: 'roleplay',
  intent: { goal: '接住刚才的场景', constraints: ['不要追问晚归原因'] },
  scene: { time: '深夜', location: '门口', participants: ['bot', 'user'], knownFacts: ['他刚回来'], unknowns: ['为什么这么晚'] },
  characters: [{ id: 'bot', intention: '先不追问', attitude: '克制', knowledgeBoundary: ['不知道他今晚去了哪'] }],
  operators: {
    DIG: { status: 'done', summary: '回应近况' },
    LORE: { status: 'done', summary: '深夜、门口' },
    ARC: { status: 'done', nextBeat: '把茶放在桌上' },
    REVIEW: { status: 'done', issues: [], corrections: [] },
  },
  styleProfile: 'roleplay-narrative',
  outputContract: { format: 'natural_prose' },
});

test('合法规划通过校验，且归一化结果保留全部关键字段', () => {
  const result = validatePlan(validPlan());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.plan.schemaVersion, PLAN_SCHEMA_VERSION);
  assert.equal(result.plan.intent.goal, '接住刚才的场景');
  assert.equal(result.plan.scene.location, '门口');
  assert.equal(result.plan.characters[0].id, 'bot');
  assert.equal(result.plan.operators.ARC.nextBeat, '把茶放在桌上');
  assert.equal(result.plan.styleProfile, 'roleplay-narrative');
});

test('非法 JSON / 非对象 / 坏版本被拒绝并给出正确的 code', () => {
  assert.deepEqual(validatePlan(null).errors, [{ path: '$', code: 'not-object' }]);
  assert.deepEqual(validatePlan('{"a":1}').errors, [{ path: '$', code: 'not-object' }]);
  assert.deepEqual(validatePlan([1, 2]).errors, [{ path: '$', code: 'not-object' }]);
  assert.deepEqual(validatePlan({ schemaVersion: 99 }).errors, [{ path: 'schemaVersion', code: 'wrong-version' }]);
  assert.equal(validatePlan({ schemaVersion: 99 }).ok, false);
});

test('缺关键字段被拒：没有 goal 就失败', () => {
  const result = validatePlan({ schemaVersion: 1, taskType: 'chat', intent: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ path: 'intent.goal', code: 'missing' }]);
});

test('枚举越界被拒：taskType / styleProfile / format / operator status', () => {
  const bad = {
    ...validPlan(),
    taskType: 'novel',
    styleProfile: 'literary',
    outputContract: { format: 'poem' },
    operators: { ...validPlan().operators, DIG: { status: 'maybe', summary: '' } },
  };
  const result = validatePlan(bad);
  assert.equal(result.ok, false);
  const codes = result.errors.map(error => `${error.path}:${error.code}`);
  assert.ok(codes.includes('taskType:bad-enum'), codes.join(','));
  assert.ok(codes.includes('styleProfile:bad-enum'), codes.join(','));
  assert.ok(codes.includes('outputContract.format:bad-enum'), codes.join(','));
  assert.ok(codes.includes('operators.DIG.status:bad-enum'), codes.join(','));
});

test('超长字段与超量数组被截断到 PLAN_LIMITS（而不是让整份规划失败）', () => {
  const overflowing = {
    ...validPlan(),
    intent: { goal: 'x'.repeat(5000), constraints: Array.from({ length: 30 }, () => 'y'.repeat(400)) },
    scene: { ...validPlan().scene, participants: Array.from({ length: 30 }, (_, index) => `p${index}`) },
    characters: Array.from({ length: 20 }, (_, index) => ({ id: `c${index}`, intention: 'z'.repeat(900), knowledgeBoundary: Array.from({ length: 20 }, () => 'k'.repeat(300)) })),
  };
  const result = validatePlan(overflowing);
  assert.equal(result.plan.intent.goal.length, PLAN_LIMITS.goal);
  assert.equal(result.plan.intent.constraints.length, PLAN_LIMITS.constraints);
  assert.ok(result.plan.intent.constraints.every(item => item.length <= PLAN_LIMITS.constraint));
  assert.equal(result.plan.scene.participants.length, PLAN_LIMITS.participants);
  assert.equal(result.plan.characters.length, PLAN_LIMITS.characters);
  assert.ok(result.plan.characters[0].intention.length <= PLAN_LIMITS.intention);
  assert.ok(result.plan.characters[0].knowledgeBoundary.length <= PLAN_LIMITS.knowledgeBoundary);
  // 截断本身不是致命错误，但它被记录下来了
  assert.ok(result.errors.some(error => error.code === 'too-many'));
  assert.equal(result.ok, true, '截断后仍是可用的规划');
});

test('未知字段被丢弃：规划产物只有 schema 里的字段', () => {
  const result = validatePlan({ ...validPlan(), secretNote: '不该被带出去', extra: { deep: true } });
  assert.equal(result.plan.secretNote, undefined);
  assert.equal(result.plan.extra, undefined);
  assert.deepEqual(
    Object.keys(result.plan).sort(),
    ['characters', 'intent', 'operators', 'outputContract', 'scene', 'schemaVersion', 'styleProfile', 'taskType'],
  );
});

test('extractJsonObject 能吃下 ```json 围栏与前后废话', () => {
  const fenced = '好的，规划如下：\n```json\n{"schemaVersion":1,"taskType":"chat"}\n```\n以上。';
  const result = extractJsonObject(fenced);
  assert.equal(result.ok, true);
  assert.equal(result.value.taskType, 'chat');

  const unlabeled = '```\n{"schemaVersion":1}\n```';
  assert.equal(extractJsonObject(unlabeled).ok, true);

  const bare = '{"schemaVersion":1,"intent":{"goal":"x"}}';
  assert.equal(extractJsonObject(bare).ok, true);
});

test('extractJsonObject 在纯文本、空串、数组上安全失败（不抛错）', () => {
  assert.equal(extractJsonObject('抱歉，我不能输出 JSON。').ok, false);
  assert.equal(extractJsonObject('').ok, false);
  assert.equal(extractJsonObject(null).ok, false);
  assert.equal(extractJsonObject('[1,2,3]').ok, false);
  assert.equal(extractJsonObject('{"broken": ').ok, false);
});

test('extractJsonObject 取第一个可解析的对象，不被前面的坏括号带偏', () => {
  const result = extractJsonObject('{不是json} 然后 {"schemaVersion":1,"taskType":"task"}');
  assert.equal(result.ok, true);
  assert.equal(result.value.taskType, 'task');
});

test('Planner 提示词：只输出 JSON、不写正文、不调用工具', () => {
  const { system } = buildPlannerPrompt({
    route: { mode: 'roleplay', intensity: 'immersive', profile: 'roleplay-narrative', operators: { DIG: 'on' } },
    persona: '设定', memoryContext: '', workingMemory: '', userMessage: '「你回来了。」',
    config: { planner: { maxInputChars: 8000 } },
  });
  assert.match(system, /只输出一个 JSON 对象/);
  assert.match(system, /不写正文/);
  assert.match(system, /不调用任何工具/);
  assert.match(system, /不要为了填满而编内容/);
});

test('Planner 提示词：input 长度永不超过 maxInputChars，且始终保留当前用户消息', () => {
  for (const maxInputChars of [1000, 2000, 8000]) {
    const { input } = buildPlannerPrompt({
      route: { mode: 'roleplay', intensity: 'immersive', profile: 'roleplay-narrative', operators: {} },
      persona: '角色设定'.repeat(4000),
      memoryContext: '长期记忆'.repeat(4000),
      workingMemory: '工作记忆'.repeat(2000),
      userMessage: '「你今天怎么回来得这么晚」',
      config: { planner: { maxInputChars } },
    });
    assert.ok(input.length <= maxInputChars, `input ${input.length} > ${maxInputChars}`);
    assert.ok(input.includes('你今天怎么回来得这么晚'), '当前用户消息必须保留');
  }
});

test('Planner 提示词：空上下文也能用，未知字段要求留空而不是编造', () => {
  const { system, input } = buildPlannerPrompt({
    route: { mode: 'chat', intensity: 'normal', profile: 'chat', operators: {} },
    persona: '', memoryContext: '', workingMemory: '', userMessage: '早',
    config: { planner: { maxInputChars: 8000 } },
  });
  assert.match(system, /不知道的字段留空/);
  assert.match(input, /mode=chat/);
  assert.ok(input.length <= 8000);
});

test('格式修复提示词：带上失败项与上一次的输出，长度也受上限约束', () => {
  const { system, input } = buildRepairPrompt({
    rawText: '{"schemaVersion":1,"intent":{}}',
    errors: [{ path: 'intent.goal', code: 'missing' }],
    config: { planner: { maxInputChars: 2000 } },
  });
  assert.match(system, /只输出修正后的 JSON/);
  assert.match(input, /intent\.goal: missing/);
  assert.match(input, /schemaVersion/);
  assert.ok(input.length <= 2000);
});

test('renderPlanForWriter：紧凑、非空字段才输出、长度 ≤ 900', () => {
  const rendered = renderPlanForWriter(validatePlan(validPlan()).plan);
  assert.ok(rendered.length > 0);
  assert.ok(rendered.length <= PLAN_LIMITS.renderedChars);
  assert.match(rendered, /目标：接住刚才的场景/);
  assert.match(rendered, /场景：时间 深夜/);
  assert.match(rendered, /ARC（done）/);
  assert.match(rendered, /下一步 把茶放在桌上/);
  assert.match(rendered, /认知边界/);
});

test('renderPlanForWriter：空规划返回空串，skipped 的算子不出现', () => {
  assert.equal(renderPlanForWriter(null), '');
  assert.equal(renderPlanForWriter({}), '');
  const minimal = validatePlan({
    schemaVersion: 1, taskType: 'chat',
    intent: { goal: '回一句' },
    operators: { DIG: { status: 'done', summary: '' }, LORE: { status: 'skipped' }, ARC: { status: 'not-needed' }, REVIEW: { status: 'not-needed' } },
  }).plan;
  const rendered = renderPlanForWriter(minimal);
  assert.match(rendered, /目标：回一句/);
  assert.doesNotMatch(rendered, /LORE/);
  assert.doesNotMatch(rendered, /ARC/);
  assert.doesNotMatch(rendered, /REVIEW/);
});

test('renderPlanForWriter 永远不超过 900 字（极端输入也一样）', () => {
  const huge = validatePlan({
    ...validPlan(),
    intent: { goal: 'g'.repeat(240), constraints: Array.from({ length: 6 }, () => 'c'.repeat(120)) },
    scene: { ...validPlan().scene, knownFacts: Array.from({ length: 8 }, () => 'k'.repeat(120)), unknowns: Array.from({ length: 6 }, () => 'u'.repeat(120)) },
    characters: Array.from({ length: 5 }, (_, index) => ({ id: `c${index}`, intention: 'i'.repeat(160), attitude: 'a'.repeat(80), knowledgeBoundary: Array.from({ length: 6 }, () => 'b'.repeat(80)) })),
  }).plan;
  assert.ok(renderPlanForWriter(huge).length <= PLAN_LIMITS.renderedChars);
});

test('规划只是内部产物：渲染文本里不出现 JSON 结构或代码围栏', () => {
  const rendered = renderPlanForWriter(validatePlan(validPlan()).plan);
  assert.doesNotMatch(rendered, /```/);
  assert.doesNotMatch(rendered, /"schemaVersion"/);
  assert.doesNotMatch(rendered, /^\s*\{/m);
});

test('枚举常量与合同一致', () => {
  assert.deepEqual([...PLAN_ENUMS.taskType], ['chat', 'companion', 'roleplay', 'task']);
  assert.deepEqual([...PLAN_ENUMS.styleProfile], ['chat', 'companion', 'implicit-roleplay', 'roleplay-narrative', 'task']);
  assert.deepEqual([...PLAN_ENUMS.format], ['natural_prose', 'structured_answer', 'short_reply']);
  assert.deepEqual([...PLAN_ENUMS.operatorStatus], ['done', 'skipped', 'not-needed']);
  assert.equal(PLAN_SCHEMA_VERSION, 1);
});

test('validatePlan 是纯函数：同输入同输出，且不改动入参', () => {
  const input = validPlan();
  const snapshot = JSON.stringify(input);
  const first = validatePlan(input);
  const second = validatePlan(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot);
  assert.notEqual(first.plan, input, '返回的是安全副本，不是入参本身');
});
