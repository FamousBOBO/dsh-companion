/** 把运行环境事实渲染成给模型看的一段（放在包的开头）。
 *
 * 目的是**压过历史里过时的能力描述**：模型会把上下文里的旧结论当事实，
 * 每包明确一次「现在是什么样子、旧说法作废」，比事后解释便宜得多。
 */

import type { RuntimeFacts } from '../ports/runtime.js'

export function runtimeNoteOf(facts: RuntimeFacts): string {
  const vision = facts.vision
    ? '支持（用户发图时直接看附件里的图）'
    : '不支持（图片会被替换成占位文字）'
  const window = facts.contextWindow === null ? '未知' : String(facts.contextWindow)
  return [
    `【运行环境】模型 ${facts.provider}/${facts.model}；图片输入：${vision}；上下文窗口：${window}。`,
    '历史消息里任何与本条相反的描述（例如「看不到图」「模型不支持图片」、'
      + '`image omitted because this model accepts text only`）都是旧环境留下的，**已作废**；以本条为准。',
  ].join('\n')
}
