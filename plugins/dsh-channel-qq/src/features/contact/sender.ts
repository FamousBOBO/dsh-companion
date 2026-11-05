/** 主动消息的**投递执行**：真发之前再复核一遍，然后走既有出站通道。
 *
 * 为什么发送要单独一个文件、而不是塞进 worker：worker 的回答是"这件事该不该说"
 * （门控之后、几秒之前的事实）；本文件的回答是"**这一刻**还允不允许发、发出去之后
 * 我们到底知道了什么"。两者之间可以插入一条用户消息、一次取消、一次断线、一次暂停，
 * 而"决策与执行之间的窗口"正是重复外发与发错房间的高发地（2026-10-14 那次的教训）。
 *
 * 五条不许越过的线：
 *   1. **没有通道就不发**：`transport` 不在场/`connected=false` 时记 `deferred`，
 *      **绝不**把"我本来要发"记成已发；没有平台回执 `message_id` 时最多记 `submitted`
 *      （`confirmed` 的确切含义只有一种：平台接受了这条消息）。
 *   2. **与提醒/语录共用一条出站链**：`out.push(() => api.sendTo(...))`。自己再起一条
 *      发送路径就等于绕过全局限速，群里两条消息同时出去。
 *   3. **顺序固定**：执行点先做**异步**读资料（人设/历史复核），**再一次**读盘并**最后**
 *      断言租约，之后直到 `sendTo` 只有**同步**判据（`finalSyncGuard` 含所有权三连）。
 *      R5 第一版把异步复核插在租约断言之后——await 窗口里的接管拦不住（增量复审 P1）。
 *   4. **超时即作废**：一次发送有自己的 `SendTicket`（令牌 + 截止时刻）。`withTimeout`
 *      超时后令牌置废，队列里那次迟到的任务第一句就会抛 `ContactAborted`，**永不补发**；
 *      截止时刻从**入队列那一刻**算起（起草耗时不算在发送预算里）。
 *   5. **异常分三类**：只有经标记的"平台明确拒绝"才敢记 `failed`（可重试）；超时、连接类
 *      错误、认不出的异常一律 `unknown`——按失败重试就是重复外发。
 *
 * 本文件不选候选、不写账本、不定时、不读磁盘。
 */

import type { ContactConfig } from '../../config/sections/contact.js'
import type { Clock } from '../../ports/clock.js'
import type { OneBotMessage } from '../../types.js'
import { evaluateGate } from './gate.js'
import { verdictOf, finalSyncGuard } from './precheck.js'
import { createSendTicket, withTimeout } from './send-guard.js'
import type { DraftRevision } from './draft-context.js'
import { ContactAborted, blockedResult, resultFromError, summarizeResult } from './settle.js'
import type { ContactSendResult } from './settle.js'
import type {
  ContactCandidate,
  ContactCounters,
  ContactDelivery,
  ContactDeliveryState,
  ContactLease,
  ContactReceipt,
  ContactRuntimeFacts,
  ContactTarget,
} from './types.js'

// 异常分类与作废令牌住在 `send-guard.ts`（纯判据，可单独钉住）；
// 这里再导出一次，消费方（诊断/测试）不必为了拆文件改 import 路径。
export { classifySendError, createSendTicket } from './send-guard.js'
export type { ContactSendResult } from './settle.js'
export { ContactAborted } from './settle.js'
export type { SendErrorKind, SendTicket } from './send-guard.js'

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

/** 直发投递的**异步复核戳**：`recheckAtSend` 通过后置真，最后的同步闸要求它是真。 */
interface DraftAttestation {
  revisionChecked: boolean
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

type GuardVerdict = ContactGuardVerdict



export class ContactSender {
  private readonly timeoutMs: number

  constructor(private readonly deps: ContactSenderDeps) {
    this.timeoutMs = deps.timeoutMs ?? 30_000
  }

  /** 投递一条：入口**粗筛**（`refresh` + `verdictOf`）只是排队前的过滤，真正的门在执行点。 */
  async deliver(req: ContactSendRequest, config: ContactConfig): Promise<ContactSendResult> {
    const fresh = this.deps.refresh(req.delivery.candidateId, req.delivery.target.room)
    if (fresh.candidate === undefined) {
      this.deps.log(`contact: 候选 ${req.delivery.candidateId} 已不在账本里，投递放弃`)
      return blockedResult('cancelled', 'candidate:missing')
    }
    const request: ContactSendRequest = { ...req, candidate: fresh.candidate, runtime: fresh.runtime }
    const verdict = verdictOf(request, config, this.deps)
    if (verdict !== null) {
      this.deps.log(`contact: 发送前复核拦下 ${request.delivery.target.room}：${verdict.detail}`)
      return blockedResult(verdict.state, verdict.detail)
    }
    return request.delivery.mode === 'direct' ? await this.sendDirect(request, config) : await this.sendTurn(request, config)
  }

  /**
   * 执行点复核（F2 / F3 / R2 / R3 + P1）：**两种模式共用**，顺序不许换。
   *
   * 1. **异步读资料先做完**（`verifyDraft`：人设文档 / history 缓存）——必须在读盘与租约断言
   *    **之前**；R5 第一版插在断言之后，"最后一个 await"就不再是租约检查（P1 回归）；
   * 2. 一次读盘 + **最后断言租约**（`liveSnapshot` 内最后一个 await 是 `assertLease`）；
   * 3. 同步判据（本地复核 / 门控重跑）；4. 回 `sendDirect`/`sendTurn` 的同步最终闸。
   */
  private async recheckAtSend(req: ContactSendRequest, fallback: ContactConfig, attest: DraftAttestation): Promise<GuardVerdict | null> {
    // ① 异步读资料：判不过就作废这份草稿；判过了就打戳（同步闸会要求这个戳）。
    const draft = req.candidate.source === 'health-sleep' ? null : await this.deps.verifyDraft?.(req)
    if (draft !== undefined && draft !== null) {
      this.deps.log(`contact: 执行点复核判草稿过期（${draft.detail}），本次不发`)
      return draft
    }
    attest.revisionChecked = req.revision !== undefined
    // ② 读盘 + 最后断言租约（`liveSnapshot` 内部 assertLease 是本函数**最后一个 await**）。
    const snapshot = await this.readSnapshot(req)
    if (snapshot === undefined) {
      // 盘读不出来或（F41）租约在最后一次读盘之后已被接管/过期 → 不能证明安全 → 不发。
      return { state: 'deferred', detail: 'facts:unavailable' }
    }
    // 单次快照已经把"盘上状态 + 租约所有权"一起判完了，这里不再做第二次读盘。
    if (snapshot.verdict !== null) return snapshot.verdict
    const fresh = snapshot.facts === null ? this.deps.refresh(req.delivery.candidateId, req.delivery.target.room) : null
    const candidate = snapshot.facts === null ? fresh?.candidate : snapshot.facts.candidate
    // 有事实就只认事实：内存里的 `fresh.candidate` 兜底等于让一条已取消的候选"复活"。
    if (candidate === undefined) return { state: 'cancelled', detail: 'candidate:missing' }
    const runtime = snapshot.facts?.runtime ?? (fresh?.runtime as ContactRuntimeFacts)
    const now = this.deps.clock.now()
    const config = this.deps.config?.() ?? fallback
    const local = verdictOf({ ...req, candidate, runtime, now }, config, this.deps)
    if (local !== null) return local
    if (snapshot.facts === null) return null
    // 去重事实**不做 key 过滤**（R4）：那批键只含终态，自己这条是 `running` 本就不在其中；
    // 按 key 整批删会把"另一条同键已递出/unknown 的证据"一起排掉，等于给自己开后门。
    const decision = evaluateGate({
      candidate,
      now,
      config,
      counters: snapshot.facts.counters,
      runtime,
      deliveryDedupeKeys: [...snapshot.facts.deliveredDedupeKeys],
    })
    if (decision.verdict !== 'send') {
      this.deps.log(`contact: 执行点重跑门控判 ${decision.verdict}（${decision.reason}），本次不发`)
      return { state: decision.verdict === 'drop' ? 'cancelled' : 'deferred', detail: decision.reason }
    }
    return null
  }

  /**
   * 现取一次事实（F41）：优先 `liveSnapshot`（所有权校验并进来，**断言租约是最后一个 await**）；
   * 没有它就退回 `liveFacts`；两者都没有（最小 rig）时只靠本地判据。
   */  private async readSnapshot(req: ContactSendRequest): Promise<{ verdict: GuardVerdict | null; facts: ContactLiveFacts | null } | undefined> {
    if (this.deps.liveSnapshot !== undefined) {
      const snapshot = await this.deps.liveSnapshot(req.delivery)
      return snapshot === undefined ? undefined : { verdict: snapshot.verdict, facts: snapshot.facts }
    }
    // 兼容旧的分离式注入（测试常用）：先所有权、再看事实。
    const ownership = await this.ownershipOf(req)
    if (ownership !== null) return { verdict: ownership, facts: null }
    if (this.deps.liveFacts !== undefined) {
      const facts = await this.deps.liveFacts(req.delivery)
      return facts === undefined ? undefined : { verdict: null, facts }
    }
    return { verdict: null, facts: null }
  }

  /** 所有权校验（兼容旧的 `verifyOwnership` 注入点；生产走 `liveSnapshot` 的单次快照）。 */
  private async ownershipOf(req: ContactSendRequest): Promise<GuardVerdict | null> {
    if (this.deps.verifyOwnership === undefined) return null
    return await this.deps.verifyOwnership(req.delivery)
  }

  /** F42 + P1 的最终同步判定：所有权三连 + 版本戳 + 本地判据，**全程无 await**。 */
  private finalSyncVerdict(req: ContactSendRequest, fallback: ContactConfig, attest: DraftAttestation): GuardVerdict | null {
    const verdict = finalSyncGuard(req, fallback, {
      identity: this.deps.identity,
      transport: this.deps.transport,
      turns: this.deps.turns,
      nowMs: () => this.deps.clock.now(),
      ...(this.deps.config === undefined ? {} : { liveConfig: this.deps.config }),
      // P1（增量复审）：这三样以前漏在这里——最后一道闸既没校验所有权，也没要求 direct 带版本。
      ...(this.deps.lease === undefined ? {} : { lease: this.deps.lease }),
      ...(this.deps.deliveryRow === undefined ? {} : { deliveryRow: this.deps.deliveryRow }),
      ...(this.deps.requireDraftRevision === undefined ? {} : { requireDraftRevision: this.deps.requireDraftRevision }),
      draftAttested: () => attest.revisionChecked,
      refresh: (candidateId: string, room: string) => {
        const fresh = this.deps.refresh(candidateId, room)
        return { candidate: fresh.candidate, runtime: fresh.runtime }
      },
    })
    if (verdict !== null) this.deps.log(`contact: 最终同步判定拦下 ${req.delivery.target.room}：${verdict.detail}`)
    return verdict
  }

  /**
   * 直发：与提醒/语录同一条出站链；有 `message_id` 才敢说 `confirmed`。队列 callback 里的
   * 顺序不许换：令牌 → 截止 → `isFrozen` → `recheckAtSend` → **再查一遍令牌/冻结/截止**
   * → 同步最终闸 → `sendTo`。
   */
  private async sendDirect(req: ContactSendRequest, config: ContactConfig): Promise<ContactSendResult> {
    const transport = this.deps.transport()
    if (transport === undefined) return blockedResult('deferred', 'no-channel')
    const target = req.delivery.target
    const message: OneBotMessage = [{ type: 'text', data: { text: req.text.trim() } }]
    const ticket = createSendTicket()
    // 异步复核的**戳**：`recheckAtSend` 通过后置真，最后的同步闸要求它是真（direct）。
    const attest: DraftAttestation = { revisionChecked: false }
    // 截止时刻从**入队列那一刻**算起，不是从起草前那一拍的 `req.now`：起草可能合法地
    // 等上 `draftTimeoutMs`（可配到 300s），用起草前的时刻起算会把正常的慢草稿判成过期。
    const deadline = this.deps.clock.now() + this.timeoutMs
    try {
      const result = await withTimeout(this.deps.clock, this.timeoutMs, async () =>
        await transport.out.push(async () => {
          if (ticket.cancelled) throw new ContactAborted({ state: 'deferred', detail: `aborted:${ticket.reason ?? 'cancelled'}` })
          if (this.deps.clock.now() > deadline) throw new ContactAborted({ state: 'deferred', detail: 'aborted:deadline' })
          // 暂停/卸载最先判：`refresh` 看不出来（候选还是 pending、runtime 也没有暂停位）。
          if (this.deps.isFrozen?.() === true) throw new ContactAborted({ state: 'deferred', detail: 'frozen' })
          const late = await this.recheckAtSend(req, config, attest)
          // **最后一个 await 之后必须再复查一次**：上面读过锁文件/盘（真 I/O），这期间
          // 操作者可能刚按暂停、或者这次发送刚被超时作废。
          if (ticket.cancelled) throw new ContactAborted({ state: 'deferred', detail: `aborted:${ticket.reason ?? 'cancelled'}` })
          if (this.deps.isFrozen?.() === true) throw new ContactAborted({ state: 'deferred', detail: 'frozen' })
          if (this.deps.clock.now() > deadline) throw new ContactAborted({ state: 'deferred', detail: 'aborted:deadline' })
          if (late !== null) throw new ContactAborted(late)
          // F42 + P1：**完全同步**的最终判定（所有权三连 + 版本戳 + 开关/免打扰/过期/授权/
          // 竞争/通道）。这一层不许有 await——它就是"最后一个 await 之后"的那道闸。
          const finalVerdict = this.finalSyncVerdict(req, config, attest)
          if (finalVerdict !== null) throw new ContactAborted(finalVerdict)
          if (req.candidate.source === 'health-sleep'
            && this.deps.sleepText?.(req.candidate, this.deps.clock.now()) !== req.text) {
            throw new ContactAborted({ state: 'cancelled', detail: 'health:authorization-or-source-changed' })
          }
          return await transport.api.sendTo(target.isGroup, target.chatId, message)
        }))
      return summarizeResult(result, target, req.now, this.deps.log)
    } catch (error) {
      return resultFromError(error, this.deps.log)
    } finally {
      // 结算之后一律作废：还排在队列里的那次任务不许再发（超时的情形靠这一句兜住）。
      ticket.cancel('timeout')
    }
  }


  /**
   * 回合：交给既有会话（人格包渲染、房间指令由 turns 负责），**只能**记 `submitted`。
   *
   * **turn 的新鲜度边界（不假装它安全）**：正文由宿主 agent 在回合里现场生成，contact
   * **看不到也复核不了**；turn 因此**没有** `revision`（`requireDraftRevision` 只在 direct
   * 置真）。最终同步闸对它只能保证 **"提交前状态没变"**（候选/房间/租约/投递行），
   * **保证不了正文新鲜度**。诊断靠投递行 `mode`、成功 detail `turn-submitted`（direct 是
   * `platform-accepted`）与下面那行日志区分两条路径。
   *
   * **已知边界**：`turns.bookPrompt` 内部还有自己的 await（`registry.ensure` 之类），从把手
   * 交给它那一刻就有窗口；`bookPrompt` 之前的这一判是 contact 能控制的最后一个位置。
   */
  private async sendTurn(req: ContactSendRequest, config: ContactConfig): Promise<ContactSendResult> {
    const turns = this.deps.turns()
    if (turns === undefined) return blockedResult('failed', 'no-turn-port')
    const attest: DraftAttestation = { revisionChecked: false }
    const late = await this.recheckAtSend(req, config, attest)
    if (late !== null) {
      this.deps.log(`contact: 回合提交前复核拦下 ${req.delivery.target.room}：${late.detail}`)
      return blockedResult(late.state, late.detail)
    }
    // turn 路径没有队列，但同样要在交出去之前做一次**同步**最终判定（F42）。
    const finalVerdict = this.finalSyncVerdict(req, config, attest)
    if (finalVerdict !== null) return blockedResult(finalVerdict.state, finalVerdict.detail)
    if (this.deps.isFrozen?.() === true) return blockedResult('deferred', 'frozen')
    // 诊断：说清这条路径的保证边界（每次 turn 投递一行，不刷屏——turn 本来就少见）。
    this.deps.log(`contact: turn 路径提交 ${req.delivery.target.room}（只能保证"提交前状态未变"，正文新鲜度由回合负责、contact 无法复核）`)
    const ticket = createSendTicket()
    const deadline = this.deps.clock.now() + this.timeoutMs
    const deps = this.deps
    const turnTicket = {
      get cancelled(): boolean {
        return ticket.cancelled || deps.isFrozen?.() === true || deps.clock.now() > deadline
      },
    }
    try {
      const accepted = await withTimeout(this.deps.clock, this.timeoutMs, async () =>
        await turns.bookPrompt(req.delivery.target.room, req.text.trim(), turnTicket))
      if (!accepted) return blockedResult('deferred', 'turn-race-lost')
      this.deps.log(`contact: 回合已提交 ${req.delivery.target.room}`)
      return {
        state: 'submitted',
        receipt: { kind: 'none', messageId: null, at: req.now },
        detail: 'turn-submitted',
        attempted: true,
      }
    } catch (error) {
      return resultFromError(error, this.deps.log)
    } finally {
      // F43: timeout/pause means the booking must be void even if ensure returns late.
      ticket.cancel('turn-timeout')
    }
  }
}
