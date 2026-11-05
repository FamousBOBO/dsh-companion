/** 交互提示段（A1）：回合进行中的「正在输入」与表情回应。
 *
 * 类型与字段放在同一个文件里，理由与 music/skills 相同：`src/config.ts` 是
 * 全仓引用的类型入口，体积有硬上限；新增一段的默认做法是把段连同类型一起放进来，
 * 在 `config.ts` 里只留一个 `import(...)` 引用。
 */

import { b, s, type FieldGroup } from '../dsl.js'

export interface InteractionConfig {
  /** 私聊回合开始/结束时设置「正在输入」。 */
  typingIndicator: boolean
  /** 回合开始时给触发消息贴一个表情，结束时撤掉。 */
  ackReaction: boolean
  /** 表情 id（QQ 表情编号的字符串形式，例如 424）。 */
  ackEmojiId: string
}

export const INTERACTION_GROUPS: FieldGroup[] = [
  {
    id: 'interaction',
    label: '交互提示',
    page: 'messages',
    help: '回合进行中的「正在输入」与表情回应；失败只写日志，不影响回复。',
    fields: {
      // 读法：回合开始/结束时现取（live）。
      typingIndicator: b('私聊显示「正在输入」', false, {
        hot: 'live',
        help: '只对私聊生效（QQ 群聊没有输入状态）。默认关 = 不额外发任何协议动作。',
      }),
      ackReaction: b('收到时贴表情回应', false, {
        hot: 'live',
        help: '只对群聊生效（QQ 私聊不支持表情回应）。回合开始时贴、结束时撤。默认关。',
      }),
      ackEmojiId: s('回应表情 id', '424', {
        hot: 'live',
        help: 'QQ 表情编号的字符串形式；默认 424（思考）。',
        hiddenIf: { field: 'interaction.ackReaction', equals: false },
      }),
    },
  },
]
