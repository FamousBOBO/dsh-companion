/** 合并转发的展开（缺口 1，2026-10-25：此前群里发合并转发，机器人只看到占位符）。
 *
 * 从 pipeline 拆出（那边有 400 行硬上限）。每个容器 ≤20 条、每条 ≤60 字、
 * 整体 ≤3 个容器——展开是给模型看的上下文，不是存档，超了截断。
 * 展开失败（过期/无权限）就静默留占位符，不丢消息。
 */

import type { ParsedInbound } from '../../core/message/parse.js'
import type { ForwardMsgItem } from '../../ports/platform.js'
import type { QQApi } from '../../ports/platform.js'

export async function expandForwards(
  apiOf: () => QQApi,
  parsed: ParsedInbound,
  log: (line: string) => void,
): Promise<string | null> {
  if (parsed.forwards.length === 0) return null
  const lines: string[] = []
  for (const { id } of parsed.forwards.slice(0, 3)) {
    try {
      const body = await apiOf().getForwardMsg(id)
      for (const item of (body?.messages ?? []) as readonly ForwardMsgItem[]) {
        const who = item.sender?.card?.trim() || item.sender?.nickname || `QQ${item.sender?.user_id ?? '?'}`
        const segments = Array.isArray(item.content) ? item.content : []
        const text = segments
          .map((seg) => (typeof seg === 'object' && seg !== null && 'data' in seg
            ? ((seg as { data?: { text?: string } }).data?.text ?? '')
            : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60)
        if (text !== '') lines.push(`${who}：${text}`)
      }
    } catch (error) {
      log(`forward ${id} expand failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return lines.length === 0 ? null : lines.join('；').slice(0, 600)
}
