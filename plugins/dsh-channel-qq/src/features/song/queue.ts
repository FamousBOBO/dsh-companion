/** 串行队列：一次只做一首歌，并且**同一件事不会做两次**。
 *
 * 为什么必须串行：本机实测「分离 89 s + 推理 27 s」是**吃满显卡**的。两个人同时点歌，
 * 两个 python 进程会互相抢显存，结果是两首都变慢、两首都可能 OOM。串行的代价是
 * 第二个人多等一会儿——而多等一会儿是可以回一句"排队中"解决的，OOM 不可以。
 *
 * 为什么任务 id 由**去重键派生**：同一条入站消息被重复投递（NapCat 重连、事件重放）时
 * 会得到同一个 id，于是队列里已有的那条直接命中，不会变成两首歌。id 也同时是任务目录名，
 * 所以"同一件事"连目录都是同一个。
 *
 * 四条边界，每条都有对应的验收：
 *
 *   1. **入队只判"队列满/去重"，不判授权**。授权在发送之前现取（见 `pipeline.ts`）。
 *   2. **失败不阻塞后续**。每条任务包在自己的 `catch` 里，一个漏掉的异常不该让队列停摆。
 *   3. **阶段推进立刻写账本**。重启之后账本里能看到"上次卡在哪一步"——这是排查
 *      "为什么没收到语音条"的唯一线索。
 *   4. **取消是真的取消**：`AbortSignal` 传给每个适配器，正在跑的 python 被 tree-kill
 *      （见 `adapters/song/process.ts`）。不做这件事，取消只是"不再看结果"——
 *      显卡还被占着，下一条点歌照样排队。
 */

import { randomBytes } from 'node:crypto'
import type { Clock } from '../../ports/clock.js'
import type { SongConfig } from '../../config/sections/song.js'
import {
  autoUsedToday, countsAsSent, isTerminal, loadLedger, mergeLedger, saveLedger,
  type SongLedgerData, type SongLedgerRow,
} from './ledger.js'
import { runTask, type PipelineDeps } from './pipeline.js'
import type { SongEnqueueResult, SongRequest, SongStage, SongTaskStatus } from './types.js'

/** 排队中的一条任务（内存态；账本里只有它的阶段快照）。 */
interface QueuedTask {
  readonly request: SongRequest
  row: SongLedgerRow
  readonly controller: AbortController
}

export interface SongQueueDeps extends PipelineDeps {
  /** 账本文件（绝对路径）。 */
  readonly ledgerFile: string
  /**
   * 自主选歌的实现（装配期注入；缺省 = 未启用自主选歌）。
   *
   * 为什么做成注入而不是在队列里直接写：挑歌要用 B站搜索、主人 QQ、日期这些
   * "装配期才知道"的东西，而队列只该知道"串行、去重、额度、清理"。
   * 注入之后 `autoPickOnce()` 成为服务面上的一个方法，**计划/后台**可以不 import
   * 点歌模块就让它唱一首（`features/` 之间不互相 import 的约定）。注意它**没有定时器**。
   */
  readonly autoPick?: () => Promise<boolean>
  /**
   * 一条任务落到终态之后的通知（可选）。
   *
   * 为什么在这里而不是让调用方轮询：私聊点歌失败时要**在那个私聊里说明卡在哪一步**，
   * 自主选歌成功时要**记一次日额度**。这两件事都必须发生在"终态已定"之后，
   * 而终态只有一个出口（`finish()`）。放在这里，就不可能漏。
   *
   * 实现必须**不抛**（队列会兜住，但兜住不等于可以抛——一次通知失败不该让下一条任务不跑）。
   */
  readonly onFinish?: (event: SongFinished) => Promise<void> | void
}

/** 一条任务结束的现场（通知用；不含路径与凭据）。 */
export interface SongFinished {
  readonly request: SongRequest
  readonly stage: 'sent' | 'dry-run' | 'failed' | 'unknown-send' | 'cancelled'
  readonly detail: string | null
  readonly bvid: string | null
  readonly chorusStart: number | null
  readonly seconds: number | null
}

/** 队列对外的两个面（工具面与自主入口都用它们）。 */
export interface SongService {
  /** 入队（含去重与队列上限）；**不等待执行**。 */
  enqueue(request: SongRequest): Promise<SongEnqueueResult>
  /** 现在的任务列表（新的在前；`limit` 截断）。 */
  status(limit?: number): SongTaskStatus[]
  /** 取消一条（排队中直接摘掉，跑着的中止）。 */
  cancel(taskId: string, reason: string): Promise<boolean>
  /** 今天还能自主发几首（`Asia/Shanghai` 的日）。 */
  autoQuotaLeft(dayKey: string): Promise<number>
  /** 记一次自主发送（成功之后调用；失败不记账）。 */
  noteAutoSent(dayKey: string): Promise<void>
  /**
   * 今天（日键）已经自主发了几首。
   *
   * 不限额模式下，自主入口要拿它区分"同一天的第 N 首"——去重键里带上序号，
   * 否则 `auto:<日>:<房间>` 恒等，第二首会被当成重复。
   */
  autoUsedToday(dayKey: string): Promise<number>
  /** 载入账本（子插件 apply 时调用一次）。 */
  load(): Promise<void>
  /**
   * 自主选歌试一次（由主动联系的节拍调用；见 `features/contact/worker.ts` 的 `afterTick`）。
   *
   * 为什么挂在服务面上而不是让主动联系 import 点歌模块：`features/` 之间不互相 import
   * 是本仓库的约定（协作只经服务袋）。主动联系只管"到点了"，挑歌与判据在点歌这一侧。
   */
  autoPickOnce(): Promise<boolean>
}

/**
 * 任务 id：**由去重键派生**（同一件事 = 同一个 id）。
 *
 * 用 FNV-1a 而不是 sha256：这里要的是"稳定且够分散"，不是密码学强度；
 * 它不值得为一行哈希 import 一个 crypto 模块，也就不会有人想"顺手"把它当成安全边界。
 */
export function taskIdOf(dedupeKey: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < dedupeKey.length; i += 1) {
    hash ^= dedupeKey.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return `s-${hash.toString(36)}`
}

/** 一个任务目录名的随机尾：只在**去重键冲突**（哈希撞了）时用来分开两次不同的点歌。 */
function collisionTail(): string {
  return randomBytes(3).toString('hex')
}

/** "不限额"时报的剩余量：不用 `Infinity`（日志里难看、进 JSON 变 `null`）。 */
const UNLIMITED_QUOTA = 9999

export class SongQueue implements SongService {
  private ledger: SongLedgerData | null = null
  private readonly pending: QueuedTask[] = []
  private chain: Promise<void> = Promise.resolve()
  private readonly log: (line: string) => void
  private readonly clock: Clock

  constructor(private readonly deps: SongQueueDeps) {
    this.log = deps.log
    this.clock = deps.clock
  }

  async load(): Promise<void> {
    this.ledger = await loadLedger(this.deps.ledgerFile, this.log)
    const rows = this.ledger.tasks.length
    if (rows > 0) this.log(`song: 账本载入 ${String(rows)} 条（去重与日上限活过重启）`)
  }

  private data(): SongLedgerData {
    // 没 `load()` 就用的路径不该出现（装配保证先 load）；真的发生了就按空账本跑，
    // 让点歌能用，而不是让整个功能因为"少调了一次 load"而拒绝服务。
    return this.ledger ?? { version: 1, tasks: [], autoDay: '', autoCount: 0 }
  }

  private async write(change: {
    readonly upsert?: readonly SongLedgerRow[]
    readonly autoDay?: string
    readonly autoCount?: number
  }): Promise<void> {
    const merged = mergeLedger(this.data(), change, this.clock.now())
    this.ledger = merged
    await saveLedger(this.deps.ledgerFile, merged, this.log)
  }

  /** 同一条消息重复进来：跑着的、发过的、回执未知的都不再重做。 */
  private alreadyHandled(request: SongRequest): SongEnqueueResult | null {
    const row = this.data().tasks.find((task) => task.id === request.id)
    if (row === undefined) return null
    if (countsAsSent(row)) {
      this.log(`song: 去重命中 ${request.id}（已经发过：${row.stage}）`)
      return { accepted: false, taskId: row.id, note: '这条点歌已经处理过了（不会重复发语音条）' }
    }
    if (!isTerminal(row.stage)) {
      this.log(`song: 去重命中 ${request.id}（进行中：${row.stage}）`)
      return { accepted: false, taskId: row.id, note: `这首歌正在做（${stageText(row.stage)}），做好就发` }
    }
    // 失败/取消/演练过的：允许再做一次（用户重新点歌是明确意图）。但 id 要换一个，
    // 否则账本里两条同 id 的记录会互相覆盖。
    return null
  }

  /** 现在一共占着几个位置：**在跑的那条也算**（否则上限只管排队、实际能超一倍）。 */
  private get depth(): number {
    return this.pending.length + (this.inFlight === null ? 0 : 1)
  }

  async enqueue(request: SongRequest): Promise<SongEnqueueResult> {
    const config = this.deps.config()
    if (!config.enabled) {
      return { accepted: false, taskId: null, note: '点歌翻唱没有启用（后台「音乐」页的「启用点歌翻唱」）' }
    }
    const dupe = this.alreadyHandled(request)
    if (dupe !== null) return dupe
    if (this.depth >= config.maxQueue) {
      this.log(`song: 队列已满（${String(this.depth)}/${String(config.maxQueue)}），拒绝 ${request.song}`)
      return {
        accepted: false, taskId: null,
        note: `前面还有 ${String(this.depth)} 首在做，先排队吧——排太久的语音条已经过时了`,
      }
    }

    // 失败过的同一件事：换 id（`-<随机>` 尾），账本因此能留下两次尝试的真实记录。
    const id = this.data().tasks.some((task) => task.id === request.id)
      ? `${request.id}-${collisionTail()}`
      : request.id
    const row: SongLedgerRow = {
      id,
      entry: request.entry,
      room: request.room,
      song: request.song,
      artist: request.artist,
      stage: 'queued',
      bvid: request.bvid,
      chorusStart: request.chorusAt,
      seconds: null,
      keyUp: request.keyUp,
      detail: null,
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
      messageId: null,
    }
    const task: QueuedTask = { request: { ...request, id }, row, controller: new AbortController() }
    this.pending.push(task)
    await this.write({ upsert: [row] })
    this.log(`song: 入队 ${id}（${request.song}${request.artist === '' ? '' : ` / ${request.artist}`}）→ ${request.room}`)
    this.schedule(task)
    return { accepted: true, taskId: id, note: '收到啦，做好就发——副歌开始的那段语音条' }
  }

  /**
   * 把一条任务挂到串行链上。
   *
   * 链上每一步都兜住异常：`this.chain` 一旦被一个拒绝占住，后面所有任务就永远不跑，
   * 而症状是"点歌点了没反应"——那是最难查的一类问题。
   */
  private schedule(task: QueuedTask): void {
    this.chain = this.chain
      .then(async () => { await this.runOne(task) })
      .catch((error: unknown) => {
        this.log(`song: 队列内部异常（${error instanceof Error ? error.message : String(error)}）`)
      })
  }

  private async runOne(task: QueuedTask): Promise<void> {
    const index = this.pending.indexOf(task)
    if (index !== -1) this.pending.splice(index, 1)
    this.inFlight = task

    // 排队期间被取消：直接收场，一行也不记成失败（那是用户的意图）。
    if (task.controller.signal.aborted) {
      this.inFlight = null
      await this.finish(task, 'cancelled', '排队时被取消', null)
      return
    }

    let current: SongLedgerRow = task.row
    const hooks = {
      advance: async (stage: SongStage, patch?: {
        readonly bvid?: string; readonly chorusStart?: number; readonly seconds?: number
      }): Promise<void> => {
        current = {
          ...current,
          stage,
          ...(patch?.bvid === undefined ? {} : { bvid: patch.bvid }),
          ...(patch?.chorusStart === undefined ? {} : { chorusStart: patch.chorusStart }),
          ...(patch?.seconds === undefined ? {} : { seconds: patch.seconds }),
          updatedAt: this.clock.now(),
        }
        task.row = current
        await this.write({ upsert: [current] })
      },
    }

    this.log(`song: 开始 ${task.request.id}（${task.request.song}）`)
    const startedAt = this.clock.now()
    try {
      const outcome = await runTask(this.deps, task.request, hooks, task.controller.signal)
      const elapsed = ((this.clock.now() - startedAt) / 1000).toFixed(0)
      this.log(`song: 结束 ${task.request.id}（${outcome.stage}，用时 ${elapsed}s）`)
      await this.finish(task, outcome.stage, outcome.detail, outcome.messageId)
    } finally {
      this.inFlight = null
    }
  }

  /** 落终态。**只写一次**（终态之后不会有新阶段），然后通知。 */
  private async finish(
    task: QueuedTask,
    stage: SongStage,
    detail: string | null,
    messageId: number | null,
  ): Promise<void> {
    const row: SongLedgerRow = {
      ...task.row,
      stage,
      detail,
      messageId,
      updatedAt: this.clock.now(),
    }
    await this.write({ upsert: [row] })

    const notify = this.deps.onFinish
    if (notify === undefined) return
    // 通知在账本之后：记账是合同（去重与日上限靠它），通知是附加（失败了也只记一行日志）。
    const terminal = stage === 'sent' || stage === 'dry-run' || stage === 'failed'
      || stage === 'unknown-send' || stage === 'cancelled'
    if (!terminal) return
    try {
      await notify({
        request: task.request,
        stage,
        detail,
        bvid: row.bvid,
        chorusStart: row.chorusStart,
        seconds: row.seconds,
      })
    } catch (error) {
      this.log(`song: 结束通知失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  status(limit = 10): SongTaskStatus[] {
    const rows = this.data().tasks.slice().sort((a, b) => b.createdAt - a.createdAt)
    return limit > 0 ? rows.slice(0, limit) : rows
  }

  async cancel(taskId: string, reason: string): Promise<boolean> {
    const queued = this.pending.find((task) => task.request.id === taskId)
    if (queued !== undefined) {
      queued.controller.abort()
      this.log(`song: 取消排队中的 ${taskId}（${reason}）`)
      return true
    }
    // 串行队列最多一条在跑，所以"正在跑的那条"就是一个字段，不需要表。
    if (this.inFlight !== null && this.inFlight.request.id === taskId) {
      this.inFlight.controller.abort()
      this.log(`song: 中止正在跑的 ${taskId}（${reason}）`)
      return true
    }
    return false
  }

  /** 正在跑的那一条（串行，最多一个）。 */
  private inFlight: QueuedTask | null = null

  async autoQuotaLeft(dayKey: string): Promise<number> {
    if (dayKey === '') return 0
    // `0` = 不限额（操作员显式选的）。返回一个"永远够用"的数而不是 `Infinity`。
    const cap = this.deps.config().dailyAutoCap
    if (cap <= 0) return UNLIMITED_QUOTA
    return Math.max(0, cap - autoUsedToday(this.data(), dayKey))
  }

  async noteAutoSent(dayKey: string): Promise<void> {
    if (dayKey === '') return
    const used = autoUsedToday(this.data(), dayKey)
    await this.write({ autoDay: dayKey, autoCount: used + 1 })
  }

  /**
   * 今天（日键）已经自主发了几首。
   *
   * 为什么单独暴露它：`dailyAutoCap=0`（不限额）时，**去重键必须靠它区分同一天的
   * 第二次点歌**——`auto:<日>:<房间>` 这个键在同一天只能存在一次，否则第二首会被
   * 当成"已经处理过"直接去重掉，"不限额"就等于"一天仍然只有一首"。
   */
  async autoUsedToday(dayKey: string): Promise<number> {
    return dayKey === '' ? 0 : autoUsedToday(this.data(), dayKey)
  }

  /** 自主选歌：交给注入的实现（缺省 = 什么都不做，理由在日志里给）。 */
  async autoPickOnce(): Promise<boolean> {
    const pick = this.deps.autoPick
    if (pick === undefined) {
      this.log('song: 自主选歌跳过（没有注入实现）')
      return false
    }
    try {
      return await pick()
    } catch (error) {
      this.log(`song: 自主选歌出错（${error instanceof Error ? error.message : String(error)}）`)
      return false
    }
  }
}

/** 阶段的中文说法（给私聊回复用；账本里存的是稳定英文枚举）。 */
export function stageText(stage: SongStage): string {
  switch (stage) {
    case 'queued': return '排队中'
    case 'downloading': return '正在下载音轨'
    case 'chorus': return '正在找副歌'
    case 'covering': return '正在翻唱'
    case 'sending': return '正在发送'
    case 'sent': return '已发出'
    case 'dry-run': return '演练模式（没有真发）'
    case 'failed': return '失败'
    case 'unknown-send': return '回执未知'
    case 'cancelled': return '已取消'
  }
}
