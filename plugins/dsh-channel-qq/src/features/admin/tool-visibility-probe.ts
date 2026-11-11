/** 把宿主接缝包成「表情工具可见性探测」的依赖（只读，后台状态页与启动日志用）。
 *
 * 为什么单独一个文件：`admin/index.ts` 已经接近函数体量上限，而这段只做**接线**——
 * 从 `host` 里取三样东西（工具表、会话登记表、宿主 agents 注册表），任何一样拿不到都
 * 退化成 `unknown`，绝不让后台刷新或启动失败。
 */

import { probeToolVisibility, type ToolVisibilityReport } from '../../adapters/dsh-host/tool-visibility.js'
import { sessionIdOf } from '../../core/room.js'
import type { SubHost } from '../plugin-kit.js'

/** 宿主上下文的窄面（只有这里用到的几个成员）。 */
interface ToolsSurface {
  readonly tools?: {
    get?: (name: string, agent?: unknown) => unknown
  }
  get?: (name: string) => unknown
}

/** 从宿主桥取工具上下文（拿不到就是 `undefined`，不抛）。 */
function surfaceOf(host: SubHost): ToolsSurface | undefined {
  try {
    return host.bridge.toolHost() as ToolsSurface | undefined
  } catch {
    return undefined
  }
}

/** 当前活着的会话（房间键 + agent 句柄）；取不到 agent 的会话跳过。 */
function liveAgentsOf(host: SubHost): Array<{ room: string; agent: unknown }> {
  let keys: string[] = []
  try {
    keys = host.get('inbound')?.registry.keys() ?? []
  } catch {
    keys = []
  }
  if (keys.length === 0) return []
  let registry: { get: (id: unknown) => unknown } | undefined
  try {
    registry = host.bridge.agentRegistry()
  } catch {
    registry = undefined
  }
  if (registry === undefined) return []
  const rows: Array<{ room: string; agent: unknown }> = []
  for (const room of keys) {
    let agent: unknown
    try {
      agent = registry.get(sessionIdOf(room))
    } catch {
      agent = undefined
    }
    if (agent === undefined || agent === null) continue
    rows.push({ room, agent })
  }
  return rows
}

/**
 * 跑一次可见性探测。
 *
 * 三层各问一个问题，答不上来就是 `unknown`：
 *   1. 模块挂没挂（`companionExpression` 服务在不在）；
 *   2. 工具注册没注册（全局 `tools.get(name)`）；
 *   3. 会话看不看得见（`tools.get(name, agent)`，按登记表里每个活会话问一次）。
 */
export function expressionVisibilityOf(host: SubHost): ToolVisibilityReport {
  const surface = surfaceOf(host)
  const tools = surface?.tools
  const get = typeof tools?.get === 'function' ? tools.get.bind(tools) : undefined
  return probeToolVisibility({
    serviceOf: () => {
      try {
        return surface?.get?.('companionExpression')
      } catch {
        return undefined
      }
    },
    getGlobal: (name) => {
      if (get === undefined) throw new Error('宿主工具表没有 get()')
      return get(name)
    },
    ...(get === undefined ? {} : { getInSession: (name: string, agent: unknown) => get(name, agent) }),
    agents: () => liveAgentsOf(host),
    moduleGate: () => {
      try {
        const service = surface?.get?.('companionExpression')
        return service === undefined || service === null ? 'disabled' : 'enabled'
      } catch {
        return 'unavailable'
      }
    },
  })
}

export default { expressionVisibilityOf }
