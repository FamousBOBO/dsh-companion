/**
 * **内存回滚**（task-64）：改内存 → 落盘失败 → 把内存**整份**恢复原样。
 *
 * 为什么需要它：复审用探针证明了六个"抛错但内存已改"的漏洞——
 * `expireStale` / `capBacklog` / `clearPendingDispatch` / `resolve` / `pruneFired` / 普通写失败，
 * 底层 `ReminderFile.save()` 拒绝写入（锁生效或磁盘失败）时，**内存已经被改了**。
 * 结果：调用方以为没成，内存却已经是"新的"；下一次成功落盘就把这次"没成的变更"带上去了。
 *
 * 口径：**"共同底层拒写" ≠ "共同拒绝内存变更"**（复审原话）。
 * 所以每个 mutator 都要：改之前验锁 → 改完立刻落盘 → 失败就整份回滚并**返回失败**。
 */

import type { Reminder } from './reminder-model.js'

/** 整份深拷贝（提醒全是 JSON 安全字段，深拷贝即可）。 */
export function snapshotOf(items: readonly Reminder[]): Reminder[] {
  return JSON.parse(JSON.stringify(items)) as Reminder[]
}

/** 把 `items` **原地**恢复成快照（保持数组引用不变，调用方手里的引用仍然有效）。 */
export function restoreInto(items: Reminder[], snapshot: readonly Reminder[]): void {
  items.length = 0
  items.push(...(JSON.parse(JSON.stringify(snapshot)) as Reminder[]))
}

/**
 * **成败闭环**（task-64）：所有 mutator 都走这一条路。
 *
 *   1. **改内存之前验锁**——锁着就直接返回失败（`fail`），内存一点不动；
 *   2. 改内存 → 立刻落盘（唯一写出口 `ReminderFile.save()`）；
 *   3. **落盘失败就整份回滚**，并返回失败（`fail`）。
 *
 * 为什么必须整份回滚：复审用探针证明"抛错但内存已改"有六处——调用方以为没成，
 * 内存却已经是新的；下一次成功落盘就把这次"没成的变更"带上去了。
 */
export async function guardedWrite<T>(
  ctx: { gate: { refuse(where: string): boolean }; items: Reminder[]; log: (line: string) => void },
  where: string,
  run: () => Promise<T>,
  fail: T,
): Promise<T> {
  if (ctx.gate.refuse(where)) return fail
  const snapshot = snapshotOf(ctx.items)
  try {
    return await run()
  } catch (error) {
    restoreInto(ctx.items, snapshot)
    ctx.log(`reminders: ${where} 落盘失败 → 内存已回滚（变更未生效）：${error instanceof Error ? error.message : String(error)}`)
    return fail
  }
}
