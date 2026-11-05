/** 读一个会话的体积：当前请求 token 估算 + 路由模型声明的上下文窗口。
 *
 * 会话换血的看门狗用它。三个宿主服务都按结构化类型取（可选）：任一缺失时
 * 返回 null，看门狗安静跳过——宁可不换血，也不要在读不到尺寸时误杀历史。
 *
 * 宿主形状只出现在 adapters（R2）。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 一次测量结果。 */
export interface SessionSize {
  /** 当前上下文的 token 估算。 */
  readonly tokens: number
  /** 路由模型的上下文窗口；模型没声明时为 null。 */
  readonly contextWindow: number | null
  readonly provider: string
  readonly model: string
}

/** 测量器。 */
export interface SessionSizeProbe {
  measure(sessionId: string): Promise<SessionSize | null>
}

/** `ctx.agents` 的窄形状。 */
interface AgentsSeam {
  get(id: string): { session?: unknown } | undefined
}

/** `ctx.tokenMeter` 的窄形状。 */
interface TokenMeterSeam {
  measure(session: unknown): { totalTokens?: unknown }
}

/** `ctx.llm` 的窄形状。 */
interface LlmSeam {
  resolveModelInfo(provider: string, model: string): Promise<{ context?: { contextWindow?: unknown } }>
}

/** 会话对象上的 requestHeader（宿主 Session 的公开方法）。 */
interface SessionSeam {
  requestHeader?(): { config?: { provider?: unknown; model?: unknown } } | undefined
}

/** 建一个测量器；宿主服务不全时返回的测量器永远返回 null。 */
export function createSessionSizeProbe(ctx: Context): SessionSizeProbe {
  return {
    async measure(sessionId: string): Promise<SessionSize | null> {
      const agents = ctx.get('agents') as AgentsSeam | undefined
      const meter = ctx.get('tokenMeter') as TokenMeterSeam | undefined
      const llm = ctx.get('llm') as LlmSeam | undefined
      if (agents === undefined || meter === undefined || llm === undefined) return null
      const agent = agents.get(sessionId)
      const session = agent?.session as SessionSeam | undefined
      if (session === undefined) return null
      const header = session.requestHeader?.()
      const provider = typeof header?.config?.provider === 'string' ? header.config.provider : ''
      const model = typeof header?.config?.model === 'string' ? header.config.model : ''
      if (provider === '' || model === '') return null
      const measured = meter.measure(session)
      const tokens = typeof measured.totalTokens === 'number' && Number.isFinite(measured.totalTokens)
        ? measured.totalTokens
        : null
      if (tokens === null) return null
      let contextWindow: number | null = null
      try {
        const info = await llm.resolveModelInfo(provider, model)
        const window = info.context?.contextWindow
        if (typeof window === 'number' && Number.isFinite(window) && window > 0) contextWindow = window
      } catch {
        contextWindow = null
      }
      return { tokens, contextWindow, provider, model }
    },
  }
}
