/** `BlobStore` 的文件实现：工作区收件箱 + 本机文件读取。
 *
 * 文件名清洗是**安全边界**，不是美化：群里可以有人发一个叫 `../../../etc/passwd`
 * 的文件。清洗规则是把路径分隔符与 Windows 保留字符全换成下划线（原实现就在这么做，
 * 这里逐字保留）。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { BlobStore, InboxWrite } from '../../ports/blob-store.js'
import { atomicWriteFile } from './atomic.js'

/** 文件名里不许出现的字符（路径分隔符与 Windows 保留字符）。 */
const UNSAFE = /[/\:*?"<>|]/g

/** 建一个收件箱。`workspacePath` 是取值函数——它对应可热改的配置项。 */
export function createBlobStore(workspacePath: () => string): BlobStore {
  return {
    async writeInbox(input: InboxWrite): Promise<string> {
      const inbox = path.join(workspacePath(), 'inbox')
      await fs.mkdir(inbox, { recursive: true })
      const safeName = input.name.replace(UNSAFE, '_')
      const target = path.join(inbox, `${input.nowMs}_${safeName}`)
      await atomicWriteFile(target, input.bytes)
      return target
    },
    async readLocal(file: string): Promise<Uint8Array | null> {
      try {
        return new Uint8Array(await fs.readFile(file))
      } catch {
        return null
      }
    },
  }
}
