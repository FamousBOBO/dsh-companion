/** 混合机器人生态的**互动风险**判定（P9-G4 §4.1）：只回答"这一轮参与会不会造成无意义的循环"。
 *
 * 为什么这件事必须由代码做：计划 §4.1 的最后两条是硬的——
 *   - **不能仅因为前一条消息来自 Bot 就判定高风险**；
 *   - **不得仅凭文本相似度判定循环，必须结合消息顺序、回复关系和话题状态**。
 * 两条都要求"看结构"，而模型看到的是一段渲染好的文字，它没法可靠地回答"这是第几次同题重启"。
 *
 * 三条纪律：
 *   1. **只判风险，不判该不该说**：这里产出 `botLoopRisk` 与几个布尔事实，
 *      真正的 `silent/observe/reply/join/react` 仍由模型决定（§4「保留原有五动作」）。
 *   2. **判不出就说判不出**：身份未知、引用缺失、话题不明 → 都往"低风险"或"不判定"收敛，
 *      因为误判高风险的代价是"她该说话时闭嘴"，而那个错误没人能看见。
 *   3. **纯**：不读时钟、不读盘、不联网（R8）。
 *
 * 特别说明（§4.1 末段）：这里算出来的 high 是"**候选发言可能产生**循环风险"，
 * 不是"已经观察到 DSH 造成了 Bot-to-Bot 闭环"。后者只能在受控 Live 阶段验证，
 * 报告措辞不许越界。
 */

import { overlapRatio } from './group-feedback.js'
import type { SenderKind } from './participant.js'

/** 一帧用于风险判定的消息（与 `SceneInput` 同形，但多一个身份类别）。 */
export interface RiskEntry {
  readonly messageId: number | null
  readonly userId: number
  readonly senderKind: SenderKind
  /** 正文（不含发送者抬头）。 */
  readonly text: string
  readonly atMs: number
  readonly self: boolean
  /** 平台 reply 段的引用目标；没有就是 `null`。 */
  readonly replyToMessageId?: number | null
  /** 平台 at 段的真实 @ 目标。 */
  readonly atIds?: readonly number[]
}

/** 互动风险（§4.1 的形状）。 */
export interface InteractionRisk {
  readonly botLoopRisk: 'low' | 'medium' | 'high'
  /** 这一批里是否已经出现语义上重复的回答（同一实质内容说了不止一次）。 */
  readonly semanticDuplicate: boolean
  /** 这一批里是否已经有人回答过（用于"别抢答"）；判不准时 `false`（不拦）。 */
  readonly alreadyAnswered: boolean
  /** 这一批里是否出现了**新信息**（新发言人、新 @ 对象、新正文）。 */
  readonly newInformation: boolean
  /** 一句话理由（进日志/影子日志；没有风险时缺省）。 */
  readonly reason?: string
}

/** 判定参数（先验值，未经真实样本校准；全部集中在这里便于后续按 §6 指标调整）。 */
export const RISK_THRESHOLDS = Object.freeze({
  /** "几乎同一句"的双字重合阈值（与 `SELF_REPEAT_THRESHOLD` 同口径）。 */
  duplicateRatio: 0.9,
  /** "同一个话题被反复重启"的时间窗。 */
  restartWindowMs: 5 * 60_000,
  /** 判定"连续礼貌性互动"的最少条数。 */
  politenessRun: 3,
  /** 只看最近多少条（再往前属于记忆，不属于这一轮的结构）。 */
  window: 8,
})

/** 纯礼貌/致谢的短句（"连续礼貌性互动"的唯一判据，§4.1）。 */
const POLITE = /^(谢谢|感谢|多谢|收到|好的|好|嗯+|哦+|OK|ok|感谢分享|多谢指教|辛苦了|学习了|了解了|明白|明白了)[。.!！~～\s]*$/u

/** 一句话是不是"纯礼貌"（长度与形状都要对上，否则普通短句会被误算成礼貌）。 */
function isPolite(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  // 超过 12 个字几乎不可能是纯客套；把它算进去会让"好的，我觉得还得再改改"被当成致谢。
  if ([...trimmed].length > 12) return false
  return POLITE.test(trimmed)
}

/** 最近 N 条（时间正序的尾部）。 */
function recent(entries: readonly RiskEntry[], window: number): RiskEntry[] {
  return entries.length <= window ? [...entries] : entries.slice(-window)
}

/**
 * 这一批里是否出现语义重复：**任意两条**（非同一人）的重合率 ≥ 阈值。
 *
 * 为什么要求不同人：同一个人连说两句相似的话是"补充说明"，不是"多个 Bot 重复回答"。
 */
function hasSemanticDuplicate(entries: readonly RiskEntry[]): { duplicate: boolean; example: string } {
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]
      const b = entries[j]
      if (a === undefined || b === undefined) continue
      if (a.userId === b.userId) continue
      if (a.text.trim() === '' || b.text.trim() === '') continue
      if (overlapRatio(a.text, b.text) >= RISK_THRESHOLDS.duplicateRatio) {
        return { duplicate: true, example: String(a.messageId ?? '?') + '/' + String(b.messageId ?? '?') }
      }
    }
  }
  return { duplicate: false, example: '' }
}

/**
 * 连续礼貌性互动的条数（尾部连续）。
 *
 * 只数**尾部连续的**纯客套：中间夹一句实质发言就断掉——"谢谢 → 有个问题"不是循环。
 */
function politenessRun(entries: readonly RiskEntry[]): number {
  let run = 0
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry === undefined || !isPolite(entry.text)) break
    run += 1
  }
  return run
}

/**
 * 同一话题被反复重启的次数：**不同发言人**在窗口内就同一个引用目标各说一次。
 *
 * 判据刻意用"引用目标"而不是文本相似度——§4.1 明写不得只凭文本相似度判循环。
 * 没有引用结构时这里返回 0（判不出就说判不出）。
 */
function restartCount(entries: readonly RiskEntry[], nowMs: number): number {
  const counts = new Map<number, Set<number>>()
  for (const entry of entries) {
    const target = entry.replyToMessageId
    if (typeof target !== 'number' || !Number.isSafeInteger(target) || target <= 0) continue
    if (!Number.isFinite(entry.atMs) || nowMs - entry.atMs > RISK_THRESHOLDS.restartWindowMs) continue
    const speakers = counts.get(target) ?? new Set<number>()
    speakers.add(entry.userId)
    counts.set(target, speakers)
  }
  let max = 0
  for (const speakers of counts.values()) max = Math.max(max, speakers.size)
  return max
}

/**
 * 这一批里的"实质发言"（非纯礼貌、非空、不是她自己的话）。
 *
 * 判据与 `politenessRun` 共用一个 `isPolite`，保证"谢谢"既不算实质回答、也不算延续讨论。
 */
function substantiveEntries(entries: readonly RiskEntry[]): RiskEntry[] {
  return entries.filter((entry) => !entry.self && entry.text.trim() !== '' && !isPolite(entry.text))
}

/**
 * 这一批里**已经有人回答过**没有。
 *
 * 要求"至少两个不同的人说过实质内容"，而不是"有实质内容"：只有一条消息时那一条是
 * **话题本身**，不是对它的回答。按后者判会把"一个新问题"算成"已经答过了"，于是她
 * 对每个第一次出现的问题都倾向沉默——那正好是"她变呆了"的典型表现。
 */
function answeredByDistinct(entries: readonly RiskEntry[]): RiskEntry[] {
  const substantive = substantiveEntries(entries)
  return new Set(substantive.map((entry) => entry.userId)).size >= 2 ? substantive : []
}

/** 这一批里有没有新信息：新发言人、新 @ 对象、或存在实质正文。 */
function hasNewInformation(entries: readonly RiskEntry[], bots: number, humans: number): boolean {
  // 有人类开口 = 一定有新信息（§4 第 5 条：人类是否加入或改变了话题方向）。
  if (humans > 0) return true
  if (substantiveEntries(entries).length > 0) return true
  // 全是 bot 但互相 @ 了不同对象，也算"关系在变化"。
  const atTargets = new Set<number>()
  for (const entry of entries) for (const id of entry.atIds ?? []) atTargets.add(id)
  return atTargets.size > 0 && bots > 0
}

/**
 * 算一次互动风险。
 *
 * @param entries 这一批背景（时间正序；`self` 为真的条目也传进来，它关系到"是不是同一对在互相附和"）
 * @param nowMs   现在几点（只用于"话题重启"的时间窗）
 *
 * 判据顺序（决定 `reason` 的第一条，也是报告里最可信的那条）：语义重复 → 重复重启 →
 * 连续礼貌 → 已有实质回答。**没有任何一条命中时给 `low`**，而不是 `uncertain`：
 * 交易成本不对称（误判高风险会让她该说话时闭嘴）。
 */
export function assessInteractionRisk(entries: readonly RiskEntry[], nowMs: number): InteractionRisk {
  const window = recent(entries, RISK_THRESHOLDS.window)
  const bots = window.filter((entry) => entry.senderKind === 'known_bot').length
  const humans = window.filter((entry) => entry.senderKind === 'known_human').length
  const answers = answeredByDistinct(window)
  const duplicate = hasSemanticDuplicate(window)
  const restarts = restartCount(window, nowMs)
  const polite = politenessRun(window)
  const newInformation = hasNewInformation(window, bots, humans)

  const base = { semanticDuplicate: duplicate.duplicate, alreadyAnswered: answers.length > 0, newInformation }

  // 高风险：同一实质内容被不同人各说了一遍 / 同一目标被多人反复重启 / 尾部一长串客套。
  if (duplicate.duplicate) {
    return { ...base, botLoopRisk: 'high', reason: '两个不同的人说了几乎同一句（' + duplicate.example + '）' }
  }
  if (restarts >= 3) {
    return { ...base, botLoopRisk: 'high', reason: String(restarts) + ' 个人在 5 分钟内对同一条消息各回了一次' }
  }
  if (polite >= RISK_THRESHOLDS.politenessRun) {
    return { ...base, botLoopRisk: 'high', reason: '尾部连续 ' + String(polite) + ' 条都是纯客套' }
  }
  // 中风险：已有实质回答，但**有**新信息（人加入、或出现了新内容）→ 要明确的新观点才值得再说。
  if (answers.length > 0 && newInformation) {
    return { ...base, botLoopRisk: 'medium', reason: '已经有人实质回答过（' + String(answers.length) + ' 条），还有新信息' }
  }
  // 中风险：多个 bot 在说话且都算不上实质（比如互相 @ 打招呼）。
  if (bots >= 2 && answers.length === 0) {
    return { ...base, botLoopRisk: 'medium', reason: String(bots) + ' 个已确认的 bot 在互相打招呼，没有实质内容' }
  }
  return { ...base, botLoopRisk: 'low' }
}

/**
 * 风险对"能不能参与"的**建议**（§4.1 的处理原则）。
 *
 * 只给建议，不做决定：调用方把它渲染成提示词里的一句话，最终仍由模型选五个动作。
 * 返回 `null` 表示没有建议（低风险）。
 */
export function riskAdvice(risk: InteractionRisk): string | null {
  if (risk.botLoopRisk === 'high') {
    return '【互动风险】' + (risk.reason ?? '这一批已经很像无意义的循环')
      + '。优先 silent 或 observe；除非你手上有**明确的新信息**，否则别再加一句。'
  }
  if (risk.botLoopRisk === 'medium') {
    return '【互动风险】' + (risk.reason ?? '已经有人答过')
      + '。要参与就给出**别处没有**的东西（新角度、具体经验、真问题），别把已有的答案换个说法。'
  }
  return null
}
