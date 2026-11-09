/** 混合机器人生态的**接线层**（P9-G4 §3 / §4.1）：把"参与者是谁"与"参与会不会变成循环"接进一次判断。
 *
 * 为什么与 `presence-scene.ts` 分开：那个文件管的是"这一批谁在跟谁说话"（平台结构），
 * 这里管的是"说话的人属于哪一类、这一轮参与有没有价值"（生态判断）。两件事共用同一批背景，
 * 但**判据来源不同**——身份来自注册表，风险来自结构统计。混在一个文件里会让
 * "注册表坏了"和"场景判不出来"看起来像同一个故障。
 *
 * 三条纪律：
 *   1. **身份由代码查，不由模型猜**（§2.1）：这里只调 `resolveParticipant`，
 *      模型看到的永远是查完的结果；
 *   2. **注册表缺失不是错误**：拿不到注册表 → 所有人 `unknown`，照常判断；
 *   3. **绝不抛**：身份或风险算不出来只是少一段上下文，不能让这一次判断失败。
 */

import { assessInteractionRisk, type InteractionRisk, type RiskEntry } from '../../core/bot-ecology.js'
import {
  registryFor, resolveParticipant,
  type GroupParticipant, type RegistryFile, type SenderKind,
} from '../../core/participant.js'
import { renderParticipants, renderRisk } from './group-ecology-prompt.js'
import type { CycleDeps, CycleInput } from './presence-flow.js'

/** 这一批的参与者（去重后按出现顺序）。注册表拿不到时全员 `unknown`（不是错误）。 */
export function participantsOf(input: CycleInput, deps: CycleDeps): GroupParticipant[] {
  try {
    const registry = registryFor(deps.registry?.() ?? null, input.groupId)
    const selfId = deps.selfId?.()
    const seen = new Set<number>()
    const out: GroupParticipant[] = []
    for (const entry of input.background) {
      if (!Number.isSafeInteger(entry.userId) || entry.userId <= 0) continue
      if (seen.has(entry.userId)) continue
      seen.add(entry.userId)
      // 采集时冻结过就用它，否则现查（§2.3）。
      if (entry.senderKind !== undefined) {
        out.push({
          userId: entry.userId,
          displayName: entry.name,
          senderKind: entry.senderKind,
          source: 'manual_registry',
        })
        continue
      }
      out.push(resolveParticipant({
        userId: entry.userId,
        displayName: entry.name,
        ...(selfId === undefined ? {} : { selfId }),
        registry,
      }))
    }
    return out
  } catch {
    return []
  }
}

/**
 * 这一批的互动风险。
 *
 * 身份**逐条**取（同一个人在背景里可能被标过两次）：`assessInteractionRisk` 要按
 * 每条消息的发送者类别分别统计"有几个已确认的 bot 在说话"，所以这里不能只传去重后的列表。
 */
export function riskOf(input: CycleInput, deps: CycleDeps): InteractionRisk | null {
  try {
    const registry = registryFor(deps.registry?.() ?? null, input.groupId)
    const selfId = deps.selfId?.()
    const entries: RiskEntry[] = input.background.map((entry) => {
      const participant = resolveParticipant({
        userId: entry.userId,
        displayName: entry.name,
        ...(selfId === undefined ? {} : { selfId }),
        registry,
      })
      // 采集时冻结过就用它（§2.3：历史事件的原始身份不许被后来的注册表改写）。
      const frozen = entry.senderKind
      return {
        messageId: entry.messageId,
        userId: entry.userId,
        senderKind: frozen ?? participant.senderKind,
        text: entry.body ?? entry.text,
        atMs: entry.atMs,
        self: entry.self,
        replyToMessageId: entry.replyToMessageId ?? null,
        atIds: entry.atIds ?? [],
      }
    })
    return assessInteractionRisk(entries, deps.clock.now())
  } catch {
    return null
  }
}

/** 渲染身份段（空串 = 这一批没有可说的身份信息）。 */
export function renderParticipantsSection(input: CycleInput, deps: CycleDeps): string {
  try {
    return renderParticipants(participantsOf(input, deps))
  } catch {
    return ''
  }
}

/** 渲染风险段（空串 = 低风险，没有建议）。 */
export function renderRiskSection(input: CycleInput, deps: CycleDeps): string {
  try {
    const risk = riskOf(input, deps)
    return risk === null ? '' : renderRisk(risk)
  } catch {
    return ''
  }
}

/** 一份可以进影子日志/评测记录的生态元数据（§8 的 `MixedEcologyEvalMetadata` 前半）。 */
export interface EcologyMeta {
  readonly botParticipants: readonly number[]
  readonly humanParticipants: readonly number[]
  readonly unknownParticipants: readonly number[]
  readonly botLoopRisk?: 'low' | 'medium' | 'high'
  readonly semanticDuplicate?: boolean
  readonly alreadyAnswered?: boolean
  readonly newInformation?: boolean
}

/**
 * 抽一份生态元数据。
 *
 * 为什么要单独一个函数：影子日志与评测报告要的是**结构化字段**，而提示词要的是**渲染文本**。
 * 两件事共用同一批计算结果，但一个不能从另一个反解（从中文里解出 bot 数量就是又猜一次）。
 */
export function ecologyMetaOf(input: CycleInput, deps: CycleDeps): EcologyMeta {
  const participants = participantsOf(input, deps)
  const risk = riskOf(input, deps)
  const pick = (kind: GroupParticipant['senderKind']): number[] =>
    participants.filter((participant) => participant.senderKind === kind).map((participant) => participant.userId)
  return {
    botParticipants: pick('known_bot'),
    humanParticipants: pick('known_human'),
    unknownParticipants: pick('unknown'),
    ...(risk === null ? {} : {
      botLoopRisk: risk.botLoopRisk,
      semanticDuplicate: risk.semanticDuplicate,
      alreadyAnswered: risk.alreadyAnswered,
      newInformation: risk.newInformation,
    }),
  }
}

/**
 * 采集时冻结的发送者身份（P9-G4 §2.3 的落点）。
 *
 * 为什么在这里算而不是让流水线自己拼：流水线只该知道"要不要带身份"，不该知道
 * 注册表怎么查、`selfId` 怎么比。这一处与判断时那一处**共用同一个 `resolveParticipant`**，
 * 两处结果才不会分叉（分叉的表现是"采集时是 bot、判断时是人"，而那正是最难查的一类）。
 *
 * 注册表拿不到时返回空对象（不带这个字段），而不是 `{ senderKind: 'unknown' }`：
 * "没查"与"查了没登记"在诊断上是两件事（见 `JudgeEntry.senderKind` 的注释）。
 */
export function senderKindFields(
  registry: RegistryFile | null,
  groupId: number,
  input: { readonly userId: number; readonly displayName?: string; readonly selfId?: number | undefined },
): { readonly senderKind?: SenderKind } {
  try {
    const participant = resolveParticipant({
      userId: input.userId,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.selfId === undefined ? {} : { selfId: input.selfId }),
      registry: registryFor(registry, groupId),
    })
    return { senderKind: participant.senderKind }
  } catch {
    return {}
  }
}
