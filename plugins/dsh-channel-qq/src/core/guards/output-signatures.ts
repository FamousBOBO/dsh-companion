/** 出站特征拦截（P6c）：广告前缀、同一会话连续复读开头串。**命中即拦**。
 *
 * 方向与入站扫描相反：入站只打标（不可信输入不该被过滤改写），出站这条是模型
 * 自己生成的话——拦下来就是工具报错，模型据此改正（05 §4 的 `output-signatures`
 * 一行）。判据全是纯函数 + 一张有界的房间状态表：没有时钟、没有 IO（R8）。
 *
 * "连续"由**发送顺序**定义而不是时间：同一会话里连着几条开头一样，就是复读；
 * 跨会话不算（不同房间里说"早上好呀"是正常的）。
 */

import type { OutputSignatureRules } from '../injection/signatures.js'
import { dmRoom, groupRoom } from '../room.js'

/** 出站拦截的两个 reason key（文案在人格包的 `guards/output-*.txt`）。 */
export const OUTPUT_SIGNATURE_REASONS = {
  adPrefix: 'policy.output.ad-prefix',
  repeatOpening: 'policy.output.repeat-opening',
} as const

export type OutputSignatureReason = (typeof OUTPUT_SIGNATURE_REASONS)[keyof typeof OUTPUT_SIGNATURE_REASONS]

/**
 * 与发送工具一致的"剥壳"：`<思考>` 段落不会进消息，判据也不该看见它。
 *
 * 与 `qq_send_text` / `qq_reply_quote` 的清洗保持同一形状——闸门看到的是参数，
 * 而真正发出去的是剥壳并 trim 之后的文本，两处不一致会让复读判据记错开头。
 */
export function normalizeForSend(text: string): string {
  return text.replace(/<思考>[\s\S]*?<\/思考>\s*/g, '').trim()
}

/** 开头串：不足 `minChars` 个字的消息没有"≥6 字的相同开头"，返回 null。 */
export function openingKeyOf(text: string, minChars: number): string | null {
  const t = normalizeForSend(text)
  return t.length < minChars ? null : t.slice(0, minChars)
}

interface RoomOpening {
  open: string | null
  run: number
}

/**
 * 每房间"最近一次发送的开头串 + 连发计数"。
 *
 * 有界（默认最久未用的 200 个房间被淘汰）：这份状态是会话连续性的近似，丢一个
 * 房间只让复读检测从新开始，不影响任何其它行为，所以不需要落盘、不需要时钟。
 */
export class SendSignatureGuard {
  private readonly rooms = new Map<string, RoomOpening>()

  constructor(private readonly rules: OutputSignatureRules, private readonly maxRooms = 200) {}

  /**
   * 这次要发的文本该不该拦？命中返回 reason key，否则 null。
   *
   * 复读判据：这条与**已发出的**最近两条开头串相同（即这一条会是连续第
   * `minRun` 条），拦下。被拦下的发送不进账本（record 只记真的发出去的）。
   */
  check(room: string, text: string): OutputSignatureReason | null {
    const normalized = normalizeForSend(text)
    if (normalized === '') return null
    for (const rule of this.rules.adPrefix) {
      // `^` 锚点匹配剥壳后的开头（规则本身自带 ^；这里再 trim 一次防全角空格）。
      if (rule.pattern.test(normalized)) return OUTPUT_SIGNATURE_REASONS.adPrefix
    }
    const open = openingKeyOf(normalized, this.rules.repeatOpening.minChars)
    if (open === null) return null
    const state = this.rooms.get(room)
    if (state !== undefined && state.open === open && state.run >= this.rules.repeatOpening.minRun - 1) {
      return OUTPUT_SIGNATURE_REASONS.repeatOpening
    }
    return null
  }

  /** 记一条**真的发出去**的消息（失败的、被拦下的都不进账本）。 */
  record(room: string, text: string): void {
    const open = openingKeyOf(text, this.rules.repeatOpening.minChars)
    const prev = this.rooms.get(room)
    const next: RoomOpening = open !== null && prev !== undefined && prev.open === open
      ? { open, run: prev.run + 1 }
      : { open, run: open === null ? 0 : 1 }
    // 重新插入让 Map 的迭代顺序反映"最近用过"，淘汰时从头删。
    this.rooms.delete(room)
    this.rooms.set(room, next)
    while (this.rooms.size > this.maxRooms) {
      const oldest = this.rooms.keys().next().value
      if (oldest === undefined) break
      this.rooms.delete(oldest)
    }
  }
}

/**
 * 这个工具调用是不是"往某个会话发一段文本"？是就返回待发文本。
 *
 * 6d（工具合并 86→17）已落地：`qq_send_text` / `qq_reply_quote` 合并为
 * `qq_message` 的 `send` / `reply`，下面按两级匹配并存。旧名两个分支不能先删
 * ——tools.v2 默认关时它们就是现役表面；旧面整体退役时再逐条勾掉。
 */
export function textSentBy(tool: string, args: Readonly<Record<string, unknown>>): string | null {
  if (tool === 'qq_send_text' || tool === 'qq_reply_quote') return stringOf(args.text)
  if (tool === 'qq_message' && (args.action === 'send' || args.action === 'reply')) return stringOf(args.text)
  return null
}

/** 目标房间键（`group-…` / `dm-…`）；`target` 不是合法 QQ 号时返回 null。 */
export function roomKeyOf(args: Readonly<Record<string, unknown>>): string | null {
  const target = Number(args.target)
  if (!Number.isSafeInteger(target) || target <= 0) return null
  return args.isGroup === true ? groupRoom(target) : dmRoom(target)
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}
