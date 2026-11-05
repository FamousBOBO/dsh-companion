/** 会话分解（P6e·e3，09 §6.2 的 04:40）：
 * 会话原件 → 按"回合块"切分 → 交给抽取器变成事实记录。
 *
 * 为什么按块而不是整份喂：抽取器（`extractFromText`）的输入上限是实测出来的
 * （1500 字/块，超过上游会 502，见 `knowledge.ts` 那段量测），而一天的原件有几十
 * 万字符。块 = "一段连续的对话"——间隔超过 `GAP_MS` 就算换了一场（群里中午聊的和
 * 晚上聊的是两件事，拼在一起只会让抽取器把无关的事混成一条）。
 *
 * 只读**本地日**的行：`time` 是毫秒时间戳，用 `localDayKey` 判定，与日志/日记同一口径。
 */

import { localDayKey } from '../../core/schedule/stamp.js'

/** 两段对话间隔超过它就算换了场（30 分钟）。 */
export const GAP_MS = 30 * 60_000

/** 一块的字符上限（与抽取器的分块对齐，避免二次切分）。 */
export const MAX_BLOCK_CHARS = 1500

/** 一块：一个房间里一段连续的对话。 */
export interface TurnChunk {
  /** 房间键（`group-…` / `dm-…`）。 */
  readonly room: string
  /** 块开始的时间戳（毫秒）；记录出处时用它当"什么时候发生的"。 */
  readonly start: number
  readonly text: string
}

interface ChatLine {
  readonly at: number
  readonly text: string
}

/** 一行会话日志 → 一条聊天行；不是聊天行 / 时间读不出来时为 null。 */
function chatLineOf(line: string): ChatLine | null {
  if (!line.includes('"type":"user/message"')) return null
  try {
    const entry = JSON.parse(line) as { time?: unknown; data?: { content?: unknown } }
    const at = typeof entry.time === 'number' ? entry.time : Number.NaN
    if (!Number.isFinite(at)) return null
    const content = entry.data?.content
    if (!Array.isArray(content)) return null
    const text = content
      .filter((b: { type?: string }) => b?.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join(' ')
      .trim()
    if (text === '') return null
    return { at, text }
  } catch {
    return null
  }
}

/**
 * 把一份会话原件切成"某一天"的回合块。
 *
 * @param jsonl `readSessionLog` 的返回值（整份 JSONL 文本）
 * @param room 房间键（只用于给块打标签）
 * @param day 本地日 `YYYY-MM-DD`
 */
export function chunksOfDay(jsonl: string, room: string, day: string): TurnChunk[] {
  const lines: ChatLine[] = []
  for (const line of jsonl.split('\n')) {
    const chat = chatLineOf(line)
    if (chat === null) continue
    if (localDayKey(new Date(chat.at)) !== day) continue
    lines.push(chat)
  }
  if (lines.length === 0) return []
  lines.sort((a, b) => a.at - b.at)
  const chunks: TurnChunk[] = []
  let current: ChatLine[] = []
  const flush = (): void => {
    if (current.length === 0) return
    const text = current.map((l) => l.text).join('\n').slice(0, MAX_BLOCK_CHARS)
    chunks.push({ room, start: current[0]!.at, text })
    current = []
  }
  for (const line of lines) {
    const previous = current[current.length - 1]
    if (previous !== undefined && line.at - previous.at > GAP_MS) flush()
    current.push(line)
  }
  flush()
  return chunks
}
