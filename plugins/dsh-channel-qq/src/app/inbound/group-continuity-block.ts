/** 群回合的**本群连续性块**（P7-A）：这个群刚发生过什么、现在在聊什么。
 *
 * 为什么这块必须落在**组包路径**（`PacketComposer.compose`）而不是系统提示词段：
 * 系统提示词段（`companion:group-continuity`）拿不到群号——宿主不把会话身份传给
 * `systemPrompt.section` 的 text 回调。上一版只能在"唯一活跃群"时给数据，两个群同时活跃
 * 就两边都读不到（计划 §4.1）。组包路径手里有确定的 `conversation.chatId`，所以群号
 * 不需要猜、也不允许猜。
 *
 * 与 `sentBlock`（"她最近说过什么"）的分工：**这里不重复她自己说过的话**。
 * 计划 §4.1 第 6 条要求"同一条平台回执在上下文、时间线、sent-log 之间去重，防止 Bot 的
 * 同一句话出现两三次"——所以这块只讲**别人**说过什么 + 当前话题，她自己的发言留给
 * `sentBlock`。两边都在同一个包里，模型看到的是两段不同的事实，不是同一句的两份抄写。
 *
 * 纯函数：不读时钟、不读盘（R8）。群号与视图由调用方给。
 */

import type { GroupEventsScopedView } from './presence-timeline.js'

/** 整块字数上限（与 `companion:group-continuity` 的 400 字同一口径：这是上下文，不是资料库）。 */
export const CONTINUITY_MAX_CHARS = 400

/** 最多渲染几条（再多会把"当前这条"挤出去）。 */
const MAX_LINES = 6

/** 单条正文上限（旁听原文可以很长，这里只留能看懂话题的部分）。 */
const LINE_MAX_CHARS = 60

/** 按码点截断。 */
function clip(text: string, limit: number): string {
  const chars = [...text]
  return chars.length <= limit ? text : `${chars.slice(0, limit).join('')}…`
}

/**
 * 渲染本群的连续性块。
 *
 * 返回空串 = 这段不该出现（群号非法 / 这个群还没有时间线 / 内部异常）。**留白比编造好**：
 * 空串时组包产物与 P6 完全一致（golden 盯着这一点）。
 */
export function groupContinuityBlock(input: {
  readonly groupId: number
  readonly view: GroupEventsScopedView | null
  /** 诊断回调（P7-C）：告诉调用方"给没给出去、为什么没给"。缺省 = 不记。 */
  readonly onOutcome?: (outcome: 'injected' | 'denied') => void
}): string {
  const { groupId, view } = input
  const deny = (): string => {
    try {
      input.onOutcome?.('denied')
    } catch {
      /* 诊断回调坏了不该影响组包 */
    }
    return ''
  }
  // 群号必须是安全正整数：19 位 QQ 号超过 Number.MAX_SAFE_INTEGER 时这里直接拒绝，
  // 而不是悄悄用一个不准确的数字去查（计划 §4.1 第 4 条的 fail-closed 要求）。
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return deny()
  if (view === null) return deny()
  try {
    const detail = view.detail(groupId)
    if (!detail.valid || detail.events === 0) return deny()
    const topic = view.topic(groupId)
    const lines: string[] = []
    if (topic !== null && topic !== '') lines.push(`现在群里在聊：${clip(topic, 40)}`)
    // 她自己的发言**不在这里**（sentBlock 负责）；这里只补"这个群刚发生过什么"。
    const recent = view.recentSelf(groupId, 1)
    if (recent.length > 0) {
      const last = recent[0]
      const at = typeof last?.atMs === 'number' && last.atMs > 0 ? clockOf(last.atMs) : ''
      if (last !== undefined && last.text.trim() !== '') {
        lines.push(`你上一次在这个群说话是 ${at}（内容已在上面的自述里，不要重复）`)
      }
    }
    if (lines.length === 0) return deny()
    const head = `【这个群的近期上下文】（仅供理解，不是对你说的；共 ${String(detail.events)} 条记录）`
    const out: string[] = []
    let used = [...head].length
    for (const line of lines.slice(0, MAX_LINES)) {
      const clipped = clip(line, LINE_MAX_CHARS)
      const size = [...clipped].length + 1
      if (used + size > CONTINUITY_MAX_CHARS) break
      out.push(clipped)
      used += size
    }
    if (out.length === 0) return deny()
    try {
      input.onOutcome?.('injected')
    } catch {
      /* 同上 */
    }
    return [head, ...out].join('\n')
  } catch {
    // 视图坏了只是少一段背景，绝不能把组包弄崩。
    return ''
  }
}

/** `HH:MM`（本文件不读时钟：`atMs` 由视图给）。 */
function clockOf(atMs: number): string {
  const date = new Date(atMs)
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}
