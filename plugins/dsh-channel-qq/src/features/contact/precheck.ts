/** 发送前的**本地判据**：这一步还允不允许发（暂停之外的全部静态条件）。
 *
 * 从 `sender.ts` 拆出来的判据：这些规则只看"请求 + 配置 + 三个端口"，没有任何 I/O，
 * 因此可以在没有平台、没有账本、没有时钟推进的测试里逐条钉住；而 `sender.ts` 自己要管
 * 复核顺序、队列、令牌与结算。规则表最怕的是"读代码时被流程打断"，拆开之后两边都好读。
 *
 * 与 `gate.ts` 的分工：门控回答"**该不该**说这件事"（时间窗、额度、冷却、去重、未回复
 * 退避）；这里回答"**此刻能不能发出去**"（绑定是否自洽、作用域是否越权、会话是否在跑、
 * 通道是否可用、出网是否被授权、正文是否为空）。两者不重复，缺一条都会出事故：
 * 只有门控会发出越权消息，只有本地判据会忽略免打扰。
 */

// 新鲜度的判据本体在 `draft-freshness.ts`（版本闸，Codex P1/R5）；这里只保留"最后一道闸"的位置。
import { compareRevision } from './draft-freshness.js'
import type { ContactConfig } from '../../config/sections/contact.js'
import { authorizeOutbound } from './gate.js'
import { inQuiet, zoneClock } from './local-time.js'
import type {
  ContactGuardVerdict,
  ContactIdentity,
  ContactSendRequest,
  ContactTransport,
  ContactTurnPort,
} from './sender.js'
import type { ContactCandidate, ContactDelivery, ContactLease, ContactRuntimeFacts, ContactTarget } from './types.js'

/** 本地判据要的三样惰性端口（`ContactSenderDeps` 天然满足它）。 */
export interface PrecheckDeps {
  readonly identity: () => ContactIdentity
  readonly transport: () => ContactTransport | undefined
  readonly turns: () => ContactTurnPort | undefined
  /**
   * 这一条投递**必须**带起草冻结版本吗（C0 的 `direct` 装配为 `true`）。
   *
   * 缺失版本 = 无法比较 = 拒绝（`draft:stale:unverifiable`），见 `freshnessIssue`。
   */
  readonly requireDraftRevision?: () => boolean
}

/** 最终同步判定额外要的几样（全部**同步**：一个 await 都不能有）。 */
export interface FinalGuardDeps extends PrecheckDeps {
  readonly nowMs: () => number
  readonly liveConfig?: () => ContactConfig
  readonly refresh: (candidateId: string, room: string) => {
    readonly runtime: ContactRuntimeFacts
    /** R5-1: production passes the candidate re-read **after** the lease assert. */
    readonly candidate?: ContactCandidate
  }
  /**
   * 本实例当前持有的租约（**同步内存视图**）。
   *
   * 为什么最后一道还要看它：`assertLease` 是异步的（读锁文件），它是 `recheckAtSend` 里
   * 的**最后一个 await**；而"最后一个 await 之后、`sendTo` 之前"这段窗口里仍然可能发生
   * 暂停/卸载/租约到期/被同进程的新代次取代。这一层用内存租约把那段窗口再收一次
   * （generation + `expiresAt` + owner 三样）。缺省 = 不校验（最小 rig）。
   */
  readonly lease?: () => ContactLease | null
  /** 账本里这条投递行的**同步**视图（`store.state.outbox[id]`）：确认没有被别人 claim。 */
  readonly deliveryRow?: (id: string) => ContactDelivery | undefined
  /**
   * 执行点的**异步**版本复核（人设摘要 / 历史尾游标）是否已经跑过并通过。
   *
   * `direct` 起草的草稿如果"没被复核过"就放行，等于把 R5 的版本闸变成可选项——所以
   * 最后这一层要求它**留下戳**：没有戳 = `draft:stale:unverified`（拒绝，不是放行）。
   */
  readonly draftAttested?: () => boolean
}

/** 房间键与目标自洽（两种历史前缀都认，与 `gate.ts` 的同名判断同口径）。 */
export function targetMatchesRoom(target: ContactTarget): boolean {
  if (target.channel !== 'qq') return false
  const kind = target.isGroup ? 'group' : 'dm'
  return target.room.endsWith(`${kind}-${String(target.chatId)}`)
}

/**
 * 作用域复核：人格/世界必须一致；私聊的收件人必须就是候选指向的那个人。
 *
 * 群聊里 `scope.userId` 只表示"这件事关于谁"，不要求与房间相同——把群聊也卡成
 * "候选人 == 房间号"会让所有群候选都被判越权。
 */
export function scopeIssue(candidate: ContactCandidate, target: ContactTarget, identity: ContactIdentity): string | null {
  const scope = candidate.scope
  if (scope.personaId !== '' && scope.personaId !== identity.personaId) return 'scope:persona'
  if (scope.worldId !== identity.worldId) return 'scope:world'
  if (scope.userId === null) return null
  if (target.isGroup) return null
  return target.chatId === scope.userId ? null : 'scope:user'
}

/**
 * **新鲜度复核**（P2.5-3D / Slice C0-7；Codex 预发布审查 P1/R5 之后升级为**版本闸**）。
 *
 * 判据本体在 `draft-freshness.compareRevision`（同步、零 `await`，逐项比：候选 `version`
 * 与 `updatedAt`、房间游标 `lastUserAt`+`queueDepth`、绑定标识、冻结摘要是否存在）。
 * 本函数只负责一件事：**决定"没有冻结版本时算不算问题"**。
 *
 * 为什么 "没有 revision" 要分两种处置：
 *   - C0 的 `direct` 装配（`requireRevision=true`）**必须**带上 `revision`，缺席 = 无法比较
 *     = 拒绝（`draft:stale:unverifiable`）。这是审查点名要求的"缺失按保守处理"，
 *     否则一个装配漏接就会静默退回"只比时间戳"的老闸。
 *   - `turn` 模式与历史用例没有起草上下文，按老口径（两个 `>`）判，行为与修复前一致。
 *
 * 一律 `deferred` 而不是 `cancelled`：下一拍会重新起草（`pickDue` 会重新捞 `deferred`），
 * 候选不丢。
 */
export function freshnessIssue(
  req: ContactSendRequest,
  candidate: ContactCandidate,
  runtime: ContactRuntimeFacts,
  requireRevision = false,
): ContactGuardVerdict | null {
  if (req.revision === undefined && requireRevision) {
    return { state: 'deferred', detail: 'draft:stale:unverifiable' }
  }
  return compareRevision(req, candidate, runtime)
}

/**
 * 本地复核：返回 `null` 表示"这一步没有理由拦"，否则是"如果现在停下该记成什么"。
 *
 * `deferred`（下轮还有机会）与 `cancelled`（永远不会自己变好）的分界是本文件最重要的
 * 信息：绑定失效、越权、空正文属于后者，重试三轮只会把同一条错发三次。
 */
export function verdictOf(req: ContactSendRequest, config: ContactConfig, deps: PrecheckDeps): ContactGuardVerdict | null {
  const { candidate, delivery, now, runtime, text } = req
  const target = delivery.target
  const room = target.room
  if (candidate.intent && config.adaptiveFollowUp === false) return { state: 'deferred', detail: 'followup:disabled' }
  if ((config.allowedRooms?.length ?? 0) > 0 && !config.allowedRooms?.includes(room)) return { state: 'cancelled', detail: 'room-not-allowed' }
  if (candidate.state !== 'pending' && candidate.state !== 'deferred') return { state: 'cancelled', detail: `candidate:${candidate.state}` }
  if (now >= candidate.expiresAt) return { state: 'cancelled', detail: 'candidate:expired' }
  if (!targetMatchesRoom(target)) return { state: 'cancelled', detail: 'binding-invalid' }
  const health = candidate.source === 'health-sleep'
  if (delivery.mode !== (health ? 'direct' : config.sendMode)) return { state: 'deferred', detail: 'mode-changed' }
  const scope = scopeIssue(candidate, target, deps.identity())
  if (scope !== null) return { state: 'cancelled', detail: scope }
  // 起草之后世界变了 → 旧草稿作废（deferred，等下一拍重新起草）。
  const stale = freshnessIssue(req, candidate, runtime, !health && deps.requireDraftRevision?.() === true)
  if (stale !== null) return stale
  const lastUserAt = runtime.lastUserMessageAtByRoom[room] ?? null
  if (lastUserAt !== null && now - lastUserAt < config.settleWindowMs) return { state: 'deferred', detail: 'settle:user-active' }
  if (runtime.turnRunningByRoom[room] === true) return { state: 'deferred', detail: 'turn-running' }
  if (!runtime.connected) return { state: 'deferred', detail: 'no-channel' }
  if (!runtime.roomBound) return { state: 'cancelled', detail: 'binding-invalid:room' }
  // 出网授权（dryRun / allowExternalSend）由 gate.ts 判定，这里只消费结论。
  const authorization = authorizeOutbound(config)
  if (!authorization.allowed) return { state: 'deferred', detail: authorization.reason }
  if (text.trim() === '') return { state: 'cancelled', detail: 'empty-text' }
  if (delivery.mode === 'direct' && deps.transport() === undefined) return { state: 'deferred', detail: 'no-channel' }
  if (delivery.mode === 'turn' && deps.turns() === undefined) return { state: 'failed', detail: 'no-turn-port' }
  return null
}

/**
 * **最后一个同步判定**（F42）：在最后一次 `await` 返回之后、`sendTo` 之前跑。
 *
 * 为什么必须单独一层：完整门控（`evaluateGate`）跑在"最后一轮 I/O 之前"，而那一轮 I/O
 * （读锁文件、读盘快照）本身要花时间。Codex 实测的两个反例都发生在这段时间里：
 * 假时钟从 22:59:55 走到 23:00:05（进入免打扰），或者在最后一轮快照里把 `enabled` 置
 * false——两者都被"拿旧结论放行"了。
 *
 * **这一层不允许有 await**，否则窗口又回来了。它只看三样能同步拿到的东西：
 * 现在（`clock.now()`）、当前配置（`config()`）、本地房间事实（`refresh()`，内存快照）。
 *
 * 诚实的边界：**最后一次同步判定之后仍未发生的事件无法再观测**——那条消息从这一刻起
 * 已经交给平台/回合了。这条上限由"跨进程租约 + 平台接受语义"决定，本层只能减少窗口。
 */
export function finalGuard(
  req: ContactSendRequest,
  config: ContactConfig,
  deps: PrecheckDeps,
  now: number,
  runtime: ContactRuntimeFacts,
): ContactGuardVerdict | null {
  // 开关：最后一刻被关掉（后台页面、reload）就不发。
  if (!config.enabled) return { state: 'deferred', detail: 'disabled' }
  // 免打扰：与 `gate.ts` 用同一对纯函数（`zoneClock` + `inQuiet`），不复制规则。
  const clock = zoneClock(now, config.timezone)
  if (clock === null) return { state: 'deferred', detail: 'timezone-invalid' }
  if (config.quietHours.length > 0 && inQuiet(clock.minutes, config.quietHours)) {
    return { state: 'deferred', detail: 'quiet-hours' }
  }
  // 其余本地判据（候选过期、绑定、作用域、settle 窗、回合占用、通道、出网授权、空正文）。
  return verdictOf({ ...req, now, runtime }, config, deps)
}

/**
 * `finalGuard` 的装配侧入口：**自己重取**现在、当前配置与本地房间事实（全部同步）。
 *
 * 为什么单独一个函数而不是在 sender 里就地写：这两步"重取"的语义（时钟、配置 getter、
 * refresh 都是同步的）需要被一眼看见——如果有人日后把其中任何一个换成 await，这个
 * 函数就不该再叫 `final` 了。
 */
/**
 * **最后一步**（F42 + Codex 增量复审 P1）：`sendTo` 之前的**同步、零 await** 判定。
 *
 * 三连顺序（都是同步读，不看盘、不看网络）：
 *   ① **所有权**：租约还在（generation = `delivery.epoch`、`expiresAt` 未过、owner 对得上）；
 *      投递行仍是**我领取的那一条**（`running` + epoch + owner 三项）；
 *   ② **版本戳**：`direct` 起草的草稿必须带冻结版本，且异步复核（人设/历史）已经打过戳；
 *   ③ 原有的本地判据（开关/免打扰/过期/绑定/作用域/新鲜度/竞争/通道/授权/空正文）。
 *
 * 为什么这三样必须在"最后一个 await 之后"：`recheckAtSend` 里有真实 I/O（读锁文件、读盘快照、
 * 读人设文档、读 history 缓存）。R5 第一版把异步复核放在租约断言**之后**，于是那段窗口里
 * 发生了接管也照样会发出去——这正是本次要修的顺序回归。现在约定：**任何异步读资料都在
 * `readSnapshot` 之前**，这一层之后只剩 `sendTo` 本身。
 */
export function finalSyncGuard(req: ContactSendRequest, fallback: ContactConfig, deps: FinalGuardDeps): ContactGuardVerdict | null {
  const now = deps.nowMs()
  const ownership = ownershipAtFinal(req, now, deps)
  if (ownership !== null) return ownership
  const fresh = deps.refresh(req.delivery.candidateId, req.delivery.target.room)
  const config = deps.liveConfig?.() ?? fallback
  // R5-1: the last synchronous refresh is authoritative. Missing means deleted;
  // terminal means cancelled. Never fall back to the entry candidate here.
  if (fresh.candidate === undefined) return { state: 'cancelled', detail: 'candidate:missing' }
  if (fresh.candidate.state !== 'pending' && fresh.candidate.state !== 'deferred') {
    return { state: 'cancelled', detail: `candidate:${fresh.candidate.state}` }
  }
  return finalGuard({ ...req, candidate: fresh.candidate, runtime: fresh.runtime, now }, config, deps, now, fresh.runtime)
}

/**
 * 最后一道里的**所有权 + 版本戳**三连（全部同步）。
 *
 * 诚实的边界：跨进程"别人刚抢走租约"只有读锁文件才看得见（那是异步的，不在这一层）。
 * 这一层能同步看见的是：**租约没了**（暂停/卸载释放）、**代次变了**（同进程内被新代次取代）、
 * **过期了**（`now >= expiresAt`，这正是"旧实例在接管之后仍然去发"的典型形态）、
 * 以及投递行被别人改过状态。跨进程那一半由 `readSnapshot` 里的 `assertLease`（最后一个 await）
 * 负责——两层各管一段窗口，谁都不假装覆盖全部。
 */
function ownershipAtFinal(req: ContactSendRequest, now: number, deps: FinalGuardDeps): ContactGuardVerdict | null {
  if (deps.lease !== undefined) {
    const lease = deps.lease()
    if (lease === null) return { state: 'deferred', detail: 'lease-lost' }
    if (lease.epoch !== req.delivery.epoch) return { state: 'deferred', detail: 'lease-epoch-changed' }
    if (now >= lease.expiresAt) return { state: 'deferred', detail: 'lease-expired' }
    if (req.delivery.leaseOwner !== `${lease.hostId}#${String(lease.pid)}`) {
      return { state: 'deferred', detail: 'lease-owner-changed' }
    }
  }
  if (deps.deliveryRow !== undefined) {
    const row = deps.deliveryRow(req.delivery.id)
    if (row === undefined) return { state: 'cancelled', detail: 'delivery:missing' }
    if (row.state !== 'running' || row.epoch !== req.delivery.epoch || row.leaseOwner !== req.delivery.leaseOwner) {
      return { state: 'deferred', detail: `delivery:${row.state}` }
    }
  }
  if (req.candidate.source !== 'health-sleep' && deps.requireDraftRevision?.() === true) {
    // `direct` 的草稿：要么带冻结版本且被异步复核过，要么不发（缺失 ≠ 放行）。
    if (req.revision === undefined) return { state: 'deferred', detail: 'draft:stale:unverifiable' }
    if (deps.draftAttested?.() !== true) return { state: 'deferred', detail: 'draft:stale:unverified' }
  }
  return null
}
