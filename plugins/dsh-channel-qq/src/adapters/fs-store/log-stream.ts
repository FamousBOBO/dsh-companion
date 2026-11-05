/** 追加式日志流：`LogStream<T>` 的实现。
 *
 * 与 `JsonStore` 的分工：`JsonStore` 是"整份读、整份写"（配置、语录、记忆索引），
 * `JsonlLogStream` 是"只追加、按尾部读"（发送记录、结构化日志、审计）。
 * 两者都靠 `mutex.ts` 串行化——追加虽然天然不易写坏，但同一次追加写一半仍然是
 * 半截 JSONL。
 *
 * 封顶（`trim`）是必需的：日志文件没有上限就是磁盘泄漏。旧实现里
 * `channel-qq.log` 一直没有上限，只是靠"出问题才去看"掩盖了这一点。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { LogStream } from '../../ports/store.js'
import { withLock } from './mutex.js'

/** 一行怎么变成值、值怎么变回一行。 */
export interface LineCodec<T> {
  encode(value: T): string
  decode(line: string): T | null
}

/** 每行一个 JSON 对象。 */
export function jsonCodec<T>(): LineCodec<T> {
  return {
    encode: (value: T): string => JSON.stringify(value),
    decode: (line: string): T => JSON.parse(line) as T,
  }
}

/**
 * 每行就是原样的文本——用于**保持旧格式**的日志文件。
 *
 * 这个 codec 存在的唯一理由：`channel-qq.log` 必须继续是"<时间戳> <内容>"的
 * 纯文本，`deploy/log-analyze.mjs` 与后台日志页都按那个格式读。如果把它也当成
 * JSONL 写，每行会多出一对引号，两个消费者就同时坏了。
 */
export const plainCodec: LineCodec<string> = {
  encode: (value: string): string => value,
  decode: (line: string): string => line,
}

export class JsonlLogStream<T> implements LogStream<T> {
  readonly path: string
  private readonly codec: LineCodec<T>
  private readonly log: (line: string) => void

  constructor(file: string, options: { codec?: LineCodec<T>; log?: (line: string) => void } = {}) {
    this.path = file
    this.codec = options.codec ?? jsonCodec<T>()
    this.log = options.log ?? ((): void => {})
  }

  /** 追加一条；用 `O_APPEND` 语义（`fs.appendFile`），整条一次写入。 */
  async append(entry: T): Promise<void> {
    await this.appendLine(this.codec.encode(entry))
  }

  /** 追加一整行（`line` 里不要带换行）。 */
  async appendLine(line: string): Promise<void> {
    await withLock(this.path, async () => {
      await fs.mkdir(path.dirname(this.path), { recursive: true })
      // 一次 write 一条：POSIX 对 O_APPEND 的追加写保证小于 PIPE_BUF 的写不交错，
      // 而这里的条目远小于那个值。串行化再叠一层保险。
      await fs.appendFile(this.path, `${line}\n`, 'utf-8')
    })
  }

  /** 读最后 `count` 条（写入顺序）。文件不存在或读不了都返回空数组。 */
  async tail(count: number): Promise<T[]> {
    const lines = await this.readLines()
    return lines.slice(-count).map((line) => this.parse(line)).filter((v): v is T => v !== null)
  }

  /** 只保留最后 `keep` 行。整份重写，所以先写临时文件再改名（原子替换）。 */
  async trim(keep: number): Promise<void> {
    await withLock(this.path, async () => {
      const lines = await this.readLines()
      if (lines.length <= keep) return
      const tmp = `${this.path}.trim-${String(process.pid)}`
      await fs.writeFile(tmp, `${lines.slice(-keep).join('\n')}\n`, 'utf-8')
      await fs.rename(tmp, this.path)
    })
  }

  private async readLines(): Promise<string[]> {
    try {
      const raw = await fs.readFile(this.path, 'utf-8')
      return raw.split('\n').filter((line) => line !== '')
    } catch {
      return []
    }
  }

  /** 坏一行不能带崩整份日志——半截写入在崩溃之后是常态。 */
  private parse(line: string): T | null {
    try {
      return this.codec.decode(line)
    } catch {
      this.log(`log stream: skipped a corrupt line in ${this.path}`)
      return null
    }
  }
}
