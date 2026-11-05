/** 运行环境事实的端口类型（只有类型）。
 *
 * 每包注入一次，用来压过历史里过时的能力描述（2026-10-20 的「看不到图」
 * 自我强化事故）。实现见 `adapters/dsh-host/runtime-info.ts`。
 */

export interface RuntimeFacts {
  readonly provider: string
  readonly model: string
  /** 是否支持图片输入。 */
  readonly vision: boolean
  /** 上下文窗口；未知为 null。 */
  readonly contextWindow: number | null
}
