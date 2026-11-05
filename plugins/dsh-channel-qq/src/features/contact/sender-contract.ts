/** 主动消息投递的**合同类型**（从 `sender.ts` 纯搬移出来的接口面）。
 *
 * 为什么单独一个文件：`sender.ts` 已经贴着 400 行的硬上限（`scripts/check-size.mjs`），
 * 而它前一半几乎全是"调用方要满足什么"的声明——那是**合同**，不是执行。执行留
 * 在 `sender.ts`，声明搬到这里；`sender.ts` 仍然原样 re-export 这些名字，所以
 * 既有 `import … from './sender.js'` 的写法一个字都不用改。
 *
 * 本文件只有类型，没有任何运行时代码。
 */

import type { ContactConfig } from '../../config/sections/contact.js'
import type { Clock } from '../../ports/clock.js'
import type { OneBotMessage } from '../../types.js'
import type { DraftRevision } from './draft-context.js'
import type {
  ContactCandidate,
  ContactCounters,
  ContactDelivery,
  ContactDeliveryState,
  ContactLease,
  ContactRuntimeFacts,
} from './types.js'

/** 出站通道的窄面（`platform` 子插件提供的几件套里，投递只需要这两样）。 */
export interface ContactTransport {
  readonly connected: boolean
  /** 与提醒/语录共用的串行限速链。 */
  readonly out: { push<T>(task: () => Promise<T>): Promise<T> }
  readonly api: { sendTo(isGroup: boolean, target: number, message: OneBotMessage): Promise<{ message_id?: number }> }
}

/** `sendMode='turn'` 的入口（inbound 的 `turns`）。 */
export interface ContactTurnPort {
  /** F43: the ticket is checked again after the asynchronous registry.ensure, before submit. */
  bookPrompt(room: string, prompt: string, ticket?: { readonly cancelled: boolean }): Promise<boolean>
}

/** 当前人格/世界（作用域复核用；首版只有一个值，但结构上留位）。 */
export interface ContactIdentity {
  readonly personaId: string
  readonly worldId: string
}

export interface ContactSenderDeps {
  readonly log: (line: string) => void
  readonly clock: Clock
  /** 惰性取：插件卸载后不该继续用旧引用发送。 */
  readonly transport: () => ContactTransport | undefined
  readonly turns: () => ContactTurnPort | undefined
  readonly identity: () => ContactIdentity
  /**
   * **发送前的重新读盘**（决策与执行之间的那道窗口）。
   *
   * 门控给出结论到真正发送之间要经过模型起草，可能几秒到二十秒：这期间用户可能刚
   * 说了一句话、候选可能被取消。`req` 里带的是门控那一刻的快照，用它做"复核"等于没
   * 复核——所以这里再读一次候选与房间事实，由调用方（index）从账本/平台现取。
   */
  readonly refresh: (candidateId: string, room: string) => {
    readonly candidate: ContactCandidate | undefined
    readonly runtime: ContactRuntimeFacts
  }
  /** 是否已暂停/卸载（`worker.pause()` 之后在途的发送也要被拦住）。 */
  readonly isFrozen?: () => boolean
  /** 当前租约代次（`null` = 不校验；与 `delivery.epoch` 不等就不发）。这是内存快判。 */
  readonly leaseEpoch?: () => number | null
  /**
   * **执行点的所有权校验（F2）**：发送前一刻用**持久化依据**（锁文件的 hostId/pid/epoch
   * 与有效期，或等价的一次 keeper 校验）确认这条投递还属于本实例。
   *
   * 为什么不复用 `leaseEpoch`：那是内存 getter——租约过期、被别的进程接管之后，内存里
   * 的 epoch 还是老样子，旧实例会照着发。只有读锁文件才能问出真相。
   * 返回 `null` = 允许发；否则是"如果现在停下该记什么"。
   */
  readonly verifyOwnership?: (delivery: ContactDelivery) => Promise<ContactGuardVerdict | null>
  /**
   * **执行点的现取事实（F3）**：盘上快照（候选）+ 运行时 + 计数 + 已递出去的重键。
   *
   * 门控要在执行点**重跑**一次（22:59:55 入队、23:00:05 执行就该判免打扰），而重跑
   * 要的是"此刻的配置、此刻的事实"。返回 `undefined` = 读不到（当作不能发）。
   * 这是**测试用**的简化入口；生产装配走下面的 `liveSnapshot`（把所有权校验也并进去）。
   */
  readonly liveFacts?: (delivery: ContactDelivery) => Promise<ContactLiveFacts | undefined>
  /**
   * **F41：单次快照 + 最后断言租约**。
   *
   * 装配方在一次调用里完成：读盘快照 → 用它判候选/投递行（`verdict`）→ **最后**才
   * `assertLease(epoch)`。为什么必须是这个顺序：先把租约断言了再去读盘，读盘期间租约
   * 可能刚好到期或被别的进程接管，而我们手里已经是"断言通过"的旧结论了。
   * `facts` 必须是**同一次**快照的派生值——再读第二次盘就等于把窗口又拉开一次。
   */
  readonly liveSnapshot?: (delivery: ContactDelivery) => Promise<ContactLiveSnapshot | undefined>
  /** 当前生效配置（每次现取：后台改完立刻生效，不用等下一次门控）。 */
  readonly config?: () => ContactConfig
  /** 单次发送的等待上限（超过就记 `unknown`，不重发）。 */
  readonly timeoutMs?: number
  /** 执行点的**异步**版本复核（人设/历史）：必须跑在读盘与租约断言**之前**。 */
  readonly verifyDraft?: (req: ContactSendRequest) => Promise<ContactGuardVerdict | null>
  readonly sleepText?: (candidate: ContactCandidate, now: number) => string | null
  /** 这条投递**必须**带冻结版本吗（`direct` 为 true；缺失 = 无法比较 = 不发）。 */
  readonly requireDraftRevision?: () => boolean
  /** 租约的**同步**内存视图（`store.lease`）：最后一道闸的所有权三连靠它。 */
  readonly lease?: () => ContactLease | null
  /** 投递行的**同步**视图（`store.state.outbox[id]`）：确认没被别人 claim。 */
  readonly deliveryRow?: (id: string) => ContactDelivery | undefined
}

/** 执行点复核的结论：`state` 是"如果现在停下，这条投递该记成什么"。 */
export interface ContactGuardVerdict {
  readonly state: ContactDeliveryState
  readonly detail: string
}

/** 执行点重跑门控要的现取事实（全部来自**盘上**或平台，不用门控那一刻的快照）。 */
export interface ContactLiveFacts {
  readonly candidate: ContactCandidate | undefined
  readonly runtime: ContactRuntimeFacts
  readonly counters: ContactCounters
  /** 已经"递出去了"的去重键（只含终态；自己这条的 `running` 不在其中）。 */
  readonly deliveredDedupeKeys: readonly string[]
}

/** F41：单次快照的产物——盘上状态判定 + 同一份快照派生的事实。 */
export interface ContactLiveSnapshot {
  /** 盘上状态判定（候选是否还活着、投递行是否还是我领取的那条）；`null` = 没问题。 */
  readonly verdict: ContactGuardVerdict | null
  readonly facts: ContactLiveFacts
}

/** 一次投递请求：投递记录（已领取）+ 候选（复核用）+ 现取的运行时事实。 */
export interface ContactSendRequest {
  readonly delivery: ContactDelivery
  readonly candidate: ContactCandidate
  /** `direct` = 要发出去的正文；`turn` = 交给回合的指令（由人格包再包装）。 */
  readonly text: string
  readonly now: number
  readonly runtime: ContactRuntimeFacts
  /** **起草那一刻**的时刻（Unix 毫秒），`direct` 由 `attempt.ts` 填（不能用 `now`/`createdAt`）。 */
  readonly draftedAt?: number
  /** **起草时冻结的版本**（Codex P1/R5）：逐项复核候选版本/房间游标/绑定/人设摘要。 */
  readonly revision?: DraftRevision
}
