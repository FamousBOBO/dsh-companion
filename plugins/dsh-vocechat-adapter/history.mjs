// 群聊上下文：把「自上次发言以来频道里说过的话」取回来，渲染成模型能读的一段。
//
// 为什么需要（2026-11-18 实测的缺口）：
//   入站包原来只有触发这一轮的那几条消息。群里 A 说「昨天那个文件呢」、B 说「我看看」
//   之后轮到我们，模型看到的是「我看看」——它不知道「那个文件」是什么，只能反问或者瞎猜。
//   私聊里这个问题不存在（一对一，上下文天然连续），所以这一段只对**频道**生效。
//
// 三条判据，每条都对应一个具体的错法：
//
//   1. **按 mid 排序，不信任返回顺序。** `user-api.mjs` 的注释写的是「newest first」，
//      2026-11-18 实测是**升序**（旧→新，最后一条最新）。注释已经错了，就不能让渲染依赖它：
//      统一按 mid 升序重排，两种返回顺序都得到同一个结果。
//   2. **水位是「我们上次成功发出的 mid」，不是「上次收到」。** 用收到的那条做界会把
//      自己上一轮说的话挡在外面，而群里那正是最需要接上的部分。
//   3. **失败不编内容。** 取不到历史就**整段不注入**，而不是注入「历史不可用」。后者会
//      进提示词、被模型当成事实复述出来（"我看不到之前的消息"），比不注入更糟。
//
// 与 `dsh-channel-qq` 的差别：那边有 OneBot 的 `get_group_msg_history` 与本地 chatlog 双份
// 来源，这里只有平台 `GET /api/group/{gid}/history` 一个来源，所以取数失败就是没有上下文。

/** 单条历史正文的最大字符数。超出截断并标记，避免一条长文吃掉整个上下文预算。 */
const MAX_ROW_CHARS = 500;

/** `history()` 平台行 → 内部行。字段名只在这个函数里出现一次。 */
export function mapHistoryRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mid = Number(raw.mid);
  if (!Number.isInteger(mid) || mid <= 0) return null;
  const fromUid = Number(raw.from_uid ?? raw.fromUid);
  const detail = raw.detail && typeof raw.detail === 'object' ? raw.detail : {};
  const content = typeof detail.content === 'string'
    ? detail.content
    : (typeof raw.content === 'string' ? raw.content : '');
  const contentType = typeof detail.content_type === 'string'
    ? detail.content_type
    : (typeof raw.contentType === 'string' ? raw.contentType : '');
  const createdAt = Number(raw.created_at ?? raw.createdAt);
  return {
    mid,
    // 拿不到发送者时给 0：渲染层据此写 `uid:?`，而不是把这条当成"自己说的"或直接丢掉。
    fromUid: Number.isInteger(fromUid) && fromUid >= 0 ? fromUid : 0,
    content,
    contentType,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
  };
}

/** 平台行列表 → 内部行列表，丢掉形状不对的。 */
export function mapHistoryRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(mapHistoryRow).filter(Boolean);
}

/**
 * 只留「还没被这一轮处理、也不在水位以下」的行。
 *
 * @param {object[]} rows      mapped rows
 * @param {object} options
 * @param {Iterable<number>} [options.batchMids] 本批将单独渲染的 mid，必须剔除（否则同一句出现两次）
 * @param {number|null} [options.watermark]      我们上次成功发出的 mid；`null` = 没有水位
 * @param {number} [options.limit]               最多保留几条（保留**最近**的）
 */
export function selectRows(rows, { batchMids = [], watermark = null, limit = 20 } = {}) {
  const skip = new Set([...batchMids].map(Number).filter(Number.isInteger));
  const floor = Number.isInteger(watermark) && watermark > 0 ? watermark : null;
  const filtered = (Array.isArray(rows) ? rows : []).filter(row => {
    if (skip.has(row.mid)) return false;
    if (floor !== null && row.mid <= floor) return false;
    return true;
  });
  // 稳定排序：同 mid 不可能出现两条（平台级自增），但仍按 mid 排，避免上游顺序变化。
  filtered.sort((a, b) => a.mid - b.mid);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 20;
  return filtered.length <= cap ? filtered : filtered.slice(filtered.length - cap);
}

/** 一行历史 → `[mid] uid:n：正文`。自己发的标出来，否则模型会把自己的话当成别人说的。 */
export function renderRow(row, { selfUid = 0 } = {}) {
  const who = row.fromUid > 0
    ? (selfUid > 0 && row.fromUid === selfUid ? `uid:${row.fromUid}（你自己）` : `uid:${row.fromUid}`)
    : 'uid:?';
  const text = String(row.content ?? '').trim();
  const body = text.length <= MAX_ROW_CHARS ? text : `${text.slice(0, MAX_ROW_CHARS)}…`;
  // 正文内部的换行缩进对齐，避免一行历史在提示词里看起来像好几条。
  return `[${row.mid}] ${who}：${body.replace(/\n/g, '\n    ')}`;
}

/**
 * 取频道历史并渲染。**永不抛。**
 *
 * @param {object} input
 * @param {object|null} input.port    `companionVoceChat` 端口（要有 `history`）
 * @param {{channel:number}|{user:number}|null} input.target  房间目标
 * @param {Iterable<number>} [input.batchMids]
 * @param {number|null} [input.watermark]
 * @param {number} [input.limit]
 * @param {number} [input.selfUid]
 * @returns {Promise<{lines: string[], reason: string, rows: number, code: string|null}>}
 *           `reason`：`ok` / `no-port` / `no-history` / `bad-response` / `error:<code>`
 */
export async function fetchContext({
  port, target, batchMids = [], watermark = null, limit = 20, selfUid = 0,
} = {}) {
  if (!port || typeof port.history !== 'function') return { lines: [], reason: 'no-port', rows: 0, code: null };
  if (!target) return { lines: [], reason: 'no-target', rows: 0, code: null };
  let raw;
  try {
    raw = await port.history(target, { limit });
  } catch (error) {
    // 传输层对「不是数组」已经抛 `bad-response`，其余是网络/鉴权。两者都归到「没有上下文」。
    const code = String(error?.code ?? error?.message ?? 'unknown').slice(0, 60);
    return { lines: [], reason: `error:${code}`, rows: 0, code };
  }
  if (!Array.isArray(raw)) return { lines: [], reason: 'bad-response', rows: 0, code: 'bad-response' };
  const rows = selectRows(mapHistoryRows(raw), { batchMids, watermark, limit });
  if (rows.length === 0) return { lines: [], reason: 'no-history', rows: 0, code: null };
  return { lines: rows.map(row => renderRow(row, { selfUid })), reason: 'ok', rows: rows.length, code: null };
}

/**
 * 入站包前面那一段。**空数组 = 不加这一段**（私聊、或有频道但没有可说的历史）。
 *
 * @param {string[]} lines
 * @param {number|null} watermark
 */
export function contextBlock(lines, watermark = null) {
  const list = Array.isArray(lines) ? lines.filter(line => typeof line === 'string' && line !== '') : [];
  if (list.length === 0) return [];
  const head = Number.isInteger(watermark) && watermark > 0
    ? `自你上次发言（mid ${watermark}）之后，频道里还说过这些话：`
    : '频道里最近说过这些话：';
  return [head, ...list, '——'];
}

export { MAX_ROW_CHARS };
