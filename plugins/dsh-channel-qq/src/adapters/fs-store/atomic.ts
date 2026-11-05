/** 原子写：先写临时文件、fsync、再 rename 覆盖。
 *
 * 为什么必须这样（01 §B7）：`writeFile(target)`
 * 是"打开 → 截断 → 写"。进程在中间任何一刻死掉（崩溃、OOM、部署时被 SIGKILL），
 * 目标文件就变成半截 JSON，而下一个进程读到它就是"整个 store 空了"。
 * 全仓 31 处写文件全是这个写法，其中装着记忆、语录、提醒、好感度——丢了回不来。
 *
 * `rename` 在同一文件系统内是原子的：读者要么看到旧内容、要么看到新内容，
 * 不会看到半截。所以在临时文件里写完、fsync 落盘、再改名，就得到了这个保证。
 *
 * 顺带解决"并发保存互相踩"：两个 `save()` 同时跑，各自的临时文件互不干扰，
 * 最后改名的是后完成的那一个——不会出现两份内容交错写进同一个文件。
 * 需要更强的"后写必胜"语义时用 `adapters/fs-store/mutex.ts`。
 */

import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import * as path from 'node:path'

/** 临时文件后缀；清理时按它识别。 */
const TMP_SUFFIX = '.dsh-tmp'

/** 生成同目录下的临时文件名（同目录才能保证 rename 不跨设备）。 */
function tempPathFor(file: string): string {
  return `${file}${TMP_SUFFIX}-${process.pid}-${randomBytes(4).toString('hex')}`
}

/**
 * **Windows 上的 `rename` 会偶发 EPERM/EBUSY**：杀毒、索引、或另一个进程刚打开过目标文件时，
 * 改名会被拒（POSIX 上没有这回事）。这里退避重试几次——原子写的语义不变，
 * 只是把"系统瞬时占用"与"真的写不了"区分开。重试仍失败就照常抛，调用方按原逻辑处理。
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  let last: unknown = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      last = error
      const code = (error as { code?: string }).code ?? ''
      if (!RENAME_RETRY_CODES.has(code)) throw error
      // 5ms → 10 → 20 → 40 → 80：总等待 ~155ms，足够躲过杀毒/索引的瞬时占用。
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt))
    }
  }
  throw last
}

/**
 * 原子地写一个文本文件。
 *
 * @param file 目标路径（目录会自动创建）
 * @param data 完整内容
 */
export async function atomicWriteFile(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = tempPathFor(file)
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(tmp, 'w')
    await handle.writeFile(data)
    // fsync：只 rename 不 fsync 的话，机器断电可能留下"改名成功但内容还没落盘"的文件。
    await handle.sync()
    await handle.close()
    handle = null
    await renameWithRetry(tmp, file)
  } catch (error) {
    if (handle !== null) {
      try { await handle.close() } catch { /* 已经关了 */ }
    }
    // 失败了要把临时文件收掉，否则目录里会慢慢堆垃圾。
    try { await fs.rm(tmp, { force: true }) } catch { /* 没建起来就算了 */ }
    throw error
  }
}

/** 原子地写一个 JSON 文件（换行结尾，便于 diff 与 `cat`）。 */
export async function atomicWriteJson(file: string, value: unknown, indent = 2): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(value, null, indent)}\n`)
}

/**
 * 读文本；不存在或读不了返回 null（**不抛**）。
 *
 * 与 `save` 的不对称是有意的：读失败最常见的原因是"第一次运行、文件还没建"，
 * 那不该让插件起不来。但调用方要能区分"空"和"读不到"，所以返回 null 而不是空串。
 */
export async function readTextFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 读 JSON；不存在/损坏/形状不对都返回 null。
 *
 * @param validate 形状校验；返回 false 视为损坏
 */
export async function readJsonFileOrNull<T>(
  file: string,
  validate?: (value: unknown) => value is T,
): Promise<T | null> {
  const text = await readTextFileOrNull(file)
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (validate !== undefined && !validate(parsed)) return null
  return parsed as T
}

/**
 * 清理目录里本模块留下的孤儿临时文件（进程被杀时会留下）。
 *
 * 只在启动时跑一次即可；返回清掉的数量。
 */
export async function sweepTempFiles(dir: string): Promise<number> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.includes(TMP_SUFFIX)) continue
    try {
      await fs.rm(path.join(dir, name), { force: true })
      removed += 1
    } catch {
      /* 别为了清垃圾让启动失败 */
    }
  }
  return removed
}
