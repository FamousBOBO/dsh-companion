/** 追加一行到文件（带文件锁与"首次写头"原子判定）。
 *
 * 为什么放在 adapters：仓库规则是"写文件只走 atomicWriteFile，只有 adapters/fs-store
 * 可以直接 write"。追加式日志（原话簿）不适合整份重写，所以把 `appendFile` 收在这里，
 * 与其它写路径共用同一把锁，首次写头也不会并发写两遍。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { withLock } from './mutex.js'

/**
 * 追加一行；文件不存在时先写 `header`。
 * @returns 写入成功为 true；失败只返回 false，由调用方决定怎么记日志。
 */
export async function appendLineWithHeader(file: string, header: string, line: string): Promise<boolean> {
  try {
    await withLock(file, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      let exists = true
      try {
        await fs.access(file)
      } catch {
        exists = false
      }
      await fs.appendFile(file, exists ? line : `${header}${line}`, 'utf8')
    })
    return true
  } catch {
    return false
  }
}
