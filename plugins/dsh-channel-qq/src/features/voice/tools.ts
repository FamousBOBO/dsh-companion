/** 语音：4 个工具。
 *
 * 发语音条（TTS 产物）与 AI 语音。
 *
 * 这些 spec **逐字节**来自原来的 `registerQQTools`——P4 的判据是工具名与
 * 参数 schema 一条都不许变（`test/golden/tools/qq-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在 1200 行里找它的边界。
 */

import { napcatFileArg, localPathOf } from '../../local-file.js'
import type { OneBotMessageSegment } from '../../types.js'
import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQToolDeps } from '../tool-deps.js'

/** `qq_send_voice` — 把一段本地音频文件当语音条发出去（mp3/wav等常规格式均可，NapCat 自动转 silk）。想用自定义音色就先用外… */
function qqSendVoice(deps: QQToolDeps): ToolSpec {
  const { api, out } = deps
  return {
        name: 'qq_send_voice',
        description: '把一段本地音频文件当语音条发出去（mp3/wav等常规格式均可，NapCat 自动转 silk）。想用自定义音色就先用外部 TTS 生成音频文件再发。',
        parameters: {
          type: 'object',
          properties: {
            isGroup: { type: 'boolean' },
            target: { type: 'number', description: '群号或对方QQ号' },
            file: { type: 'string', description: '本地音频文件绝对路径（mp3/wav/silk等）' },
          },
          required: ['isGroup', 'target', 'file'],
        },
        run: async (args) => {
          const message: OneBotMessageSegment[] = [{ type: 'record', data: { file: await napcatFileArg(String(args.file)) } }]
          return args.isGroup === true
            ? await out.push(() => api.sendGroupMessage(Number(args.target), message))
            : await out.push(() => api.sendPrivateMessage(Number(args.target), message))
        },
      }
}

/** `qq_can_send_voice` — 检测当前 QQ 实例是否具备发语音条的能力。… */
function qqCanSendVoice(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_can_send_voice',
        description: '检测当前 QQ 实例是否具备发语音条的能力。',
        parameters: { type: 'object', properties: {} },
        run: async () => api.canSendRecord(),
      }
}

/** `qq_send_ai_voice` — QQ自带AI语音（百变变声器）：选一个音色把文字念成语音条发到群里。character 是QQ音色ID（如 ai_cha… */
function qqSendAiVoice(deps: QQToolDeps): ToolSpec {
  const { api, out } = deps
  return {
        name: 'qq_send_ai_voice',
        description: 'QQ自带AI语音（百变变声器）：选一个音色把文字念成语音条发到群里。character 是QQ音色ID（如 ai_char_1 这类，不存在的会报错，换一个试）。仅限群聊。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            character: { type: 'string', description: 'QQ音色ID，如 ai_char_1' },
            text: { type: 'string', description: '要念的文字，别太长' },
          },
          required: ['groupId', 'character', 'text'],
        },
        run: async (args) => out.push(() => api.sendGroupAiRecord(Number(args.groupId), String(args.character), String(args.text ?? ''))),
      }
}

/** `qq_get_ai_voice_url` — 获取QQ AI语音的音频URL（不发出去）。配合下载后可用 qq_send_voice 当语音条发到任意会话——这是私聊… */
function qqGetAiVoiceUrl(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_get_ai_voice_url',
        description: '获取QQ AI语音的音频URL（不发出去）。配合下载后可用 qq_send_voice 当语音条发到任意会话——这是私聊用AI音色的办法。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number', description: 'AI语音按群开通，传群号' },
            character: { type: 'string', description: 'QQ音色ID' },
            text: { type: 'string' },
          },
          required: ['groupId', 'character', 'text'],
        },
        run: async (args) => api.getAiRecord(Number(args.groupId), String(args.character), String(args.text ?? '')),
      }
}

/** 组装这一组工具。 */
export function voiceTools(deps: QQToolDeps): ToolSpec[] {
  return [
    qqSendVoice(deps),
    qqCanSendVoice(deps),
    qqSendAiVoice(deps),
    qqGetAiVoiceUrl(deps),
  ]
}
