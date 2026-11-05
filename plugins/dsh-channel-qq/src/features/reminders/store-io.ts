/**
 * **提醒文件的持久化适配器**（设计 §1.4/§5）：tagged read + **唯一写入口** + 提交回执。
 *
 * 三条硬边界：
 *   1. `readOnce()` 必须分开"文件不存在"（`missing`）与"内容是 JSON null"（`present`）；
 *   2. `replaceSerialized()` 返回 `committed` = **已经提交**（rename 成功）；抛错 = **未提交**；
 *   3. 普通失败一律抛 `PERSIST_FAILED`，**不许**吞错返回 boolean（吞错是前三轮翻车的根因）。
 */

import { promises as fs } from 'node:fs'
import { atomicWriteFile, atomicWriteJson } from '../../adapters/fs-store/atomic.js'
import type { ReadResult, ReminderPersistence } from './store-contract.js'
import { storeFault } from './store-contract.js'

export interface ReadFailureRecord {
  at: number
  reason: 'unreadable' | 'permission'
  source: string
  detail: string
}

export class ReminderFile implements ReminderPersistence {
  constructor(readonly file: string, private readonly log: (line: string) => void = () => {}) {}

  get markerFile(): string { return `${this.file}.readonly.json` }

  /** 一次读：数据与错误分类来自同一次 `readFile`（不许读两次，第二次的错会被吞掉）。 */
  async readOnce(): Promise<ReadResult> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      const code = (error as { code?: string }).code ?? ''
      if (code === 'ENOENT') return { kind: 'missing' }
      return {
        kind: 'failed',
        failure: {
          at: Date.now(),
          reason: code === 'EACCES' || code === 'EPERM' ? 'permission' : 'unreadable',
          source: this.file,
          detail: error instanceof Error ? error.message : String(error),
        },
      }
    }
    try {
      return { kind: 'present', raw: JSON.parse(text) as unknown }
    } catch (error) {
      return {
        kind: 'failed',
        failure: {
          at: Date.now(),
          reason: 'unreadable',
          source: this.file,
          detail: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  /** **唯一写入口**：只在这里落盘；成功 ⇒ `committed`；失败 ⇒ 抛出（未提交）。 */
  async replaceSerialized(bytes: string): Promise<{ kind: 'committed' }> {
    try {
      await atomicWriteFile(this.file, bytes)
      return { kind: 'committed' }
    } catch (error) {
      throw storeFault('PERSIST_FAILED', 'replaceSerialized',
        `写 ${this.file} 失败（未提交）：${error instanceof Error ? error.message : String(error)}`, error)
    }
  }

  async readMarker(): Promise<ReadFailureRecord | null> {
    try {
      const text = await fs.readFile(this.markerFile, 'utf8')
      const parsed = JSON.parse(text) as ReadFailureRecord
      if (typeof parsed?.at !== 'number' || typeof parsed?.reason !== 'string') return null
      return parsed
    } catch {
      return null
    }
  }

  /** 故障标记也走**原子写**（R4）：它是"上次为什么锁"的唯一证据，半截 JSON 读回来就是 `null`。 */
  async writeMarker(failure: ReadFailureRecord): Promise<void> {
    try {
      await atomicWriteJson(this.markerFile, failure)
    } catch (error) {
      this.log(`reminders: 写故障标记 ${this.markerFile} 失败（不影响锁定本身）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async removeMarker(): Promise<void> {
    try {
      await fs.rm(this.markerFile, { force: true })
    } catch (error) {
      throw storeFault('RECOVERY_MARKER_FAILED', 'removeMarker',
        `删不掉故障标记 ${this.markerFile}：${error instanceof Error ? error.message : String(error)}`, error)
    }
  }
}
