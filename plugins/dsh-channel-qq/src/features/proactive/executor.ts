/** 事件书执行器（P6f）：把「书 + 状态 + 判定」接起来，真的去跑。
 *
 * 分工（每件事只有一个家）：
 *   - **到什么点了**：`core/schedule/due.ts`（纯函数，注入 now）；
 *   - **书长什么样、合不合法**：`core/schedule/event-book.ts`；
 *   - **这一桶/今天做过没有**：`./state.ts`（落盘，跨重启）；
 *   - **文案**：人格包（`prompts.render(template, …)`），本文件不写面向模型的话；
 *   - **执行**：prompt → 回合发起（`turns.bookPrompt`）、job → 注册表、script → `./script-run.ts`。
 *
 * 三条贯穿的规矩：
 *   1. **先写状态再执行**（修 B1）：幂等键落盘之后才动手，进程死在半路也不会重发；
 *   2. **跳过要具名、且不消耗这一轮**：安静时段/条件不满足只记 `skipped:<原因>`，
 *      绝不动 lastKey——否则"夜里安静了一下"会把整晚的机会吃掉（旧巡逻踩过）；
 *   3. **一个事件出问题不影响别的**：每个事件独立 try，失败只进它自己的状态与日志。
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import type { ConversationRegistry } from '../../app/conversation/registry.js'
import type { PromptComposer } from '../../app/conversation/prompt-composer.js'
import type { TurnLauncher } from '../../app/conversation/turns.js'
import type { QQChannelConfig } from '../../config.js'
import { decideDue, inQuietHours, intervalKey } from '../../core/schedule/due.js'
import type { BookEvent, EventBook } from '../../core/schedule/event-book.js'
import { formatLocalStamp, localDayKey, timeContext } from '../../core/schedule/stamp.js'
import { resolveTarget, type TargetDirectory } from '../../core/schedule/targets.js'
import type { Clock, TimerHandle } from '../../ports/clock.js'
import { resolveJob } from './jobs.js'
import { collectMaterials } from './materials.js'
import { runBookScript } from './script-run.js'
import { migrateLegacyMarks, ProactiveState, type EventStateEntry } from './state.js'

/** 状态文件版本（`{version:1, events:{…}}`）。 */
const STATE_FORMAT_VERSION = 1

/** 判定的节拍：一分钟一次。所有触发语义都是分钟粒度，更密没有意义。 */
const TICK_MS = 60_000

export interface ExecutorDeps {
  readonly turns: TurnLauncher
  readonly registry: ConversationRegistry
  readonly prompts: PromptComposer
  /** 活配置（每次现取：后台改完不用重挂）。 */
  readonly config: () => QQChannelConfig
  /** 当前生效的事件书（配置里那份；解析/校验在装配期完成）。 */
  readonly book: () => EventBook
  readonly log: (line: string) => void
  readonly dshHome: string
  readonly clock: Clock
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ProactiveExecutor {
  private readonly state: ProactiveState
  private timer: TimerHandle | null = null
  /** 防重入：上一轮还在跑（事件里有 await）就跳过这一分钟，而不是叠起来跑。 */
  private busy = false

  constructor(private readonly deps: ExecutorDeps) {
    this.state = new ProactiveState({
      file: path.join(deps.dshHome, 'channel-qq', 'proactive-state.json'),
      log: deps.log,
    })
  }

  start(): void {
    this.state.load()
    const now = this.deps.clock.date()
    this.importLegacyMarks(now)
    this.seedBootBuckets(now)
    this.timer = this.deps.clock.setInterval(() => { void this.tick(this.deps.clock.date()) }, TICK_MS)
    this.timer.unref?.()
    // 启动即刻判一次：窗口事件（早报/梦）"今天还没做"时，开机就该补上。
    void this.tick(now)
    const book = this.deps.book()
    this.deps.log(`events: executor started, ${book.events.length} events (${book.events.filter((e) => e.enabled).length} on), state ${this.state.size()} entries`)
  }

  dispose(): void {
    this.timer?.cancel()
    this.timer = null
  }

  /** 跑一轮判定。`now` 注入（测试推进假时钟即可精确复现）。 */
  async tick(now: Date): Promise<void> {
    if (this.busy) {
      this.deps.log('events: tick skipped, previous tick still running')
      return
    }
    this.busy = true
    try {
      // 幂等：`start()` 已经读过一次；从这里再读一次是为了"被直接 tick 的测试/诊断
      // 也必须看得到盘上的状态"（否则同一桶会在重启后被重跑一遍）。
      this.state.load()
      for (const event of this.deps.book().events) {
        if (!event.enabled) continue
        // 一个事件出问题不拖累后面的：失败已经记在它自己的状态里。
        await this.consider(event, now).catch((error: unknown) => {
          this.deps.log(`events: ${event.id} tick error: ${describeError(error)}`)
        })
      }
    } finally {
      this.busy = false
    }
  }

  /** 单个事件：判定 → 门 → 执行。 */
  private async consider(event: BookEvent, now: Date): Promise<void> {
    const lastKey = this.state.get(event.id)?.lastKey ?? null
    const verdict = decideDue(event.id, event.trigger, lastKey, now)
    if (verdict.kind !== 'due') return
    const gate = this.gateReason(event, now)
    if (gate !== null) {
      this.noteSkip(event.id, gate)
      return
    }
    await this.execute(event, verdict.key, now)
  }

  /**
   * 执行前的门（不通过就跳过、**不消耗**这一轮）。
   *
   * 顺序：安静时段 → （prompt 事件）target 可解析 → requires。
   * 每一条的跳过理由都会写进状态，后台"主动行为"页直接看得到。
   */
  private gateReason(event: BookEvent, now: Date): string | null {
    if (inQuietHours(event.quietHours, now)) return 'quiet-hours'
    if (event.kind !== 'prompt') return null
    const resolved = resolveTarget(event.target ?? '', this.directory())
    if (!resolved.ok) return `target:${resolved.reason}`
    const record = this.deps.registry.get(resolved.room)
    for (const need of event.requires) {
      if (need === 'room-has-session' && record === undefined) return 'requires:room-has-session'
      if (need === 'turn-idle' && record?.tracker.running() === true) return 'requires:turn-idle'
    }
    return null
  }

  /**
   * 跳过：记状态与日志，**不动 lastKey**（下一分钟还会重新判）。
   *
   * 同一个原因连续出现时只记第一次：巡逻在夜里每分钟判一次，不该每分钟写一行日志
   * 也写一次盘（状态没变就什么都不做）。
   */
  private noteSkip(id: string, reason: string): void {
    const prev = this.state.get(id)
    if (prev?.lastOutcome === `skipped:${reason}`) return
    this.state.setEntry(id, {
      lastKey: prev?.lastKey ?? null,
      lastRunAt: prev?.lastRunAt ?? null,
      lastOutcome: `skipped:${reason}`,
      lastSkipReason: reason,
      runs: prev?.runs ?? 0,
    })
    this.persist()
    this.deps.log(`events: ${id} skipped: ${reason}`)
  }

  /** 执行一条事件：先落"正在跑"，跑完落结果。 */
  private async execute(event: BookEvent, key: string, now: Date): Promise<void> {
    const prev = this.state.get(event.id)
    const entry: EventStateEntry = {
      lastKey: key,
      lastRunAt: formatLocalStamp(now),
      lastOutcome: 'running',
      lastSkipReason: null,
      runs: (prev?.runs ?? 0) + 1,
    }
    this.state.setEntry(event.id, entry)
    this.persist()
    this.deps.log(`events: ${event.id} start (${event.kind})`)
    let outcome: string
    try {
      outcome = await this.dispatch(event, now)
    } catch (error) {
      outcome = `failed:${describeError(error)}`
    }
    this.state.setEntry(event.id, { ...entry, lastOutcome: outcome })
    this.persist()
    this.deps.log(`events: ${event.id} ${outcome}`)
  }

  private async dispatch(event: BookEvent, now: Date): Promise<string> {
    if (event.kind === 'prompt') return await this.runPrompt(event, now)
    if (event.kind === 'job') return await this.runJob(event, now)
    return await this.runScriptEvent(event)
  }

  /** prompt 事件：素材（可选）→ 模板（人格包）→ 回合发起。 */
  private async runPrompt(event: BookEvent, now: Date): Promise<string> {
    const dir = this.directory()
    const resolved = resolveTarget(event.target ?? '', dir)
    if (!resolved.ok) return `failed:${resolved.reason}`
    const config = this.deps.config()
    const material = await collectMaterials(event.materials, {
      now,
      today: localDayKey(now),
      settings: config.morningReport,
      workspace: config.workspacePath,
      dshHome: this.deps.dshHome,
      primaryGroup: dir.primaryGroup,
    })
    const prompt = this.deps.prompts.render(event.template ?? '', {
      flavor: timeContext(now).flavor,
      material,
      master: dir.masterId === null ? '' : String(dir.masterId),
    })
    const ok = await this.deps.turns.bookPrompt(resolved.room, prompt)
    return ok ? 'ran' : 'failed:not-submitted'
  }

  /** job 事件：按名字查注册表，绝不自己实现业务。 */
  private async runJob(event: BookEvent, now: Date): Promise<string> {
    const name = event.job ?? ''
    const handler = resolveJob(name)
    if (handler === undefined) return `failed:unknown-job:${name}`
    const outcome = await handler({
      now,
      log: this.deps.log,
      dshHome: this.deps.dshHome,
      workspace: this.deps.config().workspacePath,
    })
    if (outcome?.skipped !== undefined && outcome.skipped !== '') return `skipped:${outcome.skipped}`
    if (outcome?.note !== undefined && outcome.note !== '') this.deps.log(`events: ${event.id} note: ${outcome.note}`)
    return 'ran'
  }

  /** script 事件：argv + 无 shell + 限定在 workspace/scripts（见 script-run.ts）。 */
  private async runScriptEvent(event: BookEvent): Promise<string> {
    const workspace = this.deps.config().workspacePath
    if (workspace === null || workspace === '') return 'failed:no-workspace'
    if (event.script === null) return 'failed:no-script'
    const result = await runBookScript(event.script, { workspaceDir: workspace, log: this.deps.log })
    if (result.output !== '') this.deps.log(`events: ${event.id} output: ${result.output}`)
    return result.ran ? 'ran' : `failed:${result.detail}`
  }

  /**
   * 启动瞬间"吞掉"当前 interval 桶（修 B2）。
   *
   * `runOnBoot: false`（默认）的事件不在启动那一刻补跑：部署日重启十几次，补跑会让
   * 每次部署都多跑一轮巡逻/自省。幂等键落盘管的是"同一个桶不重复"，这一条管的是
   * "新进程别把部署当成到点"。window 事件不吞——"今天的早报还没发"本来就该在
   * 恢复后补上（旧实现的 morning catch-up 就是干这个的）。
   *
   * @returns 吞掉了几个桶（0 = 没有需要吞的）
   */
  private seedBootBuckets(now: Date): number {
    let seeded = 0
    for (const event of this.deps.book().events) {
      if (!event.enabled) continue
      if (event.trigger.type !== 'interval' || event.trigger.runOnBoot) continue
      const key = intervalKey(event.id, event.trigger.everyMin, now.getTime())
      const prev = this.state.get(event.id)
      if (prev?.lastKey === key) continue
      this.state.setEntry(event.id, {
        lastKey: key,
        lastRunAt: prev?.lastRunAt ?? null,
        lastOutcome: prev?.lastOutcome ?? null,
        lastSkipReason: prev?.lastSkipReason ?? null,
        runs: prev?.runs ?? 0,
      })
      seeded += 1
    }
    if (seeded > 0) {
      this.persist()
      this.deps.log(`events: boot-seeded ${seeded} interval bucket(s) (runOnBoot=false)`)
    }
    return seeded
  }

  /** 第一次跑（状态文件还不存在）时把旧调度器的"今天做过了"标记接过来。 */
  private importLegacyMarks(now: Date): void {
    if (this.state.existed) return
    const legacy = path.join(this.deps.dshHome, 'channel-qq', 'scheduler-state.json')
    const migrated = migrateLegacyMarks(this.state, legacy, localDayKey(now))
    if (migrated.length > 0) {
      this.persist()
      this.deps.log(`events: migrated legacy marks: ${migrated.join(', ')}`)
    }
  }

  private directory(): TargetDirectory {
    const config = this.deps.config()
    return { primaryGroup: config.primaryGroup, masterId: config.admins[0] ?? null }
  }

  /** 原子落盘（临时文件 + rename），与 `scheduler-state.ts` 同一套范式。 */
  private persist(): void {
    const file = this.state.stateFile
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const payload = { version: STATE_FORMAT_VERSION, events: this.state.snapshot() }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
      renameSync(tmp, file)
    } catch (error) {
      // 落盘失败不能让调度停摆：最坏是重启后重跑一轮，与改造前同级。
      this.deps.log(`proactive state save failed: ${describeError(error)}`)
      try { rmSync(`${file}.tmp`, { force: true }) } catch { /* 已经没了 */ }
    }
  }
}
