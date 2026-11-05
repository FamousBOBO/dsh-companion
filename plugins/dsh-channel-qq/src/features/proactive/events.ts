/** Scheduler: proactivity, time-of-day awareness, dreams, self-evolution.
 *
 * All four run through the same TurnLauncher path so everything the model does
 * stays inside the harness (tools, permissions, sessions).
 *
 * - 主动性巡逻 (every ~9 min, only when the group had recent traffic): the
 *   model gets the recent context marked as a patrol and decides itself
 *   whether to start a topic, react, or stay silent.
 * - 时段感知: every packet gets a one-line time-of-day flavor prefix.
 * - 梦境 (04:30 daily): the model writes a dream into workspace
 *   memory/dreams/YYYY-MM-DD.md and may share a fragment in the group.
 * - 自进化 (every 6h): the model reviews its memory diaries and appends
 *   learnings to MEMORY.md — the persona file itself stays read-only.
 *
 * 「今天做过了」由 `SchedulerState` 落盘（见该文件）：内存标记一重启就忘，
 * 于是部署期的每次重启都会让早报 / 梦 / 知识抽取再跑一遍。
 *
 * P5.4 搬迁注记：本文件是 `src/scheduler.ts` 整块搬来的——**时刻表、文案与行为
 * 一字不改**（真正的重新设计是 P6f 的事件书）。`src/scheduler.ts` 现在只留一个
 * 转发口给 deploy 脚本与旧引用。为满足"新文件里任何函数 ≤ 60 行"的棘轮，
 * 只做了两处纯搬移式拆分：`start` 里的任务书定时器 → `armTaskBook()`，
 * 早报的素材收集 → `./materials.ts` 的 `collectMorningMaterial()`（P6f 起**两边
 * 共用同一份**，事件书的 `materials: […]` 与旧调度器走同一条路径）。
 */

import type { TurnLauncher } from '../../app/conversation/turns.js'
import * as path from 'node:path'
import type { CruiseTaskConfig, QQChannelConfig } from '../../config.js'
import { resolveDshHome } from '../../paths.js'
import { SchedulerState } from '../../scheduler-state.js'
import { runCruiseScript } from '../../cruise-run.js'
import type { PromptComposer } from '../../app/conversation/prompt-composer.js'
// 时间格式化与时段判定搬去了 core/schedule（纯函数、参数注入）。
// 这里仍然转出去：旧引用从 scheduler.js 拿它们，接口面不变。
import { localDayKey, timeContext } from '../../core/schedule/stamp.js'
import { collectMorningMaterial } from './materials.js'
export { localDayKey, timeContext } from '../../core/schedule/stamp.js'

export class Scheduler {
  private timers: Array<NodeJS.Timeout> = []
  private readonly groupConversationKey: string | null
  /** 「今天做过了」的持久化标记（早报 / 梦 / 知识抽取共用一张表）。 */
  private readonly state: SchedulerState

  constructor(
    /** 发起回合的四个入口（主动私聊 / 巡逻 / 做梦 / 自省）。 */
    private readonly turns: TurnLauncher,
    /** 组包器：三段主动文案（巡逻 / 做梦 / 自省）取自人格包。 */
    private readonly prompts: PromptComposer,
    private readonly config: QQChannelConfig,
    private readonly log: (line: string) => void,
    private readonly opts: { workspace?: string; onExtract?: (source: string, text: string) => Promise<number> } = {},
  ) {
    this.groupConversationKey = this.config.primaryGroup !== null ? `group-${this.config.primaryGroup}` : null
    if (opts.workspace) this.configWorkspace = opts.workspace
    this.state = new SchedulerState({
      file: path.join(resolveDshHome(), 'channel-qq', 'scheduler-state.json'),
      log: this.log,
    })
  }

  start(): void {
    // **总开关（默认关）**：`proactive.scheduler` 关着时一个定时器都不注册。
    // 这套时刻表是"装好就开始自己找人说话"的那一类行为（巡逻 / 做梦 / 自省 /
    // 主动私聊 / 早报 / 抽知识），发布默认必须是静默的：不注册定时器 = 不调用模型
    // = 不产生任何外发。打开它是操作者的显式决定（见 `sections/proactive.ts`）。
    if (this.config.proactive.scheduler !== true) {
      this.log('scheduler: 旧定时行为未启用（proactive.scheduler=false）→ 不注册巡逻 / 做梦 / 自省 / 主动私聊 / 早报 / 抽取定时器')
      return
    }
    // 先把历史标记读回来：不读的话，重启就等于「今天什么都没做过」。
    this.state.load()
    // Proactive patrol: every 9 minutes, jittered; the bridge's own gates
    // (talk chance, pending turn) still apply.
    const patrol = setInterval(() => {
      void this.patrol().catch((e: Error) => this.log(`patrol failed: ${e.message}`))
    }, 9 * 60_000 + Math.floor(Math.random() * 60_000))
    // Dream: check every 10 min, fire once when it is 04:00-04:59 and not yet done today.
    const dream = setInterval(() => {
      void this.dream().catch((e: Error) => this.log(`dream failed: ${e.message}`))
    }, 10 * 60_000)
    // Self-evolution: every 6 hours.
    //
    // The boot-time kick ("first evolution 3 minutes after start") is gone. Its
    // intent was "a fresh process should not wait 6 hours for its first pass",
    // but during deployment — where the process restarts a dozen times a day —
    // it turned into a dozen extra passes a day, each one appending 1-3 entries
    // to MEMORY.md. The periodic timer covers the intent without the burst.
    const evolve = setInterval(() => {
      void this.evolve().catch((e: Error) => this.log(`evolve failed: ${e.message}`))
    }, 6 * 60 * 60_000)
    // Knowledge extraction: 04:40 daily, right after the dream.
    const knowledge = setInterval(() => {
      void this.extractKnowledge().catch((e: Error) => this.log(`knowledge extract failed: ${e.message}`))
    }, 10 * 60_000)
    this.timers.push(knowledge)

    // ── 任务书定时器（从她的定时任务书.md 移植）──
    this.armTaskBook()

    // DM proactivity: every ~22 min she may come find 主人 on her own.
    const dm = setInterval(() => {
      void this.dmProactive().catch((e: Error) => this.log(`dm proactive failed: ${e.message}`))
    }, 22 * 60_000 + Math.floor(Math.random() * 90_000))
    this.timers.push(patrol, dream, evolve, dm)
    this.log(`scheduler started: patrol 9min, dm-proactive 22min, morning-report 06:00-11:59, cruises ${this.config.cruises.filter((c) => c.enabled).length}, dream 04:xx, knowledge-extract 04:00-08:59, evolve 6h, state ${this.state.size()} marks`)
  }

  /** 任务书定时器：每日早报与配置的工作区巡航脚本（创建顺序与原实现一致）。 */
  private armTaskBook(): void {
    // 任务一：每日早报。
    //
    // The window used to be 06:00-06:04 with no catch-up: a restart inside those
    // four minutes lost the day's report for good. And because a *disabled*
    // report returned without logging anything, "switched off" was
    // indistinguishable from "never ran" — which is exactly how this looked like
    // a broken scheduler when it was a `morningReport.enabled: false` in config.
    // Now: a slot plus morning catch-up, a local-day key, and a log line for
    // every outcome including the skips.
    const morningReport = setInterval(() => {
      const now = new Date()
      const h = now.getHours()
      if (h < 6 || h > 11) return // 06:00-11:59 local
      const key = `morning-${localDayKey(now)}`
      if (this.state.has(key)) return
      this.state.mark(key)
      void this.morningReport().catch((e: Error) => this.log(`morning report failed: ${e.message}`))
    }, 60_000)
    this.timers.push(morningReport)

    // Configured workspace cruises. Empty by default: a fresh deployment must
    // not inherit another host's scripts and log a failure every 15 minutes.
    for (const cruise of this.config.cruises) {
      if (!cruise.enabled) continue
      const timer = setInterval(() => {
        void this.runCruise(cruise).catch((e: Error) => this.log(`cruise ${cruise.id} failed: ${e.message}`))
      }, Math.max(1, cruise.intervalMin) * 60_000)
      this.timers.push(timer)
    }
  }

  private dmCounter = 0

  /** 主动私聊主人：报进展 / 打招呼 / 分享 / 找话头——由模型自己决定说不说。 */
  private async dmProactive(): Promise<void> {
    const master = this.config.admins[0]
    if (master === undefined) return
    const now = new Date()
    const h = now.getHours()
    // 夜间安静：01:00–08:00 不打扰（04:xx 的做梦不算）。
    if (h >= 1 && h < 8) return
    this.dmCounter += 1
    // 说话方式**不写死在提示词里**：具体语气属于人格（用户写在 config/persona.md），
    // 插件只给"短、一条、别复述对方原话"这类与人格无关的发送约束。
    const style = '用你人格设定里的说话方式；一条只说一件事，短、口语，别复述对方原话。'
    const pool = [
      `【主动私聊】${timeContext(now).flavor}。去私聊找主人说一句：可以聊我最近在干啥（翻翻工作区文件有啥进展）、可以是昨天聊过的事的后续、也可以直接问他忙不忙。像突然想起他，只发一句。${style}`,
      `【主动私聊】${timeContext(now).flavor}。看看工作区（PROGRESS.md、downloads/、任务文件）有没有新进展，有就往私聊说一句；没有就换个花样：分享个刚看到的东西，或者直接问他在干嘛。只发一句。${style}`,
      `【主动私聊】${timeContext(now).flavor}。翻翻 memory/ 今天的日记，挑一件没跟主人提过的小事，私聊跟他讲一句。只发一句，别刷屏。${style}`,
    ]
    const prompt = pool[this.dmCounter % pool.length]!
    await this.turns.dmProactive(prompt)
  }

  dispose(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  private async patrol(): Promise<void> {
    if (this.groupConversationKey === null) return
    const now = new Date()
    const ctx = timeContext(now)
    // Night silence: no patrols 01:00-07:30.
    const h = now.getHours()
    if (h >= 1 && h < 7.5) return
    await this.turns.patrolTick(this.groupConversationKey, this.prompts.render('proactive/patrol', { flavor: ctx.flavor }))
  }

  private async dream(): Promise<void> {
    const now = new Date()
    if (now.getHours() !== 4) return
    if (this.groupConversationKey === null) return
    // 标记放在闸门**之后**：持久化会把「没标记 = 还能做」这个状态带到下一次启动，
    // 所以只有真的要去做了才落盘，不能让一个启动期条件把今天整天的机会吃掉。
    const key = `dream-${localDayKey(now)}`
    if (this.state.has(key)) return
    this.state.mark(key)
    const ctx = timeContext(now)
    await this.turns.dreamTick(this.groupConversationKey, this.prompts.render('proactive/dream', { flavor: ctx.flavor }))
  }

  /**
   * 任务一：每日早报（06:00 每天一次）。
   *
   * The plugin only gathers material — date, timetable, weather, and how busy
   * the group was yesterday. The wording is the model's, so the briefing reads
   * like a person's morning message instead of a fixed template. Every input
   * stays optional: a host with no timetable or no city still gets a report.
   */
  private async morningReport(): Promise<void> {
    const settings = this.config.morningReport
    // Named skips instead of a bare `return`: a scheduled task that does nothing
    // must say *why*, or the operator (and the model reading its own log) will
    // conclude the scheduler is broken.
    if (!settings.enabled) {
      this.log('morning report skipped: morningReport.enabled is false')
      return
    }
    const master = this.config.admins[0]
    if (master === undefined) {
      this.log('morning report skipped: no admin configured (config.admins is empty)')
      return
    }
    const now = new Date()
    const today = localDayKey(now)
    // 素材收集只有一份实现（`materials.ts`）：旧调度器与事件书 v2 走同一条路径，
    // 免得"搬出去了但旧的还留一份"——两份迟早各自漂移。
    const { material, weather, schedule } = await collectMorningMaterial({
      now,
      today,
      settings,
      workspace: this.opts.workspace ?? null,
      dshHome: resolveDshHome(),
      primaryGroup: this.config.primaryGroup,
    })
    // 走人格包模板而不是内联字符串：模板在 tools.v2 下会被 composer 改写成
    // `qq_message（action=send）`。内联那一份曾经硬编码 `qq_send_text`，于是
    // 旧调度器（proactive.v2 关）在 tools.v2 开的部署里会教模型调用不存在的工具。
    const prompt = this.prompts.render('events/morning-report', { master: String(master), material })
    try {
      await this.turns.dmProactive(prompt)
      this.log(`morning report submitted to ${master} (weather=${weather !== '' ? 'yes' : 'no'}, schedule=${schedule !== '' ? 'yes' : 'no'})`)
    } catch (e) {
      this.log(`morning report failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Run one configured workspace script (no shell, confined to <workspace>/scripts). */
  private async runCruise(cruise: CruiseTaskConfig): Promise<void> {
    if (!this.config.workspacePath) return
    if (this.config.admins[0] === undefined) return
    const started = await runCruiseScript(cruise.script, {
      cwd: this.config.workspacePath,
      log: this.log,
    })
    if (started) this.log(`cruise executed: ${cruise.script} (every ${cruise.intervalMin}min)`)
  }

  private async extractKnowledge(): Promise<void> {
    const now = new Date()
    // 04:00-08:59 local: the dream writes the diary at 04:00, and the extra hours
    // are catch-up for a restart in the original one-hour slot.
    const h = now.getHours()
    if (h < 4 || h > 8) return
    const today = localDayKey(now)
    // Named skips, as in morningReport(): a silent return here made "the
    // extractor was never wired" look identical to "the diary was empty".
    // 闸门在标记之前：这两个都取自启动期，落盘后再改接线就再也补不回来了。
    if (!this.opts.onExtract) { this.log('knowledge: skipped, no extractor wired'); return }
    if (!this.configWorkspace) { this.log('knowledge: skipped, no workspace configured'); return }
    const key = `kn-${today}`
    if (this.state.has(key)) return
    this.state.mark(key)
    const diaryPath = `${this.configWorkspace}/memory/${today}.md`
    try {
      const fs = await import('node:fs/promises')
      const diary = await fs.readFile(diaryPath, 'utf-8').catch(() => '')
      if (diary.trim().length < 50) { this.log('knowledge: diary too short, skip'); return }
      const n = await this.opts.onExtract(`日记 ${today}`, diary)
      this.log(`knowledge: extracted ${n} entries from ${today} diary`)
    } catch (e) {
      this.log(`knowledge extract error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private configWorkspace = ''

  private async evolve(): Promise<void> {
    if (this.groupConversationKey === null) return
    await this.turns.evolveTick(this.groupConversationKey, this.prompts.render('proactive/evolve'))
  }
}
