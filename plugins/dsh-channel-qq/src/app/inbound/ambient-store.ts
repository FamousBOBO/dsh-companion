/** 旁听状态的**装配层**：配置 → 每群一个 `AmbientRing`。
 *
 * 为什么要有这一层而不是让流水线自己 `new`：配置是"现取"的（后台改完立即生效），
 * 而环是"有状态"的。两者的寿命不一样——配置每次读，环按群活。分开之后：
 *   - 流水线只做 `ambient.ring(groupId, limits).add(...)`；
 *   - 上限变了（`presence.ambient*` 热改）时环按新上限裁一次，不重建、不丢上下文；
 *   - 群被移出白名单时 `forget(groupId)` 直接抹掉，不会在内存里留一份"看不见的旁听"。
 *
 * 这里**不做**任何 IO：旁听是短期背景，不落盘。落盘的证据是 sent-log 与会话历史的事。
 */

import { AmbientRing, type AmbientLimits } from '../../core/ambient.js'

/** 只取本模块要用的那几个配置项（结构类型：不把整份 config 拖进来）。 */
export interface PresenceSettings {
  readonly enabled: boolean
  readonly groups: readonly unknown[]
  readonly ambientMaxEntries: number
  readonly ambientTtlMs: number
  readonly ambientMaxChars: number
}

/** 缺省视为"关"（旧配置构造里没有这一段）。泛型保留调用方那一份配置的附加字段。 */
export function presenceSettingsOf<T extends PresenceSettings>(
  config: { readonly presence?: T | undefined },
): T | null {
  return config.presence === undefined ? null : config.presence
}

/**
 * 白名单群号。
 *
 * 配置层已经按 `itemsKind: 'number'` 归一，但**手改 JSON / 旧配置文件**里出现过字符串
 * （2026-10-19 的 `primaryGroup` 就是这样：存成 `"1000000004"`，所有严格比较恒假）。
 * 这里再兜一层：认得出就换成数字，认不出就丢掉——宁可不启用，也不要把群号弄错。
 */
export function presenceGroupsOf(settings: PresenceSettings): number[] {
  if (!Array.isArray(settings.groups)) return []
  const out: number[] = []
  for (const raw of settings.groups) {
    const value = typeof raw === 'string' ? Number(raw.trim()) : raw
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) out.push(value)
  }
  return out
}

/** 这个群在不在旁听白名单里（总开关关着时永远 false）。 */
export function presenceAppliesTo(settings: PresenceSettings | null, groupId: number | null): boolean {
  if (settings === null || settings.enabled !== true || groupId === null) return false
  return presenceGroupsOf(settings).includes(groupId)
}

/** 缓冲上限（配置值原样传下去，环自己夹安全值）。 */
export function ambientLimitsOf(settings: PresenceSettings): AmbientLimits {
  return {
    maxEntries: settings.ambientMaxEntries,
    ttlMs: settings.ambientTtlMs,
    maxChars: settings.ambientMaxChars,
  }
}

export interface AmbientStoreDeps {
  readonly log: (line: string) => void
}

/** 群号 → 旁听环。纯内存，进程结束就没了（这正合"短期背景"的定位）。 */
export class AmbientStore {
  private readonly rings = new Map<number, AmbientRing>()

  constructor(private readonly deps: AmbientStoreDeps) {}

  /** 取（必要时新建）这个群的环；上限每次现对齐。 */
  ring(groupId: number, limits: AmbientLimits): AmbientRing {
    const existing = this.rings.get(groupId)
    if (existing !== undefined) {
      if (!sameLimits(existing.limits, limits)) existing.configure(limits)
      return existing
    }
    const created = new AmbientRing(limits)
    this.rings.set(groupId, created)
    this.deps.log(`presence: ambient buffer created for group ${String(groupId)}`)
    return created
  }

  /** 白名单里现在有哪些群（诊断用）。 */
  groups(): number[] {
    return [...this.rings.keys()]
  }

  /** 群被移出白名单/禁用时抹掉它的旁听（不留看不见的状态）。 */
  forget(groupId: number): void {
    if (this.rings.delete(groupId)) this.deps.log(`presence: ambient buffer dropped for group ${String(groupId)}`)
  }
}

function sameLimits(a: AmbientLimits, b: AmbientLimits): boolean {
  return a.maxEntries === b.maxEntries && a.ttlMs === b.ttlMs && a.maxChars === b.maxChars
}
