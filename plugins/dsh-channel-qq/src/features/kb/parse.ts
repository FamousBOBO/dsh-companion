/** 文件解析：文本/Markdown/HTML 原生解析；PDF/Office/图片交给可选的 Docling sidecar。
 *
 * 三条边界：
 *   - **大小先看 stat 再读**：一个 200MB 的 PDF 不该先进内存再被拒；
 *   - **Docling 没配或者不可用 = 这份文档记一条"解析失败"**，不是整个扫描失败——
 *     用户目录里混着 PDF 是常态；
 *   - 解析结果统一成 Markdown 文本（标题保留 `#`），后面的标题感知分块才对得上。
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { systemHttp } from '../../adapters/http/client.js'

/** Docling 返回的 Markdown 可能比原文件大（OCR 文本）；上限放宽到 32MB。 */
const DOCLING_RESPONSE_LIMIT = 32 * 1024 * 1024

/** 原生解析的扩展名。 */
const TEXT_EXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '.log', '.rst', '.json', '.csv'])
const HTML_EXT = new Set(['.html', '.htm', '.xhtml'])
/** 需要 Docling 的扩展名（没配 Docling 时只登记、不解析）。 */
const DOCLING_EXT = new Set([
  '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.odt', '.ods', '.odp', '.rtf',
  '.epub', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp',
])

/** 图片：没有 Docling（OCR）时索引它们没有意义，扫描阶段直接跳过。 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'])

export type FileKind = 'text' | 'html' | 'docling' | 'unsupported'

export interface ParsedDoc {
  readonly text: string
  /** `markdown` / `text` / `html` / `docling`。 */
  readonly parser: string
  /** Docling 返回的页数（其它格式没有）。 */
  readonly pages?: number
}

export interface ParseOptions {
  readonly maxBytes: number
  /** docling-serve 地址；空串 = 不解析二进制文档。 */
  readonly doclingUrl: string
  readonly timeoutMs?: number
}

/** 这个文件名归哪一类。 */
export function kindOf(fileName: string): FileKind {
  const ext = path.extname(fileName).toLowerCase()
  if (TEXT_EXT.has(ext)) return 'text'
  if (HTML_EXT.has(ext)) return 'html'
  if (DOCLING_EXT.has(ext)) return 'docling'
  return 'unsupported'
}

/** 扫描时要收的文件（unsupported 直接跳过，连文档表都不进）。 */
export function isSupportedFile(fileName: string): boolean {
  return kindOf(fileName) !== 'unsupported'
}

/** 图片文件（没配 Docling 时扫描阶段跳过，避免下载目录里的图把文档表刷满）。 */
export function isImageFile(fileName: string): boolean {
  return IMAGE_EXT.has(path.extname(fileName).toLowerCase())
}

/** 逐文件解析。失败抛错，由摄取层记进文档表。 */
export async function parseFile(absPath: string, fileName: string, opts: ParseOptions): Promise<ParsedDoc> {
  const stat = await fs.stat(absPath)
  if (!stat.isFile()) throw new Error('不是普通文件')
  if (stat.size > opts.maxBytes) {
    throw new Error(`文件 ${formatBytes(stat.size)} 超过上限 ${formatBytes(opts.maxBytes)}`)
  }
  return await parseBytes(await fs.readFile(absPath), fileName, opts)
}

/** 从已经读进内存的字节解析（摄取层要先算哈希，避免读两遍）。 */
export async function parseBytes(bytes: Buffer, fileName: string, opts: ParseOptions): Promise<ParsedDoc> {
  const kind = kindOf(fileName)
  if (kind === 'unsupported') throw new Error(`不支持的格式：${path.extname(fileName) || '(无扩展名)'}`)
  if (kind === 'text') {
    const text = stripBom(bytes.toString('utf8'))
    const ext = path.extname(fileName).toLowerCase()
    return { text, parser: ext === '.md' || ext === '.markdown' || ext === '.mdx' ? 'markdown' : 'text' }
  }
  if (kind === 'html') return { text: htmlToText(stripBom(bytes.toString('utf8'))), parser: 'html' }
  if (opts.doclingUrl.trim() === '') {
    throw new Error('PDF/Office/图片需要配置 Docling 地址（kb.doclingUrl）才能解析')
  }
  return await convertWithDocling(bytes, fileName, opts.doclingUrl.trim(), opts.timeoutMs ?? 120_000)
}

/** Docling：multipart 上传，取回 Markdown。响应形状在不同版本间有差异，三者都认。
 *
 * 走 `systemHttp` 而不是裸 fetch（R6）：超时、体积上限、重定向规则都在端口里；
 * 地址来自**运维填的配置**（本机 sidecar），所以显式放行私网。
 */
async function convertWithDocling(bytes: Buffer, fileName: string, baseUrl: string, timeoutMs: number): Promise<ParsedDoc> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/convert/file?to_formats=md`
  const form = multipartBody(fileName, bytes)
  let response
  try {
    response = await systemHttp.request(url, {
      method: 'POST',
      headers: { 'content-type': form.contentType, accept: 'application/json' },
      body: form.body,
      timeoutMs,
      limit: DOCLING_RESPONSE_LIMIT,
      allowPrivateHosts: true,
    })
  } catch (error) {
    throw new Error(`Docling 请求失败：${(error as Error).message}`)
  }
  if (!response.ok) throw new Error(`Docling HTTP ${response.status}`)
  const payload = response.json<{
    document?: { md_content?: unknown; markdown?: unknown; pages?: unknown }
    md_content?: unknown
    markdown?: unknown
  }>()
  const text = pickString(payload.document?.md_content, payload.document?.markdown, payload.md_content, payload.markdown)
  if (text.trim() === '') throw new Error('Docling 返回了空内容（可能是扫描件且未跑 OCR）')
  const pages = Number(payload.document?.pages)
  return Number.isFinite(pages) && pages > 0 ? { text, parser: 'docling', pages } : { text, parser: 'docling' }
}

function pickString(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value !== '') return value
  return ''
}

/** 手写 multipart（D8：不新增运行时依赖）。 */
function multipartBody(fileName: string, bytes: Buffer): { body: Buffer, contentType: string } {
  const boundary = `----dshkb${randomBytes(8).toString('hex')}`
  const safeName = fileName.replace(/["\r\n]/g, '_')
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${safeName}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** HTML → Markdown 风格纯文本：保留标题层级与段落换行，去掉脚本/样式/标签。 */
export function htmlToText(html: string): string {
  const withoutBlocks = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, '')
  const withHeadings = withoutBlocks.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_all, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${stripTags(inner)}\n\n`,
  )
  const text = withHeadings
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** 最少的一组实体；其它按数字实体解。 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  }
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return safeChar(parseInt(body.slice(2), 16), all)
    if (body.startsWith('#')) return safeChar(parseInt(body.slice(1), 10), all)
    return named[body.toLowerCase()] ?? all
  })
}

function safeChar(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback
  try { return String.fromCodePoint(code) } catch { return fallback }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
