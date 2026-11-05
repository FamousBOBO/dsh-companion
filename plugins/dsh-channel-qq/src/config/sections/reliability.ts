/** 可靠性段（A2）：长回合的进度告知与永久失败告知。
 *
 * 为什么不是"重发最终答案"：本项目的回复由模型调用发送工具完成，网关超时后
 * 回合账本会用退避重试**重新驱动同一包**（`core/retry-policy.ts`），结果由工具
 * 在重试回合里送达；没有"未投递的最终文本"可补。缺的是**告诉对方还在处理**，
 * 以及**永久失败时说一声**。
 */

import { b, n, type FieldGroup } from '../dsl.js'

export interface ReliabilityConfig {
  /** 回合超过 slowAfterMs 还没结束，发一句"还在处理"。 */
  slowNotice: boolean
  slowAfterMs: number
  /** 永久性失败（参数错误/重试用尽）时发一句失败告知。 */
  failureNotice: boolean
}

export const RELIABILITY_GROUPS: FieldGroup[] = [
  {
    id: 'reliability',
    label: '回合告知',
    page: 'messages',
    help: '长回合计时告知、永久失败告知；默认关，关着时一条提示都不发。',
    fields: {
      // 读法：每回合现取（live）。
      slowNotice: b('慢回合发一句「还在处理」', false, {
        hot: 'live',
        help: '默认关。只发一次，回合结束后不会再发"处理完了"。',
      }),
      slowAfterMs: n('多久算慢（毫秒）', 120_000, {
        min: 10_000, max: 1_800_000, step: 5_000, hot: 'live', unit: 'ms',
        hiddenIf: { field: 'reliability.slowNotice', equals: false },
      }),
      failureNotice: b('永久失败说一声', false, {
        hot: 'live',
        help: '默认关。网关退避重试仍在跑时不说；只在确定不会再试时发一句。',
      }),
    },
  },
]
