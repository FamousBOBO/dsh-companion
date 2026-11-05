/** 谷歌翻译免 key 朗读后端（HTTP 回退之一，非中文语言优先）。 */

import { HTTP_UA, httpGet, readAudio, voiceLang, type HttpOptions } from './common.js'

const GOOGLE_TTS_URL = 'https://translate.google.com/translate_tts'

/** 谷歌翻译的免 key 朗读接口（实测 200 / audio/mpeg）。只需要浏览器 UA。 */
export async function googleSynthesize(opts: HttpOptions): Promise<Buffer> {
  const url = new URL(GOOGLE_TTS_URL)
  url.search = new URLSearchParams({
    ie: 'UTF-8',
    q: opts.text,
    tl: voiceLang(opts.voice).google,
    client: 'tw-ob',
  }).toString()
  opts.log(`tts 回退谷歌：tl=${url.searchParams.get('tl')} ${opts.text.length} 字`)
  const response = await httpGet(url, { 'User-Agent': HTTP_UA, Accept: '*/*' }, '谷歌')
  return readAudio(response, '谷歌')
}
