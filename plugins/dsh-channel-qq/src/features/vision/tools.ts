/** 图片文字识别（B5）：服务端 OCR。
 *
 * 只在 `imageRecognition.serverOcr` 打开时注册——默认关，工具面与旧版逐字节一致。
 * 用途：视觉模型读不清的截图/海报、或模型本身不支持图片时，把字读出来。
 */

import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { OneBotMessage } from '../../types.js'
import type { QQToolDeps } from '../tool-deps.js'

/** 从一条消息里找第一张图片的 file/url（数组段或 CQ 字符串两种历史形状都认）。 */
function firstImage(message: OneBotMessage | undefined): string {
  if (typeof message === 'string') {
    const match = /\[CQ:image,[^\]]*?(?:file|url)=([^,\]]+)/.exec(message)
    return match?.[1] === undefined ? '' : match[1]
  }
  const image = (message ?? []).find((segment) => segment.type === 'image')
  const file = image?.data?.file
  const url = image?.data?.url
  if (typeof file === 'string' && file !== '') return file
  if (typeof url === 'string' && url !== '') return url
  return ''
}

export function visionTools(deps: QQToolDeps): ToolSpec[] {
  return [
    {
      name: 'qq_read_image_text',
      description: '识别图片里的文字（服务端 OCR）。messageId 用上下文包里的 #编号；也可以直接给 file（图片缓存 id 或 URL）。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'number', description: '含图片的消息 #编号' },
          file: { type: 'string', description: '图片缓存 id 或 http(s) URL（与 messageId 二选一）' },
        },
        required: [],
      },
      run: async (args) => {
        let image = typeof args.file === 'string' ? args.file.trim() : ''
        if (image === '' && typeof args.messageId === 'number') {
          const message = await deps.api.getMessage(args.messageId)
          image = firstImage(message.message)
        }
        if (image === '') throw new Error('需要 messageId（那条消息里要有图片）或 file（图片 id / URL）。')
        const result = await deps.api.ocrImage(image)
        const texts = (result.texts ?? [])
          .map((item) => (typeof item.text === 'string' ? item.text.trim() : ''))
          .filter((text) => text !== '')
        return { count: texts.length, language: result.language ?? null, texts }
      },
    },
  ]
}
