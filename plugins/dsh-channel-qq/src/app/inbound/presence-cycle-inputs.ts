/** `presence-cycle.ts` 的**输入装配**：从旁听环与记忆服务里取出这一轮要用的东西。
 *
 * 为什么从 `presence-cycle.ts` 拆出来：那个文件已经贴着单文件行数上限（400 行），
 * 而这几段是"取数据"而不是"编排"——它们只读旁听环、按条数/字数裁窗、格式化时间标签。
 * 拆开之后 `runCycleFor` 那条主线读起来只剩"取批 → 判断 → 记账 → 收尾"。
 *
 * 三条口径（与原来同一份，一个都没放松）：
 *   1. **绝不抛**：记忆召回坏了只是少一段上下文，不是判断失败；
 *   2. **不推进交付游标**：判断只看不取，被 @ 时的交付仍由流水线负责；
 *   3. **不读全局时钟**（分层检查 R8）：`nowMs` 与 `nowLabel` 都由调用方给。
 */

import type { AmbientEntry } from '../../core/ambient.js'
import { EMPTY_RECALL } from './group-memory-contract.js'
import type { GroupMemoryRecall } from './group-memory-contract.js'
import type { JudgeEntry } from './presence-judge.js'
import { DEFAULTS, positiveOr } from './presence-flow.js'

/** 这一轮要注入的记忆（**绝不抛**：记忆坏了只是少一段，不是判断失败）。 */
export function recallFor(
  read: (input: {
    groupId: number
    memberIds: readonly number[]
    topic: string
    background: readonly JudgeEntry[]
    nowMs: number
  }) => GroupMemoryRecall | undefined,
  log: (line: string) => void,
  groupId: number,
  memberIds: readonly number[],
  background: readonly JudgeEntry[],
  nowMs: number,
): GroupMemoryRecall {
  try {
    const topic = background
      .filter((entry) => !entry.self)
      .map((entry) => (typeof entry.body === 'string' ? entry.body : entry.text))
      .slice(-1)[0] ?? ''
    const recalled = read({ groupId, memberIds, topic: topic.slice(0, 60), background, nowMs })
    return recalled ?? EMPTY_RECALL
  } catch (error) {
    log(`presence: 群 ${String(groupId)} 记忆召回失败（已忽略）：${describe(error)}`)
    return EMPTY_RECALL
  }
}

/**
 * 按条数与字数取**最近**的一段背景（时间正序返回）。
 *
 * 与 `AmbientRing.take` 同一套口径（从最新往前收，至少留一条），但这里**不推进**缓冲的
 * 交付游标：判断只看不取，被 @ 时的交付仍由流水线负责。
 */
export function windowOf(entries: readonly AmbientEntry[], maxEntries: number, maxChars: number): JudgeEntry[] {
  const entryCap = Math.max(1, Math.trunc(positiveOr(maxEntries, DEFAULTS.judgeMaxEntries)))
  const charCap = Math.max(1, Math.trunc(positiveOr(maxChars, DEFAULTS.judgeMaxChars)))
  const recent = entries.slice(-entryCap).reverse()
  const picked: AmbientEntry[] = []
  let total = 0
  for (const entry of recent) {
    const size = [...entry.text].length
    if (picked.length > 0 && total + size > charCap) break
    picked.push(entry)
    total += size
  }
  return picked.reverse().map((entry) => ({
    messageId: entry.messageId,
    name: entry.name,
    userId: entry.userId,
    text: entry.text,
    // 正文单独带一份：渲染层要显式输出一次发送者身份，整行里那段抬头就不能再出现。
    // 环里没存 body（旧写入方 / 测试直接 `add`）时不填这个键：让判断层自己去剥抬头，
    // 而不是在这里塞一整行当正文——那正好会渲染成"身份出现两次"。
    ...(entry.body === undefined ? {} : { body: entry.body }),
    self: entry.self,
    atMs: entry.atMs,
    // 平台结构原样带给判断层（P6-A）：场景摘要只认这些事实。
    ...(entry.replyToMessageId === undefined ? {} : { replyToMessageId: entry.replyToMessageId }),
    ...(entry.atIds === undefined ? {} : { atIds: entry.atIds }),
  }))
}

/** 提示词里的"现在几点"（用注入时钟的 `date()`，不读全局时钟——R8）。 */
export function nowLabelOf(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())} `
    + `${two(date.getHours())}:${two(date.getMinutes())}`
}

/**
 * 当前运行模式（每次现取；取不到按 `live`）。
 *
 * 取不到按 live 是**刻意的**：那是旧装配（没有闸门）与单测的默认路径。默认成 shadow
 * 会让既有测试与旧部署突然"不发消息"——那不是加固，是静默的功能回退。
 * 抛错时按 `off`（宁可这一轮不发，也不要在状态坏掉时乱开口）。
 */
export function modeNow(read: (() => string | undefined) | undefined): string {
  try {
    const mode = read?.()
    return typeof mode === 'string' && mode !== '' ? mode : 'live'
  } catch {
    return 'off'
  }
}

/**
 * 她自己的 QQ 号（P6-A）。
 *
 * 取不到给 0 而不是猜一个：`buildSocialScene` 会因此把 `askedMe` 保守地判成 false。
 * 猜错的代价是"以为在叫她"，比"少接一句"贵得多。
 */
export function selfIdNow(platform: () => { readonly selfId: number | null }): number {
  try {
    const id = platform().selfId
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : 0
  } catch {
    return 0
  }
}

/** 语义复核档位（P6-B）：配错/取不到按 `warn`（只记不拦）。 */
export function guardModeNow(read: (() => string | undefined) | undefined): string {
  try {
    return read?.() ?? 'warn'
  } catch {
    return 'warn'
  }
}

/** 异常只留一句话。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
