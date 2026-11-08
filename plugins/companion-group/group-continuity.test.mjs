import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_CHAT_CONDUCT,
  GROUP_CONTINUITY_EMPTY,
  GROUP_CONTINUITY_ITEM_MAX_CHARS,
  GROUP_CONTINUITY_MAX_CHARS,
  GROUP_CONTINUITY_MAX_ITEMS,
  GROUP_CONTINUITY_ORDER,
  GROUP_CONTINUITY_SECTION_NAME,
  GROUP_CONTINUITY_SERVICE_NAME,
  buildGroupContinuitySection,
  groupContinuityInputOf,
  hasGroupContinuityService,
} from './group-continuity.mjs';
import { apply as persona } from './index.mjs';
import { GROUP_ALLOWED_TOOLS } from './core.mjs';

// 固定时间戳：用例不依赖宿主时钟（渲染用本地 HH:MM，这里按本地时间构造当天的时间点）。
const at = (hh, mm) => new Date(2026, 10, 8, hh, mm, 0, 0).getTime();
const item = (text, hh, mm, kind = 'agent_reply') => ({ text, atMs: at(hh, mm), kind });
const EMPTY_INPUT = { recentSelf: [], topic: null, recentlyMentioned: [] };

/** 挂一个最小 ctx，拿到注册的 section。 */
function mount(ctxExtra = {}) {
  const sections = [];
  persona({
    tools: { guard() {}, restrict() {} },
    systemPrompt: { section(value) { sections.push(value); } },
    on() {},
    ...ctxExtra,
  });
  return { sections, continuity: sections.find(s => s.name === GROUP_CONTINUITY_SECTION_NAME) };
}

test('empty input says so plainly and invents nothing', () => {
  const empty = buildGroupContinuitySection(EMPTY_INPUT);
  assert.equal(empty, GROUP_CONTINUITY_EMPTY);
  assert.match(empty, /还没有记录/);
  assert.ok(empty.length <= GROUP_CONTINUITY_MAX_CHARS);
  // 明确否认记忆，而不是留一句可以被模型自由发挥的空白。
  assert.match(empty, /不要假装记得/);
  // 不编造内容：没有具体时间、没有列表项。
  assert.equal(/\d{2}:\d{2}/.test(empty), false, 'no fabricated clock');
  assert.equal(empty.includes('- '), false, 'no fabricated list items');
  // 缺省 / 形状不对的参数一律当「没有记录」，不抛。
  for (const input of [undefined, null, {}, [], 'x', 0, { recentSelf: 'nope' }, { recentSelf: [null, 3, {}] }]) {
    assert.equal(buildGroupContinuitySection(input), GROUP_CONTINUITY_EMPTY, String(input));
  }
});

test('records render in clock order with kind labels, newest last, capped by count', () => {
  const text = buildGroupContinuitySection({
    recentSelf: [item('先说一句', 21, 5), item('主动说的', 21, 12, 'proactive_message'), item('最后一句', 21, 40)],
    topic: '在聊晚饭吃什么',
    recentlyMentioned: ['小王', '小李'],
  });
  assert.ok(text.length <= GROUP_CONTINUITY_MAX_CHARS);
  assert.ok(text.includes('21:05 回复：先说一句'));
  assert.ok(text.includes('21:12 主动发言：主动说的'));
  assert.ok(text.includes('21:40 回复：最后一句'));
  assert.ok(text.includes('当前话题：在聊晚饭吃什么'));
  assert.ok(text.includes('最近被提到：小王、小李'));
  assert.ok(text.indexOf('21:05') < text.indexOf('21:12'));
  assert.ok(text.indexOf('21:12') < text.indexOf('21:40'));
  // 只保留最后 MAX_ITEMS 条。
  const many = Array.from({ length: 12 }, (_, i) => item('第' + i + '句', 20, i));
  const kept = buildGroupContinuitySection({ recentSelf: many, topic: null, recentlyMentioned: [] });
  assert.equal(kept.split('\n').filter(line => line.startsWith('- ')).length, GROUP_CONTINUITY_MAX_ITEMS);
  assert.ok(kept.includes('第11句'), 'newest kept');
  assert.equal(kept.includes('第0句'), false, 'oldest dropped by count');
  // 乱序输入也要按时间排（服务顺序错了比少一条更糟）。
  const shuffled = buildGroupContinuitySection({ recentSelf: [item('后', 22, 30), item('前', 22, 10)], topic: null, recentlyMentioned: [] });
  assert.ok(shuffled.indexOf('22:10') < shuffled.indexOf('22:30'));
});

test('over-long input drops the oldest records first and never exceeds 400 chars', () => {
  const longText = '很长的句子'.repeat(40); // 200 字一条
  const rows = Array.from({ length: 8 }, (_, i) => item(String(i) + '号' + longText, 10 + i, 0));
  const text = buildGroupContinuitySection({ recentSelf: rows, topic: '一个不短的话题'.repeat(3), recentlyMentioned: ['甲', '乙'] });
  assert.ok(text.length <= GROUP_CONTINUITY_MAX_CHARS, 'length ' + text.length);
  assert.ok(text.includes('7号'), 'newest survived');
  assert.equal(text.includes('0号'), false, 'oldest dropped');
  // 单条正文本身也有上限，一条吃不掉整段。
  const one = buildGroupContinuitySection({ recentSelf: [item('长'.repeat(500), 12, 0)], topic: null, recentlyMentioned: [] });
  assert.ok(one.length <= GROUP_CONTINUITY_MAX_CHARS);
  assert.ok(one.includes('…'), 'per-item clamped');
  assert.ok(one.includes('12:00'), 'time preserved');
  // 只有话题、没有记录：不是「没有记录」，但同样受 400 字约束。
  const topicOnly = buildGroupContinuitySection({ recentSelf: [], topic: '话'.repeat(200), recentlyMentioned: [] });
  assert.ok(topicOnly.length <= GROUP_CONTINUITY_MAX_CHARS);
  assert.notEqual(topicOnly, GROUP_CONTINUITY_EMPTY);
  assert.ok(topicOnly.includes('当前话题'));
});

test('service shape: absent, malformed or throwing degrades to an empty section without throwing', () => {
  for (const service of [undefined, null, 0, 'x', {}, { recentSelf: 1, topic: 2 }, { recentSelf() {}, topic: 'no' }, []]) {
    assert.equal(hasGroupContinuityService(service), false, String(service));
    assert.deepEqual(groupContinuityInputOf(service), EMPTY_INPUT);
    assert.equal(buildGroupContinuitySection(groupContinuityInputOf(service)), GROUP_CONTINUITY_EMPTY);
  }
  const boom = () => { throw new Error('timeline exploded'); };
  assert.deepEqual(groupContinuityInputOf({ recentSelf: boom, topic: boom }), EMPTY_INPUT);
  // 只有一半坏：不交付「半个」输入，整段降级。
  assert.deepEqual(groupContinuityInputOf({ recentSelf: () => [item('不该出现', 9, 0)], topic: boom }), EMPTY_INPUT);
  assert.deepEqual(groupContinuityInputOf({ recentSelf: boom, topic: () => '话题' }), EMPTY_INPUT);
  // 返回值类型不对：不是数组 → 空；topic 不是字符串 → null。
  assert.deepEqual(groupContinuityInputOf({ recentSelf: () => 'nope', topic: () => 42 }), EMPTY_INPUT);
  assert.deepEqual(groupContinuityInputOf({ recentSelf: () => null, topic: () => undefined }), EMPTY_INPUT);
  // 正常服务：拿得到，limit 夹在渲染上限内。
  let asked = null;
  const ok = groupContinuityInputOf({ recentSelf(limit) { asked = limit; return [item('说过的', 8, 30)]; }, topic: () => '天气' });
  assert.equal(ok.topic, '天气');
  assert.equal(ok.recentSelf.length, 1);
  assert.equal(asked, GROUP_CONTINUITY_MAX_ITEMS);
  assert.equal(groupContinuityInputOf({ recentSelf: () => [], topic: () => null }, 999).recentSelf.length, 0);
});

test('the section is companion:group-continuity at order 51, lazily read and failure-proof', () => {
  for (const ctxExtra of [
    {},
    { get: () => undefined },
    { get: () => ({ recentSelf: 'nope' }) },
    { get: () => { throw new Error('registry exploded'); } },
  ]) {
    const { continuity } = mount(ctxExtra);
    assert.equal(continuity.name, GROUP_CONTINUITY_SECTION_NAME);
    assert.equal(continuity.order, GROUP_CONTINUITY_ORDER);
    assert.equal(continuity.interpolate, false, 'literal text: group content must not be interpolated');
    assert.equal(typeof continuity.text, 'function', 'lazy: text is a callback');
    const text = continuity.text();
    assert.ok(text.includes(GROUP_CHAT_CONDUCT), 'conduct survives any service failure');
    assert.ok(text.includes(GROUP_CONTINUITY_EMPTY), 'no fabricated continuity');
  }
  // 服务可用：每次调用都重新问一次服务，拿到的是当下这一份。
  let calls = 0;
  const store = { rows: [item('上次说过的', 19, 0)], topic: '在聊电影' };
  const { continuity } = mount({
    get(name) {
      assert.equal(name, GROUP_CONTINUITY_SERVICE_NAME);
      calls++;
      return { recentSelf: limit => store.rows.slice(-limit), topic: () => store.topic };
    },
  });
  assert.ok(continuity.text().includes('19:00 回复：上次说过的'));
  assert.ok(continuity.text().includes('当前话题：在聊电影'));
  store.rows = [item('第二轮新说的', 19, 30)];
  const second = continuity.text();
  assert.ok(second.includes('第二轮新说的'));
  assert.equal(second.includes('上次说过的'), false, 'lazy: recomputed per assembly');
  assert.equal(calls, 3);
  assert.equal(GROUP_CONTINUITY_ORDER, 51);
  assert.equal(GROUP_CONTINUITY_SECTION_NAME, 'companion:group-continuity');
});

test('the prompt text names no character, so persona stays in config/persona.md', () => {
  const texts = [GROUP_CHAT_CONDUCT, GROUP_CONTINUITY_EMPTY];
  texts.push(buildGroupContinuitySection({ recentSelf: [item('随便一句', 20, 0)], topic: '聊点什么都行', recentlyMentioned: ['某人'] }));
  texts.push(buildGroupContinuitySection(groupContinuityInputOf({ recentSelf: () => [item('随便一句', 20, 0)], topic: () => '聊点什么都行' })));
  const { continuity } = mount({ get: () => ({ recentSelf: () => [item('随便一句', 20, 0)], topic: () => '话题' }) });
  texts.push(continuity.text());

  // 人格段（index.mjs）里那几句角色设定，一个字都不许出现在这一段里。
  for (const forbidden of ['bot', '你是「', '陪伴助手', '性格', '人设', '口癖', '傲娇', '温柔', '元气', '说话风格']) {
    for (const text of texts) assert.equal(text.includes(forbidden), false, 'forbidden ' + forbidden);
  }
  // 反过来：每一条表达约定都在（防止将来被悄悄删掉）。
  for (const rule of ['短句', '口语', '一到两句', '不写小作文', '旁白', '沉默是正常结果', '不重复自己刚说过的话', '争执', '隐私', '钱', '账号', '推测', '不把猜测说成事实']) {
    assert.ok(GROUP_CHAT_CONDUCT.includes(rule), 'conduct must state: ' + rule);
  }
  assert.ok(GROUP_CHAT_CONDUCT.length <= GROUP_CONTINUITY_MAX_CHARS);
  assert.ok(continuity.text().length <= GROUP_CONTINUITY_MAX_CHARS * 2 + 8);
  // 数值契约：整段 400 字、单条 80 字。
  assert.equal(GROUP_CONTINUITY_MAX_CHARS, 400);
  assert.equal(GROUP_CONTINUITY_ITEM_MAX_CHARS, 80);
  // 群聊这一层只加约束，不放开工具。
  assert.ok(GROUP_ALLOWED_TOOLS.includes('qq_message'));
  assert.equal(GROUP_ALLOWED_TOOLS.includes('companion_recall'), false);
});
