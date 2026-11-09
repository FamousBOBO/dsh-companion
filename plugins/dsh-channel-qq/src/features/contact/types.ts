/** 主动消息（contact）的**共享词汇**：候选、投递账本、租约、计数与运行时事实。
 *
 * 为什么单独一个 types 文件：这套东西有四个责任方，各自只该看见形状、不该互相 import 实现——
 *   - `gate.ts`（contract-policy）：只看候选 + 计数 + 运行时事实，算"发 / 缓 / 丢"；
 *   - `model.ts`（contract-policy）：只看候选，写草稿；预算与退避在它自己那儿；
 *   - `store.ts` / `worker.ts` / `sender.ts`（store-delivery）：只管存取与投递；
 *   - `test/contact-*.test.ts`（verify-review）：用假时钟/假平台造这些形状。
 *
 * 三条贯穿全文件的约定（与 [06 · 运行与数据契约](../../../../../../architecture-wiki/06-runtime-and-contracts.md)
 * 和 [12 · 日程与心跳](../../../../../../architecture-wiki/12-agenda-heartbeat-development.md) 对齐）：
 *   1. **模型只提建议**：`authorization` 由代码判定；`source` 只说明"为什么想到这件事"，
 *      不构成发送许可。普通计划陈述（"明天去文庙"）不是提醒授权。
 *   2. **状态是账本不是日志**：候选与投递各自有终态；`confirmed` 的确切含义只有一种——
 *      **平台接受了这条消息**，不等于送达，更不等于已读。
 *   3. **所有时间都是 Unix 毫秒**；本地日/时区换算由调用方按配置的 IANA 时区做，
 *      这里不出现 `Date.now()`（测试注入假时钟才能复现）。
 */

/** 候选从哪来：只描述"为什么想到这件事"，不构成授权。 */
export type ContactSourceKind =
  /** 用户明确要求过（"明早提醒我"）。注意：**到期提醒的直发仍归 reminders**，这里只是候选来源标签。 */
  | 'explicit-reminder'
  /** 已有对话里留下的事项，到了该跟进的时候。 */
  | 'follow-up'
  /** 真实活动回执（工具/适配器给出的事实），不是"她觉得自己做了"。 */
  | 'activity-receipt'
  /** 有依据的分享意图（例如刚读到的东西与这位用户相关）。 */
  | 'share-intent'
  | 'health-sleep'

/**
 * 作用域：候选只能在这三者同时匹配的情况下被投递。
 *
 * `userId` 为 null 表示"这个候选不属于任何具体用户"——首版**不允许**这种候选被投递到私聊，
 * 群聊候选也必须显式带 `target.room`。空世界统一用 `''`（与既有记忆 viewer 的约定一致），
 * 免得可空字段在去重时漏掉。
 */
export interface ContactScope {
  readonly userId: number | null
  /** 人格/角色 id（当前基座是单人格，填固定值，但结构上留位）。 */
  readonly personaId: string
  /** 世界 id；空串 = 默认世界。 */
  readonly worldId: string
}

/** 目标通道与会话。首版只有 QQ；别的通道要另外接，不能靠改这里"假装支持"。 */
export interface ContactTarget {
  readonly channel: 'qq'
  /** 房间键，沿用既有约定：`qq-group-<群号>` / `qq-dm-<QQ号>`。 */
  readonly room: string
  readonly isGroup: boolean
  /** 群号或对方 QQ 号（与 `room` 必须自洽，发送前复核）。 */
  readonly chatId: number
}

/**
 * 授权：**只有代码能写**。
 *
 * - `explicit`：用户原话说要联系/提醒（带原话与时间），候选可以按约定时刻发；
 * - `standing`：用户给过长期许可（例如"有事可以找我"）——仍受免打扰与额度约束；
 * - `none`：模型或规则自己想到的（follow-up / share-intent 的常态），
 *   只能在**闲聊门控**全部通过时发，且必须受额度与退避约束。
 */
export interface ContactAuthorization {
  readonly kind: 'explicit' | 'standing' | 'none'
  /** 授权人 QQ；`none` 时为 null。 */
  readonly by: number | null
  /** 授权时刻（Unix 毫秒）；`none` 时为 null。 */
  readonly at: number | null
  /** 用户原话摘录（用于诊断与事后核对）；`none` 时为 null。**不要把推断写成原话**。 */
  readonly quote: string | null
}

/**
 * 候选状态。
 *
 * `pending` 等待 earliestAt；`deferred` 被门控推迟（仍可能复活）；
 * `cancelled` / `expired` / `consumed` 是终态——**迟到结果不得让它们复活**。
 */
export type ContactCandidateState = 'pending' | 'deferred' | 'cancelled' | 'expired' | 'consumed'

/** 一个联系候选（"是否该找 TA 说话"的最小记账单位）。 */
import type { AdaptiveIntent } from './adaptive-intent.js'

export interface ContactCandidate {
  readonly intent?: AdaptiveIntent
  /** `c-<base36 时间>-<随机>`；稳定、可诊断，不参与权限判定。 */
  readonly id: string
  readonly source: ContactSourceKind
  /** 一句话原因（给诊断面板看，也给未来的自己看）。 */
  readonly reason: string
  /** 证据来源的**命名空间**（`reminders` / `chatlog` / `activity:<name>` / `memory:<id>`…）。 */
  readonly evidenceSource: string
  /** 具体证据 id 列表（可为空，但 `evidenceSource` 不得为空串）。 */
  readonly evidenceIds: readonly string[]
  readonly scope: ContactScope
  readonly target: ContactTarget
  /** 优先级：小的先评估（0 = 最高）。同日免打扰结束后按它排序。 */
  readonly priority: number
  /** 最早可以发（Unix 毫秒）。 */
  readonly earliestAt: number
  /** 过了这个时刻就只能丢（Unix 毫秒）。 */
  readonly expiresAt: number
  /** 去重键：同一件事只该有一个候选（`reminder:<id>` / `followup:<room>:<topic>`）。 */
  readonly dedupeKey: string
  /** 乐观并发版本：每次状态变化 +1；旧版本的建议提交必须被拒。 */
  readonly version: number
  readonly authorization: ContactAuthorization
  readonly state: ContactCandidateState
  /** 进入门控的次数（用于诊断；不等于发送尝试）。 */
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
  /** 最近一次被抑制的原因（门控 reason；`null` = 还没被评估过）。 */
  readonly lastSuppressedReason: string | null
}

/**
 * 投递状态机：
 *
 * ```
 * pending → running → submitted → confirmed
 *    ↘         ↘         ↘
 *  deferred   failed    unknown
 * ```
 *
 * 另外任何非终态都可以被 `cancelled`；`deferred` 用来表示"这一轮没轮到"，
 * 与 `failed`（有明确错误）分开，避免把并发/额度问题记成故障。
 *
 * **`confirmed` 只表示平台接受了这条消息**（拿到了平台回执/receipt），
 * 不表示对方收到、更不表示已读。没有回执能力的通道只能停在 `submitted`。
 */
export type ContactDeliveryState =
  | 'pending'
  | 'running'
  | 'submitted'
  | 'confirmed'
  | 'unknown'
  | 'failed'
  | 'cancelled'
  | 'deferred'

/** 平台回执。`kind` 写清楚"我们到底知道多少"。 */
export interface ContactReceipt {
  /** `platform-accepted` = 平台接口返回成功（可能带 message id）；`none` = 拿不到回执。 */
  readonly kind: 'platform-accepted' | 'none'
  /** 平台消息 id（OneBot `message_id`）；拿不到时为 null。 */
  readonly messageId: number | null
  readonly at: number
}

/** 一条投递记录（outbox 的一行）。文本与候选解耦：候选可以没有草稿就过期。 */
export interface ContactDelivery {
  readonly id: string
  readonly candidateId: string
  /** 从候选继承的去重键：跨 tick/跨进程去重都靠它。 */
  readonly dedupeKey: string
  readonly target: ContactTarget
  readonly scope: ContactScope
  /** 最终要发出去的短消息（经门控与长度约束后的版本）。 */
  readonly text: string
  readonly state: ContactDeliveryState
  /** 真实发送尝试次数（不含门控抑制）。 */
  readonly attempts: number
  /** 当前持有租约的实例（`<hostId>#<pid>`）；无租约为 null。 */
  readonly leaseOwner: string | null
  /** 领取时的运行代次；提交时与最新代次比对，旧代次不得写入。 */
  readonly epoch: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly submittedAt: number | null
  readonly confirmedAt: number | null
  readonly receipt: ContactReceipt | null
  /** 最近一次错误（截断后入库，便于诊断；不要放凭据）。 */
  readonly lastError: string | null
  /** 投递模式：`turn` = 既有会话回合（人格包渲染，无回执能力）；`direct` = 直发（有 message id）。 */
  readonly mode: 'turn' | 'direct'
}

/**
 * 调度租约：同一时刻只允许一个实例推进 tick。
 *
 * 跨进程靠独占创建 `<dshHome>/channel-qq/contact.lock`；`epoch` 单调递增，
 * 旧代次即使复活也不能提交（JavaScript 单例替代不了跨进程独占，见 12 页 §心跳）。
 */
export interface ContactLease {
  readonly hostId: string
  readonly pid: number
  /** 单调递增的运行代次；每次成功取得租约 +1。 */
  readonly epoch: number
  readonly acquiredAt: number
  /** 过期时刻；过了它别的实例可以接管（并 +1 代次）。 */
  readonly expiresAt: number
}

/** 落在账本里的计数（跨重启保留；`day` 变了就归零）。 */
export interface ContactCounters {
  /** 本地日键 `YYYY-MM-DD`（按配置时区）。 */
  readonly day: string
  readonly sentTodayGlobal: number
  /** 房间键 → 当日已发条数。 */
  readonly sentTodayByRoom: Readonly<Record<string, number>>
  /** 全局上次成功投递时刻（Unix 毫秒）。 */
  readonly lastSentAt: number | null
  /** 房间键 → 上次成功投递时刻。 */
  readonly lastSentAtByRoom: Readonly<Record<string, number>>
  /** 房间键 → 连续未收到回复的主动消息条数（收到用户消息即清零）。 */
  readonly unansweredStreakByRoom: Readonly<Record<string, number>>
  /** 当日模型草稿调用次数（共享预算，空转不消耗）。 */
  readonly draftCallsToday: number
  /** 上一次草稿失败的时刻（用于有界退避）；`null` = 没失败过。 */
  readonly lastDraftFailureAt: number | null
  /** 连续草稿失败次数；用于指数退避与"停下来别再试"。 */
  readonly draftFailureStreak: number
}

/** tick 时现取的运行时事实（不落盘：它们每秒钟都可能变）。 */
export interface ContactRuntimeFacts {
  /** 通道当前可用（OneBot 连上了）。 */
  readonly connected: boolean
  /** 目标房间的绑定仍然有效（会话记录/群号自洽）。 */
  readonly roomBound: boolean
  /** 房间键 → 是否有一轮正在跑（正在聊天时不插话）。 */
  readonly turnRunningByRoom: Readonly<Record<string, boolean>>
  /** 当前是否有工具在跑（工具运行中不插话）。 */
  readonly toolRunning: boolean
  /** 房间键 → 最近一条用户消息时刻（Unix 毫秒）；没有则 null。 */
  readonly lastUserMessageAtByRoom: Readonly<Record<string, number | null>>
  /**
   * 房间键 → 尚未成包的入站行数（`ConversationRecord.queue.length`）。
   *
   * 为什么需要这个第二个游标：`lastUserMessageAtByRoom` 来自 `OneBot event.time`，是**秒级**
   * 的——同一秒里又来了一条消息，时间戳完全相等，`>` 比较拦不住（Codex 预发布审查 R5）。
   * 行数变化（0→1）就是"房间里刚刚有人说话"的可见证据。可选：装配拿不到时缺省，判据按 null 比。
   */
  readonly queueDepthByRoom?: Readonly<Record<string, number | null>>
  /** 已存在投递记录的去重键（用于"同一件事不重复发"）。 */
  readonly deliveredDedupeKeys: readonly string[]
}

/** 模型草稿的产物：只允许短文本；返回 null = 这次没话可说（**合法结果**）。 */
export interface ContactDraft {
  readonly text: string
  /** 生成它的模型路由（诊断用，可能为空串）。 */
  readonly route: string
}

/** 提出一个候选（模型/规则都走这里，最终是否发由门控决定）。 */
export interface ProposeContactInput {
  readonly intent?: AdaptiveIntent
  readonly source: ContactSourceKind
  readonly reason: string
  readonly evidenceSource: string
  readonly evidenceIds?: readonly string[]
  readonly scope: ContactScope
  readonly target: ContactTarget
  readonly priority?: number
  readonly earliestAt: number
  readonly expiresAt: number
  readonly dedupeKey: string
  readonly authorization: ContactAuthorization
}

/** 提出候选的结果。`duplicate` 不覆盖既有候选（只强化它的证据）。 */
export interface ProposeContactResult {
  readonly outcome: 'accepted' | 'duplicate' | 'rejected'
  readonly candidateId: string | null
  readonly note: string
}

/** 诊断快照：后台资源页与测试都读它。 */
export interface ContactStatusSnapshot {
  readonly enabled: boolean
  readonly dryRun: boolean
  readonly paused: boolean
  readonly lease: ContactLease | null
  readonly candidates: readonly ContactCandidate[]
  readonly deliveries: readonly ContactDelivery[]
  readonly counters: ContactCounters
  /** 最近若干条抑制/投递原因（新的在前，最多 50 条）。 */
  readonly recentReasons: readonly string[]
}

/**
 * 服务袋里的 `contact` 服务（子插件对外只暴露这一个面）。
 *
 * 说明：**没有** `sendNow` 之类的直通口——发送只能由 worker 在门控之后发生，
 * 否则"最终授权由代码强制"就成了一句注释。
 */
export interface ContactService {
  /** 提一个候选（幂等：同 `dedupeKey` 只留一个，返回 `duplicate`）。 */
  propose(input: ProposeContactInput): Promise<ProposeContactResult>
  /** 取消一个候选（幂等；已终态返回 false）。 */
  cancel(candidateId: string, reason: string): Promise<boolean>
  /** 暂停/恢复（暂停只阻止新动作，已提交的投递不回滚）。 */
  setPaused(paused: boolean): void
  /** 诊断快照（不含正文以外的隐私字段；正文来自候选自己的 reason/evidence）。 */
  status(): ContactStatusSnapshot
  /**
   * **共享出网闸门**（P2.5-3A-1）：与候选身份无关的那一半判据（免打扰/竞争/冷却/额度/
   * 退避/通道），用的就是 contact 自己的 `evaluateOutboundBudget()` 与同一本 counters。
   *
   * 别的发送方（提醒 runner）在真发之前必须问它；返回 `allowed=false` 时**不要发**。
   */
  outboundBudget(input: OutboundBudgetInput): Promise<OutboundBudgetResult>
  /**
   * **共享账本**（P2.5-3A-1）：真发成功之后把这一条记进 contact 的 counters。
   *
   * 不记就等于"配额与冷却各有各的计数"，面板上的"今天还能说几句"会失真。
   */
  account(input: OutboundAccountInput): Promise<void>
}

/** 共享闸门的入参：只要房间与时刻（没有候选）。 */
export interface OutboundBudgetInput {
  /** 房间键（`dm-<号>` / `group-<号>`；与 contact 的房间键同一套拼法）。 */
  readonly room: string
  /** 谁在问（只进日志，便于排查"这条提醒为什么没发"）。 */
  readonly sender: string
  /** 现在；缺省用 contact 的时钟。 */
  readonly now?: number
  /**
   * **预算档**（2026-11-10 修复）：`reminder` = 到点提醒，只判通道可行性
   * （`no-channel` / `binding-invalid`）；缺省 `proactive` = 修复前的老判据，一字不变。
   *
   * 为什么提醒要单独一档：免打扰/冷却/配额/退避回答的是"现在适合主动找人说话吗"，
   * 而提醒是**主人在某个时刻明确要求**的一句话。拿主动消息的额度去推迟它，就是把一次
   * 承诺改写成"看心情"——2026-11-09 的 42 分钟延迟正是如此：23:21 一条普通回复留下的
   * 会话冷却（`perRoomCooldownMs` 1 小时）把 23:40 的提醒挡到了 00:21:52。
   *
   * 判据表在 `features/contact/gate.ts::budgetChecksFor()`。安全边界没有放松：
   * 提醒的 `dryRun` / `allowExternalSend` 由提醒自己的装配判，投递成功后**照样**记进
   * 同一本账，所以主动消息那一侧仍然看得见"刚发过提醒"。
   */
  readonly profile?: BudgetProfile
}

/** 共享闸门的结论（`reason` 与 contact 门控同名同义）。 */
export interface OutboundBudgetResult {
  readonly allowed: boolean
  readonly reason: string
  /** `send` / `defer` / `drop`——与 `gate.GateVerdict` 一致。 */
  readonly verdict: 'send' | 'defer' | 'drop'
}

/** 共享账本的入参：记一次成功投递。 */
export interface OutboundAccountInput {
  readonly room: string
  readonly sender: string
  /** 记账原因（进日志与 `recentReasons`，便于对照"这几条是谁发的"）。 */
  readonly reason: string
  readonly now?: number
}

/**
 * **预算判据的两档**（2026-11-10 修复）：谁在问，决定适用哪张判据表。
 *
 * 缺省 `proactive` = contact 自己与所有老调用方，行为与修复前逐条相同；`reminder` =
 * 到点提醒（只判物理可行性）。语义与取舍见 `OutboundBudgetInput.profile` 与
 * `features/contact/gate.ts::budgetChecksFor()`。
 */
export type BudgetProfile = 'proactive' | 'reminder'

/** 空计数（第一次启动、跨日清零都用它）。 */
export function emptyCounters(day: string): ContactCounters {
  return {
    day,
    sentTodayGlobal: 0,
    sentTodayByRoom: {},
    lastSentAt: null,
    lastSentAtByRoom: {},
    unansweredStreakByRoom: {},
    draftCallsToday: 0,
    lastDraftFailureAt: null,
    draftFailureStreak: 0,
  }
}
