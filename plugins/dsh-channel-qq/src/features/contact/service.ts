/** `contact` 服务的实现：**唯一的对外入口**，也是唯一决定"什么能进候选池"的地方。
 *
 * 为什么从 `index.ts` 拆出来：装配（哪个端口接哪个对象）与合同（什么输入算合法、
 * 什么状态算终态、诊断快照长什么样）是两件事。前者要跟着宿主变，后者是三个责任方
 * 一起遵守的约定（`types.ts` 的 `ContactService`）。混在一起时，加一个校验就要动一遍
 * 装配代码，而装配代码没人愿意读第二遍。
 *
 * 三条边界：
 *   1. **没有 `sendNow`**：发送只能由 worker 在门控之后发生。服务面多一个直通口，
 *      "最终授权由代码强制"就成了一句注释；
 *   2. **`propose` 只入库**：模型/规则提建议，是否发由门控判；坏输入（伪造的
 *      `explicit` 授权、没有收件人的私聊、对不上号的房间键）在这里就退回；
 *   3. **`status` 不外泄**：只输出账本与稳定 reason 串，不含凭据、正文以外也不含
 *      URL/原始证据内容（面板与 `/api/contact` 都读它）。
 */

import type { ContactConfig } from '../../config/sections/contact.js'
import type { Clock } from '../../ports/clock.js'
import type { ContactStore } from './store.js'
import type { ContactWorker } from './worker.js'
import { splitRoom } from '../../core/room.js'
import { zoneClock } from './local-time.js'
import { evaluateOutboundBudget } from './gate.js'
import type {
  ContactCandidate,
  ContactCounters,
  ContactRuntimeFacts,
  ContactService,
  ContactStatusSnapshot,
  OutboundAccountInput,
  OutboundBudgetInput,
  OutboundBudgetResult,
  ProposeContactInput,
  ProposeContactResult,
} from './types.js'

/** 服务实现要的全部东西（`config` 是取值函数：后台改完立刻生效）。 */
export interface ContactServiceDeps {
  readonly store: ContactStore
  readonly worker: ContactWorker
  readonly clock: Clock
  readonly log: (line: string) => void
  readonly config: () => ContactConfig
  /** 候选 id 里的随机段（默认 systemRandom；测试注入固定值即可复现 id）。 */
  readonly random: () => number
  /** 通道现在通不通（共享闸门要用；缺省 = true，测试与最小装配不必提供）。 */
  readonly connected?: () => boolean
  readonly sleepEnqueueAllowed?: (candidate: ContactCandidate, counters: ContactCounters) => boolean
}

/** 房间键是否自洽（`group-<号>` / `dm-<号>`，两种历史前缀都认）。 */
function roomBound(room: string): boolean {
  return splitRoom(room) !== null
}

/** 房间键与目标是否描述同一个收件人（`gate.ts`/`sender.ts` 各自还会再复核一次）。 */
function targetAgrees(target: { room: string; isGroup: boolean; chatId: number }): boolean {
  return roomBound(target.room) && target.room.endsWith(`${target.isGroup ? 'group' : 'dm'}-${String(target.chatId)}`)
}

/** 提候选的输入校验：**模型只提建议**，坏输入在这里就退回（返回原因是给人看的）。 */
import { normalizeAdaptiveIntent } from './adaptive-intent.js'

export function validatePropose(input: ProposeContactInput): string | null {
  if (input.evidenceSource === 'planned-followup' && !input.intent) return 'adaptive intent metadata required'
  if (input.intent && (!normalizeAdaptiveIntent(input.intent) || input.source !== 'follow-up'
    || input.evidenceSource !== 'planned-followup' || input.target.isGroup || input.scope.userId !== input.target.chatId
    || input.intent.originSessionId !== `qq-dm-${String(input.target.chatId)}`)) return 'invalid adaptive intent binding'
  if (input.reason.trim() === '') return 'reason 不能为空：候选要能说清"为什么想到这件事"'
  if (input.evidenceSource.trim() === '') return 'evidenceSource 不能为空（提醒/聊天记录/活动回执…）'
  if (input.dedupeKey.trim() === '') return 'dedupeKey 不能为空：否则同一件事会重复发'
  if (!targetAgrees(input.target)) return `目标与房间键对不上：${input.target.room} / ${String(input.target.chatId)}`
  if (input.scope.userId === null && !input.target.isGroup) return '私聊候选必须带 scope.userId（不许凭空造收件人）'
  if (input.authorization.kind === 'explicit' && (input.authorization.by === null || input.authorization.at === null)) {
    return 'explicit 授权必须带 by 与 at（原话与时刻是凭据，不是形容词）'
  }
  if (!Number.isFinite(input.earliestAt) || !Number.isFinite(input.expiresAt)) return 'earliestAt/expiresAt 必须是 Unix 毫秒'
  if (input.expiresAt <= input.earliestAt) return 'expiresAt 必须晚于 earliestAt'
  return null
}

/** 新候选（`version: 1`；之后每次状态变化 +1，旧版本的建议提交会被拒）。 */
function candidateOf(input: ProposeContactInput, id: string, now: number): ContactCandidate {
  return {
    id,
    source: input.source,
    ...(input.intent ? { intent: normalizeAdaptiveIntent(input.intent)! } : {}),
    reason: input.reason.trim().slice(0, 300),
    evidenceSource: input.evidenceSource.trim(),
    evidenceIds: input.evidenceIds ?? [],
    scope: input.scope,
    target: input.target,
    priority: input.priority ?? 100,
    earliestAt: input.earliestAt,
    expiresAt: input.expiresAt,
    dedupeKey: input.dedupeKey,
    version: 1,
    authorization: input.authorization,
    state: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    lastSuppressedReason: null,
  }
}

async function propose(deps: ContactServiceDeps, input: ProposeContactInput): Promise<ProposeContactResult> {
  const problem = validatePropose(input)
  if (problem !== null) return { outcome: 'rejected', candidateId: null, note: problem }
  const now = deps.clock.now()
  const id = `c-${now.toString(36)}-${Math.floor(deps.random() * 46_656).toString(36)}`
  const candidate = candidateOf(input, id, now)
  // **查重与入池必须在同一个事务里**：分成"先 find 再 put"两步时，`start()` 的首拍与
  // 显式 `tick()` 并发（或两个来源同时对同一件事提出候选）都会各自查到"没有"，于是
  // 同一件事在池子里出现两条——第二条只能靠 `cooldown:room` 才没重复发。`store.write`
  // 是"读-改-写"一次的原子操作，去重判据放在它里面才是真的幂等。
  let capped = false
  let sleepBlocked = false
  let existingId: string | null = null
  let existingEvidence: readonly string[] = []
  const inserted = await deps.store.write((ledger) => {
    if (candidate.source === 'health-sleep' && deps.sleepEnqueueAllowed?.(candidate, ledger.counters) !== true) {
      sleepBlocked = true
      return false
    }
    for (const row of Object.values(ledger.candidates)) {
      const sameIntent = candidate.intent && row.intent && row.scope.userId === candidate.scope.userId && ['pending', 'deferred'].includes(row.state) && row.intent.purpose.replace(/\s+/g, '') === candidate.intent.purpose.replace(/\s+/g, '')
      if (row.dedupeKey !== input.dedupeKey && !sameIntent) continue
      existingId = row.id
      existingEvidence = row.evidenceIds
      return false
    }
    if (candidate.intent && Object.values(ledger.candidates).filter(row => row.intent && row.scope.userId === candidate.scope.userId && ['pending', 'deferred'].includes(row.state)).length >= 5) { capped = true; return false }
    ledger.candidates[candidate.id] = candidate
    return true
  })
  if (sleepBlocked) return { outcome: 'rejected', candidateId: null, note: 'health:enqueue-gate' }
  if (capped) return { outcome: 'rejected', candidateId: null, note: 'followup:too-many-open-intents' }
  if (!inserted) {
    if (existingId === null) {
      // 事务里没改动却没找到重复：只可能是并发下被别人取消/清理，按"已存在"处理即可。
      return { outcome: 'duplicate', candidateId: null, note: '同一件事已有候选（本次未改动）' }
    }
    // 同一件事再次被想起：只强化证据，不覆盖既有的时间窗与授权。
    const merged = [...new Set([...existingEvidence, ...(input.evidenceIds ?? [])])]
    if (merged.length !== existingEvidence.length) {
      await deps.store.patchCandidate(existingId, { evidenceIds: merged }, now).catch(() => false)
    }
    return { outcome: 'duplicate', candidateId: existingId, note: '同一件事已有候选（只合并了证据）' }
  }
  deps.log(`contact: 候选 ${id} 入库（${candidate.source} / ${candidate.target.room}）`)
  return { outcome: 'accepted', candidateId: id, note: '已入库；发不发由门控决定' }
}

/** 取消：终态不可回滚（已取消/已过期的再取消返回 false，幂等）。 */
async function cancel(deps: ContactServiceDeps, candidateId: string, reason: string): Promise<boolean> {
  const candidate = deps.store.candidate(candidateId)
  if (candidate === undefined) return false
  if (candidate.state !== 'pending' && candidate.state !== 'deferred') return false
  const now = deps.clock.now()
  const note = `cancelled:${reason}`.slice(0, 200)
  await deps.store.patchCandidate(candidateId, { state: 'cancelled', lastSuppressedReason: note }, now)
  await deps.store.noteReason(`${candidateId} ${note}`, now)
  deps.log(`contact: 候选 ${candidateId} 已取消（${reason}）`)
  return true
}

/** 诊断快照：活着的候选在前，投递按最近更新排序（面板直接渲染）。 */
function status(deps: ContactServiceDeps): ContactStatusSnapshot {
  const state = deps.store.state
  const config = deps.config()
  const liveFirst = (row: ContactCandidate): number => (row.state === 'pending' || row.state === 'deferred' ? 0 : 1)
  return {
    enabled: config.enabled,
    dryRun: config.dryRun,
    paused: deps.worker.isPaused,
    lease: deps.store.lease ?? state.lease,
    candidates: deps.store.listCandidates()
      .sort((a, b) => (liveFirst(a) - liveFirst(b)) || (a.priority - b.priority) || (a.earliestAt - b.earliestAt))
      .slice(0, 100),
    deliveries: deps.store.listDeliveries().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50),
    counters: state.counters,
    recentReasons: state.recentReasons.slice(0, 50),
  }
}

/** 装配成 `ContactService`（每个动作一个函数，见上面各自的注释）。 */
export function createContactService(deps: ContactServiceDeps): ContactService {
  return {
    propose: async (input) => await propose(deps, input),
    cancel: async (candidateId, reason) => await cancel(deps, candidateId, reason),
    setPaused: (paused) => {
      if (paused) deps.worker.pause()
      else deps.worker.resume()
    },
    status: () => status(deps),
    outboundBudget: async (input) => await outboundBudget(deps, input),
    account: async (input) => await account(deps, input),
  }
}

/**
 * **共享闸门**（P2.5-3A-1）：别的发送方（目前是提醒 runner）在真发之前问一句
 * "现在这台机器允许再往外发一条吗"。
 *
 * 用的是 `gate.evaluateOutboundBudget()`——**同一个函数**、同一本账
 * （`contact.json` 的 counters），所以配额/冷却/免打扰只有一套判据。
 * 它**不**看候选身份（终态/时间窗/授权/去重），那些只属于 contact 自己的候选。
 *
 * 运行时事实里只保留与预算有关的几项：通道连通性（由装配注入）、房间绑定（房间键自洽）、
 * 以及"这个房间现在有没有回合/工具在跑"——提醒不参与那两条，所以给空表（= 没有竞争）。
 * `toolRunning`/`turnRunning` 取**真实**值的话要读 inbound 的运行时状态，那属于 contact
 * 自己的 tick；提醒这一侧保守地当作"没有竞争"，理由是提醒是主人自己定的时刻承诺。
 */
async function outboundBudget(deps: ContactServiceDeps, input: OutboundBudgetInput): Promise<OutboundBudgetResult> {
  const config = deps.config()
  const now = input.now ?? deps.clock.now()
  const snapshot = await deps.store.snapshot()
  const runtime: ContactRuntimeFacts = {
    connected: deps.connected?.() ?? true,
    roomBound: roomBound(input.room),
    lastUserMessageAtByRoom: {},
    turnRunningByRoom: {},
    toolRunning: false,
    deliveredDedupeKeys: Object.values(snapshot.outbox)
      .filter((row) => row.state === 'submitted' || row.state === 'confirmed' || row.state === 'unknown')
      .map((row) => row.dedupeKey),
  }
  const decision = evaluateOutboundBudget({
    now,
    config,
    counters: snapshot.counters,
    runtime,
    room: input.room,
  })
  const allowed = decision.verdict === 'send'
  if (!allowed) deps.log(`contact: 共享闸门拦下 ${input.sender} → ${input.room}（${decision.reason}）`)
  return { allowed, reason: decision.reason, verdict: decision.verdict }
}

/**
 * **共享账本**（P2.5-3A-1）：别的发送方真发成功之后，把这一条记进同一本账。
 *
 * 为什么必须共用：配额（`dailyQuotaGlobal`/`dailyQuotaPerRoom`）与冷却
 * （`perRoomCooldownMs`/`globalCooldownMs`）读的就是这几个字段。提醒自己记一套等于
 * "两组计数器各算各的"，主人看到的"今天还能说几句"就是假的。
 *
 * 只记**成功投递**（`confirmed`/`submitted`/`unknown` 中真正交给平台的那一次）；
 * 被闸门拒、dryRun、失败都不记（失败与 unknown 的账由调用方按 contact 同语义处理：
 * unknown 记一次、之后不重发）。
 *
 * **这条路径会抛什么、不会抛什么**（round16 §3.4 + round18 裁决，别在这里"顺手再兜一层"）：
 *   - **无租约**：不抛。只记一条日志就返回（本实例没有写这本账的资格，账少了可以补）；
 *   - **有租约但已失效（`StaleLeaseError`）、落盘 IO 失败**：**照常抛**。那是真实的归属
 *     失效/磁盘故障，不是可修复的记账缺口；调用方（`reminders/index.ts` 的 `sendOnce`）
 *     已 `.catch` 记日志，后果是"少记一笔账"而不是"多发一条"。把这类异常也吞掉，等于
 *     把"这个实例不该再写账"这件事藏起来，比现在更危险。
 */
async function account(deps: ContactServiceDeps, input: OutboundAccountInput): Promise<void> {
  const now = input.now ?? deps.clock.now()
  const config = deps.config()
  // P2.5 round16 §3.4：**没有租约 = 这笔不记账，也不许抛**。
  // 旧写法把"没租约"折成 `epoch = 0` 交给 `store.write()`，而 `keeper.assert(0)` 对
  // "手上没有任何租约"是一律抛 `StaleLeaseError` 的（lease.ts 的 assert）。调用方恰恰是
  // 提醒 runner 的"已经真发成功"记账路径：于是一次**成功投递**会被一个纯记账问题改写成
  // "记账失败"，最坏的结果是整个提醒侧停表。这里改成诚实降级：说清这笔没记、为什么没记，
  // 然后照常返回——账少了可以补，投递结论不能被子系统的 IO 反过来污染。
  const lease = deps.store.lease
  if (lease === null) {
    deps.log(`contact: 共享账本跳过 ${input.sender} → ${input.room}（本实例没有租约，这笔没记账；不是发送失败）`)
    return
  }
  const day = zoneClock(now, config.timezone)?.day ?? ''
  if (day === '') {
    // 时区算不出本地日：不记（与门控的 fail-closed 同口径，宁可少记一笔也不写错日键）。
    deps.log(`contact: 共享账本跳过 ${input.sender}（时区 ${config.timezone} 算不出本地日）`)
    return
  }
  await deps.store.write((ledger) => {
    const counters = ledger.counters
    const sameDay = counters.day === day
    const sentByRoom = sameDay ? { ...counters.sentTodayByRoom } : {}
    sentByRoom[input.room] = (sentByRoom[input.room] ?? 0) + 1
    ledger.counters = {
      ...counters,
      day,
      sentTodayGlobal: (sameDay ? counters.sentTodayGlobal : 0) + 1,
      sentTodayByRoom: sentByRoom,
      lastSentAt: now,
      lastSentAtByRoom: { ...(sameDay ? counters.lastSentAtByRoom : {}), [input.room]: now },
    }
    return true
  }, lease.epoch)
  deps.log(`contact: 共享账本记一次 ${input.sender} → ${input.room}（${input.reason}）`)
}
