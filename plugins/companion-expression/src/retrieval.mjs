/**
 * 检索与重排（E2）。设计文档 §6.2 的召回顺序，逐条对应到函数：
 *
 *   0. **上下文归一化**（`contextFromDraft`）：草稿 → 意图/情绪/语气/场景标签，用的是
 *      `synonyms.mjs` 那份**唯一**的中文近义表（与入库的 `analyzer.mjs` 同一份，不再各写一套）。
 *      曾经这里只做字符重合：于是「笑着答应、乖巧点头、轻松愉快」一个标签都抽不出来，
 *      只能比「点」「头」「松」这种偶然单字，相关素材被压成 0.30 分、偏题素材反而进前三。
 *   1. **检索前硬门**（`hardGate`）：来源作用域 + 审核态 + 发送格式 + 用户禁用词。
 *      可见性是硬门，不可被任何分数绕过（`scopes.mjs` 的 `visibilityGate` 是唯一裁决者）。
 *   2. **多路召回**（`fromLibrary().recall`）：原始短查询词面 / 归一化标签 / 近义扩展 /
 *      本会话已审核素材补齐，四路合并去重。补齐**只扩充待排序池**，不作为「适合发送」的依据。
 *      候选池有明确上限（`DEFAULT_POOL_LIMIT`，可由 `retrieval.poolLimit` 配置），不整库扫描。
 *   3. **加权重排**：语义 0.22 / 意图 0.20 / 情绪 0.18 / 语气 0.12 / 语境 0.08 /
 *      正反馈 0.08 / 角色风格 0.07 / 新鲜度 0.05，再减「重复」「场景风险」「冲突」三项惩罚。
 *      归一化口径：**只有真的有信号的维度才计入分母**（`activeWeights` 是实际在用的权重和）。
 *   4. **冲突约束**：意图/情绪/语气里出现相反表达（认同↔拒绝、开心↔悲伤、安慰↔嘲讽…）时，
 *      非混合语境下该候选直接判 `incompatible`——不允许「字符重合」把反义素材抬上来；
 *      混合语境（`mixed=true`，如「好气又好笑」）只罚分，不硬砍。
 *   5. **只返回 3–5 个 `{assetId, summary, intents, avoidWhen, fitScore}`**：给模型的候选是窄结构，
 *      没有路径、没有字节、没有原始 URL。低分项只进 `diagnostics`，不进 `candidates`。
 *
 * ── 注入的 library 窄接口（本层用到的最小面）──────────────────────────────────
 * 首选（多路召回）：
 *   library.recall({ usable: string[], lexical: string, labels: string[], expansions: string[],
 *                    poolLimit: number })
 *     → { rows: Array<candidate>, stats: {lexical, label, expand, supplement, merged} }
 * 兼容（单路召回，测试里的假图库仍可用）：
 *   library.candidates({ usable, query, limit }) → Array<candidate>
 *
 * candidate = {
 *   assetId, moderationState, kind, mime, createdAt,
 *   visibility: Array<{scope, approval}>,
 *   card: null | { literal, ocr, intents[], emotions[], tone[], rhetoric[], scenes[],
 *                  avoidWhen[], aggression, confidence, modelVersion, hint? }
 * }
 *
 * 另有两个可选注入（缺省即视为中性，不猜）：
 *   feedbackScore({ assetId, scope }) → 0..1（0.5 中性）   —— feedback.mjs 提供
 *   isSuppressed({ assetId, scope }) → boolean            —— feedback.mjs 提供
 *   personaStyle(assetId, card) → 0..1（缺省 0.5）        —— 角色贴合度，暂由调用方给
 */
import { visibilityGate } from './scopes.mjs';
import {
  CONFLICTS, normalizeText, gradedOverlap, expandTerms, EMOTION_SIMILARITY, TONE_SIMILARITY,
} from './synonyms.mjs';

/** 可以发出去的格式。`kind` 之外的 mime 一律硬门拒绝（不发未知容器）。 */
export const SENDABLE_KINDS = Object.freeze(['png', 'jpeg', 'gif', 'webp']);
export const CANDIDATE_MIN = 3;
export const CANDIDATE_MAX = 5;
/** 待排序候选池的默认上限（多路召回合并后）。可以由 `retrieval.poolLimit` 配置。 */
export const DEFAULT_POOL_LIMIT = 60;
export const POOL_LIMIT_MAX = 200;

/**
 * 权重表：改这里就等于改行为，所以只在这里定义一次。
 *
 * `emotion` 与 `intent` 拆开：表情包首先是情绪素材，「意图相同但情绪相反」和「情绪相近但
 * 意图不同」是两种不同贴切度，混在一个维度里就分不出来。
 */
export const WEIGHTS = Object.freeze({
  semantic: 0.22, intent: 0.20, emotion: 0.18, tone: 0.12, context: 0.08, feedback: 0.08, persona: 0.07, freshness: 0.05,
});
/** 惩罚项：重复（最近发过）、场景风险（素材自带的 avoidWhen 命中当前场景）、相反表达。 */
export const PENALTIES = Object.freeze({ repeat: 0.35, sceneRisk: 0.45, conflict: 0.30 });

/** CJK 判定（与 library.mjs 的 FTS 切词口径一致）。 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const LATIN_WORD = /[a-z0-9]/;

/** 文本 → 词集合。中文按「单字 + 相邻二字」，拉丁按整词；与 library.mjs 的 FTS 口径一致。 */
export function tokens(text) {
  const source = String(text ?? '').toLowerCase().slice(0, 2000);
  const out = new Set();
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    for (const char of run) out.add(char);
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run[i] + run[i + 1]);
    run = [];
  };
  let word = '';
  const flushWord = () => {
    if (word) out.add(word);
    word = '';
  };
  for (const char of source) {
    if (CJK.test(char)) { flushWord(); run.push(char); continue; }
    flush();
    if (LATIN_WORD.test(char)) { word += char; continue; }
    flushWord();
  }
  flush();
  flushWord();
  return out;
}

/** 标点与全角符号：由它们组成的「词」不是语义证据（`应、`/`、点` 只是切词副产品）。 */
const PUNCT = /[\u3000-\u303f\uff00-\ufff0]/;

/**
 * 打分用的词集合：**丢掉中文单字与带标点的词**。
 *
 * 这是「中文字符重合让无关素材拿分」的修法：`头晕` 与 `轻松愉快` 只共享标点，单字重合
 * （「头」「松」）纯属偶然，而 `应、`/`、点` 这种标点+字的二元组更不是语义。只保留
 * 相邻二字与拉丁整词，重合才有「这是一个词」的意义。FTS 索引仍保留单字（召回要宽），
 * 但**排序不吃单字与标点分**。
 */
export function scoringTokens(text) {
  const out = new Set();
  for (const token of tokens(text)) {
    if (token.length === 1 && CJK.test(token)) continue;
    if ([...token].some(char => PUNCT.test(char))) continue;
    out.add(token);
  }
  return out;
}

/** `b` 中的词有多少落进了 `a`（0–1）。两边空集都算 0，不白送分。 */
export function overlap(a, b) {
  const want = b instanceof Set ? b : tokens(b);
  if (want.size === 0) return 0;
  const have = a instanceof Set ? a : tokens(a);
  if (have.size === 0) return 0;
  let hits = 0;
  for (const token of want) if (have.has(token)) hits += 1;
  return hits / want.size;
}

function setOf(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map(item => String(item).toLowerCase()));
  if (typeof value === 'string' && value.trim()) return new Set([value.trim().toLowerCase()]);
  return new Set();
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function listOf(value) {
  return Array.isArray(value) ? value.map(item => String(item)) : [];
}

/**
 * 候选卡的标签：结构化字段 + **从 literal 现算**的归一化标签取并集。
 *
 * 为什么必须现算：历史素材（以及导入包里手写的卡）常常只有 `literal`，`intents/emotions`
 * 是空的。只看结构化字段就等于把这些素材当成「没有任何语义」。现算的结果与查询侧完全
 * 同源（同一个 `normalizeText`），所以「好呀、点头、收到」也能对上「答应/轻松」。
 */
export function cardLabelsOf(card = {}) {
  const derived = normalizeText([card?.literal, card?.ocr, card?.hint].filter(Boolean).join(' '));
  return {
    intents: [...new Set([...listOf(card?.intents).map(item => item.toLowerCase()), ...derived.intents])],
    emotions: [...new Set([...listOf(card?.emotions).map(item => item.toLowerCase()), ...derived.emotions])],
    tone: [...new Set([...listOf(card?.tone).map(item => item.toLowerCase()), ...derived.tone])],
    scenes: [...new Set([...listOf(card?.scenes).map(item => item.toLowerCase()), ...derived.scenes])],
    labels: [...new Set([...listOf(card?.intents), ...listOf(card?.emotions), ...listOf(card?.tone),
      ...listOf(card?.scenes), ...derived.labels].map(item => String(item).toLowerCase()))],
  };
}

/**
 * 硬门。四道，顺序即文档顺序：作用域 → 审核态 → 格式 → 用户禁用词。
 * @returns {{ok: true, scope: string} | {ok: false, reasonCode: string}}
 */
export function hardGate({ candidate, usable, disabledTerms = null, now = Date.now() } = {}) {
  const visibility = Array.isArray(candidate?.visibility) ? candidate.visibility : [];
  const gate = visibilityGate({ visibility, usable });
  if (!gate.ok) return { ok: false, reasonCode: gate.reason };
  if (!SENDABLE_KINDS.includes(String(candidate?.kind ?? ''))) {
    return { ok: false, reasonCode: 'kind-not-sendable' };
  }
  const state = String(candidate?.moderationState ?? '');
  if (state !== 'approved') return { ok: false, reasonCode: `asset-${state || 'unknown'}` };
  const terms = setOf(disabledTerms);
  if (terms.size > 0) {
    const labels = cardLabelsOf(candidate?.card);
    const text = [candidate?.card?.literal, candidate?.card?.ocr, labels.labels.join(' ')].join(' ');
    for (const term of terms) {
      if (term && String(text).toLowerCase().includes(term)) return { ok: false, reasonCode: 'user-disabled-term' };
    }
  }
  void now;
  return { ok: true, scope: gate.scope };
}

/** 新鲜度分：越近入库越高，30 天线性衰减到 0。 */
export function freshnessScore(createdAt, now = Date.now()) {
  const age = Math.max(0, Number(now) - Number(createdAt || 0));
  const day = 86_400_000;
  return clamp01(1 - age / (30 * day));
}

/** 草稿进入分析器前的截断上限，与 `tokens()` 同一个数：分析看的那段话就是打分看的那段话。 */
const DRAFT_LIMIT = 2000;

/**
 * 从草稿文本派生检索上下文。**全模块只有这一处推导**：工具、HTTP 实验室、测试都调它，
 * 所以「真实回合会怎么判」与「实验室说会怎么判」不可能走成两套口径。
 *
 * `avoidWhen` 直接当 `riskTags` 用：草稿落在冲突/道歉语境里时，愤怒类素材自带的
 * `serious-conflict`/`apology` 标签就该命中并吃场景风险罚分。
 *
 * @param {string} text 草稿（用户这句话 / 待发的文字）
 * @returns {{query, intents, emotions, tone, scenes, riskTags, labels, mixed, suppressed, expansions}}
 */
export function contextFromDraft(text = '') {
  const query = String(text ?? '').slice(0, DRAFT_LIMIT);
  const normalized = normalizeText(query);
  return {
    query,
    intents: normalized.intents,
    emotions: normalized.emotions,
    tone: normalized.tone,
    scenes: normalized.scenes,
    riskTags: normalized.avoidWhen,
    labels: normalized.labels,
    mixed: normalized.mixed === true,
    suppressed: normalized.suppressed,
    // 召回用的近义扩展（只扩同类别，不跨类别，见 synonyms.mjs）。
    expansions: expandTerms(normalized),
  };
}

/**
 * 单个候选的打分（纯函数，便于测试）。
 *
 * 归一化规则：**缺席的信号不计入分母**。`parts` 保留各维原始分（便于诊断），`fitScore` 只用
 * `activeWeights`（真的有信号的维度）作分母——否则缺席维度记 0.5 会变成隐藏天花板。
 *
 * @returns {{fitScore, parts, activeWeights, penalties, conflicts, compatible, scope}}
 */
export function scoreCandidate({
  candidate, context = {}, scope = '', now = Date.now(),
  feedbackScore = 0.5, personaScore = 0.5, repeated = false,
} = {}) {
  const card = candidate?.card ?? {};
  const labels = cardLabelsOf(card);
  const queryTokens = scoringTokens(context.query ?? '');
  const literalTokens = scoringTokens([card.literal, card.ocr].join(' '));
  const wantedIntents = setOf(context.intents);
  const wantedEmotions = setOf(context.emotions);
  const wantedTone = setOf(context.tone);
  const wantedScenes = setOf(context.scenes);
  const riskTags = setOf(context.riskTags);

  const lexical = overlap(literalTokens, queryTokens);
  const semantic = lexical;

  // 意图/情绪/语气都用「分级重合」：完全一致算 1，相近表达按相似表打折，相反表达算 0。
  const intent = gradedOverlap(wantedIntents, setOf(labels.intents));
  const emotion = gradedOverlap(wantedEmotions, setOf(labels.emotions), EMOTION_SIMILARITY);
  const tone = gradedOverlap(wantedTone, setOf(labels.tone), TONE_SIMILARITY);
  const scenes = gradedOverlap(wantedScenes, setOf(labels.scenes));
  const contextScore = scenes === null ? 0.5 : Math.max(scenes, lexical * 0.5);

  const parts = {
    semantic: clamp01(semantic),
    intent: intent === null ? 0.5 : clamp01(intent),
    emotion: emotion === null ? 0.5 : clamp01(emotion),
    tone: tone === null ? 0.5 : clamp01(tone),
    context: clamp01(contextScore),
    feedback: clamp01(feedbackScore),
    persona: clamp01(personaScore),
    freshness: freshnessScore(candidate?.createdAt, now),
  };
  // 哪些维度真的有信号：语义永远是（草稿本身就是查询），正反馈/角色风格/新鲜度永远有值，
  // 另外四维只在调用方真的给了对应的「想要什么」时才算数。空集不是「中性」，是「没问」。
  const active = {
    semantic: true,
    intent: wantedIntents.size > 0,
    emotion: wantedEmotions.size > 0,
    tone: wantedTone.size > 0,
    context: wantedScenes.size > 0 || riskTags.size > 0,
    feedback: true,
    persona: true,
    freshness: true,
  };

  const activeWeights = {};
  let weighted = 0;
  let weightSum = 0;
  for (const key of Object.keys(parts)) {
    if (active[key] !== true) continue;
    activeWeights[key] = WEIGHTS[key];
    weighted += parts[key] * WEIGHTS[key];
    weightSum += WEIGHTS[key];
  }
  const normalised = weightSum > 0 ? weighted / weightSum : 0;

  // 场景风险：素材自己的 avoidWhen 命中当前场景标签（严重求助/现实争执/道歉…），重罚但不硬砍。
  const avoid = setOf(card.avoidWhen);
  const risky = [...wantedScenes].some(scene => avoid.has(scene)) || [...riskTags].some(tag => avoid.has(tag));
  const aggression = clamp01(card.aggression);
  const scenePenalty = risky ? PENALTIES.sceneRisk : aggression * PENALTIES.sceneRisk * 0.5;

  // 相反表达：草稿是混合语境时不硬砍（好气又好笑本来就同时要生气与发笑），只罚分；
  // 否则直接判 incompatible，分数再高也不许发（防「字符重合挑到反义素材」）。
  const wantedAll = new Set([...wantedIntents, ...wantedEmotions, ...wantedTone]);
  const cardAll = new Set(labels.labels);
  const conflicts = conflictsAcross(wantedAll, cardAll);
  const mixed = context.mixed === true;
  const incompatible = conflicts.length > 0 && !mixed;
  const conflictPenalty = conflicts.length > 0 ? PENALTIES.conflict : 0;

  const repeatPenalty = repeated ? PENALTIES.repeat : 0;
  const fitScore = clamp01(normalised - scenePenalty - conflictPenalty - repeatPenalty);
  return {
    fitScore, parts, activeWeights,
    penalties: { scene: scenePenalty, repeat: repeatPenalty, conflict: conflictPenalty },
    conflicts, incompatible, scope,
  };
}

/**
 * 相反对（跨家族）：认同↔拒绝、开心↔悲伤、安慰↔嘲讽、轻松↔严肃… 与 `synonyms.mjs` 的
 * `CONFLICTS` 同口径——这里直接引用那份表，**不再抄一份**（两处不一致正是反义误命中的来源）。
 */
export function conflictsAcross(a, b) {
  const left = a instanceof Set ? a : new Set(Array.isArray(a) ? a : []);
  const right = b instanceof Set ? b : new Set(Array.isArray(b) ? b : []);
  const pairs = [];
  for (const [x, y] of CONFLICTS) {
    if ((left.has(x) && right.has(y)) || (left.has(y) && right.has(x))) pairs.push([x, y]);
  }
  return pairs;
}

function summarize(card) {
  const literal = String(card?.literal ?? '').trim();
  const ocr = String(card?.ocr ?? '').trim();
  if (literal && ocr) return `${literal}（图上写着「${ocr}」）`.slice(0, 120);
  if (literal) return literal.slice(0, 120);
  const labels = cardLabelsOf(card).labels;
  if (ocr) return `图上写着「${ocr}」${labels.length ? `，表达：${labels.slice(0, 3).join('、')}` : ''}`.slice(0, 120);
  if (labels.length) return `表达：${labels.slice(0, 4).join('、')}`.slice(0, 120);
  return '（没有语义卡，仅凭场景命中）';
}

/** 对外候选：只有这五个字段，没有路径、没有字节、没有原始来源。 */
export function publicCandidate(assetId, card, fitScore) {
  return {
    assetId: String(assetId),
    summary: summarize(card),
    intents: cardLabelsOf(card).intents.slice(0, 6),
    avoidWhen: listOf(card?.avoidWhen).slice(0, 6),
    fitScore: Number(Number(fitScore).toFixed(4)),
  };
}

/** 过滤桶：诊断用。命名与 `filtered` 一一对应，避免把不同原因都归成 low-fit。 */
export const FILTER_BUCKETS = Object.freeze([
  'scope', 'kind', 'moderation', 'disabledTerm', 'suppressed', 'conflict', 'belowMin',
]);

function bucketFor(reasonCode) {
  if (reasonCode === 'scope-not-visible' || reasonCode === 'asset-not-approved') return 'scope';
  if (reasonCode === 'kind-not-sendable') return 'kind';
  if (reasonCode === 'user-disabled-term') return 'disabledTerm';
  return 'moderation';
}

/**
 * 单个候选的过滤 + 打分。抽出来只是为了让 `retrieve()` 可读——硬门顺序不因重构而变：
 * 作用域 → 审核态 → 格式 → 禁用词 → 显式抑制 → 打分 → 冲突 → 门槛。
 */
function judgeCandidate({
  candidate, usable, disabledTerms, now, scope, context, feedbackScore, isSuppressed,
  personaStyle, minFitScore, recentSet,
}) {
  const assetId = String(candidate?.assetId ?? '');
  if (!assetId) return { keep: false, bucket: 'kind', reasonCode: 'asset-id-missing' };
  const gate = hardGate({ candidate, usable, disabledTerms, now });
  if (!gate.ok) return { keep: false, bucket: bucketFor(gate.reasonCode), reasonCode: gate.reasonCode };
  let suppressed = false;
  try { suppressed = Boolean(isSuppressed?.({ assetId, scope })); } catch { suppressed = false; }
  if (suppressed) return { keep: false, bucket: 'suppressed', reasonCode: 'suppressed' };

  let feedbackValue = 0.5;
  try { feedbackValue = Number(feedbackScore?.({ assetId, scope }) ?? 0.5); } catch { feedbackValue = 0.5; }
  let personaValue = 0.5;
  try { personaValue = Number(personaStyle?.(assetId, candidate?.card ?? {}) ?? 0.5); } catch { personaValue = 0.5; }

  const scored = scoreCandidate({
    candidate, context, scope, now, feedbackScore: feedbackValue, personaScore: personaValue,
    repeated: recentSet.has(assetId),
  });
  if (scored.incompatible) {
    return { keep: false, bucket: 'conflict', reasonCode: 'conflict-opposite', scored };
  }
  if (scored.fitScore < Number(minFitScore)) return { keep: false, bucket: 'belowMin', reasonCode: 'below-min-fit', scored };
  return { keep: true, assetId, fitScore: scored.fitScore, candidate, scored, scope };
}

/**
 * 检索 + 重排。
 *
 * @param {{
 *   library: {recall?: Function, candidates?: Function},
 *   usable: string[], context: object, scope: string,
 *   limit?: number, minFitScore?: number, now?: number, poolLimit?: number,
 *   feedbackScore?: Function|null, isSuppressed?: Function|null,
 *   personaStyle?: Function|null, recent?: Set<string>|Array<string>|null,
 *   disabledTerms?: string[]|Set<string>|null, candidates?: Array<object>|null,
 * }} input
 * @returns {{ok, candidates, filtered, reasonCode, warnings, matched, diagnostics}}
 */
export function retrieve({
  library, usable = [], context = {}, scope = 'own',
  limit = CANDIDATE_MAX, minFitScore = 0, now = Date.now(), poolLimit = DEFAULT_POOL_LIMIT,
  feedbackScore = null, isSuppressed = null, personaStyle = null,
  recent = null, disabledTerms = null, candidates = null,
} = {}) {
  const take = Math.max(CANDIDATE_MIN, Math.min(CANDIDATE_MAX, Number(limit) || CANDIDATE_MAX));
  const cap = Math.max(take * 4, Math.min(POOL_LIMIT_MAX, Number(poolLimit) || DEFAULT_POOL_LIMIT));
  const warnings = [];
  const filtered = { scope: 0, kind: 0, moderation: 0, disabledTerm: 0, suppressed: 0, conflict: 0, belowMin: 0 };
  const diagnostics = {
    query: String(context?.query ?? ''),
    normalized: {
      intents: listOf(context?.intents), emotions: listOf(context?.emotions),
      tone: listOf(context?.tone), scenes: listOf(context?.scenes), mixed: context?.mixed === true,
    },
    recall: { lexical: 0, label: 0, expand: 0, supplement: 0, merged: 0, poolCap: cap, paths: {} },
    gate: { evaluated: 0, passed: 0 },
    filtered,
    scored: [],
    compatible: [],
    threshold: Number(minFitScore) || 0,
    reasonCode: '',
  };
  if (!library || (typeof library.recall !== 'function' && typeof library.candidates !== 'function')) {
    return { ok: false, candidates: [], filtered, reasonCode: 'library-unavailable', warnings: ['图库不可用，本轮没有候选。'], matched: 0, diagnostics };
  }

  // 1) 多路召回（或测试里的单路假图库）。
  let rows = [];
  const recallMap = new Map();
  try {
    if (Array.isArray(candidates)) {
      rows = candidates;
      diagnostics.recall.merged = rows.length;
    } else if (typeof library.recall === 'function') {
      const recalled = library.recall({
        usable,
        lexical: String(context.query ?? ''),
        labels: listOf(context.labels).length ? listOf(context.labels) : [...listOf(context.intents), ...listOf(context.emotions), ...listOf(context.tone), ...listOf(context.scenes)],
        expansions: listOf(context.expansions),
        poolLimit: cap,
      });
      rows = Array.isArray(recalled?.rows) ? recalled.rows : [];
      const stats = recalled?.stats ?? {};
      diagnostics.recall = { ...diagnostics.recall, ...stats, poolCap: cap };
      for (const row of rows) {
        const id = String(row?.assetId ?? '');
        if (!id) continue;
        recallMap.set(id, row?.recallPath ?? []);
        for (const path of row?.recallPath ?? []) {
          diagnostics.recall.paths[path] = Number(diagnostics.recall.paths[path] ?? 0) + 1;
        }
      }
    } else {
      rows = library.candidates({ usable, query: String(context.query ?? ''), limit: cap }) ?? [];
      diagnostics.recall.merged = Array.isArray(rows) ? rows.length : 0;
    }
  } catch (error) {
    return {
      ok: false, candidates: [], filtered, reasonCode: 'retrieval-failed', diagnostics,
      warnings: [`检索失败：${String(error?.message ?? error).slice(0, 160)}`],
    };
  }

  // 2) 去重（同一 assetId 可能同时被多路命中）。
  const unique = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.assetId ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(row);
  }
  diagnostics.recall.merged = unique.length;
  diagnostics.gate.evaluated = unique.length;

  const recentSet = setOf(recent);
  const scored = [];
  for (const candidate of unique) {
    const judged = judgeCandidate({
      candidate, usable, disabledTerms, now, scope, context, feedbackScore, isSuppressed,
      personaStyle, minFitScore, recentSet,
    });
    if (!judged.keep) {
      if (judged.bucket in filtered) filtered[judged.bucket] += 1;
      if (judged.scored) {
        diagnostics.scored.push({
          assetId: String(candidate.assetId), fitScore: Number(judged.scored.fitScore.toFixed(4)),
          bucket: judged.bucket, reasonCode: judged.reasonCode,
          parts: judged.scored.parts, conflicts: judged.scored.conflicts,
        });
      }
      continue;
    }
    diagnostics.gate.passed += 1;
    scored.push({
      assetId: judged.assetId, card: judged.candidate?.card, fitScore: judged.fitScore,
      recallPath: recallMap.get(judged.assetId) ?? [], scored: judged.scored,
    });
    diagnostics.scored.push({
      assetId: judged.assetId, fitScore: Number(judged.fitScore.toFixed(4)), bucket: 'ok',
      reasonCode: '', parts: judged.scored.parts, conflicts: judged.scored.conflicts,
    });
  }

  // 3) 排序：分数优先，同分按 id 稳定（不靠新鲜度、不靠默认中性偏好）。
  scored.sort((a, b) => b.fitScore - a.fitScore || a.assetId.localeCompare(b.assetId));
  const picked = scored.slice(0, take);
  diagnostics.compatible = picked.map(row => ({
    assetId: row.assetId, fitScore: Number(row.fitScore.toFixed(4)), recallPath: row.recallPath,
    parts: row.scored.parts, conflicts: row.scored.conflicts,
  }));

  const candidateList = picked.map(row => publicCandidate(row.assetId, row.card, row.fitScore));
  if (picked.length > 0 && picked.length < CANDIDATE_MIN) {
    warnings.push(`只有 ${picked.length} 个候选（目标 ${CANDIDATE_MIN}–${CANDIDATE_MAX}）；候选少不等于该发图，不硬凑。`);
  }
  const reasonCode = candidateList.length ? '' : 'no-candidates';
  diagnostics.reasonCode = reasonCode;
  if (!candidateList.length) {
    diagnostics.noCandidateReason = filtered.belowMin > 0 ? 'all-below-fit-threshold' : (
      filtered.conflict > 0 ? 'opposite-expression-filtered' : 'nothing-recallable'
    );
  }
  return {
    ok: true, candidates: candidateList, filtered, reasonCode, warnings,
    matched: scored.length, diagnostics,
  };
}

/**
 * 适配器：把真实 `library.mjs` 包成上面的窄接口。
 *
 * 四路召回（任务书 §3 要求）：
 *   1. 原始短查询的词面匹配（FTS5 OR）；
 *   2. 归一化标签匹配（意图/情绪/语气/场景 id 本身就在 FTS 的 intents/scenes 列里）；
 *   3. 少量高置信度近义扩展（只扩同类别，见 synonyms.mjs）；
 *   4. 前几路不足时从**当前会话已审核素材**里补齐（只扩充待排序池）。
 *
 * 补齐**始终**做（不是只在零命中时做）：一张偏题命中不该阻止其它路补足。候选池有上限，
 * 不整库无限扫描。
 */
export function fromLibrary(library, { poolLimit = DEFAULT_POOL_LIMIT, supplementLimit = null } = {}) {
  if (!library || typeof library.getAsset !== 'function') throw new Error('fromLibrary 需要 library.mjs 的图库句柄。');
  const cap = Math.max(CANDIDATE_MAX, Math.min(POOL_LIMIT_MAX, Number(poolLimit) || DEFAULT_POOL_LIMIT));
  const supplementCap = Math.max(CANDIDATE_MAX, Math.min(cap, Number(supplementLimit) || cap));

  function idsOf(searchFn, query) {
    if (typeof searchFn !== 'function' || !String(query ?? '').trim()) return [];
    try {
      return searchFn(String(query), { limit: cap }).map(item => (typeof item === 'string' ? item : String(item?.assetId ?? item?.id ?? ''))).filter(Boolean);
    } catch {
      return [];
    }
  }

  return {
    recall({ usable = [], lexical = '', labels = [], expansions = [], poolLimit: wanted = cap } = {}) {
      const limit = Math.max(CANDIDATE_MAX, Math.min(POOL_LIMIT_MAX, Number(wanted) || cap));
      const paths = new Map();
      const mark = (id, path) => {
        const assetId = String(id ?? '');
        if (!assetId) return;
        const list = paths.get(assetId) ?? [];
        if (!list.includes(path)) list.push(path);
        paths.set(assetId, list);
      };
      // 1) 词面。
      for (const id of idsOf(library.search, lexical)) mark(id, 'lexical');
      // 2) 标签（英文 id 就是 FTS 里的索引词）。
      const labelText = Array.isArray(labels) ? labels.filter(Boolean).join(' ') : '';
      for (const id of idsOf(library.search, labelText)) mark(id, 'label');
      // 3) 近义扩展。
      const expansionText = Array.isArray(expansions) ? expansions.filter(Boolean).join(' ') : '';
      for (const id of idsOf(library.search, expansionText)) mark(id, 'expand');
      // 4) 补齐：本会话所有已审核素材（按作用域逐个取，新到旧）。只扩充池子，不代表适合发送。
      if (typeof library.listAssets === 'function' && usable.length > 0) {
        for (const scope of usable) {
          if (paths.size >= Math.max(limit, supplementCap)) break;
          try {
            const listed = library.listAssets({ scope, moderation: 'approved', sort: 'newest', limit: supplementCap });
            for (const item of listed?.items ?? []) mark(String(item.assetId ?? item.id ?? ''), 'supplement');
          } catch { /* 补齐失败不阻断其它召回 */ }
        }
      }
      const ids = [...paths.keys()].slice(0, Math.max(limit, supplementCap));
      const rows = [];
      for (const assetId of ids) {
        const asset = library.getAsset(assetId);
        if (!asset) continue;
        rows.push({
          assetId: asset.assetId,
          moderationState: asset.moderationState,
          kind: asset.kind,
          mime: asset.mime,
          createdAt: asset.createdAt,
          visibility: asset.visibility ?? [],
          card: asset.card ?? null,
          recallPath: paths.get(assetId) ?? [],
        });
      }
      return {
        rows,
        stats: {
          lexical: [...paths.values()].filter(list => list.includes('lexical')).length,
          label: [...paths.values()].filter(list => list.includes('label')).length,
          expand: [...paths.values()].filter(list => list.includes('expand')).length,
          supplement: [...paths.values()].filter(list => list.includes('supplement')).length,
          merged: rows.length,
          poolCap: Math.max(limit, supplementCap),
        },
      };
    },
    /** 兼容旧的单路接口（HTTP 实验室/测试假图库仍可能用它）。 */
    candidates({ usable = [], query = '', limit = 20 } = {}) {
      return this.recall({ usable, lexical: query, labels: [], expansions: [], poolLimit: Math.max(Number(limit) || 20, poolLimit) }).rows
        .map(row => ({ ...row, recallPath: undefined }));
    },
  };
}

export default {
  SENDABLE_KINDS, CANDIDATE_MIN, CANDIDATE_MAX, DEFAULT_POOL_LIMIT, POOL_LIMIT_MAX,
  WEIGHTS, PENALTIES, FILTER_BUCKETS,
  tokens, scoringTokens, overlap, hardGate, freshnessScore, contextFromDraft,
  cardLabelsOf, scoreCandidate, conflictsAcross, publicCandidate, retrieve, fromLibrary,
};
