/** 主动消息的**廉价门控**：一条候选"能不能发、现在还是以后、还是永远不发"。
 *
 * 为什么单独一个文件、而且必须是纯函数：
 *   - 它是「最终授权由代码强制」的唯一落点。模型想说什么由 `model.ts` 起草，但
 *     **要不要发不许由模型决定**；把判定关进一个无 IO 的函数，才能在测试里逐条钉住
 *     每个 reason（诊断面板也直接显示它）；
 *   - 调用方（`worker.ts`）必须在**产生任何代价之前**先问它：没过门就不生成草稿、
 *     不建投递记录、不碰平台。"空转不调用模型"不是一句约定，而是这条顺序的结果；
 *   - 无 IO / 无 `Date.now()` / 无随机：`now`、计数、运行时事实全部由参数传入，
 *     同一份输入永远判出同一个结论（与 `core/` 的 R8 同一精神）。
 *
 * 判定**顺序**也是契约（`GATE_STEPS`）：先看候选自己（终态、时间窗），再看授权与
 * 作用域，再看人（免打扰、正在说话），再看预算（冷却、额度），最后看通道。
 * 顺序重要是因为诊断与测试都按"第一个不通过的原因"解释一条候选为什么停在原地——
 * 顺序一变，"为什么没发"的答案就跟着变。
 *
 * 时区换算、免打扰区间与跨日额度在 `./local-time.ts`（纯函数，单独可测）；
 * 本文件只留下判定表本身，读起来应该像一张表。
 *
 * 与 reminders 的边界：到期提醒的唯一投递方是 `features/reminders/runner.ts`，这里对
 * `source === 'explicit-reminder'` 一律 drop（`reminders-owns`）。同一提醒绝不允许
 * 两条路径各发一次；reminders 关着时宁可都不发，也不假装另一条通道会兜住。
 */

import type { ContactConfig } from '../../config/sections/contact.js'
import { countsForToday, inQuiet, zoneClock } from './local-time.js'
import { roomOf, targetMatchesRoom } from './room-target.js'
import type { BudgetProfile, ContactCandidate, ContactCounters, ContactRuntimeFacts } from './types.js'

/**
 * 全部可能的 reason（**稳定字符串**，诊断面板与测试直接断言它）。
 *
 * 命名约定：`动词:对象` 用短横线，不要空格、不要中文——它同时是日志字段与
 * 后台徽章的取值，改成中文会让 `grep` 与快照一起废掉。
 */
export const GATE_REASONS = [
  /** 通过（唯一会走到发送的理由）。 */
  'ok',
  /** 子系统开关关着（默认）：候选留着，等显式启用再判。 */
  'disabled',
  /** 候选已经是终态，迟到结果不得让它复活。 */
  'cancelled',
  'expired',
  'consumed',
  /** 还没到 earliestAt。 */
  'not-due',
  /** 早过了补算视界：停机期间攒下的候选不集中补发（`maxCatchupHours`）。 */
  'stale:restart',
  /** 声称是"用户明确要求/长期许可"，但授权人不全（by/at 缺失）——那是伪造的授权。 */
  'authorization-invalid',
  /** 私聊候选却没有明确用户：不许凭空造一个收件人。 */
  'scope:no-user',
  /** 明确提醒的直发归 reminders；这条候选再发一次就是重复。 */
  'reminders-owns',
  /** 安静时段（含跨午夜）。 */
  'quiet-hours',
  /** 配置的 IANA 时区不认识：宁可判不出免打扰，也不要在错的时区里发。 */
  'timezone-invalid',
  /** 用户刚说过话（settle window）：等这一轮聊完再考虑插话。 */
  'settle:user-active',
  /** 这个房间正有一轮在跑。 */
  'turn-running',
  /** 有工具正在跑（工具运行中插话会打断节奏）。 */
  'tool-running',
  /** 会话级冷却未到。 */
  'cooldown:room',
  /** 全局冷却未到。 */
  'cooldown:global',
  /** 当日全局额度用尽。 */
  'quota:global',
  /** 当日该房间额度用尽。 */
  'quota:room',
  /** 同一件事已经投递过（去重键命中）。 */
  'dedupe',
  /** 连续多条没得到回复：先停下来。 */
  'backoff:unanswered',
  /** 通道不可用（OneBot 没连上）。 */
  'no-channel',
  /** 目标房间与目标本身不自洽（群/私聊与房间键对不上）。 */
  'binding-invalid',
] as const

export type GateReason = (typeof GATE_REASONS)[number]

/** 门控的判定顺序（面板按它解释"先卡在哪一步"；测试按它钉顺序）。 */
export const GATE_STEPS = [
  'state',
  'window',
  'authorization',
  'quiet-hours',
  'contention',
  'cooldown',
  'quota',
  'dedupe',
  'backoff',
  'channel',
] as const

export type GateStep = (typeof GATE_STEPS)[number]

/**
 * 门控结论。
 *
 * `send`：可以进入下一步（起草 → 投递）；`defer`：**环境**现在不允许，保留候选、
 * 下个 tick 再判；`drop`：**候选自身**的问题，这条候选永远不会发（终态、过期、
 * 重复、作用域/绑定无效）。
 *
 * 这个区分不是审美：`defer` 之后还会再问，`drop` 之后不会。把"环境问题"记成
 * `drop` 会丢掉一条本来能发的候选；把"候选问题"记成 `defer` 会让一条过期候选
 * 永远占着额度去重的位置。所以：**能等的是 defer，不能等的是 drop**。
 */
export type GateVerdict = 'send' | 'defer' | 'drop'

export interface GateDecision {
  readonly verdict: GateVerdict
  readonly reason: GateReason
}

export interface GateInput extends BudgetGateInput {
  readonly candidate: ContactCandidate
  /** 已存在投递记录的去重键（与 `runtime.deliveredDedupeKeys` 取并集）。 */
  readonly deliveryDedupeKeys: readonly string[]
}

/**
 * **预算类**检查的最小输入（P2.5-3A-1）：与候选身份无关的那一半——提醒投递也要用同一份
 * 判据、同一本账。`room` 可选：`evaluateGate` 的老调用方不传时从候选推（`roomOf()`），
 * 所以 contact 侧行为一字不变。
 */
export interface BudgetGateInput {
  /** 现在（Unix 毫秒），由调用方注入。 */
  readonly now: number
  readonly config: ContactConfig
  readonly counters: ContactCounters
  /** tick 时现取的运行时事实（不落盘）。 */
  readonly runtime: ContactRuntimeFacts
  /** 房间键；缺省时从 `candidate.target.room` 推（老调用方不用改）。 */
  readonly room?: string
  /** 只有"用候选身份推房间"这一条还要它。 */
  readonly candidate?: ContactCandidate
  /**
   * 谁在问：`proactive`（缺省，= 修复前的判据一字不变）或 `reminder`（到点提醒）。
   * 为什么要分两档：见 `types.ts::OutboundBudgetInput.profile`（这里不重复说明）。
   */
  readonly profile?: BudgetProfile
}

/** 出网前的两道**配置授权**（与候选门控正交：它们管"这条路允不允许存在"）。 */
export interface OutboundAuthorization {
  /**
   * 三态，不是布尔：
   *   - `allowed`：配置放开，可以真发；
   *   - `dry-run`：走完全部流程只记账（诊断里能看到"本来要发什么"），**不投递**；
   *   - `denied`：`allowExternalSend=false` 明确禁止外发。
   *
   * 为什么把 `dry-run` 与 `denied` 分开：前者是"在观察"，后者是"被禁止"。
   * worker 对它们的记账不同（dry-run 记 `skipped:dry-run`，denied 记 `deferred`），
   * 混成 false 之后，运维从诊断里分不出"还没敢开"和"配置写错了"。
   */
  readonly verdict: 'allowed' | 'dry-run' | 'denied'
  /**
   * `verdict === 'allowed'` 的便捷写法（发送侧最常见的那个判断）。
   *
   * 它**不**表示"可以在演练模式下发送"——`dry-run` 时它是 false，正是要防的事。
   */
  readonly allowed: boolean
  /** 给日志与诊断的稳定原因串。 */
  readonly reason: 'ok' | 'dry-run' | 'external-send-denied'
}

/** `authorizeOutbound` 只读这两道开关；收窄参数面让装配与测试都能只造这两个字段。 */
export type OutboundGateConfig = Pick<ContactConfig, 'dryRun' | 'allowExternalSend'>

/**
 * 真发之前还要过这一关：`dryRun` 或 `allowExternalSend === false` 时**一律不许出网**。
 *
 * 为什么与 `evaluateGate` 分开：候选门控回答"这件事该不该说"，这里回答"这台机器
 * 允不允许对外说"。两件事的配置来源、默认值与失败代价都不同，混在一起会让
 * "dryRun 打开"看起来像"这条候选有问题"。**默认两道都关**：`dryRun=true` +
 * `allowExternalSend=false`，安装即静默。
 *
 * worker 侧的记账口径（与本函数的返回值一一对应）：`denied` → 记 `deferred`（不是失败，
 * 是配置禁止）；`dry-run` → 记 `skipped:dry-run` 类诊断、绝不投递；`allowed` → 才走发送。
 */
export function authorizeOutbound(config: OutboundGateConfig): OutboundAuthorization {
  if (config.dryRun) return { verdict: 'dry-run', allowed: false, reason: 'dry-run' }
  if (!config.allowExternalSend) return { verdict: 'denied', allowed: false, reason: 'external-send-denied' }
  return { verdict: 'allowed', allowed: true, reason: 'ok' }
}

/** 一次判定：按 `GATE_STEPS` 顺序问，第一个不通过的就是答案。 */
export function evaluateGate(input: GateInput): GateDecision {
  for (const step of CHECKS) {
    const decision = step(input)
    if (decision !== null) return decision
  }
  return { verdict: 'send', reason: 'ok' }
}

type Check = (input: GateInput) => GateDecision | null
type BudgetCheck = (input: BudgetGateInput) => GateDecision | null

const CHECKS: readonly Check[] = [
  checkState,
  checkWindow,
  checkAuthorization,
  checkQuietHours,
  checkContention,
  checkCooldown,
  checkQuota,
  checkDedupe,
  checkBackoff,
  checkChannel,
]

/** 预算类步骤（3A-1）：`CHECKS` 引用的是同一批函数，所以顺序与 reason 不会漂移。 */
const BUDGET_CHECKS: readonly BudgetCheck[] = [
  checkQuietHours,
  checkContention,
  checkCooldown,
  checkQuota,
  checkBackoff,
  checkChannel,
]

/**
 * **到点提醒**的预算判据（2026-11-10 修复；理由见 `BudgetGateInput.profile`）。
 *
 * 只留 `checkChannel`：通道不通、绑定对不上是"真的发不出去"；免打扰 / 冷却 / 配额 /
 * 未回复退避回答的是"现在适合主动找人说话吗"，而提醒回答的是"主人约好的那一刻到了"。
 * ⚠️ 不是开后门：dryRun 与外发授权在 `features/reminders/index.ts` 自己判，投递成功后
 * **照样**记进同一本账——单向：提醒不借额度，但会消耗额度。
 */
const REMINDER_BUDGET_CHECKS: readonly BudgetCheck[] = [checkChannel]
/** 按档取判据表（缺省 `proactive` ⇒ 与修复前逐条相同）。 */
export function budgetChecksFor(profile: BudgetProfile = 'proactive'): readonly BudgetCheck[] {
  return profile === 'reminder' ? REMINDER_BUDGET_CHECKS : BUDGET_CHECKS
}

/** 只跑预算类检查（给"没有候选"的发送方用）；`send` = 允许出网，reason 与 contact 同名同义。 */
export function evaluateOutboundBudget(input: BudgetGateInput): GateDecision {
  for (const step of budgetChecksFor(input.profile)) {
    const decision = step(input)
    if (decision !== null) return decision
  }
  return { verdict: 'send', reason: 'ok' }
}

// ── 各步 ───────────────────────────────────────────────────────────────────

/** 终态 + 总开关。终态先判：它是候选自己的事实，与"这台机器开没开"无关。 */
function checkState(input: GateInput): GateDecision | null {
  const state = input.candidate.state
  if (state === 'cancelled') return { verdict: 'drop', reason: 'cancelled' }
  if (state === 'consumed') return { verdict: 'drop', reason: 'consumed' }
  if (state === 'expired') return { verdict: 'drop', reason: 'expired' }
  if (!input.config.enabled) return { verdict: 'defer', reason: 'disabled' }
  return null
}

/**
 * 候选自己的时间窗：过期丢、没到点等、早于补算视界的也丢。
 *
 * 补算视界（`maxCatchupHours`）不是"只在重启那一刻判一次"，而是**持续判定**：
 * `now - earliestAt > 视界` 就丢（reason `stale:restart`）。于是"停机八小时攒下三件
 * 事"与"一个候选在池子里滞留了一整天"落在同一格里处理——两者都不该补发。
 * 名字里的 restart 只说明它主要防的是恢复后的补发洪峰，不代表只有那一刻会触发；
 * store 在启动时给滞留候选打的标记也用同一个串，诊断里因此只有一种说法。
 *
 * `maxCatchupHours = 0` = **关闭**这条判定（与 worker 的 `expireStale` 同一口径：
 * 同一个字段在两边含义不一致，就是"配了却没按预期生效"的来源）。
 */
function checkWindow(input: GateInput): GateDecision | null {
  const candidate = input.candidate
  if (input.now >= candidate.expiresAt) return { verdict: 'drop', reason: 'expired' }
  const horizonMs = input.config.maxCatchupHours * 3_600_000
  if (input.config.maxCatchupHours > 0 && input.now - candidate.earliestAt > horizonMs) {
    return { verdict: 'drop', reason: 'stale:restart' }
  }
  if (input.now < candidate.earliestAt) return { verdict: 'defer', reason: 'not-due' }
  return null
}

/**
 * 授权、作用域与目标自洽。
 *
 * 三条都是"候选自身"的问题，所以判 `drop`：伪造的授权、没有收件人的私聊、
 * 对不上号的房间键，等多久都不会自己变对。
 *
 * 授权完整性的判据：`explicit` 与 `standing` **都必须有授权人（`by`）与授权时刻（`at`）**
 * ——连"谁在什么时候许可的"都说不出的授权，与没有授权同义，不能当成许可拿去发消息。
 * `none`（模型/规则自己想到的）是唯一允许空授权的形态，它照样要过后面所有门控。
 */
function checkAuthorization(input: GateInput): GateDecision | null {
  const candidate = input.candidate
  const auth = candidate.authorization
  if (auth.kind !== 'none' && (auth.by === null || auth.at === null)) {
    return { verdict: 'drop', reason: 'authorization-invalid' }
  }
  // 到期提醒的投递方**只有** `features/reminders/runner.ts`：这类候选一律 drop。
  //
  // 为什么不做"提醒通道关了就让 contact 接管"（这是第二轮 F1 的整改，第三轮被审阅判 FAIL
  // 之后按决定撤销）：`reminders.enabled` **不是** runner 的停止事实——`features/reminders/index.ts`
  // 无条件 `runner.start()`，那个开关只在提醒工具里被读。所以把它当"停止事实"去接管，
  // 结果就是同一提醒被两条路径各发一次；而"把 remindersPlugin 整段摘掉"又会连
  // `ReminderStore` 一起摘掉，接管根本没有来源。真正可用的接管需要 runner 侧提供
  // **可验证的所有权/停止接口 + 共享的 occurrence 消费记录（并推进 `fired`/周期）**，
  // 那属于提醒子系统的改动，不在本次范围。
  if (candidate.source === 'explicit-reminder') return { verdict: 'drop', reason: 'reminders-owns' }
  if (candidate.scope.userId === null && !candidate.target.isGroup) {
    return { verdict: 'drop', reason: 'scope:no-user' }
  }
  if (!targetMatchesRoom(candidate)) return { verdict: 'drop', reason: 'binding-invalid' }
  return null
}

/** 时区与免打扰（跨午夜）。时区名不认识时 fail-closed：判不出安静时段就不发。 */
function checkQuietHours(input: BudgetGateInput): GateDecision | null {
  const clock = zoneClock(input.now, input.config.timezone)
  if (clock === null) return { verdict: 'defer', reason: 'timezone-invalid' }
  const ranges = input.config.quietHours
  if (ranges.length > 0 && inQuiet(clock.minutes, ranges)) return { verdict: 'defer', reason: 'quiet-hours' }
  return null
}

/** 竞争：用户刚说话、这个房间正在跑回合、有工具在跑——都不插话。 */
function checkContention(input: BudgetGateInput & { candidate?: ContactCandidate }): GateDecision | null {
  const room = roomOf(input)
  const lastUserAt = input.runtime.lastUserMessageAtByRoom[room] ?? null
  // `now - lastUserAt` 为负（时钟回拨/未来时间戳）也按"刚说过话"处理：宁可少发。
  // A deferred idle candidate must wait again if the owner resumed chatting.
  const idleWindow = input.candidate?.source === 'follow-up' && input.candidate.evidenceSource === 'chat'
    ? (input.config.followUpIdleMs ?? 0) : 0
  if (lastUserAt !== null && input.now - lastUserAt < Math.max(input.config.settleWindowMs, idleWindow)) {
    return { verdict: 'defer', reason: 'settle:user-active' }
  }
  if (input.runtime.turnRunningByRoom[room] === true) return { verdict: 'defer', reason: 'turn-running' }
  if (input.runtime.toolRunning) return { verdict: 'defer', reason: 'tool-running' }
  return null
}

/** 冷却：先看房间（更具体），再看全局。0 = 该级不设冷却。 */
function checkCooldown(input: BudgetGateInput): GateDecision | null {
  const room = roomOf(input)
  const roomLast = input.counters.lastSentAtByRoom[room]
  if (input.config.perRoomCooldownMs > 0 && roomLast !== undefined
    && input.now - roomLast < input.config.perRoomCooldownMs) {
    return { verdict: 'defer', reason: 'cooldown:room' }
  }
  const globalLast = input.counters.lastSentAt
  if (input.config.globalCooldownMs > 0 && globalLast !== null
    && input.now - globalLast < input.config.globalCooldownMs) {
    return { verdict: 'defer', reason: 'cooldown:global' }
  }
  return null
}

/** 额度：先全局后房间（面板上"今天还能说几句"就是这个数）。计数跨日自动归零。 */
function checkQuota(input: BudgetGateInput): GateDecision | null {
  const counts = countsForToday(input.counters, input.now, input.config.timezone)
  if (counts.sentTodayGlobal >= input.config.dailyQuotaGlobal) return { verdict: 'defer', reason: 'quota:global' }
  const used = counts.sentTodayByRoom[roomOf(input)] ?? 0
  if (used >= input.config.dailyQuotaPerRoom) return { verdict: 'defer', reason: 'quota:room' }
  return null
}

/** 重复主题：同一个去重键已经投递过，就不再发第二遍。 */
function checkDedupe(input: GateInput): GateDecision | null {
  const key = input.candidate.dedupeKey
  if (key === '') return null
  if (input.deliveryDedupeKeys.includes(key)) return { verdict: 'drop', reason: 'dedupe' }
  if (input.runtime.deliveredDedupeKeys.includes(key)) return { verdict: 'drop', reason: 'dedupe' }
  return null
}

/** 连续未回复退避：主动消息没人理还继续发，是最快把关系耗光的做法。0 = 不设上限。 */
function checkBackoff(input: BudgetGateInput): GateDecision | null {
  if (input.config.maxUnansweredStreak <= 0) return null
  const streak = input.counters.unansweredStreakByRoom[roomOf(input)] ?? 0
  if (streak >= input.config.maxUnansweredStreak) return { verdict: 'defer', reason: 'backoff:unanswered' }
  return null
}

/**
 * 通道与绑定。
 *
 * `roomBound` 的判据边界（由调用方算，这里只解释它该怎么算）：
 * **房间键与 chatId 自洽 + 会话存在或可安全合成**。一个"还没聊过的 master 私聊"
 * 是合法目标——`registry.get()` 当时返回 undefined 只说明这个房间没被物化过，
 * 不说明它不该存在。所以 store 侧算 `roomBound` 时不能把"没有会话记录"直接当
 * 绑定失效，否则第一条主动私聊会被永久丢掉（`binding-invalid` 是 drop，捡不回来）。
 * 真正该判 false 的只有：群号与房间键互斥、目标号是机器人自己、通道不支持该类目标。
 */
function checkChannel(input: BudgetGateInput): GateDecision | null {
  if (!input.runtime.connected) return { verdict: 'defer', reason: 'no-channel' }
  if (!input.runtime.roomBound) return { verdict: 'drop', reason: 'binding-invalid' }
  return null
}

