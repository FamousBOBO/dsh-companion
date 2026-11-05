// Event capture for the companion memory engine (CONTRACT.md §11, plan §5.1).
//
// Two jobs live here:
//   1. Decide whether one DSH `session/event` is a real piece of conversation
//      and turn it into an immutable `source_events` row. Injection material
//      (the memory block we inject ourselves, runtime context, tool cards) must
//      never be captured, otherwise recall feeds extraction and the companion
//      starts remembering its own memories ("memory echo").
//   2. Track a per-stream cursor (`user:persona:world`) so that a batch of
//      un-summarised messages is handed to the `extract` job queue only once.
//
// Nothing here throws at the caller: a broken database or a malformed event
// degrades to `null` / `{capture:false}` so a chat turn can never fail because
// of memory bookkeeping.

import { contentHash, isoNow, parseTime, redactSecrets, truncate } from './text.mjs';

export const CAPTURE_VERSION = 1;

/** Character ceiling for one stored message body (plan §5.1: keep raw text). */
export const DEFAULT_MAX_MESSAGE_CHARS = 16000;
/** Messages needed before a batch job is queued. */
export const DEFAULT_MIN_MESSAGES = 6;
/** Hard cap on one batch, so a single model call stays bounded. */
export const DEFAULT_MAX_MESSAGES = 40;
/** Job type used by lib/jobs.mjs; kept in sync through this export. */
export const EXTRACT_JOB_TYPE = 'extract';

const MESSAGE_EVENT_TYPES = new Set(['user/message', 'assistant/message']);
const STREAM_EVENT_LIMIT = 1000;
const MIN_BATCH_MESSAGES = 1;
const MAX_BATCH_MESSAGES = 400;

// Synthetic content never comes from the human user. `dsh-*` covers harness
// namespaces (dsh-context, dsh-tools, ...) that may appear on injected turns.
const INJECTED_SOURCE_KINDS = new Set([
  'companion-memory',
  'companion-identity',
  'runtime-context',
  'system',
  'system-reminder',
  'context',
  'injection',
  'memory',
  'tool',
  'tool-call',
  'tool-result',
  'tool_use',
  'tool_result',
]);
const INJECTED_SOURCE_PREFIXES = ['dsh-', 'companion-memory', 'runtime-'];

function text(value) {
  return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** Is this `source.kind` something the memory engine (or the host) injected? */
export function isInjectedSourceKind(kind) {
  const normalized = text(kind).trim().toLowerCase();
  if (!normalized) return false;
  if (INJECTED_SOURCE_KINDS.has(normalized)) return true;
  return INJECTED_SOURCE_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * `session/event` carries the message either at `data.message` or (older host
 * builds) directly on `data`. Both shapes are accepted, for both roles.
 */
export function messageFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const data = event.data;
  if (data && typeof data === 'object') {
    if (data.message && typeof data.message === 'object') return data.message;
    if ('content' in data || 'source' in data || 'role' in data) return data;
  }
  if (event.message && typeof event.message === 'object') return event.message;
  return null;
}

/**
 * Flatten the text parts of one message. Tool cards, images and reasoning
 * blocks carry no conversation text and therefore do not count as content.
 */
export function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  const parts = [];
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type !== 'text') continue;
      if (typeof part.text === 'string') parts.push(part.text);
      else if (typeof part.content === 'string') parts.push(part.content);
    }
  }
  if (!parts.length && typeof message.text === 'string') parts.push(message.text);
  return parts.join('\n').trim();
}

function resolveSeq(event) {
  const raw = Number(event?.seq);
  if (Number.isFinite(raw) && raw >= 0) return Math.trunc(raw);
  return null;
}

function resolveOccurredAt(event, clock) {
  const candidates = [event?.time, event?.occurredAt, event?.at, event?.createdAt];
  for (const candidate of candidates) {
    // `time` may be an ISO string or epoch milliseconds depending on the host.
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return isoNow(candidate);
    const parsed = parseTime(candidate);
    if (parsed) return parsed;
  }
  return isoNow(typeof clock === 'function' ? clock() : clock);
}

function hasIdentity(viewer) {
  return Boolean(viewer) && Boolean(text(viewer.userId).trim());
}

/**
 * Decide whether one session event may become evidence.
 *
 * @param {object} event   DSH session event (`{ type, seq, time, data }`)
 * @param {{viewer?: object}} options
 * @returns {{capture: boolean, reason: string, message?: object, sourceKind?: string}}
 */
export function shouldCapture(event, { viewer } = {}) {
  if (!event || typeof event !== 'object') {
    return { capture: false, reason: '事件不是对象，已跳过' };
  }
  const type = text(event.type);
  if (!MESSAGE_EVENT_TYPES.has(type)) {
    return { capture: false, reason: `不是消息事件（${type || '空类型'}），已跳过` };
  }
  const message = messageFromEvent(event);
  if (!message) {
    return { capture: false, reason: '消息体缺失，已跳过' };
  }
  const sourceKind = text(message.source?.kind).trim().toLowerCase();
  if (isInjectedSourceKind(sourceKind)) {
    // The echo guard: never capture memory/runtime injections as user speech.
    return { capture: false, reason: `注入材料（source.kind=${sourceKind}）不回写记忆，已跳过`, sourceKind };
  }
  if (!messageText(message)) {
    return { capture: false, reason: '消息没有可捕获的文本，已跳过' };
  }
  if (type === 'user/message' && sourceKind !== 'user') {
    return { capture: false, reason: `不是真实用户消息（source.kind=${sourceKind || '未知'}），已跳过`, sourceKind };
  }
  if (!hasIdentity(viewer)) {
    return { capture: false, reason: '当前会话没有绑定的用户身份，已跳过' };
  }
  return {
    capture: true,
    reason: type === 'user/message' ? '真实用户消息' : '助手回复',
    message,
    sourceKind,
  };
}

/**
 * Map one session event to a `source_events` row (CONTRACT.md §6 appendEvent).
 * Content is secret-redacted and truncated, never rewritten after insertion.
 *
 * @returns {object|null} row draft, or null when the event is not capturable
 */
export function toSourceEvent({ sessionId, event, viewer, clock = Date.now(), maxChars = DEFAULT_MAX_MESSAGE_CHARS } = {}) {
  try {
    const decision = shouldCapture(event, { viewer });
    if (!decision.capture) return null;
    const session = text(sessionId ?? event?.sessionId).trim();
    if (!session) return null;

    const raw = messageText(decision.message);
    if (!raw) return null;
    const redactedBody = redactSecrets(raw);
    const limit = clampInt(maxChars, 80, 200000, DEFAULT_MAX_MESSAGE_CHARS);
    const content = truncate(redactedBody, limit);

    const seq = resolveSeq(event);
    // DSH always sends `seq`; if a foreign caller omits it, a content hash keeps
    // two distinct messages from collapsing onto the same event key.
    const eventKey = seq === null
      ? `${session}:#${contentHash(raw).slice(0, 8)}`
      : `${session}:${seq}`;

    return {
      eventKey,
      sessionId: session,
      seq: seq === null ? 0 : seq,
      role: event.type === 'user/message' ? 'user' : 'assistant',
      sourceKind: 'desktop_conversation',
      occurredAt: resolveOccurredAt(event, clock),
      content,
      userId: text(viewer?.userId).trim(),
      personaId: text(viewer?.personaId).trim(),
      worldId: text(viewer?.worldId ?? ''),
      meta: {
        capture: 'session/event',
        captureVersion: CAPTURE_VERSION,
        eventType: text(event.type),
        sourceKind: decision.sourceKind,
        sourceForm: text(decision.message?.source?.form),
        chars: content.length,
        redacted: redactedBody !== raw,
        truncated: content.length < redactedBody.length,
      },
    };
  } catch {
    // Capture is bookkeeping: a malformed event must never break a chat turn.
    return null;
  }
}

/**
 * Append one session event and (optionally) note it for extraction.
 * Convenience wrapper used by the host facade and by tests.
 *
 * @returns {{captured: boolean, sourceId?: string, reason?: string, batch?: object|null}}
 */
export function captureEvent({ db, sessionId, event, viewer, clock = Date.now(), maxChars, noteBatch = false, minMessages, maxMessages } = {}) {
  try {
    if (!db || typeof db.appendEvent !== 'function') return { captured: false, reason: '记忆数据库不可用' };
    const row = toSourceEvent({ sessionId, event, viewer, clock, maxChars });
    if (!row) return { captured: false, reason: '事件不可捕获' };
    const result = db.appendEvent(row);
    const outcome = { captured: Boolean(result?.inserted), sourceId: result?.sourceId, eventKey: row.eventKey };
    if (noteBatch && outcome.captured) {
      outcome.batch = noteCaptureBatch({ db, viewer, clock, minMessages, maxMessages });
    }
    return outcome;
  } catch (error) {
    return { captured: false, reason: `捕获失败：${text(error?.message ?? error)}` };
  }
}

// --- batch cursor -----------------------------------------------------------

/**
 * Stream key for the `extract` job queue (`CONTRACT.md` §11 streamKey).
 * The world is part of the key: a reality worker must never claim a fiction
 * world's batch (P1-3). An empty world is rendered as `-` so the key stays
 * readable; a non-empty world is percent-encoded.
 */
export function streamKeyFor(viewer) {
  const userId = text(viewer?.userId).trim();
  const personaId = text(viewer?.personaId).trim();
  const worldId = text(viewer?.worldId ?? '');
  return `${userId}:${personaId}:${worldId ? encodeURIComponent(worldId) : '-'}`;
}

/**
 * Pre-world queue key (`user:persona`). Old queued jobs still use it; jobs.mjs
 * accepts them for the same user/persona as long as the payload's worldId
 * matches the caller, so no batch is stranded after the upgrade.
 */
export function legacyStreamKeyFor(viewer) {
  return `${text(viewer?.userId).trim()}:${text(viewer?.personaId).trim()}`;
}

/** schema_meta key holding the batch cursor of one user/persona/world stream. */
export function captureCursorKey(viewer) {
  return `capture:${text(viewer?.userId).trim()}:${text(viewer?.personaId).trim()}:${text(viewer?.worldId ?? '')}`;
}

function normalizeCursor(raw) {
  if (raw == null) return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const afterOccurredAt = text(parsed.afterOccurredAt);
  const afterSourceId = text(parsed.afterSourceId);
  if (!afterOccurredAt && !afterSourceId) return null;
  return {
    batched: clampInt(parsed.batched, 0, Number.MAX_SAFE_INTEGER, 0),
    afterOccurredAt,
    afterSourceId,
    updatedAt: text(parsed.updatedAt),
  };
}

/** Read the persisted batch cursor of one stream (null when nothing batched). */
export function readCaptureCursor({ db, viewer } = {}) {
  try {
    if (!db || typeof db.meta !== 'function') return null;
    return normalizeCursor(db.meta(captureCursorKey(viewer)));
  } catch {
    return null;
  }
}

// Only real desktop conversation may become a new batch. Imported evidence
// (`role='imported'`, `source_kind='astrbot_import'`), manual facts and system
// rows are already summarised (or trusted differently) and must never be
// re-wrapped as user speech and re-extracted (P1-1).
const STREAM_EVENT_FILTER = `
      user_id = ? AND persona_id = ? AND world_id = ?
      AND source_kind = 'desktop_conversation'
      AND role IN ('user', 'assistant')`;

// Keyset pagination: `(occurred_at, source_id) > (?, ?)` in the same order the
// cursor is compared, so a stream can walk past the first page forever (P1-2).
const STREAM_EVENT_SQL = `
  SELECT source_id, role, source_kind, occurred_at, content, user_id, persona_id, world_id
    FROM source_events
   WHERE ${STREAM_EVENT_FILTER}
     AND (occurred_at > ? OR (occurred_at = ? AND source_id > ?))
   ORDER BY occurred_at ASC, source_id ASC
   LIMIT ?`;

function mapStreamEvent(row) {
  return {
    sourceId: text(row.source_id),
    role: text(row.role),
    sourceKind: text(row.source_kind ?? ''),
    occurredAt: text(row.occurred_at),
    content: text(row.content),
    userId: text(row.user_id ?? ''),
    personaId: text(row.persona_id ?? ''),
    worldId: text(row.world_id ?? ''),
  };
}

/**
 * Next page of capturable conversation evidence for one stream, and only that
 * stream: world, desktop origin and message role are filtered in SQL, so
 * imported/manual/system rows can never leak into a batch and pagination is not
 * capped by a fixed scan window.
 *
 * @param {object} params.cursor cursor returned by readCaptureCursor (null = from the start)
 * @param {number} params.limit  maximum rows to return
 */
export function listStreamEvents(db, viewer, { cursor = null, limit = DEFAULT_MAX_MESSAGES } = {}) {
  const userId = text(viewer?.userId).trim();
  const personaId = text(viewer?.personaId).trim();
  const worldId = text(viewer?.worldId ?? '');
  const afterOccurredAt = text(cursor?.afterOccurredAt);
  const afterSourceId = text(cursor?.afterSourceId);
  const bounded = clampInt(limit, 1, STREAM_EVENT_LIMIT, DEFAULT_MAX_MESSAGES);

  const handle = db?.handle;
  if (handle && typeof handle.prepare === 'function') {
    const statement = handle.prepare(STREAM_EVENT_SQL);
    const rows = statement.all(
      userId, personaId, worldId,
      afterOccurredAt, afterOccurredAt, afterSourceId,
      bounded,
    );
    return (Array.isArray(rows) ? rows : []).map(mapStreamEvent);
  }

  // Degraded path for a store that does not expose its handle: same filters and
  // keyset comparison in JS. Ties on occurred_at cannot be paged here, but the
  // cursor comparison still keeps the batch honest.
  return db.eventsSince({ userId, personaId, afterOccurredAt: '', limit: STREAM_EVENT_LIMIT })
    .filter(row => text(row.worldId ?? '') === worldId)
    .filter(row => text(row.sourceKind ?? '') === 'desktop_conversation')
    .filter(row => row.role === 'user' || row.role === 'assistant')
    .filter(row => {
      const occurredAt = text(row.occurredAt);
      const sourceId = text(row.sourceId);
      if (occurredAt !== afterOccurredAt) return occurredAt > afterOccurredAt;
      return sourceId > afterSourceId;
    })
    .sort((a, b) => text(a.occurredAt).localeCompare(text(b.occurredAt))
      || text(a.sourceId).localeCompare(text(b.sourceId)))
    .slice(0, bounded)
    .map(mapStreamEvent);
}

/** Messages that were never handed to an extraction job yet. */
export function unbatchedEvents({ db, viewer, limit = 200 } = {}) {
  try {
    if (!db || !hasIdentity(viewer) || !text(viewer.personaId).trim()) return [];
    const cursor = readCaptureCursor({ db, viewer });
    return listStreamEvents(db, viewer, { cursor, limit });
  } catch {
    return [];
  }
}

// Number of unfinished extraction jobs one stream may carry. `enqueueJob`
// with `force` bypasses job reuse, so a cap keeps a burst of capture events
// from building an unbounded backlog; older stores simply reuse the job.
const MAX_INFLIGHT_JOBS = 4;

/**
 * Fold the oldest `maxMessages` un-summarised messages into one `extract` job.
 *
 * The cursor advances when the messages *enter* the queue ("入批"), not when the
 * model succeeds: a failed job keeps its own payload (source ids) and is the
 * retry vehicle, so raw text and the cursor both survive a model outage.
 *
 * `enqueueJob(..., {force:true})` makes a new job even while an earlier batch is
 * still pending/running, so catch-up batches are not swallowed. Stores without
 * `force` reuse the in-flight job; then the returned payload does not carry our
 * source ids and the cursor deliberately stays put (messages are queued later).
 *
 * @returns {{jobId: string, messageCount: number, cursor: number, sourceIds: string[]}|null}
 */
export function noteCaptureBatch({ db, viewer, minMessages = DEFAULT_MIN_MESSAGES, maxMessages = DEFAULT_MAX_MESSAGES, clock = Date.now() } = {}) {
  try {
    if (!db || typeof db.enqueueJob !== 'function' || typeof db.setMeta !== 'function') return null;
    if (!hasIdentity(viewer) || !text(viewer.personaId).trim()) return null;

    const min = clampInt(minMessages, MIN_BATCH_MESSAGES, MAX_BATCH_MESSAGES, DEFAULT_MIN_MESSAGES);
    const max = clampInt(maxMessages, min, MAX_BATCH_MESSAGES, Math.max(min, DEFAULT_MAX_MESSAGES));

    const cursor = readCaptureCursor({ db, viewer });
    // One query, bounded to one batch: SQL keyset paging means the 1001st
    // message is reachable too, not just the first scanned window.
    const waiting = listStreamEvents(db, viewer, { cursor, limit: max });
    if (waiting.length < min) return null;

    const streamKey = streamKeyFor(viewer);
    const inFlight = pendingBatches({ db, limit: 100 }).filter(job => job.streamKey === streamKey);
    if (inFlight.length >= MAX_INFLIGHT_JOBS) {
      return { jobId: inFlight[0].jobId, messageCount: 0, cursor: Number(inFlight[0].cursor ?? 0), sourceIds: [], reused: true, reason: '未完成的抽取作业过多，本批消息留到下一轮' };
    }

    const batch = waiting;
    const last = batch[batch.length - 1];
    const batched = (cursor?.batched ?? 0) + batch.length;
    const payload = {
      version: CAPTURE_VERSION,
      userId: text(viewer.userId).trim(),
      personaId: text(viewer.personaId).trim(),
      worldId: text(viewer.worldId ?? ''),
      sourceIds: batch.map(event => text(event.sourceId)),
      messageCount: batch.length,
      afterOccurredAt: text(last?.occurredAt),
      afterSourceId: text(last?.sourceId),
      enqueuedAt: isoNow(typeof clock === 'function' ? clock() : clock),
    };

    const job = db.enqueueJob({
      type: EXTRACT_JOB_TYPE,
      streamKey,
      cursor: batched,
      payload,
      // Queue this batch even if an earlier one is still in flight.
      force: true,
    });
    if (!job?.jobId) return null;

    // Only advance the cursor when the stored job really is *this* batch.
    // A store that ignores `force` returns the in-flight job instead.
    const storedIds = Array.isArray(job.payload?.sourceIds) ? job.payload.sourceIds.map(String) : [];
    const queuedThisBatch = storedIds.length === payload.sourceIds.length
      && storedIds.every((id, index) => id === payload.sourceIds[index]);
    if (!queuedThisBatch) {
      return {
        jobId: job.jobId,
        messageCount: 0,
        cursor: Number(job.cursor ?? 0),
        sourceIds: [],
        reused: true,
        reason: '作业未完成，本批消息留到下一轮',
      };
    }

    db.setMeta(captureCursorKey(viewer), JSON.stringify({
      version: CAPTURE_VERSION,
      batched,
      afterOccurredAt: payload.afterOccurredAt,
      afterSourceId: payload.afterSourceId,
      updatedAt: payload.enqueuedAt,
    }));

    return { jobId: job.jobId, messageCount: batch.length, cursor: batched, sourceIds: payload.sourceIds };
  } catch {
    return null;
  }
}

/** Queued or running extraction jobs, newest first (diagnostics/UI helper). */
export function pendingBatches({ db, limit = 5 } = {}) {
  try {
    if (!db || typeof db.jobs !== 'function') return [];
    return db.jobs({ type: EXTRACT_JOB_TYPE, state: ['pending', 'running'], limit: clampInt(limit, 1, 100, 5) });
  } catch {
    return [];
  }
}
