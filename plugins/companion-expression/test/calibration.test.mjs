/**
 * 标定测试：`retrieval.minFitScore` 必须**真的可达**。
 *
 * 这个文件守的是一条不变量，而不是某个函数的实现细节：默认 0.72 的门槛只有在
 * 「有信号的维度才计入分母」时才有意义。缺陷的原始形态是两处都把上下文写死成
 * `{query, intents: [], scenes: []}`，于是 intent/tone/context 三维恒为中性 0.5，
 * 七维全开时完美命中最多只有 0.675 < 0.72——**任何图库、任何候选都发不出去**。
 * 这里的用例用**真实形状**的卡片与**人真的会打出来的话**做标定，不用「每个维度都 1」
 * 的合成输入；同时也把「稀释」这条已知性质钉成数字，防止有人为了让它发图去调门槛。
 *
 * 数据库一律 `:memory:`，绝不碰 data/ 下的真库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openExpressionDb } from '../src/db.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { privateScope } from '../src/scopes.mjs';
import { contextFromDraft, retrieve, scoreCandidate, WEIGHTS } from '../src/retrieval.mjs';
import { decide } from '../src/decision.mjs';

const SALT = 'test-salt-0123456789abcdef';
const OWNER_SCOPE = privateScope({ kind: 'owner_private', chatId: 10001, salt: SALT });
const NOW = 1_700_000_000_000;

/** 精选表情包入库后会得到的卡：literal 是图上的字 + 常见同义词，emotions 是它表达的情绪。 */
const CURATED_CARD = {
  literal: '困 好困 困了 想睡 睡觉 睡着了 疲惫 累 打哈欠',
  ocr: '',
  intents: [],
  emotions: ['tired'],
  tone: [],
  rhetoric: [],
  scenes: ['bedtime', 'night'],
  avoidWhen: [],
  aggression: 0,
};

/** 只有这一张图、没有任何反馈历史的新图库。 */
const freshLibrary = () => ({
  candidates: () => [{
    assetId: 'ast_curated001',
    moderationState: 'approved',
    kind: 'png',
    mime: 'image/png',
    createdAt: NOW,
    visibility: [{ scope: OWNER_SCOPE, approval: 'approved' }],
    card: CURATED_CARD,
  }],
});

/** 只打开投递总闸，其余一律用默认值——`retrieval.minFitScore` 保持 0.72。 */
const configWithDelivery = { ...DEFAULT_CONFIG, delivery: { ...DEFAULT_CONFIG.delivery, enabled: true } };

function decisionFor({ db, draft, library = freshLibrary() }) {
  const found = retrieve({
    library, usable: [OWNER_SCOPE], scope: OWNER_SCOPE, context: contextFromDraft(draft),
    limit: 5, minFitScore: 0, now: NOW,
  });
  return {
    found,
    decision: decide({
      db, config: configWithDelivery, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE,
      candidates: found.candidates, now: NOW,
    }),
  };
}

test('阈值必须够得着：完美匹配的上限高于默认 minFitScore', () => {
  // 修复前：七维全按固定分母 1.0 相加，缺席的三维各记中性 0.5，于是
  //   0.30·1 + 0.20·0.5 + 0.15·0.5 + 0.10·0.5 + 0.10·0.5 + 0.10·0.5 + 0.05·1 = 0.675 < 0.72，
  // 即「完美匹配」也够不到门槛——那不是候选不够好，是阈值从设计上就不可达。
  // 修复后：分母只算有信号的维度，四维满 + 三维中性 ⇒ (0.30+0.20+0.15+0.10+0.05+0.05+0.05)/(0.30+0.20+0.15+0.10+0.10+0.10+0.05) 再到 0.90。
  const ceiling = WEIGHTS.semantic + WEIGHTS.intent + WEIGHTS.tone + WEIGHTS.context
    + WEIGHTS.feedback * 0.5 + WEIGHTS.persona * 0.5 + WEIGHTS.freshness;
  // 用真实打分函数再算一遍，防止权重表与实现走岔。
  const perfectCard = {
    literal: '猫猫大笑', intents: ['laugh'], emotions: ['joy'], tone: ['playful'], scenes: ['work'],
    avoidWhen: [], aggression: 0,
  };
  const realized = scoreCandidate({
    candidate: { card: perfectCard, createdAt: NOW },
    context: { query: '猫猫大笑', intents: ['laugh'], emotions: ['joy'], tone: ['playful'], scenes: ['work'] },
    now: NOW,
  }).fitScore;
  assert.ok(Math.abs(ceiling - realized) < 1e-9, `权重表算出的上限 ${ceiling} 与实测 ${realized} 应一致`);
  assert.equal(DEFAULT_CONFIG.retrieval.minFitScore, 0.72, '默认门槛保持 0.72（不靠调低门槛来跑通）');
  assert.ok(ceiling > DEFAULT_CONFIG.retrieval.minFitScore,
    `完美匹配上限 ${ceiling.toFixed(3)} 必须高于门槛 ${DEFAULT_CONFIG.retrieval.minFitScore}，否则模块永远发不出图`);
});

test('真实形状的卡片 + 真实草稿：默认 0.72 门槛下判 send', () => {
  const db = openExpressionDb({ file: ':memory:' });
  try {
    const { found, decision } = decisionFor({ db, draft: '好困' });
    assert.equal(found.ok, true);
    assert.equal(found.candidates.length, 1, '新图库里这张图必须能进候选');
    const fit = found.candidates[0].fitScore;
    // 实测（tired 卡 + 草稿「好困」，新鲜素材、无反馈历史、中性角色）：0.8667。
    assert.ok(Math.abs(fit - 0.8667) < 1e-3, `适配分应约 0.8667，实际 ${fit}`);
    assert.ok(fit >= DEFAULT_CONFIG.retrieval.minFitScore, `适配分 ${fit} 应 ≥ ${DEFAULT_CONFIG.retrieval.minFitScore}`);
    assert.equal(decision.send, true, `应判 send，实际 ${decision.reasonCode}（fit=${fit}）`);
    assert.equal(decision.reasonCode, 'send');
    assert.equal(decision.mode, 'text_then_sticker');
    assert.ok(Math.abs(decision.fitScore - fit) < 1e-9, '决策用的就是检索给的那一分');

    // 门槛是唯一的变量：同一批候选、同一份配置，只把投递总闸关回去，拒绝理由就必须是
    // abstain-delivery-disabled 而不是 text-only-low-fit——说明这次 send 真是分数挣来的。
    const gated = decide({
      db, config: DEFAULT_CONFIG, target: { kind: 'dm', id: 10001 }, scope: OWNER_SCOPE,
      candidates: found.candidates, now: NOW,
    });
    assert.equal(gated.reasonCode, 'abstain-delivery-disabled', '默认配置下总闸是关的（没有为此改任何配置）');
  } finally {
    db.close();
  }
});

test('反向孪生：无关草稿必须 abstain，绝不发图', () => {
  const db = openExpressionDb({ file: ':memory:' });
  try {
    const { decision } = decisionFor({ db, draft: '明天要交作业' });
    // 实测：语义 0、情绪维度未命中 ⇒ fitScore 0.2769，远低于 0.72。
    assert.equal(decision.send, false, '无关草稿不该发图');
    assert.ok(
      ['text-only-low-fit', 'text-only-no-candidate'].includes(decision.reasonCode),
      `应为纯文字，实际 ${decision.reasonCode}`,
    );
    assert.equal(decision.mode, 'text_only');
  } finally {
    db.close();
  }
});

test('稀释要如实记录：「我好困啊」的 fitScore 是 0.6381，并且因此 abstain', () => {
  const db = openExpressionDb({ file: ':memory:' });
  try {
    const { found, decision } = decisionFor({ db, draft: '我好困啊' });
    const fit = found.candidates[0].fitScore;
    // 已知性质，不是 bug：`overlap()` 的分母是**查询**的词数（单字 + 相邻二字），
    // 「我好困啊」有 7 个词（我/好/困/啊/我好/好困/困啊），卡片只命中 好/困/好困 ⇒ 0.4286。
    // 归一化后：(0.30·0.4286 + 0.20·1 + 0.10·0.5 + 0.10·0.5 + 0.05·1) / 0.75 = 0.6381。
    assert.ok(Math.abs(fit - 0.6381) < 1e-4, `稀释后的适配分应约 0.6381，实际 ${fit}`);
    assert.equal(decision.send, false, '边际匹配就该 abstain，不能为了「能发图」而调低门槛');
    assert.equal(decision.reasonCode, 'text-only-low-fit');
  } finally {
    db.close();
  }
});

/* ───────── scoreCandidate：情绪并入「意图」维度 ───────── */

test('情绪命中提高 fitScore：其余字段完全相同时，只有情绪对得上的那张更高', () => {
  const matched = scoreCandidate({
    candidate: { card: CURATED_CARD, createdAt: NOW }, context: contextFromDraft('好困，想睡觉了'), now: NOW,
  });
  const mismatched = scoreCandidate({
    candidate: { card: { ...CURATED_CARD, emotions: ['joy'] }, createdAt: NOW },
    context: contextFromDraft('好困，想睡觉了'), now: NOW,
  });
  assert.ok(matched.fitScore > mismatched.fitScore,
    `情绪对得上的应更高：${matched.fitScore} vs ${mismatched.fitScore}`);
  assert.equal(matched.parts.intent, 1, '卡片 tired 与草稿 tired 完全重叠');
  assert.equal(mismatched.parts.intent, 0, '卡片 joy 与草稿 tired 不重叠');
  assert.equal(matched.parts.semantic, mismatched.parts.semantic, '两个用例其余维度必须完全一样，差异只能来自情绪');
});

test('两边都没有意图/情绪：该维度是「没问」，不进分母，也不拖到 0.5', () => {
  const bare = { literal: '猫猫', intents: [], emotions: [], scenes: [], avoidWhen: [] };
  const wanted = { card: bare, createdAt: NOW };
  const wantsNothing = scoreCandidate({ candidate: wanted, context: {}, now: NOW });
  assert.equal(wantsNothing.parts.intent, 0.5, 'parts 仍保留原公式的中性值（便于观察）');
  assert.equal('intent' in wantsNothing.activeWeights, false, '但没有信号就不该计入分母');
  assert.deepEqual(Object.keys(wantsNothing.activeWeights).sort(),
    ['feedback', 'freshness', 'persona', 'semantic'], '只算真正有信号的维度');

  // 草稿带着情绪来、卡片却一个情绪都没有：没有命中就是这个维度的 0，不是中性。
  const cardHasNone = scoreCandidate({ candidate: wanted, context: { emotions: ['tired'], intents: ['laugh'] }, now: NOW });
  assert.equal(cardHasNone.parts.intent, 0, '想要的集合非空而卡片为空 → 0（不猜）');
  assert.equal(cardHasNone.activeWeights.intent, WEIGHTS.intent, '有信号，参与分母');

  // 卡片带着情绪、草稿却什么都没带：草稿没给信号，该维度同样不计入。
  const cardHasEmotion = scoreCandidate({
    candidate: { card: { ...bare, emotions: ['tired'] }, createdAt: NOW }, context: {}, now: NOW,
  });
  assert.equal(cardHasEmotion.parts.intent, 0.5, '草稿没带意图/情绪 → parts 中性');
  assert.equal('intent' in cardHasEmotion.activeWeights, false, '没问过就不计分');
});

test('草稿既无意图也无情绪：不会因为卡片有 emotions 就白拿 1.0', () => {
  const scored = scoreCandidate({
    candidate: { card: CURATED_CARD, createdAt: NOW }, context: { query: '明天要交作业' }, now: NOW,
  });
  assert.equal(scored.parts.intent, 0.5, '想要集合全空 → parts 中性（不因为卡片有 emotions 就白拿分）');
  assert.equal('intent' in scored.activeWeights, false, '无信号维度不进分母');
});

test('归一化：完全没有语气/场景信号时，仅凭语义也能超过 0.72', () => {
  // 卡片与草稿都不带任何 intent/tone/scene 线索（「猫猫」只有字面）。
  // 活跃维度 = 语义 0.30 + 正反馈 0.10 + 角色 0.10 + 新鲜度 0.05 = 0.55。
  // 完美字面命中 ⇒ (0.30·1 + 0.10·0.5 + 0.10·0.5 + 0.05·1) / 0.55 = 0.8182 > 0.72。
  // 修复前这里恰好是 0.675——「没有信号」被当成一个够不到的天花板。
  const card = { literal: '猫猫 猫 喵喵', intents: [], emotions: [], tone: [], scenes: [], avoidWhen: [], aggression: 0 };
  const scored = scoreCandidate({ candidate: { card, createdAt: NOW }, context: contextFromDraft('猫猫'), now: NOW });
  assert.equal('intent' in scored.activeWeights, false, '草稿没有意图/情绪信号');
  assert.equal('tone' in scored.activeWeights, false, '草稿没有语气信号');
  assert.equal('context' in scored.activeWeights, false, '草稿没有场景/风险信号');
  assert.ok(Math.abs(scored.fitScore - 0.8182) < 1e-3, `应约 0.8182，实际 ${scored.fitScore}`);
  assert.ok(scored.fitScore > DEFAULT_CONFIG.retrieval.minFitScore, '缺席的信号绝不能封顶');
});

test('情绪维与场景风险同向：冲突语境的草稿会压低愤怒类素材', () => {
  const angryCard = { literal: '生气 火大', intents: [], emotions: ['anger'], scenes: [], avoidWhen: ['serious-conflict'], aggression: 1 };
  const calm = scoreCandidate({
    candidate: { card: angryCard, createdAt: NOW }, context: contextFromDraft('今天天气不错'), now: NOW,
  });
  const conflict = scoreCandidate({
    candidate: { card: angryCard, createdAt: NOW }, context: contextFromDraft('对不起，我们别吵了'), now: NOW,
  });
  assert.ok(conflict.penalties.scene > 0, '冲突语境下愤怒素材必须吃到场景风险罚分');
  assert.ok(conflict.fitScore < calm.fitScore, `冲突语境应更低：${conflict.fitScore} vs ${calm.fitScore}`);
});
