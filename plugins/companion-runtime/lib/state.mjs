// lib/state.mjs — C4 短期状态（tension / energy / focus）。
//
// 纯函数模块：时间只从参数进入（不读时钟、不用随机数），不碰数据库、文件或网络，
// 也不调用模型。因此同一条事件时间线在任何采样频率下得到同一条轨迹（A09）：
// 一个区间内的事件按各自发生时刻分段推进，clip 只在事件施加之后执行，
// 普通的向基线回落不裁剪。
import { ValidationError } from './errors.mjs';

export const STATE_SCHEMA_VERSION = 1;

// 工程参数，不是对人的测量：范围 [0,1]，向基线指数回落，τ 为恢复时间常数（毫秒）。
// weights 是「该 kind 的单位冲击对本变量的作用量」，冲击强度来自事件 amount。
export const STATE_DEFS = Object.freeze([
  Object.freeze({
    id: 'tension', baseline: 0.2, tauMs: 1_800_000, min: 0, max: 1,
    weights: Object.freeze({ 'state/impulse': 1, 'state/recovered': -0.6 }),
  }),
  Object.freeze({
    id: 'energy', baseline: 0.65, tauMs: 3_600_000, min: 0, max: 1,
    weights: Object.freeze({ 'state/impulse': -0.7, 'state/recovered': 0.5 }),
  }),
  Object.freeze({
    id: 'focus', baseline: 0.5, tauMs: 900_000, min: 0, max: 1,
    weights: Object.freeze({ 'state/impulse': -0.9, 'state/recovered': 0.4 }),
  }),
]);

// 注入预算的变量系数：紧张、耗能压缩注入（更短更克制），专注允许更长的上下文。
// 不在这里出现的变量无法改变任何注入决策，按合同第 4 节应进 DISABLED_BY_DEFAULT。
export const BUDGET_WEIGHTS = Object.freeze({ tension: -0.35, energy: -0.25, focus: 0.45 });
export const BUDGET_DEFAULTS = Object.freeze({ base: 320, min: 160, max: 480 });

// 消融后不改变任何注入决策的变量默认关闭。当前三个变量都参与 BUDGET_WEIGHTS，
// 因此这里是空列表；test/state.test.mjs 用固定夹具反向验证这条规则（无关变量必须出现在这里）。
export const DISABLED_BY_DEFAULT = Object.freeze([]);

const MAX_APPLIED_MARKERS = 512;
const DEFAULT_KIND = 'state/impulse';

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function requireInstant(value, field) {
  const instant = Number(value);
  if (!Number.isFinite(instant)) throw new ValidationError(`${field} must be a finite epoch millisecond`);
  return instant;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeDefs(defs) {
  if (!Array.isArray(defs) || defs.length === 0) throw new ValidationError('state defs must be a non-empty array');
  const seen = new Set();
  return defs.map((input) => {
    const id = typeof input?.id === 'string' ? input.id.trim() : '';
    if (!id) throw new ValidationError('state def requires an id');
    if (seen.has(id)) throw new ValidationError(`duplicate state variable: ${id}`);
    seen.add(id);
    const baseline = Number(input.baseline);
    const tauMs = Number(input.tauMs);
    const min = numberOr(input.min, 0);
    const max = numberOr(input.max, 1);
    if (!Number.isFinite(baseline) || !Number.isFinite(tauMs)) throw new ValidationError(`state def ${id} needs a finite baseline and tauMs`);
    if (!(tauMs > 0)) throw new ValidationError(`state def ${id} needs tauMs > 0`);
    if (min > max) throw new ValidationError(`state def ${id} needs min <= max`);
    const weights = {};
    for (const [kind, weight] of Object.entries(input.weights ?? {})) {
      const value = Number(weight);
      if (Number.isFinite(value)) weights[kind] = value;
    }
    return { id, baseline: clamp(baseline, min, max), tauMs, min, max, weights };
  });
}

/** 建一个处于基线的切片；`disabled` 的变量固定不动，等价于永久消融。 */
export function createStateSlice(now, { disabled = DISABLED_BY_DEFAULT, defs = STATE_DEFS } = {}) {
  const instant = requireInstant(now, 'createStateSlice(now)');
  const resolved = normalizeDefs(defs);
  const known = new Set(resolved.map((def) => def.id));
  const pinned = [...new Set((Array.isArray(disabled) ? disabled : [disabled]).map((id) => String(id)))];
  for (const id of pinned) if (!known.has(id)) throw new ValidationError(`unknown state variable: ${id}`);
  const values = {};
  for (const def of resolved) values[def.id] = def.baseline;
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    defs: resolved,
    values,
    pinned,
    applied: [],
    evaluatedAt: instant,
  };
}

/** 校验并拷贝一份可安全改写的内部状态；入参切片永远不会被就地修改。 */
function prepare(slice) {
  if (!slice || typeof slice !== 'object' || !Array.isArray(slice.defs)) {
    throw new ValidationError('state slice is missing; call createStateSlice first');
  }
  const defs = normalizeDefs(slice.defs);
  const pinned = Array.isArray(slice.pinned) ? slice.pinned.filter((id) => defs.some((def) => def.id === id)) : [];
  const values = {};
  for (const def of defs) {
    const stored = Number(slice.values?.[def.id]);
    values[def.id] = pinned.includes(def.id) ? def.baseline : (Number.isFinite(stored) ? stored : def.baseline);
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    defs,
    values,
    pinned,
    applied: Array.isArray(slice.applied) ? [...slice.applied] : [],
    evaluatedAt: requireInstant(slice.evaluatedAt, 'slice.evaluatedAt'),
  };
}

/** 指数回落；时间不倒流时 Δ<=0 直接不动，且从不裁剪。 */
function decayAll(state, from, to) {
  const deltaMs = to - from;
  if (!(deltaMs > 0)) return;
  for (const def of state.defs) {
    if (state.pinned.includes(def.id)) continue;
    const value = state.values[def.id];
    state.values[def.id] = def.baseline + (value - def.baseline) * Math.exp(-deltaMs / def.tauMs);
  }
}

/** 施加冲击并在之后裁剪；没有权重（或权重为 0）的变量不受影响。 */
function impulseAll(state, amount, kind) {
  for (const def of state.defs) {
    if (state.pinned.includes(def.id)) continue;
    const weight = numberOr(def.weights?.[kind], 0);
    if (weight === 0) continue;
    state.values[def.id] = clamp(state.values[def.id] + weight * amount, def.min, def.max);
  }
}

function orderEvents(events) {
  if (!Array.isArray(events)) throw new ValidationError('advance requires an events array');
  return events
    .map((input) => {
      const id = typeof input?.id === 'string' ? input.id.trim() : '';
      if (!id) throw new ValidationError('state impulse requires an id (used for duplicate detection)');
      const at = requireInstant(input?.at, 'event.at');
      const amount = Number(input?.amount);
      if (!Number.isFinite(amount)) throw new ValidationError('event.amount must be a finite number');
      const kind = typeof input?.kind === 'string' && input.kind ? input.kind : DEFAULT_KIND;
      return { id, at, amount, kind };
    })
    .sort((left, right) => (left.at - right.at) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** 记住 (id, at) 已应用标记；窗口有界，长期去重仍由 consumer_receipts 负责（合同 §3）。 */
function remember(state, mark) {
  state.applied.push(mark);
  if (state.applied.length > MAX_APPLIED_MARKERS) state.applied.splice(0, state.applied.length - MAX_APPLIED_MARKERS);
}

/**
 * 推进到 `to`，把区间内的事件按发生时刻分段施加。
 *
 * - 乱序输入先按 (at, id) 排序，因此同一批事件与投递顺序无关。
 * - 同一 (id, at) 在切片生命周期内最多应用一次（重复投递幂等）。
 * - 迟到事件（at 早于已评估时刻）在当前时刻结算，时间轴不倒流；未来事件留待下次。
 */
export function advance(slice, to, events = []) {
  const state = prepare(slice);
  const target = requireInstant(to, 'advance(to)');
  const stop = Math.max(target, state.evaluatedAt);
  const queue = orderEvents(events);
  const seen = new Set(state.applied);
  let cursor = state.evaluatedAt;
  for (const event of queue) {
    if (event.at > stop) break;
    const mark = `${event.id}|${event.at}`;
    if (seen.has(mark)) continue;
    const at = Math.max(cursor, event.at);
    decayAll(state, cursor, at);
    cursor = at;
    impulseAll(state, event.amount, event.kind);
    seen.add(mark);
    remember(state, mark);
  }
  decayAll(state, cursor, Math.max(target, cursor));
  state.evaluatedAt = stop;
  return state;
}

/** 先衰减到 `at`，再施加冲击并裁剪。 */
export function applyImpulse(slice, { id, amount, at, kind = DEFAULT_KIND } = {}) {
  const instant = requireInstant(at, 'applyImpulse(at)');
  return advance(slice, instant, [{ id, amount, at: instant, kind }]);
}

function projectionOf(state) {
  const normalized = {};
  for (const def of state.defs) {
    const span = def.max - def.min;
    normalized[def.id] = span === 0 ? 0 : clamp((state.values[def.id] - def.min) / span, 0, 1);
  }
  return { values: { ...state.values }, normalized };
}

/** 归一化读数（不改切片）；`to` 早于已评估时刻时返回当前值，时间不倒流。 */
export function normalize(slice, to) {
  const state = prepare(slice);
  const target = requireInstant(to, 'normalize(to)');
  decayAll(state, state.evaluatedAt, Math.max(target, state.evaluatedAt));
  return projectionOf(state).normalized;
}

function budgetParams(options = {}) {
  const base = numberOr(options.base, BUDGET_DEFAULTS.base);
  const min = numberOr(options.min, BUDGET_DEFAULTS.min);
  const max = numberOr(options.max, BUDGET_DEFAULTS.max);
  if (min > max) throw new ValidationError('injectionBudget needs min <= max');
  return { base, min, max };
}

/** 归一化值的纯函数：整数、有界、对三个系数分别单调。 */
export function normalizedBudget(normalized = {}, options = {}) {
  const { base, min, max } = budgetParams(options);
  let scale = 1;
  for (const [id, weight] of Object.entries(BUDGET_WEIGHTS)) {
    scale += weight * clamp(numberOr(normalized?.[id], 0), 0, 1);
  }
  return clamp(Math.round(base * scale), min, max);
}

/** 注入字符预算：确定整数，只由 `to` 时刻的归一化状态决定。 */
export function injectionBudget(slice, to, options = {}) {
  return normalizedBudget(normalize(slice, to), options);
}

/** 把指定变量固定在基线（消融）；返回新切片，`at` 之前的回落先结算。 */
export function ablate(slice, ids, now) {
  const advanced = advance(slice, now, []);
  const known = new Set(advanced.defs.map((def) => def.id));
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id));
  for (const id of list) if (!known.has(id)) throw new ValidationError(`unknown state variable: ${id}`);
  const pinned = [...new Set([...advanced.pinned, ...list])];
  const values = { ...advanced.values };
  for (const def of advanced.defs) if (pinned.includes(def.id)) values[def.id] = def.baseline;
  return { ...advanced, values, pinned };
}

/** 注入/诊断用的只读投影：值、归一化值、预算字符数与求值时刻。 */
export function describe(slice, to, budget = BUDGET_DEFAULTS) {
  const state = prepare(slice);
  const target = requireInstant(to, 'describe(to)');
  decayAll(state, state.evaluatedAt, Math.max(target, state.evaluatedAt));
  const { values, normalized } = projectionOf(state);
  return { values, normalized, budgetChars: normalizedBudget(normalized, budget), evaluatedAt: target };
}

/**
 * 消费者 reducer 适配器，签名与 `applyEvent({ apply })` 的回调一致
 * （见 lib/events.mjs）：返回 `{ slice, result }`，不读写数据库。
 */
export function applyStateEvent({ event, slice, now } = {}) {
  if (!event || typeof event !== 'object') throw new ValidationError('applyStateEvent requires an event envelope');
  const at = requireInstant(event.occurredAt ?? now, 'event.occurredAt');
  const kind = typeof event.kind === 'string' && event.kind ? event.kind : DEFAULT_KIND;
  const base = slice && Array.isArray(slice.defs) ? prepare(slice) : createStateSlice(at);
  const id = typeof event.eventId === 'string' && event.eventId ? event.eventId : `${kind}:${at}`;
  const counts = { kind, variables: base.defs.length, pinned: base.pinned.length, evaluatedAt: base.evaluatedAt };
  if (!base.defs.some((def) => numberOr(def.weights?.[kind], 0) !== 0)) {
    return { slice: base, result: { applied: false, ...counts, reason: 'kind-not-weighted' } };
  }
  const amount = Number(event.payload?.amount ?? (kind === 'state/recovered' ? 1 : 0));
  if (!Number.isFinite(amount)) {
    return { slice: base, result: { applied: false, ...counts, reason: 'invalid-amount' } };
  }
  const duplicate = base.applied.includes(`${id}|${at}`);
  const next = applyImpulse(base, { id, amount, at, kind });
  return {
    slice: next,
    result: {
      applied: !duplicate,
      duplicate,
      kind,
      variables: next.defs.length,
      pinned: next.pinned.length,
      evaluatedAt: next.evaluatedAt,
      ...(duplicate ? { reason: 'duplicate-applied-impulse' } : {}),
    },
  };
}
