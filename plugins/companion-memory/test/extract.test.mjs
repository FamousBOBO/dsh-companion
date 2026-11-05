// Tests for the extraction pipeline and the fact promotion gate.
// Pure logic only: no database, no network. The model client is a stub.
// Run with: node --test test/extract.test.mjs (from plugins/companion-memory)

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CANDIDATE_SCHEMA_VERSION,
  MAX_CANDIDATES_PER_BATCH,
  MAX_VALUE_LENGTH,
  factKey,
  gateCandidate,
  isMultiValueAttribute,
  mergeDecision,
  parseCandidate,
} from '../lib/validate.mjs';
import {
  EXTRACTION_DEFAULTS,
  buildExtractionPrompt,
  extractBatch,
  normalizeBatchMessages,
  parseExtractionOutput,
  resolveExtractionConfig,
} from '../lib/extract.mjs';

const VIEWER = { userId: 'u_local', personaId: 'p_bot', worldId: '' };
const WORLD_VIEWER = { userId: 'u_local', personaId: 'p_bot', worldId: 'w_knights' };
const PERSONA = { displayName: 'bot' };
const NOW = Date.parse('2026-03-07T12:00:00.000Z');

/** A realistic small batch: reality chatter plus one in-chat roleplay scene. */
const EVIDENCE = [
  { sourceId: 'm1', role: 'user', content: '我平时更喜欢喝乌龙茶，咖啡喝了心慌' },
  { sourceId: 'm2', role: 'user', content: '下个月我打算去杭州看展，顺便问问你要不要一起' },
  {
    sourceId: 'm3',
    role: 'user',
    content: '（我们来演一段：你扮演落难骑士，我是路过的旅人，故事发生在北境）',
  },
  {
    sourceId: 'm4',
    role: 'assistant',
    content: '（剧情里）在下从北境而来，只求一碗热汤，姑娘可否行个方便',
  },
  { sourceId: 'm5', role: 'user', content: '最近工作压力好大，晚上老是失眠' },
  { sourceId: 'm6', role: 'user', content: '这事我只跟你说，别告诉别人' },
  { sourceId: 'm7', role: 'assistant', content: '今天的云很好看，我在窗边站了好一会儿' },
  { sourceId: 'm8', role: 'user', content: '下周我打算去杭州看展，对了我不喝咖啡，只喝乌龙茶' },
];

function baseCandidate(overrides = {}) {
  return {
    kind: 'preference',
    scope: 'user_global',
    subject: 'user',
    predicate: 'prefers_drink',
    value: '用户更喜欢喝乌龙茶',
    evidence_source_ids: ['m1'],
    confidence: 0.82,
    importance: 0.6,
    validity: 'current',
    suggested_operation: 'upsert',
    mention_policy: 'direct',
    ...overrides,
  };
}

function gated(raw, context = {}) {
  const parsed = parseCandidate(raw);
  assert.equal(parsed.ok, true, `候选应通过结构校验：${JSON.stringify(parsed.errors)}`);
  return gateCandidate(parsed.candidate, { evidence: EVIDENCE, viewer: VIEWER, now: NOW, ...context });
}

function withTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-extract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- parseCandidate --------------------------------------------------------

test('parseCandidate 接受合法候选并补齐默认值', () => {
  const parsed = parseCandidate({
    kind: 'preference',
    scope: 'user_global',
    predicate: 'prefers_drink',
    value: '用户更喜欢喝乌龙茶',
    evidence_source_ids: ['m1', 'm1'],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.candidate.subject, 'user');
  assert.equal(parsed.candidate.validity, 'current');
  assert.equal(parsed.candidate.suggested_operation, 'upsert');
  assert.equal(parsed.candidate.schema_version, CANDIDATE_SCHEMA_VERSION);
  assert.deepEqual(parsed.candidate.evidence_source_ids, ['m1'], '证据 id 必须去重');
  assert.ok(parsed.candidate.importance > 0, '缺省 importance 由 kind 推导');
  assert.ok(parsed.warnings.length >= 1, '缺省字段应给出提示');
});

test('parseCandidate 拒绝越界的 confidence 与 importance', () => {
  const high = parseCandidate(baseCandidate({ confidence: 1.4 }));
  assert.equal(high.ok, false);
  assert.ok(high.errors.some(error => error.includes('confidence')), high.errors.join('|'));

  const negative = parseCandidate(baseCandidate({ importance: -0.2 }));
  assert.equal(negative.ok, false);
  assert.ok(negative.errors.some(error => error.includes('importance')));

  const notNumber = parseCandidate(baseCandidate({ confidence: 'very sure' }));
  assert.equal(notNumber.ok, false);
});

test('parseCandidate 拒绝空证据、非法枚举与超长 value', () => {
  const noEvidence = parseCandidate(baseCandidate({ evidence_source_ids: [] }));
  assert.equal(noEvidence.ok, false);
  assert.ok(noEvidence.errors.some(error => error.includes('evidence_source_ids')));

  const badScope = parseCandidate(baseCandidate({ scope: 'global' }));
  assert.equal(badScope.ok, false);
  assert.ok(badScope.errors.some(error => error.includes('scope')));

  const badKind = parseCandidate(baseCandidate({ kind: 'opinion' }));
  assert.equal(badKind.ok, false);

  const tooLong = parseCandidate(baseCandidate({ value: '茶'.repeat(MAX_VALUE_LENGTH + 1) }));
  assert.equal(tooLong.ok, false);
  assert.ok(tooLong.errors.some(error => error.includes('value')));

  const badValidity = parseCandidate(baseCandidate({ validity: 'someday' }));
  assert.equal(badValidity.ok, false);
});

test('parseCandidate 容忍字段别名、脱敏密钥并忽略未知字段', () => {
  const parsed = parseCandidate({
    kind: 'fact',
    scope: 'user_global',
    predicate: 'gpu_model',
    value: '用户机器上的 API_KEY: sk-abcdefghijklmnop 是新的',
    evidenceSourceIds: ['m1'],
    mentionPolicy: 'soft',
    confidence: '0.7',
    extra_note: '模型自己加的字段',
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.candidate.evidence_source_ids, ['m1']);
  assert.equal(parsed.candidate.mention_policy, 'soft_echo');
  assert.equal(parsed.candidate.confidence, 0.7);
  assert.ok(!parsed.candidate.value.includes('sk-abcdefghijklmnop'), '密钥必须脱敏');
  assert.ok(parsed.warnings.some(warning => warning.includes('extra_note')));
});

// --- gate: reality classification -----------------------------------------

test('中文角色扮演台词不会提升为现实事实', () => {
  const result = gated(baseCandidate({
    predicate: 'came_from_north',
    value: '用户来自北境',
    evidence_source_ids: ['m3', 'm4'],
    confidence: 0.9,
    mention_policy: 'direct',
  }));
  assert.equal(result.decision, 'reject');
  const joined = result.reasons.join(' | ');
  assert.ok(joined.includes('剧情') || joined.includes('角色扮演'), joined);
  assert.ok(result.reasons.some(reason => reason.startsWith('拒绝')), '必须给出拒绝原因');
  assert.equal(result.normalized.status, null, '被拒绝的候选不得带 status');
});

test('剧情片之类的现实喜好不会被误判成角色扮演', () => {
  const genre = gated(baseCandidate({
    kind: 'preference',
    predicate: 'prefers_genre',
    value: '用户喜欢看剧情片和纪录片',
    evidence_source_ids: ['m12'],
  }), {
    evidence: [{ sourceId: 'm12', role: 'user', content: '我周末喜欢看剧情片和纪录片' }],
  });
  assert.equal(genre.decision, 'accept', JSON.stringify(genre.reasons));
});

test('未绑定世界时，弱剧情提示只进入 pending', () => {
  const weak = gated(baseCandidate({
    kind: 'fact',
    predicate: 'story_setting',
    value: '用户说这个故事发生在海边',
    evidence_source_ids: ['m13'],
  }), {
    evidence: [{ sourceId: 'm13', role: 'user', content: '这个故事设定在海边的小镇' }],
  });
  assert.equal(weak.decision, 'pending');
  assert.ok(weak.reasons.some(reason => reason.includes('剧情')));
});

test('剧情内容写入 roleplay_world 时被接受', () => {
  const result = gated(baseCandidate({
    kind: 'event',
    scope: 'roleplay_world',
    subject: 'world',
    predicate: 'knight_origin',
    value: '北境骑士自称从北方来',
    evidence_source_ids: ['m4'],
    mention_policy: 'direct',
  }), { viewer: WORLD_VIEWER });
  assert.equal(result.decision, 'accept');
  assert.equal(result.normalized.realityLevel, 'roleplay_fiction');
  assert.equal(result.normalized.mentionPolicy, 'soft_echo', '剧情记忆只能自然呼应');
  assert.equal(result.normalized.status, 'confirmed');
});

test('未绑定世界的剧情候选进入 pending', () => {
  const result = gated(baseCandidate({
    kind: 'event',
    scope: 'roleplay_world',
    subject: 'world',
    predicate: 'knight_origin',
    value: '北境骑士自称从北方来',
    evidence_source_ids: ['m4'],
  }));
  assert.equal(result.decision, 'pending');
  assert.ok(result.reasons.some(reason => reason.includes('worldId')));
});

test('未来计划变成 commitment + planned + soft_echo', () => {
  const result = gated(baseCandidate({
    kind: 'event',
    predicate: 'trip_hangzhou',
    value: '用户要去杭州看展',
    evidence_source_ids: ['m2'],
    validity: 'current',
    mention_policy: 'direct',
  }));
  assert.equal(result.decision, 'accept');
  assert.equal(result.normalized.kind, 'commitment');
  assert.equal(result.normalized.validity, 'planned');
  assert.equal(result.normalized.mentionPolicy, 'soft_echo');
  assert.ok(result.reasons.some(reason => reason.includes('未完成约定')));
});

test('同一句里的现实偏好不会被计划检测误伤', () => {
  const result = gated(baseCandidate({
    predicate: 'prefers_drink',
    value: '用户更喜欢喝乌龙茶',
    evidence_source_ids: ['m8'],
  }));
  assert.equal(result.decision, 'accept');
  assert.equal(result.normalized.kind, 'preference', '偏好不能被改写成约定');
  assert.equal(result.normalized.validity, 'current');
});

test('引用他人说法与玩笑进入 pending', () => {
  const quoted = gated(baseCandidate({
    predicate: 'friend_is_doctor',
    value: '用户的朋友是医生',
    evidence_source_ids: ['m9'],
  }), {
    evidence: [...EVIDENCE, { sourceId: 'm9', role: 'user', content: '我朋友说他是医生，听着挺靠谱' }],
  });
  assert.equal(quoted.decision, 'pending');
  assert.ok(quoted.reasons.some(reason => reason.includes('引用他人')));

  const joke = gated(baseCandidate({
    predicate: 'is_doctor',
    value: '用户是医生',
    evidence_source_ids: ['m10'],
  }), {
    evidence: [...EVIDENCE, { sourceId: 'm10', role: 'user', content: '我是医生，开玩笑的啦' }],
  });
  assert.equal(joke.decision, 'pending');
  assert.ok(joke.reasons.some(reason => reason.includes('玩笑')));
});

// --- gate: evidence -------------------------------------------------------

test('没有证据的候选进入 pending 而不是直接入库', () => {
  const missing = gated(baseCandidate({ evidence_source_ids: ['m_missing'] }));
  assert.equal(missing.decision, 'pending');
  assert.equal(missing.normalized.status, 'pending');
  assert.ok(missing.reasons.some(reason => reason.includes('pending') || reason.includes('找不到')));

  const empty = parseCandidate(baseCandidate({ evidence_source_ids: [] }));
  assert.equal(empty.ok, false, '空证据在结构校验阶段就被拒绝');
});

test('只有 assistant 发言作证据时不能写成用户事实', () => {
  const result = gated(baseCandidate({
    kind: 'fact',
    predicate: 'took_photo',
    value: '用户今天在窗边拍了照片',
    evidence_source_ids: ['m7'],
  }));
  assert.equal(result.decision, 'pending');
  assert.ok(result.reasons.some(reason => reason.includes('assistant')));
});

test('迁移旧记录（role=imported）不能单独确认用户现实事实', () => {
  const importedEvidence = [
    ...EVIDENCE,
    {
      sourceId: 'imp_1',
      role: 'imported',
      sourceKind: 'astrbot_import',
      content: '旧库对话摘要：用户喜欢喝乌龙茶，住在杭州',
    },
  ];
  const result = gated(baseCandidate({ evidence_source_ids: ['imp_1'] }), { evidence: importedEvidence });
  assert.equal(result.decision, 'pending', 'imported 证据不得产出 accept');
  assert.equal(result.normalized.status, 'pending');
  const joined = result.reasons.join(' | ');
  assert.ok(joined.includes('non_conversation_evidence'), joined);
  assert.notEqual(result.normalized.realityLevel, 'explicit_user_statement');
  assert.ok(result.flags.nonConversationEvidence.includes('imp_1'));
  assert.equal(result.flags.conversationEvidence, 0);
});

test('sourceKind 为 astrbot_import 时即使 role=user 也算材料', () => {
  const result = gated(baseCandidate({ evidence_source_ids: ['imp_2'] }), {
    evidence: [{ sourceId: 'imp_2', role: 'user', sourceKind: 'astrbot_import', content: '用户喜欢喝乌龙茶' }],
  });
  assert.equal(result.decision, 'pending');
  assert.ok(result.reasons.some(reason => reason.includes('non_conversation_evidence')));
});

test('混合证据仍可确认，但信任等级不升为 explicit', () => {
  const result = gated(baseCandidate({
    evidence_source_ids: ['m1', 'imp_1'],
    confidence: 0.95,
  }), {
    evidence: [
      ...EVIDENCE,
      { sourceId: 'imp_1', role: 'imported', sourceKind: 'astrbot_import', content: '旧库摘要：用户喜欢喝乌龙茶' },
    ],
  });
  assert.equal(result.decision, 'accept');
  assert.equal(result.normalized.realityLevel, 'user_utterance_not_verified_fact');
  assert.ok(result.reasons.some(reason => reason.includes('未核实')));
});

test('证据属于其它用户或其它世界时直接拒绝', () => {
  const otherUser = gated(baseCandidate({ evidence_source_ids: ['m_other'] }), {
    evidence: [{ sourceId: 'm_other', role: 'user', userId: 'u_someone_else', content: '我喜欢喝乌龙茶' }],
  });
  assert.equal(otherUser.decision, 'reject');
  assert.ok(otherUser.reasons.some(reason => reason.includes('其它用户')));

  const otherWorld = gated(baseCandidate({ evidence_source_ids: ['m_world'] }), {
    evidence: [{ sourceId: 'm_world', role: 'user', worldId: 'w_other', content: '我在这个王国里是骑士' }],
  });
  assert.equal(otherWorld.decision, 'reject');
  assert.ok(otherWorld.reasons.some(reason => reason.includes('世界')));
});

test('角色自身行为不能写进用户现实作用域', () => {
  const result = gated(baseCandidate({
    kind: 'bot_action',
    predicate: 'sent_photo',
    value: 'bot发了一张照片',
    evidence_source_ids: ['m7'],
  }));
  assert.equal(result.decision, 'reject');
  assert.ok(result.reasons.some(reason => reason.includes('bot_action')));
});

test('validity=uncertain 与低置信度都进入 pending', () => {
  const uncertain = gated(baseCandidate({ validity: 'uncertain' }));
  assert.equal(uncertain.decision, 'pending');
  assert.ok(uncertain.reasons.some(reason => reason.includes('uncertain')));

  const lowConfidence = gated(baseCandidate({ confidence: 0.3 }));
  assert.equal(lowConfidence.decision, 'pending');
  assert.ok(lowConfidence.reasons.some(reason => reason.includes('置信度')));
});

// --- gate: expression policy ---------------------------------------------

test('敏感情绪只影响语气，隐私请求改为回避', () => {
  const sensitive = gated(baseCandidate({
    kind: 'note',
    predicate: 'recent_mood',
    value: '用户最近压力很大、晚上失眠',
    evidence_source_ids: ['m5'],
  }));
  assert.equal(sensitive.decision, 'accept');
  assert.equal(sensitive.normalized.mentionPolicy, 'tone_only');
  assert.ok(sensitive.reasons.some(reason => reason.includes('tone_only')));

  const private_ = gated(baseCandidate({
    kind: 'note',
    predicate: 'private_topic',
    value: '用户有一件只想让bot知道的事',
    evidence_source_ids: ['m6'],
  }));
  assert.equal(private_.decision, 'accept');
  assert.equal(private_.normalized.mentionPolicy, 'avoid_unless_asked');
  assert.ok(private_.reasons.some(reason => reason.includes('avoid_unless_asked')));
});

test('剧情世界会话里的现实事实需要用户明确说明', () => {
  const vague = gated(baseCandidate({
    predicate: 'prefers_drink',
    value: '用户喜欢乌龙茶',
    evidence_source_ids: ['m1'],
  }), { viewer: WORLD_VIEWER });
  assert.equal(vague.decision, 'pending');
  assert.ok(vague.reasons.some(reason => reason.includes('剧情世界')));

  const explicit = gated(baseCandidate({
    predicate: 'prefers_drink',
    value: '用户喜欢乌龙茶',
    evidence_source_ids: ['m11'],
  }), {
    viewer: WORLD_VIEWER,
    evidence: [{ sourceId: 'm11', role: 'user', content: '现实里我更喜欢喝乌龙茶啦' }],
  });
  assert.equal(explicit.decision, 'accept', JSON.stringify(explicit.reasons));
});

// --- mergeDecision --------------------------------------------------------

const EXISTING_DRINK = {
  id: 'mem_drink_tea',
  kind: 'preference',
  scope: 'user_global',
  subject: 'user',
  predicate: 'prefers_drink',
  value: '茶',
  status: 'confirmed',
  updatedAt: '2026-03-01T00:00:00.000Z',
};

function incoming(overrides = {}) {
  return {
    kind: 'preference',
    scope: 'user_global',
    subject: 'user',
    predicate: 'prefers_drink',
    value: '咖啡',
    confidence: 0.8,
    evidenceSourceIds: ['m1'],
    decision: 'accept',
    status: 'confirmed',
    ...overrides,
  };
}

test('单值稳定属性冲突走 supersede', () => {
  const decision = mergeDecision({ incoming: incoming(), existing: EXISTING_DRINK });
  assert.equal(decision.operation, 'supersede');
  assert.equal(decision.targetId, 'mem_drink_tea');
  assert.ok(decision.reasons.length >= 1);
});

test('存储草稿只带单个 sourceId 时也算有证据', () => {
  // jobs.mjs builds its insert draft with `sourceId` (one representative event),
  // not `evidenceSourceIds`; a supersede must not degrade to conflict.
  const draft = {
    kind: 'preference',
    scope: 'user_global',
    subject: 'user',
    predicate: 'prefers_drink',
    value: '咖啡',
    confidence: 0.85,
    status: 'confirmed',
    decision: 'accept',
    sourceId: 'evt_123',
  };
  const decision = mergeDecision({ incoming: draft, existing: EXISTING_DRINK });
  assert.equal(decision.operation, 'supersede');
  assert.equal(decision.targetId, 'mem_drink_tea');

  const noEvidence = { ...draft, sourceId: '' };
  assert.equal(mergeDecision({ incoming: noEvidence, existing: EXISTING_DRINK }).operation, 'conflict');
});

test('同值重复写入被判为 duplicate', () => {
  const decision = mergeDecision({ incoming: incoming({ value: '茶' }), existing: EXISTING_DRINK });
  assert.equal(decision.operation, 'duplicate');
  assert.equal(decision.targetId, 'mem_drink_tea');
});

test('多值属性允许并存：insert 而不是覆盖', () => {
  const decision = mergeDecision({
    incoming: incoming({ predicate: 'hobby', value: '摄影' }),
    existing: {
      id: 'mem_hobby_photo',
      kind: 'preference',
      scope: 'user_global',
      subject: 'user',
      predicate: 'hobby',
      value: '逛博物馆',
      status: 'confirmed',
    },
  });
  assert.equal(decision.operation, 'insert');
  assert.ok(isMultiValueAttribute({ kind: 'commitment', predicate: 'promise' }));
  assert.ok(isMultiValueAttribute({ kind: 'preference', predicate: 'multi:game' }));
  assert.ok(!isMultiValueAttribute({ kind: 'fact', predicate: 'lives_in' }));
});

test('证据不足或仍待定的候选只能给出 conflict', () => {
  assert.equal(mergeDecision({ incoming: incoming({ evidenceSourceIds: [] }), existing: EXISTING_DRINK }).operation, 'conflict');
  assert.equal(mergeDecision({ incoming: incoming({ decision: 'pending' }), existing: EXISTING_DRINK }).operation, 'conflict');
  assert.equal(
    mergeDecision({
      incoming: incoming({ confidence: 0.2 }),
      existing: EXISTING_DRINK,
    }).operation,
    'conflict',
  );
  assert.equal(
    mergeDecision({
      incoming: incoming(),
      existing: { ...EXISTING_DRINK, id: 'mem_pending', value: '乌龙茶', status: 'pending' },
    }).operation,
    'conflict',
  );
});

test('同值待定记录在证据充分时升级为确认', () => {
  const decision = mergeDecision({
    incoming: incoming({ value: '咖啡' }),
    existing: { ...EXISTING_DRINK, id: 'mem_pending_coffee', value: '咖啡', status: 'pending' },
  });
  assert.equal(decision.operation, 'update');
  assert.equal(decision.targetId, 'mem_pending_coffee');
});

test('无既有记录或键不同时直接 insert', () => {
  assert.equal(mergeDecision({ incoming: incoming(), existing: null }).operation, 'insert');
  assert.equal(
    mergeDecision({
      incoming: incoming({ scope: 'user_persona' }),
      existing: EXISTING_DRINK,
    }).operation,
    'insert',
  );
  assert.equal(factKey(EXISTING_DRINK), 'user_global|user|prefers_drink');
});

test('已归档的旧值不会吞掉新值', () => {
  const decision = mergeDecision({
    incoming: incoming({ value: '茶' }),
    existing: { ...EXISTING_DRINK, id: 'mem_old_tea', status: 'superseded' },
  });
  assert.notEqual(decision.operation, 'duplicate');
  assert.equal(decision.operation, 'insert', '没有当前事实可覆盖时新建一条，而不是重复写旧值');
});

// --- parseExtractionOutput ------------------------------------------------

test('parseExtractionOutput 容忍 ```json 围栏与前后解释文字', () => {
  const text = '好的，我整理了一下：\n```json\n[\n  {"kind":"preference","value":"喝茶"}\n]\n```\n以上就是全部。';
  const parsed = parseExtractionOutput(text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].value, '喝茶');
});

test('parseExtractionOutput 对坏 JSON 返回 errors 而不抛', () => {
  const cases = [
    '抱歉，我无法完成这个任务。',
    '[{"kind": "fact", "value": "未闭合',
    '',
    'null',
    '[1, 2, 3]',
  ];
  for (const text of cases) {
    const parsed = parseExtractionOutput(text);
    assert.deepEqual(parsed.candidates, [], `不应产出候选：${text}`);
    assert.ok(parsed.errors.length >= 1, `必须给出可读错误：${text}`);
  }
  assert.doesNotThrow(() => parseExtractionOutput(null));
  assert.equal(parseExtractionOutput(null).candidates.length, 0);
});

test('parseExtractionOutput 容忍尾逗号、单对象与包裹结构', () => {
  const trailing = parseExtractionOutput('[{"kind":"fact","value":"a",},]');
  assert.equal(trailing.candidates.length, 1);
  assert.ok(trailing.warnings.some(warning => warning.includes('尾逗号')));

  const single = parseExtractionOutput('{"kind":"fact","value":"a"}');
  assert.equal(single.candidates.length, 1);
  assert.ok(single.warnings.some(warning => warning.includes('根节点不是数组')));

  const wrapped = parseExtractionOutput('{"candidates":[{"kind":"fact","value":"a"}]}');
  assert.equal(wrapped.candidates.length, 1);

  const mixed = parseExtractionOutput('[{"kind":"fact"}, "oops"]');
  assert.equal(mixed.candidates.length, 1);
  assert.ok(mixed.warnings.some(warning => warning.includes('非对象')));
});

// --- prompt ---------------------------------------------------------------

test('buildExtractionPrompt 输出中文规则并逐条列出消息 id', t => {
  const dir = withTempDir(t);
  const prompt = buildExtractionPrompt({ persona: PERSONA, viewer: VIEWER, messages: EVIDENCE });
  writeFileSync(join(dir, 'prompt.txt'), `${prompt.system}\n\n${prompt.input}`, 'utf8');

  for (const rule of ['只依据', '不得编造', '剧情', '只输出一个 JSON 数组', '无法确定就不输出', `最多输出 ${MAX_CANDIDATES_PER_BATCH} 条`]) {
    assert.ok(prompt.system.includes(rule), `system 缺少规则：${rule}`);
  }
  assert.ok(prompt.input.includes('[id=m1] user: '), 'input 必须逐条列出 id 与角色');
  assert.ok(prompt.input.includes('[id=m2] user: '));
  assert.ok(prompt.input.includes('现实世界'), '必须给出作用域提示');
  assert.ok(!prompt.input.includes('```'), 'input 不应包含代码围栏');
  assert.equal(prompt.batchMeta.messageCount, EVIDENCE.length);
  assert.equal(prompt.batchMeta.scopeHint, 'reality');
  assert.equal(prompt.batchMeta.maxCandidates, MAX_CANDIDATES_PER_BATCH);
  assert.deepEqual(prompt.batchMeta.messageIds, EVIDENCE.map(item => item.sourceId));

  const worldPrompt = buildExtractionPrompt({ persona: PERSONA, viewer: WORLD_VIEWER, messages: EVIDENCE });
  assert.equal(worldPrompt.batchMeta.scopeHint, 'roleplay');
  assert.ok(worldPrompt.input.includes('roleplay_world'), '剧情会话必须提示 roleplay_world 作用域');
});

test('buildExtractionPrompt 保留非对话来源的原始角色标签并加标注', () => {
  const messages = [
    ...EVIDENCE,
    { sourceId: 'imp_1', role: 'imported', sourceKind: 'astrbot_import', content: '旧库摘要：用户喜欢喝乌龙茶' },
  ];
  const prompt = buildExtractionPrompt({ persona: PERSONA, viewer: VIEWER, messages });
  assert.ok(prompt.input.includes('[id=imp_1] imported: '), '必须保留原角色标签，不能改写成 user');
  assert.ok(!prompt.input.includes('[id=imp_1] user:'));
  assert.ok(prompt.input.includes('非对话来源'), '必须明确标注这是迁移旧记录');
  assert.ok(prompt.input.includes('不得当作新的用户陈述'));
  assert.equal(prompt.batchMeta.conversationMessages, EVIDENCE.length);
  assert.equal(prompt.batchMeta.nonConversationMessages, 1);
  assert.ok(prompt.system.includes('非对话来源'), 'system 也要声明该约束');
});

test('buildExtractionPrompt 丢弃无 id 的消息并控制长度', () => {
  const messages = [
    { role: 'user', content: '没有 id 的消息' },
    { sourceId: 'm1', role: 'user', content: '有 id 的消息' },
  ];
  const prompt = buildExtractionPrompt({ viewer: VIEWER, messages });
  assert.equal(prompt.batchMeta.messageCount, 1);
  assert.equal(prompt.batchMeta.skipped.length, 1);
  assert.ok(!prompt.input.includes('没有 id 的消息'));
});

test('normalizeBatchMessages 接受数组、{messages} 与 snake_case 行', () => {
  const snake = [{ source_id: 'evt_1', role: 'assistant', content: '你好', occurred_at: '2026-03-07T12:00:00.000Z' }];
  assert.equal(normalizeBatchMessages(snake).messages.length, 1);
  assert.equal(normalizeBatchMessages({ messages: snake }).messages[0].sourceId, 'evt_1');
  assert.equal(normalizeBatchMessages({ events: snake }).messages.length, 1);
  assert.deepEqual(normalizeBatchMessages(undefined).messages, []);
  assert.equal(normalizeBatchMessages(snake).messages[0].conversation, true);
});

test('normalizeBatchMessages 不把未知角色改写成 user', () => {
  const messages = normalizeBatchMessages([
    { sourceId: 'imp_1', role: 'imported', content: '旧库摘要' },
    { sourceId: 'sys_1', role: 'system', content: '系统提示材料' },
    { sourceId: 'tool_1', role: 'tool', content: '工具结果' },
    { sourceId: 'mix_1', role: 'user', sourceKind: 'astrbot_import', content: '旧库用户行' },
    { sourceId: 'm1', role: 'user', content: '真实用户消息' },
    { sourceId: 'm2', role: 'assistant', content: '真实角色消息' },
  ]).messages;
  const byId = Object.fromEntries(messages.map(message => [message.sourceId, message]));
  assert.equal(byId.imp_1.role, 'imported');
  assert.equal(byId.imp_1.conversation, false);
  assert.equal(byId.sys_1.role, 'system');
  assert.equal(byId.sys_1.conversation, false);
  assert.equal(byId.tool_1.role, 'tool');
  assert.equal(byId.tool_1.conversation, false);
  assert.equal(byId.mix_1.conversation, false, 'astrbot_import 来源不算对话证据');
  assert.equal(byId.m1.conversation, true);
  assert.equal(byId.m2.conversation, true);
});

// --- extractBatch ---------------------------------------------------------

function stubLlm(output) {
  const calls = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      return typeof output === 'function' ? output(request) : output;
    },
  };
}

test('extractBatch 端到端：围栏 JSON → 校验 → 闸门', async () => {
  const llm = stubLlm([
    '```json',
    JSON.stringify([
      {
        kind: 'event',
        scope: 'user_global',
        subject: 'user',
        predicate: 'trip_hangzhou',
        value: '用户要去杭州看展',
        evidence_source_ids: ['m2'],
        confidence: 0.85,
        importance: 0.6,
        validity: 'current',
        suggested_operation: 'insert',
        mention_policy: 'direct',
      },
      {
        kind: 'fact',
        scope: 'user_global',
        subject: 'user',
        predicate: 'came_from_north',
        value: '用户来自北境',
        evidence_source_ids: ['m3', 'm4'],
        confidence: 0.9,
        importance: 0.5,
        validity: 'current',
        suggested_operation: 'insert',
        mention_policy: 'direct',
      },
    ]),
    '```',
  ].join('\n'));

  const result = await extractBatch({
    llm,
    config: { extraction: { maxOutputTokens: 800 } },
    batch: { messages: EVIDENCE },
    viewer: VIEWER,
    persona: PERSONA,
  });

  assert.equal(result.failed, false);
  assert.equal(result.candidates.length, 2);
  const plan = result.candidates[0];
  assert.equal(plan.decision, 'accept');
  assert.equal(plan.candidate.kind, 'commitment');
  assert.equal(plan.candidate.validity, 'planned');
  assert.equal(plan.candidate.mentionPolicy, 'soft_echo');
  assert.equal(result.candidates[1].decision, 'reject');
  assert.equal(result.usage.accepted, 1);
  assert.equal(result.usage.rejected, 1);
  // jobs.mjs consumes `entry.normalized`; keep the alias in the contract tests.
  assert.ok(result.candidates[0].normalized);
  assert.equal(result.candidates[0].normalized, result.candidates[0].candidate);
  assert.deepEqual(result.candidates[0].normalized.evidenceSourceIds, ['m2']);
  assert.equal(result.candidates[0].normalized.status, 'confirmed');
  assert.ok(Array.isArray(result.candidates[0].flags.plan));
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].maxTokens, 800);
  assert.ok(llm.calls[0].system.includes('只依据'));
  assert.ok(llm.calls[0].input.includes('[id=m2] user: '));
  assert.ok(llm.calls[0].signal, '应传入 AbortSignal');
});

test('extractBatch 空批次安全，不调用模型', async () => {
  const llm = stubLlm('[]');
  const empty = await extractBatch({ llm, config: {}, batch: { messages: [] }, viewer: VIEWER });
  assert.deepEqual(empty.candidates, []);
  assert.deepEqual(empty.errors, []);
  assert.equal(empty.skipped, true);
  assert.equal(llm.calls.length, 0);

  const noBatch = await extractBatch({ llm, config: {}, batch: null, viewer: VIEWER });
  assert.equal(noBatch.skipped, true);
  assert.equal(llm.calls.length, 0);

  const disabled = await extractBatch({ llm, config: { extraction: { enabled: false } }, batch: EVIDENCE, viewer: VIEWER });
  assert.equal(disabled.skipped, true);
  assert.equal(llm.calls.length, 0);
});

test('extractBatch 不会把 imported 证据的候选提升为现实事实', async () => {
  const importedRow = {
    sourceId: 'imp_1',
    role: 'imported',
    sourceKind: 'astrbot_import',
    content: '旧库对话摘要：用户喜欢喝乌龙茶',
  };
  const llm = stubLlm(JSON.stringify([
    {
      kind: 'preference',
      scope: 'user_global',
      subject: 'user',
      predicate: 'prefers_drink',
      value: '用户喜欢喝乌龙茶',
      evidence_source_ids: ['imp_1'],
      confidence: 0.95,
      importance: 0.7,
      validity: 'current',
      suggested_operation: 'upsert',
      mention_policy: 'direct',
    },
  ]));
  const result = await extractBatch({
    llm,
    config: {},
    batch: { messages: [...EVIDENCE, importedRow] },
    viewer: VIEWER,
  });
  const entry = result.candidates[0];
  assert.ok(entry, '候选应被保留以便人工复核');
  assert.equal(entry.decision, 'pending');
  assert.equal(entry.normalized.status, 'pending');
  assert.ok(entry.reasons.join(' | ').includes('non_conversation_evidence'));
  assert.equal(entry.normalized.realityLevel, 'imported_summary');
  assert.equal(result.usage.accepted, 0);
});

test('全部为迁移/系统材料的批次不调用模型', async () => {
  const llm = stubLlm('[]');
  const importedBatch = [
    { sourceId: 'imp_1', role: 'imported', sourceKind: 'astrbot_import', content: '旧库摘要：用户喜欢喝乌龙茶' },
    { sourceId: 'imp_2', role: 'system', content: '系统材料：用户画像' },
  ];
  const skipped = await extractBatch({ llm, config: {}, batch: { messages: importedBatch }, viewer: VIEWER });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'no-conversation-evidence');
  assert.deepEqual(skipped.candidates, []);
  assert.deepEqual(skipped.errors, []);
  assert.equal(llm.calls.length, 0, '不得为非对话批次付费调用模型');

  // A normal user/assistant batch must keep working exactly as before.
  const normal = await extractBatch({ llm, config: {}, batch: { messages: EVIDENCE }, viewer: VIEWER });
  assert.equal(llm.calls.length, 1);
  assert.equal(normal.skipped, undefined);
  assert.equal(normal.failed, false);
  assert.equal(normal.usage.conversationMessages, EVIDENCE.length);
  assert.equal(normal.usage.nonConversationMessages, 0);

  // Mixed batch: still runs, and the model is told about the material rows.
  const mixed = await extractBatch({
    llm,
    config: {},
    batch: { messages: [...EVIDENCE, ...importedBatch] },
    viewer: VIEWER,
  });
  assert.equal(llm.calls.length, 2);
  assert.ok(llm.calls[1].input.includes('[id=imp_1] imported: '));
  assert.equal(mixed.usage.conversationMessages, EVIDENCE.length);
  assert.equal(mixed.usage.nonConversationMessages, 2);
});

test('extractBatch 模型抛错时返回 failed 而不抛', async () => {
  const llm = {
    async complete() {
      throw new Error('upstream 502');
    },
  };
  const result = await extractBatch({ llm, config: {}, batch: EVIDENCE, viewer: VIEWER });
  assert.equal(result.failed, true);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes('502'));

  const noLlm = await extractBatch({ llm: null, config: {}, batch: EVIDENCE, viewer: VIEWER });
  assert.equal(noLlm.failed, true);
  assert.ok(noLlm.errors[0].includes('llm'));

  const brokenJson = await extractBatch({ llm: stubLlm('我只想说抱歉'), config: {}, batch: EVIDENCE, viewer: VIEWER });
  assert.equal(brokenJson.failed, false);
  assert.deepEqual(brokenJson.candidates, []);
  assert.ok(brokenJson.errors.length >= 1);
});

test('extractBatch 截断到 8 条并记录不合格候选', async () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    kind: 'fact',
    scope: 'user_global',
    subject: 'user',
    predicate: `item_${index}`,
    value: `事实 ${index}`,
    evidence_source_ids: ['m1'],
    confidence: 0.8,
    importance: 0.5,
    validity: 'current',
    suggested_operation: 'insert',
    mention_policy: 'direct',
  }));
  items.push({ kind: 'fact', scope: 'user_global', predicate: 'bad_confidence', value: '越界', evidence_source_ids: ['m1'], confidence: 4 });
  const llm = stubLlm(JSON.stringify(items));
  const result = await extractBatch({ llm, config: {}, batch: EVIDENCE, viewer: VIEWER });
  assert.equal(result.candidates.length, MAX_CANDIDATES_PER_BATCH);
  assert.ok(result.errors.some(error => error.includes('截断')), result.errors.join('|'));
});

test('extractBatch 把不合格候选记入 errors 但不中断', async () => {
  const llm = stubLlm(JSON.stringify([
    { kind: 'opinion', scope: 'user_global', predicate: 'x', value: 'y', evidence_source_ids: ['m1'] },
    {
      kind: 'fact', scope: 'user_global', subject: 'user', predicate: 'coffee', value: '用户喝乌龙茶',
      evidence_source_ids: ['m1'], confidence: 0.8, importance: 0.5, validity: 'current',
      suggested_operation: 'insert', mention_policy: 'direct',
    },
  ]));
  const result = await extractBatch({ llm, config: {}, batch: EVIDENCE, viewer: VIEWER });
  assert.equal(result.candidates.length, 1);
  assert.ok(result.errors.some(error => error.includes('第 1 条候选不合格')), result.errors.join('|'));
});

test('resolveExtractionConfig 提供缺省并接受覆盖', () => {
  const defaults = resolveExtractionConfig();
  assert.equal(defaults.maxOutputTokens, EXTRACTION_DEFAULTS.maxOutputTokens);
  assert.equal(defaults.maxCandidates, MAX_CANDIDATES_PER_BATCH);
  assert.equal(defaults.enabled, true);

  const custom = resolveExtractionConfig({ extraction: { maxOutputTokens: 42, maxCandidates: 3, timeoutMs: 5000 } });
  assert.equal(custom.maxOutputTokens, 42);
  assert.equal(custom.maxCandidates, 3);
  assert.equal(custom.timeoutMs, 5000);

  const flat = resolveExtractionConfig({ maxCandidates: 2 });
  assert.equal(flat.maxCandidates, 2);

  // config.mjs ships `maxInputChars`; honour it as an alias of the prompt budget.
  assert.equal(resolveExtractionConfig({ extraction: { maxInputChars: 4000 } }).maxPromptChars, 4000);
  assert.equal(
    resolveExtractionConfig({ extraction: { gate: { minAcceptConfidence: 0.7 } } }).minAcceptConfidence,
    0.7,
  );
});
