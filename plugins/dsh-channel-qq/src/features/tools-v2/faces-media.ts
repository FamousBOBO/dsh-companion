/** 合并面（二）：表情包 / 语音 / 音乐。
 *
 * qq_music 是唯一需要参数翻译的一张脸：`provider` 选平台、`playlist` 的子动作用
 * `op`（避免与判别字段 action 撞名）、登录动作把 action 翻译回旧 shape。
 * 其余分支的字段名与旧 spec 逐字一致。
 */

import type { Face } from './types.js'

export const STICKER_FACE: Face = {
  name: 'qq_sticker',
  description: '表情包：搜索收藏库（search）、列出全部（list）、按文件名直接发（send）、按情绪一步到位发（send_by_mood）、库统计（stats）、给本地图配上下两行字做成表情包（make，只生成文件）、现做现发（send_made）、给已收藏的表情配一句话再发（caption）。拿不准氛围就先 search 看清楚再决定。',
  branches: [
    { action: 'search', legacy: 'qq_search_emojis', required: ['query'], optional: ['limit'] },
    { action: 'list', legacy: 'qq_list_emojis', required: [] },
    { action: 'send', legacy: 'qq_send_emoji', required: ['isGroup', 'target', 'file'] },
    { action: 'send_by_mood', legacy: 'qq_send_sticker', required: ['query', 'isGroup', 'target'], optional: ['fallbackRandom'] },
    { action: 'stats', legacy: 'qq_emoji_stats', required: [] },
    { action: 'make', legacy: 'qq_make_meme', required: ['image'], optional: ['top', 'bottom'] },
    { action: 'send_made', legacy: 'qq_send_meme', required: ['image', 'isGroup', 'target'], optional: ['top', 'bottom'] },
    { action: 'caption', legacy: 'qq_emoji_sticker_text', required: ['file', 'text'], optional: ['isGroup', 'target'] },
  ],
}

export const VOICE_FACE: Face = {
  name: 'qq_voice',
  description: '语音：把文字念成语音条发出去（tts_send）、只生成音频文件（tts_save）、列可用音色（voices）、QQ 自带 AI 音色的发送（ai_send，仅群聊）与只取音频 URL（ai_url）、探测实例能否发语音（can_send）、把本地音频当语音条发（send_file）。想用语音说话走 tts_send 或 send_file。',
  branches: [
    { action: 'tts_send', legacy: 'qq_tts_voice', required: ['text', 'isGroup', 'target'], optional: ['voice', 'rate', 'pitch', 'volume'] },
    { action: 'tts_save', legacy: 'qq_tts_save', required: ['text'], optional: ['voice', 'rate', 'pitch', 'volume'] },
    { action: 'voices', legacy: 'qq_list_voices', required: [] },
    { action: 'ai_send', legacy: 'qq_send_ai_voice', required: ['groupId', 'character', 'text'] },
    { action: 'ai_url', legacy: 'qq_get_ai_voice_url', required: ['groupId', 'character', 'text'] },
    { action: 'can_send', legacy: 'qq_can_send_voice', required: [] },
    { action: 'send_file', legacy: 'qq_send_voice', required: ['isGroup', 'target', 'file'] },
  ],
}

/** 登录动作的翻译：新面只要 key（poll 时），旧 spec 需要 action。 */
function loginTranslate(action: 'start' | 'poll'): (args: Readonly<Record<string, unknown>>) => Record<string, unknown> {
  return (args) => (action === 'start' ? { action: 'start' } : { action: 'poll', key: args.key })
}

/** 歌单的翻译：子动作 op → 旧 spec 的 action（旧字段名就叫 action，会与判别字段撞名）。 */
function playlistTranslate(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { action: args.op, songId: args.songId, name: args.name, artists: args.artists }
}

export const MUSIC_FACE: Face = {
  name: 'qq_music',
  description: '音乐：搜索（search）、解析播放直链（resolve）、点歌（send_card，默认发语音条，后台「点歌发文件」打开后发音频文件）、以语音条发歌（send_voice）、歌词（lyrics）、个人歌单（playlist）、扫码登录（login_start / login_poll）、登录状态（status）。',
  providerSelect: true,
  note: 'provider 默认 netease（网易云）；酷狗（kugou）只有 search / send_voice / login_start / login_poll，其余动作传 kugou 会报错。歌单 playlist 的子动作用 op：add / remove / list / clear，add 需要 songId 和 name。',
  branches: [
    { action: 'search', legacy: 'qq_search_music', provider: 'netease', required: ['keyword'], optional: ['limit'] },
    { action: 'search', legacy: 'qq_kugou_search', provider: 'kugou', required: ['keyword'], optional: ['limit'] },
    { action: 'resolve', legacy: 'qq_resolve_music', provider: 'netease', required: ['songId'], optional: ['name', 'artists'] },
    { action: 'send_card', legacy: 'qq_send_music_card', provider: 'netease', required: ['target', 'songId'], optional: ['name', 'artists', 'private'] },
    { action: 'send_voice', legacy: 'qq_send_music_voice', provider: 'netease', required: ['target', 'songId'], optional: ['name', 'artists', 'private'] },
    { action: 'send_voice', legacy: 'qq_kugou_send', provider: 'kugou', required: ['target', 'hash'], optional: ['quality', 'private'] },
    { action: 'lyrics', legacy: 'qq_music_lyrics', provider: 'netease', required: ['songId'] },
    { action: 'playlist', legacy: 'qq_music_playlist', provider: 'any', required: ['op'], optional: ['songId', 'name', 'artists'], translate: playlistTranslate },
    { action: 'login_start', legacy: 'qq_netease_login', provider: 'netease', required: [], translate: loginTranslate('start') },
    { action: 'login_poll', legacy: 'qq_netease_login', provider: 'netease', required: ['key'], translate: loginTranslate('poll') },
    { action: 'login_start', legacy: 'qq_kugou_login', provider: 'kugou', required: [], translate: loginTranslate('start') },
    { action: 'login_poll', legacy: 'qq_kugou_login', provider: 'kugou', required: ['key'], translate: loginTranslate('poll') },
    { action: 'status', legacy: 'qq_netease_status', provider: 'netease', required: [] },
  ],
}

export const MEDIA_FACES: readonly Face[] = [STICKER_FACE, VOICE_FACE, MUSIC_FACE]
