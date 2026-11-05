/** 百度翻译免 key 朗读后端（HTTP 回退之一，中文语境优先）。 */

import { HTTP_UA, httpGet, readAudio, voiceLang, type HttpOptions } from './common.js'

/** 百度 gettts 默认语速（1-15，5 ≈ 常速）。 */
const BAIDU_DEFAULT_SPD = 5
/** 百度 gettts 的 spd 只接受 1-15，钳一下防止 rate 给个离谱值。 */
const BAIDU_MIN_SPD = 1
const BAIDU_MAX_SPD = 15

const BAIDU_TTS_URL = 'https://fanyi.baidu.com/gettts'

/** '+20%' / '-10%' → 20 / -10；解析不出返回 null。 */
function ratePercent(rate: string): number | null {
  const match = /([+-]?\d+(?:\.\d+)?)\s*%/.exec(rate.trim())
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/** 语速换算：spd = clamp(5 + round(百分比/10), 1, 15)；rate 解析不出就用 5。 */
function baiduSpeed(rate: string): number {
  const percent = ratePercent(rate)
  if (percent === null) return BAIDU_DEFAULT_SPD
  const spd = BAIDU_DEFAULT_SPD + Math.round(percent / 10)
  return Math.min(BAIDU_MAX_SPD, Math.max(BAIDU_MIN_SPD, spd))
}

/**
 * 百度翻译的免 key 朗读接口（实测 200 / audio/mpeg）。
 * 需要浏览器 UA + Referer，否则被挡；长文本也能一次念完。
 */
export async function baiduSynthesize(opts: HttpOptions): Promise<Buffer> {
  const url = new URL(BAIDU_TTS_URL)
  url.search = new URLSearchParams({
    lan: voiceLang(opts.voice).baidu,
    text: opts.text,
    spd: String(baiduSpeed(opts.rate)),
    source: 'web',
  }).toString()
  opts.log(`tts 回退百度：lang=${url.searchParams.get('lan')} spd=${url.searchParams.get('spd')} ${opts.text.length} 字`)
  const response = await httpGet(url, {
    'User-Agent': HTTP_UA,
    Referer: 'https://fanyi.baidu.com/',
    Accept: '*/*',
  }, '百度')
  return readAudio(response, '百度')
}
