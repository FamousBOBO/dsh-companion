/** 每群的**只读取材**（P7-B 抽出）：人格快照、"她最近说过什么"、饥饿告警的措辞。
 *
 * 为什么单独一个文件：这几段都是"取一次、绝不抛、拿不到就降级"的读操作，与状态机的
 * 定时器/游标逻辑无关。它们混在 `presence-runtime.ts` 里时，那个文件既管"什么时候判"
 * 又管"判之前读什么"，两边都没法单独读。
 *
 * 三条共同的纪律（每一条都对应一次线上事故）：
 *   1. **绝不抛**：这些函数在入站与判断路径上被调用，抛一次就是丢一条消息或一整轮判断；
 *   2. **失败要留一行日志**：静默降级会让人误以为"人格配好了"或"她确实没说过话"；
 *   3. **每次现取**：热加载后人格提供者与时间线都会被换掉，缓存等于把重连变成静默失败。
 */

import type { GroupPersonaSnapshot } from './group-persona.js'

/** 取一次人格快照；拿不到返回 `null` 并留一行日志。 */
export function personaSnapshotOf(input: {
  readonly groupId: number
  readonly persona: () => GroupPersonaSnapshot | null
  readonly log: (line: string) => void
}): GroupPersonaSnapshot | null {
  try {
    const snapshot = input.persona()
    if (snapshot === null) {
      // 一行就够：'她说话不像角色' 的唯一排查起点就是"快照到底有没有接上"。
      input.log(`presence: 群 ${String(input.groupId)} 人格快照不可用，这一轮用降级人格`)
      return null
    }
    return snapshot
  } catch (error) {
    input.log(`presence: 群 ${String(input.groupId)} 取人格快照抛错（已降级）：${describe(error)}`)
    return null
  }
}

/**
 * "她最近说过的话"：**时间线优先**，旁听环兜底。
 *
 * 为什么以时间线为准：P3 之后"她说过什么"只有一个来源，时间的先后与去重都在那边做了。
 * 旁听环只是兜底——时间线坏了或还没建起来时，至少还有内存里的最近几句。
 */
export function sentLinesOf(input: {
  readonly groupId: number
  readonly fromTimeline: () => readonly string[]
  readonly fallback: readonly string[]
  readonly limit: number
}): readonly string[] {
  try {
    const fromTimeline = input.fromTimeline()
    if (fromTimeline.length > 0) return fromTimeline.slice(-input.limit)
  } catch {
    /* 时间线坏了就退回旁听环里的记录 */
  }
  return input.fallback
}

/** 饥饿告警那一行的措辞（单独写出来是为了它被测试钉住：这行字是运维唯一的线索）。 */
export function starvationLine(input: {
  readonly groupId: number
  readonly pending: number
  readonly waitedMs: number
  readonly reason: string
}): string {
  return `presence: 群 ${String(input.groupId)} 判断饥饿告警——${String(input.pending)} 条消息已等待 `
    + `${String(input.waitedMs)}ms 仍未判断（原因 ${input.reason}）`
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
