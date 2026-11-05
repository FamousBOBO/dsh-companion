/**
 * 出站队列：限速 + 长度硬切分。
 *
 * **分段（把一条长回复拆成几条）不在这个文件里**——它在 `core/text/segment.ts`，
 * 由 `qq_send_text` 这个工具在开关打开时调用（P6h）。这里保留的是队列本身与
 * `smartSplitMessage`（单条超过 OneBot 上限时的硬切分，D9：它永远在线）。
 */

import type { QQChannelConfig } from './config.js'
import type { QQApi } from './ports/platform.js'
import type { OneBotMessageSegment } from './types.js'

/**
 * Hard-split one overlong segment at natural boundaries (ported from the
 * extension's smartSplitMessage): newline first, then sentence punctuation,
 * then a hard cut. Keeps every chunk under the OneBot-safe limit.
 */
export function smartSplitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }
    let splitPos = remaining.lastIndexOf('\n', limit)
    // 切在标点**之后**（标点跟着上一块），切在硬限位时则不含第 `limit+1` 个字符。
    // 这两种情况的区别曾经被 `splitPos + 1` 抹平，于是"没有边界的超长文本"每块
    // 都比上限多一个字——对一个自称"keeps every chunk under the limit"的函数来说，
    // 那是它自己文档的反例。
    let inclusive = true
    if (splitPos < limit * 0.5) {
      splitPos = Math.max(
        remaining.lastIndexOf('。', limit),
        remaining.lastIndexOf('！', limit),
        remaining.lastIndexOf('？', limit),
        remaining.lastIndexOf('!', limit),
        remaining.lastIndexOf('?', limit),
        remaining.lastIndexOf('. ', limit),
        remaining.lastIndexOf('；', limit),
        remaining.lastIndexOf('; ', limit),
        remaining.lastIndexOf(', ', limit),
        remaining.lastIndexOf('，', limit),
      )
      if (splitPos <= 0) {
        splitPos = limit
        inclusive = false
      }
    }
    const cut = inclusive ? splitPos + 1 : splitPos
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  return chunks.filter((chunk) => chunk !== '')
}

/** 出站计数（指标页用）：每次 send 成功/失败各记一次。 */
export interface OutboundStats {
  sent(): void
  failed(): void
}

/** Serialises sends so the configured rate limit holds across segments and tools. */
export class OutboundQueue {
  private chain: Promise<void> = Promise.resolve()
  /** Every segment ever sent, keyed lowercase — a repeat is skipped (sentMessages). */
  private readonly sentHistory = new Set<string>()

  constructor(
    private readonly api: QQApi,
    private readonly config: QQChannelConfig,
    private readonly log: (line: string) => void,
    private readonly stats?: OutboundStats,
  ) {}

  /** Queue one send; trailing nullish segments are skipped silently. */
  enqueue(send: () => Promise<unknown>): void {
    this.chain = this.chain
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, this.config.rateLimitMs)))
      .then(send)
      .then(() => this.stats?.sent())
      .catch((error: Error) => {
        this.stats?.failed()
        this.log(`send failed: ${error.message}`)
      })
      .then(() => {})
  }


  /** Rate-limited send that resolves with the OneBot result when its turn in the chain comes. */
  push<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.chain = this.chain
        .then(() => new Promise<void>((resolve) => setTimeout(resolve, this.config.rateLimitMs)))
        .then(() => task())
        .then((value) => {
          this.stats?.sent()
          resolve(value)
        })
        .catch((error: Error) => {
          this.stats?.failed()
          reject(error)
        })
    })
  }
}
