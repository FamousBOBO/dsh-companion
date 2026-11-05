/** 一个房间的回合账本：谁在跑、跑完了没有、失败了要不要重试。
 *
 * 这些东西原来散在 `Conversation` 的十个字段里，由三个地方分别改（`submit()`、
 * `attachTurnWatch()` 的两个事件回调、`clearGatewayRetry()`），其中两个还在
 * `bridge.ts` 的文件级函数里。收成一个类之后：
 *
 *   - "什么时候算忙"只有一个答案（`busy()`），攒批闸门直接问它；
 *   - 失败分类与退避曲线是 `core/retry-policy.ts` 的纯函数，这里只做状态迁移；
 *   - 时间与定时器都走 `ports/clock.ts`，于是"退避 30 秒之后重试"可以在测试里
 *     一次推进到点，而不是真的等 30 秒。
 *
 * 状态迁移**逐条对应**原来的分支，包括那些看起来可以合并的地方——P3 的规矩是
 * 行为不变，语义的简化留给 P6。
 */

import type { AgentSession, PromptContent, TurnListener } from '../../ports/agent-gateway.js'
import type { Clock } from '../../ports/clock.js'
import { GATEWAY_RETRY_MAX, classifyFailure, gatewayBackoffMs } from '../../core/retry-policy.js'
import type { GatewayHealth } from './gateway-health.js'

export interface TurnTrackerDeps {
  /** 房间键，只用于日志（`group-1000000003`）。 */
  readonly room: string
  readonly health: GatewayHealth
  readonly clock: Clock
  readonly log: (line: string) => void
  /** 重试时补给模型的那句话；取自人格包，所以是取值函数（改文件不用重启）。 */
  readonly nudge: () => string
  /** 实时读取注入模式（后台改了立即生效，所以是取值函数而不是快照）。 */
  readonly injectMode: () => { readonly enabled: boolean; readonly duringTurn?: boolean; readonly wakeIdle: boolean }
  /** 取随机数（退避抖动）——注入是为了让退避曲线可重放。 */
  readonly roll: () => number
  /** 每次模型错误都投递一次（换血看门狗据此识别连续 400）。 */
  readonly onGatewayError?: (room: string, detail: string) => void
  /** 回合结束（A1 交互提示撤销）；没开始过的回合调到它应当是空操作。 */
  readonly onTurnEnd?: (room: string) => void
  /** 回合出错（C2 指标标记 / A2 失败告知）。 */
  readonly onTurnError?: (room: string, kind: 'retry' | 'permanent') => void
}

export class TurnTracker implements TurnListener {
  private session: AgentSession | null = null
  /** 这一轮的提示词；网关失败重试要用它判断"还有没有包可重试"。 */
  private lastPrompt: string | null = null
  private lastPromptHadImages = false
  /** `submit()` 已经把这一包交出去了、还没观察到 idle。 */
  private liveSubmitted = false
  /** 正在跑一轮（宿主 idle 之前一直为真）。 */
  private pending = false
  /** 这一轮是什么时候开始的（看门狗判断「卡住了」用）。 */
  private startedAt = 0
  /** 刚结束的那一轮是不是网关形状的失败。 */
  private turnErrored = false
  /** 重试链已武装（攒批要给它让路，别把包塞进来）。 */
  private retryArmed = false
  private retryCount = 0
  private retryTimer: { cancel(): void } | null = null
  private textOnlyRetryDone = false

  constructor(private readonly deps: TurnTrackerDeps) {}

  /** 会话开出来之后接上；重试与"是否在跑"都要用它。 */
  bind(session: AgentSession): void {
    this.session = session
  }

  /** 有回合在跑，或有重试链已经武装——攒批闸门据此重新排期。 */
  busy(): boolean {
    return this.pending || this.retryArmed
  }

  /** 有一轮正在跑吗（**不含**"重试已武装"）。"现在再递一包会不会撞车"用它。 */
  running(): boolean {
    return this.pending
  }

  /** 这一轮开始的时间戳；没在跑时为 0。看门狗用它判断"卡住了"。 */
  runningSince(): number {
    return this.pending ? this.startedAt : 0
  }

  /**
   * 开始一轮：把这一包记下来，武装"忙"标记。
   *
   * 新的一包**顶掉**旧的网关重试（旧包的问题已经被新内容取代了）。
   */
  begin(prompt: string, hadImages: boolean): void {
    this.clearRetry()
    this.pending = true
    this.startedAt = this.deps.clock.now()
    this.lastPrompt = prompt
    this.lastPromptHadImages = hadImages
    this.textOnlyRetryDone = false
    this.retryCount = 0
    this.turnErrored = false
  }

  /**
   * 把内容递给会话。
   *
   * 走哪条通道取决于注入模式：跑着就 `inject`（只进上下文，不唤醒），空闲时按
   * `wakeIdle` 决定 `steer`（唤醒）还是 `inject`。宿主不支持该通道时退回 `followup`
   * ——那是老运行时上的唯一通路。
   */
  deliver(content: PromptContent): void {
    const session = this.session
    if (session === null) throw new Error(`channel-qq: no session bound for ${this.deps.room}`)
    const mode = this.deps.injectMode()
    if (mode.enabled) {
      const running = session.isRunning()
      const channel = running ? 'inject' : (mode.wakeIdle ? 'steer' : 'inject')
      if (session.deliver(content, channel)) {
        this.liveSubmitted = true
        return
      }
    }
    session.deliver(content, 'followup')
    this.liveSubmitted = true
  }

  /**
   * 本地补丁 COMPANION-QQ-PATCH-6：把内容作为**引导**插进正在跑的回合。
   *
   * 与 `deliver()` 的差别只有一处：不看 `injectMode` 开关——回合在跑就强制走 `inject`
   * 通道（只进上下文、不新开一轮）；回合没在跑或宿主不支持该通道时返回 `false`，
   * 由调用方决定是排队还是另开回合一。
   *
   * 用途：她正在分段发消息（段间有停顿）时对方又发来一句——那句话应该成为这一轮的
   * 引导（"等一下，我还没说完"能被立刻看到），而不是等这一轮结束再单开一轮。
   */
  injectGuidance(content: PromptContent): boolean {
    const session = this.session
    if (session === null) return false
    if (!session.isRunning()) return false
    if (!session.deliver(content, 'inject')) return false
    this.liveSubmitted = true
    return true
  }

  /** 宿主报 idle：这一轮结束了。 */
  onIdle(): void {
    const wasRunning = this.pending || this.liveSubmitted
    if (wasRunning) {
      this.pending = false
      this.liveSubmitted = false
      this.startedAt = 0
      this.deps.log(`turn done for ${this.deps.room}`)
      // A1：先撤销提示，再走重试判断——失败重试期间不该继续显示"正在输入"。
      this.deps.onTurnEnd?.(this.deps.room)
    }
    if (!this.turnErrored) {
      // 干净地跑完了：这一包到位了，重试链不再需要。
      this.clearRetry()
      return
    }
    // 失败的一轮：留着已武装的重试链，只把这一轮的标记复位。
    this.turnErrored = false
  }

  /** 宿主报错：分类、必要时安排重试。 */
  onError(error: { readonly raw: string }): void {
    this.deps.onGatewayError?.(this.deps.room, error.raw)
    const action = classifyFailure(error.raw, {
      hadImages: this.lastPromptHadImages,
      textOnlyRetryDone: this.textOnlyRetryDone,
    })
    this.deps.onTurnError?.(this.deps.room, action.kind === 'permanent' ? 'permanent' : 'retry')
    if (action.kind === 'retry-text-only') {
      this.retryTextOnly()
      return
    }
    if (action.kind === 'permanent' || this.session === null) return
    if (this.lastPrompt === null) return
    if (this.retryTimer !== null) return // 一个失败窗口只挂一条重试链
    if (this.retryCount >= GATEWAY_RETRY_MAX) {
      this.deps.log(`turn for ${this.deps.room} exhausted ${GATEWAY_RETRY_MAX} gateway retries; giving up`)
      this.clearRetry()
      this.lastPrompt = null
      return
    }
    this.armRetry()
  }

  /** 取消已武装的重试链（成功、新包、或卸载）。 */
  clearRetry(): void {
    if (this.retryTimer !== null) this.retryTimer.cancel()
    this.retryTimer = null
    this.retryArmed = false
  }

  /** 卸载：取消重试定时器（攒批定时器由调用方管）。 */
  dispose(): void {
    this.clearRetry()
    // 会话被释放时也要撤销提示，否则「正在输入」会一直挂在对方窗口上。
    this.deps.onTurnEnd?.(this.deps.room)
  }

  /** 带图的请求被整个拒了：正文还在，改发一次纯文本，而不是丢掉这一轮。 */
  private retryTextOnly(): void {
    const session = this.session
    if (session === null || this.lastPrompt === null) return
    this.textOnlyRetryDone = true
    this.turnErrored = false
    this.pending = true
    this.deps.log(`image request rejected; retrying text-only for ${this.deps.room}`)
    session.deliver([{ type: 'text', text: this.deps.nudge() }], 'followup')
  }

  /** 安排一次退避重试；重试时递的是同一句 nudge（原包已经在会话历史里）。 */
  private armRetry(): void {
    this.turnErrored = true
    this.retryArmed = true
    this.retryCount += 1
    const attempt = this.retryCount
    const delay = gatewayBackoffMs(attempt, this.deps.roll)
    this.deps.health.arm(this.deps.clock.now(), delay)
    this.deps.log(
      `scheduling gateway retry ${attempt}/${GATEWAY_RETRY_MAX} for ${this.deps.room} in ${Math.round(delay / 1000)}s`,
    )
    this.retryTimer = this.deps.clock.setTimeout(() => {
      this.retryTimer = null
      const session = this.session
      if (session === null || !this.lastPrompt) return
      this.deps.log(`retry ${attempt}/${GATEWAY_RETRY_MAX} for ${this.deps.room}`)
      this.pending = true
      session.deliver([{ type: 'text', text: this.deps.nudge() }], 'followup')
    }, delay)
  }
}
