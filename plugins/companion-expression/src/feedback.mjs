/**
 * 反馈与习惯学习（E3）。
 *
 * 设计文档 §7 的四条口径，这里逐条落地：
 *   1. **只认显式反馈**：praise / reject / correction 由人或模型显式给出；**沉默不是负反馈**
 *      （`silence` 直接返回「没记」并一行都不写）。
 *   2. **reject 立即降权并抑制重发**：写一行反馈，同时在 `preferences` 落一个**作用域级**抑制键；
 *      检索与决策都读它，所以下一轮不会再选这张图，且群里的 reject 不会禁掉主人在私聊里的同一张图。
 *   3. **正反馈提升同类意图**：`feedbackScoreOf()` 给检索的「正反馈」项提供 0–1 分（0.5 为中性）。
 *   4. **群反馈不进主人记忆**：本模块只写 `expression.sqlite`，没有任何记忆桥；返回结构里固定
 *      `memoryWritten: false`，群聊统计只留在图库里。
 *
 * 本模块不联网、不读图片；`library` 只在「纠正语义卡」时需要，且只用两个窄接口：
 *   getCard(assetId) → card | null
 *   upsertCard(assetId, card) → {ok}
 */
import { createHash, randomUUID } from 'node:crypto';

export const FEEDBACK_SIGNALS = Object.freeze(['praise', 'reject', 'correction', 'silence']);
export const WRITABLE_SIGNALS = Object.freeze(['praise', 'reject', 'correction']);

const NOTE_LIMIT = 240;
const PRAISE_GAIN = 0.25;
const REJECT_PENALTY = 0.4;
const CORRECTION_GAIN = 0.05;

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

/** 抑制键：`suppress:<scope>:<assetId>`。作用域在最前面，一眼能看出它不会跨会话生效。 */
export function suppressionKey(scope, assetId) {
  return `suppress:${String(scope)}:${String(assetId)}`;
}

/** 该素材在该作用域下是否被 reject 抑制（读 preferences，不看内存）。 */
export function isSuppressed({ db, scope, assetId } = {}) {
  if (!db || typeof db.get !== 'function') return false;
  const scopeText = String(scope ?? '').trim();
  const id = String(assetId ?? '').trim();
  if (!scopeText || !id) return false;
  try {
    return db.get('SELECT value FROM preferences WHERE key = ?', [suppressionKey(scopeText, id)]) !== null;
  } catch {
    return false;
  }
}

/** 读反馈行。`scope` 为空表示看该素材的全部反馈（Studio 统计口径）。 */
export function feedbackRows({ db, assetId, scope = '' } = {}) {
  if (!db || typeof db.all !== 'function') return [];
  const id = String(assetId ?? '').trim();
  if (!id) return [];
  const scopeText = String(scope ?? '').trim();
  const sql = scopeText
    ? 'SELECT signal, confidence, note, at FROM expression_feedback WHERE asset_id = ? AND scope = ?'
    : 'SELECT signal, confidence, note, at FROM expression_feedback WHERE asset_id = ?';
  try {
    return db.all(sql, scopeText ? [id, scopeText] : [id]);
  } catch {
    return [];
  }
}

/** 取某条具体信号的最近一行（Studio/测试用）。没有就返回 null。 */
export function feedbackRowOf({ db, assetId, scope = '', signal = '' } = {}) {
  const rows = feedbackRows({ db, assetId, scope });
  const wanted = String(signal ?? '');
  const matched = rows.filter(row => String(row?.signal ?? '') === wanted);
  if (matched.length === 0) return null;
  return matched.reduce((newest, row) => (Number(row?.at ?? 0) >= Number(newest?.at ?? 0) ? row : newest), matched[0]);
}

/** 统计口径：三条显式信号的次数 + 最近一次时间 + 是否被抑制。 */
export function feedbackSummary({ db, assetId, scope = '' } = {}) {
  const rows = feedbackRows({ db, assetId, scope });
  const counts = { praise: 0, reject: 0, correction: 0, other: 0 };
  let lastAt = 0;
  for (const row of rows) {
    const signal = String(row?.signal ?? '');
    if (signal === 'praise' || signal === 'reject' || signal === 'correction') counts[signal] += 1;
    else counts.other += 1;
    lastAt = Math.max(lastAt, Number(row?.at ?? 0));
  }
  return {
    ...counts,
    total: rows.length,
    rejected: counts.reject > 0,
    suppressed: isSuppressed({ db, scope, assetId }),
    lastAt,
  };
}

/** 0–1 的正反馈分。0.5 中性；一次 praise +0.25，一次 reject -0.4，一次 correction +0.05。 */
export function feedbackScoreOf({ db, assetId, scope = '' } = {}) {
  const summary = feedbackSummary({ db, assetId, scope });
  const delta = PRAISE_GAIN * summary.praise - REJECT_PENALTY * summary.reject + CORRECTION_GAIN * summary.correction;
  return clamp01(0.5 + delta);
}

function writePreference(db, key, value, at) {
  db.run(
    `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [String(key), String(value), Number(at)],
  );
}

function refusal(reasonCode, message) {
  return { ok: false, recorded: false, reasonCode, memoryWritten: false, message };
}

function silenceReply() {
  return {
    ok: true, recorded: false, reasonCode: 'silence-not-negative', memoryWritten: false,
    message: '沉默不算负反馈：没有写入任何反馈，也没有降权。',
  };
}

/**
 * 反馈 id。**必须带随机量**：只按 (signal, at, seq) 派生时，两个写入器在同一毫秒记同一种
 * 反馈会撞主键，第二条被静默丢掉。id 不是可复算的语义值，所以随机更好。
 */
function nextFeedbackId(signal, at, seq) {
  const random = typeof randomUUID === 'function' ? randomUUID().slice(0, 12) : String(Math.random()).slice(2, 14);
  return `fb_${createHash('sha256').update(`${signal}|${at}|${seq}|${random}`).digest('hex').slice(0, 20)}`;
}

/** 落一行反馈；reject 同时落抑制键。两步同事务：要么都生效，要么都不生效。 */
function writeFeedbackRow({ db, seq, signal, assetId, planId, scope, note, confidence, at }) {
  return db.tx(() => {
    seq.value += 1;
    const rowId = nextFeedbackId(signal, at, seq.value);
    db.run(
      `INSERT INTO expression_feedback (id, asset_id, plan_id, scope, signal, confidence, note, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [rowId, assetId || null, planId === null ? null : String(planId), scope, signal,
        clamp01(confidence), String(note ?? '').slice(0, NOTE_LIMIT), at],
    );
    // reject 立刻抑制：下一轮检索/决策读 preferences，不需要等任何学习任务。
    if (signal === 'reject' && assetId) writePreference(db, suppressionKey(scope, assetId), '1', at);
    return rowId;
  });
}

/** 纠正语义卡：只改给出的字段，其余保持；失败只记 false，不影响反馈行本身。 */
function applyCardPatch(library, assetId, patch) {
  try {
    const current = library.getCard(assetId);
    if (!current) return false;
    const merged = { ...current, ...patch, assetId: String(assetId) };
    const result = library.upsertCard(assetId, merged);
    return result?.ok !== false;
  } catch {
    return false;
  }
}

/**
 * 记一条显式反馈（模块级实现，由 `createFeedback` 绑上下文后调用）。
 * @returns {{ok: boolean, recorded: boolean, reasonCode: string, message: string, memoryWritten: false}}
 */
function recordFeedback(ctx, { action, assetId = null, scope = '', planId = null, note = '', confidence = 1, cardPatch = null } = {}) {
  const signal = String(action ?? '').trim();
  if (signal === 'silence') return silenceReply();
  if (!WRITABLE_SIGNALS.includes(signal)) {
    return refusal('signal-unknown', `未知反馈信号：${signal || '(空)'}；只接受 praise / reject / correction。`);
  }
  const scopeText = String(scope ?? '').trim();
  if (!scopeText) return refusal('scope-missing', '反馈必须带作用域：群反馈也只能留在这个群里。');
  const id = String(assetId ?? '').trim();
  const at = ctx.clock();
  let feedbackId;
  try {
    feedbackId = writeFeedbackRow({
      db: ctx.db, seq: ctx.seq, signal, assetId: id, planId, scope: scopeText, note, confidence, at,
    });
  } catch (error) {
    return refusal('feedback-write-failed', `写入反馈失败：${String(error?.message ?? error).slice(0, 160)}`);
  }
  const cardUpdated = signal === 'correction' && cardPatch && ctx.library
    ? applyCardPatch(ctx.library, id, cardPatch)
    : false;
  return {
    ok: true, recorded: true, id: feedbackId, action: signal, scope: scopeText,
    assetId: id || null, suppressed: signal === 'reject' && Boolean(id), cardUpdated, memoryWritten: false,
    message: signal === 'reject' ? '已记负反馈，并立即抑制这张图在本会话的重发。' : '已记录反馈。',
  };
}

/** 解除抑制（Studio 的「恢复可用」）。 */
function clearFeedbackSuppression(ctx, { scope = '', assetId = '' } = {}) {
  const scopeText = String(scope ?? '').trim();
  const id = String(assetId ?? '').trim();
  if (!scopeText || !id) return { ok: false, reasonCode: 'scope-missing', message: '解除抑制需要作用域和 assetId。' };
  try {
    ctx.db.run('DELETE FROM preferences WHERE key = ?', [suppressionKey(scopeText, id)]);
    return { ok: true, scope: scopeText, assetId: id, cleared: true };
  } catch (error) {
    return { ok: false, reasonCode: 'preference-write-failed', message: String(error?.message ?? error).slice(0, 160) };
  }
}

/**
 * 反馈写入器。只做上下文绑定，行为都在上面的模块级函数里（单函数 ≤60 行）。
 * @param {{db: object, library?: object|null, config?: object, now?: () => number}} options
 */
export function createFeedback({ db, library = null, config = {}, now = () => Date.now() } = {}) {
  if (!db || typeof db.run !== 'function') throw new Error('createFeedback 需要数据库句柄。');
  void config;
  const ctx = { db, library, seq: { value: 0 }, clock: () => Number(now()) || Date.now() };
  return {
    record: input => recordFeedback(ctx, input),
    clearSuppression: input => clearFeedbackSuppression(ctx, input),
    clock: ctx.clock,
  };
}

export default {
  FEEDBACK_SIGNALS, WRITABLE_SIGNALS, suppressionKey, isSuppressed,
  feedbackRows, feedbackRowOf, feedbackSummary, feedbackScoreOf, createFeedback,
};
