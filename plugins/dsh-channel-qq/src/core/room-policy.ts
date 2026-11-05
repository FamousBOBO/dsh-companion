/** 按群覆盖：把"全局默认 + 单个群的例外"解析成这个群真正生效的一组值。
 *
 * 为什么需要：一个号会被拉进很多群，而"这个群要不要说话、要不要 @ 才理、接话
 * 概率多少"不该全局一刀切。优先级沿用 04 §目标架构的约定：
 *
 *     单个群（`rooms` 里的一条）> 全局（`groupEnabled` / `requireMention` / `talkValue`）
 *
 * **为什么是数组而不是 `{群号: {...}}` 对象**：配置层对 `json` 字段是"整体替换"，
 * 而这条规则只认数组——对象会被静默丢掉（2026-10-18 就是这样：后台保存成功、
 * 配置解析后却什么都没有）。数组还顺带解决了"删除某个群"：整份替换，删掉就没了。
 *
 * 纯函数：非法值（类型不对、概率越界、id 不是数字）一律当"没有覆盖"，绝不因为
 * 一个手滑的配置把某个群变成静音或刷屏。
 */

export interface RoomOverride {
  /** 群号。 */
  readonly id: number
  /** 是否处理这个群的消息；缺省 = 跟全局。 */
  readonly enabled?: boolean | null
  /** 是否必须 @ 才理；缺省 = 跟全局。 */
  readonly requireMention?: boolean | null
  /** 接话概率 0–1；缺省 = 跟全局（主群仍可被 primaryTalkValue 覆盖）。 */
  readonly talkValue?: number | null
}

export interface RoomPolicyConfig {
  readonly groupEnabled: boolean
  readonly requireMention: boolean
  readonly talkValue: number
  readonly primaryTalkValue?: number | null
  readonly primaryGroup: number | null
  /** 按群覆盖表（数组；见上面的"为什么是数组"）。 */
  readonly rooms?: readonly RoomOverride[]
}

export interface RoomPolicy {
  readonly enabled: boolean
  readonly requireMention: boolean
  readonly talkValue: number
}

function boolOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function chanceOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return undefined
  return value
}

function overrideOf(rooms: readonly RoomOverride[] | undefined, groupId: number): RoomOverride | undefined {
  if (!Array.isArray(rooms)) return undefined
  return rooms.find((entry) => typeof entry?.id === 'number' && entry.id === groupId)
}

/** 这个群最终生效的策略。`groupId` 为 null（私聊）时只返回全局值。 */
export function resolveRoomPolicy(config: RoomPolicyConfig, groupId: number | null): RoomPolicy {
  const override = groupId === null ? undefined : overrideOf(config.rooms, groupId)
  const primaryChance = groupId !== null && config.primaryGroup !== null && groupId === config.primaryGroup
    ? (typeof config.primaryTalkValue === 'number' ? config.primaryTalkValue : config.talkValue)
    : config.talkValue
  return {
    enabled: boolOf(override?.enabled) ?? config.groupEnabled,
    requireMention: boolOf(override?.requireMention) ?? config.requireMention,
    talkValue: chanceOf(override?.talkValue) ?? primaryChance,
  }
}
