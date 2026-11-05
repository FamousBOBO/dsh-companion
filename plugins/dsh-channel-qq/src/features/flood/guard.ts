/** 群内刷屏风控 (P1-5)：治理"群友刷屏"，而不是机器人自己的限流。
 *
 * 为什么要有这一层：
 * - `config.rateLimitMs` 只保证咱自己发得不快，管不了别人在群里连刷；
 * - 刷屏最典型的形态是"复读"（同一句被反复粘贴）。如果每条都按 1 计数，
 *   一个人复制粘贴 6 遍就能把 12 条的阈值糊弄过去，所以重复文本按 2 条加权；
 * - 判定与执行分离：本模块只做判定（滑动窗口 + 冷却），动作交给主控/工具。
 *   这样 `observe` 能挂在群消息入口上而不阻塞消息处理，也不会在机器人没有
 *   管理员权限时反复抛异常。
 */

import type { QQChannelConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import type { OneBotMessageSegment } from '../../types.js'

/** 一次刷屏判定结果。动作由主控执行（见 `enforceFlood`）。 */
export interface FloodDecision {
  triggered: boolean
  userId: number
  /** 加权后的条数：复读的按 2 计。 */
  count: number
  action: 'warn' | 'mute' | 'both'
  /** 给人/给模型看的原因说明。 */
  note: string
}

/** 滑动窗口里的一条消息。 */
interface WindowEntry {
  at: number
  /** 归一化后的文本，用来判断是不是复读；纯图片/表情为空串。 */
  text: string
  /** 权重：1 = 正常，2 = 复读惩罚。 */
  weight: number
}

/** 内存清扫间隔：滑窗条目和冷却记录都会过期，不清理就是慢性内存泄漏。 */
const SWEEP_INTERVAL_MS = 5 * 60_000

const ACTION_LABEL: Record<FloodDecision['action'], string> = {
  warn: '群里提醒',
  mute: '禁言',
  both: '提醒 + 禁言',
}

/**
 * 去 URL / @提及 / 空白，用于"是不是同一句"的比较。
 * 只做去噪不做分词：复读检测要的是逐字相等，任何模糊化都会漏判。
 */
function normalizeForDedup(text: string): string {
  return text
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[^\s@]{0,20}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

function describeWindow(windowSec: number): string {
  if (windowSec <= 45) return '这一分钟'
  if (windowSec <= 120) return '这几分钟'
  return '这一会儿'
}

/**
 * 群刷屏看门人。`observe` 挂在群消息入口（每条群消息都过一遍，纯内存计算），
 * 触发时返回决策；实际提醒/禁言由 `enforceFlood` 或工具执行。
 */
export class FloodGuard {
  /** key = `${groupId}:${userId}` → 滑动窗口内的消息。 */
  private readonly windows = new Map<string, WindowEntry[]>()
  /** key → 冷却截止时间戳：冷却期内不再重复触发，避免连环禁言。 */
  private readonly cooldowns = new Map<string, number>()
  /** key → 禁言截止时间戳（自动触发和手动禁言都会记）。 */
  private readonly muted = new Map<string, number>()
  private triggered = 0
  private sweepTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly config: QQChannelConfig,
    private readonly log: (line: string) => void,
  ) {
    // unref 掉：风控不该拖住进程退出。
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref()
  }

  /**
   * 记录一条群消息并判定是否刷屏。
   * 返回 null 表示"不用管"（非目标群/被豁免/没超阈值/还在冷却）。
   */
  observe(input: { groupId: number; userId: number; text: string; selfId: number | null }): FloodDecision | null {
    const flood = this.config.flood
    if (!flood.enabled) return null
    // primaryGroup 为 null 时对所有群生效（单群部署里它就是唯一的群）。
    if (this.config.primaryGroup !== null && input.groupId !== this.config.primaryGroup) return null

    const { groupId, userId } = input
    // 豁免三连：咱自己、学弟团、显式豁免名单。机器人不能把自己禁言了。
    if (input.selfId !== null && userId === input.selfId) return null
    if (this.config.admins.includes(userId)) return null
    if (flood.exempt.includes(userId)) return null

    const now = Date.now()
    const key = `${groupId}:${userId}`
    const windowMs = Math.max(1, flood.windowSec) * 1000

    const cooldownUntil = this.cooldowns.get(key)
    if (cooldownUntil !== undefined) {
      if (now < cooldownUntil) return null
      this.cooldowns.delete(key)
    }

    const history = this.windows.get(key) ?? []
    const fresh = history.filter((entry) => now - entry.at < windowMs)
    const normalized = normalizeForDedup(input.text)
    // 复读惩罚：窗口内已经出现过同一句 → 这条按 2 计。
    const repeated = normalized !== '' && fresh.some((entry) => entry.text === normalized)
    fresh.push({ at: now, text: normalized, weight: repeated ? 2 : 1 })
    this.windows.set(key, fresh)

    const count = fresh.reduce((sum, entry) => sum + entry.weight, 0)
    if (count <= flood.maxMessages) return null

    // 冷却时长用 muteSeconds（配置成 0/负数时兜底 1 秒，否则会无限触发）。
    this.cooldowns.set(key, now + Math.max(1_000, flood.muteSeconds * 1000))
    this.triggered += 1
    const repeatedCount = fresh.filter((entry) => entry.weight === 2).length
    // 注意 count 是**加权**后的数（复读按 2 计），与发了几条不是一回事；
    // 只报加权数会让主人照着回执调阈值时越调越偏（2026-10-19 排查）。
    const note = `${flood.windowSec}秒内 ${fresh.length} 条（复读 ${repeatedCount} 条按双倍计，加权 ${count}；阈值 ${flood.maxMessages}）`
    this.log(`flood: group ${groupId} user ${userId} 触发（${note}）`)
    return { triggered: true, userId, count, action: flood.action, note }
  }

  /** 记录一次禁言（自动或手动），冷却时长取 `config.flood.muteSeconds`。 */
  recordMute(groupId: number, userId: number): void {
    const until = Date.now() + Math.max(1, this.config.flood.muteSeconds) * 1000
    this.muted.set(`${groupId}:${userId}`, until)
  }

  isMuted(groupId: number, userId: number): boolean {
    const key = `${groupId}:${userId}`
    const until = this.muted.get(key)
    if (until === undefined) return false
    if (Date.now() >= until) {
      this.muted.delete(key)
      return false
    }
    return true
  }

  stats(): { tracked: number; triggered: number } {
    return { tracked: this.windows.size, triggered: this.triggered }
  }

  dispose(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.windows.clear()
    this.cooldowns.clear()
    this.muted.clear()
  }

  /** 清掉过期的窗口条目 / 冷却 / 禁言记录（每 5 分钟一次）。 */
  private sweep(): void {
    const now = Date.now()
    const windowMs = Math.max(1, this.config.flood.windowSec) * 1000
    for (const [key, history] of this.windows) {
      const fresh = history.filter((entry) => now - entry.at < windowMs)
      if (fresh.length === 0) this.windows.delete(key)
      else if (fresh.length !== history.length) this.windows.set(key, fresh)
    }
    for (const [key, until] of this.cooldowns) if (now >= until) this.cooldowns.delete(key)
    for (const [key, until] of this.muted) if (now >= until) this.muted.delete(key)
  }
}

/** `enforceFlood` 及其三段执行器共用的依赖形状。 */
interface FloodEnforceDeps {
  api: QQApi
  out: OutboundQueue
  config: QQChannelConfig
  log: (l: string) => void
  groupId: number
}

/**
 * 执行一次刷屏决策：群里提醒 + 可选禁言 + 私聊学弟简报。
 *
 * 提醒走 `out.push`（限流队列）而不是直接 call，免得和正常回复抢带宽；
 * 禁言失败只记日志不抛（机器人常常不是管理员，抛异常会把调用方整条流程带崩）。
 */
export async function enforceFlood(
  decision: FloodDecision,
  deps: {
    api: QQApi
    out: OutboundQueue
    config: QQChannelConfig
    log: (l: string) => void
    groupId: number
  },
): Promise<{ warned: boolean; muted: boolean }> {
  const warned = decision.action === 'warn' || decision.action === 'both'
    ? await warnInGroup(decision, deps)
    : false
  const muted = decision.action === 'mute' || decision.action === 'both'
    ? await muteInGroup(decision, deps)
    : false
  await briefMaster(decision, deps, { warned, muted })
  return { warned, muted }
}

/** 第一段：群里 @ 提醒。返回是否真的发出去了。 */
async function warnInGroup(decision: FloodDecision, deps: FloodEnforceDeps): Promise<boolean> {
  const { api, out, config, log, groupId } = deps
  // 拟人化提醒：像群友顺口说一句，不像管理员公告。@ 用真实 at 段。
  const message: OneBotMessageSegment[] = [
    { type: 'at', data: { qq: String(decision.userId) } },
    { type: 'text', data: { text: ` ${describeWindow(config.flood.windowSec)}刷得有点猛，先缓缓？` } },
  ]
  try {
    await out.push(() => api.sendGroupMessage(groupId, message))
    return true
  } catch (error) {
    log(`flood: 群提醒发送失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** 第二段：禁言。返回是否成功。 */
async function muteInGroup(decision: FloodDecision, deps: FloodEnforceDeps): Promise<boolean> {
  const { api, config, log, groupId } = deps
  try {
    await api.setGroupBan(groupId, decision.userId, config.flood.muteSeconds)
    return true
  } catch (error) {
    // 没有管理员权限是常态，不是错误路径。
    log(`flood: 禁言 ${decision.userId} 失败（机器人可能不是管理员）：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** 第三段：私聊学弟简报（学弟没配就跳过）。 */
async function briefMaster(
  decision: FloodDecision,
  deps: FloodEnforceDeps,
  outcome: { warned: boolean; muted: boolean },
): Promise<void> {
  const { api, out, config, log, groupId } = deps
  // 私聊学弟简报：谁被处理、为什么、做了什么。学弟没配就跳过。
  // typeof 收窄而不是 `!== undefined`：admins[0] 在类型上是 number，直接比
  // undefined/null 会被 strict 模式判成"无重叠比较"，而且脏配置里真可能是 null。
  const master: unknown = config.admins[0]
  if (!(typeof master === 'number' && master > 0 && master !== decision.userId)) return
  const done = outcome.muted
    ? `已禁言 ${config.flood.muteSeconds} 秒`
    : (outcome.warned ? '已在群里提醒' : '执行失败（可能没管理员权限）')
  const brief = [
    `【刷屏处理】群 ${groupId}`,
    `对象：${decision.userId}`,
    `原因：${decision.note}`,
    `动作：${ACTION_LABEL[decision.action]} → ${done}`,
  ].join('\n')
  try {
    await out.push(() => api.sendPrivateMessage(
      master, [{ type: 'text', data: { text: brief } }] as OneBotMessageSegment[],
    ))
  } catch (error) {
    log(`flood: 学弟简报发送失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
