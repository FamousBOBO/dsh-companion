/** 旧路径转发口（P5.4）。
 *
 * 调度器已整体搬进 `features/proactive/`（时刻表与行为一字未改；见那里的
 * `events.ts` 搬迁注记）。本文件保留为兼容转发口，理由有二：
 *   - `deploy/check-localtime.mjs` 从构建产物 `#lib/scheduler.js` 取
 *     `localStamp` / `timeContext`——历史签名是"不传参 = 取现在"，这里原样恢复
 *     （core/ 不允许读全局时钟，兼容口放在这里正好）；
 *   - 任何仍按旧路径 import `Scheduler` 的代码不会断。
 */

import { formatLocalStamp, timeContext as timeContextAt } from './core/schedule/stamp.js'
export { Scheduler } from './features/proactive/events.js'
export { localDayKey } from './core/schedule/stamp.js'

/** 历史签名：不传参表示"现在"。 */
export function localStamp(d: Date = new Date()): string {
  return formatLocalStamp(d)
}

/** 历史签名：不传参表示"现在"。 */
export function timeContext(now: Date = new Date()) {
  return timeContextAt(now)
}
