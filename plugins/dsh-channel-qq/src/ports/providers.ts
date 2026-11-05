/** 能力提供者：语音合成、语音识别、生图、音乐、链接解析、视觉标注。
 *
 * 为什么把它们的**接口**单独立在这里（04 §2）：
 * 这六件事各自都有一个"外部世界"在背后——TTS 服务、whisper 接口、生图接口、
 * 网易云/酷狗、目标网页、视觉模型——而那个外部世界**会换**（B站接口说变就变、
 * 机房 IP 连不上 edge 的 WebSocket）。接口留在这里，`features/` 只认识接口，
 * 换实现时不必碰工具面。
 *
 * 实现见 `adapters/providers/`。这些接口刻意写得**窄**：只声明本项目真正调用的
 * 那几个方法，外部服务加了新能力也不需要知道。
 *
 * 只有类型，没有实现。
 */

/** 合成一段语音。 */
export interface SpeechSynth {
  synthesize(input: { text: string; voice: string; rate: string; pitch: string; volume: string }):
  Promise<{ bytes: Uint8Array; format: string }>
}

/** 把一条语音转成文字。 */
export interface SpeechRecog {
  transcribe(messageId: number): Promise<string | null>
}

/** 按提示词生成一张图。 */
export interface ImageGen {
  generate(prompt: string): Promise<{ bytes: Uint8Array; mediaType: string }>
}

/** 一首歌的解析结果（点歌链路统一成这个形状，两个平台各自实现）。 */
export interface MusicHit {
  readonly id: string
  readonly title: string
  readonly artist: string
  readonly cover: string | null
}

export interface MusicProvider {
  readonly platform: string
  search(keyword: string, limit?: number): Promise<MusicHit[]>
  resolve(id: string): Promise<MusicHit & { url: string | null }>
}

/** 一条链接解析出来的卡片。 */
export interface LinkCard {
  readonly kind: string
  readonly title: string
  readonly desc: string
  readonly cover: string | null
  readonly url: string
}

export interface LinkResolver {
  resolve(url: string): Promise<LinkCard>
}

/** 给一张图打语义标签（表情包库靠它让模型能按情绪搜到图）。 */
export interface VisionTagger {
  tag(input: { bytes: Uint8Array; mediaType: string }): Promise<{ desc: string; tags: string[] }>
}
