// 门 2 生效性测试（计划 §5 A.4）：门 2 的判定必须真的改变注入文本，
// 不能只统计计数。全部为合成记录，不起数据库、不读任何真实记忆。
import assert from 'node:assert/strict';
import test from 'node:test';

import { injectionDecision } from '../lib/injection-gate.mjs';
import {
  CONTEXT_HEADER,
  DEFAULT_BUDGET,
  HINT_VALUE,
  renderContext,
  renderRecallResult,
} from '../lib/render.mjs';
import { formatMoment, truncate } from '../lib/text.mjs';

const NOW = Date.parse('2026-03-07T12:00:00.000Z');
const VIEWER = Object.freeze({ userId: 'user_synth', personaId: 'bot', worldId: '' });

function record(overrides = {}) {
  return {
    id: 'mem_synth_render_1',
    scope: 'user_global',
    kind: 'event',
    subject: 'user',
    value: '合成的示例记忆正文',
    status: 'confirmed',
    userId: 'user_synth',
    personaId: 'bot',
    worldId: '',
    mentionPolicy: 'direct',
    realityLevel: 'explicit_user_statement',
    sourceKind: 'desktop_fact',
    validFrom: '2026-03-01T00:00:00.000Z',
    validTo: null,
    occurredAt: '2026-03-01T08:00:00.000Z',
    ...overrides,
  };
}

/** 旧实现的逐字输出：不经过任何门，直接一行 JSON。 */
function legacyLine(row) {
  return JSON.stringify({
    id: String(row.id),
    type: String(row.kind ?? ''),
    reality: String(row.realityLevel ?? ''),
    at: formatMoment(String(row.occurredAt ?? '')) || '未知',
    policy: String(row.mentionPolicy ?? 'direct'),
    value: truncate(String(row.value ?? ''), 240),
  });
}

function lines(text) {
  if (!text) return [];
  return text.slice(CONTEXT_HEADER.length + 1).split('\n').map(line => JSON.parse(line));
}

test('tone_only 的 bot_action 在 auto 下正文不出现，explicit 才展开', () => {
  const botNote = record({
    id: 'mem_bot_action_1',
    scope: 'persona_self',
    kind: 'bot_action',
    subject: 'bot',
    mentionPolicy: 'tone_only',
    realityLevel: 'bot_action',
    value: '那晚我主动提起了过去那段亲密经历的具体细节',
  });
  assert.equal(injectionDecision(botNote, { viewer: VIEWER, now: NOW, purpose: 'auto' }).render, 'hint');

  const auto = renderContext({ entries: [botNote], purpose: 'auto', viewer: VIEWER, now: NOW });
  assert.doesNotMatch(auto, /主动提起/, 'auto 注入不得出现正文关键内容');
  assert.doesNotMatch(auto, /亲密经历的具体细节/);
  const autoLine = lines(auto)[0];
  assert.equal(autoLine.policy, 'tone_only', '仍然如实标注策略');
  assert.equal(autoLine.value, HINT_VALUE, '只给固定提示，不引用正文');

  const explicit = renderContext({ entries: [botNote], purpose: 'explicit', viewer: VIEWER, now: NOW });
  assert.match(explicit, /主动提起/, '用户明确来问时给正文');
  assert.equal(lines(explicit)[0].value, truncate(botNote.value, 240));
});

test('推断内容（inferred）在 auto 下只给提示，explicit 才给正文', () => {
  const inferred = record({
    id: 'mem_inferred_1',
    mentionPolicy: 'direct',
    realityLevel: 'inferred',
    value: '助手推断：用户最近压力很大',
  });
  const auto = renderContext({ entries: [inferred], purpose: 'auto', viewer: VIEWER, now: NOW });
  assert.doesNotMatch(auto, /压力很大/, '助手自己的猜测不得作为正文自动注入');
  assert.equal(lines(auto)[0].value, HINT_VALUE);
  const explicit = renderContext({ entries: [inferred], purpose: 'explicit', viewer: VIEWER, now: NOW });
  assert.match(explicit, /压力很大/);
});

test('avoid_unless_asked 在 auto 与 explicit 都是占位，正文始终不出现', () => {
  const secret = record({
    id: 'mem_secret_1',
    kind: 'note',
    mentionPolicy: 'avoid_unless_asked',
    value: '不愿被主动提起的旧事：住院手术',
  });
  for (const purpose of ['auto', 'explicit']) {
    const text = renderContext({ entries: [secret], purpose, viewer: VIEWER, now: NOW });
    assert.doesNotMatch(text, /住院手术/, `${purpose} 不得泄露私密正文`);
    const line = lines(text)[0];
    assert.equal(line.type, 'hidden');
    assert.equal(line.policy, 'avoid_unless_asked');
    assert.equal(line.value, undefined);
  }
  // 显式召回工具同样只告知存在（既有冻结行为）。
  const payload = renderRecallResult({ entries: [secret], purpose: 'explicit', viewer: VIEWER, now: NOW });
  assert.equal(payload.entries[0].value, '');
  assert.equal(payload.entries[0].hidden, true);
  assert.equal(payload.hiddenCount, 1);
});

test('soft_echo 行在 auto 下正文保留但被标成「仅可呼应」，显式查询给原始正文', () => {
  const soft = record({
    id: 'mem_soft_1',
    kind: 'commitment',
    scope: 'user_global',
    mentionPolicy: 'soft_echo',
    value: '约定下周一起去海边，还没出发',
  });
  const auto = renderContext({ entries: [soft], purpose: 'auto', viewer: VIEWER, now: NOW });
  const line = lines(auto)[0];
  // 正文仍然在（承诺必须能被自然呼应，不能像 tone_only 那样压掉），
  // 但被明确标成「仅可呼应、不可当既成事实」。
  assert.match(line.value, /还没出发/, '正文必须保留，否则承诺无法被呼应');
  assert.match(line.value, /仅可自然呼应/, 'auto 下必须标成可呼应不可直述');
  assert.equal(line.policy, 'soft_echo', '呼应标签保留，模型能据此约束表述');

  const explicit = renderContext({ entries: [soft], purpose: 'explicit', viewer: VIEWER, now: NOW });
  assert.equal(lines(explicit)[0].value, truncate(soft.value, 240), '用户开口问了才给原始正文');
  assert.doesNotMatch(explicit, /仅可自然呼应/);
  // 预算上限同样适用于软表述。
  const long = record({
    id: 'mem_soft_long',
    mentionPolicy: 'soft_echo',
    value: '很长的承诺细节：' + '细节'.repeat(400),
  });
  const capped = renderContext({ entries: [long], purpose: 'auto', viewer: VIEWER, now: NOW });
  assert.ok(lines(capped)[0].value.length <= 160 + '（仅可自然呼应，不可当作已确认事实）'.length);
});

test('direct 行在 auto / explicit 下与旧输出逐字节相同（防回归）', () => {
  const plain = record({ id: 'mem_plain_1', kind: 'preference', value: '用户喜欢喝乌龙茶' });
  const expected = `${CONTEXT_HEADER}\n${legacyLine(plain)}`;
  assert.equal(renderContext({ entries: [plain] }), expected, '不传新参数的旧调用必须逐字节不变');
  assert.equal(renderContext({ entries: [plain], purpose: 'auto' }), expected);
  assert.equal(
    renderContext({ entries: [plain], purpose: 'explicit', viewer: VIEWER, now: NOW }),
    expected,
  );
  // 显式召回工具的字段集合与旧行为一致。
  const payload = renderRecallResult({ entries: [{ record: plain, score: 0.5, section: 'stable' }] });
  assert.deepEqual(
    Object.keys(payload.entries[0]).sort(),
    ['at', 'id', 'policy', 'reality', 'score', 'source', 'type', 'value'],
  );
  assert.equal(payload.entries[0].value, '用户喜欢喝乌龙茶');
  assert.equal(renderRecallResult({ entries: [plain], purpose: 'explicit', viewer: VIEWER, now: NOW }).entries[0].value,
    '用户喜欢喝乌龙茶');
});

test('降级之后仍受 BUDGET.total 约束，且不会被预算挤掉提示行之外的东西', () => {
  const rows = [];
  for (let index = 0; index < 30; index += 1) {
    rows.push(record({
      id: `mem_fill_${index}`,
      kind: index % 3 === 0 ? 'relationship' : 'preference',
      scope: index % 3 === 0 ? 'user_persona' : 'user_global',
      value: `第 ${index} 条较长的合成记忆正文：` + '用于把注入预算撑满的填充内容'.repeat(10),
      importance: 0.5,
    }));
  }
  rows.push(record({ id: 'mem_hint_fill', mentionPolicy: 'tone_only', kind: 'event', value: '不该出现的旧事细节' }));
  const text = renderContext({ entries: rows, purpose: 'auto', budget: DEFAULT_BUDGET, viewer: VIEWER, now: NOW });
  assert.ok(text.length <= DEFAULT_BUDGET, `注入长度 ${text.length} 超过预算 ${DEFAULT_BUDGET}`);
  assert.doesNotMatch(text, /不该出现的旧事细节/);
  const small = renderContext({ entries: rows, purpose: 'auto', budget: 600, viewer: VIEWER, now: NOW });
  assert.ok(small.length <= 600);
});

test('门 1 不通过的行在注入阶段直接不渲染（不靠预算来兜）', () => {
  const expired = record({ id: 'mem_expired_1', validTo: '2026-03-05T00:00:00.000Z', value: '已过期的合成内容' });
  const foreign = record({ id: 'mem_foreign_1', userId: 'user_other', value: '别人的合成内容' });
  const text = renderContext({
    entries: [expired, foreign],
    purpose: 'auto',
    viewer: VIEWER,
    now: NOW,
  });
  assert.equal(text, '', '过期与他人的行一条都不该出现');
  const payload = renderRecallResult({
    entries: [expired, foreign],
    purpose: 'explicit',
    viewer: VIEWER,
    now: NOW,
  });
  assert.equal(payload.total, 0);
  assert.deepEqual(payload.entries, []);
});
