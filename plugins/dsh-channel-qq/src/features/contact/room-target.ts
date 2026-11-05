/**
 * 房间键与目标的自洽几何（从 `gate.ts` 抽出来的一小块）。
 *
 * 为什么单独一个文件而不是留在门控里：这两个函数判的不是"这条候选该不该发"，
 * 而是"这个房间键与这个目标是不是同一个东西"。门控每隔几步就要用它，于是它被
 * 反复引用；而它一旦写错（后缀写法变化、群/私聊互认），后果是**发错窗口**——
 * 那是这个仓库最不可撤回的一类事故。把它放在一个只有几何、没有策略的文件里，
 * 读的人不必先读懂 12 步门控才能确认它是对的。
 */
import type { BudgetGateInput } from './gate.js'
import type { ContactCandidate } from './types.js'

/** 预算按房间算；老调用方（只有候选）从 `candidate.target.room` 推，行为不变。 */
export function roomOf(input: BudgetGateInput): string {
  return typeof input.room === 'string' ? input.room : (input.candidate?.target.room ?? '')
}

/**
 * 目标是否与房间键自洽。
 *
 * 房间键有两套历史写法（`group-<号>` 的房间键、`qq-group-<号>` 的会话 id），
 * 这里只认**后缀**：`group-<chatId>` 或 `dm-<chatId>`，两种前缀都放行。
 * 不这样写的话，一次前缀习惯变化就会让所有候选静默失效（2026-10-19 那类事故）。
 *
 * 后缀里带上了类型，所以 `qq-dm-123` 与 `qq-group-123` **不能互认**（群目标配私聊房间键
 * 会被这条拦下）。这条值得钉一个断言：它是"发错窗口"这类事故的最后一道。
 */
export function targetMatchesRoom(candidate: ContactCandidate): boolean {
  const target = candidate.target
  if (target.channel !== 'qq') return false
  const kind = target.isGroup ? 'group' : 'dm'
  return target.room.endsWith(`${kind}-${String(target.chatId)}`)
}
