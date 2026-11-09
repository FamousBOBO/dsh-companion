/**
 * **按到期时刻醒来的定时器**（2026-11-10 修复：到点精度）。
 *
 * 为什么不再用 `setInterval(30_000)`：固定轮询把"提醒何时被看见"的下界钉死在轮询间隔上
 * ——一条 23:40:00 的提醒最好的情况也要 23:40:00–23:40:30 之间才被处理。实测事故日志里
 * 那 84 次被拦的记录间隔稳定在 30 s 上下，就是这条定时器（见
 * `docs/reminders-dispatch-timing.md`）。任务要求"计划时间附近 5 秒内进入发送流程"，
 * 固定 30 s 轮询在结构上达不到。
 *
 * 现在的行为：每拍跑完**重新算一次**下次唤醒时刻并 `setTimeout`——有未来提醒 ⇒ 正好在它的
 * `at` 醒来；没有 ⇒ 走心跳。心跳不能省，它兜三件事：时钟漂移、系统休眠/唤醒（`setTimeout`
 * 不保证跨休眠按墙钟走）、以及被外部手改过的提醒文件。
 *
 * **定时器与时钟都从 `Clock` 端口注入**（`ports/clock.ts`）。于是"到点精度"能在假时钟上
 * 逐毫秒测试（`test/reminders-dispatch-timing.test.ts`），不用靠 `sleep(150)` 猜。
 *
 * 这个类只管"什么时候叫醒你"，不懂业务：延迟由 `nextDelayMs()` 算，叫醒后干什么由
 * `onTick` 决定。
 */

import type { Clock, TimerHandle } from '../../ports/clock.js'

/** 排程现场（只读诊断 + 测试断言用）。 */
export interface WakeupState {
  /** 定时器还挂着吗。 */
  readonly armed: boolean
  /** 当前这一拍的等待时长（毫秒）；没排程时是 `null`。 */
  readonly delayMs: number | null
  /** 排过多少次（含启动那次）。 */
  readonly arms: number
  /** 实际跑过多少拍。 */
  readonly ticks: number
}

export interface WakeupTimerOptions {
  /** 时钟与定时器（缺省 = 系统实现；测试注入假时钟）。 */
  readonly clock: Clock
  /** 下一拍该等多久（毫秒；0 = 立刻）。每次 `onTick` 结束之后问一次。 */
  readonly nextDelayMs: () => number
  /** 叫醒之后干什么。`onTick` 抛错不影响继续排程。 */
  readonly onTick: () => Promise<void> | void
  readonly log: (line: string) => void
}

export class WakeupTimer {
  private handle: TimerHandle | null = null
  private delay: number | null = null
  private armCount = 0
  private tickCount = 0
  private closed = false

  constructor(private readonly deps: WakeupTimerOptions) {}

  /** 排上第一拍（立刻跑一次）。重复调用无副作用。 */
  start(): void {
    if (this.handle !== null) return
    this.closed = false
    this.arm(0)
  }

  /** 撤掉定时器（卸载/停表）。之后 `start()` 可以重来。 */
  dispose(): void {
    this.closed = true
    if (this.handle !== null) {
      this.handle.cancel()
      this.handle = null
    }
    this.delay = null
  }

  /**
   * **立刻重算并重排**（`nudge.ts` 的落点：刚建/刚删了一条提醒）。
   *
   * 不取消正在跑的 `onTick`——只撤掉"还在等的那一拍"。正在跑的那拍结束时自己会再算一次，
   * 所以最坏情况是多重排一次（`arm()` 覆盖旧句柄前先 `cancel`）。
   */
  reschedule(): void {
    if (this.closed || this.handle === null) return
    this.handle.cancel()
    this.handle = null
    this.arm(0)
  }

  state(): WakeupState {
    return { armed: this.handle !== null, delayMs: this.delay, arms: this.armCount, ticks: this.tickCount }
  }

  private arm(delayMs: number): void {
    if (this.closed) return
    const wait = Math.max(0, Math.floor(delayMs))
    this.delay = wait
    this.armCount += 1
    // **注意别写成 `() => { void this.fire() }`**：这里要**返回** promise，测试把定时器换掉之后
    // 才能 `await` 到"这一拍真的跑完"（`test/contact-regression.test.ts` 的 `captureIntervals`）。
    // `Clock.setTimeout` 声明的是 `() => void`，返回 promise 是合法的（调用方可以不理它）。
    const handle = this.deps.clock.setTimeout(() => this.fire(), wait)
    this.handle = handle
    // 别让这个定时器把进程钉住（主控 dispose 时进程照常退出）。
    if (typeof handle.unref === 'function') handle.unref()
  }

  private async fire(): Promise<void> {
    this.handle = null
    if (this.closed) return
    this.tickCount += 1
    try {
      await this.deps.onTick()
    } catch (error) {
      // 投递级异常由 runner 自己接住（它要按 code 分级停表）。能冒到这里的只剩程序级问题——
      // 记录下来，但**不许把定时器链断掉**：断了之后一条提醒都不会响，而且没有迹象。
      this.deps.log(`reminders: 本拍异常逃到定时器（${error instanceof Error ? error.message : String(error)}）→ 继续排程`)
    }
    if (this.closed) return
    let next = 1
    try {
      next = this.deps.nextDelayMs()
    } catch (error) {
      this.deps.log(`reminders: 算下一拍失败（${error instanceof Error ? error.message : String(error)}）→ 立刻重排`)
    }
    this.arm(next)
  }
}
