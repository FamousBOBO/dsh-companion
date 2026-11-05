/** 串行化：把同一个键上的异步操作排成队。
 *
 * 场景：群里连着来几条消息，两个保存同时开始；或者"读到 → 改 → 写回"这种
 * 读改写序列被并发跑两遍（后完成的把先完成的覆盖掉，丢一次更新）。
 * `atomicWriteFile` 保证"不会写坏"，但保证不了"不丢更新"——那需要排队。
 *
 * 实现是**按键排队**：不同键互不阻塞（两个无关的存储不该互相等），
 * 同一个键严格串行。键通常就是文件路径。
 */

/** 键 → 队尾（一个"永不 reject"的 promise）。 */
const tails = new Map<string, Promise<void>>()

/**
 * 在 `key` 上独占执行 `run`。
 *
 * @param key 排队键（通常用文件路径）
 * @param run 要独占执行的操作
 * @returns `run` 的返回值；`run` 抛错原样抛出，且**不影响排在后面的任务**
 */
export async function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  // `then(run, run)`：前一个成功或失败都接着跑——一次失败不该卡死整条队。
  const result = previous.then(run, run)
  // 链上只存"完成"这一事实，不存结果也不存错误，否则一次失败会顺着链传下去。
  const nextTail: Promise<void> = result.then(() => undefined, () => undefined)
  tails.set(key, nextTail)
  try {
    return await result
  } finally {
    // 只有当没人接在我们后面时才清键，否则会把后一个任务的队尾抹掉。
    // 这样长跑进程里 Map 不会无限增长。
    if (tails.get(key) === nextTail) tails.delete(key)
  }
}

/** 当前在排队的键（诊断用）。 */
export function lockedKeys(): string[] {
  return [...tails.keys()]
}
