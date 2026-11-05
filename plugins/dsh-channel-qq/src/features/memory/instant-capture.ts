/** 即时抽取（P0 的白天侧，调研 [20261024_memory-system-research.md] §6-P0）。
 *
 * 夜间抽取（`nightly.ts` 的 diary-extract / session-split）只能覆盖**昨天**；
 * "被纠正的那句话"等到凌晨再抽，纠正的情绪与上下文早就凉了。feiyu-memory 的
 * 解法是 turn-end 带外队列：回合结束时极短判断一次，值得记才固化——本文件
 * 是它的规则版：
 *
 *   `begin(room, event)` 记下这回合用户说了什么 → `end(room)` 时：
 *   规则判据（`shouldCaptureInstant`，零模型）→ 每日配额 / 房间冷却 →
 *   走抽取通道固化一条短事实（**带外异步**，绝不阻塞回合收尾）。
 *
 * 三条纪律（与夜间任务同源）：
 *   - **失败只进日志**：抽取挂了不影响对话，下一回合再来；
 *   - **每条都低置信**（confidence 0.5、importance 4）：聊天原文的转述，
 *     错了不致命，被召回验证会自然爬高（withHit 的 +0.05）；
 *   - **配额与冷却落盘**：重启不清零，"今天已经抽够了"要跨重启成立。
 */

import * as path from 'node:path'
import { atomicWriteFile, readTextFileOrNull } from '../../adapters/fs-store/atomic.js'
import { CAPTURE_DAILY_CAP, CAPTURE_MIN_GAP_MS, distillFact, shouldCaptureInstant } from '../../core/memory/distill.js'
import { localDayKey } from '../../core/schedule/stamp.js'
import type { MemorySource } from '../../core/memory/model.js'
import type { ExtractedItem } from './nightly-io.js'
import { findNearDuplicate } from './nightly-io.js'
import type { MemoryStore } from './store.js'

/** 配额状态：一天一行，重启不清零。 */
interface CaptureState {
  readonly day: string
  readonly count: number
}

export interface CaptureTurn {
  readonly text: string
  readonly speakerId?: number
  readonly speakerName?: string
}

export interface InstantCaptureDeps {
  readonly store: () => MemoryStore | null
  /** 抽取通道（与夜间同一配置）；没配/关着就是缺省 → 即时抽取整体关闭。 */
  readonly extract?: ((source: string, text: string) => Promise<ExtractedItem[]>) | null
  readonly log: (line: string) => void
  readonly random: () => number
  readonly clock: { now(): number }
  readonly dir: string
  readonly dailyCap?: number
}

/** 房间键的形状与 channel-qq 一致（group-<号> / dm-<号>）；只用于日志与出处。 */
function assertRoom(room: string): void {
  if (!/^(group|dm)-\d{1,12}$/.test(room)) throw new Error(`capture: 房间键不认识：${room}`)
}

export class InstantCapture {
  private readonly pending = new Map<string, CaptureTurn>()
  private readonly lastAt = new Map<string, number>()
  private state: CaptureState = { day: '', count: 0 }
  private loaded = false
  private readonly stateFile: string

  constructor(private readonly deps: InstantCaptureDeps) {
    this.stateFile = path.join(deps.dir, 'capture-state.json')
  }

  /** 回合开始：记下这回合的用户消息（begin 带的 event 文本由装配层提取）。 */
  begin(room: string, turn: CaptureTurn): void {
    assertRoom(room)
    this.pending.set(room, turn)
  }

  /** 回合结束：带外判定 + 抽取。同步返回，异步干活。 */
  end(room: string): void {
    const turn = this.pending.get(room)
    this.pending.delete(room)
    if (turn === undefined) return
    void this.capture(room, turn)
  }

  /** 今天还剩几条配额（后台状态页用）。 */
  remainingToday(): number | null {
    if (this.deps.extract === null) return null
    return Math.max(0, (this.deps.dailyCap ?? CAPTURE_DAILY_CAP) - this.state.count)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const raw = await readTextFileOrNull(this.stateFile)
    if (raw === null) return
    try {
      const parsed = JSON.parse(raw) as CaptureState
      if (typeof parsed?.day === 'string' && typeof parsed?.count === 'number') this.state = parsed
    } catch { /* 坏文件当没有 */ }
  }

  private async consumeQuota(now: Date): Promise<boolean> {
    const day = localDayKey(now)
    await this.ensureLoaded()
    if (this.state.day !== day) this.state = { day, count: 0 }
    const cap = this.deps.dailyCap ?? CAPTURE_DAILY_CAP
    if (this.state.count >= cap) return false
    this.state = { day, count: this.state.count + 1 }
    try {
      await atomicWriteFile(this.stateFile, JSON.stringify(this.state))
    } catch (error) {
      this.deps.log(`capture: 配额落盘失败（不阻断）：${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }

  private async capture(room: string, turn: CaptureTurn): Promise<void> {
    const extract = this.deps.extract ?? null
    const store = this.deps.store()
    if (extract === null || store === null) return
    if (!shouldCaptureInstant(turn.text)) return
    const now = this.deps.clock.now()
    const last = this.lastAt.get(room)
    if (last !== undefined && now - last < CAPTURE_MIN_GAP_MS) return
    const nowDate = new Date(now)
    if (!(await this.consumeQuota(nowDate))) return
    this.lastAt.set(room, now)
    const source: MemorySource = { kind: 'extract', room }
    try {
      const items = await extract(`即时抽取 ${room}`, turn.text)
      const nowMs = now
      let added = 0
      for (const item of items.slice(0, 3)) {
        const content = distillFact(item.content)
        if (content.length < 4) continue
        const duplicate = findNearDuplicate(store, content)
        if (duplicate !== null) continue
        await store.remember({
          kind: 'fact',
          subject: { type: 'group' },
          content,
          source,
          keywords: item.tags,
          tags: ['instant'],
          importance: 4,
          confidence: 0.5,
        }, nowMs, this.deps.random)
        added += 1
      }
      if (added > 0) this.deps.log(`capture: ${room} 即时沉淀 ${added} 条（今日 ${this.state.count}）`)
    } catch (error) {
      this.deps.log(`capture: ${room} 即时抽取失败（不影响对话）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 读配额状态（后台状态页用；读不到 = 没抽过）。 */
export async function readCaptureState(dir: string): Promise<CaptureState | null> {
  const raw = await readTextFileOrNull(path.join(dir, 'capture-state.json'))
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as CaptureState
    return typeof parsed?.day === 'string' ? parsed : null
  } catch { return null }
}

/** 供装配层把状态文件放进 store 同目录。 */
export function captureStatePathOf(storeDir: string): string {
  return path.join(storeDir, 'capture-state.json')
}

/** 给测试用的：直接看当天配额用了多少（不触碰 fs）。 */
export function quotaUsedOf(state: CaptureState | null, today: string): number {
  if (state === null || state.day !== today) return 0
  return state.count
}
