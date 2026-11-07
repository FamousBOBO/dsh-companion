/**
 * 被动收集的整条流水线：授权 → 限流 → 下载 → 校验 → 私图门控 → 入库 → 入队。
 *
 * 顺序和「0 下载、0 视觉调用」是硬要求，不是实现细节（AGENTS.md 硬规则 3 与设计文档 §4）：
 *   1. **先判授权**：`scopesFor()` 说不能收，就直接落一条 `ingest_jobs` 拒绝记录并返回，
 *      `http` 与 `vision` 一次都不碰。测试用假 http/假 vision 计数证明这一点。
 *   2. **再判限流**：`quotas` 表按作用域 + 小时桶累加，超了就拒绝；限流在下载之前做，
 *      所以被限的素材同样不产生任何网络请求。
 *   3. **下载只用注入的 http**：本模块从不自己 new fetch，测试里绝不真发请求。
 *   4. **校验在落盘之前**：字节判型、体积、像素上限都由 security.mjs 负责。
 *   5. **私图先门控再分析**：照片/截图进隔离区且**不送视觉模型**；判不准的按
 *      `capture.uncertain` 走 review 或 quarantine。
 *   6. **幂等靠 source_key**：同一条消息的同一张图重复投递只处理一次（UNIQUE 约束）。
 */
import { createHash } from 'node:crypto';

import { QUARANTINE, scopesFor } from './scopes.mjs';
import { validateImage, DEFAULT_MAX_BYTES } from './security.mjs';
import { analyze } from './analyzer.mjs';

/** `ingest_jobs.state` 的取值。 */
export const JOB_STATES = Object.freeze(['pending', 'done', 'skipped', 'quota', 'failed']);

const HOUR_MS = 3_600_000;

/** 小时桶：限流按自然小时对齐，不使用滑动窗口（实现简单、结果可解释）。 */
export function hourSlot(nowMs) {
  return `h${Math.floor(Number(nowMs) / HOUR_MS)}`;
}

/** 幂等键：同一作用域 + 同一消息 + 同一 URL 只收一次。哈希里不含任何原文。 */
export function sourceKeyFor({ scope, messageHash, url }) {
  return createHash('sha256')
    .update(`${String(scope)}|${String(messageHash ?? '')}|${String(url ?? '')}`)
    .digest('hex')
    .slice(0, 40);
}

function refusal(id, reasonCode, message, extra = {}) {
  return { ok: false, jobId: id, reasonCode, message, downloads: 0, visionCalls: 0, ...extra };
}

/**
 * 创建收集管道。
 *
 * @param {{
 *   db: object, library: object, config: object,
 *   http: {get: Function}, vision?: Function|null,
 *   now?: () => number
 * }} options
 */
export function createIngest({ db, library, config, http, vision = null, now = () => Date.now() } = {}) {
  if (!db || typeof db.tx !== 'function') throw new Error('createIngest 需要数据库句柄。');
  if (!library || typeof library.receive !== 'function') throw new Error('createIngest 需要图库句柄。');
  if (!http || typeof http.get !== 'function') throw new Error('createIngest 需要注入的 http（本模块从不自己发请求）。');
  const clock = () => Number(now()) || Date.now();

  /**
   * 占位一条 job。
   *
   * 幂等口径：只有 `done` 才算「已收过」，不再下载。`skipped`/`quota`/`failed` 允许下次重来
   * ——授权可能是后来才给的、配额是每小时刷新、网络失败更该重试；把一次失败永久钉死在这条
   * 消息上才是错的。`attempts` 记录真实尝试次数。
   *
   * @returns {{id: string, duplicate: boolean, state: string}}
   */
  function beginJob(sourceKey) {
    const at = clock();
    const fallbackId = `job_${sourceKey.slice(0, 16)}`;
    const result = db.run(
      `INSERT INTO ingest_jobs (id, asset_id, source_key, state, attempts, next_try_at, last_error, created_at, updated_at)
         VALUES (?, NULL, ?, 'pending', 0, NULL, NULL, ?, ?)
         ON CONFLICT(source_key) DO NOTHING`,
      [fallbackId, sourceKey, at, at],
    );
    const existing = db.get('SELECT id, state FROM ingest_jobs WHERE source_key = ?', [sourceKey]);
    if (Number(result?.changes ?? 0) === 0 && existing) {
      if (String(existing.state) === 'done') return { id: String(existing.id), duplicate: true, state: 'done' };
      db.run("UPDATE ingest_jobs SET state = 'pending', attempts = attempts + 1, updated_at = ? WHERE id = ?", [at, String(existing.id)]);
      return { id: String(existing.id), duplicate: false, state: 'pending' };
    }
    return { id: String(existing?.id ?? fallbackId), duplicate: false, state: 'pending' };
  }

  function finishJob(jobId, state, { assetId = null, error = '' } = {}) {
    if (!JOB_STATES.includes(state)) throw new Error(`未知 job 状态：${state}`);
    if (!jobId) return;
    db.run(
      `UPDATE ingest_jobs SET state = ?, asset_id = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      [state, assetId, String(error).slice(0, 300), clock(), String(jobId)],
    );
  }

  /**
   * 占一个配额。上限 0 表示明确关闭收集，不是「不限」。
   * @returns {{ok: boolean, used: number, limit: number, reasonCode: string, message: string}}
   */
  function consumeQuota({ bucket, limit, slot = hourSlot(clock()) }) {
    const cap = Number(limit);
    if (!Number.isFinite(cap) || cap <= 0) {
      return { ok: false, used: 0, limit: 0, reasonCode: 'quota-off', message: '本来源的每小时配额为 0，收集已关闭。' };
    }
    const row = db.get('SELECT used FROM quotas WHERE bucket = ? AND slot = ?', [String(bucket), String(slot)]);
    const used = Number(row?.used ?? 0);
    if (used >= cap) return { ok: false, used, limit: cap, reasonCode: 'quota-exceeded', message: `本小时已收 ${used} 张，达到上限 ${cap}。` };
    db.run(
      `INSERT INTO quotas (bucket, slot, used) VALUES (?, ?, 1)
         ON CONFLICT(bucket, slot) DO UPDATE SET used = used + 1`,
      [String(bucket), String(slot)],
    );
    return { ok: true, used: used + 1, limit: cap, reasonCode: '', message: '' };
  }

  /** 下载：只走注入的 http；SecurityError 的 code 直接当 reasonCode，其它错误码也照抄（便于排障）。 */
  async function download(url, maxBytes) {
    try {
      const response = await http.get(url, { maxBytes });
      return { ok: true, response };
    } catch (error) {
      // 注入的 http 可能是 security.createGuardedHttp（抛 SecurityError），也可能是测试/其它
      // 实现（抛带 code 的普通 Error）。两者都照抄 code，不吞成笼统的 download-failed。
      const rawCode = typeof error?.code === 'string' ? error.code.trim() : '';
      const code = rawCode && rawCode.length <= 40 ? rawCode : 'download-failed';
      return { ok: false, reasonCode: code, message: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /**
   * 分析一步。隐私门控在 analyzer 内部是硬线（照片/截图即使开了 host-vision 也不送出去），
   * 这里只负责把上下文对齐。
   */
  function analyzeBytes(context, bytes, mime, checked) {
    return analyze({
      config,
      bytes,
      mime,
      literal: context.literal ?? '',
      hint: context.summaryHint ?? '',
      fileNameHint: context.fileNameHint ?? String(context.url ?? ''),
      summaryHint: context.summaryHint ?? '',
      subType: context.subType ?? '',
      width: checked.width,
      height: checked.height,
      animated: context.animated === true,
      vision,
    });
  }

  /**
   * 收一张图。
   *
   * @param {{
   *   kind: 'dm'|'group', chatId: number, isOwner?: boolean, salt: string,
   *   url: string, messageHash?: string, senderHash?: string, literal?: string,
   *   summaryHint?: string, fileNameHint?: string, subType?: string, animated?: boolean,
   *   autoApprove?: boolean
   * }} input
   * @returns {Promise<object>} 永远返回结构化结果，不抛
   */
  async function ingestOne(input = {}) {
    const salt = String(input.salt ?? '');
    // 盐缺失是装配错误，不是数据问题：仍然返回结构化结果，不往消息路径上抛异常。
    if (!salt) return refusal(null, 'salt-missing', '缺少作用域盐，本次收集被拒绝（未下载）。', { state: 'skipped' });
    const scopes = scopesFor({ kind: input.kind, chatId: input.chatId, isOwner: input.isOwner === true, salt, config });
    const sourceKey = sourceKeyFor({ scope: scopes.own, messageHash: input.messageHash, url: input.url });
    const started = beginJob(sourceKey);
    if (started.duplicate) {
      return {
        ok: true, jobId: started.id, duplicate: true, state: 'done',
        reasonCode: 'already-ingested',
        message: '这条消息的这张图已经收过，未重复下载。',
        downloads: 0, visionCalls: 0,
      };
    }

    // 1) 授权：未授权来源 0 下载、0 视觉调用。
    if (scopes.capture !== true) {
      finishJob(started.id, 'skipped', { error: `unauthorized:${scopes.reason}` });
      return refusal(started.id, 'unauthorized', `未授权收集（${scopes.reason || 'no-grant'}）：没有下载，也没有调用视觉模型。`, { state: 'skipped' });
    }

    // 2) 限流：同样在下载之前。
    const quota = consumeQuota({ bucket: scopes.own, limit: config?.capture?.maxPerHour });
    if (!quota.ok) {
      finishJob(started.id, quota.reasonCode === 'quota-off' ? 'skipped' : 'quota', { error: quota.reasonCode });
      return refusal(started.id, quota.reasonCode, quota.message, { state: quota.reasonCode === 'quota-off' ? 'skipped' : 'quota' });
    }

    // 3) 下载。
    const maxBytes = Number(config?.capture?.maxDownloadBytes ?? DEFAULT_MAX_BYTES);
    const fetched = await download(String(input.url ?? ''), maxBytes);
    if (!fetched.ok) {
      finishJob(started.id, 'failed', { error: fetched.reasonCode });
      return refusal(started.id, fetched.reasonCode, fetched.message, { state: 'failed' });
    }
    if (fetched.response.ok === false) {
      finishJob(started.id, 'failed', { error: `http-${fetched.response.status}` });
      return refusal(started.id, 'http-error', `对方返回 HTTP ${fetched.response.status}。`, { state: 'failed' });
    }

    // 4) 校验（体积 / 魔数 / 像素上限）。
    const checked = validateImage({ bytes: fetched.response.bytes, declaredMime: fetched.response.mime, maxBytes });
    if (!checked.ok) {
      finishJob(started.id, 'failed', { error: checked.reasonCode });
      return refusal(started.id, checked.reasonCode, checked.message, { state: 'failed' });
    }

    // 5) 隐私门控 + 分析（照片/截图不送视觉模型，见 analyzer.mjs 的隐私硬线）。
    const analysis = await analyzeBytes({ ...input, url: input.url }, fetched.response.bytes, fetched.response.mime, checked);
    const privacy = analysis.privacy;
    const quarantine = privacy.classification === 'photo' || privacy.classification === 'screenshot';
    const moderationState = quarantine ? 'quarantined' : analysis.moderation.moderation;
    const played = quarantine
      ? { moderation: 'quarantined', reasonCode: analysis.moderation.reasonCode || 'private-image-quarantined', message: analysis.moderation.message }
      : analysis.moderation;

    // 6) 入库：物理去重 + 来源行 + 可见性行（权限互不影响）。
    const received = library.receive({
      bytes: fetched.response.bytes, format: checked.format, width: checked.width,
      height: checked.height, moderationState,
    });
    if (!received.ok) {
      finishJob(started.id, 'failed', { error: received.reasonCode });
      return refusal(started.id, received.reasonCode, received.message, { state: 'failed' });
    }
    const approval = moderationState === 'quarantined' ? 'quarantined' : (input.autoApprove === true ? 'approved' : 'review');
    const visibility = moderationState === 'quarantined'
      ? [{ scope: QUARANTINE, approval: 'quarantined' }]
      : [{ scope: scopes.own, approval }];
    const registered = library.register({
      assetId: received.assetId,
      sources: [{ originScope: scopes.own, sourceMessageHash: input.messageHash, senderHash: input.senderHash, consentRef: scopes.own }],
      visibility,
    });
    if (registered.ok === false) {
      // 文件已经落盘但权限没写进去：宁可记失败，也不能让一条「没有来源」的素材留在库里。
      finishJob(started.id, 'failed', { error: registered.reasonCode });
      return refusal(started.id, registered.reasonCode, registered.message, { state: 'failed' });
    }
    library.upsertCard(received.assetId, analysis.card);

    finishJob(started.id, 'done', { assetId: received.assetId });
    return {
      ok: true,
      jobId: started.id,
      assetId: received.assetId,
      deduped: received.deduped,
      moderationState,
      approval,
      reasonCode: played.reasonCode ?? '',
      message: played.reasonCode ? `已入库，${analysis.moderation.message}` : '已入库，等待审核。',
      privacy,
      modeUsed: analysis.modeUsed,
      visionReasonCode: analysis.reasonCode,
      confidence: analysis.card.confidence,
      warnings: analysis.warnings,
      downloads: 1,
      visionCalls: analysis.modeUsed === 'host-vision' ? 1 : 0,
    };
  }

  /** 查询某作用域本小时的用量（Studio 用）。 */
  function quotaStatus(scope, slot = hourSlot(clock())) {
    const row = db.get('SELECT used FROM quotas WHERE bucket = ? AND slot = ?', [String(scope), String(slot)]);
    return { scope: String(scope), slot, used: Number(row?.used ?? 0), limit: Number(config?.capture?.maxPerHour ?? 0) };
  }

  /** 失败的 job 可以重试：把 state 退回 pending 并清 last_error。 */
  function retryJob(jobId) {
    const row = db.get('SELECT * FROM ingest_jobs WHERE id = ?', [String(jobId)]);
    if (!row) return { ok: false, reasonCode: 'job-missing', message: '任务不存在。' };
    if (String(row.state) !== 'failed') return { ok: false, reasonCode: 'not-failed', message: '只有失败的任务可以重试。' };
    db.run("UPDATE ingest_jobs SET state = 'pending', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?", [clock(), String(jobId)]);
    return { ok: true, jobId: String(jobId) };
  }

  return { ingestOne, consumeQuota, quotaStatus, retryJob, hourSlot, sourceKeyFor };
}

export default { createIngest, JOB_STATES, hourSlot, sourceKeyFor };
