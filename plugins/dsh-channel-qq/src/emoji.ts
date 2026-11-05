/** Sticker (emoji) store: steal images from the primary group, auto-attach on replies.
 *
 * Deliberately a lite port: the OpenClaw extension's VLM intensity scoring is
 * not carried over; stealing is keyword-free and sending is probability-based.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { resolveDshHome } from './paths.js'
import { napcatFileArg } from './local-file.js'
import { randomUUID } from 'node:crypto'
import type { EmojiConfig } from './config.js'
import type { QQApi } from './ports/platform.js'
import type { OneBotMessageSegment } from './types.js'
import type { HttpClient } from './ports/http.js'
import { systemHttp } from './adapters/http/client.js'
import type { OneBotEvent } from './types.js'
import { parseInbound } from './core/message/parse.js'
import type { EmojiLibrary, EmojiIndexEntry } from './emoji-library.js'
import { atomicWriteFile } from './adapters/fs-store/atomic.js'

/** 偷一张表情包的体积上限。 */
const MAX_STICKER_BYTES = 8 * 1024 * 1024

/**
 * 按字节魔数判真实图片格式（COMPANION-QQ-PATCH-10）。
 *
 * 只认宿主读图能识别的四种格式（PNG / JPEG / GIF / WebP）外加 BMP；认不出返回 `null`，
 * 调用方保留 URL 后缀当兜底。QQ 的表情图常常是 WebP 或 GIF 但 URL 没有后缀，靠扩展名
 * 猜必然错——错一次就会在之后 `read_image` 时报 “extension declares …, but the bytes
 * use a different image format”。
 */
export function sniffImageExtension(buf: Uint8Array): string | null {
  if (buf.length < 12) return null
  const at = (i: number): number => buf[i] as number
  const ascii = (start: number, end: number): string => String.fromCharCode(...buf.slice(start, end))
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return '.png'
  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return '.jpg'
  // GIF87a / GIF89a
  if (ascii(0, 3) === 'GIF') return '.gif'
  // RIFF....WEBP
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp'
  // BMP: BM
  if (at(0) === 0x42 && at(1) === 0x4d) return '.bmp'
  return null
}

export class EmojiStore {
  constructor(
    private readonly config: EmojiConfig,
    private readonly api: QQApi,
    private readonly log: (line: string) => void,
    private readonly library?: EmojiLibrary,
    private readonly http: HttpClient = systemHttp,
  ) {}

  /**
   * Sticker directories, resolved from config on every access.
   *
   * Getters rather than constructor fields so `emoji.dir` / `emoji.registeredDir`
   * are editable live in the admin panel — a cached path would keep stealing
   * into the old directory until the plugin restarted.
   */
  private get dir(): string {
    return this.config.dir ?? path.join(resolveDshHome(), 'channel-qq', 'emoji')
  }

  private get registeredDir(): string {
    return this.config.registeredDir ?? path.join(this.dir, '..', 'emoji-registered')
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.mkdir(this.registeredDir, { recursive: true })
  }

  /** Steal the first image of a primary-group message into the raw sticker dir. */
  async steal(event: OneBotEvent): Promise<EmojiIndexEntry | null> {
    const parsed = parseInbound(event)
    const url = parsed.imageUrls[0]
    if (url === undefined) return null
    try {
      // The directory may be brand new (the panel can repoint `emoji.dir`).
      await fs.mkdir(this.dir, { recursive: true })
      const ext = path.extname(new URL(url).pathname).replace(/[^.\w]/g, '') || '.png'
      const stem = `stolen_${Date.now()}_${randomUUID().slice(0, 8)}`
      // 消息里的图片地址 = 别人给的地址，必须过闸门。
      const res = await this.http.request(url, { limit: MAX_STICKER_BYTES })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(res.bytes)
      // 本地补丁 COMPANION-QQ-PATCH-10：**用字节判真实格式**，别信 URL 后缀。
      // 2026-11-01 事故：QQ 的动图表情 URL 没有可用后缀（或后缀与内容不符），于是 GIF 被
      // 存成 `stolen_*.png`，之后按扩展名读图就报 “the .png extension declares image/png,
      // but the bytes use a different image format”。字节认得出就用字节的格式。
      const realExt = sniffImageExtension(buf)
      const target = path.join(this.dir, `${stem}${realExt ?? ext}`)
      await atomicWriteFile(target, buf)
      this.log(`stole sticker → ${path.basename(target)}`)
      if (this.library !== undefined) {
        const entry = await this.library.addFile(target, 'stolen')
        if (entry === null) {
          this.log('duplicate sticker (md5 known), not indexed again')
          return null
        }
        return entry
      }
      return null
    } catch (error) {
      this.log(`sticker steal failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

}
