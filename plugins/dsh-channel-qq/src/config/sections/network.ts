/** 网络段：链接卡片 / 生图（page: links）。
 *
 * 这两段的消费方都是"每次调用现取 config"（观察者与工具都在调用点读），
 * 所以全部标 `live`；密钥字段另加 `secret`（快照与日志掩码）。
 */

import { b, e, list, n, s, type FieldGroup } from '../dsl.js'

export const NETWORK_GROUPS: FieldGroup[] = [
  {
    id: 'linkResolve',
    label: '链接卡片',
    page: 'links',
    fields: {
      enabled: b('启用', true, { hot: 'live' }),
      autoGroups: list('自动出卡的群', [], {
        help: '留空 = 只在被工具调用时才出卡。', hot: 'live', itemsKind: 'number',
      }),
      maxPerMessage: n('每条消息最多几张', 2, { min: 0, max: 5, hot: 'live' }),
      bilibiliCookie: s('B站 SESSDATA', null, {
        help: '填了能提高限流额度、拿到高清封面。', secret: true, hot: 'live', advanced: true,
      }),
    },
  },
  {
    id: 'imageGen',
    label: '生图',
    page: 'links',
    fields: {
      enabled: b('启用', true, { hot: 'live' }),
      provider: e('后端', 'pollinations', [
        ['pollinations', 'pollinations（免 key）'],
        ['openai', 'OpenAI 兼容接口'],
      ], { hot: 'live' }),
      baseUrl: s('接口地址', null, { help: 'provider=openai 时必填；可以指向本机的生图服务。', hot: 'live' }),
      apiKey: s('接口密钥', null, { secret: true, hot: 'live', advanced: true }),
      model: s('模型', 'flux', { hot: 'live' }),
      width: n('宽', 1024, { min: 64, max: 4096, hot: 'live' }),
      height: n('高', 1024, { min: 64, max: 4096, hot: 'live' }),
    },
  },
]
