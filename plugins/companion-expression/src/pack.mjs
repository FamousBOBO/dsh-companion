/**
 * 表情包「整包导入」的清单（manifest）校验与语义卡整形。
 *
 * 为什么要有这一层：图库本身只有一个入口 `library.receive()`，它只认字节、格式与审核态，
 * 不知道「这张图在什么场合能发」。真实可用的图库必须带语义卡，而语义卡的字段
 * （`literal` / `intents` / `emotions` / `tone` / `scenes` / `avoidWhen` / `aggression`）是**人写的
 * 判断**，不是能从 PNG 字节里算出来的东西 —— `analyzer.mjs` 明确写了 OCR 与向量检索未实现。
 *
 * 所以导入流程必须是「操作者给的清单 + 压缩包里的图片」两样东西对上号：
 *   1. 清单说清楚每张图**是什么、什么时候能发、什么时候不该发**；
 *   2. 这个模块只负责校验清单形状、把清单条目整成 `library.upsertCard()` 认的那张卡；
 *   3. 真正的落库、写作用域、算哈希全在 `scripts/import-pack.mjs` 里做，且必须走 library 的
 *      公开方法（不直接写 SQL —— 那样会绕过 `asset_visibility` 的审核态约束）。
 *
 * 纯模块：没有 IO、没有时钟、没有随机数、不碰数据库。这样离线测试能把「清单长什么样才合法」
 * 全部钉死，而不用去碰用户的真库。
 */

/** 清单的硬上限。数值按「一个表情包压缩包」的现实规模取，超出的清单不该被信任。 */
export const PACK_LIMITS = Object.freeze({
  /** 一次导入最多多少张图。 */
  maxEntries: 200,
  /** `literal` 最长多少字符（与 `library.cardColumns` 落库时的截断口径无关，这里是入库前的门）。 */
  maxLiteral: 200,
  /** 每个列表字段最多几个元素（与 `analyzer.mjs` 的 8 项上限一致）。 */
  maxList: 8,
  /** 文件名最长多少字节（与 `security.assertSafeFilename` 的 240 对齐）。 */
  maxFileName: 240,
});

/** 清单里允许出现的键。多一个都拒 —— 拼错的键静默丢失比报错更难查。 */
export const ENTRY_KEYS = Object.freeze([
  'file', 'literal', 'intents', 'emotions', 'tone', 'scenes', 'avoidWhen', 'aggression', 'description',
]);

/**
 * 人工整理的表情包没有模型版本可言：这个常量就是「操作者写的卡」的诚实标记，
 * 绝不冒充 `analyzer.mjs` 的 `heuristics-v1` 或某个视觉模型。
 */
export const CURATED_MODEL_VERSION = 'curated-pack-v1';
/** 操作者逐张写卡时的置信度：高但不是 1.0（人工整理也会看走眼）。 */
export const CURATED_CONFIDENCE = 0.8;

const PACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

function refusal(code, message) {
  return { ok: false, reasonCode: code, message };
}

function asList(value, field) {
  if (value === undefined || value === null) return { ok: true, list: [] };
  if (typeof value === 'string') return { ok: true, list: [value.trim()].filter(Boolean) };
  if (!Array.isArray(value)) return { ok: false, ...refusal('pack-list-not-array', `清单字段 ${field} 必须是字符串数组。`) };
  const list = [];
  for (const item of value) {
    if (typeof item === 'string' || typeof item === 'number') {
      const text = String(item).trim();
      if (text) list.push(text.slice(0, 40));
      continue;
    }
    return { ok: false, ...refusal('pack-list-item-invalid', `清单字段 ${field} 里有不是字符串的元素。`) };
  }
  // 去重后截断：清单写多了是操作者的手误，不该让整包失败；但必须报出来（见 noteOf）。
  const unique = [...new Set(list)];
  return { ok: true, list: unique.slice(0, PACK_LIMITS.maxList), truncated: unique.length > PACK_LIMITS.maxList };
}

function asRatio(value, field, fallback) {
  if (value === undefined || value === null || value === '') return { ok: true, value: fallback };
  const number = Number(value);
  if (!Number.isFinite(number)) return { ok: false, ...refusal('pack-ratio-invalid', `清单字段 ${field} 必须是 0–1 的数字。`) };
  return { ok: true, value: Math.min(1, Math.max(0, number)) };
}

/**
 * 校验一条清单条目。
 *
 * `file` 必须是**裸文件名**：不接受任何路径分隔符、`..` 段、盘符、控制字符。理由是这套
 * 与 `zip.mjs` 的「整包拒收坏名字」是同一条边界 —— 清单是操作者手写的，手滑写进
 * `../` 就该当场报错，而不是等到解包时才靠运气拦住。
 *
 * @param {unknown} raw
 * @returns {{ok: true, entry: object, warnings: string[]} | {ok: false, reasonCode: string, message: string}}
 */
export function validatePackEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return refusal('pack-entry-not-object', '清单条目必须是对象。');
  }
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.includes(key)) {
      return refusal('pack-entry-unknown-key', `清单条目里有不认识的字段 ${key}；可用：${ENTRY_KEYS.join(' / ')}。`);
    }
  }
  const file = String(raw.file ?? '').trim();
  if (!file) return refusal('pack-file-missing', '清单条目缺少 file（压缩包里的文件名）。');
  if (file.length > PACK_LIMITS.maxFileName) return refusal('pack-file-too-long', `文件名超过 ${PACK_LIMITS.maxFileName} 字节。`);
  if (file.includes('/') || file.includes('\\') || file.includes(':') || file.includes('..')) {
    return refusal('pack-file-not-basename', `file 只能是压缩包里的裸文件名，不能带路径：${file}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(file)) return refusal('pack-file-control-char', '文件名里有控制字符。');

  const literal = String(raw.literal ?? '').trim();
  if (!literal) {
    // 没有 literal 的卡在检索里只剩 intents/scenes 可命中，召回率会明显下降；宁可要求写清楚。
    return refusal('pack-literal-missing', `${file} 缺少 literal：封面文字或她能用来检索的说法必须写出来。`);
  }

  const warnings = [];
  const lists = {};
  for (const field of ['intents', 'emotions', 'tone', 'scenes', 'avoidWhen']) {
    const parsed = asList(raw[field], field);
    if (!parsed.ok) return parsed;
    lists[field] = parsed.list;
    if (parsed.truncated) warnings.push(`${file} 的 ${field} 超过 ${PACK_LIMITS.maxList} 项，已截断。`);
  }
  const aggression = asRatio(raw.aggression, 'aggression', 0);
  if (!aggression.ok) return aggression;
  if (aggression.value >= 0.5) {
    // 攻击性高的素材会被场景风险惩罚压分（retrieval.mjs 的 PENALTIES.sceneRisk）；
    // 这里只提示，不阻止 —— 有些包确实要一张「生气」。
    warnings.push(`${file} 的 aggression=${aggression.value} 偏高：它在检索时会被场景风险惩罚扣分。`);
  }

  return {
    ok: true,
    warnings,
    entry: {
      file,
      literal: literal.slice(0, PACK_LIMITS.maxLiteral),
      description: String(raw.description ?? '').trim().slice(0, 200),
      intents: lists.intents,
      emotions: lists.emotions,
      tone: lists.tone,
      scenes: lists.scenes,
      avoidWhen: lists.avoidWhen,
      aggression: aggression.value,
    },
  };
}

/**
 * 校验整份清单。
 *
 * @param {unknown} raw 已经 `JSON.parse` 过的清单对象
 * @returns {{ok: true, pack: {packId: string, name: string, note: string, entries: object[]}, warnings: string[]}
 *   | {ok: false, reasonCode: string, message: string}}
 */
export function validatePackManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return refusal('pack-manifest-not-object', '清单必须是 JSON 对象。');
  }
  const packId = String(raw.packId ?? '').trim();
  if (!PACK_ID_PATTERN.test(packId)) {
    return refusal('pack-id-invalid', 'packId 只能由字母、数字、下划线与短横线组成（1–40 个字符）。');
  }
  const entriesRaw = raw.entries;
  if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
    return refusal('pack-entries-empty', '清单里 entries 必须是非空数组。');
  }
  if (entriesRaw.length > PACK_LIMITS.maxEntries) {
    return refusal('pack-too-many-entries', `清单有 ${entriesRaw.length} 条，超过上限 ${PACK_LIMITS.maxEntries}。`);
  }

  const warnings = [];
  const entries = [];
  const seen = new Set();
  for (const [index, item] of entriesRaw.entries()) {
    const parsed = validatePackEntry(item);
    if (!parsed.ok) return refusal(parsed.reasonCode, `第 ${index + 1} 条：${parsed.message}`);
    const entry = parsed.entry;
    if (seen.has(entry.file)) return refusal('pack-file-duplicate', `清单里 ${entry.file} 出现了不止一次。`);
    seen.add(entry.file);
    entries.push(entry);
    for (const warning of parsed.warnings) warnings.push(warning);
  }

  return {
    ok: true,
    warnings,
    pack: {
      packId,
      name: String(raw.name ?? '').trim().slice(0, 80) || packId,
      note: String(raw.note ?? '').trim().slice(0, 400),
      entries,
    },
  };
}

/**
 * 清单条目 → `library.upsertCard()` 认的语义卡。
 *
 * 除了清单里写的字段，只补两样：`modelVersion` 与 `confidence`。`ocr` 恒为空串 ——
 * `analyzer.mjs` 的 `NOT_IMPLEMENTED.ocr` 说了不做 OCR，往这一列里塞东西就是撒谎。
 *
 * @param {object} entry 已通过 `validatePackEntry` 的条目
 * @returns {object}
 */
export function cardForEntry(entry) {
  return {
    literal: String(entry?.literal ?? ''),
    ocr: '',
    intents: [...(entry?.intents ?? [])],
    emotions: [...(entry?.emotions ?? [])],
    tone: [...(entry?.tone ?? [])],
    rhetoric: [],
    scenes: [...(entry?.scenes ?? [])],
    avoidWhen: [...(entry?.avoidWhen ?? [])],
    aggression: Number(entry?.aggression ?? 0),
    confidence: CURATED_CONFIDENCE,
    modelVersion: CURATED_MODEL_VERSION,
  };
}

/**
 * 清单与压缩包对账：哪些文件能导、哪些清单写了但包里没有、哪些包里有但清单没写。
 *
 * 后两类一律**不阻止**导入，但必须报出来：少一张图是操作者的清单漏了，多一张图可能是
 * 预览图 / 说明图 / 包里混进的东西。静默忽略才是这里最危险的选择。
 *
 * @param {{pack: object, zipNames: string[]}} input
 * @returns {{ok: boolean, reasonCode: string, message: string, plan: Array<{file: string, entry: object}>,
 *   missing: string[], extra: string[]}}
 */
export function reconcilePack({ pack, zipNames } = {}) {
  const names = new Set((Array.isArray(zipNames) ? zipNames : []).map(name => String(name)));
  const plan = [];
  const missing = [];
  for (const entry of pack?.entries ?? []) {
    if (!names.has(entry.file)) { missing.push(entry.file); continue; }
    plan.push({ file: entry.file, entry });
  }
  const listed = new Set((pack?.entries ?? []).map(entry => entry.file));
  const extra = [...names].filter(name => !listed.has(name));
  if (plan.length === 0) {
    return {
      ok: false, reasonCode: 'pack-zip-mismatch',
      message: `压缩包里一张清单上的图都没有（清单 ${listed.size} 条，包 ${names.size} 个条目）。`,
      plan, missing, extra,
    };
  }
  return { ok: true, reasonCode: '', message: '', plan, missing, extra };
}

export default {
  PACK_LIMITS, ENTRY_KEYS, CURATED_MODEL_VERSION, CURATED_CONFIDENCE,
  validatePackEntry, validatePackManifest, cardForEntry, reconcilePack,
};
