/**
 * 检索与重排（E2）。设计文档 §6.2 的召回顺序，逐条对应到函数：
 *
 *   1. **检索前硬门**（`hardGate`）：来源作用域 + 审核态 + 发送格式 + 用户禁用词。
 *      可见性是硬门，不可被任何分数绕过（`scopes.mjs` 的 `visibilityGate` 是唯一裁决者）。
 *   2. **FTS5 召回**：由注入的 library 门面负责（本层不直接写 SQL）。
 *   3. **加权重排**：语义 0.30 / 语用意图 0.20 / 语气关系 0.15 / 语境 0.10 / 正反馈 0.10 /
 *      角色风格 0.10 / 新鲜度 0.05，再减去「重复」与「场景风险」两项惩罚。
 *   4. **只返回 3–5 个 `{assetId, summary, intents, avoidWhen}`**：给模型的候选是窄结构，
 *      没有路径、没有字节、没有原始 URL。
 *
 * ── 注入的 library 窄接口（本层用到的最小面）──────────────────────────────────
 * 只要求一个方法，签名与返回结构如下（Lead 收尾时用 `fromLibrary()` 与 task-1 的
 * `library.mjs` 对齐；适配器只调它的公开方法，不碰内部实现）：
 *
 *   library.candidates({ usable: string[], query: string, limit: number })
 *     → Array<{
 *         assetId: string,
 *         moderationState: string,          // approved|review|quarantined|disabled|revoked
 *         kind: string,                     // png|jpeg|gif|webp|…
 *         mime: string,
 *         createdAt: number,
 *         visibility: Array<{scope: string, approval: string}>,
 *         card: null | {
 *           literal, ocr, intents[], emotions[], tone[], rhetoric[], scenes[],
 *           avoidWhen[], aggression, confidence, modelVersion
 *         }
 *       }>
 *
 * 另有两个可选注入（缺省即视为中性，不猜）：
 *   feedbackScore({ assetId, scope }) → 0..1（0.5 中性）   —— feedback.mjs 提供
 *   isSuppressed({ assetId, scope }) → boolean            —— feedback.mjs 提供
 *   personaStyle(assetId, card) → 0..1（缺省 0.5）        —— 角色贴合度，暂由调用方给
 */
import { visibilityGate } from './scopes.mjs';

/** 可以发出去的格式。`kind` 之外的 mime 一律硬门拒绝（不发未知容器）。 */
export const SENDABLE_KINDS = Object.freeze(['png', 'jpeg', 'gif', 'webp']);
export const CANDIDATE_MIN = 3;
export const CANDIDATE_MAX = 5;

/** 权重表：与设计文档示例同值，改这里就等于改行为，所以只在这里定义一次。 */
export const WEIGHTS = Object.freeze({
  semantic: 0.30, intent: 0.20, tone: 0.15, context: 0.10, feedback: 0.10, persona: 0.10, freshness: 0.05,
});
/** 惩罚项：重复（最近发过）与场景风险（素材自带的 avoidWhen 命中当前场景）。 */
export const PENALTIES = Object.freeze({ repeat: 0.35, sceneRisk: 0.45 });

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

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
  for (const char of source) {
    if (CJK.test(char)) { run.push(char); continue; }
    flush();
    if (/[a-z0-9]/.test(char)) out.add(char);
  }
  flush();
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
    const text = [candidate?.card?.literal, candidate?.card?.ocr, listOf(candidate?.card?.intents).join(' ')].join(' ');
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

/**
 * 单个候选的打分（纯函数，便于测试）。
 *
 * @param {{
 *   candidate: object, context: object, scope: string, now?: number,
 *   feedbackScore?: number, personaScore?: number, repeated?: boolean,
 * }} input
 * @returns {{fitScore: number, parts: object}}
 */
export function scoreCandidate({
  candidate, context = {}, scope = '', now = Date.now(),
  feedbackScore = 0.5, personaScore = 0.5, repeated = false,
} = {}) {
  const card = candidate?.card ?? {};
  const queryTokens = tokens(context.query ?? '');
  const literalTokens = tokens([card.literal, card.ocr].join(' '));
  const intentTokens = setOf(card.intents);
  const toneTokens = setOf(card.tone);
  const sceneTokens = setOf(card.scenes);
  const wantedIntents = setOf(context.intents);
  const wantedTone = setOf(context.tone);
  const wantedScenes = setOf(context.scenes);

  const semantic = Math.max(overlap(literalTokens, queryTokens), overlap(intentTokens, queryTokens) * 0.8);
  const intent = wantedIntents.size === 0 ? 0.5 : overlap(intentTokens, wantedIntents);
  const tone = wantedTone.size === 0 ? 0.5 : Math.max(overlap(toneTokens, wantedTone), overlap(toneTokens, wantedTone) * 0.9);
  const sceneHit = wantedScenes.size === 0 ? 0.5 : overlap(sceneTokens, wantedScenes);
  const contextScore = Math.max(sceneHit, intent * 0.6);

  const parts = {
    semantic: clamp01(semantic), intent: clamp01(intent), tone: clamp01(tone), context: clamp01(contextScore),
    feedback: clamp01(feedbackScore), persona: clamp01(personaScore),
    freshness: freshnessScore(candidate?.createdAt, now),
  };
  const weighted =
    parts.semantic * WEIGHTS.semantic + parts.intent * WEIGHTS.intent + parts.tone * WEIGHTS.tone +
    parts.context * WEIGHTS.context + parts.feedback * WEIGHTS.feedback +
    parts.persona * WEIGHTS.persona + parts.freshness * WEIGHTS.freshness;

  // 场景风险：素材自己的 avoidWhen 命中当前场景标签（严重求助/现实争执/道歉…），重罚但不硬砍，
  // 硬砍留给 decision 的禁忌硬门（那里有明确原因码）。aggression 高的素材同样收一点风险。
  const avoid = setOf(card.avoidWhen);
  const risky = [...wantedScenes].some(scene => avoid.has(scene)) || [...setOf(context.riskTags)].some(tag => avoid.has(tag));
  const aggression = clamp01(card.aggression);
  const scenePenalty = risky ? PENALTIES.sceneRisk : aggression * PENALTIES.sceneRisk * 0.5;
  const repeatPenalty = repeated ? PENALTIES.repeat : 0;

  const fitScore = clamp01(weighted - scenePenalty - repeatPenalty);
  return { fitScore, parts, penalties: { scene: scenePenalty, repeat: repeatPenalty }, scope };
}

function summarize(card) {
  const literal = String(card?.literal ?? '').trim();
  const ocr = String(card?.ocr ?? '').trim();
  if (literal && ocr) return `${literal}（图上写着「${ocr}」）`.slice(0, 120);
  if (literal) return literal.slice(0, 120);
  const intents = listOf(card?.intents);
  if (ocr) return `图上写着「${ocr}」${intents.length ? `，用途：${intents.slice(0, 3).join('、')}` : ''}`.slice(0, 120);
  if (intents.length) return `用途：${intents.slice(0, 4).join('、')}`.slice(0, 120);
  return '（没有语义卡，仅凭场景命中）';
}

/** 对外候选：只有这四个字段，没有路径、没有字节、没有原始来源。 */
export function publicCandidate(assetId, card, fitScore) {
  return {
    assetId: String(assetId),
    summary: summarize(card),
    intents: listOf(card?.intents).slice(0, 6),
    avoidWhen: listOf(card?.avoidWhen).slice(0, 6),
    fitScore: Number(Number(fitScore).toFixed(4)),
  };
}

/**
 * 单个候选的过滤 + 打分。抽出来只是为了让 `retrieve()` 可读——硬门顺序不因重构而变：
 * 作用域 → 审核态 → 格式 → 禁用词 → 显式抑制 → 打分 → 门槛。
 * @returns {{keep: true, assetId: string, fitScore: number} | {keep: false, bucket: string}}
 */
function judgeCandidate({ candidate, usable, disabledTerms, now, scope, context, feedbackScore, isSuppressed, personaStyle, minFitScore, recentSet }) {
  const assetId = String(candidate?.assetId ?? '');
  if (!assetId) return { keep: false, bucket: 'kind' };
  const gate = hardGate({ candidate, usable, disabledTerms, now });
  if (!gate.ok) {
    if (gate.reasonCode === 'scope-not-visible' || gate.reasonCode === 'asset-not-approved') return { keep: false, bucket: 'scope' };
    if (gate.reasonCode === 'kind-not-sendable') return { keep: false, bucket: 'kind' };
    if (gate.reasonCode === 'user-disabled-term') return { keep: false, bucket: 'disabledTerm' };
    return { keep: false, bucket: 'moderation' };
  }
  let suppressed = false;
  try { suppressed = Boolean(isSuppressed?.({ assetId, scope })); } catch { suppressed = false; }
  if (suppressed) return { keep: false, bucket: 'suppressed' };

  let feedbackValue = 0.5;
  try { feedbackValue = Number(feedbackScore?.({ assetId, scope }) ?? 0.5); } catch { feedbackValue = 0.5; }
  let personaValue = 0.5;
  try { personaValue = Number(personaStyle?.(assetId, candidate?.card ?? {}) ?? 0.5); } catch { personaValue = 0.5; }

  const { fitScore } = scoreCandidate({
    candidate, context, scope, now, feedbackScore: feedbackValue, personaScore: personaValue,
    repeated: recentSet.has(assetId),
  });
  if (fitScore < Number(minFitScore)) return { keep: false, bucket: 'belowMin' };
  return { keep: true, assetId, fitScore, candidate };
}

/**
 * 检索 + 重排。
 *
 * @param {{
 *   library: {candidates: Function},
 *   usable: string[], context: object, scope: string,
 *   limit?: number, minFitScore?: number, now?: number,
 *   feedbackScore?: Function|null, isSuppressed?: Function|null,
 *   personaStyle?: Function|null, recent?: Set<string>|Array<string>|null,
 *   disabledTerms?: string[]|Set<string>|null,
 *   candidates?: number
 * }} input
 * @returns {{ok: boolean, candidates: object[], filtered: object, reasonCode: string, warnings: string[]}}
 */
export function retrieve({
  library, usable = [], context = {}, scope = 'own',
  limit = CANDIDATE_MAX, minFitScore = 0, now = Date.now(),
  feedbackScore = null, isSuppressed = null, personaStyle = null,
  recent = null, disabledTerms = null, candidates = null,
} = {}) {
  const take = Math.max(CANDIDATE_MIN, Math.min(CANDIDATE_MAX, Number(limit) || CANDIDATE_MAX));
  const warnings = [];
  const filtered = { scope: 0, kind: 0, moderation: 0, disabledTerm: 0, suppressed: 0, belowMin: 0 };
  if (!library || typeof library.candidates !== 'function') {
    return { ok: false, candidates: [], filtered, reasonCode: 'library-unavailable', warnings: ['图库不可用，本轮没有候选。'] };
  }

  let rows = [];
  try {
    // 多取一些再过滤：硬门与惩罚都可能砍掉大半，召回量本身很便宜。
    rows = candidates ?? library.candidates({ usable, query: String(context.query ?? ''), limit: take * 4 }) ?? [];
  } catch (error) {
    return {
      ok: false, candidates: [], filtered, reasonCode: 'retrieval-failed',
      warnings: [`检索失败：${String(error?.message ?? error).slice(0, 160)}`],
    };
  }

  const recentSet = setOf(recent);
  const scored = [];
  for (const candidate of Array.isArray(rows) ? rows : []) {
    const judged = judgeCandidate({ candidate, usable, disabledTerms, now, scope, context, feedbackScore, isSuppressed, personaStyle, minFitScore, recentSet });
    if (!judged.keep) {
      if (judged.bucket in filtered) filtered[judged.bucket] += 1;
      continue;
    }
    scored.push(judged);
  }

  scored.sort((a, b) => b.fitScore - a.fitScore || a.assetId.localeCompare(b.assetId));
  const picked = scored.slice(0, take).map(row => publicCandidate(row.assetId, row.candidate?.card, row.fitScore));
  if (picked.length < CANDIDATE_MIN) {
    warnings.push(`只有 ${picked.length} 个候选（目标 ${CANDIDATE_MIN}–${CANDIDATE_MAX}）；候选少不等于该发图。`);
  }
  return {
    ok: true, candidates: picked, filtered,
    reasonCode: picked.length ? '' : 'no-candidates',
    matched: scored.length,
    warnings,
  };
}

/**
 * 适配器：把 task-1 的真实 `library.mjs` 包成上面的窄接口。
 *
 * 只用它的公开方法（`search` / `getAsset` / `gateFor`），所以两边内部实现怎么变都不会
 * 影响到本层；如果将来 library 自己提供 `candidates()`，这个适配器自动让位。
 */
export function fromLibrary(library, { poolLimit = 60 } = {}) {
  if (!library || typeof library.getAsset !== 'function') throw new Error('fromLibrary 需要 library.mjs 的图库句柄。');
  return {
    candidates({ usable = [], query = '', limit = 20 } = {}) {
      const ids = [];
      if (typeof library.search === 'function' && String(query).trim()) {
        ids.push(...library.search(query, { limit: Math.max(Number(limit) || 20, poolLimit) }));
      }
      // 没命中就把「本作用域可发」的素材按新到旧补齐，保证候选池不是空的（不硬塞，只提供）。
      if (ids.length === 0 && typeof library.listAssets === 'function') {
        const listed = library.listAssets({ scope: usable[0] ?? '', moderation: 'approved', limit: poolLimit });
        for (const item of listed?.items ?? []) ids.push(String(item.assetId ?? item.id ?? ''));
      }
      const rows = [];
      for (const assetId of [...new Set(ids)]) {
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
        });
      }
      return rows;
    },
  };
}

export default {
  SENDABLE_KINDS, CANDIDATE_MIN, CANDIDATE_MAX, WEIGHTS, PENALTIES,
  tokens, overlap, hardGate, freshnessScore, scoreCandidate, publicCandidate, retrieve, fromLibrary,
};
