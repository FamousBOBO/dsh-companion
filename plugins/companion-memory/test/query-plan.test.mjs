// 短句查询构造的专项测试（计划 §5 A.2 / A.3，必测用例 1、2、5）。
//
// 全部是纯函数用例：没有数据库、没有网络、没有真实记忆。fixture 就写在文件里，
// 断言只针对「构造出了什么」与「丢了什么、为什么丢」。
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildQueryPlan, anchorRejection, QUERY_PLAN_VERSION } from '../lib/query-plan.mjs';

const NOW = Date.parse('2026-03-07T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** 一条「用户确认过的」锚点，统一按 UTC ISO 给时间。 */
function userAnchor(text, extra = {}) {
  return {
    role: 'user',
    text,
    scope: 'user_global',
    realityLevel: 'explicit_user_statement',
    occurredAt: new Date(NOW - HOUR).toISOString(),
    at: NOW - HOUR,
    ref: 'evt_test_1',
    ...extra,
  };
}

test('问候「早」给出空主题，绝不推断「刚睡醒 / 刚起床」这类未确认事实', () => {
  for (const greeting of ['早', '早安', '早上好', '早啊', '在吗', '嗯嗯', '好的', '哈哈']) {
    const plan = buildQueryPlan({ query: greeting, anchors: [userAnchor('用户陪父亲去医院复诊')], now: NOW });
    assert.equal(plan.source, 'weak-intent', `${greeting} 应判为弱意图`);
    assert.equal(plan.weakIntent, true);
    assert.equal(plan.topicText, '', `${greeting} 不允许构造出任何主题`);
    assert.equal(plan.matchText, '', `${greeting} 不允许构造承接查询`);
    assert.deepEqual(plan.entities, [], `${greeting} 不允许带出实体`);
    assert.deepEqual(plan.events, [], `${greeting} 不允许带出事件`);
    // 关键负例：词面不得暗示「刚睡醒」「刚起床」。
    const serialized = JSON.stringify(plan);
    for (const forbidden of ['睡醒', '起床', '刚睡', '刚起', '醒了', '睡着']) {
      assert.ok(!serialized.includes(forbidden), `问候不得推演出「${forbidden}」`);
    }
  }
  assert.equal(buildQueryPlan({ query: '早', now: NOW }).dropped['weak-intent-empty-topic'], 1);
});

test('真实主题不会被误判成弱意图（「早」只有整句都是问候才生效）', () => {
  const coffee = buildQueryPlan({ query: '早上想喝咖啡', now: NOW });
  assert.equal(coffee.source, 'raw');
  assert.equal(coffee.weakIntent, false);
  assert.equal(coffee.topicText, '早上想喝咖啡');

  const duck = buildQueryPlan({ query: '北京的烤鸭', now: NOW });
  assert.equal(duck.source, 'raw');
});

test('承接链：用户说「陪父亲复诊」→ 下一句「他太顽固」承接父亲与复诊这个实体事件', () => {
  const plan = buildQueryPlan({
    query: '他太顽固',
    anchors: [userAnchor('今天我陪父亲去医院复诊，医生说下周还要复查')],
    now: NOW,
  });
  assert.equal(plan.source, 'continuation', '代词 + 可用锚点必须走承接');
  assert.equal(plan.anaphora, true);
  assert.equal(plan.anchorCount, 1);
  // 第一轮仍用原句，第二轮用锚点补上下文。
  assert.equal(plan.topicText, '他太顽固');
  assert.ok(plan.matchText, '承接必须给出第二轮查询文本');
  for (const needle of ['父亲', '复诊', '医院']) {
    assert.ok(plan.matchText.includes(needle), `承接查询必须含「${needle}」，实际：${plan.matchText}`);
  }
  assert.ok(plan.entities.some(token => token.includes('父亲') || token.includes('复诊')));
  assert.equal(plan.events.length, 1);
  assert.equal(plan.events[0].ref, 'evt_test_1');
  assert.ok(plan.events[0].terms.length > 0);
});

test('承接只认用户自己说过的：助手的话、推断、旧摘要、机器人行为、剧情设定全部丢弃并计数', () => {
  const anchors = [
    userAnchor('用户陪父亲去医院复诊'),
    userAnchor('助手猜用户最近熬夜了', { role: 'assistant', ref: 'evt_assistant' }),
    userAnchor('推断：用户父亲脾气不好', {
      role: 'memory', realityLevel: 'inferred', scope: 'user_global', ref: 'mem_inferred',
    }),
    userAnchor('旧库摘要：用户和父亲吵过架', {
      role: 'memory', realityLevel: 'imported_summary', ref: 'mem_summary',
    }),
    userAnchor('机器人主动发了早安', {
      role: 'memory', realityLevel: 'bot_action', scope: 'persona_self', ref: 'mem_bot',
    }),
    userAnchor('剧情里父亲是骑士团长', {
      role: 'memory', realityLevel: 'roleplay_fiction', scope: 'roleplay_world', ref: 'mem_fiction',
    }),
    userAnchor('未确认的聊天原话：父亲很严厉', {
      role: 'memory', realityLevel: 'user_utterance_not_verified_fact', ref: 'mem_unverified',
    }),
  ];
  const plan = buildQueryPlan({ query: '他太顽固', anchors, now: NOW });
  assert.equal(plan.source, 'continuation');
  assert.equal(plan.anchorCount, 1, '只有用户确认的那一条能进承接');
  assert.deepEqual(plan.events.map(event => event.ref), ['evt_test_1']);
  const serialized = JSON.stringify(plan);
  for (const forbidden of ['熬夜', '脾气不好', '吵过架', '早安', '骑士团长', '很严厉']) {
    assert.ok(!serialized.includes(forbidden), `非用户确认内容不得进入构造结果：${forbidden}`);
  }
  assert.equal(plan.dropped['assistant-utterance'], 1);
  assert.equal(plan.dropped['inferred-reality'], 1);
  assert.equal(plan.dropped['imported-summary'], 1);
  assert.equal(plan.dropped['bot-action'], 1);
  assert.equal(plan.dropped['roleplay-fiction'], 1);
  assert.equal(plan.dropped['unverified-utterance'], 1);
});

test('没有可信锚点时不做承接，退回原句，并记录原因', () => {
  const plan = buildQueryPlan({
    query: '他太顽固',
    anchors: [userAnchor('助手说父亲很固执', { role: 'assistant' })],
    now: NOW,
  });
  assert.equal(plan.source, 'raw', '没有用户确认的锚点就不许承接');
  assert.equal(plan.topicText, '他太顽固');
  assert.equal(plan.matchText, '');
  assert.deepEqual(plan.events, []);
  assert.equal(plan.dropped['assistant-utterance'], 1);
  assert.ok(plan.dropped['no-confirmed-anchor'] >= 1);
});

test('锚点超出时间窗口就作废（不做跨天的承接）', () => {
  const stale = userAnchor('今天我陪父亲去医院复诊', { at: NOW - 24 * HOUR, occurredAt: new Date(NOW - 24 * HOUR).toISOString() });
  const plan = buildQueryPlan({ query: '他太顽固', anchors: [stale], now: NOW, anchorWindowMs: 6 * HOUR });
  assert.equal(plan.source, 'raw');
  assert.equal(plan.dropped['stale-anchor'], 1);
  assert.equal(anchorRejection(stale, NOW, 6 * HOUR), 'stale-anchor');
  // 不限窗口时同一条锚点仍然可用。
  assert.equal(anchorRejection(stale, NOW, 0), '');
});

test('显式历史查询：主题为空但给兜底标记，保证门槛提高后不会全空', () => {
  for (const question of ['上次我说过什么', '你还记得吗', '我们之前聊过什么', '我以前提过什么来着']) {
    const plan = buildQueryPlan({ query: question, now: NOW });
    assert.equal(plan.source, 'explicit-history', `${question} 应判为显式历史查询`);
    assert.equal(plan.explicitHistory, true);
    assert.equal(plan.topicText, '', `${question} 不构造具体主题`);
    assert.equal(plan.historyFallback, true, `${question} 必须允许兜底`);
  }
  const disabled = buildQueryPlan({ query: '上次我说过什么', now: NOW, historyFallbackEnabled: false });
  assert.equal(disabled.historyFallback, false);
  assert.equal(disabled.dropped['history-fallback-disabled'], 1);
});

test('带真实主题的「记得」问句仍然走原句检索（不被元记忆判定吞掉）', () => {
  const plan = buildQueryPlan({ query: '你还记得我平时喜欢喝什么吗', now: NOW });
  assert.equal(plan.source, 'raw');
  assert.equal(plan.topicText, '你还记得我平时喜欢喝什么吗');
  assert.equal(plan.explicitHistory, false);
});

test('开关与空输入兼容旧行为', () => {
  // 关闭查询构造：原句直通，等价旧版。
  const off = buildQueryPlan({ query: '他太顽固', anchors: [userAnchor('陪父亲复诊')], enabled: false, now: NOW });
  assert.equal(off.source, 'raw');
  assert.equal(off.topicText, '他太顽固');
  assert.equal(off.matchText, '');
  assert.equal(off.weakIntent, false);

  // 关闭承接：代词句不再构造第二轮。
  const noContinuation = buildQueryPlan({
    query: '他太顽固', anchors: [userAnchor('陪父亲复诊')], continuationEnabled: false, now: NOW,
  });
  assert.equal(noContinuation.source, 'raw');
  assert.equal(noContinuation.matchText, '');
  assert.equal(noContinuation.dropped['continuation-disabled'], 1);

  // 空 / 缺失查询：保持「最近重要记忆」路径。
  for (const query of ['', '   ', undefined, null]) {
    const plan = buildQueryPlan({ query, now: NOW });
    assert.equal(plan.source, 'raw');
    assert.equal(plan.topicText, '');
  }
  // 无参数调用也不能炸。
  assert.equal(buildQueryPlan().version, QUERY_PLAN_VERSION);
});

test('构造结果只含计数与短词元，不含整句正文副本', () => {
  const plan = buildQueryPlan({
    query: '他太顽固',
    anchors: [userAnchor('用户陪父亲去医院复诊，医生说下周还要复查')],
    now: NOW,
  });
  const serialized = JSON.stringify(plan);
  assert.ok(!serialized.includes('医生说下周还要复查'), '整句原文不得进入构造结果');
  for (const token of plan.entities) assert.ok(token.length <= 12, `词元过长：${token}`);
  for (const value of Object.values(plan.dropped)) assert.equal(typeof value, 'number');
});
