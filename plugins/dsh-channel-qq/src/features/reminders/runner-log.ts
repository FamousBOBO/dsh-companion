/**
 * **积压丢弃的日志落点**（从 `runner.ts` 抽出：那边贴着 400 行硬上限）。
 *
 * 为什么这几行值得单独一个文件：它们是**唯一**能让人事后解释"那几条提醒为什么没了"
 * 的痕迹。只有数字等于没用（运维要能指出是哪一条），所以这里既打前 5 条明细，
 * 又明确说出"清单被截断了、还有几条没列出"——把"部分信息"伪装成"全部信息"
 * 比不打更糟（Lead 的 P2）。
 */

import type { ReminderStore } from './store.js'

/** 明细最多列几条（再多日志就没人看了）。 */
const DROPPED_SAMPLE = 5

/**
 * 记一次积压丢弃。
 *
 * @param dropped 本拍被丢弃的条数
 * @param store 读明细与总数的来源（只读，不新增写路径）
 */
export function logDroppedBacklog(input: {
  readonly dropped: number
  readonly store: ReminderStore
  readonly now: number
  readonly maxTotal: number
  readonly log: (line: string) => void
}): void {
  const { store, log } = input
  log(`reminders: 因积压丢弃 ${String(input.dropped)} 条（skipped-expired:backlog-overflow，`
    + `上限 ${String(input.maxTotal)} 条；最老优先丢，后台可见）`)
  // **扔了哪几条要能看见**：时间 + 截断文本。
  const sample = typeof store.droppedItems === 'function' ? store.droppedItems(DROPPED_SAMPLE) : []
  for (const item of sample) {
    const when = new Date(item.at).toISOString().slice(11, 16)
    log(`reminders: 丢弃明细 ${when} ${item.text}（${item.reason}）`)
  }
  const total = typeof store.catchUpDiagnostics === 'function'
    ? store.catchUpDiagnostics(input.now).droppedTotal
    : input.dropped
  if (total > sample.length) {
    log(`reminders: 丢弃明细只列了 ${String(sample.length)} 条，**还有 ${String(total - sample.length)} 条没列出**`
      + `（后台 reminders.catchUp.droppedTotal=${String(total)}、droppedTruncated=true）`)
  }
}
