/** 开关型段与主动消息段的类型本体（P6c `policy` / P6d `tools` / P6f `proactive` /
 * P6g `planner` / A2 `contact`）。
 *
 * 为什么形状在这里而不是 `config.ts` 内联：那份文件吃着 400 行的硬上限
 * （`scripts/check-size.mjs`），每加一段都要从别处抠一行。把"只有开关和一个
 * 数据块"的三段收成一处、由 `QQChannelConfig` 继承，新增段就不再挤那 400 行。
 * `contact` 虽然字段多，但同样只是"一片类型"，放这里比把 20 个字段塞进
 * `config.ts` 更省行数（那份文件本轮只剩 6 行余量）。
 *
 * 只放**类型**：字段的中文标签、默认值与热生效标注仍然在各自的 `sections/*.ts`
 * 里（`config.ts` 只 import 类型，运行时一律走 schema）。
 */

import type { QuietRange } from '../../core/schedule/due.js'
import type { EventBook } from '../../core/schedule/event-book.js'
import type { RoomOverride } from '../../core/room-policy.js'

/** 工具策略 v2（P6c）；字段定义见 `sections/safety.ts`。 */
export interface PolicySwitchConfig {
  readonly v2: boolean
}

/** 工具面 v2（P6d）；字段定义见 `sections/tools.ts`。 */
export interface ToolsSwitchConfig {
  readonly v2: boolean
}

/** 事件书（P6f）；字段定义见 `sections/proactive.ts`。 */
export interface ProactiveConfig {
  /**
   * 旧定时行为总开关（默认 false）。
   *
   * `false` = `Scheduler.start()` 只写一行日志，**一个定时器都不注册**：不巡逻、
   * 不做梦、不自省、不主动私聊、不抽知识。发布默认就是这个姿态——装上插件不该
   * 立刻开始自己找人说话。`v2` 开着时事件书另有一套开关，不受它影响。
   */
  readonly scheduler: boolean
  /** 开关（默认关；关着走旧调度器，行为一字不改）。 */
  readonly v2: boolean
  /** 事件书内容：`{version:1, events:[…]}`（校验见 `core/schedule/event-book.ts`）。 */
  readonly book: EventBook
}

/** 群聊准入（P6g）；字段定义见 `sections/chat.ts`。 */
export interface PlannerSwitchConfig {
  readonly enabled: boolean
}

/**
 * 主动消息（A2 门控）；字段定义见 `sections/contact.ts`。
 *
 * 为什么类型在这里、字段在别处：`config.ts` 本轮只剩几行余量，而这段有二十来个
 * 字段。类型挪到这里之后，`QQChannelConfig` 只加一行继承。
 *
 * **默认一切关闭**：`enabled=false`、`dryRun=true`、`allowExternalSend=false`、
 * `sendMode='turn'`、`draftModel=false`。每个数字都是工程建议默认值（非用户决定），
 * 出处与后果见 `docs/proactive-message.md`。
 */
export interface ContactConfig {
  /** 总开关（默认 false）：关着时候选照常入库，但一条都不发、也不调用模型。 */
  readonly enabled: boolean
  /** 演练（默认 true）：走完全部门控与草稿，只记账不投递。 */
  readonly dryRun: boolean
  /** 第二道闸（默认 false）：与 `dryRun` 是与关系，两者都放开才可能真发。 */
  readonly allowExternalSend: boolean
  /** 发送方式（默认 `turn`）：经会话回合开口，还是直发。 */
  readonly sendMode: 'turn' | 'direct'
  /** 免打扰与"今天"使用的 IANA 时区；空串 = 跟随宿主 TZ。 */
  readonly timezone: string
  /** 可选出站房间白名单；空/缺省 = 不额外限制（生产启用时只放主人 DM）。 */
  readonly allowedRooms?: readonly string[]
  /** 免打扰时段（半开区间，支持跨午夜）；空数组 = 不设。 */
  readonly quietHours: readonly QuietRange[]
  /** 用户最后一条消息之后多久内不主动开口（毫秒）；0 = 关闭该门。 */
  readonly settleWindowMs: number
  /** 候选池上限（超了先丢低优先级、再丢早过期的）。 */
  readonly maxCandidates: number
  /** 分享候选（share-intent）在池里最多等多久（毫秒；默认 6 小时，见字段 help）。 */
  readonly shareTtlMs: number
  /** 两条主动消息之间的全局最小间隔（毫秒）；0 = 不设。 */
  readonly globalCooldownMs: number
  /** 同一房间的最小间隔（毫秒）；0 = 不设。 */
  readonly perRoomCooldownMs: number
  /** 每日全局额度（≥1；想全停请关 `enabled`）。 */
  readonly dailyQuotaGlobal: number
  /** 每日每会话额度（≥1）。 */
  readonly dailyQuotaPerRoom: number
  /** 连续未回复上限（0 = 不设上限）。 */
  readonly maxUnansweredStreak: number
  /** worker 调度间隔（毫秒）。 */
  readonly pollIntervalMs: number
  /** 空闲跟进阈值（毫秒；缺省 6 小时）。 */
  readonly followUpIdleMs?: number
  /** 空闲候选最小生成周期（毫秒；缺省每天一次）。 */
  readonly followUpIntervalMs?: number
  /**
   * 停机补算视界（小时）：`earliestAt` 比这个视界还老的候选直接判过期。
   *
   * 停机八小时之后不该把八小时里攒的候选一口气全发出去——那是"补发"，
   * 不是"现在想找你说话"（与 12 页"不集中补发"同一口径）。
   */
  readonly maxCatchupHours: number
  /** 每次 tick 最多领取几条候选（首版 1：一条一条来，失败也不会连带）。 */
  readonly maxPerTick: number
  /** 是否允许为草稿调用模型（默认 false：只产候选与诊断，一条也发不出去）。 */
  readonly adaptiveFollowUp?: boolean
  /** Explicit disclosure consent, scoped to the owner QQ number. Empty disables it. */
  readonly sleepSummaryRecipient?: string
  readonly draftModel: boolean
  /** 草稿的每日调用预算（成功与失败都算，空转不算）。 */
  readonly draftDailyBudget: number
  /** 草稿的每小时突发预算（只在内存里记，重启归零）。 */
  readonly draftHourlyBudget: number
  /** 单次起草超时（毫秒）；0 = 不设超时。 */
  readonly draftTimeoutMs: number
  /** 草稿字数上限（超了按"没话可说"处理，不截断）。 */
  readonly draftMaxChars: number
  /** 失败退避基数（毫秒）：按连续失败次数翻倍，封顶 8 倍。 */
  readonly draftFailureBackoffMs: number
  /** 连续失败到多少次就停止起草（等跨日归零或人工介入）。 */
  readonly draftMaxFailures: number
}

/** 五段合起来由 `QQChannelConfig` 继承。 */
export interface SwitchSections {
  policy: PolicySwitchConfig
  tools: ToolsSwitchConfig
  proactive: ProactiveConfig
  planner: PlannerSwitchConfig
  contact: ContactConfig
  /** 按群覆盖（数组：`[{ id, enabled?, requireMention?, talkValue? }]`；缺省 = 跟全局）。 */
  rooms?: RoomOverride[]
}
