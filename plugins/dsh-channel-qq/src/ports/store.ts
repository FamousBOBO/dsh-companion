/** 存储端口：JSON 集合与追加式日志。
 *
 * 为什么需要它（01 §B7）：全仓 21 个文件、
 * 31 处 `writeFile`，**没有一处是原子写**；8 个以上 store 各写一套
 * `mkdir + writeFile(JSON.stringify(...))`；并发保存可能交错，写到一半崩溃会
 * 损坏 `entries.json`、语录、提醒。而这里面的东西——记忆、语录、提醒、好感度
 * ——**丢了就回不来**。
 *
 * 端口只描述"要什么"，不描述"怎么写"：
 *   - `Store`：整份读写一个 JSON 值（实现负责原子替换、串行化、备份）；
 *   - `LogStream`：只追加、按行读（JSONL 形态，用于发送记录、审计）。
 *
 * 实现见 `adapters/fs-store`（P2.4）。
 */

/** 整份读写的 JSON 存储。 */
export interface Store<T> {
  /** 读一次；文件不存在返回 `fallback`，损坏也返回 `fallback`（绝不因存储而启动失败）。 */
  load(fallback: T): Promise<T>
  /** 覆盖写。实现必须做到：要么完整生效，要么完全不动（原子替换）。 */
  save(value: T): Promise<void>
  /** 文件路径（诊断与后台展示用）。 */
  readonly path: string
}

/** 只追加的 JSONL 日志。 */
export interface LogStream<T> {
  /** 追加一条。实现必须保证并发追加不交错。 */
  append(entry: T): Promise<void>
  /** 读最后 `count` 条（顺序为写入顺序）。 */
  tail(count: number): Promise<T[]>
  /** 只保留最后 `keep` 条，用于封顶。 */
  trim(keep: number): Promise<void>
  readonly path: string
}

/**
 * 存储操作的失败原因；实现不应把 IO 错误伪装成"空数据"。
 *
 * `cause` 交给 `Error` 自己的第二参数（`super(message, { cause })`），不自己再声明
 * 一个同名字段——那会和基类冲突（`noImplicitOverride` 下直接报错），
 * 也会让 `err.cause` 的语义出现两套。
 */
export class StoreError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StoreError'
  }
}
