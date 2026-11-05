/** 宿主 token 用量（C1/C2）。
 *
 * 数据来自 dsh 的 `tokenUsage` 会话投影：不随分页/压缩/重连漂移的**持久计费**。
 * 端口只暴露四个桶，不暴露宿主类型——metrics 子插件按它做按房间/按天的聚合。
 */

export interface UsageBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** 一个会话的累计用量；宿主没有 token-meter 时恒为 null。 */
export interface UsageProbe {
  usage(sessionId: string): Promise<UsageBuckets | null>
}
