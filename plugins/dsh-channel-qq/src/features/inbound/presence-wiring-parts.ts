/** 判断层的**输入源**：人格快照、群记忆召回、候选记忆写入。
 *
 * 为什么从 `presence-wiring.ts` 拆出来：那三个函数都是"读宿主侧的数据，再交给判断层"，
 * 与"造执行器、接线、留拆卸钩子"是两类事。混在一起时装配函数会撞上单文件行数上限，
 * 而这一段真正值得读的信息（**每一段都绝不抛、只在状态变化时打一行日志**）会淹没在
 * 二十个依赖字段里。
 *
 * 三条共同口径：
 *   1. **绝不抛**：人格拿不到就是 `null`（提示词里明说降级）、记忆打不开就是空结果、
 *      写入失败只记一行。判断路径上任何一处异常都只能让"这一轮少一段上下文"；
 *   2. **日志只在变化时打**：每轮都打会把群里的其它日志淹掉，而"一直正常"本身没有信息量；
 *   3. **每次现取**：人格文件与记忆库都会被后台改动，缓存等于让"改了不生效"变成难查的问题。
 */

import { dataRootOfDshHome, readGroupPersona, type GroupPersonaDeps } from '../../adapters/dsh-host/group-persona.js'
import { openGroupMemory, recallGroupMemory, rememberGroupFacts } from '../../adapters/dsh-host/group-memory.js'
import { DEFAULTS, positiveOr } from '../../app/inbound/presence-flow.js'
import type { GroupMemoryRecall } from '../../app/inbound/group-memory-contract.js'
import type { CandidateFact } from '../../core/group-memory-extract.js'
import type { SubHost } from '../plugin-kit.js'

/**
 * 人格快照的取用（**每轮现取**：快照自带版本号，人格文件改了要在下一轮生效）。
 *
 * 这条路径没有系统提示词、没有会话，所以人格只能从这条缝进提示词；适配层拿不到就
 * 返回 `null`，提示词里明说"这次拿不到完整人格"，而不是让它自由发挥。
 * 日志只在**来源变了**时打一行。
 */
export function personaReader(host: SubHost): () => ReturnType<typeof readGroupPersona>['snapshot'] {
  const deps: GroupPersonaDeps = {
    context: () => host.bridge.tagContext(),
    // 桥是可选通道（新布局下 home 的父目录才是套件根，能不能解析到取决于部署形态）。
    bridge: () => null,
    dataRoot: () => dataRootOfDshHome(host.dshHome),
    log: host.log,
  }
  let last = ''
  return () => {
    const read = readGroupPersona(deps)
    const note = read.snapshot === null ? `none(${read.reason})` : `${read.via} v${read.snapshot.version}`
    if (note !== last) {
      last = note
      host.log(`presence: 人格快照 ${note}`)
    }
    return read.snapshot
  }
}

/**
 * 群记忆召回（P1 §5.4）。
 *
 * 打不开库不是错误：`recallGroupMemory` 返回空结果，群聊照常跑（§5.5 的要求）。
 * 日志同样只在**可用性变了**时打一行。
 */
export function memoryRecall(host: SubHost): (input: {
  groupId: number
  memberIds: readonly number[]
  topic: string
}) => GroupMemoryRecall {
  let last = ''
  return ({ groupId, memberIds, topic }) => {
    const dataRoot = dataRootOfDshHome(host.dshHome)
    const recall = recallGroupMemory({
      dataRoot,
      groupId,
      memberIds,
      topic,
      budgetChars: positiveOr(
        host.config.presence?.memoryBudgetChars ?? DEFAULTS.memoryBudgetChars,
        DEFAULTS.memoryBudgetChars,
      ),
    })
    const handle = openGroupMemory(dataRoot)
    const note = `${handle.reason}/${String(recall.group.length)}g${String(recall.member.length)}m`
    if (note !== last) {
      last = note
      const where = handle.file === '' ? '未配置路径' : handle.file
      host.log(`presence: 群记忆 ${note}${handle.reason === 'ok' ? '' : `（${where}）`}`)
    }
    return recall
  }
}

/**
 * 记忆写入（P1 §5.3）：逐条落库，失败只记一行。
 *
 * 为什么打日志要"只在真写了东西时"：顺利时每轮都会有一条候选，逐轮打会把群里
 * 其它日志淹掉；而"一条都没写"是常态（大多数话不是事实），不值得记。
 */
export function memoryWriter(host: SubHost): (input: {
  groupId: number
  facts: readonly CandidateFact[]
  nowMs: number
}) => void {
  return (input) => {
    try {
      const { written, merged, rejected } = rememberGroupFacts({ dataRoot: dataRootOfDshHome(host.dshHome), ...input })
      if (written + merged > 0) {
        host.log(`presence: 群 ${String(input.groupId)} 记住 ${String(written)} 条`
          + `（合并 ${String(merged)}，拒 ${String(rejected)}）`)
      }
    } catch (error) {
      host.log(`presence: 群记忆写入失败（已忽略）：${describe(error)}`)
    }
  }
}

/** 异常只留一句话。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
