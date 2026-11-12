/**
 * 真实投递（E2）。设计文档 §3 / §6.3 / §12「群图出站」逐条落地。
 *
 * 两阶段，顺序不可调换：
 *   **A. 准备（prepare）**——在任何一次发送之前完成：
 *     1. 计划形状与过期时间；
 *     2. 二次校验：作用域硬门 → 实体文件存在 → sha256 相符 → 冷却 / 小时配额 / 重复窗口；
 *     3. stage 到 `home/media/expression-out/`（群守卫只放行 `home/media` 下的绝对路径，所以素材
 *        必须真的落到那里，而不是放宽守卫）；`resolveStageRoot()` 保证配置越界时回退默认。
 *     准备阶段任何一步失败 → **整轮退化为纯文字**（`failClosed` + `fallbackToText`），原因码记下来；
 *     不二次选图、不半截发送。
 *   **B. 执行（execute）**——按 part 顺序调注入的 `qqSender`：
 *     每 part 有幂等键（`sha256(planId:index)`），已落终态的不再发；`unknown` 不重试且**停止后续
 *     part**（顺序错了比少发一段更糟）；回执逐行落 `deliveries`。
 *
 * 本模块不 import 任何 QQ 代码、不自己发请求；`qqSender` 由 index.mjs 注入（内部调既有
 * `qq_sticker` 执行器）。测试用假 sender 与内存库。
 *
 * ── 注入的窄接口 ─────────────────────────────────────────────────────────────
 * library.getFileForDelivery({assetId, usable, verifyHash:true})
 *   → {ok:true, path, sha256, mime, kind, scope} | {ok:false, reasonCode, message}
 * qqSender.sendText({kind, target, text, idempotencyKey})   → {ok, messageId?, status?} | {ok:false, code, message}
 * qqSender.sendSticker({kind, target, file, assetId, idempotencyKey}) → 同上
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { inside, resolveStageRoot } from './paths.mjs';
import { consumeDeliveryQuota, limitsFrom, quotaState, repeatedAsset } from './decision.mjs';
import { isExpired, partJobs, validatePlan } from './planner.mjs';

/** `deliveries.status` 的取值。`unknown` 与 `failed` 都不重试。 */
export const DELIVERY_STATES = Object.freeze(['sent', 'confirmed', 'unknown', 'failed', 'skipped']);
/** stage 文件名前缀：群守卫与 TTL 清理都认这个前缀。 */
export const STAGE_PREFIX = 'expression-';

export function extensionForKind(kind, mime = '') {
  const text = String(kind).toLowerCase();
  if (text === 'gif' || String(mime).includes('gif')) return '.gif';
  if (text === 'webp' || String(mime).includes('webp')) return '.webp';
  if (text === 'jpeg' || text === 'jpg' || String(mime).includes('jpeg')) return '.jpg';
  if (text === 'png' || String(mime).includes('png')) return '.png';
  return '.bin';
}

/**
 * 一次 sender 结果 → 四态之一。
 *
 * **没有回执就是 `unknown`，不是 `sent`**（docs/11 P2 第 10 条）：聊天平台只有在返回
 * `message_id` 时才算"真的发出去了"。`ok:true` 但没有 id 的返回值什么也证明不了——
 * 它可能是 NapCat 吞掉了响应，也可能是对面根本没收到。把它记成 `sent` 会让「发过没有」
 * 永远说不清，也会让配额与重复窗口按一次并不存在的发送来算。
 *
 * `unknown` 与 `failed` 都是终态且**不重试**：顺序错乱比少发一段更糟。
 */
export function statusOf(result) {
  if (!result || result.ok !== true) return String(result?.code ?? '') === 'unknown' ? 'unknown' : 'failed';
  if ((typeof result.messageId === 'number' || typeof result.messageId === 'string')
    && String(result.messageId).trim() !== '' && Number.isSafeInteger(Number(result.messageId))
    && Number(result.messageId) !== 0) return 'confirmed';
  // 显式说了别的状态就照它（sender 可能报告 `failed` 之下的细分成因）；否则一律 unknown。
  const declared = String(result.status ?? '');
  return declared === 'failed' || declared === 'unknown' ? declared : 'unknown';
}

export function sha256File(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** 该 part 是否已落终态（判重靠这一列；`skipped` 允许重来）。 */
export function alreadyDelivered({ db, idempotencyKey } = {}) {
  try {
    const row = db.get('SELECT status FROM deliveries WHERE idempotency_key = ?', [String(idempotencyKey)]);
    const status = String(row?.status ?? '');
    return DELIVERY_STATES.includes(status) && status !== 'skipped';
  } catch {
    return false;
  }
}

export function recordDelivery({ db, plan, part, status, providerMessageId = null, reasonCode = '', now = Date.now() }) {
  try {
    db.run(
      `INSERT INTO deliveries (plan_id, part_index, asset_id, scope, status, idempotency_key, provider_message_id, reason_code, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET
           status = excluded.status, provider_message_id = excluded.provider_message_id,
           reason_code = excluded.reason_code, at = excluded.at`,
      [String(plan?.planId ?? ''), Number(part?.index ?? 0), part?.assetId ?? null,
        String(plan?.scope ?? ''), String(status), String(part?.idempotencyKey ?? ''),
        providerMessageId === null ? null : String(providerMessageId), String(reasonCode).slice(0, 120), Number(now)],
    );
    return { ok: true, status };
  } catch (error) {
    return { ok: false, reasonCode: 'delivery-record-failed', message: String(error?.message ?? error).slice(0, 160) };
  }
}

/**
 * stage 一份素材：读字节 → 校验 sha256 → 临时文件 → rename。返回路径必在 `home/media` 内。
 * @returns {{ok:true, path:string, stageRoot:string}|{ok:false, reasonCode:string, message:string}}
 */
export function stageAsset({ dataRoot, configured = null, sourcePath, assetId, sha256 = null, kind = '', mime = '' } = {}) {
  // `resolveStageRoot()` 的契约：配置越界时它**返回默认目录并置 ok:false**（越界配置不被采纳，
  // 但也不会因此让整轮投递失败——默认目录本来就是 home/media 内合法的那一个）。所以这里先取它
  // 给的 path，再独立地确认这个 path 真的在 home/media 内；不在才 fail closed。
  const resolved = resolveStageRoot(dataRoot, configured);
  const mediaRoot = path.join(path.resolve(dataRoot), 'home', 'media');
  if (!inside(mediaRoot, resolved.path)) {
    return { ok: false, reasonCode: 'stage-root-outside-home-media', message: 'stage 目录不在 home/media 内，已拒绝投递。' };
  }
  let bytes;
  try {
    bytes = fs.readFileSync(String(sourcePath));
  } catch (error) {
    return { ok: false, reasonCode: 'file-missing', message: `素材文件读不到（${String(error?.code ?? error)}）。` };
  }
  if (sha256) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== String(sha256)) return { ok: false, reasonCode: 'hash-mismatch', message: '素材内容与记录不符，已拒绝投递。' };
  }
  const name = `${STAGE_PREFIX}${String(assetId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}-${randomUUID().slice(0, 8)}${extensionForKind(kind, mime)}`;
  const target = path.join(resolved.path, name);
  const temp = path.join(resolved.path, `.${name}.tmp`);
  try {
    fs.mkdirSync(resolved.path, { recursive: true });
    fs.writeFileSync(temp, bytes);
    if (!inside(mediaRoot, target) || !inside(mediaRoot, temp)) throw new Error('目标越界');
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    return { ok: false, reasonCode: 'stage-write-failed', message: String(error?.message ?? error).slice(0, 160) };
  }
  return { ok: true, path: target, stageRoot: resolved.path, bytes: bytes.length };
}

/** 清理过期 stage 产物：只删本前缀文件，不扫别的目录。 */
export function cleanStage({ stageRoot, ttlMs = 600_000, now = Date.now() } = {}) {
  const removed = [];
  try {
    for (const name of fs.readdirSync(String(stageRoot))) {
      if (!name.startsWith(STAGE_PREFIX)) continue;
      const file = path.join(String(stageRoot), name);
      try {
        if (Number(now) - fs.statSync(file).mtimeMs >= Number(ttlMs)) { fs.rmSync(file, { force: true }); removed.push(name); }
      } catch { /* 单个文件失败不影响其它 */ }
    }
  } catch { /* 目录不存在 = 没有可清的 */ }
  return { ok: true, removed };
}

/** 一个 sticker part 的全部前置校验；任何一项不过，整轮退化成纯文字。 */
function precheckSticker({ library, part, usable, kind, limits, db, bucketKey, now, dataRoot, configured }) {
  let granted;
  try {
    granted = library.getFileForDelivery({ assetId: part.assetId, usable, verifyHash: true });
  } catch (error) {
    return { ok: false, reasonCode: 'library-unavailable', message: String(error?.message ?? error).slice(0, 160) };
  }
  if (!granted?.ok) return { ok: false, reasonCode: String(granted?.reasonCode ?? 'gate-denied'), message: String(granted?.message ?? '作用域硬门拒绝。') };
  const repeated = repeatedAsset({ db, bucketKey, assetId: part.assetId, kind, limits, now });
  if (repeated.repeated) return { ok: false, reasonCode: 'repeat-window', message: `同一张图 ${repeated.hours}h 内已发过。` };
  const staged = stageAsset({
    dataRoot, configured, sourcePath: granted.path, assetId: part.assetId,
    sha256: granted.sha256, kind: granted.kind ?? '', mime: granted.mime ?? '',
  });
  if (!staged.ok) return staged;
  return { ok: true, file: staged.path, assetId: part.assetId };
}

/**
 * 准备阶段：把所有 sticker 先 stage 好；失败就整轮退化纯文字（不半截发）。
 * @returns {{ok:true, mode, parts, prepared: object[], degraded: boolean, reasonCode: string}
 *   | {ok:false, reasonCode: string, message: string}}
 */
export function prepare({ plan, library, db, config = {}, dataRoot, scope = '', bucketKey = null, kind = 'dm', usable = [], now = Date.now() } = {}) {
  const checked = validatePlan(plan);
  if (!checked.ok) return { ok: false, reasonCode: checked.reasonCode, message: checked.message };
  if (isExpired(plan, now)) return { ok: false, reasonCode: 'plan-expired', message: '计划已过期，整轮不投递。' };
  const limits = limitsFrom(config);
  if (limits.enabled !== true) return { ok: false, reasonCode: 'delivery-disabled', message: 'delivery.enabled 为 false：不会真发图。' };
  const key = bucketKey ?? plan.bucketKey ?? '';
  const quota = quotaState({ db, bucketKey: key, kind, limits, now });
  if (quota.cooling) return { ok: false, reasonCode: 'cooldown', message: `冷却中：还需 ${Math.ceil(quota.cooldownRemainingMs / 1000)} 秒。` };
  if (quota.hourlyFull) return { ok: false, reasonCode: 'hourly-quota', message: `本小时已达上限 ${quota.limit}。` };

  const jobs = partJobs(plan);
  const stickerJobs = jobs.filter(job => job.kind === 'sticker');
  if (stickerJobs.length === 0) {
    return { ok: true, mode: plan.mode, parts: jobs.map(job => ({ ...job })), prepared: [], degraded: false, reasonCode: String(plan.reasonCode ?? '') };
  }
  const prepared = [];
  for (const job of stickerJobs) {
    const checkedSticker = precheckSticker({ library, part: job, usable, kind, limits, db, bucketKey: key, now, dataRoot, configured: config?.delivery?.stageRoot });
    if (!checkedSticker.ok) {
      // failClosed：丢掉所有 sticker part，只保留文字；计划在发送前就已退化。
      const textParts = jobs.filter(item => item.kind === 'text').map(item => ({ ...item }));
      return {
        ok: true,
        mode: textParts.length ? 'text_only' : 'silent',
        parts: textParts,
        prepared: [],
        degraded: true,
        reasonCode: checkedSticker.reasonCode,
        message: checkedSticker.message,
      };
    }
    prepared.push(checkedSticker);
  }
  return {
    ok: true, mode: plan.mode, parts: jobs.map(job => ({ ...job })),
    prepared, degraded: false, reasonCode: String(plan.reasonCode ?? ''),
  };
}

/** 执行阶段：顺序发送，幂等判重，unknown 停止后续 part。 */
export async function execute({ plan, preparedPlan, db, qqSender, now = Date.now(), kind = 'dm', target = {} } = {}) {
  const parts = Array.isArray(preparedPlan?.parts) ? preparedPlan.parts : [];
  const planId = String(plan?.planId ?? '');
  const scope = String(plan?.scope ?? '');
  const results = [];
  let delivered = 0;
  let halted = '';
  for (const part of parts) {
    const base = { index: part.index, kind: part.kind, idempotencyKey: part.idempotencyKey };
    if (halted) {
      recordDelivery({ db, plan: { ...plan, scope }, part, status: 'skipped', reasonCode: `halted-after-${halted}`, now });
      results.push({ ...base, status: 'skipped', reasonCode: `halted-after-${halted}` });
      continue;
    }
    if (alreadyDelivered({ db, idempotencyKey: part.idempotencyKey })) {
      results.push({ ...base, status: 'skipped', reasonCode: 'already-delivered' });
      continue;
    }
    let outcome;
    if (part.kind === 'text') {
      outcome = await sendText({ qqSender, target, kind, part });
    } else {
      const match = (preparedPlan.prepared ?? []).find(row => row.assetId === part.assetId);
      if (!match) {
        recordDelivery({ db, plan: { ...plan, scope }, part, status: 'skipped', reasonCode: 'no-staged-file', now });
        results.push({ ...base, status: 'skipped', reasonCode: 'no-staged-file' });
        continue;
      }
      outcome = await sendSticker({ qqSender, target, kind, part, file: match.file });
    }
    const status = statusOf(outcome);
    recordDelivery({
      db, plan: { ...plan, scope }, part, status,
      providerMessageId: outcome?.messageId ?? null,
      reasonCode: outcome?.ok === true ? '' : String(outcome?.code ?? 'send-failed'), now,
    });
    if (status === 'sent' || status === 'confirmed') delivered += 1;
    if (part.kind === 'sticker' && (status === 'sent' || status === 'confirmed')) {
      try { consumeDeliveryQuota({ db, bucketKey: plan?.bucketKey ?? '', now }); } catch { /* 配额记录失败不影响已发出的图 */ }
    }
    results.push({ ...base, status, reasonCode: outcome?.ok === true ? '' : String(outcome?.code ?? 'send-failed'), messageId: outcome?.messageId ?? null });
    // 任何失败都停止后续 part：unknown 绝不能重投；文字没发出去时再单发一张图同样会让对话错位。
    if (status === 'unknown') halted = 'unknown';
    else if (status === 'failed') halted = 'failed';
  }
  const failed = results.filter(row => row.status === 'failed' || row.status === 'unknown');
  return {
    ok: failed.length === 0,
    planId, mode: preparedPlan?.mode ?? 'silent', results,
    delivered, status: failed.length ? (failed.some(row => row.status === 'unknown') ? 'unknown' : 'failed') : (delivered > 0 ? 'sent' : 'skipped'),
    reasonCode: failed[0]?.reasonCode ?? (preparedPlan?.degraded ? preparedPlan.reasonCode : ''),
  };
}

async function sendText({ qqSender, target, kind, part = {} }) {
  if (!qqSender || typeof qqSender.sendText !== 'function') return { ok: false, code: 'sender-unavailable', message: '没有注入文本发送器。' };
  try {
    return await qqSender.sendText({ kind, target, text: String(part.content ?? ''), idempotencyKey: part.idempotencyKey });
  } catch (error) {
    return { ok: false, code: 'sender-threw', message: String(error?.message ?? error).slice(0, 160) };
  }
}

async function sendSticker({ qqSender, target, kind, part = {}, file }) {
  if (!qqSender || typeof qqSender.sendSticker !== 'function') return { ok: false, code: 'sender-unavailable', message: '没有注入图片发送器。' };
  try {
    return await qqSender.sendSticker({ kind, target, file, assetId: String(part.assetId), idempotencyKey: part.idempotencyKey });
  } catch (error) {
    return { ok: false, code: 'sender-threw', message: String(error?.message ?? error).slice(0, 160) };
  }
}

/**
 * 一条龙：准备 → 执行。**永不抛**。
 * @returns {{ok:boolean, mode:string, degraded:boolean, reasonCode:string, results:object[], delivered:number,
 *   status:string, warnings:string[]}}
 */
export async function deliver({
  plan, library, db, config = {}, dataRoot, qqSender, scope = '', usable = [],
  bucketKey = null, kind = 'dm', target = {}, now = Date.now(),
} = {}) {
  const warnings = [];
  const prepared = prepare({ plan, library, db, config, dataRoot, scope, bucketKey, kind, usable, now });
  if (!prepared.ok) {
    return { ok: false, mode: 'silent', degraded: true, reasonCode: prepared.reasonCode, results: [], delivered: 0, status: 'skipped', warnings: [prepared.message] };
  }
  if (prepared.degraded) warnings.push(`已退化为纯文字（${prepared.reasonCode}）：${prepared.message ?? ''}`);
  if (prepared.parts.length === 0) {
    return { ok: true, mode: 'silent', degraded: prepared.degraded, reasonCode: prepared.reasonCode, results: [], delivered: 0, status: 'skipped', warnings };
  }
  const executed = await execute({ plan, preparedPlan: prepared, db, qqSender, now, kind, target });
  return {
    ok: executed.ok,
    mode: prepared.mode,
    degraded: prepared.degraded,
    reasonCode: executed.reasonCode,
    results: executed.results,
    delivered: executed.delivered,
    status: executed.status,
    warnings,
  };
}

export default {
  DELIVERY_STATES, STAGE_PREFIX, extensionForKind, statusOf, sha256File, alreadyDelivered,
  recordDelivery, stageAsset, cleanStage, prepare, execute, deliver,
};
