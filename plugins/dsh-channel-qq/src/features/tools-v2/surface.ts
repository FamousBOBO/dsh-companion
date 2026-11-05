/** 合并面的注册与委派（P6d 的核心薄层）。
 *
 * 设计判据是"不要重写实现"：新面只是**薄适配器**——17 个工具的 run 按 action
 * 在"名字 → 旧 spec"的表里找到实现、把参数（默认原样）交过去。于是
 * "合并前后行为一致"不靠复读，靠**委派**本身就是原来那段代码。
 */

import { registerSpecs, setToolSpecSink, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import { MAPPING, describeFace, faceParameters, isLegacyToolName } from './mapping.js'
import { resolveBranchCall } from './validate.js'

/** `tools.v2` 的开关形状（与 `policyEnabled` 的读法一致：只读一个布尔）。 */
export interface ToolsV2ConfigLike {
  readonly tools?: { readonly v2?: boolean }
}

/** `tools.v2` 开着吗（每处现取；面在挂载时构建一次，改它要重启 dsh）。 */
export function toolsV2Enabled(config: ToolsV2ConfigLike): boolean {
  return config.tools?.v2 === true
}

/**
 * 由收编表生成 17 个合并工具。
 *
 * `run` 在**调用时**才查表：其余插件的旧 spec 挂载得比本组晚（装载顺序里
 * qq-tools 在第 8 位），注册时表还不全——查表放到调用时，"谁先挂"就不影响委派。
 */
export function buildToolsV2Specs(legacy: ReadonlyMap<string, ToolSpec>): ToolSpec[] {
  return MAPPING.map((face) => ({
    name: face.name,
    description: describeFace(face),
    parameters: faceParameters(face),
    run: async (args: Record<string, unknown>) => {
      const verdict = resolveBranchCall(face, args ?? {})
      if (!verdict.ok) throw new Error(verdict.message)
      const spec = legacy.get(verdict.legacy)
      if (spec === undefined) {
        throw new Error(`${face.name} 的实现（${verdict.legacy}）在这个进程里还没注册——这是插件的内部错误，请回报`)
      }
      return await spec.run(verdict.args)
    },
  }))
}

export interface MergedSurfaceArgs {
  readonly ctx: ToolHost
  /** 本组（qq-tools 的 57 个）旧 spec；其余 31 个由采集口在各自插件挂载时收编。 */
  readonly specs: readonly ToolSpec[]
  readonly log: (line: string) => void
}

/**
 * `tools.v2` 打开时的注册面：旧 spec 全部进收编表（不上宿主），宿主上只出现
 * 合并后的 17 个。采集口（`setToolSpecSink`）就此武装、一直留到卸载——后面
 * 挂载的工具组继续被收编。
 *
 * @returns 卸载器：注销 17 个并**解除采集口**（还原为"一切照常注册"）。
 */
export function registerMergedSurface(args: MergedSurfaceArgs): () => void {
  const legacy = new Map<string, ToolSpec>()
  // 本组里被合并表收编的：直接进表，不绕采集口。
  for (const spec of args.specs) {
    if (isLegacyToolName(spec.name)) legacy.set(spec.name, spec)
  }
  // 本组里**不在合并表**的新工具（例如 serverOcr 打开后的 qq_read_image_text）：
  // 单独注册，否则会进 legacy 表却没有任何合并工具能委派到它（等于消失）。
  const extra = args.specs.filter((spec) => !isLegacyToolName(spec.name))
  const disposeExtra = extra.length === 0 ? (() => {}) : registerSpecs(args.ctx, extra, args.log, 'tools-v2-extra')
  // 17 个先在采集口**之外**注册：合并名与旧名有一处相撞（合并后的 `qq_remind`
  // 与旧工具 `qq_remind` 同名），先注册再把口子张开——既不会自己收编自己，
  // 也不会让后挂的旧 spec 与合并工具在宿主上撞名（撞名的旧 spec 会被收编进表）。
  const dispose = registerSpecs(args.ctx, buildToolsV2Specs(legacy), args.log, 'tools-v2')
  setToolSpecSink((spec) => {
    if (!isLegacyToolName(spec.name)) return false
    legacy.set(spec.name, spec)
    return true
  })
  args.log(`tools.v2: ${legacy.size} 个旧工具已收编（其余工具组挂载时继续收编），注册 ${MAPPING.length} 个合并工具`)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    dispose()
    disposeExtra()
    setToolSpecSink(null)
  }
}
