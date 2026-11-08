/** 一次自主发言**之后**的附加动作（P4 §8.2 表情包 / §8.3 弱反馈 / P3 话题落地）。
 *
 * 为什么单独一个文件：这三件事都发生在"她已经说出去了"之后，失败也绝不能影响那句话；
 * 而 `presence-wiring.ts` 已经接近函数级上限（`check:size` 的 60 行）。拆出来之后
 * 每条附加动作都能被单独读、单独测。
 *
 * 三条共同约束：
 *   1. **只在拿到回执之后**才被调用（`presence-cycle.ts` 的 `onSpoken`）；
 *   2. **绝不抛**：每一段自己 catch 并记一行日志；
 *   3. **不改人格、不改频率**：表情包只发一张且有独立额度，弱反馈只记事实，
 *      任何"没人理就多说点"的回路在 §8.4 里被明确禁止。
 */

import { checkSticker } from '../../core/group-expression.js'
import { GroupFeedbackBook } from '../../core/group-feedback.js'
import { noteGroupTopic } from '../../adapters/dsh-host/group-memory.js'
import { expressionServiceOf, sendSticker } from '../../adapters/dsh-host/expression-service.js'
import { dataRootOfDshHome } from '../../adapters/dsh-host/group-persona.js'
import { positiveOr } from '../../app/inbound/presence-flow.js'
import type { PresenceView } from '../../app/inbound/presence-flow.js'
import type { SubHost } from '../plugin-kit.js'

/** 表情包的默认额度（与文字分开：文字是啰嗦，图是刷屏）。 */
const STICKER_DEFAULTS = { minIntervalMs: 600_000, maxPerHour: 1 } as const

/** 一次"她说完了"的输入。 */
export interface SpokenInput {
  readonly groupId: number
  readonly action: 'reply' | 'join' | 'react'
  readonly text: string
  readonly messageId: number
  readonly atMs: number
  readonly topic: string | null
}

/** 每群的发图记录（内存，重启即清；额度本来就是滑动窗口，不需要持久化）。 */
interface StickerLedger {
  lastAtMs: number
  sentTimes: number[]
}

/** 套件数据根（与人格/记忆同一条口径）。 */
function dataRootOf(host: SubHost): string | null {
  try {
    // 直接复用适配层的算法：**不要**在这里再算一次父目录——两份算法一旦分叉，
    // 群记忆与人格快照就会指向不同的库，而这种不一致只会以"记忆时有时无"的形式出现。
    return dataRootOfDshHome(host.dshHome)
  } catch {
    return null
  }
}

/**
 * 表情包的额度与发送（§8.2）。
 *
 * 三条：额度独立于文字；只在 `join`/`react` 上考虑；**能不能发由图库决定**——
 * 这里只做"要不要去问"，问完拿到候选才发，绝不拼路径、绝不重试。
 */
function stickerStep(host: SubHost, ledgers: Map<number, StickerLedger>, input: SpokenInput, settings: PresenceView): void {
  if (settings.stickers !== true) return
  const ledger = ledgers.get(input.groupId) ?? { lastAtMs: 0, sentTimes: [] }
  ledgers.set(input.groupId, ledger)
  ledger.sentTimes = ledger.sentTimes.filter((at) => at > input.atMs - 3_600_000)
  const verdict = checkSticker({
    action: input.action,
    text: input.text,
    hasTopic: input.topic !== null && input.topic !== '',
    nowMs: input.atMs,
    lastStickerAtMs: ledger.lastAtMs,
    sentThisHour: ledger.sentTimes.length,
    minIntervalMs: positiveOr(settings.stickerMinIntervalMs ?? STICKER_DEFAULTS.minIntervalMs, STICKER_DEFAULTS.minIntervalMs),
    maxPerHour: positiveOr(settings.stickerMaxPerHour ?? STICKER_DEFAULTS.maxPerHour, STICKER_DEFAULTS.maxPerHour),
  })
  if (!verdict.ok) {
    host.log(`presence: 群 ${String(input.groupId)} 这一句不配图（${verdict.reason}）`)
    return
  }
  const service = expressionServiceOf(() => host.bridge.tagContext()).service
  const outcome = sendSticker(service, {
    groupId: input.groupId,
    query: verdict.query,
    // 图配在文字**之后**：文字是主表达，图是补充（反过来会让图变成开场白）。
    mode: 'text_then_sticker',
    text: input.text,
    log: host.log,
  })
  if (outcome.kind !== 'sent') {
    host.log(`presence: 群 ${String(input.groupId)} 表情没发（${outcome.reason}）`)
    return
  }
  ledger.lastAtMs = input.atMs
  ledger.sentTimes = [...ledger.sentTimes, input.atMs]
}

/**
 * 造一个"说完之后"的处理器。
 *
 * @param host 用来取配置/打日志/拿上下文
 * @param settingsOf 现取 `presence.*`（热改立即生效）
 */
export function afterSpeakHandler(
  host: SubHost,
  settingsOf: () => PresenceView | null,
): (input: SpokenInput) => void {
  const feedback = new GroupFeedbackBook()
  const ledgers = new Map<number, StickerLedger>()
  return (input) => {
    // ① 弱反馈：记下"她刚说完一句"，等后续 90 秒内有没有人接（只记事实，不做评价）。
    try {
      feedback.expect(input.groupId, input.text, input.atMs)
    } catch {
      /* 反馈是诊断数据，坏了不影响任何东西 */
    }
    // ② 话题落地：把当前话题写给存储，下一次召回可以按话题取相关记忆。
    try {
      if (input.topic !== null && input.topic !== '') {
        noteGroupTopic({
          dataRoot: dataRootOf(host),
          groupId: input.groupId,
          topic: input.topic,
          startedBy: '',
          participants: [],
        })
      }
    } catch {
      /* 话题没写进去只是少一条证据 */
    }
    // ③ 表情包（§8.2）。整段包在 try 里：配图失败绝不能影响"这一句已经发出去了"。
    try {
      const settings = settingsOf()
      if (settings !== null) stickerStep(host, ledgers, input, settings)
    } catch (error) {
      host.log(`presence: 群 ${String(input.groupId)} 表情动作失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
