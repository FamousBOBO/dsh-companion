/** 旁听缓冲（群聊短期背景）：一组群消息的内存环形缓冲。
 *
 * 为什么需要它：现在 `requireMention=true` 时未 @ 的消息在入队前就被丢掉了，于是下一次
 * 被 @ 时她对"刚才大家在聊什么"一无所知。要能看懂"你怎么看"这类追问，就得有一条
 * **有界**的短期记忆——只留最近一小段、到期就丢、不落盘、不当证据。
 *
 * 三条硬规矩（写在这里，因为它们是这个模块存在的理由）：
 *   1. **旁听 ≠ 发言**：进缓冲不等于要回，更不等于要调模型（那是 `core/presence` 的事）；
 *   2. **有界**：条数、时间、字数三重上限，任何一条越界都从最老的开始丢；
 *   3. **纯**：不读时钟、不写盘、不联网——时间由调用方传进来（R8 的重放要求）。
 *
 * `seq` 是"交付到哪了"的游标：被 @ 时把尚未交付的背景一次性取走（`take`），
 * 兴趣判断则只看最近一段（`peekAfter`，不推进游标）。两者共用同一份条目。
 */

/** 缓冲里的一条：保留真实发送者、消息号、时间与顺序。 */
export interface AmbientEntry {
  /** 群内单调递增序号；游标与"判断到哪了"都用它。 */
  readonly seq: number
  /** QQ 消息号；缺省为 null（合成消息没有号，不能参与去重）。 */
  readonly messageId: number | null
  /** 真实发送者 QQ 号（宿主给的，不是正文里自称的）。 */
  readonly userId: number
  /** 群名片或昵称；空串 = 不知道。 */
  readonly name: string
  /** 已渲染的入站行（含发送者标识），只作背景资料。 */
  readonly text: string
  /** 这条消息的时间（毫秒）。 */
  readonly atMs: number
  /** 她自己发的（回显 / 自主接话）。判断与背景都要能区分。 */
  readonly self: boolean
}

/** 三重上限。 */
export interface AmbientLimits {
  readonly maxEntries: number
  readonly ttlMs: number
  readonly maxChars: number
}

/** `add` 的入参（`seq` 由缓冲自己发）。 */
export type AmbientInput = Omit<AmbientEntry, 'seq'>

/** 取多少个（`maxEntries` / `maxChars` 都给默认值：调用方可以只给一半）。 */
export interface AmbientWindow {
  readonly excludeMessageId?: number | null
  readonly maxEntries?: number
  readonly maxChars?: number
}

/** 一条多少字才算"正文字数"：按码点算，emoji 不会被算成两个字。 */
function charsOf(text: string): number {
  return [...text].length
}

/** 正数才认；非法配置一律夹成安全值（绝不能因为一个手滑的配置把缓冲撑爆）。 */
function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 每群一个环形缓冲。群之间没有任何共享状态。 */
export class AmbientRing {
  private entries: AmbientEntry[] = []
  private nextSeq = 1

  constructor(public limits: AmbientLimits) {}

  /** 换上限（配置热更新）：立即按新上限裁剪，不迁移历史。 */
  configure(limits: AmbientLimits): void {
    this.limits = limits
    this.trim()
  }

  /**
   * 记一条。
   *
   * 顺序是**先去重、再入列**：重复消息（NapCat 重试、窗口回显）如果先入列，去重就没有意义了。
   */
  add(input: AmbientInput): 'added' | 'duplicate' | 'rejected' {
    this.prune(input.atMs)
    if (this.isDuplicate(input)) return 'duplicate'
    if (input.text.trim() === '') return 'rejected'
    this.entries.push({ ...input, seq: this.nextSeq })
    this.nextSeq += 1
    this.trim()
    return 'added'
  }

  /** 去重游标之后的条目（不推进游标）：兴趣判断用它，避免把同一批反复判。 */
  peekAfter(seq: number, nowMs: number): AmbientEntry[] {
    return this.live(nowMs).filter((entry) => entry.seq > seq)
  }

  /**
   * 把"尚未交付"的最近一段取走，并把游标推到最新。
   *
   * 被跳过（超出条数/字数、或是当前这条消息本身）的旧条目**也**算交付过：
   * 否则它们会在下一次被 @ 时又冒出来一遍。
   */
  take(nowMs: number, window: AmbientWindow = {}): AmbientEntry[] {
    const candidates = this.live(nowMs).filter((entry) =>
      entry.seq > this.cursor && (window.excludeMessageId === undefined
        || window.excludeMessageId === null
        || entry.messageId !== window.excludeMessageId))
    const picked = this.windowed(candidates, window)
    this.cursor = this.lastSeq()
    return picked
  }

  /** 最新序号（0 = 还空着）。 */
  lastSeq(): number {
    return this.nextSeq - 1
  }

  /** 未过期的条数。 */
  size(nowMs: number): number {
    return this.live(nowMs).length
  }

  /** 未过期的条目（时间正序）。 */
  live(nowMs: number): AmbientEntry[] {
    const ttl = positive(this.limits.ttlMs, 600_000)
    return this.entries.filter((entry) => entry.atMs + ttl > nowMs)
  }

  /** 已交付给回合的游标（诊断与测试用）。 */
  private cursor = 0

  private isDuplicate(input: AmbientInput): boolean {
    if (input.messageId === null) return false
    return this.entries.some((entry) => entry.messageId === input.messageId)
  }

  private prune(nowMs: number): void {
    const ttl = positive(this.limits.ttlMs, 600_000)
    this.entries = this.entries.filter((entry) => entry.atMs + ttl > nowMs)
  }

  /** 条数 + 字数双重淘汰，都从最老的开始。 */
  private trim(): void {
    const maxEntries = positive(this.limits.maxEntries, 40)
    const maxChars = positive(this.limits.maxChars, 6000)
    if (this.entries.length > maxEntries) this.entries = this.entries.slice(-maxEntries)
    let total = this.entries.reduce((sum, entry) => sum + charsOf(entry.text), 0)
    while (this.entries.length > 0 && total > maxChars) {
      const dropped = this.entries.shift()
      total -= charsOf(dropped?.text ?? '')
    }
  }

  /** 取窗口：先按条数留最近 N 条，再从最近往前按字数收（保证交替时保留最新的）。 */
  private windowed(entries: readonly AmbientEntry[], window: AmbientWindow): AmbientEntry[] {
    const maxEntries = positive(window.maxEntries ?? this.limits.maxEntries, 40)
    const maxChars = positive(window.maxChars ?? this.limits.maxChars, 6000)
    const recent = entries.slice(-maxEntries).reverse()
    const picked: AmbientEntry[] = []
    let total = 0
    for (const entry of recent) {
      const size = charsOf(entry.text)
      if (picked.length > 0 && total + size > maxChars) break
      picked.push(entry)
      total += size
    }
    return picked.reverse()
  }
}
