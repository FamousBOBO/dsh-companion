/** 运行时的分支裁决：校验 + 参数翻译（"恰好匹配一个分支"的强制执行点）。
 *
 * 校验三件事，报错都要能指导模型改正：
 *   1. action 必须是这张脸的动作之一（报错列出全部可选动作）；
 *   2. provider（音乐）选平台变体，不支持的动作按"它只有哪些平台"报错；
 *   3. 字段必须恰好属于所选分支：缺必填逐个点名，多出来的字段逐个点名。
 * 全过之后按分支的翻译函数把参数变成旧 spec 的形状——**默认原样透传**
 * （去掉 action/provider），字段名与旧工具逐字一致。
 */

import { faceActions } from './mapping.js'
import type { Branch, Face } from './types.js'

export type BranchVerdict =
  | { readonly ok: true; readonly legacy: string; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly message: string }

function fail(face: Face, detail: string): BranchVerdict {
  return { ok: false, message: `${face.name}：${detail}` }
}

export function resolveBranchCall(face: Face, raw: Readonly<Record<string, unknown>>): BranchVerdict {
  const action = raw.action
  if (typeof action !== 'string' || action === '') {
    return fail(face, `需要 action 参数。可选动作：${faceActions(face).join('、')}`)
  }
  const candidates = face.branches.filter((branch) => branch.action === action)
  if (candidates.length === 0) {
    return fail(face, `没有 action=${action}。可选动作：${faceActions(face).join('、')}`)
  }
  const picked = face.providerSelect === true
    ? pickByProvider(face, raw, action, candidates)
    : pickSingle(face, action, candidates)
  if (typeof picked === 'string') return { ok: false, message: picked }
  const error = fieldError(face, raw, action, picked)
  if (error !== null) return { ok: false, message: error }
  const args = picked.translate !== undefined ? picked.translate(raw) : passthrough(raw)
  return { ok: true, legacy: picked.legacy, args }
}

/** provider 选择：先校验枚举，再按动作过滤出唯一分支。失败返回报错文案。 */
function pickByProvider(
  face: Face,
  raw: Readonly<Record<string, unknown>>,
  action: string,
  candidates: readonly Branch[],
): Branch | string {
  const provider = raw.provider ?? 'netease'
  if (provider !== 'netease' && provider !== 'kugou') {
    return `${face.name}：provider 只能是 netease 或 kugou（收到 ${JSON.stringify(raw.provider)}）`
  }
  const matching = candidates.filter((branch) => branch.provider === 'any' || branch.provider === provider)
  if (matching.length === 0) {
    const providers = [...new Set(candidates.map((branch) => (branch.provider === 'kugou' ? 'kugou' : 'netease')))]
    return `${face.name}：action=${action} 没有 provider=${provider} 的版本；它只有：${providers.join(' / ')}`
  }
  return pickSingle(face, action, matching)
}

function pickSingle(face: Face, action: string, candidates: readonly Branch[]): Branch | string {
  if (candidates.length !== 1) {
    return `${face.name}：action=${action} 的分支映射不唯一（这是插件的内部错误，请回报）`
  }
  return candidates[0]!
}

/** 字段检查：缺必填 / 多给字段都点名；通过返回 null。 */
function fieldError(
  face: Face,
  raw: Readonly<Record<string, unknown>>,
  action: string,
  branch: Branch,
): string | null {
  const missing = branch.required.filter((name) => raw[name] === undefined)
  if (missing.length > 0) {
    return `${face.name}：action=${action} 需要字段：${branch.required.join('、')}（还差：${missing.join('、')}）`
  }
  const allowed = new Set<string>([...branch.required, ...(branch.optional ?? [])])
  const extra = Object.keys(raw).filter((key) => key !== 'action' && key !== 'provider' && !allowed.has(key))
  if (extra.length > 0) {
    return `${face.name}：action=${action} 不认识字段：${extra.join('、')}；这个动作的字段：${[...allowed].join('、') || '（无）'}`
  }
  return null
}

/** 默认翻译：去掉判别字段（action）与选择器（provider），其余原样交给旧 spec。 */
function passthrough(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'action' && key !== 'provider') out[key] = value
  }
  return out
}
