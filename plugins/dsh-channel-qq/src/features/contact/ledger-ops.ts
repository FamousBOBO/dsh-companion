/** 账本要改的**内容**（从 `store.ts` 拆出：那里只管"怎么安全地写下去"，这里管"改成什么样"）。
 *
 * 拆出来的判据：`store.ts` 真正不可替代的只有一件事——把"进程内串行 + 跨进程租约 +
 * 原子落盘"包成一个事务；至于事务内部"候选怎么打补丁、投递怎么结算、计数怎么加一"，
 * 都是对 `ContactLedger` 的纯函数：同一份账本 + 同一组参数，结果永远一样。混在一起时，
 * 每动一条状态规则都要在加锁、读盘、降级这三件事之间找它落在哪一行。
 *
 * 三条纪律（都是"为什么"）：
 *   1. **只改传进来的这份账本**，不读磁盘、不碰 `store` 的内存账本——P2.5 round16 §2.3a
 *      的写入原子性靠的就是这条：这些函数作用在"刚落盘解析出来的草稿"上，落盘失败时
 *      调用方直接丢掉草稿，进程内账本一点没变；
 *   2. 返回 `false` 只有一个含义：**按业务规则不该改**（幂等重放、状态已变、旧代次…），
 *      调用方据此既不落盘也不换内存；
 *   3. 时间一律由参数给（`now`）。这些函数因此能在没有时钟、没有文件、没有租约的测试里
 *      独立复现整条状态机。
 */

import {
  MAX_REASONS,
  rollCounters,
  type CandidatePatch,
  type ContactLedger,
  type DeliverySettlement,
} from './ledger.js'
import type {
  ContactCandidate,
  ContactCounters,
  ContactDelivery,
} from './types.js'

/**
 * 改候选（版本 +1：时间戳、抑制原因、证据都算变化）。
 *
 * 证据只增不减：同一件事再次被想起时，旧的证据仍然成立。
 *
 * @returns 改完的那条（没这条 = `null`，调用方据此知道"什么也没发生"）
 */
export function applyCandidatePatch(
  ledger: ContactLedger,
  id: string,
  patch: CandidatePatch,
  now: number,
): ContactCandidate | null {
  const prev = ledger.candidates[id]
  if (prev === undefined) return null
  const next: ContactCandidate = {
    ...prev,
    ...(patch.state === undefined ? {} : { state: patch.state }),
    ...(patch.lastSuppressedReason === undefined ? {} : { lastSuppressedReason: patch.lastSuppressedReason }),
    ...(patch.attempts === undefined ? {} : { attempts: patch.attempts }),
    ...(patch.earliestAt === undefined ? {} : { earliestAt: patch.earliestAt }),
    ...(patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.evidenceIds === undefined ? {} : { evidenceIds: [...new Set([...prev.evidenceIds, ...patch.evidenceIds])] }),
    version: prev.version + 1,
    updatedAt: now,
  }
  ledger.candidates[id] = next
  return next
}

/**
 * 领取一条投递：置 `running` 并绑定租约。
 *
 * 幂等：盘上这条已经不是"可以领"的状态就返回 false，于是重复 tick、热重载后的重入、
 * 第二个实例的并发都不会二次发送。**`cancelled` 不许复活**（取消是终态）；
 * `failed`/`deferred`/`pending` 仍可重领——那是"重试"语义，次数由 `attempts` 兜住。
 *
 * 领取与"候选是否还被允许发"在**同一个事务**里判：只看投递行是不够的——候选可能
 * 在 `pickDue` 之后被 `cancel()` 掉，那样"取消后仍然发出去"就发生了。
 */
export function applyClaim(
  ledger: ContactLedger,
  delivery: ContactDelivery,
  owner: string,
  epoch: number,
  now: number,
): boolean {
  const candidate = ledger.candidates[delivery.candidateId]
  if (candidate === undefined) return false
  if (candidate.state !== 'pending' && candidate.state !== 'deferred') return false
  const prev = ledger.outbox[delivery.id]
  if (prev !== undefined && (prev.state === 'running' || prev.state === 'submitted'
    || prev.state === 'confirmed' || prev.state === 'unknown' || prev.state === 'cancelled')) {
    return false
  }
  ledger.outbox[delivery.id] = {
    ...delivery,
    state: 'running',
    leaseOwner: owner,
    epoch,
    // 次数以**盘上**那份为准：调用方拿的可能是几毫秒前的快照，用它会让计数回退。
    attempts: (prev ?? delivery).attempts + 1,
    updatedAt: now,
    lastError: null,
  }
  return true
}

/** 结算一条投递。旧代次的迟到结果写不进去（`epoch` 对不上就 false）。 */
export function applySettle(
  ledger: ContactLedger,
  id: string,
  epoch: number,
  settle: DeliverySettlement,
  now: number,
): boolean {
  const prev = ledger.outbox[id]
  if (prev === undefined) return false
  if (prev.epoch !== epoch) return false
  ledger.outbox[id] = {
    ...prev,
    state: settle.state,
    receipt: settle.receipt,
    lastError: settle.lastError,
    submittedAt: settle.submittedAt ?? prev.submittedAt,
    confirmedAt: settle.confirmedAt ?? prev.confirmedAt,
    leaseOwner: null,
    updatedAt: now,
  }
  return true
}

/** 一条"已经交给平台"的投递该花的额度（quota + 冷却 + 未回复计数，一次全给）。 */
function chargeSent(ledger: ContactLedger, room: string, now: number): void {
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
}

/**
 * R5-3: settle the delivery row, the send quota/cooldown counters and the candidate
 * terminal state in **one** ledger write. A crash can no longer leave a confirmed/
 * unknown row without its quota charge, which would let a different candidate spend
 * the same daily slot after restart.
 */
export function applySettleAndAccount(
  ledger: ContactLedger,
  id: string,
  epoch: number,
  settle: DeliverySettlement,
  now: number,
  candidateId: string,
  detail: string,
): boolean {
  const prev = ledger.outbox[id]
  if (prev === undefined || prev.epoch !== epoch) return false
  // Idempotent replay: an already settled terminal row must never charge again.
  if (prev.leaseOwner === null && (prev.state === 'confirmed' || prev.state === 'submitted' || prev.state === 'unknown' || prev.state === 'cancelled')) return true
  ledger.outbox[id] = {
    ...prev,
    state: settle.state,
    receipt: settle.receipt,
    lastError: settle.lastError,
    submittedAt: settle.submittedAt ?? prev.submittedAt,
    confirmedAt: settle.confirmedAt ?? prev.confirmedAt,
    leaseOwner: null,
    updatedAt: now,
  }
  const candidate = ledger.candidates[candidateId]
  const terminal: boolean = settle.state === 'confirmed' || settle.state === 'submitted' || settle.state === 'unknown'
  if (terminal) {
    chargeSent(ledger, prev.target.room, now)
    if (candidate !== undefined) {
      ledger.candidates[candidateId] = {
        ...candidate,
        state: 'consumed',
        lastSuppressedReason: `sent:${settle.state}`,
        version: candidate.version + 1,
        updatedAt: now,
      }
    }
    return true
  }
  if (settle.state === 'cancelled' && candidate !== undefined) {
    const expired = detail === 'candidate:expired'
    ledger.candidates[candidateId] = {
      ...candidate,
      state: expired ? 'expired' : 'cancelled',
      lastSuppressedReason: expired ? 'expired' : detail,
      version: candidate.version + 1,
      updatedAt: now,
    }
  }
  return true
}

/** 改计数（`day` 由读盘/跨日逻辑守着，这里绝不覆盖）。 */
export function applyCounters(ledger: ContactLedger, patch: Partial<ContactCounters>): ContactCounters {
  const next = { ...ledger.counters, ...patch, day: ledger.counters.day }
  ledger.counters = next
  return next
}

/**
 * 把账本推进到 `day`（跨日归零）。
 *
 * 判据复用 `ledger.rollCounters`（读盘时也用它）：跨日"清哪些、留哪些"只许有一份答案，
 * 在这里重写一遍就是给午夜留一个"重启与不重启行为不同"的口子。
 *
 * 没有返回值：调用方 `store.rollDay()` 只在"这个实例还认为是昨天"时才走到这里，所以
 * 落一笔盘本身就是这次调用的目的（见那里的注释）。
 */
export function applyRoll(ledger: ContactLedger, day: string): void {
  ledger.counters = rollCounters(ledger.counters, day)
}

/** 记一条抑制/投递原因（连续同因不重复记，避免夜里每分钟刷一行）。 */
export function applyNote(ledger: ContactLedger, reason: string, now: number): boolean {
  const newest = ledger.recentReasons[0]
  if (newest !== undefined && newest.slice(newest.indexOf(' ') + 1) === reason) return false
  ledger.recentReasons = [`${new Date(now).toISOString()} ${reason}`, ...ledger.recentReasons].slice(0, MAX_REASONS)
  return true
}
