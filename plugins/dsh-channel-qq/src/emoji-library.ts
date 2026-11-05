/** Emoji library: dedup-by-md5 sticker store with vision tagging and semantic search.
 *
 * Ideas ported from astrbot_plugin_stealer / meme_manager (analyzed, not copied):
 * - MD5 dedup: the same sticker never enters the index twice.
 * - Vision tagging: stolen images get a one-shot multimodal caption + mood tags
 *   through the harness LLM seam (best-effort, non-blocking).
 * - Semantic search: the agent finds stickers by mood/meaning instead of
 *   browsing a flat directory.
 * - Send cooldown: per-conversation minimum interval between auto-sent
 *   stickers, so a hot room cannot get spammed.
 *
 * Storage layout (under <dshHome>/channel-qq/):
 *   emoji/            raw stolen images (unchanged, shared with EmojiStore)
 *   emoji-registered/ hand-picked sendable stickers (unchanged)
 *   emoji-index.json  the index: md5 -> { file, source, tags, mood, desc, addedAt }
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { resolveDshHome } from './paths.js'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { isPlaceholderTag, tagImage } from './emoji-tagging.js'
import type { EmojiConfig } from './config.js'
import { JsonStore } from './adapters/fs-store/json-store.js'
import { llmSeam } from './adapters/dsh-host/services.js'

export interface EmojiIndexEntry {
  /** Absolute file path. */
  file: string
  /** registered (hand-picked) or stolen. */
  source: 'registered' | 'stolen'
  /** Lowercase hex MD5 of the file bytes. */
  md5: string
  /** Free-text description from the vision model (empty until tagged). */
  desc: string
  /** Mood/usage tags, lowercase, e.g. ["开心","嘲讽","摸鱼"]. */
  tags: string[]
  addedAt: number
}

export interface EmojiSearchHit {
  file: string
  source: string
  desc: string
  tags: string[]
  score: number
}

export class EmojiLibrary {
  private index: Map<string, EmojiIndexEntry> = new Map()
  private dirty = false
  /** md5 of in-flight tagging jobs, prevents double-tagging. */
  private readonly tagging = new Set<string>()

  constructor(
    private readonly config: EmojiConfig,
    private readonly log: (line: string) => void,
  ) {}

  /**
   * Where the index lives, resolved from config on every access.
   *
   * Computed rather than captured in the constructor so that `emoji.dir` is
   * hot-editable in the admin panel: `reload()` then picks the new location up
   * without the plugin restarting.
   */
  private get indexFile(): string {
    const home = resolveDshHome()
    const dir = this.config.dir ?? path.join(home, 'channel-qq', 'emoji')
    return path.join(dir, '..', 'emoji-index.json')
  }

  /**
   * 索引文件的位置**每次访问都重新算**（`emoji.dir` 可以在后台热改），
   * 所以 store 不能是构造期字段——`JsonStore` 本身只是"拿着一个路径"，
   * 每次新建的代价就是几次字段赋值。
   */
  private get store(): JsonStore<unknown> {
    return new JsonStore<unknown>(this.indexFile, { log: this.log })
  }

  /** Re-read the index in place — used when `emoji.dir` changed. */
  async reload(): Promise<string> {
    const before = this.index.size
    this.index = new Map()
    await this.load()
    this.dirty = false
    return `表情索引已改读 ${this.indexFile}（${before} → ${this.index.size} 条）`
  }

  async load(): Promise<void> {
    const raw = await this.store.load(null) as { entries?: EmojiIndexEntry[] } | null
    if (raw === null) {
      this.index = new Map()
      this.log('emoji library: no existing index, starting fresh')
      return
    }
    this.index = new Map((raw.entries ?? []).map((e) => [e.md5, e]))
    // 旧索引里可能混着提示符占位标签（情绪1/标签2），读的时候顺手清掉。
    let cleaned = 0
    for (const entry of this.index.values()) {
      const tags = entry.tags.filter((tag) => !isPlaceholderTag(tag))
      if (tags.length !== entry.tags.length) {
        entry.tags = tags
        cleaned += 1
      }
    }
    if (cleaned > 0) this.dirty = true
    this.log(`emoji library loaded: ${String(this.index.size)} entries`)
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    try {
      await this.store.save({ version: 1, entries: [...this.index.values()] })
      this.dirty = false
    } catch (error) {
      this.log(`emoji index save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private static md5(buf: Buffer): string {
    return createHash('md5').update(buf).digest('hex')
  }

  /**
   * Register a newly stolen/registered image. Returns the index entry, or
   * null when the exact image (by MD5) is already indexed — the caller then
   * does not need to keep the duplicate file.
   */
  async addFile(file: string, source: 'registered' | 'stolen'): Promise<EmojiIndexEntry | null> {
    let buf: Buffer
    try {
      buf = await fs.readFile(file)
    } catch {
      return null
    }
    const md5 = EmojiLibrary.md5(buf)
    const existing = this.index.get(md5)
    if (existing !== undefined) {
      // Prefer keeping the registered copy as canonical.
      if (source === 'registered' && existing.source !== 'registered') {
        existing.source = 'registered'
        existing.file = file
        this.dirty = true
      }
      return null
    }
    const entry: EmojiIndexEntry = { file, source, md5, desc: '', tags: [], addedAt: Date.now() }
    this.index.set(md5, entry)
    this.dirty = true
    return entry
  }

  /** Whether this MD5 is already indexed (duplicate detection before download). */
  hasMd5(md5: string): boolean {
    return this.index.has(md5)
  }

  /**
   * Best-effort vision tagging through the harness LLM seam. Never throws:
   * a failed tagging leaves the entry searchable by filename later.
   */
  async tagEntry(ctx: Context, entry: EmojiIndexEntry, imageData: Buffer, mediaType: string): Promise<void> {
    if (this.tagging.has(entry.md5)) return
    this.tagging.add(entry.md5)
    try {
      // 宿主形状的知识全在 adapters/dsh-host/，这里不再自己转型。
      const seam = llmSeam(ctx)
      const llm = seam.llm
      const selection = seam.agentDefaultModel?.currentSelection()
      const attachments = seam.attachments
      if (llm === undefined || selection === undefined) return
      if (attachments === undefined) {
        this.log('emoji tagging skipped: 宿主没有 attachments 服务（视觉消息发不出去）')
        return
      }
      // 形状、媒体类型、重试都在 `emoji-tagging.ts`（拆出去的那三个坑）。
      const result = await tagImage({
        attachments,
        llm,
        selection,
        data: imageData,
        mediaType,
        name: `emoji-${entry.md5}`,
        log: this.log,
      })
      if (result === null) return
      entry.desc = result.desc
      entry.tags = result.tags
      this.dirty = true
      this.log(`emoji tagged [${entry.tags.join(',')}] ${entry.desc}`)
    } catch (error) {
      this.log(`emoji tagging skipped: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.tagging.delete(entry.md5)
    }
  }

  /**
   * Search the library by free text: scores tag/desc substring hits plus a
   * light synonym expansion so "哈哈" finds "大笑" entries.
   */
  search(query: string, limit = 5): EmojiSearchHit[] {
    const q = query.trim().toLowerCase()
    if (q === '') return []
    const synonyms: Record<string, string[]> = {
      '哈哈': ['大笑', '开心'],
      '笑': ['大笑', '开心'],
      '乐': ['开心'],
      '哭': ['委屈'],
      '气': ['生气'],
      '喷': ['大笑', '嘲讽'],
      '赞': ['点赞'],
      '冲': ['加油'],
      '摸': ['摸鱼'],
      '瓜': ['吃瓜'],
      '怕': ['害怕'],
      '?': ['疑问'],
      '？': ['疑问'],
    }
    const terms = new Set<string>([q])
    for (const [key, list] of Object.entries(synonyms)) {
      if (q.includes(key)) for (const t of list) terms.add(t)
    }
    const hits: EmojiSearchHit[] = []
    for (const entry of this.index.values()) {
      let score = 0
      const haystackDesc = entry.desc.toLowerCase()
      for (const term of terms) {
        if (term === '') continue
        if (entry.tags.some((t) => t.includes(term))) score += 3
        if (haystackDesc.includes(term)) score += 2
      }
      if (score > 0) hits.push({ file: entry.file, source: entry.source, desc: entry.desc, tags: entry.tags, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  /**
   * 全库随机一张（兜底用）。
   *
   * 不能用 `list(200)` 再随机：那只会在"最新 200 张"里挑，库大了等于永远
   * 只发最近收的（2026-10-19 排查）。
   */
  random(): EmojiIndexEntry | undefined {
    const all = [...this.index.values()]
    return all.length === 0 ? undefined : all[Math.floor(Math.random() * all.length)]
  }

  /** All indexed entries (bounded), newest first — the fallback listing. */
  list(limit = 40): EmojiIndexEntry[] {
    return [...this.index.values()].sort((a, b) => b.addedAt - a.addedAt).slice(0, limit)
  }

  /**
   * Drop one entry from the index by MD5.
   *
   * The file on disk is deliberately left in place: the index is a searchable
   * view over a directory the user also browses by hand, and deleting their
   * images from a web panel is not something an operator can undo.
   */
  async remove(md5: string): Promise<boolean> {
    const existed = this.index.delete(md5)
    if (existed) {
      this.dirty = true
      await this.save()
    }
    return existed
  }

  /** Hand-edit an entry's description/tags (admin panel correction). */
  async retag(md5: string, desc: string, tags: string[]): Promise<boolean> {
    const entry = this.index.get(md5)
    if (entry === undefined) return false
    entry.desc = desc.slice(0, 200)
    entry.tags = tags
      .map((t) => String(t).trim().toLowerCase())
      .filter((t) => t !== '')
      .slice(0, 8)
    this.dirty = true
    await this.save()
    return true
  }

  /** Full-library rebuild: index every image file on disk that is missing. */
  async rescan(): Promise<{ added: number; duplicates: number }> {
    const home = resolveDshHome()
    const dir = this.config.dir ?? path.join(home, 'channel-qq', 'emoji')
    const registeredDir = this.config.registeredDir ?? path.join(dir, '..', 'emoji-registered')
    let added = 0
    let duplicates = 0
    for (const [d, source] of [[registeredDir, 'registered'], [dir, 'stolen']] as const) {
      let files: string[] = []
      try {
        files = (await fs.readdir(d)).filter((name) => !name.startsWith('.'))
      } catch { continue }
      for (const name of files) {
        const entry = await this.addFile(path.join(d, name), source)
        if (entry === null) duplicates += 1
        else added += 1
      }
    }
    await this.save()
    return { added, duplicates }
  }

  /**
   * 全部重新打标（后台「重新打标」按钮）。
   *
   * 为什么需要它：2026-10-21 之前视觉消息的形状给错了（`image_url` 而非宿主
   * 的 `{type:'image', attachment}`），模型收到的是"没有图片的图片消息"，于是
   * 库里 60 多条全是「疑问/无语/尴尬」这类兜底标签——检索自然永远搜不到合适的。
   * 修好形状之后，这些旧标签要靠这一轮重打覆盖。
   */
  async retagAll(ctx: Context, onProgress?: (done: number, total: number) => void): Promise<{ done: number; failed: number; total: number }> {
    const entries = [...this.index.values()]
    let done = 0
    let failed = 0
    for (const entry of entries) {
      try {
        const buf = await fs.readFile(entry.file)
        entry.desc = ''
        entry.tags = []
        await this.tagEntry(ctx, entry, buf, 'image/jpeg')
        if (entry.tags.length > 0 || entry.desc !== '') done += 1
        else failed += 1
      } catch {
        failed += 1
      }
      onProgress?.(done + failed, entries.length)
    }
    this.dirty = true
    await this.save()
    this.log(`emoji retag: ${done}/${entries.length} 成功，${failed} 失败`)
    return { done, failed, total: entries.length }
  }
}
