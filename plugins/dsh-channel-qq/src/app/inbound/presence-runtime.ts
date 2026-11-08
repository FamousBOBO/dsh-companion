/** 群聊旁听的**状态机**：合批定时器、每群游标、限频记账、卸载。
 *
 * 分层（这个文件的边界就是这三层的边界）：
 *   - `core/ambient.ts`  : 背景缓冲（旁听 ≠ 发言；**唯一的写入者是流水线**）；
 *   - `core/presence.ts` : 限频记账（能不能判、能不能说，纯函数、不可变状态）；
 *   - `presence-flow.ts` : **一次**判断的完整流程（模型 → 解析 → 复核 → 发送 → 记账）；
 *   - **本文件**          : 把这些接到"入站那一刻"与"到点那一刻"上。
 *
 * 五条硬约束（每一条都对应一个会出事的地方）：
 *   1. **`observe` 非阻塞**：入站路径上不能等模型。这里只（可能）武装一个
 *      `judgeIntervalMs` 的合批定时器，判断在回调里跑。
 *   2. **旁听环不归我写**：流水线的 `captureAmbient` 负责 `add`；这里只 `peekAfter`
 *      读并推进自己的 `judgedSeq`（两个写者会让"这条到底算不算看过"变成猜测）。
 *   3. **每次现取 platform**：热加载后旧客户端会被换掉（2026-11 的私聊事故就是闭包抓着
 *      死掉的客户端）。缓存 api 等于把"重连"变成"静默失败"。
 *   4. **热加载不补发**：`emptyPresenceState(now)` 把上次判断/发言时刻置成"现在"，
 *      所以重载之后不会立刻回放旧批次；每群游标首见时落在"此刻最新的那条"上，
 *      于是只有她"上线"之后的新消息才会被判断。
 *   5. **同群不并发**：一个群同时只跑一次判断（`inflight`），避免"两句连着发出去"。
 *
 * 这里不碰盘、不建会话、不给工具：自主发言由通道直接发，不经过群 agent（§0.8）。
 */

import { emptyPresenceState, judgeVerdict, type PresenceState } from '../../core/presence.js'
import type { AmbientEntry } from '../../core/ambient.js'
import { ambientLimitsOf, presenceAppliesTo, type AmbientStore } from './ambient-store.js'
import { DEFAULTS, limitsOf, positiveOr, runPresenceCycle, type CompletePort, type PresenceView } from './presence-flow.js'
import type { Clock, TimerHandle } from '../../ports/clock.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { JudgeEntry } from './presence-judge.js'
import type { GroupPersonaSnapshot } from './group-persona.js'

export type { CompletePort, CompleteRequest, CompleteResult, PresenceView } from './presence-flow.js'

export interface PresenceDeps {
  /** 现取配置（后台改完立即生效；`presence` 缺席 = 这套能力不存在）。 */
  readonly config: () => { readonly presence?: PresenceView }
  readonly clock: Clock
  readonly log: (line: string) => void
  /** **不缓存**：热加载后要跟随新客户端。 */
  readonly platform: () => ChatPlatform
  readonly ambient: AmbientStore
  readonly complete: CompletePort
  /** 写 sent-log（她自己的出站账本）；失败只记日志。 */
  readonly recordSent: (groupId: number, messageId: number | null, text: string) => Promise<void>
  /**
   * 现取群聊可见的人格快照（P0 §4.2）。
   *
   * 为什么是"取快照的函数"而不是"一份快照"：快照带版本号，人格文件改了要在下一轮判断
   * 里生效，而不是等通道重启。解析成本由发布方（foundation）缓存，这里每轮只多一次
   * 函数调用。返回 `null` = 取不到，提示词会明说降级（绝不假装已经读到完整人格）。
   */
  readonly persona: () => GroupPersonaSnapshot | null
}

/** 她最近说过的话留几条（防重复；提示词里最多渲染 6 条）。 */
const SENT_MEMORY = 6

/** 群聊旁听的执行器。一个实例管所有白名单群（每群一份状态，互不影响）。 */
export class GroupPresence {
  private readonly states = new Map<number, PresenceState>()
  /** 每群"已经判到哪一条"（`AmbientRing` 的 seq）。 */
  private readonly judgedSeq = new Map<number, number>()
  private readonly timers = new Map<number, TimerHandle>()
  /** 正在跑判断的群（同群不并发、不连发）。 */
  private readonly inflight = new Set<number>()
  private readonly sent = new Map<number, readonly string[]>()
  private disposed = false

  constructor(private readonly deps: PresenceDeps) {}

  /**
   * 记一条旁听/准备判断（**非阻塞**：不等模型、不发消息、不写盘）。
   *
   * 流水线在 `captureAmbient` 之后调它一次。这里要回答的只有一句：
   * **现在该不该武装一个合批定时器**（到点再花钱判断）。
   */
  observe(groupId: number): void {
    if (this.disposed) return
    try {
      const settings = this.settings()
      if (settings === null || !presenceAppliesTo(settings, groupId)) return
      this.arm(groupId, settings)
    } catch (error) {
      // 入站路径上绝不能因为旁听把一条正常消息弄丢。
      this.deps.log(`presence: 群 ${String(groupId)} 旁听记账异常（已忽略）：${describe(error)}`)
    }
  }

  /** 卸下：取消所有定时器，丢掉所有内存状态（**不**补发、不落盘）。 */
  dispose(): void {
    this.disposed = true
    for (const handle of this.timers.values()) {
      try {
        handle.cancel()
      } catch {
        /* 取消失败只影响一次判断，不能把卸载流程弄崩 */
      }
    }
    this.timers.clear()
    this.states.clear()
    this.judgedSeq.clear()
    this.sent.clear()
    this.inflight.clear()
  }

  // ── 内部：合批定时器 ────────────────────────────────────────────────────

  /**
   * 满足条件就武装一个 `judgeIntervalMs` 的合批定时器。
   *
   * 已经武装/正在判断的群**不重排**：否则热闹的群会把窗口无限往后推，永远轮不到判断
   * （判断的最小间隔另由 `core/presence.ts` 的 `judgeVerdict` 把关）。
   */
  private arm(groupId: number, settings: PresenceView): void {
    if (this.timers.has(groupId) || this.inflight.has(groupId)) return
    const nowMs = this.deps.clock.now()
    const ring = this.deps.ambient.ring(groupId, ambientLimitsOf(settings))
    const pending = ring.peekAfter(this.cursorOf(groupId, ring), nowMs).filter((entry) => !entry.self).length
    const verdict = judgeVerdict(this.stateOf(groupId), nowMs, limitsOf(settings), pending)
    if (!verdict.ok) return
    const interval = positiveOr(settings.judgeIntervalMs, DEFAULTS.judgeIntervalMs)
    const handle = this.deps.clock.setTimeout(() => {
      this.timers.delete(groupId)
      void this.runCycle(groupId).catch((error: unknown) => {
        this.deps.log(`presence: 群 ${String(groupId)} 判断流程抛错（已忽略）：${describe(error)}`)
      })
    }, interval)
    handle.unref?.()
    this.timers.set(groupId, handle)
  }

  // ── 内部：到点跑一次 ────────────────────────────────────────────────────

  /** 定时器到点：取背景 → 交给流程 → 把结果记回状态/旁听。 */
  private async runCycle(groupId: number): Promise<void> {
    if (this.disposed) return
    const settings = this.settings()
    if (settings === null || !presenceAppliesTo(settings, groupId)) return
    this.inflight.add(groupId)
    try {
      const background = this.takeBatch(groupId, settings)
      if (background.length === 0) return
      const outcome = await runPresenceCycle(
        {
          groupId,
          settings,
          state: this.stateOf(groupId),
          background,
          sentLines: this.sent.get(groupId) ?? [],
          nowLabel: nowLabelOf(this.deps.clock.date()),
          persona: this.personaSnapshot(groupId),
        },
        { clock: this.deps.clock, log: this.deps.log, platform: this.deps.platform, complete: this.deps.complete, recordSent: this.deps.recordSent },
      )
      // 卸载之后到达的结果一律丢弃（否则"关掉了还在发"）。
      if (this.disposed) return
      this.states.set(groupId, outcome.state)
      if (outcome.kind !== 'spoke') return
      this.sent.set(groupId, [...(this.sent.get(groupId) ?? []), outcome.text].slice(-SENT_MEMORY))
      this.echoSelf(groupId, settings, outcome.messageId, outcome.selfId, outcome.text)
    } finally {
      this.inflight.delete(groupId)
    }
  }

  /**
   * 取这一批背景，并**无论如何**推进游标。
   *
   * 推进游标是记账的一部分：同一批内容不该被反复判（每次判断都要花钱），
   * 判过之后的静默也不该被下一条无关消息重新翻出来。
   */
  private takeBatch(groupId: number, settings: PresenceView): JudgeEntry[] {
    const nowMs = this.deps.clock.now()
    const ring = this.deps.ambient.ring(groupId, ambientLimitsOf(settings))
    const after = ring.peekAfter(this.cursorOf(groupId, ring), nowMs)
    this.judgedSeq.set(groupId, ring.lastSeq())
    const fresh = after.filter((entry) => !entry.self).length
    const verdict = judgeVerdict(this.stateOf(groupId), nowMs, limitsOf(settings), fresh)
    if (!verdict.ok) {
      this.deps.log(`presence: 群 ${String(groupId)} 这一轮不判断（${String(verdict.reason)}）`)
      return []
    }
    return windowOf(after, settings.judgeMaxEntries, settings.judgeMaxChars)
  }

  /** 把她自己刚发的那条回灌旁听：下一次判断/回合要能看见"这是我自己说的"。 */
  private echoSelf(groupId: number, settings: PresenceView, messageId: number, selfId: number | null, text: string): void {
    try {
      this.deps.ambient.ring(groupId, ambientLimitsOf(settings)).add({
        messageId,
        userId: typeof selfId === 'number' ? selfId : 0,
        name: '',
        text,
        body: text,
        atMs: this.deps.clock.now(),
        self: true,
      })
    } catch (error) {
      this.deps.log(`presence: 群 ${String(groupId)} 回灌旁听失败（已忽略）：${describe(error)}`)
    }
  }

  /**
   * 取一次人格快照（**绝不抛**：这条路径上任何异常都只能让"这一轮少一段人格"）。
   *
   * 拿不到时打一行日志——一行就够，因为"她说话不像角色"这个问题唯一的排查起点就是
   * "快照到底有没有接上"。
   */
  private personaSnapshot(groupId: number): GroupPersonaSnapshot | null {
    try {
      const snapshot = this.deps.persona()
      if (snapshot === null) {
        this.deps.log(`presence: 群 ${String(groupId)} 人格快照不可用，这一轮用降级人格`)
        return null
      }
      return snapshot
    } catch (error) {
      this.deps.log(`presence: 群 ${String(groupId)} 取人格快照抛错（已降级）：${describe(error)}`)
      return null
    }
  }

  // ── 内部：状态 ──────────────────────────────────────────────────────────

  private settings(): PresenceView | null {
    const presence = this.deps.config().presence
    return presence === undefined ? null : presence
  }

  /**
   * "已经判到哪一条"。首次见到这个群时**只留最新那一条**，并把它记下来。
   *
   * 这是"热加载/重启不补发旧批次"的另一半：缓冲里那些在她上线之前就存在的消息不会被
   * 回放。留最新这一条而不是从"此刻之后"才开始，是因为 `observe` 是流水线**先** `add`、
   * **再**调进来的——此刻最新那条正是刚发生、最该被看见的那条；丢掉它，
   * 群里要等到下一条消息才有判断，而那一批背景里还会缺掉引起话题的那一句。
   */
  private cursorOf(groupId: number, ring: { lastSeq(): number }): number {
    const recorded = this.judgedSeq.get(groupId)
    if (recorded !== undefined) return recorded
    const created = Math.max(0, ring.lastSeq() - 1)
    this.judgedSeq.set(groupId, created)
    return created
  }

  private stateOf(groupId: number): PresenceState {
    const existing = this.states.get(groupId)
    if (existing !== undefined) return existing
    // `emptyPresenceState(now)`：判断/发言时刻都从"现在"起算，重载后不会瞬间开口。
    const created = emptyPresenceState(this.deps.clock.now())
    this.states.set(groupId, created)
    return created
  }
}

/**
 * 按条数与字数取**最近**的一段背景（时间正序返回）。
 *
 * 与 `AmbientRing.take` 同一套口径（从最新往前收，至少留一条），但这里**不推进**缓冲的
 * 交付游标：判断只看不取，被 @ 时的交付仍由流水线负责。
 */
function windowOf(entries: readonly AmbientEntry[], maxEntries: number, maxChars: number): JudgeEntry[] {
  const entryCap = Math.max(1, Math.trunc(positiveOr(maxEntries, DEFAULTS.judgeMaxEntries)))
  const charCap = Math.max(1, Math.trunc(positiveOr(maxChars, DEFAULTS.judgeMaxChars)))
  const recent = entries.slice(-entryCap).reverse()
  const picked: AmbientEntry[] = []
  let total = 0
  for (const entry of recent) {
    const size = [...entry.text].length
    if (picked.length > 0 && total + size > charCap) break
    picked.push(entry)
    total += size
  }
  return picked.reverse().map((entry) => ({
    messageId: entry.messageId,
    name: entry.name,
    userId: entry.userId,
    text: entry.text,
    // 正文单独带一份：渲染层要显式输出一次发送者身份，整行里那段抬头就不能再出现。
    // 环里没存 body（旧写入方 / 测试直接 `add`）时不填这个键：让判断层自己去剥抬头，
    // 而不是在这里塞一整行当正文——那正好会渲染成"身份出现两次"。
    ...(entry.body === undefined ? {} : { body: entry.body }),
    self: entry.self,
    atMs: entry.atMs,
  }))
}

/** 提示词里的"现在几点"（用注入时钟的 `date()`，不读全局时钟——R8）。 */
function nowLabelOf(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())} `
    + `${two(date.getHours())}:${two(date.getMinutes())}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
