/** 向**兄弟插件行**发布一个服务（进程级注册表 + host.provide 两路）。
 *
 * 为什么需要这个文件：`dsh-channel-qq` 与 `companion-group` 在合成里是兄弟行，
 * `ctx.provide` 出不了自己的子树（2026-11-04 健康服务事故的结论），所以进程级注册表
 * （`Symbol.for('dsh.companion.ports.v1')` → `Map<key, { service, ready }>`）才是能跨过去的通道。
 *
 * 三条规则（照抄 foundation 的 `port-publish.mjs`，并在测试里钉住）：
 *   1. **复合键无条件写**：`<name>\u0000<root>` 永远不会和别的服务撞；
 *   2. **裸 dataRoot 只在空位时写**：`companion-health` 也发布裸键，后挂载者覆盖前者
 *      （2026-11-08 实测过），所以不能抢；
 *   3. **绝不抛**：发布失败只影响"对面看不到"，不该把通道挂载弄崩。
 *
 * 为什么放在 `adapters/`：这里要碰 `process` 与 `Reflect`，属于"与宿主/运行时打交道"的活；
 * `app/` 与 `core/` 保持可重放（分层 R8）。
 */

/** 所有 companion 端口共用的一枚 symbol（与 foundation/health 用同一枚）。 */
export const PORTS_SYMBOL: symbol = Symbol.for('dsh.companion.ports.v1')

/** 一个已发布端口的账目条目。 */
interface PortEntry {
  readonly service: unknown
  readonly ready: () => boolean
}

/** 取（必要时创建）进程级注册表。 */
function registry(): Map<string, PortEntry> {
  const holder: unknown = Reflect.get(process, PORTS_SYMBOL)
  if (holder instanceof Map) return holder as Map<string, PortEntry>
  const created = new Map<string, PortEntry>()
  Reflect.set(process, PORTS_SYMBOL, created)
  return created
}

/** 一个 root 的拼写变体（反斜杠/正斜杠/去尾分隔符/Windows 小写）。 */
export function rootVariants(root: string): string[] {
  const raw = String(root ?? '').trim()
  if (raw === '') return []
  const variants = new Set<string>([raw])
  const slashed = raw.replace(/\\/g, '/')
  variants.add(slashed)
  variants.add(slashed.replace(/\/+$/, ''))
  if (process.platform === 'win32') for (const variant of [...variants]) variants.add(variant.toLowerCase())
  variants.delete('')
  return [...variants]
}

/** 一个名字在某个 root 下的复合键（消费端先试这些，再回落到裸键）。 */
export function scopedKeys(name: string, root: string): string[] {
  return rootVariants(root).map((variant) => `${name}\u0000${variant}`)
}

/**
 * 发布一个服务，返回幂等的释放函数。
 *
 * `ctx` 可以是任何带 `provide` 的东西（本仓库的 `SubHost`）；没有就只走进程注册表。
 */
export function publishServiceToPeers(input: {
  name: string
  service: unknown
  root: string
  ready?: () => boolean
  provide?: (name: string, service: unknown) => void
  log?: (line: string) => void
}): () => void {
  const { name, service, root } = input
  const log = input.log ?? (() => {})
  if (name === '' || service === null || service === undefined) return () => {}
  const entry: PortEntry = { service, ready: input.ready ?? (() => true) }
  const written: string[] = []
  let released = false
  try {
    const table = registry()
    for (const key of scopedKeys(name, root)) {
      table.set(key, entry)
      written.push(key)
    }
    for (const key of rootVariants(root)) {
      const occupant = table.get(key)
      if (occupant !== undefined && occupant.service !== service) {
        log(`publish: 裸键已被其它服务占用，${name} 只写复合键`)
        continue
      }
      table.set(key, entry)
      written.push(key)
    }
  } catch (error) {
    log(`publish: 进程注册表不可用（${describe(error)}）`)
  }
  try {
    input.provide?.(name, service)
  } catch (error) {
    log(`publish: host.provide('${name}') 失败（继续用注册表）：${describe(error)}`)
  }
  return () => {
    if (released) return
    released = true
    try {
      const table = registry()
      for (const key of written) if (table.get(key) === entry) table.delete(key)
    } catch {
      /* 释放必须幂等且不抛 */
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
