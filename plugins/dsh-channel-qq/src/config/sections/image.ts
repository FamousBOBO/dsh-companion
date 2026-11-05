/** 看图段（含服务端 OCR 开关）。类型与字段分开放：`config.ts` 有 400 行硬上限。 */

import { b, n, type FieldGroup } from '../dsl.js'

export interface ImageConfig {
  /** Download inbound images and attach them to the model prompt (vision). */
  enabled: boolean
  /** Register the server-side OCR tool (`qq_read_image_text`). */
  serverOcr: boolean
  /** Max images attached per message (extras stay noted as [图片]). */
  maxPerMessage: number
}

export const IMAGE_GROUPS: FieldGroup[] = [
  {
    id: 'imageRecognition',
    label: '看图',
    page: 'media',
    help: '把群友发的图片下载下来附进提示词（视觉）。',
    fields: {
      enabled: b('启用', true, { hot: 'live' }),
      serverOcr: b('注册图片 OCR 工具', false, {
        hot: 'reload',
        help: '默认关。打开后多一个 qq_read_image_text（协议端 OCR），适合截图/海报里的字。',
      }),
      maxPerMessage: n('每条消息最多几张', 2, { min: 0, max: 10, hot: 'live' }),
    },
  },
]
