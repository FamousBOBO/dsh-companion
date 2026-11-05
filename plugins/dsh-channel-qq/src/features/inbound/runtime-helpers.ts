/** 入站运行时的两个小适配（从 index.ts 搬出：那里有 400 行硬上限）。
 *
 * 都是"把宿主/子插件的形状收敛成运行时依赖"的胶水，不参与任何判定。
 */

import { transcribeVoiceMessage } from '../../adapters/providers/stt.js'
import type { QQChannelConfig } from '../../config.js'
import type { TurnHooks } from '../../ports/turn-hooks.js'
import { parseInbound } from '../../core/message/parse.js'
import type { PlatformParts, SubHost } from '../plugin-kit.js'

/** 语音转写：适配器返回 `[text] | null`，这里只取第一条（失败 = null）。 */
export async function transcribeOne(
  api: PlatformParts['api'],
  stt: QQChannelConfig['stt'],
  messageId: number,
  log: (line: string) => void,
): Promise<string | null> {
  // 本地 STT：没配/失败都不抛穿——开了兜底就换协议端，没开就返回 null（原行为）。
  let local: string | null = null
  try {
    const result = await transcribeVoiceMessage(api, stt, messageId, log)
    local = result === null ? null : result[0]
  } catch (error) {
    if (stt.serverFallback !== true) throw error
    log(`voice ${messageId}: 本地 STT 失败，改用协议端：${error instanceof Error ? error.message : String(error)}`)
  }
  if (local !== null) return local
  if (stt.serverFallback !== true) return null
  try {
    const remote = await api.getVoiceText(messageId)
    const text = typeof remote.text === 'string' ? remote.text.trim() : ''
    if (text !== '') log(`voice ${messageId}: 协议端转写 ${text.slice(0, 40)}`)
    return text === '' ? null : text
  } catch (error) {
    log(`voice ${messageId}: 协议端转写失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** 回合钩子：惰性取 interaction / metrics（它们可能比 inbound 晚挂载）。 */
export function turnHooksOf(host: SubHost): TurnHooks {
  /** 即时抽取（P0）：begin 记本回合消息、end 带外沉淀；memory 插件没挂时是 undefined。 */
  const capture = () => host.get('memoryCapture') as
    | { begin(room: string, turn: { text: string; speakerId?: number; speakerName?: string }): void; end(room: string): void }
    | undefined
  return {
    begin: (room, event) => {
      host.get('interaction')?.begin(room, event)
      host.get('metrics')?.begin(room)
      host.get('reliability')?.begin(room)
      const c = capture()
      if (c !== undefined) {
        const parsed = parseInbound(event)
        c.begin(room, {
          text: parsed.text,
          speakerId: event.user_id,
          speakerName: event.sender?.card ?? event.sender?.nickname,
        })
      }
    },
    end: (room) => {
      host.get('interaction')?.end(room)
      host.get('metrics')?.end(room)
      host.get('reliability')?.end(room)
      capture()?.end(room)
    },
    // 出错先撤提示；指标只标记失败（样本在 end 落），可靠性按 retry/permanent 分流。
    error: (room, kind) => {
      host.get('interaction')?.end(room)
      host.get('metrics')?.error(room)
      host.get('reliability')?.error(room, kind)
    },
  }
}
