/**
 * **一次投递尝试的四种结论**——**唯一权威定义**（类型从这里派生，别再手写第二份）。
 *
 * 单独成文件的唯一理由：`runner.ts` 与 `dispatch.ts` 都要用它，而 `dispatch.ts` 不能反向
 * import `runner.ts`（那是循环依赖）。`runner.ts` 仍然 re-export 这几个符号，
 * 所以 `import { REMINDER_OUTCOMES, outcomeOf } from '../src/features/reminders/runner.js'`
 * 这种既有写法继续有效（`test/review3-qq.test.ts` B2-4 就在钉它）。
 *
 * | 结论 | 会写什么 | 会不会消耗这条提醒 |
 * |---|---|---|
 * | `sent` | `markFired()` / `markFiredRebound()`（推进 `at`、换绑 `occurrence`） | 会（它就是"发过了"） |
 * | `dry-run` | **什么都不写**（只留一行日志） | **不会**（演练不是发出） |
 * | `unknown` | `markUnknown()`（终态，留证据） | 会（但会留痕、可人工收敛） |
 * | `skipped` | 什么都不写 | 不会 |
 *
 * ⚠️ 仓外若有人按"三态"枚举（`sent`/`unknown`/`skipped`），**必须**把 `dry-run` 补进去：
 * 演练既不是"发出去"也不是"失败"，混进 `unknown` 会让人以为出过错。
 */
export const REMINDER_OUTCOMES = ['sent', 'dry-run', 'unknown', 'skipped'] as const

/** 一次投递尝试的结论。`skipped` / `dry-run` 都不消耗提醒，区别是后者"闸门跑过了"。 */
export type ReminderOutcome = typeof REMINDER_OUTCOMES[number]

/** 把回调随便返回的东西收敛成四种结论之一（认不出的按 `unknown`：说不清就别重试）。 */
export function outcomeOf(value: unknown): ReminderOutcome {
  const text = String(value)
  return (REMINDER_OUTCOMES as readonly string[]).includes(text) ? text as ReminderOutcome : 'unknown'
}
