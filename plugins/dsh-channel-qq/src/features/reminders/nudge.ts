/**
 * **"刚建了/刚改了提醒，立刻重算下一次唤醒"**（2026-11-10 修复）。
 *
 * 为什么必须有它：定时器按"下一条提醒的 `at`"排程，但**新提醒是在两次排程之间出现的**。
 * 只靠心跳兜的话，一条"15 秒后"的提醒可能排在一个已等待 30 秒的心跳后面 ⇒ 到点时已经迟到
 * 15 秒，5 秒的验收目标直接失效。所以写入侧（`tools.ts` 与后台删除）成功之后**主动拍一下**，
 * 让定时器立刻重算并重新排程。
 *
 * 为什么用"一个模块级回调"而不是互相 import 实例：`features/` 之间的方向是单向的，
 * 工具面不该持有 runner 实例（那会让"谁在跑"变成工具面的状态）。这里只放**一个**可空回调：
 * 没装 runner 时它是 `null`，调用方什么也不用管（进程内只有一个提醒子系统，这是事实）。
 */

type Nudge = (reason: string) => void

let current: Nudge | null = null

/** 装上/卸下（`null` = 卸下）。runner 启动时装、停表/卸载时卸。 */
export function setReminderNudge(next: Nudge | null): void {
  current = next
}

/**
 * 拍一下（事后通知）。**永不抛**：写入已经成功，排程通知失败不该把"提醒建好了"改写成"建失败"
 * —— 最坏情况只是回到心跳粒度，下一拍仍会处理。
 */
export function nudgeReminders(reason: string): void {
  const fn = current
  if (fn === null) return
  try {
    fn(reason)
  } catch {
    /* 排程通知是尽力而为；失败不改变写入结论 */
  }
}

/**
 * **写成功之后才重排**（`store` 的三个写入口在用）。
 *
 * 为什么必须挂在写入侧、而不是定时器自己"每次多看一眼"：定时器按"下一条 `at`"定，
 * 而新提醒出现在两次排程之间。不拍这一下，一条"15 秒后"的提醒可能排在一个已经等了一半的
 * 心跳后面 —— 最坏白等一整个心跳，5 秒验收当场失效（`test/reminders-dispatch-timing.test.ts` T15）。
 *
 * 判据是 `ok && changed`：业务拒绝（`NOT_FOUND` 之类）与"没改动"都不改排程——
 * 排程按盘上的状态算，盘没变就不该重排（重排只是白醒一次，但没有理由）。
 */
export function nudgeIfChanged(mutation: { ok: boolean; changed?: boolean }, reason: string): void {
  if (!mutation.ok) return
  if (mutation.changed === false) return
  nudgeReminders(reason)
}
