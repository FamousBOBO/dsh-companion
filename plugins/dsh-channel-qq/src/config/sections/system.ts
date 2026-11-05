/** 系统段：每日早报 / 管理后台（page: proactive / security）。 */

import { b, n, s, type FieldGroup } from '../dsl.js'

export const SYSTEM_GROUPS: FieldGroup[] = [
  {
    id: 'morningReport',
    label: '每日早报',
    page: 'proactive',
    fields: {
      // 读法：调度器每次触发时现取 config.morningReport（live）。
      // **默认关**：早报是"每天定时往外发一条消息"，属于自动外发；装上插件就
      // 自己开口不是默认行为，打开是操作者的显式决定。
      enabled: b('启用', false, {
        hot: 'live',
        help: '默认关。打开后每天 06:00–11:59 之间向主人私聊发一条早报（由模型写，插件只备素材）。'
          + '定时行为本身还要打开「主动行为」段里的「旧定时行为」总开关。',
      }),
      weatherLocation: s('天气地点', null, { help: 'wttr.in 能认的地点串，例如 Lianjiang,Guangdong；留空不查天气。', hot: 'live' }),
      scheduleFile: s('课表文件', null, { help: '工作区里的相对路径；留空不读课表。', hot: 'live', advanced: true }),
    },
  },
  {
    id: 'admin',
    label: '管理后台',
    page: 'security',
    help: '改端口会就地重新监听，登录态保持。',
    fields: {
      // 读法：applyEffects 里 admin 段变化会 relisten（reload）。
      enabled: b('启用', true, { hot: 'reload' }),
      port: n('端口', 8790, { min: 1, max: 65_535, hot: 'reload' }),
      // 读法：登录时现取（live）；保存改它会撤销全部会话（由 admin.ts 处理）。
      // 口令的权威来源是环境变量（scrypt 哈希），这里只是无环境变量时的兜底。
      password: s('密码', '', {
        help: '权威来源是环境变量 CHANNEL_QQ_ADMIN_PASSWORD_HASH（scrypt 哈希）；这里留空即用兜底链。长度 ≥12。',
        secret: true, hot: 'live',
      }),
      // 读法：只有设了 CHANNEL_QQ_ADMIN_ALLOW_REMOTE=1 才会生效；改它属重启级。
      host: s('监听地址', '127.0.0.1', {
        help: '只有设了 CHANNEL_QQ_ADMIN_ALLOW_REMOTE=1 才会生效。', hot: 'restart',
      }),
    },
  },
]
