/** 判断后端的**分派**：`host`（宿主默认模型）与 `jev-local`（本地 Jev typed）二选一。
 *
 * 为什么单独一个文件而不是在 `presence-cycle.ts` 里写一个 `if`：那个文件已经贴着
 * 单文件行数上限（400 行），而这段分派要同时 import 两条流程（提示词组装的与本地打分的），
 * 塞进去会一路把它顶穿。分出来之后，"换后端"这件事只有一处判据，读起来也短。
 *
 * 两条流程的**记账口径**必须一致（见 `judge-local-flow.ts` 的文件头）：
 *   - `spoke` / `silent` / `shadow` = 成功；
 *   - `failed` = 失败（累积几次就暂停）；
 *   - 唯一的差别是本地那条的 `no-route` **不算失败**（它缺席时这一轮就当没判）。
 */

import { runLocalJudgeCycle } from './judge-local-flow.js'
import { runPresenceCycle, type CycleDeps, type CycleInput, type CycleOutcome } from './presence-flow.js'

/** 判断后端（缺省 `host`，与今日行为一致）。 */
export function judgeBackendOf(deps: CycleDeps): string {
  const raw = deps.judgeBackend?.() ?? 'host'
  // 两条 typed 后端（云端 `jev-opencode` / 本地 `jev-local`）在编排上完全等价：
  // 都走 `runLocalJudgeCycle`（同一套九门 + 决策表 + 折判）。所以这里只判
  // "是不是 typed"，具体是谁由端口自己知道——加一条新后端不需要改这里。
  return raw === 'host' ? 'host' : 'typed'
}

/**
 * 跑一次判断（按当前后端分派）。
 *
 * typed 后端（云端 / 本地）但端口没接上时**退回宿主模型**而不是静默不说话：
 * 装配漏接是配置/代码错，退回至少还能工作，同时日志里会有一条"后端切了但没接上"。
 * 静默不说的代价是"群里突然安静了，而原因在日志里看不到"。
 */
export async function runJudge(input: CycleInput, deps: CycleDeps): Promise<CycleOutcome> {
  if (judgeBackendOf(deps) === 'host') return await runPresenceCycle(input, deps)
  if (deps.judge === undefined) {
    deps.log(`presence: 群 ${String(input.groupId)} 判断后端配成 typed（${deps.judgeBackend?.() ?? '?'}）但端口没接上，退回宿主模型`)
    return await runPresenceCycle(input, deps)
  }
  return await runLocalJudgeCycle(input, deps)
}
