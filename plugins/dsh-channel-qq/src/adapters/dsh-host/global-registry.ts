/** 「陪伴空间」设置桥的**进程级注册表**（宿主形状的知识，只允许出现在 adapters/）。
 *
 * 为什么这段必须住在这里：`src/features/admin/studio-bridge.ts` 需要用 `globalThis[symbol]`
 * 装一张跨模块可见的注册表，而写这种代码必然要绕过类型系统（`as unknown as`）。分层检查 R7
 * 规定"绕过类型的转型只能出现在 `src/adapters/`"——理由是同一种知识散落时，"宿主升级之后
 * 哪里会坏"就没有答案了。所以转型留在这里，业务侧只看到一个窄接口。
 *
 * 为什么挂在 `globalThis` 而不是模块级 Map：Studio 的客户端脚本与 QQ 插件行可能来自不同的
 * module realm（bundle / 插件行 / 热重载后的新实例），模块标识会变，`globalThis` 不会。
 */

/** 一张按 `dshHome` 索引的表；值形状由调用方决定（这里只管"存取同一张表"）。 */
export interface GlobalRegistry<T> {
  get(key: string): T | undefined
  set(key: string, value: T): void
  delete(key: string): void
}

/** 取（必要时创建）`globalThis[symbol]` 上那张表。 */
export function globalRegistryOf<T>(symbol: symbol): GlobalRegistry<T> {
  const holder = globalThis as unknown as { [key: symbol]: Map<string, T> | undefined }
  const registry = holder[symbol] ?? new Map<string, T>()
  holder[symbol] = registry
  return {
    get: (key) => registry.get(key),
    set: (key, value) => { registry.set(key, value) },
    delete: (key) => { registry.delete(key) },
  }
}
