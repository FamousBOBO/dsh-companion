/** 自主接话的限频记账（纯函数层）。
 *
 * 这个模块只回答一个问题：**此刻能不能判、能不能说**，以及"发生过什么"要如何记。
 * 它不读时钟、不发消息、不掷骰子——时间由调用方传进来，所以每个分支都能在测试里
 * 用一行假时间复现（R8 的重放要求）。
 *
 * 三条口径（都是事故换来的）：
 *   1. **判断与发言分开记账**。判断频率决定花多少钱，发言频率决定扰不扰民；两者
 *      间隔不同（判断密、发言稀），混成一个计数器就没法同时满足。
 *   2. **只有真实回执才算"说过话"**：`recordSpeak` 只由拿到 `message_id` 的调用方
 *      调用。判断失败、发送失败、模型沉默都**不**推进发言冷却，也不占每小时额度——
 *      否则一次网络抖动就能让她整小时不说话。
 *   3. **重置不能补发**：`emptyPresenceState(now)` 把 `judgeAtMs` / `speakAtMs` 都
 *      置成"现在"，于是热加载/重启后既不会立刻回放旧批次、也不会瞬间开口。
 */

/** 一小时（毫秒）：每小时发言额度的窗口长度。 */
export const HOUR_MS = 3_600_000

/** 限频参数（来自 `presence.*` 配置；调用方保证是合法数值）。 */
export interface PresenceLimits {
  /** 两次兴趣判断之间的最小间隔。 */
  readonly judgeIntervalMs: number
  /** 两次自主发言之间的最小间隔。 */
  readonly speakMinIntervalMs: number
  /** 每群每小时最多自主发言几次。 */
  readonly speakMaxPerHour: number
  /** 连续判断失败到几次就暂停（缺省 3）。 */
  readonly maxConsecutiveFailures?: number
  /** 暂停多久（缺省 10 分钟）。 */
  readonly failurePauseMs?: number
}

/** 一个群的记账状态。不可变：每次变化都换一份新对象，方便比较与回放。 */
export interface PresenceState {
  /** 上次兴趣判断的时刻。 */
  readonly judgeAtMs: number
  /** 上次**成功**自主发言的时刻。 */
  readonly speakAtMs: number
  /** 最近一小时内每次成功发言的时刻（滚动窗口）。 */
  readonly sentTimes: readonly number[]
  /** 连续判断失败次数。 */
  readonly failures: number
  /** 暂停到这个时刻为止（0 = 没暂停）。 */
  readonly pauseUntilMs: number
}

/** 被拒的具名理由（进日志，回答"这一次为什么没说话"）。 */
export type PresenceVeto =
  | 'judge-too-soon'
  | 'speak-cooldown'
  | 'hour-quota'
  | 'paused'
  | 'no-context'

export interface PresenceVerdict {
  readonly ok: boolean
  readonly reason?: PresenceVeto
}

const OK: PresenceVerdict = { ok: true }

function veto(reason: PresenceVeto): PresenceVerdict {
  return { ok: false, reason }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 额度类配置的取值：**0 是有效的 0，不是"没配"**。
 *
 * 这一条与上面那行的区别是安全方向。对**间隔**类（`judgeIntervalMs` / `speakMinIntervalMs`）
 * 把 0 当"没配"退回默认是安全的：结果都是"少做点"。对**额度**类（`speakMaxPerHour`）
 * 正好相反：0 退回默认 3 会让"我把它设成 0 想停发"变成"每小时还能说三次"——配置手滑
 * 变成了更多的外发。所以额度这里 fail-closed：给 0 就是 0。
 *
 * 负数/NaN/undefined 仍然退默认（那不是刻意配置，是坏值）。
 *
 * **但停发不要依赖这个**：`speakMaxPerHour=0` 只能停"自主发言"，停不了表情包与将来的
 * 其它出站路径，也不留下"本来想说什么"的诊断。真正的停发开关是
 * `presence.mode`（见 `core/presence-mode.ts`）。
 */
function quota(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.trunc(value)
}

/**
 * 一个群的初始状态。
 *
 * `nowMs` 会被写进 `judgeAtMs` / `speakAtMs`：**这是故意的**——热加载之后第一件事
 * 不该是"把刚才没说完的话补上"。
 */
export function emptyPresenceState(nowMs: number): PresenceState {
  return { judgeAtMs: nowMs, speakAtMs: nowMs, sentTimes: [], failures: 0, pauseUntilMs: 0 }
}

/** 一小时内已成功发言几次（窗口按 `nowMs` 滚动，顺带丢掉过期记录）。 */
export function recentSends(state: PresenceState, nowMs: number): number[] {
  return state.sentTimes.filter((at) => at > nowMs - HOUR_MS)
}

/** 此刻能不能发起一次兴趣判断。`pending` 是"还有多少条旁听没判过"。 */
export function judgeVerdict(
  state: PresenceState,
  nowMs: number,
  limits: PresenceLimits,
  pending: number,
): PresenceVerdict {
  if (state.pauseUntilMs > nowMs) return veto('paused')
  if (pending <= 0) return veto('no-context')
  if (nowMs - state.judgeAtMs < positive(limits.judgeIntervalMs, 50_000)) return veto('judge-too-soon')
  return OK
}

/** 此刻能不能真的开口（判断通过之后再过一遍：中间可能有过别的发言）。 */
export function speakVerdict(
  state: PresenceState,
  nowMs: number,
  limits: PresenceLimits,
): PresenceVerdict {
  if (state.pauseUntilMs > nowMs) return veto('paused')
  if (nowMs - state.speakAtMs < positive(limits.speakMinIntervalMs, 300_000)) return veto('speak-cooldown')
  if (recentSends(state, nowMs).length >= quota(limits.speakMaxPerHour, 3)) return veto('hour-quota')
  return OK
}

/**
 * 记一次判断的结果。
 *
 * `spoke` / `silent` 都算"判断成功"（模型正常回答"不说"也是成功）；只有
 * `failed`（没路由 / 超时 / 无效输出 / 发送失败）才推进失败计数，连续失败到阈值就暂停一阵，
 * 免得每 50 秒去撞一次坏掉的模型。
 */
export function recordJudge(
  state: PresenceState,
  nowMs: number,
  outcome: 'spoke' | 'silent' | 'failed',
  limits: PresenceLimits,
): PresenceState {
  const judged: PresenceState = { ...state, judgeAtMs: nowMs }
  if (outcome !== 'failed') return { ...judged, failures: 0 }
  const failures = state.failures + 1
  const threshold = positive(limits.maxConsecutiveFailures ?? 3, 3)
  const pauseMs = positive(limits.failurePauseMs ?? 600_000, 600_000)
  return {
    ...judged,
    failures,
    pauseUntilMs: failures >= threshold ? nowMs + pauseMs : state.pauseUntilMs,
  }
}

/**
 * 记一次**真实**自主发言（调用方必须已经拿到 `message_id` 回执）。
 *
 * 顺带把过期的小时记录裁掉：`sentTimes` 只留最近一小时，长跑也不会无限增长。
 */
export function recordSpeak(state: PresenceState, nowMs: number): PresenceState {
  return {
    ...state,
    speakAtMs: nowMs,
    sentTimes: [...recentSends(state, nowMs), nowMs],
    failures: 0,
  }
}
