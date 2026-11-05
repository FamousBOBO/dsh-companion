/**
 * **补发窗口与防雪崩**（终审 round4 B7）。
 *
 * 问题：`due()` 原来把所有"未触发且过期"的都列出来，`dryRun` 关掉的那一刻可能一次性
 * 补发一大批（关了一周再打开 = 一周的提醒同时炸出来）。`index.ts` 里"没有 contact 服务
 * 就跳过闸门"那条**不能**当防雪崩保护——它只管配额，不管年龄与条数。
 *
 * 两条约束：
 *   1. **窗口**：`at` 比现在早超过 `CATCH_UP_WINDOW_MS` 的不再补发，收成终态
 *      `skipped-expired:too-old`（留时间戳与原因，不静默丢弃）；
 *   2. **每拍条数上限**（`MAX_CATCH_UP_PER_TICK`，在 `runner.ts`）：超出的不丢弃，下一拍继续。
 *
 * 6 小时的口径：到点没过半天的补一下还有意义（"半小时前的吃药提醒"），昨天的就算了。
 */

import type { Reminder } from './reminder-model.js'
import type { Edit } from './store-contract.js'
import { edited, rejected, unchanged } from './store-contract.js'

/** 补发窗口：比这更旧的到期提醒不再补发。 */
export const CATCH_UP_WINDOW_MS = 6 * 3_600_000

/**
 * **积压总量上限**（Lead 裁定，2026-11-02）：一次最多允许 20 条进入补发队列，
 * 超出的**直接转终态** `skipped-expired:backlog-overflow`（不排进补发）。
 *
 * 三个常量各管一件事，别混：
 *   - `CATCH_UP_WINDOW_MS`（6h）——**年龄**：太旧的完全不补；
 *   - `CATCH_UP_MAX_TOTAL`（20）——**总量**：积压太多时只留最老的 20 条；
 *   - `MAX_CATCH_UP_PER_TICK`（3，在 `runner.ts`）——**节奏**：每拍发几条。
 *
 * 为什么必须有总量：只有窗口 + 每拍上限时，"停机 6 小时"可以攒出 720 条、分 2 小时
 * 慢慢发——那是**刷屏**，比"不发"糟得多。一次性提醒本来"过期即无用"：宁可少发，
 * 并在日志/后台明确"因积压丢弃 M 条"（转终态 + 记原因 + 可见 = 不静默）。
 */
export const CATCH_UP_MAX_TOTAL = 20

const DAY_MS = 86_400_000
const WEEK_MS = DAY_MS * 7

const TOO_OLD = 'skipped-expired:too-old'
const OVERFLOW = 'skipped-expired:backlog-overflow'

/**
 * **只对一次性提醒生效**（round5 D4）：周期提醒错过一轮要**推进到下一轮**，而不是终结。
 * 三闸（窗口/总量/每拍）若作用到 `daily/weekly` 上，等于"演练或停机一次就把周期提醒永久停掉"。
 */
export const isOneShot = (item: Reminder): boolean => item.repeat === 'none'

/**
 * 把过期太久的**一次性**提醒收成终态（`skipped-expired:too-old`）。
 *
 * 不是静默丢弃：留痕、后台能看到、`due()` 之后也不会再选中它。
 * 返回被收掉的 id（调用方据此记日志）。**周期提醒不在此列**（见 `missedRoundsOf`）。
 */
export function reduceExpireStale(draft: Reminder[], now: number): Edit<Reminder[]> {
  const floor = now - CATCH_UP_WINDOW_MS
  const stale = draft.filter((item) => !item.fired && isOneShot(item) && item.at < floor)
  if (stale.length === 0) return unchanged([])
  for (const item of stale) retire(item, now, TOO_OLD)
  return edited(stale.map((item) => ({ ...item })))
}

/**
 * **周期提醒：只跳过这一轮**（round5 D4）。把 `at` 推进到下一轮，`fired` **不置真**。
 *
 * 与"这一轮发过了"（`markFired`）语义不同：这里是"这一轮**没发**（错过了）"。
 * 写盘失败整条回滚并返回 `false`（调用方记日志、下次再试）。
 */
export function reduceSkipRound(draft: Reminder[], id: string, now: number): Edit<Reminder> {
  const item = draft.find((row) => row.id === id)
  if (item === undefined) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
  if (item.repeat === 'none') return rejected('NOT_APPLICABLE', '一次性提醒没有"跳过这一轮"')
  const step = item.repeat === 'daily' ? DAY_MS : WEEK_MS
  let next = item.at
  do { next += step } while (next <= now)
  item.at = next
  item.fired = false
  item.firedAt = now
  return edited({ ...item })
}

/**
 * **错过了这一轮的周期提醒**（round5 D4）：`at` 已经滑出窗口，但它是 `daily/weekly`。
 *
 * 这些**不终结**：由调用方（`deliverReminder`，且**只在非 dryRun 时**）把 `at` 推进到下一轮。
 * 为什么放在投递路径而不是这里：dryRun 下**一行持久状态都不许写**（B2 的规矩），
 * 所以"推进一轮"必须发生在 dryRun 判断之后。
 */
export function missedRoundsOf(items: readonly Reminder[], now: number): Reminder[] {
  const floor = now - CATCH_UP_WINDOW_MS
  return items.filter((item) => !item.fired && !isOneShot(item) && item.at < floor)
}

/** 到点、没触发、**且还在窗口内**的提醒（纯查询；周期提醒也在这里，直到被 `missedRoundsOf` 处理）。 */
export function dueOf(items: readonly Reminder[], now: number): Reminder[] {
  const floor = now - CATCH_UP_WINDOW_MS
  return items.filter((item) => !item.fired && item.at <= now && item.at >= floor)
}

const retire = (item: Reminder, now: number, reason: string): void => {
  item.fired = true
  item.firedAt = now
  item.expiredAt = now
  item.expiredReason = reason
}



/**
 * **积压总量闸**：窗口内的到期提醒超过 `CATCH_UP_MAX_TOTAL` 时，**按最老优先丢弃**超出部分。
 *
 * 为什么丢最老的：越老的提醒越没有补发价值（"昨天的该吃药了"），保留最近的那 20 条。
 * 返回被丢弃的 id（调用方记日志 + 后台计数）。
 */
export function reduceCapBacklog(draft: Reminder[], now: number): Edit<Reminder[]> {
  // **只对一次性提醒计数**（round5 D4）：周期提醒不该被"积压总量"淘汰——它们会自己推进到下一轮。
  const backlog = dueOf(draft, now).filter(isOneShot).sort((a, b) => a.at - b.at)
  if (backlog.length <= CATCH_UP_MAX_TOTAL) return unchanged([])
  const overflow = backlog.slice(0, backlog.length - CATCH_UP_MAX_TOTAL)
  for (const item of overflow) retire(item, now, OVERFLOW)
  return edited(overflow.map((item) => ({ ...item })))
}

/** **被丢弃的条目清单**（Lead 裁定：只给个数字等于没用，得能看到丢的是哪几条）。 */
export interface DroppedItem {
  /** 原本到点时刻（毫秒）。 */
  at: number
  /** 提醒正文（截断，够辨认就行）。 */
  text: string
  /** 为什么丢：`skipped-expired:backlog-overflow` / `skipped-expired:too-old`。 */
  reason: string
}

/** 清单默认上限（后台一格放得下；**清单 ≠ 全部**，见 `droppedTruncated`）。 */
export const DROPPED_ITEMS_LIMIT = 20

/** 文本截断长度：后台一格放得下，也足够辨认"吃药"和"喝水"。 */
const TEXT_LIMIT = 40

const shorten = (text: string): string => (text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT)}…`)

/**
 * 最近被丢弃的条目（**按到点时刻升序**，最多 `limit` 条 = 默认 20）。
 *
 * 为什么按时间升序：读起来像一句话（"7:00 吃药、8:00 喝水…"），比按丢弃时刻排更好懂。
 */
export function droppedItemsOf(items: readonly Reminder[], limit = DROPPED_ITEMS_LIMIT): DroppedItem[] {
  return items
    .filter((item) => item.expiredReason === TOO_OLD || item.expiredReason === OVERFLOW)
    .sort((a, b) => a.at - b.at)
    .slice(0, Math.max(0, limit))
    .map((item) => ({ at: item.at, text: shorten(item.text), reason: item.expiredReason ?? '' }))
}

/** **诊断**：等补发的条数、因积压被丢弃的条数（累计 + **最近 24 小时**）、最后一次丢弃时刻 + 丢了哪几条。 */
export function catchUpMetricsOf(items: readonly Reminder[], now: number): {
  backlog: number
  /** 累计被丢弃（`backlog-overflow`）的条数——只说明"历史上丢过多少"。 */
  dropped: number
  /** **清单应有多少条**（`too-old` + `backlog-overflow` 全部），可能大于 `droppedItems.length`。 */
  droppedTotal: number
  /** `true` = 清单被截断（`droppedTotal > droppedItems.length`），**别把清单当全部**。 */
  droppedTruncated: boolean
  /** **最近 24 小时**被丢弃的条数——回答"现在还在丢吗"。 */
  droppedLast24h: number
  /** 最后一次丢弃的时刻（毫秒）；从没丢过是 `null`。 */
  lastDroppedAt: number | null
  windowMs: number
  maxTotal: number
  /** 最近被丢弃的条目（时间 + 截断文本 + 原因，最多 `DROPPED_ITEMS_LIMIT` 条）。 */
  droppedItems: DroppedItem[]
} {
  const overflow = items.filter((item) => item.expiredReason === OVERFLOW)
  const expired = items.filter((item) => item.expiredReason === TOO_OLD || item.expiredReason === OVERFLOW)
  const dayAgo = now - 24 * 3_600_000
  const recent = overflow.filter((item) => (item.expiredAt ?? 0) >= dayAgo)
  const lastDroppedAt = overflow.reduce<number | null>((latest, item) => {
    const at = item.expiredAt ?? null
    if (at === null) return latest
    return latest === null || at > latest ? at : latest
  }, null)
  const droppedItems = droppedItemsOf(items)
  return {
    backlog: dueOf(items, now).length,
    dropped: overflow.length,
    // **清单 ≠ 全部**（Lead 的 P2）：只给 20 条时，必须同时给出真实总数与"被截断"标记。
    droppedTotal: expired.length,
    droppedTruncated: expired.length > droppedItems.length,
    droppedLast24h: recent.length,
    lastDroppedAt,
    windowMs: CATCH_UP_WINDOW_MS,
    maxTotal: CATCH_UP_MAX_TOTAL,
    droppedItems,
  }
}

