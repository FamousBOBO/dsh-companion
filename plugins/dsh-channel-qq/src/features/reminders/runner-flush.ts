/**
 * **补发上一拍没写成的 `occurrence-dispatched`**（终审 B3b）——从 `runner.ts` 原样搬出。
 *
 * 为什么搬出来：`runner.ts` 贴着 400 行硬上限（`scripts/check-size.mjs`），而这段与
 * "何时该响"无关：它只处理"投递结论已经是 `sent`、但那条事件没写进 agenda"的尾巴。
 * **纯搬移，行为逐字不变**（`log` 文案、判定顺序、返回语义都没动）。
 */

import type { Reminder, ReminderStore } from './store.js'

/** runner 注入的三件事（都只在调用时用，不持有实例）。 */
export interface FlushDeps {
  store: ReminderStore
  /** `undefined` = 没装 agenda 接缝 ⇒ 直接跳过（这条待办根本无处可写）。 */
  redispatch?: (reminder: Reminder) => Promise<'ok' | 'absent' | 'fail'>
  log: (line: string) => void
}

/** 补发上一拍没写成的 `occurrence-dispatched`；到上限转终态，不再每拍重试。 */
export async function flushPendingDispatches(deps: FlushDeps): Promise<void> {
  const { store, redispatch, log } = deps
  if (redispatch === undefined) return
  for (const reminder of store.pendingDispatches()) {
    let verdict: 'ok' | 'absent' | 'fail' = 'fail'
    try {
      verdict = await redispatch(reminder)
    } catch (error) {
      log(`reminders: ${reminder.id} 补 dispatched 抛错：${error instanceof Error ? error.message : String(error)}`)
    }
    if (verdict === 'ok') {
      // **task-65**：清待办失败时**不许**说"已补上"——那次清待办根本没落盘，下一拍还会再补。
      const cleared = (await store.clearPendingDispatch(reminder.id)).ok
      log(cleared
        ? `reminders: ${reminder.id} 的 occurrence-dispatched 已补上`
        : `reminders: ${reminder.id} 的 dispatched 补写成功，但**清待办没写进去**（写入被拒/失败）：待办仍在，下一拍会再补一次`)
      continue
    }
    // **没有 agenda**：这条待办无处可写，作废（不算"又失败一次"、也不污染 overLimit）。
    if (verdict === 'absent') {
      const cleared = (await store.clearPendingDispatch(reminder.id)).ok
      log(cleared
        ? `reminders: ${reminder.id} 的 occurrence-dispatched 待办作废（没有议程服务，不假装补过）`
        : `reminders: ${reminder.id} 的待办**没作废成功**（写入被拒/失败）：它还在，下一拍再试`)
      continue
    }
    // 真失败：次数 +1；到上限就转终态（`dispatch-abandoned`），不再每拍重试。
    // **task-66**：`bumpPendingDispatch` 回 `Mutation`；业务拒绝（没有待办）不是故障。
    const bumped = await store.bumpPendingDispatch(reminder.id)
    if (!bumped.ok) {
      log(`reminders: ${reminder.id} 的待办计数没改成（${bumped.code}：${bumped.message}）`)
      continue
    }
    if (bumped.value.abandoned) {
      // **task-66**：放弃是**终态迁移**，必须留痕——否则 `overLimit` 计数跳了却没人说话。
      // 要求看得出"哪条、什么时候、为什么"：id + 时间 + reason。
      log(`reminders: ${reminder.id} occurrence-dispatched 补到上限 → 转终态（放弃补发；dispatchAbandonedAt=${String(Date.now())}，reason=attempts-exhausted:${String(bumped.value.attempts)}）`)
      continue
    }
    log(`reminders: ${reminder.id} 的 occurrence-dispatched 仍未补上（第 ${String(bumped.value.attempts)} 次，留着下一拍再试）`)
  }
}
