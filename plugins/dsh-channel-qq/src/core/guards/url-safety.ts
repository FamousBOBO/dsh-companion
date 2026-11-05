/** 出站 URL 安检（D 组，审计 [20261025_snowluma-capability-audit.md] §2-D）。
 *
 * 协议端的 `check_url_safely` 是**异步**的网络调用，而工具闸门的 pre-execute
 * 钩子是**同步**的——所以安检做成"缓存 + 预热"两段：
 *
 *   - `warm(text)`：**异步**提取文本里的 URL 逐个查协议端，结果进缓存（TTL 30 分钟）。
 *     挂在 gate 的 post-execute（发送成功后预热）与 `qq_check_url` 工具（模型主动查）；
 *   - `cachedBlock(text)`：**同步**查缓存，命中"危险"就拦。第一次出现的链接
 *     缓存里还没有 → 放行并触发预热（同一链接第二次就会被拦）。
 *
 * 这个局限写在明面上：这是**渐进式**安检，不是发送前的完整闸门——同步钩子拿不到
 * 网络结果。对"同一条危险链接被反复发"的场景（最常见的刷屏/诈骗复读）有效。
 *
 * R8：不读时钟——`now` 由调用方注入。
 */

/** SnowLuma 的 level 语义：1 安全 / 2 警告 / 3 危险（qq_check_url 同一映射）。 */
export const URL_LEVEL_DANGEROUS = 3

export type UrlLevelSource = (url: string) => Promise<{ level?: number | string } | null>

export class UrlSafetyGuard {
  private readonly cache = new Map<string, { verdict: number; at: number }>()
  private readonly inflight = new Set<string>()

  constructor(
    private readonly checker: UrlLevelSource,
    private readonly ttlMs = 30 * 60_000,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** 文本里出现的 http(s) 链接（去重，保序）。 */
  static urlsOf(text: string): string[] {
    const matches = text.match(/https?:\/\/[^\s<>"'）】]+/g) ?? []
    return [...new Set(matches)]
  }

  /**
   * 同步查缓存：文本里有缓存判定为"危险"的链接就返回它（拦截原因），
   * 否则返回 null。过期条目视为未缓存。
   */
  cachedBlock(text: string, now: number, threshold: number = URL_LEVEL_DANGEROUS): string | null {
    for (const url of UrlSafetyGuard.urlsOf(text)) {
      const hit = this.cache.get(url)
      if (hit === undefined || now - hit.at > this.ttlMs) continue
      if (hit.verdict >= threshold) return url
    }
    return null
  }

  /** 异步预热：文本里还没缓存（或已过期）的 URL 逐个查协议端。 */
  async warm(text: string, now: number): Promise<void> {
    const urls = UrlSafetyGuard.urlsOf(text).filter((url) => {
      if (this.inflight.has(url)) return false
      const hit = this.cache.get(url)
      return hit === undefined || now - hit.at > this.ttlMs
    })
    await Promise.all(urls.map(async (url) => {
      this.inflight.add(url)
      try {
        const got = await this.checker(url)
        const level = Number(got?.level ?? 1)
        const verdict = Number.isFinite(level) ? level : 1
        this.cache.set(url, { verdict, at: now })
        if (verdict >= URL_LEVEL_DANGEROUS) {
          this.log(`url-safety: ${url} 判定为危险（level ${verdict}）——同一链接下次经过闸门会被拦截`)
        }
      } catch (error) {
        // 查不到就留空（下次再试）；绝不把"查不到"当成"安全"写进缓存。
        this.log(`url-safety: ${url} 查询失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        this.inflight.delete(url)
      }
    }))
  }

  /** 测试用：直接写入一个判定（绕过 checker）。 */
  seed(url: string, verdict: number, now: number): void {
    this.cache.set(url, { verdict, at: now })
  }
}
