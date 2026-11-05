/** 把服务发布到宿主 ctx 的三档回退（P2.5-3A-4 / 3B 共用）。
 *
 * 为什么需要三档：宿主版本不同，可用 API 也不同——
 *   `ctx.provide(name, value)`（cordis 的正规做法）→ `ctx.set(name, value)` → 属性赋值。
 * 走哪一档都要**记一行日志**（排查"runtime 为什么取不到我们的服务"时先看这一行），
 * 三档都失败也只记日志、**不抛错**：发布失败不该把插件挂载拖垮。
 *
 * 属性赋值兜底为什么也算合理：cordis 的 `ctx.get()` 在很多版本里会读 ctx 自己的属性，
 * 所以赋值往往能生效；但它没有服务生命周期语义，所以只作最后手段。
 */

export type PublishTier = 'provide' | 'set' | 'assign' | 'failed'

interface PublishableCtx {
  provide?: (name: string, service: unknown) => void
  set?: (name: string, service: unknown) => void
}

/** 发布一个服务；返回实际走的那一档（测试据此断言回退顺序）。 */
export function publishServiceSafely(
  ctx: unknown,
  name: string,
  value: unknown,
  log: (line: string) => void,
): PublishTier {
  const target = ctx as PublishableCtx & Record<string, unknown> | null
  if (target === null || typeof target !== 'object') {
    log(`publish: ctx 不可用，${name} 没有发布出去`)
    return 'failed'
  }
  try {
    if (typeof target.provide === 'function') {
      target.provide(name, value)
      log(`publish: 已用 ctx.provide 发布 ${name}`)
      return 'provide'
    }
  } catch (error) {
    log(`publish: ctx.provide('${name}') 失败（继续退避）：${describe(error)}`)
  }
  try {
    if (typeof target.set === 'function') {
      target.set(name, value)
      log(`publish: 已用 ctx.set 发布 ${name}（provide 不可用）`)
      return 'set'
    }
  } catch (error) {
    log(`publish: ctx.set('${name}') 失败（继续退避）：${describe(error)}`)
  }
  try {
    target[name] = value
    log(`publish: 已用属性赋值兜底发布 ${name}（provide/set 都不可用）`)
    return 'assign'
  } catch (error) {
    log(`publish: 三档都失败，${name} 没有发布出去（不影响本插件功能）：${describe(error)}`)
    return 'failed'
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 发布之后**回读一次**：`ctx.get(name)` 到底取不取得到。
 *
 * 为什么必须回读：三档回退里只有 `ctx.provide` 带服务语义；`ctx.set`/属性赋值在有些
 * cordis 版本上**写得到、`get()` 读不到**。所以"发布了"≠"取得到"——这一行日志就是分辨
 * 两者的唯一证据（运维手册里"为什么 runtime 拿不到 contact 服务"第 0 步就看它）。
 */
export function verifyPublished(ctx: unknown, name: string): boolean {
  const get = (ctx as { get?: (key: string, strict?: boolean) => unknown } | null)?.get
  if (typeof get !== 'function') return false
  try {
    return get.call(ctx, name, false) !== undefined && get.call(ctx, name, false) !== null
  } catch {
    return false
  }
}
