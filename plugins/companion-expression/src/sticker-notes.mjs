/**
 * 表情词典：**见过的表情只用解释一次**。
 *
 * 这条线解决的问题（2026-11-08 用户提出）：群友/主人发来的表情，模型看到的是
 * `[图片][图片含义：[动画表情]]` 或 `[图片][图片含义：[困]]`，于是它按「我看到了一张图」去
 * 描述画面 —— 而表情根本不是图，是**一句话**。`[困]` 的意思是「我困了」，不是「画面里
 * 有个字写着困」。
 *
 * 所以这里做三件事，全都不联网、不调模型：
 *
 *   1. **认得出**：同一张表情再来一次（`stickerKey` 相同），直接给出原来记下的意思；
 *   2. **认不出就说认不出**：`lookup()` 回 `{known:false}`，绝不编一段画面描述；
 *   3. **问清楚了就记住**：`record()` 把「这个表情是什么意思」写成一行，私聊里问过主人之后
 *      就能长期复用（动图也一样——它记的是意思，不是帧）。
 *
 * 键是**稳定指纹**，不是 QQ 号：`parse.ts` 的 `stickerKeyOf()` 优先用 NapCat 给的
 * `file` 名（同一张收藏表情每次都是同一个 stem），其次用 `summary` 文本，最后才退到
 * URL 末段。这样「同一张图」在跨会话、跨时间都能对上。
 */

/** 一条词典记录。 */
export function noteOf(row) {
  if (!row) return null;
  return {
    stickerKey: String(row.sticker_key),
    label: String(row.label ?? ''),
    meaning: String(row.meaning ?? ''),
    animated: Number(row.animated ?? 0) === 1,
    source: String(row.source ?? ''),
    hits: Number(row.hits ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** 意思是人写的判断，不是自动生成的，所以有长度与形状的底线。 */
const MEANING_MAX = 200;
const LABEL_MAX = 40;
const KEY_MAX = 200;

export const NOTE_SOURCES = Object.freeze(['owner', 'self', 'import', 'learned']);

function cleanKey(value) {
  return String(value ?? '').trim().slice(0, KEY_MAX);
}

function cleanMeaning(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MEANING_MAX);
}

/**
 * 创建词典句柄。
 * @param {{db: object, now?: () => number}} options
 */
export function createStickerNotes({ db, now = () => Date.now() } = {}) {
  if (!db || typeof db.run !== 'function') throw new Error('createStickerNotes 需要数据库句柄。');
  const clock = () => Number(now()) || Date.now();

  /**
   * 认一个表情。
   *
   * @param {{stickerKey?: string, label?: string, scope?: string, animated?: boolean}} input
   * @returns {{known: true, meaning: string, label: string, animated: boolean, source: string, times: number}
   *   | {known: false, reasonCode: string, label: string, animated: boolean, times: number}}
   *
   * `times` 是「这个表情在**本作用域**见过第几次」：见过多次但还没记意思，正是值得问一句的时机。
   */
  function lookup({ stickerKey = '', label = '', scope = '', animated = false } = {}) {
    const key = cleanKey(stickerKey);
    const cleanLabel = String(label ?? '').trim().slice(0, LABEL_MAX);
    const isAnimated = animated === true;
    if (key === '') return { known: false, reasonCode: 'key-missing', label: cleanLabel, animated: isAnimated, times: 0 };
    const at = clock();
    const seen = scope === '' ? 0 : markSeen(key, String(scope), at);
    const row = db.get('SELECT * FROM sticker_notes WHERE sticker_key = ?', [key]);
    if (!row) return { known: false, reasonCode: 'not-recorded', label: cleanLabel, animated: isAnimated, times: seen };
    // `hits` 是「这条意思被用了几次」：只加计数，不动 `updated_at`（那是「人最后一次改它」）。
    db.run('UPDATE sticker_notes SET hits = hits + 1 WHERE sticker_key = ?', [key]);
    const note = noteOf(row);
    return { known: true, meaning: note.meaning, label: note.label || cleanLabel, animated: note.animated || isAnimated, source: note.source, times: seen };
  }

  /** 记一次「见过」（按作用域分开计数；只用于判断「要不要问一句」）。 */
  function markSeen(key, scope, at) {
    db.run(
      `INSERT INTO sticker_seen (sticker_key, scope, first_seen, last_seen, times) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(sticker_key, scope) DO UPDATE SET last_seen = excluded.last_seen, times = times + 1`,
      [key, scope, at, at],
    );
    const row = db.get('SELECT times FROM sticker_seen WHERE sticker_key = ? AND scope = ?', [key, scope]);
    return Number(row?.times ?? 0);
  }

  /**
   * 记下意思。
   *
   * @param {{stickerKey?: string, label?: string, meaning?: string, animated?: boolean,
   *   source?: string, scope?: string}} input
   * @returns {{ok: true, note: object} | {ok: false, reasonCode: string, message: string}}
   */
  function record({ stickerKey = '', label = '', meaning = '', animated = false, source = 'owner', scope = '' } = {}) {
    const key = cleanKey(stickerKey);
    const text = cleanMeaning(meaning);
    if (key === '') return { ok: false, reasonCode: 'key-missing', message: '缺少表情指纹（stickerKey）：不知道说的是哪个表情。' };
    if (text === '') return { ok: false, reasonCode: 'meaning-empty', message: '意思不能为空：这个表情要表达什么？' };
    const origin = NOTE_SOURCES.includes(String(source)) ? String(source) : 'owner';
    const at = clock();
    db.run(
      `INSERT INTO sticker_notes (sticker_key, label, meaning, animated, source, scope, hits, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(sticker_key) DO UPDATE SET
           label = excluded.label, meaning = excluded.meaning, animated = excluded.animated,
           source = excluded.source, scope = excluded.scope, updated_at = excluded.updated_at`,
      [key, String(label ?? '').trim().slice(0, LABEL_MAX), text, animated === true ? 1 : 0, origin,
        String(scope ?? '').slice(0, 120), at, at],
    );
    return { ok: true, note: noteOf(db.get('SELECT * FROM sticker_notes WHERE sticker_key = ?', [key])) };
  }

  /** 按字面找（`困` → 所有记过这个字的表情）。Studio 与「这个词你以前说过是什么意思」用。 */
  function findByLabel(label, { limit = 5 } = {}) {
    const text = String(label ?? '').trim().slice(0, LABEL_MAX);
    if (text === '') return [];
    return db.all('SELECT * FROM sticker_notes WHERE label = ? ORDER BY updated_at DESC LIMIT ?',
      [text, Math.max(1, Math.min(20, Number(limit) || 5))]).map(noteOf);
  }

  /** 全部记过意思的表情（Studio 列表 + 统计）。 */
  function list({ limit = 50, offset = 0 } = {}) {
    const take = Math.max(1, Math.min(200, Number(limit) || 50));
    const skip = Math.max(0, Number(offset) || 0);
    const total = Number(db.get('SELECT count(*) AS total FROM sticker_notes')?.total ?? 0);
    const items = db.all('SELECT * FROM sticker_notes ORDER BY updated_at DESC LIMIT ? OFFSET ?', [take, skip]).map(noteOf);
    return { total, items };
  }

  /** 统计：记了多少、其中动图多少、见过但还没记的有多少。 */
  function stats() {
    const one = sql => Number(db.get(String(sql))?.total ?? 0);
    return {
      noted: one('SELECT count(*) AS total FROM sticker_notes'),
      animated: one('SELECT count(*) AS total FROM sticker_notes WHERE animated = 1'),
      seen: one('SELECT count(*) AS total FROM sticker_seen'),
      // 「见过 ≥2 次但还没记意思」= 最值得问一句的那一批。
      askable: one(`SELECT count(*) AS total FROM sticker_seen s
        LEFT JOIN sticker_notes n ON n.sticker_key = s.sticker_key
        WHERE n.sticker_key IS NULL AND s.times >= 2`),
    };
  }

  return { lookup, record, findByLabel, list, stats, markSeen };
}

export default { createStickerNotes, noteOf, NOTE_SOURCES };
