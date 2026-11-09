/** 群聊人格快照的**取用面**（P0 §4.1）：从兄弟插件行（companion-foundation）拿只读快照。
 *
 * 为什么必须走这条缝、而不能读文件：`src/app/` 不许 import `node:fs`（分层检查 R8），
 * 而人格文件属于 foundation 的资产（它才知道 `config/persona.md` 的解析顺序、persona id
 * 与版本哈希）。所以这里只做一件事：**把三个解析路径按代价从低到高试一遍**，
 * 拿不到就返回 `null`（调用方降级，绝不抛）。
 *
 * 三条解析路径（顺序照 `companion-foundation/health-service-ref.mjs` 的既有结论）：
 *   1. `ctx.get('companionGroupPersona')` —— 同子树消费者最确定的一条；
 *   2. **进程级注册表** `Symbol.for('dsh.companion.ports.v1')`：两个插件行是兄弟行，
 *      cordis 的服务作用域不跨行；`process` 是唯一不会分裂的身份；
 *   3. `service-bridge.resolve()` —— 项目认可的跨行通道（模块级、按 data root 规范化）。
 *
 * 为什么每次判断都重新解析、不缓存端口：热重载会把发布方换成新对象，缓存等于抓着死对象
 * （2026-11 私聊发送器事故的同类坑）。**快照本身**由发布方按文件 mtime 缓存，这里再叠一层
 * 只会让"改了人格却看不到"变成更难查的问题。
 */

import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'

import type { GroupPersonaPort, GroupPersonaSnapshot } from '../../app/inbound/group-persona.js'
import { normalizePersonaSnapshot } from '../../app/inbound/group-persona.js'
import type { CompanionBridge } from './companion-bridge.js'

/**
 * 套件 data root = `DSH_HOME` 的父目录（`data/home` → `data`）。
 *
 * 为什么用这个算、而不是让 foundation 告诉我们：进程级注册表的键就是 data root，
 * 而 QQ 插件唯一确定拿到的是 `DSH_HOME`（`host.dshHome`，本身就是套件启动时注入的）。
 * `realpathSync` 只是把 junction / 8.3 短名与符号链接折成同一个拼法——发布方与消费方
 * 必须落在同一个字符串上，否则"注册了但查不到"会表现为**静默降级**。
 * 与 `features/contact/sleep-summary.ts` 用的是同一条判据，两处必须一致。
 */
export function dataRootOfDshHome(dshHome: string): string | null {
  try {
    return dirname(realpathSync(dshHome))
  } catch {
    return null
  }
}

/** 端口在宿主 ctx 与注册表里的名字（发布方必须用同一个）。 */
export const GROUP_PERSONA_SERVICE = 'companionGroupPersona'

/** 进程级注册表的键（`Symbol.for` 保证跨模块同一枚；与 companion-foundation 用的是同一枚）。 */
export const PORTS_SYMBOL: symbol = Symbol.for('dsh.companion.ports.v1')

/** 取快照要碰到的外部世界（全部注入，测试里全是假件）。 */
export interface GroupPersonaDeps {
  /** 惰性取宿主上下文（装配侧传 `host.bridge.tagContext()`）。 */
  readonly context: () => unknown
  /** 项目服务桥（`adapters/dsh-host/companion-bridge.ts` 的产物；可为空）。 */
  readonly bridge: () => CompanionBridge | null
  /** 套件 data root（进程注册表的键）；算不出来就给 `null`。 */
  readonly dataRoot: () => string | null
  readonly log: (line: string) => void
}

/** 取到快照之后的观测：**来源**要能进日志，否则"为什么这次不像角色"只能靠猜。 */
export interface GroupPersonaRead {
  readonly snapshot: GroupPersonaSnapshot | null
  /** `ctx` / `registry` / `bridge` / `none`。 */
  readonly via: 'ctx' | 'registry' | 'bridge' | 'none'
  /** 没取到时的原因（一行，进日志用）。 */
  readonly reason: string
}

/** `ctx.get` 可能抛（`inject` 未声明时 cordis 会炸属性访问）；这里只吞不猜。 */
function fromContext(deps: GroupPersonaDeps): unknown {
  try {
    const ctx = deps.context() as { get?: (key: string) => unknown } | null | undefined
    if (typeof ctx?.get !== 'function') return undefined
    return ctx.get(GROUP_PERSONA_SERVICE)
  } catch {
    return undefined
  }
}

/**
 * 注册表里该试的键，**顺序有意义**。
 *
 * 第一个是「服务名\0dataRoot」的复合键：同一个 `Map` 也被 `companion-health` 用**裸
 * dataRoot** 发布，而注册表是一键一记录——foundation 先挂、health 后挂，裸键就被 health
 * 顶掉（2026-11-08 实测复现）。复合键不会被顶，所以先试它。
 *
 * 第二个才是裸 dataRoot（与 `health-service-ref.mjs` 一致的既有契约）：健康服务没装时
 * 它指向人格端口，装了则指向 health——此时 `asPort` 会判 not-a-port 并继续，降级而不是
 * 拿错对象。
 */
function registryKeys(dataRoot: string): string[] {
  return [`${GROUP_PERSONA_SERVICE}\u0000${dataRoot}`, dataRoot]
}

/** 进程级注册表：`Map<key, { service, ready() }>`，键见 {@link registryKeys}。 */
function fromRegistry(deps: GroupPersonaDeps): unknown {
  try {
    const dataRoot = deps.dataRoot()
    if (dataRoot === null || dataRoot === '') return undefined
    const holder: unknown = Reflect.get(process, PORTS_SYMBOL)
    if (!(holder instanceof Map)) return undefined
    for (const key of registryKeys(dataRoot)) {
      const entry = (holder as Map<string, unknown>).get(key) as
        | { service?: unknown; ready?: () => boolean }
        | undefined
      if (entry === undefined) continue
      // ready() 抛错 = 这个发布方不可用：宁可降级，也不要拿半初始化对象组提示词。
      if (typeof entry.ready === 'function') {
        let usable = false
        try {
          usable = entry.ready() === true
        } catch {
          usable = false
        }
        if (!usable) continue
      }
      if (entry.service === undefined || entry.service === null) continue
      return entry.service
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 项目服务桥（模块级；新布局下 `home` 的父目录才是套件根，能不能解析到取决于部署形态）。 */
function fromBridge(deps: GroupPersonaDeps): unknown {
  try {
    return deps.bridge()?.resolve(GROUP_PERSONA_SERVICE) ?? undefined
  } catch {
    return undefined
  }
}

/** 端口形状（`{ get(): snapshot | null }`）；形状不对就是没有。 */
function asPort(raw: unknown): GroupPersonaPort | null {
  if (raw === null || typeof raw !== 'object') return null
  const port = raw as { get?: unknown }
  return typeof port.get === 'function' ? (port as GroupPersonaPort) : null
}

/**
 * 读一次快照（**绝不抛**）。
 *
 * 返回的 `via` 与 `reason` 是给日志与诊断用的：这条路径出问题时，"哪个通道没接上"
 * 必须能从一行日志里看出来——否则只剩"她说话不像角色"这种无法定位的现象。
 */
export function readGroupPersona(deps: GroupPersonaDeps): GroupPersonaRead {
  const attempts: Array<{ via: 'ctx' | 'registry' | 'bridge'; read: () => unknown }> = [
    { via: 'ctx', read: () => fromContext(deps) },
    { via: 'registry', read: () => fromRegistry(deps) },
    { via: 'bridge', read: () => fromBridge(deps) },
  ]
  const misses: string[] = []
  for (const attempt of attempts) {
    const raw = attempt.read()
    if (raw === undefined || raw === null) {
      misses.push(`${attempt.via}:absent`)
      continue
    }
    const port = asPort(raw)
    if (port === null) {
      misses.push(`${attempt.via}:not-a-port`)
      continue
    }
    let value: unknown
    try {
      value = port.get()
    } catch (error) {
      misses.push(`${attempt.via}:threw(${describe(error)})`)
      continue
    }
    const snapshot = normalizePersonaSnapshot(value)
    if (snapshot === null) {
      misses.push(`${attempt.via}:empty`)
      continue
    }
    return { snapshot, via: attempt.via, reason: '' }
  }
  return { snapshot: null, via: 'none', reason: misses.join(',') }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
