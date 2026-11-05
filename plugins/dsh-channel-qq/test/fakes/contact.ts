/** 主动消息（contact）验证用的假件：假时钟、假平台、假回合发起、假注册表、
 *  临时 dshHome，以及一个能真的跑 `SubPlugin.apply()` 的假 SubHost。
 *
 * 为什么要另起一个文件而不是改 `test/fakes/host.ts`：那份假宿主是给
 * `ConversationBridge` 用的（只造 cordis `ctx` 的七个服务面），而这里的被测对象是
 * **子插件装配 + 后台 worker**——它们看的是 `SubHost`（配置/服务袋/日志/资源表），
 * 且需要"推进时间""数定时器""记录每一次外发"。两种假件形状不同，混在一起会让
 * 任何一处改动都能同时打破两边。
 *
 * 三条纪律（与任务书一致）：
 *   1. 只用假件：**不连网络、不调真模型、不发真 QQ、不读写真记忆库**；
 *   2. 时间只由 `FakeClock` 给：代码里的 `Date.now()` 一律不该出现在被测路径上，
 *      测试推进时间用 `advance()`，不 sleep；
 *   3. 每一次外发都落账：`FakePlatform.sent` 是"到底发了几条"的唯一事实来源，
 *      断言直接数它——比断言日志里的字串可靠（日志格式会变，发送次数不会）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { QQChannelConfig } from '../../src/config.js'
import type { Clock, TimerHandle } from '../../src/ports/clock.js'
import type { ChatPlatform, QQApi, SendResult } from '../../src/ports/platform.js'
import type { OneBotMessage } from '../../src/types.js'
import type {
  ContactCandidate, ContactDelivery, ContactRuntimeFacts,
} from '../../src/features/contact/types.js'
import type { HostBridge, SectionHostEnv, ServiceBag, SubHost } from '../../src/features/plugin-kit.js'
import { createHost } from '../../src/features/plugin-kit.js'

// ── 时间 ────────────────────────────────────────────────────────────────────

/** 一个已排定的假定时器。 */
export interface FakeTimer {
  readonly id: number
  /** 下一次触发的绝对时刻（毫秒）。 */
  at: number
  /** 周期（毫秒）；`null` = 一次性。 */
  readonly every: number | null
  readonly fn: () => void
  cancelled: boolean
}

/**
 * 可推进的假时钟。
 *
 * `advance(ms)` 会**按时间顺序真的把到期回调跑掉**（而不是只改 `now()`）：后台
 * worker 的"每分钟一拍"是 `setInterval`，不触发它就没在测真实路径。回调本身多半是
 * `void this.tick(...)`，所以推进之后要用 `await settle()` 让微任务落地。
 */
export class FakeClock implements Clock {
  private atMs: number
  private seq = 0
  private readonly timers = new Map<number, FakeTimer>()
  /** 历史上被取消的定时器数（诊断"卸载时确实取消了"）。 */
  private cancelledCount = 0

  constructor(start: Date | number | string) {
    this.atMs = typeof start === 'number' ? start : new Date(start).getTime()
  }

  now(): number {
    return this.atMs
  }

  date(): Date {
    return new Date(this.atMs)
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.arm(fn, ms, null)
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    return this.arm(fn, ms, Math.max(1, ms))
  }

  /** 仍然活着的定时器（`dispose` 之后应当为空）。 */
  live(): FakeTimer[] {
    return [...this.timers.values()].filter((timer) => !timer.cancelled)
  }

  liveCount(): number {
    return this.live().length
  }

  /** 一共取消过几个（含 dispose 时批量取消的）。 */
  get cancelled(): number {
    return this.cancelledCount
  }

  /** 只改时间，不触发任何定时器（测"时间跳变"时用）。 */
  shift(ms: number): void {
    this.atMs += ms
  }

  /**
   * 推进时间并按顺序触发到期定时器。
   *
   * @returns 触发了几个回调
   */
  advance(ms: number): number {
    const target = this.atMs + ms
    let fired = 0
    // 上限只为防"周期 0 的死循环"：正常用例远达不到。
    for (let guard = 0; guard < 100_000; guard += 1) {
      const next = this.live()
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (next === undefined) break
      this.atMs = next.at
      if (next.every === null) {
        next.cancelled = true
        this.timers.delete(next.id)
      } else {
        // 先排下一拍再跑回调：回调里 `cancel()` 能生效（与真 setInterval 不冲突）。
        next.at += next.every
      }
      fired += 1
      try {
        next.fn()
      } catch {
        /* 被测代码的回调自带 try/catch；这里不让一次异常中断时间推进 */
      }
    }
    this.atMs = target
    return fired
  }

  /** 不推进时间，只把"当前时刻已到期"的定时器跑掉。 */
  flush(): number {
    return this.advance(0)
  }

  private arm(fn: () => void, ms: number, every: number | null): TimerHandle {
    this.seq += 1
    const timer: FakeTimer = {
      id: this.seq,
      at: this.atMs + Math.max(0, ms),
      every,
      fn,
      cancelled: false,
    }
    this.timers.set(timer.id, timer)
    return {
      cancel: () => {
        if (timer.cancelled) return
        timer.cancelled = true
        this.timers.delete(timer.id)
        this.cancelledCount += 1
      },
    }
  }
}

/** 让已经排队的微任务/`setImmediate` 落地（假定时器回调里常是 `void async()`）。 */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/**
 * 等一个条件成立——用**真实**定时器驱动。
 *
 * 为什么不能用 `settle()`/`setImmediate` 轮询：`setImmediate` 只转"检查阶段"，
 * 200 轮在 Windows 上只有十几毫秒，而 `acquireLease`/`persist` 走的是真实文件 I/O
 * （临时目录 + Defender 扫描，单次 10–50ms）。轮询预算用完时 I/O 还没回来，于是
 * 一条**实现正确**的用例会偶发变红。
 *
 * 也不能用 `FakeClock` 的 `setTimeout`：那是**被测对象的时间**，拿它等被测对象，
 * 一等就是死锁（假时钟没人推进）。所以这里用宿主真实时间，并且是独立于被测 `Clock` 的。
 */
export async function waitUntil(
  predicate: () => boolean,
  budgetMs = 3_000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
  if (predicate()) return
  throw new Error(`等不到条件成立（${String(budgetMs)}ms 用尽；可能是 fire-and-forget 的 tick 卡住）`)
}

// ── 平台（外发） ─────────────────────────────────────────────────────────────

/** 一次外发的账。 */
export interface SentMessage {
  /** 走的是哪个端口方法。 */
  via: 'sendTo' | 'sendGroupMessage' | 'sendPrivateMessage'
  isGroup: boolean
  target: number
  text: string
  /** 发送时刻（假时钟的毫秒；没有注入时钟时为 0）。 */
  at: number
}

/** 从 OneBot 消息段里取纯文本（测试只关心正文）。 */
export function segmentText(message: OneBotMessage | undefined): string {
  if (!Array.isArray(message)) return ''
  return message
    .map((segment) => {
      const data = (segment as { data?: { text?: unknown } }).data
      return typeof data?.text === 'string' ? data.text : ''
    })
    .join('')
}

export interface FakePlatformOptions {
  /** 注入假时钟，`SentMessage.at` 才有意义（也让"冷却"类断言可复核）。 */
  clock?: Clock
  /** 起始连接状态（默认已连上）。 */
  connected?: boolean
}

/**
 * 会记账的假平台。
 *
 * 三种"坏通道"都能造：
 *   - `connected = false` → `isConnected()` 为假（门控应当据此拒绝，不是照样发）；
 *   - `failWith = '...'` → 每次发送都 reject（发送层必须记 failed，不能假成功）；
 *   - `loseReceipt = true` → 发送**成功**但返回空对象（回执丢失 → 只能记 unknown）。
 */
export class FakePlatform implements ChatPlatform {
  readonly sent: SentMessage[] = []
  /** 每一次端口调用（含失败的），按顺序。 */
  readonly attempts: Array<{ via: string; isGroup: boolean; target: number; ok: boolean }> = []
  selfId: number | null = 10000
  connected: boolean
  /** 非空时每次发送都抛这个错。 */
  failWith: string | null = null
  /**
   * 非空时每次发送都抛**这个错误对象**（优先于 `failWith`）。
   *
   * 用来造"带 `code` 的网络错误"与"OneBot 明确拒绝"这两种必须分流的异常：
   * `fromError` 只看 `instanceof ContactTimeoutError` 时，它们会一起掉进 `failed`。
   */
  failWithError: unknown = null
  /** true = 已发出但回执丢失（resolve 空对象）。 */
  loseReceipt = false
  readonly api: QQApi
  private readonly clock: Clock | undefined

  constructor(options: FakePlatformOptions = {}) {
    this.clock = options.clock
    this.connected = options.connected ?? true
    const self = this
    const send = async (
      via: SentMessage['via'],
      isGroup: boolean,
      target: number,
      message: OneBotMessage,
    ): Promise<SendResult> => {
      self.attempts.push({ via, isGroup, target, ok: self.failWith === null && self.failWithError === null })
      if (self.failWithError !== null) throw self.failWithError
      if (self.failWith !== null) throw new Error(self.failWith)
      self.sent.push({ via, isGroup, target, text: segmentText(message), at: self.clock?.now() ?? 0 })
      return self.loseReceipt ? {} : { message_id: 90000 + self.sent.length }
    }
    this.api = {
      sendTo: (isGroup: boolean, target: number, message: OneBotMessage) => send('sendTo', isGroup, target, message),
      sendGroupMessage: (target: number, message: OneBotMessage) => send('sendGroupMessage', true, target, message),
      sendPrivateMessage: (target: number, message: OneBotMessage) => send('sendPrivateMessage', false, target, message),
      getStatus: async () => ({ online: self.connected, good: self.connected }),
      canSendRecord: async () => ({ yes: false }),
    } as unknown as QQApi
  }

  isConnected(): boolean {
    return this.connected
  }

  /** 发出去几条（断言的主入口）。 */
  count(): number {
    return this.sent.length
  }

  /** 发往某个目标的正文列表。 */
  textsTo(target: number): string[] {
    return this.sent.filter((item) => item.target === target).map((item) => item.text)
  }
}

/**
 * 可挂住 callback 的假出站链（模拟真实限速队列的**等待窗口**）。
 *
 * 真实 `OutboundQueue` 会先等 `rateLimitMs` 才执行 callback，于是"决策"与"执行"之间
 * 有一个真实存在的时间窗——这段时间里用户可能刚说话、候选可能被取消、实例可能被暂停
 * 或接管。`hold = true` 就把这个窗口**显式化**：`out.push(task)` 不立刻跑 `task`，
 * 而是排队等 `release()`。这样"窗口期内世界变了"才测得到。
 *
 * 纪律：不用 `setImmediate` 轮询等待（Windows 上只值十几毫秒），用本文件的
 * `waitUntil`（真实定时器）等 `pending()`。
 */
export class FakeOutboundQueue {
  /** true = 之后的 `push` 都挂住，直到 `release()`。 */
  hold = false
  /** 入队过几次（含立即执行的）——"到底有没有真的进过队列"的唯一事实来源。 */
  pushCount = 0
  private readonly held: Array<() => Promise<void>> = []

  async push<T>(task: () => Promise<T>): Promise<T> {
    this.pushCount += 1
    if (!this.hold) return await task()
    return await new Promise<T>((resolve, reject) => {
      this.held.push(async () => {
        try {
          resolve(await task())
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  /** 还挂着的任务数。 */
  pending(): number {
    return this.held.length
  }

  /** 放行所有挂住的任务（按入队顺序）并等它们**连同调用方的续体**都跑完。 */
  async release(): Promise<void> {
    while (this.held.length > 0) {
      const run = this.held.shift()
      if (run === undefined) break
      await run()
      // 让 `await push(...)` 那一侧的续体先跑：否则紧接着的断言会看到"还没结算"。
      await settle(2)
    }
  }
}

/** 造一个带 `code` 的 Node 网络错误（`ECONNRESET` / `EPIPE` / `ETIMEDOUT` …）。 */
export function nodeError(code: string, message = `${code}: socket hang up`): Error {
  const error = new Error(message)
  Object.assign(error, { code })
  return error
}

/**
 * 造一个 OneBot **明确拒绝**（响应体带 `retcode` / `status: 'failed'`）。
 *
 * 第四轮 R5 之后，分类器只信任**带专用标记**的拒绝（`onebot.ts` 的 `ONEBOT_REJECTION`，
 * 由适配层在失败帧上打不可枚举标记）。所以这个工厂必须**同时**打标记——否则它只是一个
 * "带几个可疑字段的普通异常"，正确的分类是 `unknown`。
 * 用 `Symbol.for` 取同一个注册符号，避免测试去 import `onebot.ts`（那里会拖进 ws）。
 */
export function oneBotReject(retcode = 100, status = 'failed'): Error {
  const error = new Error(`send failed: retcode=${String(retcode)} status=${status}`)
  Object.assign(error, { retcode, status })
  Object.defineProperty(error, Symbol.for('dsh-channel-qq.onebot-rejection'), { value: true, enumerable: false })
  return error
}

// ── 回合 / 注册表 ───────────────────────────────────────────────────────────

/** 一次"把提示词交给会话"的记录。 */
export interface BookedPrompt {
  room: string
  prompt: string
  at: number
}

/**
 * 假回合发起器。
 *
 * 只实现被测路径真的会调用的四个入口，**记录每一次**——"模型被叫了几次"就是
 * `booked.length`（空转 24 小时应当恒为 0）。
 */
export class FakeTurns {
  readonly booked: BookedPrompt[] = []
  readonly patrols: string[] = []
  readonly dreams: string[] = []
  readonly evolves: string[] = []
  readonly sendsToDm: string[] = []
  /** `bookPrompt` 的返回值（false = 没提交上，例如会话忙）。 */
  submitOk = true
  /** 非空时 `bookPrompt` 直接抛错（测"失败不标成功"）。 */
  throwWith: string | null = null
  private readonly clock: Clock | undefined

  constructor(clock?: Clock) {
    this.clock = clock
  }

  async bookPrompt(room: string, prompt: string): Promise<boolean> {
    if (this.throwWith !== null) throw new Error(this.throwWith)
    this.booked.push({ room, prompt, at: this.clock?.now() ?? 0 })
    return this.submitOk
  }

  async patrolTick(key: string, prompt: string): Promise<void> {
    this.patrols.push(`${key}|${prompt}`)
  }

  async dreamTick(key: string, prompt: string): Promise<void> {
    this.dreams.push(`${key}|${prompt}`)
  }

  async evolveTick(key: string, prompt: string): Promise<void> {
    this.evolves.push(`${key}|${prompt}`)
  }

  async dmProactive(prompt: string): Promise<void> {
    this.sendsToDm.push(prompt)
  }

  /** 所有"叫了模型"的次数（回合三种 + 私聊主动）。 */
  total(): number {
    return this.booked.length + this.patrols.length + this.dreams.length + this.evolves.length + this.sendsToDm.length
  }
}

/**
 * 假会话注册表：`get(room)` 给 `{ tracker.running(), lastEvent }`。
 *
 * `lastEvent.time` 是**秒**（OneBot 事件的时间戳单位），`features/contact/index.ts` 的
 * `roomFacts()` 会乘 1000 变成"最后一条事件时刻"，所以这里必须和真事件同一个单位——
 * 单位写错会让 settle 窗口整个失效，而测试仍然"看起来在跑"。
 */
export class FakeRegistry {
  private readonly records = new Map<string, { running: boolean; lastEventTime: number }>()
  /** `get()` 被调用了几次（诊断越权读取用）。 */
  reads = 0

  constructor(entries: Array<[string, boolean]> = []) {
    for (const [room, running] of entries) this.records.set(room, { running, lastEventTime: 0 })
  }

  get(room: string): { tracker: { running(): boolean }; lastEvent: { time: number } } | undefined {
    this.reads += 1
    const record = this.records.get(room)
    if (record === undefined) return undefined
    return {
      tracker: { running: () => record.running },
      lastEvent: { time: record.lastEventTime },
    }
  }

  set(room: string, running: boolean): void {
    const record = this.records.get(room)
    if (record === undefined) this.records.set(room, { running, lastEventTime: 0 })
    else record.running = running
  }

  /** 设置房间"最后一条事件"的时刻（**毫秒**，内部换算成秒）。 */
  setLastEvent(room: string, ms: number): void {
    const record = this.records.get(room)
    const seconds = Math.floor(ms / 1000)
    if (record === undefined) this.records.set(room, { running: false, lastEventTime: seconds })
    else record.lastEventTime = seconds
  }
}

// ── 临时 dshHome ────────────────────────────────────────────────────────────

export interface TempHome {
  readonly dir: string
  cleanup(): void
}

/** 一个只属于本次测试的空 dshHome（**绝不**指向真的 `~/.dsh`）。 */
export function tempHome(prefix = 'qq-contact-'): TempHome {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  let cleaned = false
  return {
    dir,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 已经不在了 */ }
    },
  }
}

// ── contact 领域的造数 ──────────────────────────────────────────────────────

/** 一条"一切正常"的候选（改哪条传哪条）。 */
export function contactCandidate(over: Partial<ContactCandidate> = {}): ContactCandidate {
  return {
    id: 'c-1',
    source: 'follow-up',
    reason: '跟进上次说的部署',
    evidenceSource: 'chatlog',
    evidenceIds: [],
    scope: { userId: 10001, personaId: 'nono', worldId: '' },
    target: { channel: 'qq', room: 'dm-10001', isGroup: false, chatId: 10001 },
    priority: 0,
    earliestAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    dedupeKey: 'followup:dm-10001:deploy',
    version: 1,
    authorization: { kind: 'none', by: null, at: null, quote: null },
    state: 'pending',
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    lastSuppressedReason: null,
    ...over,
  }
}

/** 一条"已经领到"的投递记录。 */
/**
 * 等到"没有待处理候选"为止（**测试纪律**，不是产品行为）。
 *
 * 为什么要它：`contactPlugin.start()` → `worker.start()` 会 `void this.tick()` 掷出**首拍**，
 * 而 `worker.tick()` 在上一拍未完成时只记 `pendingTickAt` 然后**立刻返回**（产品有意如此：
 * 丢一拍等于丢一分钟）。于是"`await 一次 tick()`"**不等于**"这一拍跑完了"——测试若紧接着
 * 断言，就会看到 `pending` 这种中间态（`D2b`/`D2c` 在并行 + 高负载下偶发红就是这个）。
 *
 * 用法：`await waitCandidatesSettled(() => service.status())`。等不到会**抛错**
 * （`waitUntil` 的消息里就写着"可能是 fire-and-forget 的 tick 卡住"）——比放宽断言严。
 */
export async function waitCandidatesSettled(
  status: () => { readonly candidates: readonly { readonly state: string }[] },
  budgetMs = 5_000,
): Promise<void> {
  await waitUntil(() => status().candidates.every((item) => item.state !== 'pending'), budgetMs)
}

export function contactDelivery(over: Partial<ContactDelivery> = {}): ContactDelivery {
  return {
    id: 'd-1',
    candidateId: 'c-1',
    dedupeKey: 'followup:dm-10001:deploy',
    target: { channel: 'qq', room: 'dm-10001', isGroup: false, chatId: 10001 },
    scope: { userId: 10001, personaId: 'nono', worldId: '' },
    text: '在吗',
    state: 'pending',
    attempts: 0,
    leaseOwner: null,
    epoch: 0,
    createdAt: 0,
    updatedAt: 0,
    submittedAt: null,
    confirmedAt: null,
    receipt: null,
    lastError: null,
    mode: 'direct',
    ...over,
  }
}

/** 一份"什么都不挡"的运行时事实。 */
export function contactRuntime(over: Partial<ContactRuntimeFacts> = {}): ContactRuntimeFacts {
  return {
    connected: true,
    roomBound: true,
    turnRunningByRoom: {},
    toolRunning: false,
    lastUserMessageAtByRoom: {},
    deliveredDedupeKeys: [],
    ...over,
  }
}

// ── 配置 ────────────────────────────────────────────────────────────────────

/** 一个配置字段的最小形状（只取测试要读的那一项）。 */
interface FieldLike {
  readonly default: unknown
}

/**
 * 从配置段定义里读出默认值。
 *
 * 为什么不用 `resolveConfig()`：它会读环境与磁盘（`DSH_HOME`、分层配置），测试要的是
 * "代码里写死的默认值"而不是"这台机器当前的配置"。也不在测试里抄一份数字：
 * `CONTACT_GROUPS` 的 `spec.default` 是唯一来源，改了默认值这里自动跟着变。
 */
export function fieldDefaults(groups: readonly { readonly fields?: Record<string, FieldLike> }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const group of groups) {
    for (const [key, spec] of Object.entries(group.fields ?? {})) out[key] = spec.default
  }
  return out
}

/** 一份"什么都没打开"的最小配置；每项测试只打开自己关心的那一块。 */
export function baseConfig(overrides: Record<string, unknown> = {}): QQChannelConfig {
  const base: Record<string, unknown> = {
    primaryGroup: 1000000003,
    admins: [10001],
    workspacePath: null,
    rateLimitMs: 0,
    morningReport: { enabled: true, scheduleFile: null, weatherLocation: null },
    // 与 DEFAULT_CONFIG 对齐：生产默认 `enabled: true`（`resolveConfig` 会补），夹具是手写
    // 配置、少了这个字段会让"轮询器该不该启动"（P1-02）判错。
    // `dryRun: false`：3A-3 的生产默认是 true（灰度），但本夹具服务的是"投递行为"用例，
    // 需要真发；要测灰度语义的用例自己显式传 `dryRun`。
    reminders: { enabled: true, dryRun: false, file: null },
    memory: { v2: false },
    proactive: { v2: false, book: { version: 1, events: [] } },
    cruises: [],
    contact: { enabled: false, dryRun: false },
  }
  for (const [key, value] of Object.entries(overrides)) {
    const current = base[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && current !== null && typeof current === 'object' && !Array.isArray(current)) {
      base[key] = { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) }
    } else {
      base[key] = value
    }
  }
  return base as unknown as QQChannelConfig
}

// ── 假 SubHost ──────────────────────────────────────────────────────────────

/** 什么都不做的宿主桥（子插件装配期只会用到它）。 */
export function fakeBridge(): HostBridge {
  return {
    toolHost: () => ({ tools: { register: () => () => {} } }),
    agentGateway: () => ({} as never),
    tagContext: () => ({} as never),
    presetRegistry: () => undefined,
    agentRegistry: () => undefined,
    providersSurface: () => undefined,
    logHostError: () => {},
    reloadSections: async () => [],
  }
}

export interface FakeSubHost {
  readonly host: SubHost
  readonly bag: ServiceBag
  readonly logs: string[]
  readonly resources: Record<string, unknown>
  /** 已 provide 的服务直接塞进袋子（模拟装载顺序在前的子插件）。 */
  with<K extends keyof ServiceBag>(name: K, value: NonNullable<ServiceBag[K]>): FakeSubHost
}

/** 造一个能跑 `plugin.apply(host)` 的假宿主（不碰 cordis、不碰磁盘真实位置）。 */
export function fakeSubHost(name: string, config: QQChannelConfig, dshHome: string): FakeSubHost {
  const bag: ServiceBag = {}
  const logs: string[] = []
  const resources: Record<string, unknown> = {}
  const env: SectionHostEnv = {
    config,
    dshHome,
    log: (line: string) => { logs.push(line) },
    resources: resources as never,
    bridge: fakeBridge(),
    scope: async () => () => {},
  }
  const host = createHost(env, bag, name)
  const self: FakeSubHost = {
    host,
    bag,
    logs,
    resources,
    with: (key, value) => { bag[key] = value; return self },
  }
  return self
}
