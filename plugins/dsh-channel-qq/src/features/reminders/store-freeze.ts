/** 已发布状态的**不可变**保证：深度冻结（只读视图不再泄露可变行）。 */

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  // **遍历子键不用转型**（`check-layers` R7）：冻结跟 `T` 的形状无关，而
  // `Reflect.ownKeys` / `Reflect.get` 的签名本来就是"任意对象 + 任意键 ⇒ 值"，
  // 所以这里不需要假装知道 `T` 是什么（把 `T` 转成 `Record<string, unknown>` 才是假装）。
  for (const key of Reflect.ownKeys(value)) {
    const child: unknown = Reflect.get(value, key)
    deepFreeze(child)
  }
  return value
}
