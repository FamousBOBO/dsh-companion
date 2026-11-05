/** Shared agent-tool registration kit.
 *
 * Every feature module (`link-resolve`, `meme`, `quotes`, …) exposes an array
 * of `ToolSpec`s instead of reaching into the harness registry itself, so the
 * register/unregister dance lives in exactly one place.
 *
 * The registration shape is load-bearing:
 *   - the harness requires a declared `output.schema` and a `render`, otherwise
 *     `register` throws and the tool never becomes visible to the model;
 *   - a `run` that resolves `undefined`/`null` is normalized to `{ ok: true }`
 *     because OneBot mutation actions answer null even on success and the
 *     harness output validator would otherwise turn success into an error.
 */

import { toolRegistry } from './services.js'

/**
 * 当前实际注册在宿主工具表上的工具数（后台"工具数"直读它——修 B11）。
 *
 * 旧实现去 `channel-qq.log` 尾巴上数 `registered N/M tools` 行：日志一封顶、
 * 一换格式，数字就漂。计数归注册口自己维护——成功 register 加一，注销器首次
 * 执行减一（重复注销不重复减）。
 */
let liveToolCount = 0
/** 进程内的工具调用/失败计数（C2 指标页；重启归零）。 */
let toolCallCount = 0
let toolFailureCount = 0

/** 当前在册的工具数（由 `registerSpecs` 维护）。 */
export function registeredToolCount(): number {
  return liveToolCount
}

/** 工具调用与失败计数（失败 = `run` 抛错，含闸门拒绝）。 */
export function toolStats(): { calls: number; failures: number } {
  return { calls: toolCallCount, failures: toolFailureCount }
}

/**
 * 宿主工具表的**结构形状**。
 *
 * 为什么不直接用 cordis 的 `Context`：`features/` 里的工具模块只该知道"我要往一个
 * 工具表里注册东西"，不该认识宿主。收成结构类型之后，`Context` 天然满足它，
 * 而 `check-layers` 的 R2（"宿主类型只允许出现在 adapters/dsh-host/"）继续成立。
 */
export interface ToolHost {
  readonly tools?: { register(definition: Record<string, unknown>): () => void }
}

/** 一次工具调用的只读上下文（宿主 `exec` 里我们用到的那一点）。 */
export interface ToolRunContext {
  /** `exec.agent.id`：我们的 QQ 会话形如 `qq-group-<群号>`；没有会话时为 undefined。 */
  readonly agentId?: string
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  run: (args: Record<string, unknown>, context?: ToolRunContext) => Promise<unknown> | unknown
}

/**
 * 采集口（`tools.v2`，P6d）：命中时返回 true = 这个 spec 被收编、**不注册到宿主**。
 *
 * 为什么需要它：工具面按模块分散在十来个插件里注册，而 `tools.v2` 要换掉的是
 * 整个面——被收编的旧 spec 由合并后的 17 个工具按名字委派执行（见
 * `features/tools-v2/`）。收编只影响注册，`run` 还是原来那个实现。
 */
export type ToolSpecSink = (spec: ToolSpec) => boolean

let specSink: ToolSpecSink | null = null

/** 武装/解除采集口；只有 `registerQQTools` 在 `tools.v2` 打开时用，解除必须还原为 null。 */
export function setToolSpecSink(sink: ToolSpecSink | null): void { specSink = sink }

/**
 * Register a batch of specs on the global tools registry.
 *
 * @returns a disposer that unregisters everything it managed to register.
 *          Never throws: a single bad spec is logged and skipped so one broken
 *          feature cannot take the whole tool surface down.
 */
export function registerSpecs(ctx: ToolHost, specs: ToolSpec[], log: (line: string) => void, tag = 'tools'): () => void {
  const disposers: Array<() => void> = []
  const tools = ctx.tools ?? toolRegistry(ctx as never)
  if (tools === undefined) {
    log(`${tag}: tools service unavailable; not registered`)
    return () => {}
  }
  let merged = 0
  for (const spec of specs) {
    if (specSink !== null && specSink(spec)) { merged += 1; continue }
    try {
      const remove = tools.register({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: {
          schema: { type: 'object' },
          render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args: unknown, exec?: { readonly agent?: { readonly id?: string } }) {
          const context: ToolRunContext = exec?.agent?.id === undefined ? {} : { agentId: exec.agent.id }
          toolCallCount += 1
          let value: unknown
          try {
            value = await spec.run((args ?? {}) as Record<string, unknown>, context)
          } catch (error) {
            toolFailureCount += 1
            throw error
          }
          if (value === undefined || value === null) return { ok: true }
          // Prune anything a strict JSON encoder cannot round-trip, or the
          // harness rejects the whole call as "not lossless JSON".
          return lossless(value)
        },
      })
      liveToolCount += 1
      let removed = false
      disposers.push(() => {
        if (!removed) { removed = true; liveToolCount -= 1 }
        remove()
      })
    } catch (error) {
      log(`${tag}: tool ${spec.name} registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log(`${tag}: registered ${disposers.length}/${specs.length} tools${merged > 0 ? `（${merged} 个被 tools.v2 收编）` : ''}`)
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** A JSON-schema `object` parameter block. */
export function params(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required }
}

/** Short, human-friendly id for stored records. */
export function shortId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Strip values a strict JSON encoder cannot round-trip.
 *
 * The harness validates every tool result as *lossless JSON* and rejects the
 * whole call otherwise — and its rejection message names nothing useful
 * ("value is not lossless JSON"), so a single `undefined` field turns a working
 * tool into "the interface is broken". `JSON.stringify` silently drops
 * `undefined` and turns `NaN`/`Infinity` into `null`, which is exactly the
 * mismatch the validator is looking for.
 *
 * Optional result fields are pruned here rather than at each call site:
 * `note: rows.length === 0 ? '…' : undefined` is far too easy to write by
 * accident, and — as happened for real — the failure only shows up on the
 * branch that has data, so it survives every empty-store test.
 */
export function lossless(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value === null || typeof value !== 'object' || depth > 16) return value
  if (Array.isArray(value)) {
    // An array cannot lose an index: `[1, undefined]` would become `[1]` and
    // silently shift every later element.
    return value.map((entry) => {
      const clean = lossless(entry, depth + 1)
      return clean === undefined ? null : clean
    })
  }
  if (value instanceof Date) return value.toISOString()
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const clean = lossless(entry, depth + 1)
    if (clean !== undefined) out[key] = clean
  }
  return out
}