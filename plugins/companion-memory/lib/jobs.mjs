// Extraction queue worker for the companion memory engine (CONTRACT.md §11).
//
// One job = one batch of already captured messages. The flow is:
//
//   claimOwnJob('extract') -> load the job's source events -> extract.extractBatch
//   (prompt + model + parse + gate) -> mergeDecision per candidate
//   -> insertMemory / updateMemory / rememberFact -> addEvidence
//   -> completeJob(cursor)
//
// Rules that keep this safe:
//   - `lib/extract.mjs` is imported lazily so capture/index can load this module
//     without paying for the prompt machinery (and without a cycle).
//   - The model is injected. A missing or failing model is a *job* failure, not
//     a caller failure: the raw text and the cursor stay in the database, the
//     job backs off and can be retried. Disabled extraction completes empty so
//     the queue does not accumulate attempts.
//   - Every write path is guarded: one bad candidate must not lose the batch.
//   - Nothing is thrown to the caller, ever.
//
// The candidate shape comes from lib/validate.mjs (gateCandidate output,
// `normalized`). `decision='pending'` rows are stored with status 'pending' and
// the gate's flag codes as `reason:<code>` tags so the pending list can explain
// itself.

import { REAL_USER_SCOPES } from './policy.mjs';
import { isoNow, redactSecrets, truncate } from './text.mjs';
import { legacyStreamKeyFor, streamKeyFor } from './capture.mjs';

export const JOB_TYPE_EXTRACT = 'extract';
export const MERGE_ACTOR = 'capture/jobs';

const MAX_JOBS_PER_RUN = 20;
const MAX_BATCH_MESSAGES = 400;
const MAX_EVIDENCE_LINKS = 6;
const MAX_ERROR_CHARS = 400;
const MAX_ERRORS = 8;
const FALLBACK_MAX_MESSAGES = 40;

// A model that answered with prose instead of JSON is worth a retry (the raw
// text stays in source_events). A valid `[]` is NOT a failure: it means "nothing
// to remember" and completes normally.
const UNPARSEABLE_OUTPUT = /无法从模型输出中解析|结构里没有候选数组|根节点不是候选数组/;

/** Only desktop conversation is extractable; imported evidence is already trusted differently. */
const CAPTURE_SOURCE_KIND = 'desktop_conversation';

// --- small helpers -----------------------------------------------------------

function text(value) {
  return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function clockMs(now) {
  if (typeof now === 'function') {
    const value = Number(now());
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }
  if (now instanceof Date) {
    const value = now.getTime();
    return Number.isFinite(value) ? value : Date.now();
  }
  const value = Number(now);
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

function errorText(error) {
  if (error instanceof Error) return error.message || error.name;
  return text(error) || '未知错误';
}

function safeError(error) {
  return truncate(redactSecrets(errorText(error)), MAX_ERROR_CHARS);
}

function noteError(result, error) {
  if (result.errors.length >= MAX_ERRORS) return;
  result.errors.push(safeError(error));
}

function newResult(job) {
  return {
    jobId: job?.jobId ?? '',
    streamKey: job?.streamKey ?? '',
    outcome: 'done',
    candidates: 0,
    accepted: 0,
    pending: 0,
    rejected: 0,
    inserted: 0,
    updated: 0,
    superseded: 0,
    duplicated: 0,
    conflicts: 0,
    evidence: 0,
    // A failed batch is never re-queued automatically (its raw text and payload
    // stay in the database); the flag documents that for the operator.
    requeued: false,
    errors: [],
  };
}

// --- lazy pipeline -----------------------------------------------------------

let pipelinePromise = null;

/**
 * Resolve the extraction API once. `mergeDecision` lives in validate.mjs; the
 * contract lists it next to extract.mjs, so both locations are accepted.
 */
async function loadPipeline() {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    const extract = await import('./extract.mjs');
    const needsValidate = typeof extract.mergeDecision !== 'function'
      || typeof extract.gateCandidate !== 'function'
      || typeof extract.parseCandidate !== 'function';
    const validate = needsValidate ? await import('./validate.mjs') : extract;
    const pipeline = {
      extractBatch: extract.extractBatch,
      resolveExtractionConfig: extract.resolveExtractionConfig,
      mergeDecision: validate.mergeDecision,
      gateCandidate: validate.gateCandidate,
      parseCandidate: validate.parseCandidate,
    };
    for (const key of ['extractBatch', 'mergeDecision', 'gateCandidate', 'parseCandidate']) {
      if (typeof pipeline[key] !== 'function') {
        throw new Error(`抽取模块缺少 ${key}，作业已跳过`);
      }
    }
    return pipeline;
  })();
  try {
    return await pipelinePromise;
  } catch (error) {
    pipelinePromise = null; // allow a later retry after a transient import failure
    throw error;
  }
}

function resolveLimits(pipeline, config) {
  const raw = typeof pipeline?.resolveExtractionConfig === 'function'
    ? pipeline.resolveExtractionConfig(config ?? {})
    : (config?.extraction ?? config ?? {});
  const extraction = (config && config.extraction) || config || {};
  const minAcceptConfidence = Number(raw?.minAcceptConfidence);
  return {
    enabled: raw?.enabled === undefined ? true : Boolean(raw.enabled),
    minAcceptConfidence: Number.isFinite(minAcceptConfidence) ? minAcceptConfidence : 0.5,
    // `maxMessages` is a capture concern, not part of the extraction defaults.
    maxMessages: clampInt(extraction?.maxMessages, 1, MAX_BATCH_MESSAGES, FALLBACK_MAX_MESSAGES),
  };
}

// --- batch loading -----------------------------------------------------------

/**
 * Evidence rows for one job. The preferred path is the explicit `sourceIds`
 * list written by capture.noteCaptureBatch; a cursor window is supported for
 * jobs enqueued by other tools.
 *
 * Ownership (user/persona/world) and origin (`desktop_conversation` +
 * user/assistant) are both re-checked here: a mis-queued job must never mix
 * identities, and imported/manual/system evidence must never be re-extracted as
 * if it were the user's own words (P1-1).
 *
 * Storage failures are *not* swallowed: a thrown db error propagates so the job
 * fails and keeps its cursor. A missing row (null) is simply skipped.
 */
function loadBatchMessages({ db, job, viewer, maxMessages }) {
  const payload = job?.payload && typeof job.payload === 'object' ? job.payload : {};
  const userId = text(viewer.userId).trim();
  const personaId = text(viewer.personaId).trim();
  const worldId = text(viewer.worldId ?? '');
  const owned = row => {
    if (!row) return false;
    if (text(row.userId ?? '') !== userId) return false;
    if (text(row.personaId ?? '') !== personaId) return false;
    if (text(row.worldId ?? '') !== worldId) return false;
    if (text(row.sourceKind ?? '') !== CAPTURE_SOURCE_KIND) return false;
    return row.role === 'user' || row.role === 'assistant';
  };

  const ids = Array.isArray(payload.sourceIds) ? payload.sourceIds.map(id => text(id)).filter(Boolean) : [];
  const messages = [];
  if (ids.length) {
    for (const id of ids.slice(0, maxMessages)) {
      let row;
      try {
        row = db.getEvent(id);
      } catch (error) {
        throw new Error(`原文读取失败：${errorText(error)}`);
      }
      if (!owned(row)) continue;
      messages.push(toMessage(row));
    }
    return messages;
  }

  const afterOccurredAt = text(payload.afterOccurredAt);
  const untilOccurredAt = text(payload.untilOccurredAt);
  if (!afterOccurredAt && !untilOccurredAt) return [];
  let rows;
  try {
    rows = db.eventsSince({ userId, personaId, afterOccurredAt, limit: Math.min(maxMessages + 50, 1000) });
  } catch (error) {
    throw new Error(`原文读取失败：${errorText(error)}`);
  }
  return (Array.isArray(rows) ? rows : [])
    .filter(row => owned(row))
    .filter(row => !untilOccurredAt || text(row.occurredAt) <= untilOccurredAt)
    .sort((a, b) => text(a.occurredAt).localeCompare(text(b.occurredAt))
      || text(a.sourceId).localeCompare(text(b.sourceId)))
    .slice(0, maxMessages)
    .map(toMessage);
}

function toMessage(row) {
  return {
    sourceId: text(row.sourceId),
    role: text(row.role) || 'user',
    sourceKind: text(row.sourceKind ?? ''),
    content: text(row.content),
    occurredAt: row.occurredAt ?? null,
    userId: text(row.userId ?? ''),
    personaId: text(row.personaId ?? ''),
    worldId: text(row.worldId ?? ''),
  };
}

// --- candidate -> storage ----------------------------------------------------

const FLAG_REASON_CODES = [
  ['roleplay', 'roleplay'],
  ['joke', 'joke'],
  ['guess', 'guess'],
  ['quoted', 'quoted'],
  ['plan', 'plan'],
  ['future', 'future'],
  ['sensitive', 'sensitive'],
  ['privacy', 'privacy'],
  // Gate second line of defence (validate.isConversationEvidence): the evidence
  // is wholly migrated/system material, so this row may only wait for review.
  ['nonConversationEvidence', 'non_conversation_evidence'],
];

/**
 * Stable, ASCII-only codes derived from the gate flags. They end up as
 * `reason:<code>` tags so `companion_memory_pending` can show *why* a row is
 * waiting without re-running the gate.
 */
export function reasonCodes({ flags = {}, normalized = {}, minAcceptConfidence = 0.5 } = {}) {
  const codes = new Set();
  if (Number(flags.evidenceCount ?? 0) < 1) codes.add('no_evidence');
  if (Array.isArray(flags.missingIds) && flags.missingIds.length) codes.add('missing_evidence');
  if (Array.isArray(flags.foreignIds) && flags.foreignIds.length) codes.add('foreign_evidence');
  if (flags.assistantOnly) codes.add('assistant_only');
  if (flags.worldBoundSession && REAL_USER_SCOPES.has(text(normalized.scope))) codes.add('world_bound');
  for (const [flag, code] of FLAG_REASON_CODES) {
    if (Array.isArray(flags[flag]) && flags[flag].length) codes.add(code);
  }
  if (text(normalized.validity) === 'uncertain') codes.add('uncertain');
  const confidence = Number(normalized.confidence);
  if (Number.isFinite(confidence) && confidence < minAcceptConfidence) codes.add('low_confidence');
  if (!codes.size) codes.add('needs_review');
  return [...codes];
}

function tagsFor({ decision, flags, normalized, minAcceptConfidence }) {
  const tags = ['auto_extracted'];
  if (decision === 'pending') {
    tags.push('pending');
    for (const code of reasonCodes({ flags, normalized, minAcceptConfidence })) tags.push(`reason:${code}`);
  }
  return tags;
}

function latestOccurredAt(evidence, evidenceIds, fallback) {
  const wanted = new Set(evidenceIds);
  let newest = '';
  for (const row of evidence) {
    if (wanted.size && !wanted.has(text(row.sourceId))) continue;
    const occurredAt = text(row.occurredAt);
    if (occurredAt > newest) newest = occurredAt;
  }
  return newest || fallback;
}

/**
 * Gate output normally already exists (extractBatch gates every candidate).
 * If a future caller hands over raw candidates, gate them here instead.
 */
function resolveGated(entry, { pipeline, evidence, viewer, now, config }) {
  if (entry && typeof entry === 'object' && entry.normalized && entry.decision) return entry;
  const raw = entry?.raw ?? entry?.candidate ?? entry;
  const parsed = pipeline.parseCandidate(raw);
  if (!parsed?.ok) return null;
  const gated = pipeline.gateCandidate(parsed.candidate, { evidence, viewer, now, config });
  return { decision: gated.decision, reasons: gated.reasons, candidate: gated.normalized, raw, flags: gated.flags, normalized: gated.normalized };
}

function buildBaseRecord({ normalized, status, viewer, evidenceIds, tags, occurredAt }) {
  return {
    scope: normalized.scope,
    kind: normalized.kind,
    subject: normalized.subject,
    predicate: normalized.predicate,
    value: normalized.value,
    confidence: normalized.confidence,
    importance: normalized.importance,
    mentionPolicy: normalized.mentionPolicy,
    realityLevel: normalized.realityLevel,
    status,
    userId: text(viewer.userId).trim(),
    personaId: text(viewer.personaId).trim(),
    worldId: text(viewer.worldId ?? ''),
    sourceKind: 'extracted',
    sourceId: evidenceIds[0] ?? '',
    tags,
    occurredAt,
  };
}

function linkEvidence({ db, memoryId, evidenceIds, confidence, result }) {
  if (!memoryId) return;
  for (const sourceId of evidenceIds.slice(0, MAX_EVIDENCE_LINKS)) {
    // A failed link is a storage failure: let it abort the batch transaction.
    db.addEvidence(memoryId, sourceId, { evidenceKind: 'supports', confidence });
    result.evidence += 1;
  }
}

function findExisting(db, base) {
  // A read failure must surface (P1-4); only "no rows" may look like "nothing
  // exists yet", and findDuplicates signals that with an empty array.
  const rows = db.findDuplicates({
    userId: base.userId,
    personaId: base.personaId,
    worldId: base.worldId,
    scope: base.scope,
    subject: base.subject,
    predicate: base.predicate,
  });
  return Array.isArray(rows) ? rows : [];
}

function writeCandidate({ db, gated, viewer, evidence, limits, now, result, pipeline }) {
  if (!gated || typeof gated !== 'object') {
    result.rejected += 1;
    noteError(result, '候选没有闸门结论，已丢弃');
    return;
  }
  const decision = text(gated.decision);
  const normalized = gated.normalized;
  if (decision === 'reject') {
    result.rejected += 1;
    return;
  }
  if (!normalized || !text(normalized.value).trim() || !text(normalized.scope) || !text(normalized.predicate)) {
    result.rejected += 1;
    noteError(result, '候选缺少可入库字段，已丢弃');
    return;
  }

  const status = decision === 'pending' ? 'pending' : 'confirmed';
  const evidenceIds = (Array.isArray(normalized.evidenceSourceIds) ? normalized.evidenceSourceIds : [])
    .map(id => text(id))
    .filter(Boolean);
  const tags = tagsFor({
    decision,
    flags: gated.flags ?? {},
    normalized,
    minAcceptConfidence: limits.minAcceptConfidence,
  });
  const occurredAt = latestOccurredAt(evidence, evidenceIds, isoNow(now));
  const base = buildBaseRecord({ normalized, status, viewer, evidenceIds, tags, occurredAt });

  if (decision === 'pending') {
    result.pending += 1;
    // Pending rows never overwrite a stored fact; the dedupe key keeps repeats out.
    const stored = db.insertMemory(base);
    if (stored?.inserted) result.inserted += 1;
    else result.duplicated += 1;
    linkEvidence({ db, memoryId: stored?.record?.id, evidenceIds, confidence: base.confidence, result });
    return;
  }

  result.accepted += 1;
  const existing = findExisting(db, base);
  let merge = { operation: 'insert' };
  const merged = typeof pipeline?.mergeDecision === 'function'
    ? pipeline.mergeDecision({ incoming: { ...base, decision }, existing })
    : null;
  if (merged?.operation) merge = merged;
  // A merge target is required for update/duplicate; without one, insert instead.
  if (['update', 'duplicate'].includes(merge.operation) && !merge.targetId) {
    merge = { operation: 'insert' };
  }

  switch (merge.operation) {
    case 'duplicate': {
      result.duplicated += 1;
      linkEvidence({ db, memoryId: merge.targetId, evidenceIds, confidence: base.confidence, result });
      return;
    }
    case 'update': {
      // Same value was already pending (more evidence arrived): confirm it.
      const record = db.updateMemory(merge.targetId, {
        value: base.value,
        confidence: base.confidence,
        importance: base.importance,
        mentionPolicy: base.mentionPolicy,
        status: 'confirmed',
        tags: base.tags,
      }, { reason: '新证据确认了既有待定记录', actor: MERGE_ACTOR });
      result.updated += 1;
      linkEvidence({ db, memoryId: record?.id ?? merge.targetId, evidenceIds, confidence: base.confidence, result });
      return;
    }
    case 'supersede': {
      // Single-value attribute changed: keep the revision chain in db.rememberFact.
      const record = db.rememberFact({
        userId: base.userId,
        personaId: base.personaId,
        worldId: base.worldId,
        scope: base.scope,
        kind: base.kind,
        subject: base.subject,
        key: base.predicate,
        predicate: base.predicate,
        value: base.value,
        confidence: base.confidence,
        importance: base.importance,
        mentionPolicy: base.mentionPolicy,
        realityLevel: base.realityLevel,
        sourceKind: 'extracted',
        sourceId: base.sourceId,
        tags: base.tags,
        occurredAt: base.occurredAt,
        reason: '抽取到与既有事实冲突的新值，旧值转为历史',
        actor: MERGE_ACTOR,
      });
      result.superseded += 1;
      linkEvidence({ db, memoryId: record?.id, evidenceIds, confidence: base.confidence, result });
      return;
    }
    case 'conflict': {
      // Never overwrite automatically: park as pending for the operator, with
      // the same `reason:<code>` tags the pending list uses.
      const stored = db.insertMemory({
        ...base,
        status: 'pending',
        tags: tagsFor({
          decision: 'pending',
          flags: gated.flags ?? {},
          normalized,
          minAcceptConfidence: limits.minAcceptConfidence,
        }),
      });
      if (stored?.inserted) result.conflicts += 1;
      else result.duplicated += 1;
      linkEvidence({ db, memoryId: stored?.record?.id, evidenceIds, confidence: base.confidence, result });
      return;
    }
    case 'insert':
    default: {
      const stored = db.insertMemory(base);
      if (stored?.inserted) result.inserted += 1;
      else result.duplicated += 1;
      linkEvidence({ db, memoryId: stored?.record?.id, evidenceIds, confidence: base.confidence, result });
    }
  }
}

// --- one job -----------------------------------------------------------------

function isoStamp(ms) {
  return new Date(ms).toISOString();
}

/**
 * Does this job belong to the viewer? The payload carries the owner that
 * capture.noteCaptureBatch wrote; a job from another user, persona or world must
 * never be executed (and never completed) by this worker (P1-3).
 */
function sameOwner(payload, viewer) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const userId = text(source.userId).trim();
  const personaId = text(source.personaId).trim();
  if (userId && userId !== text(viewer.userId).trim()) return false;
  if (personaId && personaId !== text(viewer.personaId).trim()) return false;
  const jobWorld = source.worldId === undefined || source.worldId === null ? '' : text(source.worldId);
  return jobWorld === text(viewer.worldId ?? '');
}

/** Same user/persona prefix, so a mismatch can be reported as a world conflict. */
function sameUserPersona(job, viewer) {
  const stream = text(job?.streamKey);
  const userId = text(viewer?.userId).trim();
  const personaId = text(viewer?.personaId).trim();
  if (!userId || !personaId) return false;
  return stream === `${userId}:${personaId}` || stream.startsWith(`${userId}:${personaId}:`);
}

function sortDue(pending, stamp) {
  return pending
    .filter(job => !job.nextRetryAt || job.nextRetryAt === '' || job.nextRetryAt <= stamp)
    // Same order as db.claimJob: created_at ASC, then id.
    .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt))
      || text(a.jobId).localeCompare(text(b.jobId)));
}

/**
 * Claim the next due job of *this* stream (world included), or explain why the
 * queue cannot be drained by this viewer.
 *
 * - Prefers `db.claimJob(type, { now, streamKey })` (world-keyed stream).
 * - Legacy `user:persona` jobs (queued before the world was part of the key) are
 *   still claimable, but only when every due legacy row belongs to this viewer's
 *   world; otherwise the queue head would be claimed and stranded.
 * - A claimed job is verified against the payload owner before it runs. On a
 *   mismatch it is returned to `pending` and never completed.
 *
 * @returns {{job: object|null, reason: string}}
 */
function claimOwnJob(db, { streamKey, legacyKey, viewer, tick }) {
  const stamp = isoStamp(tick);
  const pending = readPendingJobs(db);
  let legacyClaimable = false;

  if (pending) {
    const due = sortDue(pending, stamp);
    const own = due.filter(job => job.streamKey === streamKey);
    const legacy = due.filter(job => job.streamKey === legacyKey);
    if (!own.length && !legacy.length) {
      const conflict = due.some(job => sameUserPersona(job, viewer));
      return { job: null, reason: conflict ? 'world-mismatch' : '' };
    }
    if (!own.length) {
      // Legacy queue: every due legacy row must belong to this world.
      if (!legacy.every(job => sameOwner(job.payload, viewer))) {
        return { job: null, reason: 'world-mismatch' };
      }
      legacyClaimable = true;
    }
  }

  const claim = key => db.claimJob(JOB_TYPE_EXTRACT, { now: tick, streamKey: key });
  let job = null;
  if (pending) {
    job = claim(legacyClaimable ? legacyKey : streamKey);
  } else {
    // Store cannot list jobs: claim the head, then verify the owner below.
    job = claim(undefined);
  }
  if (!job) return { job: null, reason: '' };

  if (!sameOwner(job.payload, viewer)) {
    // Never execute or complete another world's batch: put it back (P1-3).
    try {
      db.failJob(job.jobId, 'world-mismatch：作业属于其它世界，已退回队列', { retryDelayMs: 0 });
    } catch {
      // Leave the row untouched rather than completing it.
    }
    return { job: null, reason: 'world-mismatch' };
  }
  return { job, reason: '' };
}

/** Pending extract jobs, or null when the store cannot list them. */
function readPendingJobs(db) {
  try {
    if (typeof db.jobs !== 'function') return null;
    const rows = db.jobs({ type: JOB_TYPE_EXTRACT, state: 'pending', limit: 100 });
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

async function processJob({ db, llm, config, viewer, persona, job, now, retryDelayMs, pipeline }) {
  const result = newResult(job);
  const failOptions = retryDelayMs === undefined ? {} : { retryDelayMs };
  try {
    // Belt and braces: a job whose payload names another owner never runs.
    if (job.payload && typeof job.payload === 'object' && !sameOwner(job.payload, viewer)) {
      try {
        db.failJob(job.jobId, 'world-mismatch：作业属于其它世界，已退回队列', { retryDelayMs: 0 });
      } catch {
        // Keep it pending rather than completing it.
      }
      result.outcome = 'skipped';
      result.reason = 'world-mismatch';
      return result;
    }

    const limits = resolveLimits(pipeline, config);
    const messages = loadBatchMessages({ db, job, viewer, maxMessages: limits.maxMessages });

    if (!messages.length) {
      // Nothing to summarise: finish so the queue cannot stall on an empty job.
      db.completeJob(job.jobId, { cursor: job.cursor });
      result.outcome = 'empty';
      result.reason = '作业没有可用的原文消息';
      return result;
    }
    if (!limits.enabled) {
      // Config-disabled extraction must not burn retry attempts.
      db.completeJob(job.jobId, { cursor: job.cursor });
      result.outcome = 'empty';
      result.reason = '自动抽取已关闭，本批原文保留';
      return result;
    }

    const extraction = await pipeline.extractBatch({
      llm,
      config,
      batch: messages,
      viewer,
      persona,
    });
    for (const error of (extraction?.errors ?? []).slice(0, MAX_ERRORS)) noteError(result, error);

    if (extraction?.failed) {
      // Transport/model failure: keep the cursor and the payload for a retry.
      db.failJob(job.jobId, (extraction.errors ?? []).join('；') || '抽取失败', failOptions);
      markFailed(result, db);
      return result;
    }
    if (extraction?.skipped) {
      db.completeJob(job.jobId, { cursor: job.cursor });
      result.outcome = 'empty';
      result.reason = '本批没有可抽取的内容';
      return result;
    }

    const entries = Array.isArray(extraction?.candidates) ? extraction.candidates : [];
    result.candidates = entries.length;

    const unparsed = !entries.length && (extraction?.errors ?? []).some(error => UNPARSEABLE_OUTPUT.test(text(error)));
    if (unparsed) {
      // The model answered with something unusable. Keep the原文 and retry
      // instead of silently dropping a whole batch; db.failJob stops after 5.
      db.failJob(job.jobId, `模型输出无法解析：${(extraction.errors ?? [])[0] ?? '无候选'}`, failOptions);
      markFailed(result, db);
      return result;
    }

    // Candidates are written one transaction each: a storage failure anywhere
    // (read or write) aborts the whole batch instead of quietly dropping data
    // and marking the job done (P1-4).
    for (const entry of entries) {
      try {
        db.transaction(() => writeCandidate({
          db,
          gated: resolveGated(entry, { pipeline, evidence: messages, viewer, now, config }),
          viewer,
          evidence: messages,
          limits,
          now,
          result,
          pipeline,
        }));
      } catch (error) {
        const message = `候选入库失败：${errorText(error)}`;
        try {
          db.failJob(job.jobId, message, failOptions);
        } catch {
          // The storage failure is the one worth reporting.
        }
        noteError(result, message);
        markFailed(result, db);
        return result;
      }
    }

    db.completeJob(job.jobId, { cursor: job.cursor });
    result.outcome = 'done';
    return result;
  } catch (error) {
    try {
      db.failJob(job.jobId, errorText(error), failOptions);
    } catch {
      // The original failure is the one worth reporting.
    }
    noteError(result, error);
    markFailed(result, db);
    return result;
  }
}

/** Record a failed batch without ever re-queueing it automatically. */
function markFailed(result, db) {
  result.outcome = 'failed';
  result.requeued = false;
  // Newer stores expose requeueJob(jobId, { resetAttempts }); when it exists an
  // operator can re-drive the batch by hand after checking last_error.
  result.requeueable = typeof db?.requeueJob === 'function';
}

// --- public entry ------------------------------------------------------------

/**
 * Drain up to `limit` extraction jobs for one viewer.
 *
 * @param {object} params
 * @param {object} params.db      MemoryDatabase
 * @param {object} params.llm     `{ complete({system, input, maxTokens, signal}) }`
 * @param {object} params.config  plugin config (`{ extraction: {...} }`)
 * @param {{userId: string, personaId: string, worldId?: string}} params.viewer
 * @param {object} params.persona persona descriptor for the prompt
 * @param {number|Date|Function} params.now  injectable clock (tests)
 * @param {number} params.limit   jobs per call (default 1)
 * @param {number} [params.retryDelayMs] explicit backoff for db.failJob
 * @returns {Promise<{processed: number, failed: number, empty: number, skipped: number,
 *                    results: object[], reason?: string}>}
 */
export async function runJobs({ db, llm, config = {}, viewer, persona, now = Date.now(), limit = 1, retryDelayMs } = {}) {
  const summary = { processed: 0, failed: 0, empty: 0, skipped: 0, results: [], reason: '' };
  try {
    if (!db || typeof db.claimJob !== 'function') {
      summary.reason = '记忆数据库不可用';
      return summary;
    }
    if (!text(viewer?.userId).trim() || !text(viewer?.personaId).trim()) {
      summary.reason = '当前会话没有绑定用户与角色';
      return summary;
    }

    let pipeline;
    try {
      pipeline = await loadPipeline();
    } catch (error) {
      summary.reason = `抽取模块不可用：${safeError(error)}`;
      return summary;
    }
    const tick = clockMs(now);
    const max = clampInt(limit, 1, MAX_JOBS_PER_RUN, 1);
    const streamKey = streamKeyFor(viewer);
    const legacyKey = legacyStreamKeyFor(viewer);
    let claimReason = '';

    for (let index = 0; index < max; index++) {
      let claim = null;
      try {
        claim = claimOwnJob(db, { streamKey, legacyKey, viewer, tick });
      } catch (error) {
        summary.reason = `无法领取作业：${safeError(error)}`;
        break;
      }
      if (claim?.reason) claimReason = claim.reason;
      const job = claim?.job;
      if (!job) break;

      const result = await processJob({
        db, llm, config, viewer, persona, job,
        now: tick, retryDelayMs, pipeline,
      });
      summary.results.push(result);
      if (result.outcome === 'failed') summary.failed += 1;
      else if (result.outcome === 'empty') summary.empty += 1;
      else if (result.outcome === 'skipped') summary.skipped += 1;
      else summary.processed += 1;
    }
    // A world mismatch never runs or completes the batch; it only explains why
    // this call did nothing (the job stays pending for its own world).
    if (!summary.processed && !summary.failed && summary.skipped) summary.reason = 'world-mismatch';
    else if (!summary.processed && !summary.failed && claimReason) summary.reason = claimReason;
    return summary;
  } catch (error) {
    // Last line of defence: the host calls this from a chat turn.
    summary.reason = `作业执行异常：${safeError(error)}`;
    return summary;
  }
}
