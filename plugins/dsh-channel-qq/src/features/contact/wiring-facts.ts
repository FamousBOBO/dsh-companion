/** 主动消息子插件的**装配接缝**（从 `index.ts` 纯搬移出来的取数与回调工厂）。
 *
 * 为什么单独一个文件：`index.ts` 有一个包装完就贴着 400 行硬上限
 * （`scripts/check-size.mjs`）的 `apply()`，而里面一半是"从宿主取事实 / 把闭包拼出来"
 * 的胶水。搬到这里之后，`index.ts` 剩下的正是它该做的事：**把四件东西接上**。
 *
 * **纯搬移，零行为改动**：每个函数的判据、顺序、日志文本都与搬之前逐字相同；
 * 只有 `sourceCandidatesOf` / `sleepEnqueueAllowedOf` 是把 `apply()` 里的内联闭包
 * 原样提成命名函数（同样的语句、同样的顺序）。
 */

import { authorizeOutbound, evaluateGate } from './gate.js'
import { proposeIdleFollowUp } from './followup.js'
import { authorizedSleepText, proposeSleepSummary } from './sleep-summary.js'
import { splitRoom } from '../../core/room.js'
import { isRecord } from './ledger.js'
import { ONEBOT_REJECTION } from '../../onebot.js'
import type { Clock } from '../../ports/clock.js'
import type { ContactLedger } from './ledger.js'
import type { ContactGuardVerdict, ContactLiveFacts, ContactLiveSnapshot, ContactTransport } from './sender.js'
import type { ContactStore } from './store.js'
import type { ContactCandidate, ContactCounters, ContactDelivery, ContactRuntimeFacts, ContactService } from './types.js'
import type { ContactRoomFacts } from './worker.js'
import type { SubHost } from '../plugin-kit.js'

/** 房间键是否自洽（`group-<号>` / `dm-<号>`，两种历史前缀都认）。 */
export function roomBound(room: string): boolean {
  return splitRoom(room) !== null
}

/**
 * OneBot 明确拒绝（`retcode !== 0` / `status: 'failed'`）就抛出去。
 *
 * 为什么不能用返回值表达：`{ message_id }` 与 `{ retcode: 100 }` 在 sender 眼里都是
 * "一个对象"，前者是 confirmed、后者是 failed，而**只有后者值得重试**。抛错是唯一
 * 能让 `classifySendError` 看见它的方式（判据在那边按 `code`/`retcode` 认）。
 */
export function rejectIfRefused(result: unknown): void {
  if (!isRecord(result)) return
  const retcode = typeof result.retcode === 'number' ? result.retcode : 0
  const status = typeof result.status === 'string' ? result.status : ''
  // R5-2: only status:'failed' is a provable refusal. A bare nonzero retcode or
  // status:'async' is ambiguous and must classify as unknown (no retry).
  if (status === '' && retcode === 0) return
  if (status === 'ok' && retcode === 0) return
  const error = new Error(`平台回执不明确或拒绝（retcode=${String(retcode)} status=${status === '' ? '-' : status}）`)
  Object.assign(error, { retcode: retcode === 0 ? -1 : retcode, status: status === '' ? 'failed' : status })
  if (status === 'failed') {
    Object.defineProperty(error, ONEBOT_REJECTION, { value: true, enumerable: false })
  }
  throw error
}

/** 一个房间的现取事实：**每次都读一遍**，绝不缓存（缓存等于把"复核"变回快照）。 */
export function roomFactsOf(host: SubHost): (room: string) => ContactRoomFacts {
  return (room: string) => {
    const parts = host.get('platform')
    const record = host.get('inbound')?.registry.get(room)
    return {
      connected: parts?.platform.isConnected() ?? false,
      roomBound: roomBound(room),
      turnRunning: record?.tracker.running() ?? false,
      // 房间最后一条事件的时间（消息事件，秒 → 毫秒）；会话还没物化就是 null。
      lastUserMessageAt: record === undefined ? null : record.lastEvent.time * 1000,
      // 第二个游标：秒级时间戳分辨不出"同一秒里又来了一条"，未成包行数可以（Codex P1/R5）。
      // 判空是必须的：假件/老记录可能没有 `queue` 字段，缺了就是"看不到"，不是 0。
      queueDepth: record === undefined ? null : (record.queue?.length ?? null),
    }
  }
}

/**
 * 运行时事实（门控与发送前复核共用一套；同源才不会一边说能发、一边说不能）。
 *
 * 这里**不再**有"提醒通道开着吗"这类事实：第三轮 Codex 审阅判定"按配置布尔接管提醒"
 * 无法保证互斥（runner 不读 `reminders.enabled`），用户已决定**取消接管**，
 * 到期提醒一律归 `features/reminders/runner.ts`（见 `gate.ts` 的 `reminders-owns`）。
 */
export function runtimeOf(
  store: ContactStore,
  roomFacts: (room: string) => ContactRoomFacts,
  room: string,
): ContactRuntimeFacts {
  const facts = roomFacts(room)
  return {
    connected: facts.connected,
    roomBound: facts.roomBound,
    turnRunningByRoom: { [room]: facts.turnRunning },
    toolRunning: false,
    lastUserMessageAtByRoom: { [room]: facts.lastUserMessageAt },
    queueDepthByRoom: { [room]: facts.queueDepth ?? null },
    deliveredDedupeKeys: store.deliveredDedupeKeys(),
  }
}

/**
 * 出站通道的窄面（惰性、现取）。
 *
 * 为什么单独一个函数：`sendTo` 这里有一件**必须**做的事——OneBot 的明确拒绝（`retcode
 * !== 0` / `status: 'failed'`）要当**错误**抛出去。它如果照常返回，sender 眼里就是
 * "成功但没 message_id" → 会被记成 `submitted`（等于把平台拒绝谎报成已提交，而且永远
 * 不重试）。这段判断和"取不取得到平台"混在一起读，很容易漏掉。
 */
export function transportOf(host: SubHost): () => ContactTransport | undefined {
  return () => {
    const parts = host.get('platform')
    if (parts === undefined) return undefined
    return {
      connected: parts.platform.isConnected(),
      out: { push: (task) => parts.out.push(task) },
      api: {
        sendTo: async (isGroup, target, message) => {
          const result = await parts.api.sendTo(isGroup, target, message)
          rejectIfRefused(result)
          return result
        },
      },
    }
  }
}

/**
 * F2：执行点的**持久化**所有权校验。
 *
 * 快速判据 `leaseEpoch` 只读内存，租约过期/被别的进程接管时它看不出来；所以发送前一刻
 * 还要问一次盘：`assertLease` 读锁文件核对 hostId/pid/epoch/有效期，再把候选与投递行
 * 从**盘上快照**里重判一遍（内存里的"还活着"不算数）。
 */
/**
 * F41：**一次读盘 + 最后断言租约**的执行点快照。
 *
 * 顺序是这个函数的全部意义（Codex 实测的洞就是顺序）：
 *   1. `snapshot()` 读盘（候选、投递行、计数、去重键都出自这一次读）；
 *   2. 用这份快照判"盘上还许不许发"（`verdict`）；
 *   3. **最后**才 `assertLease(epoch)`——它是这个函数里的**最后一个 await**。
 *
 * 反过来（先断言再读盘）会出现：断言通过 → 读盘期间租约到期/被接管 → 拿着"断言通过"
 * 的旧结论放行。返回 `undefined` 表示"读得到盘但所有权已经不在我手里"。
 */
export function executionSnapshotOf(
  store: ContactStore,
  roomFacts: (room: string) => ContactRoomFacts,
  log: (line: string) => void,
) {
  return async (delivery: ContactDelivery): Promise<ContactLiveSnapshot | undefined> => {
    const snapshot = await store.snapshot()
    const facts: ContactLiveFacts = {
      candidate: snapshot.candidates[delivery.candidateId],
      counters: snapshot.counters,
      deliveredDedupeKeys: Object.values(snapshot.outbox)
        .filter((row) => row.state === 'submitted' || row.state === 'confirmed' || row.state === 'unknown')
        .map((row) => row.dedupeKey),
      runtime: runtimeOf(store, roomFacts, delivery.target.room),
    }
    const verdict = verdictFromDisk(snapshot, delivery)
    // 最后一个 await：租约还是我的吗（读锁文件 + 比 hostId/pid/epoch + 查有效期）。
    if (!(await store.assertLease(delivery.epoch))) {
      log(`contact: 投递 ${delivery.id} 的租约已失效（epoch=${String(delivery.epoch)}），不发`)
      return { verdict: { state: 'deferred', detail: 'lease-lost' }, facts }
    }
    return { verdict, facts }
  }
}

/** 盘上状态判定（候选是否还活着、投递行是否还是**我领取的那一条**）。 */
export function verdictFromDisk(snapshot: ContactLedger, delivery: ContactDelivery): ContactGuardVerdict | null {
  const candidate = snapshot.candidates[delivery.candidateId]
  if (candidate === undefined) return { state: 'cancelled', detail: 'candidate:missing' }
  if (candidate.state !== 'pending' && candidate.state !== 'deferred') {
    return { state: 'cancelled', detail: `candidate:${candidate.state}` }
  }
  // 只判"存在且 running"不够：盘上那行可能已经被别人重领（epoch 变了）或换了主人
  // （leaseOwner 变了）。三项一起比才对得上"我领取的那一条"。
  const row = snapshot.outbox[delivery.id]
  if (row === undefined) return { state: 'cancelled', detail: 'delivery:missing' }
  if (row.id !== delivery.id) return { state: 'cancelled', detail: 'delivery:id-mismatch' }
  if (row.state !== 'running') return { state: 'deferred', detail: `delivery:${row.state}` }
  if (row.epoch !== delivery.epoch) return { state: 'deferred', detail: 'delivery:epoch-mismatch' }
  if (row.leaseOwner !== delivery.leaseOwner) return { state: 'deferred', detail: 'delivery:owner-mismatch' }
  return null
}

/**
 * 候选来源（`worker` 的 `sourceCandidates`）：睡眠摘要复核 + 空闲跟进。
 *
 * 从 `apply()` 里提出来的是**同一段语句**：先按 `health-sleep` 复核既有候选是否需要撤销，
 * 再提睡眠摘要、再提空闲跟进。`serviceRef` 是惰性引用（`apply()` 里先建 worker 后建
 * service，回调触发时 service 一定已经就位；为空表示已经卸载，什么都不做）。
 */
export function sourceCandidatesOf(
  host: SubHost,
  store: ContactStore,
  serviceRef: { current: ContactService | null },
  clock: Clock,
): () => Promise<void> {
  return async () => {
    if (serviceRef.current === null) return
    const now = clock.now()
    for (const candidate of Object.values(store.state.candidates)) {
      if (candidate.source !== 'health-sleep' || !['pending', 'deferred'].includes(candidate.state)) continue
      if (!authorizedSleepText(host, candidate, now)) {
        await serviceRef.current.cancel(candidate.id, 'health:authorization-or-source-changed')
      }
    }
    await proposeSleepSummary(host, serviceRef.current, now)
    await proposeIdleFollowUp(host, serviceRef.current, clock.now())
  }
}

/**
 * 睡眠摘要入队前的复核（`service` 的 `sleepEnqueueAllowed`）：两道判据都过才许写账本。
 *
 * 与 `apply()` 里的内联闭包逐句相同：先看外发授权、再看这条摘要的文本是否仍然成立，
 * 最后把**同一套**门控（`evaluateGate`）跑一遍，只放行 `verdict === 'send'`。
 */
export function sleepEnqueueAllowedOf(
  host: SubHost,
  store: ContactStore,
  roomFacts: (room: string) => ContactRoomFacts,
  clock: Clock,
): (candidate: ContactCandidate, counters: ContactCounters) => boolean {
  return (candidate, counters) => {
    const now = clock.now()
    if (!authorizeOutbound(host.config.contact).allowed || !authorizedSleepText(host, candidate, now)) return false
    return evaluateGate({
      candidate, now, counters, config: host.config.contact,
      runtime: runtimeOf(store, roomFacts, candidate.target.room),
      deliveryDedupeKeys: store.deliveredDedupeKeys(),
    }).verdict === 'send'
  }
}

