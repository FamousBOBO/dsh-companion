/**
 * 决策：这一轮到底该不该发一张表情包（设计文档 §6.1）。
 *
 * 顺序是固定的，而且**禁忌硬门永远先于偏好分**：
 *   1. 总开关（`delivery.enabled`）关着 → `abstain-delivery-disabled`；
 *   2. 禁忌硬门：严肃求助 / 隐私风险 / 现实冲突 / 用户明确拒绝 → 直接 abstain，候选再好也不算；
 *   3. 配额与冷却：`deliveries`（真实发过的事实）与 `quotas`（在途预留）**两张表**取较大者；
 *   4. 同图抑制：私聊 48h / 群 168h（`delivery.repeatWindow*Hours`）内发过的素材本轮不再选；
 *   5. 候选适配分：`retrieval` 给回的候选里最高的 `fitScore` 不到 `retrieval.minFitScore` → `text_only`。
 *
 * 关键口径：**abstain 是正常结果，不是错误**。没有高分素材就是纯文字；`ok: false` 只在
 * 「参数装配错了」这种真异常时出现，且返回值结构仍然可读。
 *
 * 事实来源全部是数据库里的行，不是内存状态：重启后同一条私聊的冷却与小时配额仍然生效。
 */
import { isSuppressed } from './feedback.mjs';

/** 禁忌场景的原因码 → 中文解释。UI 与日志都直接读这张表，不另写一套文案。 */
export const TABOO_REASONS = Object.freeze({
  'serious-help': 'abstain-serious-help',
  'privacy-risk': 'abstain-privacy-risk',
  'real-conflict': 'abstain-real-conflict',
  'user-refusal': 'abstain-user-refusal',
});

export const DECISION_REASONS = Object.freeze([
  'send', 'abstain-delivery-disabled', 'abstain-serious-help', 'abstain-privacy-risk',
  'abstain-real-conflict', 'abstain-user-refusal', 'abstain-cooldown', 'abstain-hourly-quota',
  'abstain-repeat-window', 'text-only-no-candidate', 'text-only-low-fit', 'abstain-turn-limit',
  'abstain-module-off',
]);

const HOUR_MS = 3_600_000;
const DELIVERED_STATES = Object.freeze(['sent', 'confirmed', 'unknown']);

export function hourSlot(nowMs) {
  return `h${Math.floor(Number(nowMs) / HOUR_MS)}`;
}

/**
 * 配额/冷却的桶键。
 *
 * 口径很关键：`deliveries.scope` 列本来就**已经是会话粒度**——私聊是
 * `owner_private:<hash>` / `peer_private:<hash>`（一个会话一个作用域），群聊是 `group:<id>`
 * （天然按群分开）。所以配额桶直接取作用域即可：「单群 2 张/小时」「这条私聊 4 张/小时」
 * 都是文档要求的粒度，而且重启后不需要另建映射表。只有拿不到作用域时才退回 `delivery:…`。
 */
export function quotaBucketFor({ kind, id, scope }) {
  const scopeText = String(scope ?? '').trim();
  if (scopeText) return scopeText;
  return `delivery:${String(kind)}:${String(id)}`;
}

/**
 * 本轮要用的约束数值。全部来自 config（`delivery.*`），缺省回落到与 config.mjs 相同的基准，
 * 但**不从代码里另造一套默认**：调用方应当传 `config.mjs` 的 `DEFAULT_CONFIG`。
 */
export function limitsFrom(config = {}) {
  const delivery = config?.delivery ?? {};
  return {
    enabled: delivery.enabled === true,
    maxPerTurn: Number.isFinite(Number(delivery.maxPerTurn)) ? Number(delivery.maxPerTurn) : 1,
    dmCooldownSeconds: Number(delivery.dmCooldownSeconds ?? 300),
    groupCooldownSeconds: Number(delivery.groupCooldownSeconds ?? 600),
    maxDmPerHour: Number(delivery.maxDmPerHour ?? 4),
    maxGroupPerHour: Number(delivery.maxGroupPerHour ?? 2),
    repeatWindowDmHours: Number(delivery.repeatWindowDmHours ?? 48),
    repeatWindowGroupHours: Number(delivery.repeatWindowGroupHours ?? 168),
    minFitScore: Number(config?.retrieval?.minFitScore ?? 0.72),
  };
}

/** 收集禁忌标签：调用方给的标签 + 草稿里的明显信号。命中即 abstain。 */
export function tabooOf({ tabs = null, context = {}, draft = '' } = {}) {
  const wanted = new Set();
  for (const tag of Array.isArray(tabs) ? tabs : []) wanted.add(String(tag));
  for (const tag of Array.isArray(context?.riskTags) ? context.riskTags : []) wanted.add(String(tag));
  if (context?.seriousHelp === true) wanted.add('serious-help');
  if (context?.privacyRisk === true) wanted.add('privacy-risk');
  if (context?.realConflict === true) wanted.add('real-conflict');
  if (context?.userRefused === true || context?.declinedStickers === true) wanted.add('user-refusal');
  // 草稿只是弱证据：明确诉苦/求助措辞也算硬门（宁可少发一张，也不在严肃语境里玩梗）。
  const text = String(draft ?? '');
  if (/求助|怎么办|救命|很难受|想死|自杀|报警|诈骗|失恋|葬礼|去世|生病|医院/.test(text)) wanted.add('serious-help');
  if (/密码|身份证|银行卡|住址|手机号|转账截图/.test(text)) wanted.add('privacy-risk');
  if (/别吵了|分手|吵架|道歉|对不起/.test(text)) wanted.add('real-conflict');
  const hit = [...Object.keys(TABOO_REASONS)].find(tag => wanted.has(tag));
  return hit ? { taboo: true, reasonCode: TABOO_REASONS[hit], tag: hit } : { taboo: false, reasonCode: '', tag: '' };
}

/** 该会话在时间窗内确实发过几张图（`deliveries` 是事实来源，`status` 含 unknown）。 */
export function deliveriesInWindow({ db, bucketKey, sinceMs } = {}) {
  try {
    const rows = db.all(
      'SELECT status, at FROM deliveries WHERE scope = ? AND at >= ? ORDER BY at DESC',
      [String(bucketKey), Number(sinceMs)],
    );
    return rows.filter(row => DELIVERED_STATES.includes(String(row.status)));
  } catch {
    return [];
  }
}

/** 最近一次真正发图的时间（0 表示没有）。 */
export function lastDeliveryAt({ db, bucketKey } = {}) {
  try {
    const row = db.get('SELECT max(at) AS at FROM deliveries WHERE scope = ?', [String(bucketKey)]);
    return Number(row?.at ?? 0);
  } catch {
    return 0;
  }
}

/** 该素材在该会话多久之前发过（ms）。0 表示没发过。 */
export function lastSeenOfAsset({ db, bucketKey, assetId } = {}) {
  try {
    const row = db.get('SELECT max(at) AS at FROM deliveries WHERE scope = ? AND asset_id = ?', [String(bucketKey), String(assetId)]);
    return Number(row?.at ?? 0);
  } catch {
    return 0;
  }
}

/**
 * 冷却与小时配额一起判。`quotas` 里可能已经有在途预留（投递层在发送前占位），
 * 所以取两者较大者：宁可少发，也不因为两套计数不同步而超发。
 */
export function quotaState({ db, bucketKey, kind, limits, now } = {}) {
  const hourAgo = Number(now) - HOUR_MS;
  const rows = deliveriesInWindow({ db, bucketKey, sinceMs: hourAgo });
  let reserved = 0;
  try {
    const row = db.get('SELECT used FROM quotas WHERE bucket = ? AND slot = ?', [bucketKey, hourSlot(now)]);
    reserved = Number(row?.used ?? 0);
  } catch { reserved = 0; }
  const isGroup = String(kind) === 'group';
  const limit = isGroup ? limits.maxGroupPerHour : limits.maxDmPerHour;
  const cooldownSeconds = isGroup ? limits.groupCooldownSeconds : limits.dmCooldownSeconds;
  const last = lastDeliveryAt({ db, bucketKey });
  const elapsed = last > 0 ? Number(now) - last : Number.MAX_SAFE_INTEGER;
  return {
    used: rows.length,
    reserved,
    limit,
    cooldownSeconds,
    cooling: elapsed < cooldownSeconds * 1000,
    cooldownRemainingMs: Math.max(0, cooldownSeconds * 1000 - elapsed),
    hourlyFull: rows.length >= limit || reserved >= limit,
  };
}

/** 素材是否落在重复抑制窗口里。 */
export function repeatedAsset({ db, bucketKey, assetId, kind, limits, now } = {}) {
  const hours = String(kind) === 'group' ? limits.repeatWindowGroupHours : limits.repeatWindowDmHours;
  const windowMs = hours * HOUR_MS;
  const last = lastSeenOfAsset({ db, bucketKey, assetId });
  if (last <= 0) return { repeated: false, lastAt: 0, hours };
  return { repeated: Number(now) - last < windowMs, lastAt: last, hours };
}

function abstain(reasonCode, message, extra = {}) {
  return { ok: true, send: false, mode: 'text_only', reasonCode, message, fitScore: 0, ...extra };
}

/**
 * 决策入口。**永不抛**：参数不全也返回结构化 abstain。
 *
 * @param {{
 *   db: object, config: object, target: {kind: 'dm'|'group', id: string|number},
 *   scope: string, bucketKey?: string, candidates?: object[], context?: object,
 *   draft?: string, now?: number, moduleEnabled?: boolean,
 * }} input
 * @returns {{
 *   ok: boolean, send: boolean, mode: 'text_only'|'sticker_only'|'text_then_sticker',
 *   reasonCode: string, fitScore: number, assetId?: string|null, message: string,
 *   limits: object, quota: object, meta: object
 * }}
 */
export function decide({
  db, config = {}, target = {}, scope = '', bucketKey = null, candidates = [],
  context = {}, draft = '', now = Date.now(), moduleEnabled = true,
} = {}) {
  const limits = limitsFrom(config);
  const kind = String(target?.kind ?? 'dm') === 'group' ? 'group' : 'dm';
  const id = String(target?.id ?? '');
  const key = bucketKey ?? quotaBucketFor({ kind, id, scope });
  const base = { limits, quota: {}, meta: { kind, id, scope, bucketKey: key, at: Number(now) } };
  if (!db || typeof db.all !== 'function') {
    return { ...abstain('abstain-module-off', '数据库不可用，本轮不发图。', base), ok: false };
  }
  if (moduleEnabled !== true) return abstain('abstain-module-off', '表情包模块整体关闭，本轮不发图。', base);
  if (limits.enabled !== true) return abstain('abstain-delivery-disabled', 'delivery.enabled 为 false：不会真发图（工具仍可给候选）。', base);
  if (limits.maxPerTurn <= 0) return abstain('abstain-turn-limit', 'delivery.maxPerTurn 为 0：本配置下每轮都不发图。', base);

  // 1) 禁忌硬门：先于任何偏好分。
  const taboo = tabooOf({ tabs: context?.taboos, context, draft });
  if (taboo.taboo) {
    return abstain(taboo.reasonCode, `禁忌场景「${taboo.tag}」：本轮不玩梗（abstain 是正确结果）。`, { ...base, meta: { ...base.meta, taboo: taboo.tag } });
  }

  // 2) 冷却与小时配额（deliveries 与 quotas 取较大者）。
  const quota = quotaState({ db, bucketKey: key, kind, limits, now });
  if (quota.hourlyFull) {
    return abstain('abstain-hourly-quota', `本小时已发 ${quota.used} 张（预留 ${quota.reserved}），达到上限 ${quota.limit}。`, { ...base, quota });
  }
  if (quota.cooling) {
    return abstain('abstain-cooldown', `冷却中：还需 ${Math.ceil(quota.cooldownRemainingMs / 1000)} 秒（${quota.cooldownSeconds}s 规则）。`, { ...base, quota });
  }

  // 3) 候选：硬门已在 retrieval 做过；这里再按重复窗口与显式抑制过一遍。
  const shortlist = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const assetId = String(candidate?.assetId ?? '');
    if (!assetId) continue;
    let suppressed = false;
    try { suppressed = isSuppressed({ db, scope, assetId }); } catch { suppressed = false; }
    if (suppressed) continue;
    const repeat = repeatedAsset({ db, bucketKey: key, assetId, kind, limits, now });
    if (repeat.repeated) continue;
    shortlist.push({ ...candidate, fitScore: Number(candidate?.fitScore ?? 0) });
  }
  if (shortlist.length === 0) {
    return abstain('text-only-no-candidate', '没有可用候选（全部被重复窗口或显式拒绝过滤），本轮走纯文字。', { ...base, quota });
  }
  shortlist.sort((a, b) => b.fitScore - a.fitScore || String(a.assetId).localeCompare(String(b.assetId)));
  const best = shortlist[0];
  if (best.fitScore < limits.minFitScore) {
    return abstain('text-only-low-fit', `最高适配分 ${best.fitScore.toFixed(3)} < minFitScore ${limits.minFitScore}：不够贴切，走纯文字。`, { ...base, quota, fitScore: best.fitScore });
  }

  return {
    ok: true, send: true, mode: 'text_then_sticker', reasonCode: 'send',
    fitScore: best.fitScore, assetId: String(best.assetId),
    message: '可以发一张图：已过硬门、冷却、配额与重复窗口。',
    ...base, quota,
  };
}

/** 发送成功后占配额（供 delivery 调用；只增不减，便于审计）。 */
export function consumeDeliveryQuota({ db, bucketKey, now = Date.now(), count = 1 } = {}) {
  const bucket = String(bucketKey ?? '');
  if (!db || !bucket) return { ok: false, reasonCode: 'bucket-missing', message: '缺少配额桶。' };
  try {
    db.run(
      `INSERT INTO quotas (bucket, slot, used) VALUES (?, ?, ?)
         ON CONFLICT(bucket, slot) DO UPDATE SET used = used + excluded.used`,
      [bucket, hourSlot(now), Number(count) || 1],
    );
    return { ok: true, bucket, slot: hourSlot(now) };
  } catch (error) {
    return { ok: false, reasonCode: 'quota-write-failed', message: String(error?.message ?? error).slice(0, 160) };
  }
}

export default {
  TABOO_REASONS, DECISION_REASONS, limitsFrom, tabooOf, hourSlot, quotaBucketFor,
  deliveriesInWindow, lastDeliveryAt, lastSeenOfAsset, quotaState, repeatedAsset, decide, consumeDeliveryQuota,
};
