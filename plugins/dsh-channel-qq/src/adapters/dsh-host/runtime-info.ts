/** 当前运行环境的一句话事实：模型、图片能力、上下文窗口。
 *
 * 为什么每回合都要给：模型会把**自己的历史结论**当事实（2026-10-20 的
 * 「看不到图」就是这么自我强化了半天的）。历史里的能力描述可能已经过时，
 * 唯一可靠的来源是**当前路由解析出来的 modelInfo**——所以每包都带一条，
 * 并明确「历史里相反的说法作废」。
 *
 * 宿主形状只出现在 adapters（R2）；任一服务缺失时返回 null，包照常组。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RuntimeFacts } from '../../ports/runtime.js'

/** 取当前默认路由 + 能力；拿不到返回 null。 */
export async function readRuntimeFacts(ctx: Context): Promise<RuntimeFacts | null> {
  const defaults = ctx.get('agentDefaultModel') as
    | { currentSelection(): { provider?: unknown; model?: unknown } }
    | undefined
  const llm = ctx.get('llm') as
    | { resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[]; context?: { contextWindow?: unknown } }> }
    | undefined
  if (defaults === undefined || llm === undefined) return null
  let selection: { provider?: unknown; model?: unknown }
  try {
    selection = defaults.currentSelection()
  } catch {
    return null
  }
  const provider = typeof selection.provider === 'string' ? selection.provider : ''
  const model = typeof selection.model === 'string' ? selection.model : ''
  if (provider === '' || model === '') return null
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const window = info.context?.contextWindow
    return {
      provider,
      model,
      vision: Array.isArray(info.inputModalities) && info.inputModalities.includes('image'),
      contextWindow: typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null,
    }
  } catch {
    return null
  }
}
