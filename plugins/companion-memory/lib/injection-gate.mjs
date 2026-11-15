// 两道独立的门（计划 §5 A.4）。它们回答两个不同的问题，因此是两个函数、两个返回字段：
//
//   门 1  检索资格  `eligibleForRetrieval(row, ctx)`
//         这一行**能不能进入候选池**。只看这条记录自身的事实：状态、作用域、有效期、
//         有效性（含 session_recent 的 TTL）。它不看用途——可见性不该因为「这次是自动
//         注入还是用户显式查询」而漂移，否则同一条记忆会时有时无。
//
//   门 2  呈现形态  `presentationFor(row, purpose)` / `injectionDecision(row, ctx)`
//         这一行**能不能进提示词、以什么形态进**。这是展示问题，依赖用途：
//         自动注入（`purpose='auto'`）必须克制，显式查询（`purpose='explicit'`）才可以
//         展开正文。四类 mentionPolicy 的呈现策略在这里集中定义，不再散落在渲染层。
//
// 为什么要拆开：旧代码只有一个「可见」概念，于是
//   * `tone_only` 的记忆在自动注入里被当正文直接塞进提示词（「无关亲密旧事被注入」
//     的真实成因之一）；
//   * `avoid_unless_asked` 却由渲染层单独特判，两处判定各自漂移；
//   * 「助手自己推断出来的事实」没有任何呈现约束。
// 现在门 1 决定读不读，门 2 决定以什么形态出现，两者共用 policy.MENTION_POLICIES，
// 不新增字段名，也不引入新表 / 新迁移。
//
// 两个导出层级是有意的：
//   * `presentationFor(row, purpose)` 只做门 2（纯函数，不看 viewer/时间）。渲染层用它，
//     因为召回阶段已经过了门 1，重复判定只会让两条链路互相矛盾。
//   * `injectionDecision(row, ctx)` 做门 1 + 门 2，供需要一站式判定的调用方（和测试）用。
//
// 呈现策略（理由码全部是固定 code，不含任何正文）：
//
//   mentionPolicy        auto                      explicit
//   direct               full（正文）              full
//   soft_echo            soft（正文 + 呼应标签）    soft
//   tone_only            hint（只提示存在，无正文）  full（用户明确来问才展开）
//   avoid_unless_asked   placeholder（只占位）      placeholder（工具也不是索取私密的授权）
//   未知/空（旧数据）     按 direct 处理，不能静默丢内容
//
// 另外 `realityLevel='inferred'`（助手推断出来的内容）在自动注入里同样只给 hint：
// 计划 §5 A.2 要求「忽略助手自己的猜测作为事实来源」。它不是「不可见」，而是
// 「不许以正文形态自动出现在用户的一句话旁边」。

import { isActive, MENTION_POLICIES, scopeMatches } from './policy.mjs';

/** 自动注入只给提示、不给正文的现实级别。 */
const AUTO_HINT_REALITY = new Set(['inferred']);

const POLICY_RENDER = Object.freeze({
  direct: 'full',
  soft_echo: 'soft',
  tone_only: 'hint',
  avoid_unless_asked: 'placeholder',
});

function policyOf(row) {
  const value = String(row?.mentionPolicy ?? '').trim();
  return MENTION_POLICIES.includes(value) ? value : 'direct';
}

function clockOf(ctx) {
  const raw = ctx?.now;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (ctx?.now == null) return Date.now();
  const parsed = Date.parse(String(ctx.now));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function purposeOf(ctx) {
  return String(ctx?.purpose ?? ctx?.mode ?? 'auto') === 'explicit' ? 'explicit' : 'auto';
}

/**
 * 门 2（纯）：这一行在给定用途下的呈现形态。
 *
 * @param row     MemoryRecord（或同形状对象）
 * @param purpose 'auto' | 'explicit'
 * @returns `{ render, reason }`，render ∈ 'full' | 'soft' | 'hint' | 'placeholder' | 'skip'
 */
export function presentationFor(row, purpose = 'auto') {
  if (!row || typeof row !== 'object') return { render: 'skip', reason: 'missing-record' };
  const mode = String(purpose) === 'explicit' ? 'explicit' : 'auto';
  const policy = policyOf(row);
  if (policy === 'avoid_unless_asked') return { render: 'placeholder', reason: 'avoid-unless-asked' };
  if (policy === 'tone_only') {
    return mode === 'explicit'
      ? { render: 'full', reason: 'tone-only-explicit' }
      : { render: 'hint', reason: 'tone-only-auto' };
  }
  if (mode === 'auto' && AUTO_HINT_REALITY.has(String(row.realityLevel ?? ''))) {
    return { render: 'hint', reason: 'inferred-hint-only' };
  }
  if (policy === 'soft_echo') return { render: 'soft', reason: 'soft-echo' };
  return { render: 'full', reason: 'direct' };
}

/**
 * 门 1。
 *
 * @param row  MemoryRecord（或同形状对象）
 * @param ctx  `{ viewer, now }`；缺 viewer 视为不可见
 * @returns `{ ok, reason }`，reason 为 '' 表示通过。理由码与 retrieve.mjs 的
 *          `filteredReasons` 一致（`status-pending` / `scope-mismatch` / `expired` /
 *          `not-yet-valid` / `inactive` / `missing-record`），两条链路可以共用统计。
 */
export function eligibleForRetrieval(row, ctx = {}) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'missing-record' };
  const viewer = ctx.viewer ?? null;
  if (!viewer || !viewer.userId || !viewer.personaId) return { ok: false, reason: 'no-viewer' };

  const status = String(row.status ?? '');
  if (status !== 'confirmed') return { ok: false, reason: `status-${status || 'unknown'}` };
  // 作用域先于有效期判定：别的世界的剧情行报告作用域问题，而不是过期问题。
  if (!scopeMatches(row, viewer)) return { ok: false, reason: 'scope-mismatch' };
  const clock = clockOf(ctx);
  if (row.validTo) {
    const until = Date.parse(row.validTo);
    if (Number.isFinite(until) && until <= clock) return { ok: false, reason: 'expired' };
  }
  if (row.validFrom) {
    const from = Date.parse(row.validFrom);
    if (Number.isFinite(from) && from > clock) return { ok: false, reason: 'not-yet-valid' };
  }
  // 第二道保险：isActive 还会执行 session_recent 的 TTL 并复核状态/有效期，
  // 这样将来策略改动不会悄悄放宽可见性。
  if (!isActive(row, clock)) return { ok: false, reason: 'inactive' };
  return { ok: true, reason: '' };
}

/** 门 1 的布尔简写。 */
export function allowRetrieval(row, ctx = {}) {
  return eligibleForRetrieval(row, ctx).ok;
}

/**
 * 门 1 + 门 2 的一站式判定。
 *
 * @returns `{ allow, render, reason }`。`allow=false` 只在门 1 不通过时出现；
 *          敏感行一律 allow=true + 受限形态（占位/提示），因为「模型知道存在」
 *          本身是允许的信息。
 */
export function injectionDecision(row, ctx = {}) {
  const gate = eligibleForRetrieval(row, ctx);
  if (!gate.ok) return { allow: false, render: 'skip', reason: gate.reason };
  const presented = presentationFor(row, purposeOf(ctx));
  return { allow: presented.render !== 'skip', render: presented.render, reason: presented.reason };
}

/** 自动注入路径上，这一行允许出现吗（含占位/提示）。 */
export function allowAutoInjection(row, ctx = {}) {
  return injectionDecision(row, { ...ctx, purpose: 'auto' }).allow === true;
}

/** 这一行在给定用途下是否带正文（false = 只有占位/提示，正文不可见）。 */
export function carriesBody(row, ctx = {}) {
  const decision = injectionDecision(row, ctx);
  return decision.allow === true && (decision.render === 'full' || decision.render === 'soft');
}

/** 自动注入路径专用简写：正文能不能进系统提示。 */
export function carriesBodyInAuto(row, ctx = {}) {
  return carriesBody(row, { ...ctx, purpose: 'auto' });
}

/** 归类统计：把一批行按门 2 结果分桶（只返回计数，用于 explain / 日志）。 */
export function countInjectionRenders(rows, ctx = {}) {
  const counts = { full: 0, soft: 0, hint: 0, placeholder: 0, skip: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const decision = injectionDecision(row, ctx);
    if (decision.render in counts) counts[decision.render] += 1;
    else counts.skip += 1;
  }
  return counts;
}

export const INJECTION_POLICY_RENDER = POLICY_RENDER;
export const AUTO_HINT_REALITY_LIST = Object.freeze([...AUTO_HINT_REALITY]);
