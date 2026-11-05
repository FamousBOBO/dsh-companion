/** 音乐段：酷狗自建 API 的地址（page: music）。
 *
 * 曲库凭据（网易云/酷狗 Cookie）**不进配置**——它们存在 `/etc/dsh/secrets/`，
 * 由后台「音乐」页的扫码登录写入、更新与清除。这里只放"连哪里"这种非秘密参数。
 */

import { b, s, type FieldGroup } from '../dsl.js'

/** 音乐相关的非秘密配置。 */
export interface MusicConfig {
  /** 酷狗自建 API（KuGouMusicApi）的基地址；空 = 读 `KUGOU_API_BASE`，再回退 127.0.0.1:4000。 */
  kugouApiBase: string
  /**
   * 落雪（LX Music）音源：JSON 数组，`[{name,url,quality?,enabled?}]` 或 URL 字符串。
   * 音源是远程 JS，**必须管理员显式配置**；运行在受限 vm 里（见 lx-source/runtime）。
   */
  lxSources: string
  /** 点歌默认音质（给音源与网易云直链用）。 */
  quality: string
  /**
   * 点歌是否发音频文件。
   *
   * 默认 **false**（发语音条）：语音条在群里点开就能听，最接近"点歌"的体验；
   * 但 QQ 对长语音有客户端限制，四分钟以上的歌可能播不完整——所以留一个开关，
   * 需要完整音质/时长时在后台打开，改发 `.mp3` 文件。
   */
  sendFile: boolean
}

export const MUSIC_GROUPS: FieldGroup[] = [
  {
    id: 'music',
    label: '音乐',
    page: 'music',
    fields: {
      // 读法：适配器每次调用现取（hot: live），所以改完不用重启。
      kugouApiBase: s('酷狗 API 地址', 'http://127.0.0.1:4000', {
        hot: 'live',
        help: '自建 KuGouMusicApi 服务的基地址（默认本机 4000）。留空则读环境变量 KUGOU_API_BASE。'
          + '网易云不需要本项——它直连 music.163.com。',
      }),
      lxSources: s('落雪音源（JSON）', '', {
        hot: 'live',
        help: 'JSON 数组：[{"name":"ikun","url":"https://…/script/lxmusic?key=…"}]，也可直接写 URL 字符串。'
          + '音源是远程 JS，只填你信任的地址；留空 = 只用网易云直链。',
      }),
      quality: s('点歌音质', '320k', {
        hot: 'live',
        help: '128k / 320k / flac。音源不支持时会自己降级或报错，失败就换下一个音源。',
      }),
      sendFile: b('点歌发文件', false, {
        hot: 'live',
        help: '关（默认）= 点歌发语音条；开 = 发音频文件。长歌（四分钟以上）的语音条'
          + '可能被 QQ 客户端截断，需要完整时长就打开这项。',
      }),
    },
  },
]
