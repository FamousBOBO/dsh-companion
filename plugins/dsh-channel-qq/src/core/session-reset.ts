/** 会话体积看门狗：什么时候该给会话「换血」。
 *
 * 纯函数，方便在测试里把边界钉死。阈值来自**模型声明的窗口**（不是估算的
 * 默认值）：窗口没声明时不做判断——宁可不换，也不要在错误的尺寸上误杀历史。
 */

/** 阈值比例的合法范围：太低会频繁换血，太高来不及。 */
export const MIN_RATIO = 0.1
export const MAX_RATIO = 0.95

/**
 * 这个会话是不是该换血了？
 *
 * @param tokens 当前会话的请求 token 估算（tokenMeter 的结果）
 * @param contextWindow 路由模型声明的上下文窗口；未知时传 null
 * @param ratio 触发比例（`sessionReset.thresholdRatio`）
 */
export function shouldResetSession(
  tokens: number,
  contextWindow: number | null,
  ratio: number,
): boolean {
  if (contextWindow === null || !Number.isFinite(contextWindow) || contextWindow <= 0) return false
  if (!Number.isFinite(tokens) || tokens <= 0) return false
  const clamped = Number.isFinite(ratio) ? Math.min(Math.max(ratio, MIN_RATIO), MAX_RATIO) : 0.7
  return tokens >= contextWindow * clamped
}

/** 错误文本是不是「上下文/请求被上游拒绝」这一类（网关会把它包成 bad_response_status_code）。 */
export function looksLikeOverflow(detail: string): boolean {
  return /bad_response_status_code|context[ _-]?length|maximum context|too many tokens|CONTEXT_WINDOW_EXCEEDED/i.test(detail)
}

/** 连续同类错误的判定器：窗口内累计到 limit 次才返回 true；触发后有冷却。 */
export class OverflowStreak {
  private readonly hits = new Map<string, { count: number; at: number }>()
  private readonly lastFire = new Map<string, number>()

  constructor(
    private readonly limit = 2,
    private readonly windowMs = 10 * 60_000,
    private readonly cooldownMs = 30 * 60_000,
  ) {}

  /**
   * 记一次错误；达到阈值且不在冷却期时返回 true。
   * @param now 当前时间（注入，测试可重放）
   */
  hit(room: string, now: number): boolean {
    const previous = this.hits.get(room)
    const count = previous === undefined || now - previous.at > this.windowMs ? 1 : previous.count + 1
    this.hits.set(room, { count, at: now })
    if (count < this.limit) return false
    const fired = this.lastFire.get(room)
    if (fired !== undefined && now - fired < this.cooldownMs) return false
    this.lastFire.set(room, now)
    this.hits.delete(room)
    return true
  }

  /** 换血成功后清掉计数。 */
  clear(room: string): void {
    this.hits.delete(room)
  }
}

/** 管理员私聊里的换血指令（`/换血`、`重置会话`、`/reset`）。 */
export function isResetCommand(text: string): boolean {
  return /^\/?(换血|重置会话|reset)\s*$/i.test(text.trim())
}

/**
 * 定期换血：会话距上次换血超过 `maxAgeDays` 天就该重置。
 * `maxAgeDays <= 0` 表示关闭；未知上次时间（null）不触发。
 */
export function sessionExpired(lastResetAt: number | null, now: number, maxAgeDays: number): boolean {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return false
  if (lastResetAt === null || !Number.isFinite(lastResetAt)) return false
  return now - lastResetAt >= maxAgeDays * 24 * 60 * 60_000
}
