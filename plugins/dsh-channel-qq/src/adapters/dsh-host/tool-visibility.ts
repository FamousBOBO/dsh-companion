/** 表情包四个工具**可见性**的只读诊断（脱敏）。
 *
 * 为什么需要它：「模型不调用表情工具」有三种完全不同的原因，而日志里长得都差不多：
 *   1. `companion-expression` 根本没挂载 → 工具没注册；
 *   2. 模块挂上了、工具也注册了，但这个会话看**不到**（preset 作用域不同 / 工具被 restrict）；
 *   3. 工具都在，但发送器（`qq_message` / `qq_sticker`）不可见 → `expression_reply` 会报
 *      `tool-not-visible`，图库自己那边看起来一切正常。
 *
 * 这三层必须分别回答，否则只会得到「表情包不好用」这种不可行动的结论。本文件只做**探测**：
 * 不注册、不调用、不修改任何东西；拿不到就如实说「未知」，不猜。
 *
 * 输出里没有任何会泄密的东西：工具名是公开的，会话 id 是我们自己的房间键，作用域哈希不解开。
 */

/** 表情包模块注册的四个工具（与 `companion-expression/src/tools.mjs` 的 TOOL_NAMES 一致）。 */
export const EXPRESSION_TOOL_NAMES: readonly string[] = [
  'expression_candidates',
  'expression_reply',
  'expression_feedback',
  'expression_sticker_note',
]

/** 投递层真正要用到的宿主发送工具（合并面优先，旧名兜底——与 host-wiring 同口径）。 */
export const SENDER_TOOL_NAMES: readonly string[] = ['qq_message', 'qq_sticker', 'qq_send_text', 'qq_send_emoji']

/** 探测结果：每一层都是 `yes` / `no` / `unknown`（三态，不用布尔冒充「不知道」）。 */
export type Probe = 'yes' | 'no' | 'unknown'

export interface ToolVisibilityReport {
  /** 模块是否已挂载（`companionExpression` 服务在不在）。 */
  readonly module: Probe
  /** 套件级/模块级开关的说法：`enabled` / `disabled` / `unavailable` / `unknown`。 */
  readonly gate: 'enabled' | 'disabled' | 'unavailable' | 'unknown'
  /** 工具是否已注册到宿主工具表（全局层，不带会话作用域）。 */
  readonly registered: Record<string, Probe>
  /** 全局层是否能看到发送器。 */
  readonly sender: Record<string, Probe>
  /** 有会话时，逐个房间看工具与发送器在该会话作用域里是否可见。 */
  readonly sessions: ReadonlyArray<{
    readonly room: string
    readonly expression: Record<string, Probe>
    readonly sender: Record<string, Probe>
  }>
  /** 一句话结论（给人看的；不参与任何判定）。 */
  readonly hint: string
}

/** 探测时用到的两路读取：取服务与按会话取工具。 */
export interface ToolProbeDeps {
  /** `ctx.get('companionExpression')`；抛错按「没有」处理。 */
  readonly serviceOf: () => unknown
  /** 全局层可见性（`tools.get(name)`，不带 agent）。 */
  readonly getGlobal: (name: string) => unknown
  /** 会话层可见性（`tools.get(name, agent)`）；宿主不支持作用域时返回 undefined。 */
  readonly getInSession?: (name: string, agent: unknown) => unknown
  /** 当前活着的会话（房间键 + agent 句柄）；没有就是空数组。 */
  readonly agents: () => ReadonlyArray<{ readonly room: string; readonly agent: unknown }>
  /**
   * 表情模块自己的说法：'enabled' / 'disabled' / 'unavailable'（拿不到就 undefined）。
   *
   * 它与「服务在不在」是两个问题：`modules.expression=false` 时服务根本不会被创建，
   * 那和「开了但创建失败」需要不同的话。
   */
  readonly moduleGate?: () => 'enabled' | 'disabled' | 'unavailable' | undefined
}

/**
 * 跑一次探测。永不抛：任何一层读失败都降级成 `unknown`。
 *
 * @param deps 见 {@link ToolProbeDeps}
 */
export function probeToolVisibility(deps: ToolProbeDeps): ToolVisibilityReport {
  const module = probe(() => (deps.serviceOf() === undefined || deps.serviceOf() === null ? 'no' : 'yes'))
  const gate = probeGate(deps.moduleGate)
  const registered = mapTools(EXPRESSION_TOOL_NAMES, name => probe(() => (visible(deps.getGlobal(name)) ? 'yes' : 'no')))
  const sender = mapTools(SENDER_TOOL_NAMES, name => probe(() => (visible(deps.getGlobal(name)) ? 'yes' : 'no')))
  const sessions = probeSessions(deps)
  return {
    module,
    gate,
    registered,
    sender,
    sessions,
    hint: hintOf({ module, gate, registered, sender, sessions }),
  }
}

/** 模块开关那一格：只接受四种说法，读不到/给别的值都算 `unknown`。 */
function probeGate(read: (() => string | undefined) | undefined): ToolVisibilityReport['gate'] {
  if (typeof read !== 'function') return 'unknown'
  try {
    const value = read()
    return value === 'enabled' || value === 'disabled' || value === 'unavailable' ? value : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 逐个活会话探测（最多 12 个：后台一次刷新不该被会话数量拖慢）。 */
function probeSessions(deps: ToolProbeDeps): ToolVisibilityReport['sessions'] {
  let list: ReadonlyArray<{ readonly room: string; readonly agent: unknown }>
  try {
    list = deps.agents()
  } catch {
    return []
  }
  if (!Array.isArray(list) || list.length === 0) return []
  const ask = deps.getInSession
  if (typeof ask !== 'function') return []
  return list.slice(0, 12).map(({ room, agent }) => ({
    room: String(room).slice(0, 64),
    expression: mapTools(EXPRESSION_TOOL_NAMES, name => probe(() => (visible(ask(name, agent)) ? 'yes' : 'no'))),
    sender: mapTools(SENDER_TOOL_NAMES, name => probe(() => (visible(ask(name, agent)) ? 'yes' : 'no'))),
  }))
}

/** 一句话结论：按「从上游到下游」的顺序报第一个缺口。 */
function hintOf(report: Omit<ToolVisibilityReport, 'hint'>): string {
  if (report.module === 'no') {
    return report.gate === 'disabled'
      ? 'companion-expression 被开关关掉了（modules.expression / config.enabled）：四个 expression_* 工具不存在，模型不会调用任何表情工具。'
      : 'companion-expression 未挂载（开关开着却没起来，或模块未装）：四个 expression_* 工具不存在。'
  }
  const missing = EXPRESSION_TOOL_NAMES.filter(name => report.registered[name] === 'no')
  if (missing.length === EXPRESSION_TOOL_NAMES.length) {
    return '模块已挂载，但四个工具都没注册到宿主工具表：检查 ctx.tools.register 与启动日志。'
  }
  if (missing.length > 0) return `部分工具未注册：${missing.join('、')}（其余已就绪）。`
  const blind = report.sessions.filter(session => EXPRESSION_TOOL_NAMES.some(name => session.expression[name] === 'no'))
  if (blind.length > 0) return `工具已注册，但 ${blind.map(session => session.room).join('、')} 的会话作用域里看不到（preset 作用域或 tools.restrict）。`
  const noSender = report.sender.qq_message === 'no' && report.sender.qq_sticker === 'no'
  if (noSender && report.sender.qq_send_text === 'no' && report.sender.qq_send_emoji === 'no') {
    return '工具都在，但发送器一个也不可见：expression_reply 会回 tool-not-visible（本轮不会真发图）。'
  }
  if (report.registered[EXPRESSION_TOOL_NAMES[0] ?? ''] === 'unknown') {
    return '宿主工具表读不出来（没有 tools.get）：只能确认模块是否挂载，无法判定可见性。'
  }
  return '模块、工具与发送器三层都可见：剩下要看的只有素材授权与 delivery.enabled。'
}

/** 一个探测：抛错或超时都算「不知道」。 */
function probe(read: () => Probe): Probe {
  try {
    return read()
  } catch {
    return 'unknown'
  }
}

/** 宿主工具表的 `get()` 正常返回定义对象；`undefined`/`null` 是「看不见」。 */
function visible(value: unknown): boolean {
  return value !== undefined && value !== null
}

/** 对一组工具名逐个探测，结果保序。 */
function mapTools(names: readonly string[], read: (name: string) => Probe): Record<string, Probe> {
  const out: Record<string, Probe> = {}
  for (const name of names) out[name] = read(name)
  return out
}

export default { probeToolVisibility, EXPRESSION_TOOL_NAMES, SENDER_TOOL_NAMES }
