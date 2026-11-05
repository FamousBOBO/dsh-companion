/** 读会话的 `tokenUsage` 投影（type in `ports/usage.ts`）。
 *
 * 为什么不用 `session-size`：那个是"当前上下文压力"（给换血看门狗用），不是计费；
 * `tokenUsage` 是宿主按持久日志折叠出来的四个桶，分页/压缩/重连都不影响。
 *
 * 宿主服务全按结构化类型取：缺任何一个都返回 null，指标页安静跳过。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { UsageBuckets, UsageProbe } from '../../ports/usage.js'

interface AgentsSeam {
  get(id: string): { session?: unknown } | undefined
}

interface ProjectionsSeam {
  snapshot(session: unknown, keys?: readonly string[]): { values?: Record<string, unknown> }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 建一个用量探针；宿主缺服务时永远返回 null。 */
export function createUsageProbe(ctx: Context): UsageProbe {
  return {
    async usage(sessionId: string): Promise<UsageBuckets | null> {
      const agents = ctx.get('agents') as AgentsSeam | undefined
      const projections = ctx.get('sessionProjections') as ProjectionsSeam | undefined
      if (agents === undefined || projections === undefined) return null
      const session = agents.get(sessionId)?.session
      if (session === undefined) return null
      try {
        const raw = projections.snapshot(session, ['tokenUsage']).values?.tokenUsage
        if (!isRecord(raw)) return null
        return {
          uncachedInputTokens: numberField(raw, 'uncachedInputTokens'),
          outputTokens: numberField(raw, 'outputTokens'),
          cacheReadTokens: numberField(raw, 'cacheReadTokens'),
          cacheWriteTokens: numberField(raw, 'cacheWriteTokens'),
        }
      } catch {
        return null
      }
    },
  }
}
