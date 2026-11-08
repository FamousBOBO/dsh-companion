/** 群聊自主发言的**运行模式**（P5-B）：off / shadow / live。
 *
 * 为什么需要它（而不是继续用 `enabled` + 额度凑）：
 *
 *   1. **`speakMaxPerHour = 0` 从来不是停发开关**。`core/presence.ts` 的 `positive()` 把 0 当
 *      "配置写坏了"退回默认 3——于是"设 0 停发"实际会变成"每小时还能说三次"。这是个会
 *      真发消息的 bug，不是文档措辞问题。
 *   2. **shadow 需要一次真实的判断**（真实收消息、真实调模型、真实走校验），只是不发。
 *      用"额度 0"表达不了这件事：它连判断都会被省掉。
 *   3. **模式必须能随时收窄**：管理员在后台把 live 改成 shadow 时，正在飞的那次模型调用
 *      回来以后**也不许发**。所以最后一道发送闸门每次都要重新读模式，不能只在装配时读一次。
 *
 * 三个模式的语义（README、Studio、日志必须用同一套词）：
 *
 * | 模式 | 收消息/记旁听 | 调模型判断 | 代码校验 | 真实发送 | 影子日志 |
 * |---|---|---|---|---|---|
 * | `off`    | 否（不装配执行器） | 否 | 否 | 否 | 否 |
 * | `shadow` | 是 | **是** | **是** | **否** | **是** |
 * | `live`   | 是 | 是 | 是 | **是**（白名单 + 额度 + 冷却） | 否 |
 *
 * 纯函数：不读时钟、不读配置、不写盘（R8）。调用方把配置传进来。
 */

/** 三个模式（字符串字面量，直接对应配置值）。 */
export type GroupPresenceMode = 'off' | 'shadow' | 'live'

/** 合法模式值（配置校验与文档共用同一份）。 */
export const GROUP_PRESENCE_MODES: readonly GroupPresenceMode[] = ['off', 'shadow', 'live']

/** 默认模式：`off`。默认关着是本项目一贯的做法（关掉开关就回到旧行为）。 */
export const DEFAULT_MODE: GroupPresenceMode = 'off'

/** 能否收消息/记旁听/武装定时器（`off` 不装配，见 presence-wiring）。 */
export function modeRuns(mode: GroupPresenceMode): boolean {
  return mode === 'shadow' || mode === 'live'
}

/** 能否调模型判断（`shadow` 要真判，不然影子日志没有意义）。 */
export function modeJudges(mode: GroupPresenceMode): boolean {
  return mode === 'shadow' || mode === 'live'
}

/**
 * 能否**真的发出消息**。这是最后一道闸门的唯一判据。
 *
 * 只有 `live` 返回 true。任何新增的发送路径（文字、引用、表情包、将来可能的语音）
 * 都必须过这一条，不许各自判断。
 */
export function modeSends(mode: GroupPresenceMode): boolean {
  return mode === 'live'
}

/** 配置里那段 `presence` 的最小形状（结构类型：不把整份配置拖进来）。 */
export interface ModeSource {
  readonly enabled?: boolean
  readonly mode?: string
}

/**
 * 从配置解析模式（**绝不抛**）。
 *
 * 优先级（这是向后兼容的关键，改动前先读一遍）：
 *
 *   1. `presence.mode` 是合法值 → 用它。**显式写的永远是权威**：既然管理员写了
 *      `mode: 'shadow'`，那么 `enabled: true` 也不该让它发消息。
 *   2. `mode` 缺席或写错 → 退回旧口径：`enabled === true` 就是 `live`，否则 `off`。
 *      旧配置因此**行为完全不变**（这条是硬要求：升级不能把已经在用的部署静默关掉，
 *      也不能让它突然开始发）。
 *   3. 无法判断时一律 `off`。
 */
export function resolveMode(source: ModeSource | null | undefined): GroupPresenceMode {
  if (source === null || source === undefined) return DEFAULT_MODE
  const declared = typeof source.mode === 'string' ? source.mode.trim().toLowerCase() : ''
  if (declared !== '') {
    for (const mode of GROUP_PRESENCE_MODES) {
      if (declared === mode) return mode
    }
    // 写了但不认识：**不猜**。退回 enabled 口径，并在调用方记一行日志（见 modeNoteOf）。
  }
  return source.enabled === true ? 'live' : DEFAULT_MODE
}

/**
 * 配置里 `mode` 写了却认不出时的诊断串（空串 = 不用提）。
 *
 * 为什么单独一个函数：`resolveMode` 必须纯、必须不抛，而"配置写错了"这件事必须有人看见；
 * 把它放在这里，装配侧只要一行就能在启动日志里说明白。
 */
export function modeNoteOf(source: ModeSource | null | undefined): string {
  if (source === null || source === undefined) return ''
  const declared = typeof source.mode === 'string' ? source.mode.trim() : ''
  if (declared === '') return ''
  const lowered = declared.toLowerCase()
  for (const mode of GROUP_PRESENCE_MODES) {
    if (lowered === mode) return ''
  }
  return `presence.mode="${declared}" 不是合法模式（只能是 ${GROUP_PRESENCE_MODES.join(' / ')}），已按 enabled 推断`
}

/**
 * 一次"本来想发、但被模式拦下"的记录（影子日志的一行）。
 *
 * 字段刻意只放**决策与理由**，不放消息正文之外的东西：这份日志会进本地文件与人工盲评，
 * 拿它去当"她说了什么"的证据是可以的，但**不许**当成"已经发出去过"（没有 message_id）。
 */
export interface ShadowDecision {
  readonly groupId: number
  /** 她本来要做的动作。 */
  readonly action: 'reply' | 'join' | 'react'
  /** 她本来要说的那句话。 */
  readonly text: string
  /** 本来要引用哪一条（`reply` 才有）。 */
  readonly targetMessageId?: number
  /** 模型给的理由（已压成一行、≤60 字）。 */
  readonly reason: string
  readonly atMs: number
  /** 拦下它的模式（当前只可能是 shadow / off，写出来是为了区分两种"没发"）。 */
  readonly blockedBy: GroupPresenceMode
}
