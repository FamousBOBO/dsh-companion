/** 媒体段：表情包 / 配字 / 语音合成（page: stickers / media）。 */

import { b, e, n, s, type FieldGroup } from '../dsl.js'

export const MEDIA_GROUPS: FieldGroup[] = [
  {
    id: 'emoji',
    label: '表情包',
    page: 'stickers',
    fields: {
      // 读法：偷表情的观察者每事件现取（live）。
      steal: b('偷主群的表情', true, { hot: 'live' }),
      // 本机群聊全关时，主群那条路走不到。打开这个，管理员私聊里发来的表情
      // 也会收进库（同样打标），别人的私聊不落库。
      stealPrivate: b('私聊也偷（仅管理员）', false, { hot: 'live' }),
      // 读法：EmojiLibrary 的目录按调用现算，保存后 applyEffects 触发 reload
      // （索引重读）——这是「保存后自动重载该模块」的那一档。
      dir: s('原图目录', null, { help: '留空 = <dshHome>/channel-qq/emoji。', hot: 'reload' }),
      registeredDir: s('已收录目录', null, { help: '留空 = 原图目录的同级 emoji-registered。', hot: 'reload', advanced: true }),
    },
  },
  {
    id: 'meme',
    label: '表情包制作',
    page: 'stickers',
    fields: {
      // 读法：三个工具都在 run() 里现取 config.meme（live）。
      enabled: b('启用', true, { hot: 'live' }),
      fontFile: s('字体文件', null, { help: '留空自动找系统中文字体。', hot: 'live', advanced: true }),
      dir: s('输出目录', null, { help: '留空 = <工作区>/downloads/memes。', hot: 'live', advanced: true }),
    },
  },
  {
    id: 'tts',
    label: '语音合成',
    page: 'media',
    fields: {
      enabled: b('启用', true, { hot: 'live' }),
      voice: s('音色', 'zh-CN-XiaoxiaoNeural', { help: 'edge-tts 的音色名，见 qq_list_voices。', hot: 'live' }),
      // 读法：registerTtsTools 注册时解析一次（resolveProvider(config)）→ 切换
      // 后端要重启插件才换得动。这里如实标 restart，不谎称立即生效。
      provider: e('后端', 'auto', [
        ['auto', '自动（edge → baidu/google）'],
        ['edge', '只用 edge-tts'],
        ['baidu', '百度'],
        ['google', '谷歌'],
      ], { help: '机房 IP 常常连不上 edge 的 WebSocket，auto 会自己降级。', hot: 'restart' }),
      rate: s('语速', '+0%', { hot: 'live' }),
      pitch: s('音调', '+0Hz', { hot: 'live' }),
      volume: s('音量', '+0%', { hot: 'live' }),
      dir: s('输出目录', null, { help: '留空 = <dshHome>/channel-qq/tts。', hot: 'live', advanced: true }),
    },
  },
]
