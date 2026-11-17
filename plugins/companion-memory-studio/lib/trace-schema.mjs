// 陪伴空间 · 结构化诊断事件（W2）。
//
// 计划 W2 的有限 schema 在这里落地。三条硬规则：
//   1. **白名单字段**：不在 schema 里的键一律丢弃——事件是诊断，不是日志倾倒场。
//   2. **永不含正文**：用户原话、记忆 value、Prompt 正文、reasoning、工具 arguments、
//      凭据、可逆私密 ID 都不允许出现；`sanitizeEvent` 在落下之前做一次审校，命中就降级成
//      `redacted` 并只留理由码。
//   3. **失败也如实**：不合规的事件不是被静默修正，而是被标成 `degraded` 且带上
//      `reasonCode: 'event-rejected'`——让"写错了"看得见。
//
// 这个模块是纯函数集合：没有 IO、没有时间依赖（时间由调用方传）。落盘/读取在
// `trace-store.mjs`，SSE 合并在 `runtime-log-stream.mjs`。

/** 事件来源模块（有限集合）。 */
export const MODULES = Object.freeze(['memory', 'prompt', 'router', 'tool', 'studio', 'host']);

/** 阶段（有限集合）。顺序即时间线上的展示顺序。 */
export const STAGES = Object.freeze([
  'retrieve', 'filter', 'inject', 'route', 'compose',
  'tool-start', 'tool-end', 'finalize',
]);

/** 状态（有限集合）。 */
export const STATUSES = Object.freeze(['ok', 'empty', 'filtered', 'degraded', 'failed']);

/** 白名单字段：事件里只允许这些键。 */
export const EVENT_KEYS = Object.freeze([
  'eventId', 'traceId', 'at', 'module', 'stage', 'status', 'reasonCode',
  'durationMs', 'counts', 'configRevision',
]);

/** `counts` 里允许的计数键——它们是"多少个/多少字"，不是内容。 */
export const COUNT_KEYS = Object.freeze([
  'candidates', 'filtered', 'injected', 'characters', 'budgetChars',
  'toolsVisible', 'toolsCalled', 'toolsFailed', 'events', 'dropped',
  'records', 'tokens', 'modules',
]);

/**
 * 已知理由码（W2 验收要求"能在 UI 找到对应 reasonCode"）。
 *
 * 词表来自既有实现，不自创：记忆侧取自 `companion-memory/lib/retrieve.mjs` 的
 * `noteReason(...)` 与 `explain.filteredReasons`；其余是本轮新增的边界事件。
 * 未在表里的理由码**不会**被拒绝（那是过度收紧），但会被记成 `unknown-reason`，
 * 于是 UI 上能看出"有个新码还没归类"。
 */
export const REASON_CODES = Object.freeze([
  // 「没有理由」也是一条要写进契约的码：否则空理由码会绕开白名单校验。
  'ok',
  // 记忆检索（既有）
  'empty-candidate-pool', 'low-coverage', 'scope-mismatch', 'expired', 'not-yet-valid',
  'inactive', 'missing-record', 'missing-vector', 'semantic-off', 'semantic-degraded',
  'semantic-below-floor', 'semantic-empty', 'semantic-error', 'semantic-no-overlap',
  'lexical-error', 'recent-error', 'vector-error', 'rerank-unavailable', 'rerank-empty',
  'recall-error', 'no-database', 'no-viewer',
  // 本轮：路由 / 组装 / 工具 / 宿主
  'route-default', 'route-explicit', 'route-shadow', 'route-mode-off',
  'compose-budget-clamped', 'compose-module-missing', 'compose-empty',
  'tool-denied', 'tool-threw', 'tool-timeout',
  'module-not-mounted', 'config-missing', 'event-rejected', 'unknown-reason',
]);

const REASON_SET = new Set(REASON_CODES);

/**
 * 会被当成"正文泄漏"的形状。
 *
 * 判据按**字段的实际契约**定，不做宽泛启发式：
 *   - `reasonCode` 是"稳定码"，按契约只能是 ASCII 标识符；任何 CJK 出现即正文
 *     （实测：22 字的聊天句里含标点，把它切成短段后"40+ 连续 CJK"根本拦不住，
 *     所以按"含中文即正文"判，比按长度判更贴合真实契约）；
 *   - 长英文句子：至少三个空格才像自然语言（序列化后的 JSON 没有这种形态，不会自伤）。
 */
const LEAK_PATTERNS = Object.freeze([
  // 凭据形状
  /(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/,
  /(?:api[_-]?key|access[_-]?token|password|cookie)\s*[:=]\s*\S{4,}/i,
  // 任何 CJK：稳定码字段按契约只有 ASCII
  /[\u3400-\u9fff\uf900-\ufaff]/,
  // 长英文句子：至少三个空格
  /(?:[\x21-\x7e]+ ){3,}[\x21-\x7e]+/,
]);

export const MAX_REASON_CHARS = 40;
export const MAX_REVISION_CHARS = 48;
export const MAX_COUNT = 1_000_000;
export const MAX_DURATION_MS = 3_600_000;

/** 不透明 id：只允许短字母数字+少量分隔符，避免把 sessionId 原样当 traceId 用。 */
export function opaqueId(value, fallback = '') {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  return /^[A-Za-z0-9._:-]{1,64}$/.test(text) ? text : fallback;
}

/** 是否像正文/凭据（用于拒绝而不是修补）。 */
export function looksLikeContent(text) {
  const value = String(text ?? '');
  if (!value) return false;
  return LEAK_PATTERNS.some((pattern) => pattern.test(value));
}

function clampCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(MAX_COUNT, Math.max(0, Math.trunc(number)));
}

/**
 * 收敛 `counts`：只保留白名单键，值一律是非负整数。
 * 不是对象的 `counts` 直接丢掉（不猜它的形状）。
 */
export function sanitizeCounts(counts) {
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) return null;
  const out = {};
  for (const key of COUNT_KEYS) {
    if (!Object.hasOwn(counts, key)) continue;
    const value = clampCount(counts[key]);
    if (value !== null) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 主入口：把一个候选事件收敛成合规事件。
 *
 * @returns `{ event, rejected }`——`rejected` 是理由码数组；非空时 `event.status` 会被降级成
 *          `degraded`，`reasonCode` 覆盖成 `event-rejected`，并保留原事件能留下的计数。
 */
export function sanitizeEvent(input, { now = () => Date.now() } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const rejected = [];

  const moduleName = MODULES.includes(source.module) ? source.module : null;
  if (!moduleName) rejected.push('unknown-module');

  const stage = STAGES.includes(source.stage) ? source.stage : null;
  if (!stage) rejected.push('unknown-stage');

  let status = STATUSES.includes(source.status) ? source.status : null;
  if (!status) rejected.push('unknown-status');

  // **先看原文、再截断**：先截断会把 60 字正文压成 40 字，正好躲过「40+ 连续 CJK」的判据。
  const rawReason = String(source.reasonCode ?? '').trim();
  let reasonCode = rawReason.slice(0, MAX_REASON_CHARS);
  if (rawReason && looksLikeContent(rawReason)) {
    rejected.push('content-in-reason');
    reasonCode = 'event-rejected';
  } else if (reasonCode && !REASON_SET.has(reasonCode)) {
    // 不认识的码不拒绝——新码先落地，标成 unknown-reason 让 UI 能看出来。
    rejected.push('unknown-reason');
    reasonCode = 'unknown-reason';
  }
  if (!reasonCode) reasonCode = status === 'ok' ? 'ok' : '';

  const configRevision = opaqueId(source.configRevision, '');
  if (String(source.configRevision ?? '').trim() && !configRevision) rejected.push('bad-revision');

  // `at` 也必须过一遍内容判据：别的字符串字段都过了，只有它原来原样落盘，
  // 于是 `at: '中文时间'` 能带着正文进日志（M3 实测）。
  // 而且 `at: NaN` 会让 `new Date(NaN).toISOString()` 抛 RangeError —— 诊断写入端
  // 从不该抛给调用方，所以这里必须收敛成"回退到当前时间 + 记一条 bad-at"。
  const rawAt = source.at ?? null;
  let at = '';
  if (rawAt === null || rawAt === undefined) {
    at = new Date(now()).toISOString();
  } else if (typeof rawAt === 'number' || typeof rawAt === 'string') {
    const parsed = typeof rawAt === 'number' ? new Date(rawAt) : new Date(String(rawAt));
    if (Number.isFinite(parsed.getTime()) && typeof rawAt === 'number') {
      at = parsed.toISOString();
    } else if (typeof rawAt === 'string' && !looksLikeContent(rawAt) && Number.isFinite(Date.parse(rawAt))) {
      at = new Date(Date.parse(rawAt)).toISOString();
    } else {
      rejected.push('bad-at');
      at = new Date(now()).toISOString();
    }
  } else {
    rejected.push('bad-at');
    at = new Date(now()).toISOString();
  }

  let durationMs = null;
  if (source.durationMs !== undefined && source.durationMs !== null) {
    const number = Number(source.durationMs);
    if (Number.isFinite(number) && number >= 0) durationMs = Math.min(MAX_DURATION_MS, Math.trunc(number));
    else rejected.push('bad-duration');
  }

  const counts = sanitizeCounts(source.counts);

  // 任何字符串字段都再过一遍正文判据（防御性：上游拼串时可能把 query 带进来）。
  for (const key of ['traceId', 'eventId']) {
    const value = String(source[key] ?? '');
    if (value && looksLikeContent(value)) {
      rejected.push(`content-in-${key}`);
    }
  }

  const degraded = rejected.length > 0;
  const event = {
    eventId: opaqueId(source.eventId, `evt_${Math.random().toString(36).slice(2, 10)}`),
    traceId: opaqueId(source.traceId, ''),
    at,
    module: moduleName ?? 'host',
    stage: stage ?? 'finalize',
    status: degraded && status === 'ok' ? 'degraded' : (status ?? 'degraded'),
    reasonCode: degraded ? (reasonCode && reasonCode !== 'event-rejected' ? reasonCode : 'event-rejected') : reasonCode,
    durationMs,
    counts,
    configRevision: configRevision || null,
  };

  return { event, rejected };
}

/** 事件按 schema 的键序序列化：落盘与传输都用同一个顺序，便于逐字节比对。 */
export function serializeEvent(event) {
  const out = {};
  for (const key of EVENT_KEYS) out[key] = Object.hasOwn(event, key) ? event[key] : null;
  return out;
}

/** 一条事件是否"安全"（给测试与脱敏扫描用的判据，与写入路径共用同一套检查）。 */
export function isSafeEvent(event) {
  if (!event || typeof event !== 'object') return false;
  for (const key of Object.keys(event)) {
    if (!EVENT_KEYS.includes(key)) return false;
  }
  // t 与其他字符串字段同一套内容判据：它原来被漏掉了，正文可以从这里进日志。
  if (looksLikeContent(event.reasonCode) || looksLikeContent(event.traceId) || looksLikeContent(event.eventId) || looksLikeContent(event.at)) return false;
  if (typeof event.at === 'string' && event.at !== '' && !Number.isFinite(Date.parse(event.at))) return false;
  if (event.counts && typeof event.counts === 'object') {
    for (const key of Object.keys(event.counts)) if (!COUNT_KEYS.includes(key)) return false;
  }
  return true;
}
