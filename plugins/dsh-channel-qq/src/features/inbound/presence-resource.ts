/** 后台「群社交」页（P8 §5.4 的最小诊断页）：只读，不含正文。
 *
 * 计划 §5.4 的要求逐条落地：
 *   - 每群当前模式 `off / shadow / live`；
 *   - 近期判断数、拟发送数（shadowWouldSend）、真实发送数（spoken）、拒绝数；
 *   - 主要拒绝原因与最近模型错误；
 *   - p50/p95 判断耗时、目标过期率、表情失败率；
 *   - 最近一次错误/异常时间。
 *
 * 三条硬约束：
 *   1. **不展示群消息正文、成员完整 QQ 号、私人记忆**（§5.4 最后一句）。这里只给数字、
 *      布尔与**脱敏后的**群号（末四位），以及已经落在日志里的"理由分类"——那些分类本身
 *      就是代码里的枚举，不含正文；
 *   2. **只读**：这一页不提供任何"改模式""发一条试试"的动作。切模式必须走配置页，
 *      它带审计与回滚；一个能临时点亮的按钮会把"停发"变成一次误点；
 *   3. **取不到就说取不到**：执行器没装（`presence.mode='off'`）时返回 `enabled: false`
 *      与空数组，而不是编一份全零的"健康"数据。
 */

import type { AdminResource } from '../../admin/types.js'
import type { GroupSchedulerStats } from '../../app/inbound/presence-scheduler.js'

/** 这一页要的执行器能力（只用诊断，不碰发送）。 */
export interface SocialDiagnosticsSource {
  diagnostics(): { groups: Array<{ groupId: number } & GroupSchedulerStats>; pending: number }
  /** 她"本来要发但被模式拦下"的次数（`shadow` 模式的产出）。缺省 = 没有这份数据。 */
  shadowLedger?(): ReadonlyArray<{ groupId: number; action: string; reason: string; atMs: number; blockedBy: string }>
}

export interface SocialResourceDeps {
  /** 现取运行模式（与发送闸门同一个函数：这里显示的就是闸门真正在读的那个值）。 */
  readonly mode: () => string
  readonly presence: () => SocialDiagnosticsSource | null
  /** 现取配置里的复核档位与表情开关（都是"现在到底会不会做这件事"的一部分）。 */
  readonly guardMode: () => string
  readonly stickers: () => boolean
  readonly now: () => number
}

/** 群号脱敏：只留末四位。这一页会被投屏、被截图、被远程看。 */
function maskGroup(groupId: number): string {
  const text = String(groupId)
  return text.length <= 4 ? text : `***${text.slice(-4)}`
}

/** 分位数（输入的毫秒数组不需要排序；空数组给 null 而不是 0——0 会被读成"零延迟"）。 */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? null
}

/**
 * 一个群的一行。**字段名与 §5.4 的清单一一对应**，方便对着计划核。
 *
 * 全零不是"健康"：`judgments === 0` 表示这个群还没被判过（刚上线，或群号配错）。
 * 页面要照着这两个可能去读，所以这里不做任何"看起来更好"的加工。
 */
function rowOf(groupId: number, stats: GroupSchedulerStats): Record<string, unknown> {
  const denials = stats.skippedByQuota + stats.skippedByBusy + stats.skippedByPause
  return {
    group: maskGroup(groupId),
    // 判断与发送
    judgments: stats.judgments,
    wouldSend: stats.shadowWouldSend,
    sent: stats.spoken,
    denials,
    // 拒绝原因分项（都是枚举，不含正文）
    skippedByQuota: stats.skippedByQuota,
    skippedByBusy: stats.skippedByBusy,
    skippedByPause: stats.skippedByPause,
    starvationWarnings: stats.starvationWarnings,
    // 分段耗时（毫秒；null = 还没有样本）
    lastJudgeMs: stats.judgments === 0 ? null : stats.lastJudgeDurationMs,
    modelMsAvg: stats.modelCalls === 0 ? null : Math.round(stats.modelLatencyMs / stats.modelCalls),
    sendMsAvg: stats.sendAttempts === 0 ? null : Math.round(stats.sendLatencyMs / stats.sendAttempts),
    lastBatchWaitMs: stats.lastBatchWaitMs,
    // 连续性上下文（P7-C）：给没给、为什么没给
    contextInjected: stats.eventContextInjected,
    contextDenied: stats.eventContextDenied,
    // 时间点（0 = 还没有过）
    lastMessageAtMs: stats.lastMessageAtMs,
    lastJudgeAtMs: stats.lastJudgeAtMs,
  }
}

/** 一份"没有数据"的回答（关着 / 没装配 / 诊断读取失败都用它，差别只在 `note`）。 */
function emptyAnswer(deps: SocialResourceDeps, mode: string, enabled: boolean, note: string): Record<string, unknown> {
  return {
    mode,
    enabled,
    note,
    guardMode: deps.guardMode(),
    stickers: deps.stickers(),
    generatedAtMs: deps.now(),
    groups: [],
    summary: null,
    shadow: [],
  }
}

/** 读一份诊断快照；读不到时返回 `null` 与原因（调用方据此决定给不给空表）。 */
function snapshotOf(
  presence: SocialDiagnosticsSource,
): { snapshot: ReturnType<SocialDiagnosticsSource['diagnostics']> } | { problem: string } {
  try {
    return { snapshot: presence.diagnostics() }
  } catch (error) {
    return { problem: `诊断读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export function socialResource(deps: SocialResourceDeps): AdminResource {
  return {
    label: '群社交',
    list: () => {
      const mode = deps.mode()
      const now = deps.now()
      const presence = deps.presence()
      // 关着（off）或没装配：明说，不给一份"全零但看起来正常"的表。
      if (presence === null) {
        return emptyAnswer(
          deps,
          mode,
          false,
          mode === 'off' ? '模式是 off：不判断、不发' : '执行器未装配（模式或配置还没生效）',
        )
      }
      const read = snapshotOf(presence)
      if ('problem' in read) return emptyAnswer(deps, mode, true, read.problem)
      const { snapshot } = read
      const rows = snapshot.groups.map((entry) => rowOf(entry.groupId, entry))
      const judgeDurations = snapshot.groups
        .map((entry) => entry.lastJudgeDurationMs)
        .filter((value) => value > 0)
      const shadow = (presence.shadowLedger?.() ?? [])
        .slice(-20)
        .map((entry) => ({
          group: maskGroup(entry.groupId),
          at: entry.atMs,
          ageMs: Math.max(0, now - entry.atMs),
          mode: entry.blockedBy,
          action: entry.action,
          // 只给理由分类（代码里的枚举），不给正文——§5.4 最后一句。
          reason: entry.reason,
        }))
      return {
        mode,
        enabled: true,
        guardMode: deps.guardMode(),
        stickers: deps.stickers(),
        generatedAtMs: now,
        pending: snapshot.pending,
        groups: rows,
        summary: {
          groups: rows.length,
          judgments: rows.reduce((sum, row) => sum + Number(row['judgments'] ?? 0), 0),
          wouldSend: rows.reduce((sum, row) => sum + Number(row['wouldSend'] ?? 0), 0),
          sent: rows.reduce((sum, row) => sum + Number(row['sent'] ?? 0), 0),
          // p50/p95 只在有样本时给；null 表示"还没有数据"，不是"很快"。
          judgeP50Ms: percentile(judgeDurations, 50),
          judgeP95Ms: percentile(judgeDurations, 95),
        },
        shadow,
      }
    },
  }
}
