/** 把 {@link SocialScene} 渲染成**一段话**给模型看（P6-A / §3.1）。
 *
 * 为什么要给模型看结构化的东西，而不是只写一句"别插嘴"：计划 §3.1 的分工是
 * **平台事实由代码提取，语义标签由模型判断**。所以这里只把**已经确定的事实**摆出来
 * （谁回了谁、有没有真实 @、谁问过问题、自己刚说过什么），然后明写"以下推断都可能错"。
 *
 * 三条纪律：
 *   1. **不写结论句**。不出现"别插嘴""该沉默了"——那会把代码的猜测变成命令，
 *      而模型看到的上下文比这段摘要多得多。
 *   2. **判不准就写判不准**。`uncertain` 一律渲染成"看不出来"，不偷偷挑一个。
 *   3. **有字数上限**。这段是上下文，不是资料库；超了先丢最不确定的部分。
 *
 * 纯函数：不读时钟、不读盘（R8）。
 */

import type { SocialScene } from '../../core/group-scene.js'

/** 整段字数上限（与记忆段同一个量级：它只是"帮忙看懂"，不是主角）。 */
export const SCENE_MAX_CHARS = 420

/** 一次渲染能带几条引用边（再多就是复述背景了）。 */
const MAX_EDGES = 6

const DISCUSSION_TEXT: Record<SocialScene['discussionKind'], string> = {
  public: '看起来是公开聊（多个成员在说话，没有明显的定向对象）',
  directed: '看起来是**定向**的（有真实 @ 或引用，且最近几条集中在这些人之间）',
  uncertain: '看不出是公开还是定向（线索不足或互相矛盾）',
}

const ANSWER_TEXT: Record<SocialScene['answerState'], string> = {
  answered: '**可能**已经有人回应了（有人引用了那条问句，或直接回到提问者）',
  open: '看起来还没有明确的回应（后面有人说话，但都没有指向提问者）',
  uncertain: '看不出来有没有被回应',
}

const CONFLICT_TEXT: Record<SocialScene['conflictState'], string> = {
  active: '**可能**在起争执（同一对成员在短时间内互相回击、且带强否定词）',
  none: '没有争执的迹象',
  uncertain: '看不准有没有争执',
}

/** 一条引用边渲染成"消息 A → 消息 B"（只给号，不复述正文：正文在上面的背景里）。 */
function edgeLines(scene: SocialScene): string[] {
  const edges = scene.replyEdges.slice(-MAX_EDGES)
  if (edges.length === 0) return []
  return [
    '引用关系（真实引用段，不是正文猜的）：',
    ...edges.map((edge) => `- 消息 ${String(edge.fromMessageId)} 引用了 消息 ${String(edge.toMessageId)}`),
  ]
}

/**
 * 渲染场景段；返回空串 = 这段不该出现（没有可用事实）。
 *
 * 什么时候会给空：这一批只有一条消息、没有任何引用或 @、也没有可说的参与者关系。
 * 那种情况下多一段"看不出"只会白占上下文，不如省掉。
 *
 * `nameOf` 决定人怎么称呼：给了名字就用名字（"小王"），没给才退回 `QQ 10001`。
 * 为什么优先名字：背景里每条已经写着 `小王 / QQ 10001`，这一段再列一遍号会让同一串数字
 * 在提示词里出现两次，模型有可能把它当成两个不同的人。
 */
export function renderSocialScene(
  scene: SocialScene | null,
  nameOf?: (userId: number) => string,
): string {
  if (scene === null) return ''
  const who = (userId: number): string => {
    const name = nameOf?.(userId)?.trim() ?? ''
    return name === '' ? `QQ ${String(userId)}` : name
  }
  const lines: string[] = []
  try {
    const edges = edgeLines(scene)
    const participants = scene.activeParticipants.length
    const onlyTwo = participants === 2
    // 一条消息、没有引用、没有 @ —— 没有任何"关系"可说，省掉这一段。
    if (edges.length === 0 && participants <= 1 && scene.questionsAskedBy.length === 0) return ''
    lines.push('【这一批的社交结构（代码从平台字段抽出的事实，推断部分标了"可能"）】')
    lines.push(`- 参与者 ${String(participants)} 人：${scene.activeParticipants.map(who).join('、')}`)
    if (onlyTwo) lines.push('- 这一批只有两个人在说话。**两人说话本身不说明是私聊**——也可能是公开对聊。')
    if (scene.directedTo !== undefined) lines.push(`- 最近的定向对象：${who(scene.directedTo)}（真实 @ 或引用指向他）`)
    lines.push(`- 讨论形态：${DISCUSSION_TEXT[scene.discussionKind]}`)
    lines.push(`- 问句状态：${ANSWER_TEXT[scene.answerState]}`)
    if (scene.questionsAskedBy.length > 0) {
      lines.push(`- 这一批提问的人：${scene.questionsAskedBy.map(who).join('、')}（可能不止一个）`)
    }
    if (scene.askedMe) lines.push('- 有人真的 @ 了你，或引用了你说的话。')
    lines.push(`- 争执：${CONFLICT_TEXT[scene.conflictState]}`)
    if (scene.repeatedSelf) {
      lines.push('- 你最近（40 分钟内）说过**内容很接近**的话。要再说就给出新信息，别换个说法复读。')
    }
    lines.push(...edges)
    lines.push('以上都是推断，可能错。真正的判断仍在你自己：拿不准就选 silent。')
  } catch {
    return ''
  }
  const text = lines.join('\n')
  const chars = [...text]
  return chars.length <= SCENE_MAX_CHARS ? text : `${chars.slice(0, SCENE_MAX_CHARS).join('')}…`
}
