/** JSON 文件存储：`Store<T>` 的默认实现（原子写 + 串行化 + 备份）。
 *
 * 这是 8 个以上 store 共用的那一套 `mkdir + writeFile(JSON.stringify(...))` 的替代品。
 * 三个保证：
 *
 *   1. **原子替换**——要么完整生效，要么完全不动（`atomic.ts`）；
 *   2. **写不丢**——同一路径上的保存排队（`mutex.ts`），后到的不会覆盖先到的中间态；
 *   3. **留一份上一版**——保存前把现有内容挪到 `<file>.bak`。原子写已经能防
 *      "写坏"，但防不了"写对了却是错的"（代码 bug 把整个 store 写空）。
 *      有一份上一版，后台就能一键回退，而记忆/语录这类数据是不可再生的。
 *
 * 读的语义刻意宽松：文件不存在、损坏、形状不对都返回 `fallback`，
 * **绝不因为存储而让插件起不来**（原代码各处也是这个态度，这里只是统一实现）。
 */

import { promises as fs } from 'node:fs'
import type { Store } from '../../ports/store.js'
import { atomicWriteFile, readJsonFileOrNull } from './atomic.js'
import { withLock } from './mutex.js'

export interface JsonStoreOptions<T> {
  /** 形状校验；返回 false 视为损坏，退回 `fallback`。 */
  validate?: (value: unknown) => value is T
  /** 保存前是否留 `<file>.bak`。默认留。 */
  keepBackup?: boolean
  /**
   * 序列化缩进。默认 `1`——本仓库 8 个 store 的历史文件都是 1 空格缩进，
   * 换缩进等于把用户的记忆/语录文件全部重写一遍（内容一样、diff 全红）。
   */
  indent?: number
  /**
   * 是否在末尾补换行。默认 `false`：存量文件没有换行，迁移**不改一个字节**。
   * 新写的 store 想要 POSIX 结尾，显式传 `true`。
   */
  trailingNewline?: boolean
  /** 启动/保存/回退的日志出口。 */
  log?: (line: string) => void
}

/** 一份 `<file>.bak` 的路径。 */
export function backupPathOf(file: string): string {
  return `${file}.bak`
}

export class JsonStore<T> implements Store<T> {
  readonly path: string
  private readonly validate: ((value: unknown) => value is T) | undefined
  private readonly keepBackup: boolean
  private readonly indent: number
  private readonly trailingNewline: boolean
  private readonly log: (line: string) => void

  constructor(file: string, options: JsonStoreOptions<T> = {}) {
    this.path = file
    this.validate = options.validate
    this.keepBackup = options.keepBackup !== false
    this.indent = options.indent ?? 1
    this.trailingNewline = options.trailingNewline ?? false
    this.log = options.log ?? ((): void => {})
  }

  /** 这份内容会以什么字节落盘（测试与"迁移不改字节"的比对用）。 */
  serialize(value: T): string {
    return JSON.stringify(value, null, this.indent) + (this.trailingNewline ? '\n' : '')
  }

  async load(fallback: T): Promise<T> {
    const value = await readJsonFileOrNull<T>(this.path, this.validate)
    return value === null ? fallback : value
  }

  /** 读备份（后台"回退到上一版"用）。 */
  async loadBackup(): Promise<T | null> {
    return await readJsonFileOrNull<T>(backupPathOf(this.path), this.validate)
  }

  async save(value: T): Promise<void> {
    await withLock(this.path, async () => {
      if (this.keepBackup) {
        // 备份**不是**必需功能：拷不动（权限、磁盘满）只记一行日志，不能拦住保存。
        try {
          await fs.copyFile(this.path, backupPathOf(this.path))
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          // ENOENT = 第一次保存，还没有旧文件可备份，属于正常。
          if (code !== 'ENOENT') {
            this.log(`store backup skipped for ${this.path}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      await atomicWriteFile(this.path, this.serialize(value))
    })
  }

  /** 用备份覆盖当前文件。没有备份就抛错（调用方要能告诉运维"没有可回退的版本"）。 */
  async restoreBackup(): Promise<void> {
    await withLock(this.path, async () => {
      const backup = await fs.readFile(backupPathOf(this.path), 'utf-8')
      await atomicWriteFile(this.path, this.serialize(JSON.parse(backup) as T))
    })
  }
}
