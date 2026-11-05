/** 需要落盘的那份账本的**形状与洗数据**（从 store.ts 拆出：它只该管"怎么安全地改"）。
 *
 * 为什么单独一个文件：磁盘上的 JSON 是不可信输入（手改过、旧版本、半截写、跨日重启后
 * 的昨天账），把它收敛成内部形状是一件事，把内部形状原子地写回去是另一件事。前者是
 * 纯函数、可以逐个字段钉住；后者才是 `store.ts` 的 IO 与锁。混在一起的代价是每次动
 * 校验都要碰一遍加锁逻辑。
 *
 * 跨日（V-S1）：计数里的 `day` 不是"上次写盘时是哪天"，而是"这些数字属于哪一天"。
 * 所以洗数据时**必须**与"今天"比较一次：按天计的字段（今日已发、今日草稿）清零，
 * 跨天有意义的字段（最后发送时刻、退避起点、连续未回复）保留。判定放在**读盘**处，
 * 而不是只靠 worker 每 tick 调 `rollDay()`——进程可能跨日重启，重启后第一次读盘
 * 就该看到今天的额度，否则会出现"昨天把额度用光，今天一整天发不出去"。
 *
 * 本文件不读文件、不碰时钟、不记日志：输入 `unknown`，输出内部形状。
 */

import { normalizeAdaptiveIntent } from './adaptive-intent.js'
import {
  emptyCounters,
  type ContactAuthorization,
  type ContactCandidate,
  type ContactCandidateState,
  type ContactCounters,
  type ContactDelivery,
  type ContactDeliveryState,
  type ContactLease,
  type ContactReceipt,
  type ContactScope,
  type ContactSourceKind,
  type ContactTarget,
} from './types.js'

/** 账本磁盘格式版本。读到别的版本按"不认识"处理：保 `.corrupt`，不猜结构。 */
export const CONTACT_LEDGER_VERSION = 1

/** `recentReasons` 上限（新的在前）。 */
export const MAX_REASONS = 50

/** 落盘的那份账本（读写两侧同一个形状）。 */
export interface ContactLedger {
  version: number
  lease: ContactLease | null
  candidates: Record<string, ContactCandidate>
  outbox: Record<string, ContactDelivery>
  counters: ContactCounters
  /** 最近的抑制/投递原因（新的在前，最多 `MAX_REASONS` 条）。 */
  recentReasons: string[]
}

const SOURCES: ReadonlySet<string> = new Set(['explicit-reminder', 'follow-up', 'activity-receipt', 'share-intent', 'health-sleep'])
const CANDIDATE_STATES: ReadonlySet<string> = new Set(['pending', 'deferred', 'cancelled', 'expired', 'consumed'])
const DELIVERY_STATES: ReadonlySet<string> = new Set([
  'pending', 'running', 'submitted', 'confirmed', 'unknown', 'failed', 'cancelled', 'deferred',
])

export function emptyLedger(day: string): ContactLedger {
  return {
    version: CONTACT_LEDGER_VERSION,
    lease: null,
    candidates: {},
    outbox: {},
    counters: emptyCounters(day),
    recentReasons: [],
  }
}

/**
 * 投递结果的结算补丁（sender 算出来，store 落盘）。
 *
 * 与 `CandidatePatch` 一起放在这里：它们都是"账本上允许改哪些字段"的**形状**，
 * 属于数据契约，不属于 IO 事务（`store.ts` 只管"怎么安全地写下去"）。
 */
export interface DeliverySettlement {
  readonly state: ContactDeliveryState
  readonly receipt: ContactReceipt | null
  readonly lastError: string | null
  readonly submittedAt?: number
  readonly confirmedAt?: number
}

/** 候选的可写字段（其余字段是"提交时定死的事实"，改它们等于换了另一件事）。 */
export interface CandidatePatch {
  readonly state?: ContactCandidateState
  readonly lastSuppressedReason?: string | null
  readonly attempts?: number
  readonly earliestAt?: number
  readonly expiresAt?: number
  readonly priority?: number
  /** 证据 id 列表；**合并**（并集去重）而不是覆盖——同一件事再次被想起时只强化证据。 */
  readonly evidenceIds?: readonly string[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeScope(value: unknown): ContactScope | null {
  if (!isRecord(value)) return null
  const userId = value.userId === null || value.userId === undefined ? null : num(value.userId, -1)
  if (userId !== null && userId < 0) return null
  return { userId, personaId: str(value.personaId), worldId: str(value.worldId) }
}

function normalizeTarget(value: unknown): ContactTarget | null {
  if (!isRecord(value)) return null
  const room = str(value.room)
  const chatId = num(value.chatId, 0)
  if (room === '' || chatId <= 0) return null
  return { channel: 'qq', room, isGroup: value.isGroup === true, chatId }
}

function normalizeAuthorization(value: unknown): ContactAuthorization {
  if (!isRecord(value)) return { kind: 'none', by: null, at: null, quote: null }
  const kind = str(value.kind)
  return {
    kind: kind === 'explicit' || kind === 'standing' ? kind : 'none',
    by: value.by === null || value.by === undefined ? null : num(value.by, 0),
    at: value.at === null || value.at === undefined ? null : num(value.at, 0),
    quote: typeof value.quote === 'string' ? value.quote : null,
  }
}

/** 一条候选；危险字段（目标/作用域/状态/原因）不合格就整条丢——宁缺勿错发。 */
export function normalizeCandidate(value: unknown): ContactCandidate | null {
  if (!isRecord(value)) return null
  const target = normalizeTarget(value.target)
  const scope = normalizeScope(value.scope)
  const id = str(value.id)
  const dedupeKey = str(value.dedupeKey)
  const state = str(value.state)
  const reason = str(value.reason)
  const evidenceSource = str(value.evidenceSource)
  if (target === null || scope === null || id === '' || dedupeKey === '' || reason === '' || evidenceSource === '') return null
  if (!CANDIDATE_STATES.has(state)) return null
  const source = str(value.source)
  const intent = value.intent === undefined ? undefined : normalizeAdaptiveIntent(value.intent)
  if (evidenceSource === 'planned-followup' && !intent) return null
  if (value.intent !== undefined && (!intent || source !== 'follow-up' || evidenceSource !== 'planned-followup'
    || target.isGroup || scope.userId !== target.chatId || intent.originSessionId !== `qq-dm-${String(target.chatId)}`)) return null
  const createdAt = num(value.createdAt, 0)
  const evidenceIds = Array.isArray(value.evidenceIds)
    ? value.evidenceIds.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    id,
    source: (SOURCES.has(source) ? source : 'follow-up') as ContactSourceKind,
    ...(intent ? { intent } : {}),
    reason,
    evidenceSource,
    evidenceIds,
    scope,
    target,
    priority: num(value.priority, 100),
    earliestAt: num(value.earliestAt, createdAt),
    expiresAt: num(value.expiresAt, createdAt),
    dedupeKey,
    version: Math.max(0, Math.floor(num(value.version, 0))),
    authorization: normalizeAuthorization(value.authorization),
    state: state as ContactCandidateState,
    attempts: Math.max(0, Math.floor(num(value.attempts, 0))),
    createdAt,
    updatedAt: num(value.updatedAt, createdAt),
    lastSuppressedReason: typeof value.lastSuppressedReason === 'string' ? value.lastSuppressedReason : null,
  }
}

function normalizeReceipt(value: unknown): ContactReceipt | null {
  if (!isRecord(value)) return null
  const kind = str(value.kind)
  if (kind !== 'platform-accepted' && kind !== 'none') return null
  const messageId = value.messageId === null || value.messageId === undefined ? null : num(value.messageId, 0)
  return { kind, messageId, at: num(value.at, 0) }
}

/** 一条投递；`running` 的降级不在这里做（见 `sweepInterrupted`，只有接管时才降级）。 */
export function normalizeDelivery(value: unknown): ContactDelivery | null {
  if (!isRecord(value)) return null
  const target = normalizeTarget(value.target)
  const scope = normalizeScope(value.scope)
  const id = str(value.id)
  const candidateId = str(value.candidateId)
  const dedupeKey = str(value.dedupeKey)
  const state = str(value.state)
  if (target === null || scope === null || id === '' || candidateId === '' || dedupeKey === '') return null
  if (!DELIVERY_STATES.has(state)) return null
  const createdAt = num(value.createdAt, 0)
  return {
    id,
    candidateId,
    dedupeKey,
    target,
    scope,
    text: str(value.text),
    state: state as ContactDeliveryState,
    attempts: Math.max(0, Math.floor(num(value.attempts, 0))),
    leaseOwner: typeof value.leaseOwner === 'string' ? value.leaseOwner : null,
    epoch: Math.max(0, Math.floor(num(value.epoch, 0))),
    createdAt,
    updatedAt: num(value.updatedAt, createdAt),
    submittedAt: value.submittedAt === null || value.submittedAt === undefined ? null : num(value.submittedAt, 0),
    confirmedAt: value.confirmedAt === null || value.confirmedAt === undefined ? null : num(value.confirmedAt, 0),
    receipt: normalizeReceipt(value.receipt),
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    mode: str(value.mode) === 'direct' ? 'direct' : 'turn',
  }
}

export function normalizeLease(value: unknown): ContactLease | null {
  if (!isRecord(value)) return null
  const hostId = str(value.hostId)
  const pid = num(value.pid, 0)
  if (hostId === '' || pid <= 0) return null
  return {
    hostId,
    pid,
    epoch: Math.max(1, Math.floor(num(value.epoch, 0))),
    acquiredAt: num(value.acquiredAt, 0),
    expiresAt: num(value.expiresAt, 0),
  }
}

/** 洗计数：**只收敛类型，保留原 `day`**（跨日判定在 `rollCounters`）。 */
export function normalizeCounters(value: unknown, day: string): ContactCounters {
  if (!isRecord(value)) return emptyCounters(day)
  const roomNumbers = (input: unknown): Record<string, number> => {
    const out: Record<string, number> = {}
    if (!isRecord(input)) return out
    for (const [key, raw] of Object.entries(input)) out[key] = num(raw, 0)
    return out
  }
  return {
    day: str(value.day) === '' ? day : str(value.day),
    sentTodayGlobal: num(value.sentTodayGlobal, 0),
    sentTodayByRoom: roomNumbers(value.sentTodayByRoom),
    lastSentAt: value.lastSentAt === null || value.lastSentAt === undefined ? null : num(value.lastSentAt, 0),
    lastSentAtByRoom: roomNumbers(value.lastSentAtByRoom),
    unansweredStreakByRoom: roomNumbers(value.unansweredStreakByRoom),
    draftCallsToday: num(value.draftCallsToday, 0),
    lastDraftFailureAt: value.lastDraftFailureAt === null || value.lastDraftFailureAt === undefined
      ? null
      : num(value.lastDraftFailureAt, 0),
    draftFailureStreak: num(value.draftFailureStreak, 0),
  }
}

/**
 * 跨日归零（V-S1）。
 *
 * 按天计的字段清零；**跨天有意义**的字段保留：
 *   - 清零：`sentTodayGlobal` / `sentTodayByRoom` / `draftCallsToday`；
 *   - 保留：`lastSentAt` / `lastSentAtByRoom`（全局与会话冷却要跨天生效，否则午夜
 *     一到立刻又能发一条）、`lastDraftFailureAt` / `draftFailureStreak`（退避是故障
 *     状态，不该因为翻日就假装没事）、`unansweredStreakByRoom`（没人回就是没人回，
 *     与日历无关）。
 */
export function rollCounters(counters: ContactCounters, day: string): ContactCounters {
  if (counters.day === day) return counters
  return {
    ...counters,
    day,
    sentTodayGlobal: 0,
    sentTodayByRoom: {},
    draftCallsToday: 0,
  }
}

/** 把 `running` 降级成 `unknown`：进程死在发送中途，回执未知，**不重发**。 */
export function sweepInterrupted(ledger: ContactLedger, now: number): number {
  let swept = 0
  for (const [id, row] of Object.entries(ledger.outbox)) {
    if (row.state !== 'running') continue
    ledger.outbox[id] = {
      ...row,
      state: 'unknown',
      lastError: 'interrupted: 进程在发送中途结束，回执未知；不自动重发',
      leaseOwner: null,
      updatedAt: now,
    }
    // R5-3 recovery: a crash in flight may already have reached QQ. Charge the
    // quota/cooldown exactly once here, in the same recovery sweep that writes
    // unknown, so a different candidate cannot reuse the slot after restart.
    const room = row.target.room
    const counters = ledger.counters
    ledger.counters = {
      ...counters,
      sentTodayGlobal: counters.sentTodayGlobal + 1,
      sentTodayByRoom: { ...counters.sentTodayByRoom, [room]: (counters.sentTodayByRoom[room] ?? 0) + 1 },
      lastSentAt: now,
      lastSentAtByRoom: { ...counters.lastSentAtByRoom, [room]: now },
      unansweredStreakByRoom: {
        ...counters.unansweredStreakByRoom,
        [room]: (counters.unansweredStreakByRoom[room] ?? 0) + 1,
      },
    }
    const candidate = ledger.candidates[row.candidateId]
    if (candidate !== undefined) {
      // Keep the candidate non-terminal: the delivery row is the unknown/dedupe fence.
      // Marking it consumed here would mask a later lease-lost diagnosis (Q04) while
      // adding no additional safety.
      ledger.candidates[row.candidateId] = {
        ...candidate,
        lastSuppressedReason: 'sent:unknown',
        version: candidate.version + 1,
        updatedAt: now,
      }
    }
    swept += 1
  }
  return swept
}

/** 两个租约是否是同一个（hostId + pid + epoch 三项全同）。 */
export function sameLease(a: ContactLease, b: ContactLease): boolean {
  return a.hostId === b.hostId && a.pid === b.pid && a.epoch === b.epoch
}
