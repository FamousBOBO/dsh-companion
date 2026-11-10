/** 群聊的**弱反馈**信号（P4 §8.3）：只记录"有没有人接话"，绝不据此改人格或提频率。
 *
 * 这一层存在的理由是一个具体的失败模式：把"没人回复"当成负面评价，然后为了拿到回应不断
 * 提高发言频率——最后变成刷屏。所以这里有三条硬边界：
 *
 *   1. **只记事实，不记结论**：`continued` 表示"她说完之后 90 秒内有没有别人接着说话"，
 *      仅此而已。它不叫"成功"，也不叫"失败"。
 *   2. **不改核心人格**：这个模块不写 `config/persona.md`、不写人格快照、不调任何模型。
 *      它只产出一个可选的"表达倾向"数字，供后续人工审阅；当前实现**不把它接回提示词**。
 *   3. **不改发言频率**：限频只由 `core/presence.ts` 决定。任何"没人理 → 多说点"的回路
 *      都在设计上被禁止（§8.4 最后一条验收项）。
 *
 * 纯函数 + 一个内存小账本：不落盘（重启即清），不联网（R8）。
 */

/** 一次自主发言的后续观察结果。 */
export interface FeedbackSignal {
  /** 她说完之后有没有别人说话。 */
  readonly continued: boolean
  /** 跟进的人数（去重后的 QQ 号个数）。 */
  readonly responders: number
  /** 跟进第一条隔了多少毫秒（`null` = 没人接）。 */
  readonly latencyMs: number | null
  /** 是否有人明显重复她刚说过的话（判据是正文高度重合，见下）。 */
  readonly echoed: boolean
}

/** 观察窗口：她说完之后多久算"接话"（毫秒）。 */
export const FEEDBACK_WINDOW_MS = 90_000

/** 一次待观察的发言。 */
interface Pending {
  readonly text: string
  readonly atMs: number
}

/** 一个群的反馈账本（内存，重启即清）。 */
export class GroupFeedbackBook {
  private readonly pending = new Map<number, Pending>()
  private readonly signals = new Map<number, FeedbackSignal[]>()

  /** 记下"她刚说完一句"，等后续观察。 */
  expect(groupId: number, text: string, atMs: number): void {
    this.pending.set(groupId, { text, atMs })
  }

  /**
   * 有人说话了：如果还在观察窗口内，就结算一次信号。
   *
   * 为什么要结算而不是累加：一次发言对应一次信号，重复结算会让"接话率"变成人气数字。
   */
  settle(groupId: number, input: { text: string; userId: number; atMs: number }): FeedbackSignal | null {
    const waiting = this.pending.get(groupId)
    if (waiting === undefined) return null
    const latency = input.atMs - waiting.atMs
    if (latency < 0 || latency > FEEDBACK_WINDOW_MS) {
      // 窗口过了：记一条"没人接"再清空（否则这条永远不会被结算）。
      this.pending.delete(groupId)
      return this.record(groupId, { continued: false, responders: 0, latencyMs: null, echoed: false })
    }
    this.pending.delete(groupId)
    return this.record(groupId, {
      continued: true,
      responders: 1,
      latencyMs: latency,
      echoed: overlaps(waiting.text, input.text),
    })
  }

  /** 关窗口时结算所有还没结算的（卸载/热重载：记"没人接"，不补发）。 */
  flush(nowMs: number): void {
    for (const [groupId, waiting] of [...this.pending.entries()]) {
      if (nowMs - waiting.atMs <= FEEDBACK_WINDOW_MS) continue
      this.pending.delete(groupId)
      this.record(groupId, { continued: false, responders: 0, latencyMs: null, echoed: false })
    }
  }

  /** 最近的信号（诊断用；不含正文）。 */
  recent(groupId: number, limit = 20): FeedbackSignal[] {
    return (this.signals.get(groupId) ?? []).slice(-Math.max(1, limit))
  }

  /**
   * 汇总成一个**只读**倾向（诊断/人工审阅用）。
   *
   * `continuedRate` 刻意不叫"满意度"：没人接可能是话题过去了、也可能是大家都睡了，
   * 把它读成评价就会滑向"为了数字而发言"。
   */
  summary(groupId: number): { samples: number; continued: number; continuedRate: number; echoed: number } {
    const list = this.signals.get(groupId) ?? []
    const continued = list.filter((signal) => signal.continued).length
    return {
      samples: list.length,
      continued,
      continuedRate: list.length === 0 ? 0 : continued / list.length,
      echoed: list.filter((signal) => signal.echoed).length,
    }
  }

  clear(): void {
    this.pending.clear()
    this.signals.clear()
  }

  private record(groupId: number, signal: FeedbackSignal): FeedbackSignal {
    // 每群最多留 50 条：这是诊断数据，不是日志文件。
    const list = [...(this.signals.get(groupId) ?? []), signal].slice(-50)
    this.signals.set(groupId, list)
    return signal
  }
}

/**
 * 两句话是否高度重合（"明显重复"的判据）。
 *
 * 用最朴素的双字重叠率而不是编辑距离：群里复读通常是"整句搬过去"或"换一个语气词"，
 * 双字重叠对这两种都敏感，而且不会因为标点不同就判成不重复。
 */
export function overlaps(original: string, reply: string): boolean {
  return overlapRatio(original, reply) >= 0.6
}

/**
 * 双字重叠率（0–1）。`overlaps` 是它的布尔版本（阈值 0.6）。
 *
 * 为什么单独暴露比例：P6 的复读复核要**自己定阈值**（那里取 0.9，几乎是同一句才拦），
 * 而"接话是不是复读"用的是 0.6。两个场景的代价不对称——误判"她复读了"会让她少说话，
 * 误判"有人接上话了"只是诊断数字难看。
 */
export function overlapRatio(original: string, reply: string): number {
  const a = bigrams(original)
  const b = bigrams(reply)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of b) if (a.has(gram)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/** 双字集合（去空白与标点）。 */
function bigrams(text: string): Set<string> {
  const cleaned = text.replace(/[\s，,。.！!？?、：:；;"'“”「」（）()]/gu, '')
  const chars = [...cleaned]
  const grams = new Set<string>()
  for (let i = 0; i + 1 < chars.length; i += 1) grams.add(`${chars[i]}${chars[i + 1]}`)
  return grams
}
