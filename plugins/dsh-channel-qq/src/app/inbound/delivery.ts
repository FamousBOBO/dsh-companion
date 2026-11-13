/** 两条"立刻投递"的路径：私聊直投 / 注入模式。
 *
 * 流水线只剩"判定 + 攒批"，这两条各自是一个完整动作（去重缓冲、图片封顶、错误只记日志），
 * 搬出来是为了让 `pipeline.ts` 保持在单文件上限以内（`check:size`），行为与搬出前一致。
 *
 * 共同的边界：**没东西可发就什么都不做**（不提交空回合）；投递异常只记一行日志，
 * 绝不把入站循环打断。
 */

import { userOrigin } from './origin.js'
import type { Materials } from './materials.js'
import type { DmBuffer } from './dm-buffer.js'
import type { PacketComposer } from './packet-composer.js'
import type { OneBotEvent } from '../../types.js'
import type { ParsedInbound } from '../../core/message/parse.js'
import type { ConversationRecord as Conversation, ConversationRegistry } from '../conversation/registry.js'
import type { PromptComposer } from '../conversation/prompt-composer.js'
import type { TurnLauncher } from '../conversation/turns.js'

export interface DmDeliveryDeps {
  readonly registry: ConversationRegistry
  readonly turns: TurnLauncher
  readonly packets: PacketComposer
  readonly dmBuffer: DmBuffer
  readonly config: () => { readonly batching: { readonly dmEnabled?: boolean } }
}

/** 私聊：去重，按配置缓冲；不参与群聊的概率判定。 */
export async function deliverDm(
  deps: DmDeliveryDeps,
  key: string,
  event: OneBotEvent,
  parsed: ParsedInbound,
  line: string | null,
  materials: Materials,
): Promise<void> {
  if (line === null && materials.imageRefs.length === 0 && materials.receivedFiles.length === 0) return
  const conversation = await deps.registry.ensure(key, event)
  if (!deps.dmBuffer.accept(conversation, event)) return
  if (deps.config().batching.dmEnabled) {
    deps.dmBuffer.enqueue(conversation, line, materials.imageRefs, parsed.plainText.length)
    // 语音条不走合并窗口：转写出来已经是一句完整的话，再等 1.5–6 秒没有意义。
    // 队列里先前攒的文字会被**一起**发出去，不会拆成两轮。
    if (materials.voiceText !== null && materials.voiceText !== '') {
      await deps.dmBuffer.flushNow(conversation)
    }
    return
  }
  // 召回交给组包器（它才知道 memory.v2 与房间）；这里只给素材。
  const packet = await deps.packets.composeDm(conversation, { line, hasImages: materials.imageRefs.length > 0 })
  deps.turns.submit(conversation, packet, materials.imageRefs, userOrigin(event))
}

export interface InjectDeliveryDeps {
  readonly registry: ConversationRegistry
  readonly turns: TurnLauncher
  readonly packets: PacketComposer
  readonly prompts: PromptComposer
  readonly config: () => { readonly imageRecognition: { readonly maxPerMessage: number } }
  readonly log: (line: string) => void
}

/** 注入模式：这条消息立刻进 agent 上下文，不走攒批也不看概率。 */
export async function deliverInject(
  deps: InjectDeliveryDeps,
  conversation: Conversation,
  event: OneBotEvent,
  line: string | null,
  imageRefs: readonly unknown[],
  called: boolean,
  background = '',
): Promise<void> {
  if (line === null && imageRefs.length === 0) return
  // 历史里每一张附件都会在**每个后续请求**里重放，而 provider 对每请求的图片数
  // 有上限（当前池子约 16 张）。所以只在直接被叫到时带图（且不在跑回合时），
  // 平时群聊里的图靠 `[图片含义]` 文本摘要。
  const deliverImages = (called && !conversation.tracker.running())
    ? imageRefs.slice(0, Math.max(1, deps.config().imageRecognition.maxPerMessage))
    : []
  const parts: string[] = []
  // 注入模式没有独立信封：背景并进正文，但仍排在当前消息**之前**并单独成段。
  if (background !== '') parts.push(background)
  if (line !== null) parts.push(line)
  if (deliverImages.length > 0) parts.push(deps.prompts.imageNote())
  if (parts.length === 0) return
  const prompt = deps.packets.composeInject(conversation, { called, body: parts.join('\n') })
  try {
    if (conversation.session === null) await deps.registry.ensure(conversation.key, event)
    deps.turns.submit(conversation, prompt, deliverImages, userOrigin(event))
  } catch (error) {
    deps.log(`inject deliver failed: ${String(error)}`)
  }
}
