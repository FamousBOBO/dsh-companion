/**
 * 统一回复计划（设计文档 §3 / §6.3）。
 *
 * 这一层解决的是现有 QQ 通道的一个真实缺陷：**文本发送成功即结束回合**，于是「先发文字后
 * 发图」里的图永远发不出去。做法不是改通道，而是把整轮内容**先规划成完整 parts**，再统一
 * 投递：`parts` 在任何一次发送之前就已经全部生成，投递层只按顺序执行，不再二次选图。
 *
 * 不可让步的三条：
 *   1. `parts` 在第一条文本发送前生成完毕——`plan()` 是纯函数，返回后序列就不再变化；
 *   2. 幂等键 `sha256(planId:index)`：断线重连、宿主热重载都不会把同一 part 发两次；
 *   3. `expiresAt` 让过期计划失效：半个计划和一条迟到的图都不该出现在对话里。
 *
 * 本模块不联网、不读盘、不碰数据库：只做纯结构的拼装与校验。
 */
import { createHash } from 'node:crypto';

/** 设计文档 §3 的 ResponseMode，去掉 `qq_face`（v1 不投递内置表情，见 NOT_IMPLEMENTED）。 */
export const MODES = Object.freeze(['silent', 'text_only', 'sticker_only', 'text_then_sticker', 'sticker_then_text']);
/** v1 明确不做的模式：写了也不会被当成合法计划。 */
export const NOT_IMPLEMENTED_MODES = Object.freeze(['qq_face']);
export const PART_KINDS = Object.freeze(['text', 'sticker']);
/** 计划默认有效时长：一轮对话内有效，超时不投递。 */
export const DEFAULT_PLAN_TTL_MS = 120_000;
/** 单轮最多 1 张图（config.delivery.maxPerTurn=1）；模式里也只允许 1 个 sticker part。 */
export const MAX_STICKER_PARTS = 1;
const TEXT_LIMIT = 4000;

function hash(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

/** 计划 id：turnId + 目标 + 轮内序号，稳定可复算（同一轮重放不会换 id）。 */
export function planIdFor({ turnId, target, seq = 0 } = {}) {
  const kind = String(target?.kind ?? 'dm');
  const id = String(target?.id ?? '');
  return `plan_${hash(`${String(turnId)}|${kind}|${id}|${Number(seq)}`).slice(0, 20)}`;
}

/** 幂等键：`sha256(planId:index)`，索引从 0 开始。 */
export function idempotencyKeyFor(planId, index) {
  return hash(`${String(planId)}:${Number(index)}`);
}

/** 模式推导：有文字 + 有图 → 两种图文顺序；只有其一 → 单模式；都没有 → silent。 */
export function modeFor({ text = '', hasSticker = false, stickerFirst = false } = {}) {
  const hasText = String(text ?? '').trim().length > 0;
  if (hasText && hasSticker) return stickerFirst ? 'sticker_then_text' : 'text_then_sticker';
  if (hasSticker) return 'sticker_only';
  if (hasText) return 'text_only';
  return 'silent';
}

/** 模式 → parts 形状。这里就是「全部 parts 在发送前就存在」的实现点。 */
export function partsFor({ mode, text = '', assetId = null } = {}) {
  const body = String(text ?? '').trim().slice(0, TEXT_LIMIT);
  const sticker = assetId ? [{ kind: 'sticker', assetId: String(assetId) }] : [];
  switch (mode) {
    case 'silent': return [];
    case 'text_only': return body ? [{ kind: 'text', content: body }] : [];
    case 'sticker_only': return sticker;
    case 'text_then_sticker': return [...(body ? [{ kind: 'text', content: body }] : []), ...sticker];
    case 'sticker_then_text': return [...sticker, ...(body ? [{ kind: 'text', content: body }] : [])];
    default: return [];
  }
}

/**
 * 校验一个计划。返回原因码而不是抛异常：计划形状问题在真实通道里是「这一轮不发图」，
 * 不是「整个插件崩掉」。
 * @returns {{ok: true, plan: object} | {ok: false, reasonCode: string, message: string}}
 */
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') return { ok: false, reasonCode: 'plan-missing', message: '没有计划。' };
  if (!String(plan.turnId ?? '').trim()) return { ok: false, reasonCode: 'turn-missing', message: '计划缺少 turnId。' };
  const kind = String(plan.target?.kind ?? '');
  if (kind !== 'dm' && kind !== 'group') return { ok: false, reasonCode: 'target-kind-invalid', message: '目标是 dm 或 group。' };
  if (!String(plan.target?.id ?? '').trim()) return { ok: false, reasonCode: 'target-missing', message: '计划缺少目标 id。' };
  if (!MODES.includes(String(plan.mode ?? ''))) return { ok: false, reasonCode: 'mode-invalid', message: `未知模式：${String(plan.mode)}` };
  const parts = Array.isArray(plan.parts) ? plan.parts : [];
  const stickers = parts.filter(part => part?.kind === 'sticker');
  if (stickers.length > MAX_STICKER_PARTS) return { ok: false, reasonCode: 'too-many-stickers', message: '单轮最多 1 张图。' };
  for (const part of parts) {
    if (part?.kind === 'text' && (!String(part.content ?? '').trim() || String(part.content).length > TEXT_LIMIT)) {
      return { ok: false, reasonCode: 'text-part-invalid', message: `文本 part 必须 1–${TEXT_LIMIT} 字。` };
    }
    if (part?.kind === 'sticker' && !String(part.assetId ?? '').trim()) {
      return { ok: false, reasonCode: 'sticker-part-invalid', message: '图 part 缺少 assetId（模型永远不构造路径）。' };
    }
    if (!PART_KINDS.includes(String(part?.kind ?? ''))) return { ok: false, reasonCode: 'part-kind-invalid', message: '只支持 text / sticker 两种 part。' };
    // 任何路径样式的字段都直接拒绝：计划里不该出现 file/path/url。
    for (const key of Object.keys(part ?? {})) {
      if (['file', 'path', 'url', 'filePath', 'target'].includes(key)) {
        return { ok: false, reasonCode: 'path-key-forbidden', message: 'part 不接受路径类字段（投递层自己 stage）。' };
      }
    }
  }
  if (String(plan.mode) === 'silent' && parts.length > 0) return { ok: false, reasonCode: 'silent-with-parts', message: 'silent 计划不能带 parts。' };
  return { ok: true, plan };
}

/** 带图的三模式；其余模式即便给了 assetId 也不放图（模式是权威）。 */
export const STICKER_MODES = Object.freeze(['sticker_only', 'text_then_sticker', 'sticker_then_text']);

/**
 * 生成计划。
 *
 * @param {{
 *   turnId: string, target: {kind: 'dm'|'group', id: string|number},
 *   decision?: {send?: boolean, mode?: string, assetId?: string|null, reasonCode?: string},
 *   draft?: string, mode?: string, assetId?: string|null, stickerFirst?: boolean,
 *   now?: number, ttlMs?: number, seq?: number, planId?: string|null,
 * }} input
 * @returns {object} ResponsePlan（形状永远完整；不合法时 mode 退化 text_only 并给 reasonCode）
 */
export function plan({
  turnId, target, decision = null, draft = '', mode = null, assetId = null,
  stickerFirst = false, now = Date.now(), ttlMs = DEFAULT_PLAN_TTL_MS, seq = 0, planId = null,
} = {}) {
  const id = planId ?? planIdFor({ turnId, target, seq });
  const draftText = String(draft ?? '');
  const chosenAsset = assetId ?? (decision?.send === true ? decision?.assetId ?? null : null);
  // 显式 assetId 与「决策说发」都算要放图；模式一旦给了，就是模式说了算。
  const explicitSticker = Boolean(chosenAsset);
  const wantSticker = mode ? STICKER_MODES.includes(mode) : explicitSticker;
  const chosenMode = mode ?? modeFor({ text: draftText, hasSticker: wantSticker && explicitSticker, stickerFirst });
  const effectiveMode = wantSticker && !chosenAsset && chosenMode !== 'text_only' && chosenMode !== 'silent'
    ? (draftText.trim() ? 'text_only' : 'silent')
    : chosenMode;
  const parts = partsFor({ mode: effectiveMode, text: draftText, assetId: wantSticker ? chosenAsset : null });
  const candidate = {
    planId: id,
    turnId: String(turnId ?? ''),
    target: { kind: String(target?.kind ?? 'dm'), id: String(target?.id ?? '') },
    mode: effectiveMode,
    parts,
    expiresAt: Number(now) + Number(ttlMs),
    reasonCode: String(decision?.reasonCode ?? '') || (effectiveMode === 'silent' ? 'silent' : 'planned'),
    createdAt: Number(now),
  };
  const checked = validatePlan(candidate);
  if (!checked.ok) {
    // 退化必须是**计划**的退化：保留 turnId/目标，把 mode 降成 text_only 并把原因写进 reasonCode。
    return {
      planId: id, turnId: candidate.turnId, target: candidate.target,
      mode: draftText.trim() ? 'text_only' : 'silent',
      parts: partsFor({ mode: draftText.trim() ? 'text_only' : 'silent', text: draftText }),
      expiresAt: candidate.expiresAt,
      reasonCode: checked.reasonCode, createdAt: candidate.createdAt,
    };
  }
  return candidate;
}

/** 计划是否过期（投递前必查；过期就整轮作废，不投半截）。 */
export function isExpired(plan, now = Date.now()) {
  const at = Number(plan?.expiresAt ?? 0);
  return !(at > 0) || Number(now) >= at;
}

/** 给投递层用的有序执行清单：每一 part 都带 index 与幂等键，发送顺序固定。 */
export function partJobs(plan) {
  const parts = Array.isArray(plan?.parts) ? plan.parts : [];
  const planId = String(plan?.planId ?? '');
  return parts.map((part, index) => ({
    index,
    idempotencyKey: idempotencyKeyFor(planId, index),
    kind: String(part.kind),
    ...(part.kind === 'text' ? { content: String(part.content) } : { assetId: String(part.assetId) }),
  }));
}

/** 一句话摘要（日志与工具输出用，不含路径与字节）。 */
export function describePlan(plan) {
  if (!plan) return '无计划';
  const count = Array.isArray(plan.parts) ? plan.parts.length : 0;
  const labels = (Array.isArray(plan.parts) ? plan.parts : []).map(part => (part.kind === 'text' ? '文字' : `图 ${part.assetId}`));
  return `${plan.mode}（${labels.join(' + ') || '无内容'}，共 ${count} 段）`;
}

export default {
  MODES, NOT_IMPLEMENTED_MODES, PART_KINDS, DEFAULT_PLAN_TTL_MS, MAX_STICKER_PARTS,
  planIdFor, idempotencyKeyFor, modeFor, partsFor, validatePlan, plan, isExpired, partJobs, describePlan,
};
