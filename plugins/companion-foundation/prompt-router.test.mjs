import test from 'node:test';
import assert from 'node:assert/strict';

import { routeTurn, routeOperators, profileFor, initialState, MODES, PROFILES } from './prompt-router.mjs';

// 路由是整件事最容易做歪的地方。这里的每条断言都对应任务书 §6 的一条硬性要求：
// 显式优先、上下文连续、单条消息不能直接进沉浸、抽象情绪不等于 RP、不同 session 互不影响。

const baseConfig = {
  interactionMode: 'auto',
  thinkingMode: { chat: 'guided', companion: 'guided', roleplay: 'guided', task: 'guided' },
  routing: { maxHistoryTurns: 12, carryOverTurns: 6 },
};

const route = (message, extra = {}) => routeTurn({
  config: baseConfig,
  sessionId: 's1',
  message,
  history: [],
  now: 1_760_000_000_000,
  ...extra,
}).route;

test('profile 映射是唯一的：mode+intensity ⇒ 五档之一', () => {
  assert.equal(profileFor('chat', 'normal'), 'chat');
  assert.equal(profileFor('companion', 'normal'), 'companion');
  assert.equal(profileFor('task', 'normal'), 'task');
  assert.equal(profileFor('roleplay', 'normal'), 'implicit-roleplay');
  assert.equal(profileFor('roleplay', 'subtle'), 'implicit-roleplay');
  assert.equal(profileFor('roleplay', 'immersive'), 'roleplay-narrative');
  for (const mode of MODES) {
    for (const intensity of ['normal', 'subtle', 'immersive']) {
      assert.ok(PROFILES.includes(profileFor(mode, intensity)), `${mode}/${intensity}`);
    }
  }
});

test('算子激活表与合同 §4.2 逐字一致', () => {
  assert.deepEqual(routeOperators('chat', 'normal'), { DIG: 'on', LORE: 'off', ARC: 'off', REVIEW: 'optional' });
  assert.deepEqual(routeOperators('companion', 'normal'), { DIG: 'on', LORE: 'optional', ARC: 'off', REVIEW: 'optional' });
  assert.deepEqual(routeOperators('roleplay', 'subtle'), { DIG: 'on', LORE: 'optional', ARC: 'light', REVIEW: 'optional' });
  assert.deepEqual(routeOperators('roleplay', 'immersive'), { DIG: 'on', LORE: 'on', ARC: 'on', REVIEW: 'on' });
  assert.deepEqual(routeOperators('task', 'normal'), { DIG: 'on', LORE: 'optional', ARC: 'off', REVIEW: 'optional' });
  // 返回值是拷贝：调用方改了不影响下一次
  const copy = routeOperators('roleplay', 'immersive');
  copy.DIG = 'off';
  assert.equal(routeOperators('roleplay', 'immersive').DIG, 'on');
});

test('普通聊天：问候与日常小事都停在 chat/normal', () => {
  assert.equal(route('早啊').mode, 'chat');
  assert.equal(route('今天吃了碗面').mode, 'chat');
  assert.equal(route('哈哈你说得对').mode, 'chat');
  assert.equal(route('今天吃了碗面').intensity, 'normal');
});

test('情感陪伴：情绪表达走 companion，而不是 chat', () => {
  const result = route('今天真的好累，什么都不想干');
  assert.equal(result.mode, 'companion');
  assert.equal(result.intensity, 'normal');
  assert.equal(result.profile, 'companion');
  assert.equal(route('我最近很焦虑').mode, 'companion');
});

test('知识问答/技术请求走 task，且不带扮演规则', () => {
  assert.equal(route('帮我分析一下这段代码为什么报错').mode, 'task');
  assert.equal(route('解释一下 `npm ci` 和 install 的区别').mode, 'task');
  assert.equal(route('这个报错怎么修').mode, 'task');
  const result = route('帮我看看这个函数的依赖');
  assert.equal(result.mode, 'task');
  assert.equal(result.profile, 'task');
  assert.equal(result.operators.ARC, 'off');
});

test('纯疑问词不算任务：场景内的一句问话不会被降级成 task', () => {
  const result = route('你今天怎么回来得这么晚');
  assert.notEqual(result.mode, 'task');
});

test('明确开始 RP：显式控制立刻进 immersive', () => {
  const result = routeTurn({
    config: baseConfig, sessionId: 's1', message: '我们开始角色扮演吧', history: [], now: 1,
    explicit: { mode: 'roleplay' },
  });
  assert.equal(result.route.mode, 'roleplay');
  assert.equal(result.route.intensity, 'immersive');
  assert.equal(result.route.profile, 'roleplay-narrative');
  assert.equal(result.route.source, 'explicit');
  assert.equal(result.route.operators.ARC, 'on');
  assert.equal(result.route.operators.LORE, 'on');
});

test('显式控制永远优先于自主判断（强制 chat 时技术问题也不进 task）', () => {
  const result = routeTurn({
    config: baseConfig, sessionId: 's1', message: '解释一下这个函数', history: [], now: 1,
    explicit: { mode: 'chat' },
  });
  assert.equal(result.route.mode, 'chat');
  assert.equal(result.route.source, 'explicit');
});

test('配置 interactionMode 也算显式控制，source=override', () => {
  const result = routeTurn({
    config: { ...baseConfig, interactionMode: 'companion' }, sessionId: 's1', message: '这个函数报错怎么修', history: [], now: 1,
  });
  assert.equal(result.route.mode, 'companion');
  assert.equal(result.route.source, 'override');
});

test('单条消息永远不能得出 immersive（只有角色扮演暗示时最多 subtle）', () => {
  const samples = [
    '「你回来了。」她把门轻轻带上',
    '*抬头看你一眼* 外面下雨了',
    '「……你终于来了。」',
    '"你怎么才回来？" 他把伞放在门口',
  ];
  for (const sample of samples) {
    const result = route(sample);
    assert.notEqual(result.intensity, 'immersive', `单条消息不该 immersive: ${sample}`);
    assert.equal(result.mode, 'roleplay', `角色扮演暗示应当被识别: ${sample}`);
    assert.equal(result.intensity, 'subtle');
  }
});

test('没有明确指令但上下文已形成场景：承接上文时可以进 immersive', () => {
  const previous = {
    ...initialState('s1'),
    mode: 'roleplay', intensity: 'immersive', profile: 'roleplay-narrative', sceneTurns: 3, turns: 5,
  };
  const result = routeTurn({
    config: baseConfig, sessionId: 's1', message: '「我把茶放在桌上了。」',
    history: [
      { role: 'user', text: '「你今天回来得真晚。」' },
      { role: 'assistant', text: '「路上耽搁了。」' },
    ],
    previousState: previous,
    now: 1,
  });
  assert.equal(result.route.mode, 'roleplay');
  assert.equal(result.route.intensity, 'immersive');
  assert.equal(result.route.profile, 'roleplay-narrative');
  assert.ok(result.route.evidence.some(code => code.startsWith('carry-over')));
});

test('subtle → immersive 的自然过渡：前一轮 subtle 承接多轮场景后仍保持，不会跳档', () => {
  const previous = { ...initialState('s1'), mode: 'roleplay', intensity: 'subtle', profile: 'implicit-roleplay', sceneTurns: 2, turns: 4 };
  const result = routeTurn({
    config: baseConfig, sessionId: 's1', message: '*把杯子往你那边推了推*',
    history: [{ role: 'user', text: '「再坐一会儿吧。」' }, { role: 'assistant', text: '「好。」' }],
    previousState: previous,
    now: 1,
  });
  assert.equal(result.route.mode, 'roleplay');
  assert.equal(result.route.intensity, 'subtle', '承接不等于自动升级成 immersive');
});

test('RP 连续互动后主动退出：普通消息先降档、再淡出，不清除现场', () => {
  let state = { ...initialState('s1'), mode: 'roleplay', intensity: 'immersive', profile: 'roleplay-narrative', sceneTurns: 4, turns: 6 };
  // 前两次走神：允许场景自然停顿，强度不变。
  for (const now of [1, 2]) {
    const idle = routeTurn({ config: baseConfig, sessionId: 's1', message: '嗯', history: [], previousState: state, now });
    assert.equal(idle.route.mode, 'roleplay', '一条普通消息不清除稳定 RP 状态');
    assert.equal(idle.route.intensity, 'immersive');
    state = idle.state;
  }
  // 第三次：降一档到轻度沉浸，而不是直接掐断。
  const third = routeTurn({ config: baseConfig, sessionId: 's1', message: '好', history: [], previousState: state, now: 3 });
  assert.equal(third.route.mode, 'roleplay');
  assert.equal(third.route.intensity, 'subtle');
  assert.ok(third.route.evidence.includes('decay:immersive-to-subtle'));
  // 继续走神：自然淡出，但现场存进 resume，之后还能接回来。
  const fourth = routeTurn({ config: baseConfig, sessionId: 's1', message: '好的', history: [], previousState: third.state, now: 4 });
  assert.notEqual(fourth.route.mode, 'roleplay', '持续走神后自然淡出');
  assert.equal(fourth.route.intensity, 'normal');
  assert.deepEqual(fourth.state.resume, { mode: 'roleplay', intensity: 'subtle' });

  // 淡出后重新出现结构信号：能接回轻度沉浸。
  const resumed = routeTurn({ config: baseConfig, sessionId: 's1', message: '「刚才你说到哪儿了。」', history: [], previousState: fourth.state, now: 5 });
  assert.equal(resumed.route.mode, 'roleplay');
  assert.equal(resumed.route.intensity, 'subtle');
  assert.ok(resumed.route.evidence.includes('resume:scene'));
});

test('暂时切技术问题：进 task 但保留 resume，任务结束后能自然恢复', () => {
  const scene = { ...initialState('s1'), mode: 'roleplay', intensity: 'immersive', profile: 'roleplay-narrative', sceneTurns: 2, turns: 3 };
  const during = routeTurn({ config: baseConfig, sessionId: 's1', message: '等一下，这个报错怎么修', history: [], previousState: scene, now: 1 });
  assert.equal(during.route.mode, 'task');
  assert.deepEqual(during.state.resume, { mode: 'roleplay', intensity: 'immersive' });

  const after = routeTurn({
    config: baseConfig, sessionId: 's1', message: '「刚才说到哪儿了。」',
    history: [], previousState: during.state, now: 2,
  });
  assert.equal(after.route.mode, 'roleplay', '有现场信号时自然恢复');
  assert.equal(after.state.resume, null);
});

test('讨论 RP 系统本身仍然是 task，不是 RP', () => {
  const result = route('分析一下酒馆的角色扮演系统是怎么实现的');
  assert.equal(result.mode, 'task');
  assert.equal(result.intensity, 'normal');
});

test('只有抽象情绪表达、没有场景证据：走 companion，绝不误判成 RP', () => {
  const samples = [
    '如果那天我没有离开，你会不会挽留我？',
    '你有没有想过，要是当初我留下会怎样',
    '我有时候会想，是不是我太敏感了',
  ];
  for (const sample of samples) {
    const result = route(sample);
    assert.equal(result.mode, 'companion', `抽象情绪不是 RP: ${sample}`);
    assert.equal(result.intensity, 'normal');
    assert.ok(result.evidence.some(code => code === 'bounded:abstract-emotion-not-roleplay'));
  }
});

test('普通暧昧交流 ≠ 情景扮演：没有结构信号就停在 chat/companion', () => {
  assert.equal(route('我有点想你').mode, 'companion');
  assert.equal(route('你今天真好看').mode, 'chat');
});

test('不同 Session 状态隔离：一个会话的 RP 不影响另一个', () => {
  const a = routeTurn({ config: baseConfig, sessionId: 'a', message: '我们开始角色扮演吧', history: [], now: 1, explicit: { mode: 'roleplay' } });
  const b = routeTurn({ config: baseConfig, sessionId: 'b', message: '今天吃了碗面', history: [], previousState: initialState('b'), now: 1 });
  assert.equal(a.route.mode, 'roleplay');
  assert.equal(b.route.mode, 'chat');
  assert.equal(b.route.intensity, 'normal');
  assert.equal(a.state.sessionId, 'a');
  assert.equal(b.state.sessionId, 'b');
});

test('state 是纯函数式推进：同一输入 + 同一前态 ⇒ 同一结果，且不改动前态', () => {
  const previous = { ...initialState('s1'), mode: 'roleplay', intensity: 'subtle', turns: 2, sceneTurns: 1 };
  const frozen = JSON.stringify(previous);
  const one = routeTurn({ config: baseConfig, sessionId: 's1', message: '「嗯。」', history: [], previousState: previous, now: 1234 });
  const two = routeTurn({ config: baseConfig, sessionId: 's1', message: '「嗯。」', history: [], previousState: previous, now: 1234 });
  assert.deepEqual(one.route, two.route);
  assert.deepEqual(one.state, two.state);
  assert.equal(JSON.stringify(previous), frozen, '前态不可被修改');
  assert.equal(one.state.updatedAt, new Date(1234).toISOString());
});

test('diagnostics 只带码与计数，不带原文', () => {
  const message = '「你今天回来得真晚。」';
  const result = routeTurn({ config: baseConfig, sessionId: 's1', message, history: [], now: 1 });
  const serialized = JSON.stringify(result.diagnostics);
  assert.doesNotMatch(serialized, /回来得真晚/);
  assert.ok(result.diagnostics.signals.length >= 1);
  assert.match(result.diagnostics.reason, /^(explicit|override|carry-over|continuity|default):/);
});

test('thinkingMode 取自配置的场景值；普通聊天不会被自动拉进 strict', () => {
  const guided = route('早啊');
  assert.equal(guided.thinkingMode, 'guided');
  const strictChat = routeTurn({
    config: { ...baseConfig, thinkingMode: { ...baseConfig.thinkingMode, chat: 'strict' } },
    sessionId: 's1', message: '早啊', history: [], now: 1,
  });
  // 路由只反映配置；"普通聊天不自动 strict"的钳制由引擎负责（合同 §16.C）。
  assert.equal(strictChat.route.thinkingMode, 'strict');
});

test('代码围栏是最强的任务信号，压过任何场景暗示', () => {
  const result = route('「帮我看这个」\n```js\nconst a = 1;\n```');
  assert.equal(result.mode, 'task');
});

test('maxHistoryTurns 生效：超出上限的历史不会改变结论', () => {
  const history = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: '「多说几句。」' }));
  const result = routeTurn({ config: baseConfig, sessionId: 's1', message: '嗯', history, previousState: initialState('s1'), now: 1 });
  assert.ok(result.diagnostics.historyTurns <= baseConfig.routing.maxHistoryTurns);
});
