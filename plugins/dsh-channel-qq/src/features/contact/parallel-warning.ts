/** 两条主动外发路径同时开着的告警（从 `contact/index.ts` 搬出来，那个文件贴着 400 行硬上限）。
 *
 * 为什么值得单独一个文件：它是一条**运维判据**（事件书 prompt 事件 + 联系候选都开着，
 * 同一房间可能被两个来源各说一次），和"装配"不是一类东西，放一起只会让装配文件继续长。
 */

import { parseEventBook } from '../../core/schedule/event-book.js'
import type { SubHost } from '../plugin-kit.js'

export const PARALLEL_WARNING = 'contact: 检测到事件书 prompt 事件与联系候选同时启用，请确认两条主动外发路径不会对同一房间重复发言'

/** 事件书里有启用的 `prompt` 事件、且联系功能也开着 ⇒ true（两条主动外发都会说话）。 */
export function parallelProactiveRisk(host: SubHost): boolean {
  if (!host.config.contact.enabled || !host.config.proactive.v2) return false
  const parsed = parseEventBook(host.config.proactive.book)
  if (!parsed.ok) return false
  return parsed.book.events.some((event) => event.enabled && event.kind === 'prompt')
}
