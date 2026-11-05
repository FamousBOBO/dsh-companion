/** 「今天这件事已经做过了」的持久化标记。
 *
 * 旧实现是三个内存里的 `Set`：`morningDone` / `dreamDone` / `knowledgeDone`。
 * 代价在部署期直接暴露——早报窗口是 06:00-11:59，只要在这个窗口里重启一次，
 * 早报就**再发一遍**；04 点重启则会再做梦一次、再往主群发一句"咱梦到…"。
 * 而部署恰恰就是重启。
 *
 * 现在标记落在 `<dshHome>/channel-qq/scheduler-state.json`，跨进程存活。
 * 写入按「临时文件 + rename」原子替换：定时器可能和进程退出撞在一起，
 * 半截 JSON 会让下一次启动读不到任何标记（等于全部重发一次），这正是要避免的。
 *
 * 只依赖 `node:fs` / `node:path`，所以本地测试可以直接跑。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

/** 磁盘格式版本；将来改结构时用来判断是不是要迁移。 */
const FORMAT_VERSION = 1

/** 标记保留时长：超过这个天数的键在下一次写入时被清掉（只防无限增长）。 */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000

interface StateFile {
  version: number
  /** 键 → 标记时刻（ISO 字符串）。 */
  done: Record<string, string>
}

/**
 * 丢掉过期标记（纯函数，测试直接喂数据）。
 *
 * @param done 现有标记
 * @param nowMs 当前时刻（毫秒）
 * @returns 只保留未过期项的副本
 */
export function pruneDone(done: Readonly<Record<string, string>>, nowMs: number): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, at] of Object.entries(done)) {
    const stamp = Date.parse(at)
    // 解析不了的一律丢掉：留着只会永远命中不了，白占空间。
    if (Number.isNaN(stamp)) continue
    if (nowMs - stamp <= RETAIN_MS) kept[key] = at
  }
  return kept
}

export interface SchedulerStateOptions {
  /** 状态文件绝对路径。 */
  file: string
  log?: (line: string) => void
  /** 注入时钟（测试用）。 */
  now?: () => number
}

/**
 * 「已完成的定时任务」标记表。
 *
 * 用法：`await state.load()` 一次；每轮用 `state.has(key)` 判重，
 * 真要执行时 `state.mark(key)`（会立即落盘）。
 */
export class SchedulerState {
  private readonly file: string
  private readonly log: (line: string) => void
  private readonly now: () => number
  private done: Record<string, string> = {}
  private loaded = false

  constructor(options: SchedulerStateOptions) {
    this.file = options.file
    this.log = options.log ?? ((): void => {})
    this.now = options.now ?? ((): number => Date.now())
  }

  /** 读盘。读不到/读坏了都当「没有任何标记」，绝不因为状态文件而启动失败。 */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf-8'))
      if (parsed === null || typeof parsed !== 'object') return
      const done = (parsed as { done?: unknown }).done
      if (done === null || typeof done !== 'object' || Array.isArray(done)) return
      const kept: Record<string, string> = {}
      for (const [key, value] of Object.entries(done as Record<string, unknown>)) {
        if (typeof value === 'string') kept[key] = value
      }
      this.done = kept
      const count = Object.keys(kept).length
      if (count > 0) this.log(`scheduler state loaded: ${count} marks`)
    } catch (error) {
      // 文件不存在是**正常**（第一次跑）；损坏是**异常**——后者必须留痕，
      // 否则"今天做过了"静默归零，早报/梦/抽取当天重跑，而日志里一个字都没有。
      // 启动失败仍然不允许（这是设计），只是要把两种情况分开。
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        this.log(`scheduler state READ FAILED（当作空的继续）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** 这个键今天是否已经做过。 */
  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.done, key)
  }

  /** 记下「做过了」并立刻落盘。 */
  mark(key: string): void {
    this.done[key] = new Date(this.now()).toISOString()
    this.save()
  }

  /** 当前标记数（诊断用）。 */
  size(): number {
    return Object.keys(this.done).length
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const pruned = pruneDone(this.done, this.now())
      this.done = pruned
      const payload: StateFile = { version: FORMAT_VERSION, done: pruned }
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
      renameSync(tmp, this.file)
    } catch (error) {
      // 落盘失败不能让定时任务本身挂掉：最坏情况是重启后重发一次，
      // 与改造前的行为一致，不会更差。
      this.log(`scheduler state save failed: ${error instanceof Error ? error.message : String(error)}`)
      try { rmSync(`${this.file}.tmp`, { force: true }) } catch { /* 已经没了 */ }
    }
  }
}
