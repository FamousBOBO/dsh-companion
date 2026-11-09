/** 把**参与者身份**与**互动风险**渲染成提示词里的两段（P9-G4 §3 / §4.1）。
 *
 * 为什么单独一个文件、而不是塞进 `group-scene-prompt.ts`：那是"这一批谁在跟谁说话"的结构摘要，
 * 这是"说话的人是哪一类、参与会不会变成循环"的生态摘要。两件事的**误判代价**也不同——
 * 结构判错只是提示词里少一句，身份判错会让她的社交判断建立在假事实上。分开写才读得清。
 *
 * 三条纪律（与 §2.1 / §4.1 逐条对应）：
 *   1. **只摆事实，不写结论句**。不出现"别理机器人""该沉默了"；身份只写"已确认/未确认"，
 *      建议只写"如果参与，要求什么"，不替模型选动作。
 *   2. **unknown 必须显式写出来**。§2.1 说"身份未知不妨碍理解内容，但不得当成已确认事实"——
 *      所以未登记的成员要被**点名说明未登记**，而不是渲染成普通群友（那会让模型默认它是人）。
 *   3. **有字数上限**。这两段是上下文，不是资料库。
 *
 * 纯函数：不读时钟、不读盘（R8）。
 */

import type { InteractionRisk } from '../../core/bot-ecology.js'
import { riskAdvice } from '../../core/bot-ecology.js'
import type { GroupParticipant, SenderKind } from '../../core/participant.js'

/** 身份段的字数上限（与场景段同一量级：它是帮忙看懂，不是主角）。 */
export const ECOLOGY_MAX_CHARS = 400

/** 每一类身份的中文说法。**措辞刻意保守**：没有一处写"这是机器人所以…"。 */
const KIND_TEXT: Record<SenderKind, string> = {
  self: '你自己',
  known_bot: '已确认的机器人',
  known_human: '已确认的人',
  unknown: '未登记（身份未确认）',
}

/** 一条参与者怎么称呼：有名字用名字，没有再退回号。 */
function labelOf(participant: GroupParticipant): string {
  const name = participant.displayName.trim()
  const base = name === '' ? 'QQ ' + String(participant.userId) : name
  const alias = participant.botProfileId === undefined ? '' : '（' + participant.botProfileId + '）'
  return base + alias
}

/**
 * 渲染参与者身份段。
 *
 * @param participants 这一批的参与者（已由代码查过注册表；**不要**让模型自己判）
 * @returns 空串 = 这一批没有可说的身份信息（只有一个人且未登记时省掉这一整段）
 *
 * 什么时候给空：只有一名参与者、且身份是 `unknown`。那种情况下"某某未登记"只是复述背景，
 * 多一段反而占上下文；而**只要出现第二名成员或任何已确认身份**，身份差异就有信息量了。
 */
export function renderParticipants(participants: readonly GroupParticipant[]): string {
  const seen = new Set<number>()
  const unique: GroupParticipant[] = []
  for (const participant of participants) {
    if (seen.has(participant.userId)) continue
    seen.add(participant.userId)
    unique.push(participant)
  }
  if (unique.length <= 1) {
    const only = unique[0]
    if (only === undefined || only.senderKind === 'unknown') return ''
  }
  const lines: string[] = ['【这一批的参与者身份（由代码查注册表得出，未登记的就是未登记）】']
  for (const participant of unique.slice(0, 8)) {
    lines.push('- ' + labelOf(participant) + '：' + KIND_TEXT[participant.senderKind])
  }
  const unknownCount = unique.filter((participant) => participant.senderKind === 'unknown').length
  if (unknownCount > 0) {
    // §2.1 的落点：明写"不能从风格推断身份"，否则模型会照着"像 AI 的措辞"给人贴标签。
    lines.push('- 标「未登记」的成员：**不许**从措辞、昵称、回复速度推断它是人或机器人。'
      + '不知道就当不知道，按普通群友理解内容即可。')
  }
  return clip(lines.join('\n'))
}

/**
 * 渲染互动风险段（§4.1）。
 *
 * @param risk `assessInteractionRisk` 的结果；`undefined` = 这一轮没算（不渲染）
 * @returns 空串 = 低风险（没有建议可说）
 */
export function renderRisk(risk: InteractionRisk | undefined): string {
  if (risk === undefined) return ''
  const advice = riskAdvice(risk)
  if (advice === null) return ''
  const facts: string[] = [advice]
  // 三个布尔事实单独摆一行：模型能据此自己判断，而不是只能吃"高风险"这个标签。
  const flags: string[] = []
  if (risk.alreadyAnswered) flags.push('已经有人给过实质回答')
  if (risk.semanticDuplicate) flags.push('已经出现两个人说几乎同一句')
  if (risk.newInformation) flags.push('这一批还有新信息')
  if (flags.length > 0) facts.push('- 已知事实：' + flags.join('；') + '。')
  return clip(facts.join('\n'))
}

function clip(text: string): string {
  const chars = [...text]
  return chars.length <= ECOLOGY_MAX_CHARS ? text : chars.slice(0, ECOLOGY_MAX_CHARS).join('') + '…'
}
