/** URL → Markdown 入库（B6）。
 *
 * 仍然遵守知识库的入口约定：**只写工作区文件**（`kb/raw/web/`），再走扫描。
 * 这样"来源可追溯"（文档表里的 path）与哈希增量都不用另起一套逻辑。
 *
 * 抓取走 `systemHttp`（SSRF 守卫：逐跳校验重定向、拒绝私网），并按
 * `kb.maxFileBytes` 截断 —— 一个 URL 不能把内存吃光。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { systemHttp } from '../../adapters/http/client.js'
import { htmlToText } from './parse.js'

export interface UrlIngestDeps {
  readonly workspacePath: string
  /** 测试注入点；缺省走带 SSRF 守卫的 `systemHttp`。 */
  readonly http?: { request(url: string, options: Record<string, unknown>): Promise<{ ok: boolean; status: number; bytes: Uint8Array | Buffer }> }
  readonly maxBytes: number
  readonly log: (line: string) => void
  /** 写完文件后走一次扫描（与后台「立即扫描」同一个入口）。 */
  readonly scan: () => Promise<unknown>
}

/** 抓一个网页并落成 Markdown；返回落盘路径与统计。 */
export async function ingestUrl(deps: UrlIngestDeps, rawUrl: string): Promise<{ path: string; title: string; bytes: number }> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('不是合法的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http(s) URL')
  const http = deps.http ?? systemHttp
  const res = await http.request(url.toString(), {
    limit: deps.maxBytes,
    timeoutMs: 20_000,
    headers: { 'User-Agent': 'dsh-channel-qq/kb (+url ingest)' },
  })
  if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`)
  const html = Buffer.from(res.bytes).toString('utf8')
  const text = htmlToText(html).trim()
  if (text === '') throw new Error('页面没有可读正文（可能是纯脚本页）')
  const title = titleOf(html) || url.hostname + url.pathname
  const body = `# ${title}\n\n来源：${url.toString()}\n\n${text}\n`
  const name = `${new Date().toISOString().slice(0, 10)}-${createHash('sha256').update(url.toString()).digest('hex').slice(0, 10)}.md`
  const dir = path.join(deps.workspacePath, 'kb', 'raw', 'web')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await atomicWriteFile(file, body)
  deps.log(`kb: URL 入库 ${url.toString()} → ${path.relative(deps.workspacePath, file)}（${body.length} 字）`)
  await deps.scan()
  return { path: file, title, bytes: Buffer.byteLength(body) }
}

/** `<title>` 优先，其次是 og:title；都没有返回空串。 */
function titleOf(html: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''
  const og = /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? ''
  return (title || og).replace(/\s+/g, ' ').trim().slice(0, 120)
}
