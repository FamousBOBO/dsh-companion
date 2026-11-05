import { createHash } from 'node:crypto';

// Shared text primitives for the companion memory engine. Every module that
// writes or queries SQLite FTS5 text must go through here so that the indexed
// form and the query form stay identical; a mismatch silently kills recall.

const STOP_TERMS = new Set([
  '什么', '怎么', '记得', '记忆', '我们', '你们', '这个', '那个', '一下', '可以', '还是',
  '现在', '之前', '的事', '吗', '呢', '吧', '啊', '的', '了', '是', '我', '你', '他', '她',
]);

const SECRET_PATTERNS = [
  /\b(?:sk-[a-zA-Z0-9_-]{10,}|Bearer\s+[a-zA-Z0-9._-]{12,})/g,
  /((?:api[_ -]?key|password|密码|密钥|token|secret)\s*[:=：]\s*)[^\s,，;；]+/gi,
];

export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function hanRuns(value) {
  return normalizeText(value).match(/\p{Script=Han}+/gu) ?? [];
}

export function latinWords(value) {
  return normalizeText(value).match(/[a-z0-9_]{2,}/g) ?? [];
}

/** Overlapping Han bigrams plus latin words; the historical recall strategy. */
export function terms(value) {
  const result = latinWords(value);
  for (const run of hanRuns(value)) {
    for (let i = 0; i < run.length - 1; i++) result.push(run.slice(i, i + 2));
    if (run.length === 1) result.push(run);
  }
  return [...new Set(result)].filter(term => !STOP_TERMS.has(term));
}

/** Space separated tokens stored in the FTS5 column. */
export function searchText(...parts) {
  return terms(parts.filter(part => part != null && part !== '').join('\n')).join(' ');
}

/** FTS5 MATCH expression: quoted bigrams OR'd together, bounded for safety. */
export function matchExpression(query, maxTerms = 48) {
  const unique = terms(query).slice(0, maxTerms);
  if (!unique.length) return null;
  return unique.map(term => '"' + term.replaceAll('"', '""') + '"').join(' OR ');
}

export function contentHash(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function stableId(prefix, ...parts) {
  const digest = contentHash(parts.map(part => String(part ?? '')).join('\u0000')).slice(0, 20);
  return `${prefix}_${digest}`;
}

export function truncate(value, max, suffix = '…') {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

export function redactSecrets(value) {
  let text = String(value ?? '');
  text = text.replace(SECRET_PATTERNS[0], '[REDACTED]');
  text = text.replace(SECRET_PATTERNS[1], (_match, prefix) => `${prefix}[REDACTED]`);
  return text;
}

export function isoNow(clock = Date.now()) {
  return new Date(clock).toISOString();
}

/** Parse a timestamp that may be ISO or `YYYY-MM-DD HH:MM:SS.ffffff`; null when unusable. */
export function parseTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

// ---------------------------------------------------------------------------
// 时间（本项目时区固定 Asia/Shanghai，即 +08:00）
//
// 记忆的「发生时间」有两个来源：模型（或调用方）给的本地时间字符串，以及库里存的
// UTC ISO。这两个函数把两边收敛成同一种表示，避免 `Date.parse('2026-10-28')`
// 被当成 UTC 零点这种偏移 8 小时的低级错误。
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// 无时区的本地时间：日期 + 时间，允许 空格/T 分隔、秒可省略、小数秒 1–9 位。
// （2026-10-28 评审 P1：旧格式 `2026-10-27 10:00:00.123456` 之前不匹配，会回落
//  到按运行环境 TZ 解析的 parseTime，换机器差 8 小时。）
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?$/;

/** 本地时间（`YYYY-MM-DD` / `YYYY-MM-DD HH:mm[:ss[.ffff]]` / 无时区 ISO）→ UTC ISO；带 Z/偏移原样解析。 */
export function parseLocalMoment(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const text = String(value).trim();
  if (!text) return null;
  // 纯日期走同一条校验路径（补 00:00），否则 `Date.parse('2026-02-30T00:00:00+08:00')`
  // 会把 2 月 30 日静默进位成 3 月 2 日，`0999-01-01` 也不会被拒。
  const candidate = DATE_ONLY.test(text) ? `${text} 00:00` : text;
  const local = LOCAL_DATE_TIME.exec(candidate);
  if (local) {
    const [, year, month, day, hour, minute, second = '00', fraction = ''] = local;
    // 先校验字段再构造：Date.UTC 会把 2026-13 / 25:00 / :60 静默进位成合法时间，
    // 那会把「模型给了错时间」变成「记忆落在另一个时刻」，所以越界一律返回 null。
    const yearNum = Number(year);
    const monthNum = Number(month);
    const dayNum = Number(day);
    const hourNum = Number(hour);
    const minuteNum = Number(minute);
    const secondNum = Number(second);
    if (!(yearNum >= 1000 && yearNum <= 9999)) return null;
    if (!(monthNum >= 1 && monthNum <= 12)) return null;
    if (!(hourNum <= 23 && minuteNum <= 59 && secondNum <= 59)) return null;
    const daysInMonth = new Date(Date.UTC(yearNum, monthNum, 0)).getUTCDate();
    if (!(dayNum >= 1 && dayNum <= daysInMonth)) return null;
    // 自己算 UTC 毫秒再减 8 小时：不依赖 Date.parse 的小数秒处理，也不依赖运行环境 TZ。
    const millis = `${fraction}000`.slice(0, 3);
    const utcMs = Date.UTC(yearNum, monthNum - 1, dayNum, hourNum, minuteNum, secondNum, Number(millis));
    if (!Number.isFinite(utcMs)) return null;
    return new Date(utcMs - 8 * 60 * 60 * 1000).toISOString();
  }
  return parseTime(text);
}

/** UTC ISO / 时间戳 / Date → `YYYY-MM-DD HH:mm`（Asia/Shanghai）；无法识别返回 ''。 */
export function formatMoment(value, { withTime = true } = {}) {
  const iso = value instanceof Date ? value.toISOString() : parseTime(value);
  if (!iso) return '';
  // 用 UTC getter + 固定 8 小时偏移，结果不随运行环境 TZ 变化。
  const shifted = new Date(Date.parse(iso) + 8 * 60 * 60 * 1000);
  const pad = number => String(number).padStart(2, '0');
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  if (!withTime) return date;
  return `${date} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}
