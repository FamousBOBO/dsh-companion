// 主动关怀（`health.care.proactive`）的**唯一**出处。
//
// 设计上的三条硬线，缺一条这条功能就不该存在：
//   1. 只讲**来源报了什么**，不讲建议、不下结论。文本里不出现"你应该/注意/建议"这类词，
//      也不出现任何阈值判断 —— 那需要人群基线与医学依据，本模块没有。
//   2. 一夜只说一次。去重键是 `kind + 睡眠日`，靠 `health_care_delivered` 的主键保证，
//      重复开会话不会重复念同一句。
//   3. 不外发。这里只产出**文本**，投递通道由调用方决定（当前唯一实现是注入到会话上下文，
//      不经过 QQ/微信等任何平台，因此不依赖平台回执）。
//
// 说得更直白：这是一个"把昨晚的事实说一遍"的模块，不是健康建议引擎。

/** 一夜之内最多说一次的窗口：醒来后 18 小时内仍然算"今早"。 */
export const CARE_MAX_AGE_HOURS = 18;

/** 注入文本的硬上限（字符）。宁可少说，不要占掉对话的预算。 */
export const CARE_MAX_CHARS = 160;

const MINUTES_PER_HOUR = 60;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 时刻要同时认两种形状：毫秒数（库里的列）和 ISO 字符串（`buildSleep()` 投影出来的）。
 *
 * 2026-11-04 的第一版只认数字，对着真投影时 `Number('2026-11-04T03:36:00+08:00')` 是 NaN，
 * 于是每一夜都被判成"没有起止"——纯函数的单测全绿，接上真数据却一句话都说不出来。
 * 这类"单测绿、线上哑"的缝，一律在这里缝死。
 */
function instantOf(value) {
  const numeric = finiteNumber(value);
  if (numeric != null) return numeric;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 299 → `4h59m`。刻意用最紧凑的写法：这是要注入到对话里的。 */
export function shortDuration(minutes) {
  const value = finiteNumber(minutes);
  if (value == null || value < 0) return null;
  const total = Math.round(value);
  const hours = Math.floor(total / MINUTES_PER_HOUR);
  const rest = total % MINUTES_PER_HOUR;
  if (hours <= 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

/** UTC ms → `03:36`（按给定时区）。刻意不带日期：句子在多数情况下说的是"昨晚"。 */
export function clockOf(instantMs, tz) {
  const value = instantOf(instantMs);
  if (value == null) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value));
  } catch {
    return null;
  }
}

/** UTC ms → 本地 `YYYY-MM-DD`。 */
export function localDateOf(instantMs, tz) {
  const value = instantOf(instantMs);
  if (value == null) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(value));
    const get = type => parts.find(part => part.type === type)?.value ?? '';
    const text = `${get('year')}-${get('month')}-${get('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function isMainNight(session) {
  if (!session || typeof session !== 'object') return false;
  if (session.isNap === true) return false;
  // 只有聚合、没有起止的会话不进关怀：连"几点睡几点起"都说不出来，说了也是空话。
  if (session.status === 'aggregate_only') return false;
  return instantOf(session.startAt) != null && instantOf(session.endAt) != null;
}

function sortedNewestFirst(sessions) {
  return [...sessions].sort((left, right) => (instantOf(right?.endAt) ?? 0) - (instantOf(left?.endAt) ?? 0));
}

/**
 * 从睡眠投影结果生成关怀条目。**纯函数**：不读库、不看时钟以外的状态。
 *
 * @param {object} input
 * @param {object} input.sleep      `service.sleep()` 的返回（用 `sessions[]`）
 * @param {number} input.nowMs
 * @param {string} input.tz
 * @returns {Array<{kind:string, dedupeKey:string, sleepDate:string|null, text:string, at:number|null}>}
 */
export function buildCareItems({ sleep, nowMs = Date.now(), tz = 'Asia/Shanghai', qqSummary = false } = {}) {
  const sessions = Array.isArray(sleep?.sessions) ? sleep.sessions.filter(isMainNight) : [];
  if (!sessions.length) return [];

  const now = finiteNumber(nowMs) ?? Date.now();
  const maxAgeMs = CARE_MAX_AGE_HOURS * 60 * 60 * 1000;
  const items = [];

  for (const session of sortedNewestFirst(sessions)) {
    const endAt = instantOf(session.endAt);
    if (endAt == null) continue;
    // 未来的时间戳说明数据有问题，不是"马上要睡"——不猜，直接跳过。
    if (endAt > now + 60 * 60 * 1000) continue;
    if (now - endAt > maxAgeMs) continue;

    const asleep = finiteNumber(session.asleepMinutes);
    if (asleep == null || asleep <= 0) continue;

    const sleepDate = typeof session.sleepDate === 'string' ? session.sleepDate : localDateOf(endAt, tz);
    const wokeUp = clockOf(endAt, tz);
    const fellAsleep = clockOf(instantOf(session.startAt), tz);
    const duration = shortDuration(asleep);
    if (!duration || !wokeUp) continue;

    if (qqSummary) {
      const startAt = instantOf(session.startAt);
      if (endAt > now || startAt >= endAt || !fellAsleep) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sleepDate) || !session.sourceId) continue;
      return [{
        sourceId: session.sourceId,
        sleepDate,
        expiresAt: endAt + maxAgeMs,
        text: `睡眠记录显示，${fellAsleep} 入睡，${wokeUp} 醒来，共睡了 ${duration}。`,
      }];
    }

    const today = localDateOf(now, tz);
    const nightWord = sleepDate && today && sleepDate === today ? '这一觉' : '昨晚';
    const parts = [];
    if (fellAsleep) parts.push(`${fellAsleep} 入睡`);
    parts.push(`${wokeUp} 醒`);
    parts.push(`睡了 ${duration}`);
    const score = finiteNumber(session.sourceScore);
    const body = score == null ? parts.join('、') : `${parts.join('、')}（原厂评分 ${Math.round(score)}）`;

    items.push({
      kind: 'sleep.summary',
      // 一夜一条：补正了时长也还是同一夜，不再念第二遍。
      dedupeKey: `sleep.summary:${sleepDate ?? localDateOf(endAt, tz) ?? 'unknown'}`,
      sleepDate: sleepDate ?? null,
      text: `${nightWord}${body}。`,
      at: endAt,
    });
    // 只关怀最近的一夜，不补念历史。
    break;
  }

  return items;
}

/**
 * 把一条关怀条目裁成可注入的一行。
 *
 * 超长就截断并保留句号 —— 截断比省略更能让人看出"这里被裁了"，也不会吃掉后面的上下文。
 */
export function careLine(item, { maxChars = CARE_MAX_CHARS } = {}) {
  const text = typeof item?.text === 'string' ? item.text.trim() : '';
  if (!text) return '';
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.floor(Number(maxChars))
    : CARE_MAX_CHARS;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}
