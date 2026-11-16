// 陪伴空间 · 把既有诊断数据投影成 W2 事件（不新增写入口）。
//
// 为什么不在 `companion-memory` 里加埋点：那会让记忆引擎反过来依赖 Studio 的 schema，
// 方向是错的。记忆引擎**已经在写** `logs/memory-recall.jsonl`（只含计数与理由码，无正文），
// 所以 W2 的"记忆侧事件"只需要一个**投影**：读那条既有记录，映射成本包的 10 字段事件。
//
// 这个模块是纯函数：不读文件、不看时钟，时间与 id 由输入决定，于是用例可以逐字节断言。

import { sanitizeEvent, serializeEvent, opaqueId } from './trace-schema.mjs';

/** FNV-1a 32 位：稳定的短哈希，用于把 (sessionId, at) 折成一个不含标识的 traceId 前缀。 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // FNV 素数 16777619 的移位写法，配合 >>> 0 收成 32 位无符号。
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  // 无符号 + 36 进制，最短 7 位，读起来像不透明 id 而不是"人肉可读的 session"。
  return (hash >>> 0).toString(36).padStart(7, '0');
}

/**
 * 一轮召回的 traceId。
 *
 * 不用 sessionId 本身：它是可逆的身份标识，不该出现在诊断事件里。用 (sessionId, at)
 * 折叠后既能让同一轮的多条事件归到一起，又不泄漏身份。
 */
export function traceIdOf(record) {
  const session = String(record?.sessionId ?? '');
  const at = String(record?.at ?? '');
  if (!session && !at) return '';
  return `tr_${fnv1a(`${session}|${at}`)}`;
}

/** `filteredReasons` 里出现最多的那个理由码（并列时取字典序最小，保证确定性）。 */
export function dominantReason(filteredReasons) {
  const entries = Object.entries(filteredReasons ?? {}).filter(([, count]) => Number(count) > 0);
  if (!entries.length) return { reason: '', count: 0, all: {} };
  entries.sort((left, right) => (Number(right[1]) - Number(left[1]) || (left[0] < right[0] ? -1 : 1)));
  const all = {};
  for (const [key, count] of entries) all[key] = Number(count);
  return { reason: String(entries[0][0]), count: Number(entries[0][1]), all };
}

/**
 * 一条 `memory-recall.jsonl` 记录 → 一条（最多两条）trace 事件。
 *
 * 拆成两条是有意的：
 *   - `retrieve` 事件的 status 说明"这次检索本身成不成"（有错就是 `failed`）；
 *   - `inject` 事件的 status 说明"最终有没有东西进上下文"（0 字就是 `empty`）。
 * 合并成一条会让"检索失败但注入了旧内容"这种真实情况看不出来。
 *
 * @returns `{ events, rejected }`——`rejected` 非空表示输入缺关键字段（不是数据坏了，是契约变了）。
 */
export function recallRecordToEvents(record, { configRevision = null } = {}) {
  const rejected = [];
  if (!record || typeof record !== 'object') {
    return { events: [], rejected: ['missing-record'] };
  }
  const explain = record.explain && typeof record.explain === 'object' ? record.explain : null;
  if (!explain) rejected.push('missing-explain');

  const at = record.at ?? '';
  const traceId = traceIdOf(record);
  const backend = String(record.backend ?? explain?.backend ?? '');
  const elapsedMs = Number(record.elapsedMs ?? explain?.elapsedMs ?? 0);
  const candidates = Number(explain?.candidates ?? 0);
  const afterFilter = Number(explain?.afterFilter ?? 0);
  const afterDedupe = Number(explain?.afterDedupe ?? 0);
  const characters = Number(record.characters ?? 0);
  const dominant = dominantReason(explain?.filteredReasons);

  // backend 不是 schema 里的键，但它是"哪条通道在跑"，属于可靠的诊断信息。
  // 放进 counts 会污染计数语义，所以只在理由码里缺席时借位——这里选择**不加**：
  // 需要它的地方是 UI 的通道徽标，那条走 recall-log 的既有字段，不塞进事件。

  const retrieveStatus = explain ? 'ok' : 'failed';
  const retrieveReason = explain
    ? (dominant.reason || '')
    : (backend === 'none' ? 'no-database' : 'recall-error');

  const base = {
    traceId,
    at,
    module: 'memory',
    durationMs: elapsedMs,
    configRevision,
  };

  const events = [];
  const retrieve = sanitizeEvent({
    ...base,
    stage: 'retrieve',
    status: retrieveStatus,
    reasonCode: retrieveReason,
    counts: { candidates, filtered: Math.max(0, candidates - afterFilter) },
    // 同一轮里两条事件的 eventId 必须稳定：用 (traceId, stage) 折叠。
    eventId: `evt_${fnv1a(`${traceId}|retrieve`)}`,
  });
  if (retrieve.rejected.length) rejected.push(...retrieve.rejected.map((code) => `retrieve:${code}`));
  events.push(retrieve.event);

  const inject = sanitizeEvent({
    ...base,
    stage: 'inject',
    status: characters > 0 ? 'ok' : 'empty',
    reasonCode: characters > 0 ? '' : (dominant.reason || 'empty-candidate-pool'),
    counts: {
      injected: Math.max(0, afterDedupe),
      characters,
      filtered: Math.max(0, candidates - afterFilter),
    },
    eventId: `evt_${fnv1a(`${traceId}|inject`)}`,
  });
  if (inject.rejected.length) rejected.push(...inject.rejected.map((code) => `inject:${code}`));
  events.push(inject.event);

  return { events: events.map(serializeEvent), rejected };
}

/** 一批记录 → 事件数组（跳过无法解释的记录并计数）。 */
export function recallRecordsToEvents(records, options = {}) {
  const events = [];
  let skipped = 0;
  for (const record of records ?? []) {
    const projected = recallRecordToEvents(record, options);
    if (!projected.events.length || projected.rejected.length) skipped += 1;
    for (const event of projected.events) events.push(event);
  }
  return { events, skipped };
}

/** traceId 的字面校验（给路由做参数检查，避免有人传一个会话 id 当 traceId）。 */
export function isTraceId(value) {
  return /^tr_[0-9a-z]{7,}$/.test(String(value ?? ''));
}
