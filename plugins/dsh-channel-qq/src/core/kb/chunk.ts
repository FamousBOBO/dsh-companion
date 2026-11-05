/** 标题感知分块（知识库用；记忆的固定 600 字切块不动）。
 *
 * 为什么不是"每 800 字切一刀"：用户给的资料几乎都有结构（章节、条款、步骤），
 * 固定窗口会把一个标题和它的正文切开——检索命中后半截时，模型看到的是没有上文的
 * 半句话。这里按 Markdown 标题分段，块里带上**标题路径**（`安装 > 依赖`），
 * 并记录块首行号与页码。
 *
 * 三条约定：
 *   1. **先按标题切，再按长度切**：标题内正文超过上限时才继续拆，且相邻块保留
 *      `overlap` 字符的尾巴——跨块的句子不至于两边都读不懂；
 *   2. **标题路径进块文本**：向量与关键词都因此能命中"这一节讲什么"，而不是
 *      只命中正文里的字；
 *   3. **页码按换页符 `\f` 递增**：Docling 输出的 Markdown 用它分隔页。纯函数，
 *      不读时钟、不做 IO，可按 R8 单测。
 */

export interface TextChunk {
  readonly text: string
  /** 标题路径（`安装 > 依赖`）；没有标题时为空串。 */
  readonly heading: string
  /** 块首行在原文里的行号（1 起）。 */
  readonly line: number
  /** 页码（1 起）；没有换页符时全是 1。 */
  readonly page: number
}

export interface ChunkOptions {
  /** 目标块长（字符）。超过后按 `max` 判断要不要拆。 */
  readonly size?: number
  /** 单块硬上限（含标题前缀）。 */
  readonly max?: number
  /** 相邻块的重叠字符数。 */
  readonly overlap?: number
}

const DEFAULT_SIZE = 800
const DEFAULT_MAX = 1200
const DEFAULT_OVERLAP = 100
/** 标题行：`## 标题`（1–6 个 #）。 */
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/
/** 重叠时最多保留几行，避免超长单行把重叠撑爆。 */
const MAX_OVERLAP_LINES = 4

interface Resolved {
  readonly size: number
  readonly max: number
  readonly overlap: number
}

function resolveOptions(opts: ChunkOptions): Resolved {
  const size = Math.max(100, Math.trunc(opts.size ?? DEFAULT_SIZE))
  return {
    size,
    max: Math.max(size, Math.trunc(opts.max ?? DEFAULT_MAX)),
    overlap: Math.max(0, Math.min(size / 2, Math.trunc(opts.overlap ?? DEFAULT_OVERLAP))),
  }
}

/** 按行号走一遍，标题开新段；换页符由调用方先切开。 */
function walkPage(text: string, page: number, cfg: Resolved, out: TextChunk[]): void {
  const lines = text.split('\n')
  const stack: string[] = []
  let heading = ''
  let body: string[] = []
  let bodyLine = 1
  const flush = (): void => {
    flushSection(heading, body, bodyLine, page, cfg, out)
    body = []
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const match = HEADING.exec(line)
    if (match !== null) {
      flush()
      const level = (match[1] ?? '#').length
      stack.length = level - 1
      stack[level - 1] = (match[2] ?? '').trim()
      heading = stack.filter((item) => item !== undefined && item !== '').join(' > ')
      bodyLine = i + 2
      continue
    }
    if (body.length === 0) bodyLine = i + 1
    body.push(line)
  }
  flush()
}

/** 一段（一个标题下的正文）→ 一到多块。 */
function flushSection(
  heading: string,
  lines: readonly string[],
  line: number,
  page: number,
  cfg: Resolved,
  out: TextChunk[],
): void {
  const body = trimBlank(lines)
  if (body === '') return
  const text = joinHeading(heading, body)
  if (text.length <= cfg.max) {
    out.push({ text, heading, line, page })
    return
  }
  for (const piece of splitBody(body, line, cfg)) {
    out.push({ text: joinHeading(heading, piece.text), heading, line: piece.line, page })
  }
}

function joinHeading(heading: string, body: string): string {
  return heading === '' ? body : `${heading}\n\n${body}`
}

/** 超长正文按行贪心切块，块间保留尾部若干行作为重叠。
 *
 * 单行本身超过上限时（压缩后的 JSON、没有换行的导出一类）按字符硬切——否则
 * "一行 3000 字"会变成一块 3000 字的超长块，分块等于没做。
 */
function splitBody(body: string, startLine: number, cfg: Resolved): Array<{ text: string; line: number }> {
  const lines = body.split('\n').flatMap((line) => explode(line, cfg.size))
  const out: Array<{ text: string; line: number }> = []
  let buf: string[] = []
  let len = 0
  let first = startLine
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (len + line.length + 1 > cfg.size && buf.length > 0) {
      out.push({ text: trimBlank(buf), line: first })
      buf = tailLines(buf, cfg.overlap)
      len = buf.reduce((sum, item) => sum + item.length + 1, 0)
      first = startLine + i - buf.length
    }
    if (buf.length === 0) first = startLine + i
    buf.push(line)
    len += line.length + 1
  }
  const last = trimBlank(buf)
  if (last !== '') out.push({ text: last, line: first })
  return out
}

/** 尾部不超过 `budget` 字符、最多 `MAX_OVERLAP_LINES` 行。 */
function tailLines(lines: readonly string[], budget: number): string[] {
  const kept: string[] = []
  let len = 0
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_OVERLAP_LINES; i -= 1) {
    const line = lines[i] ?? ''
    if (kept.length > 0 && len + line.length + 1 > budget) break
    kept.unshift(line)
    len += line.length + 1
  }
  return kept
}

/** 把一行按上限硬切成若干段（行号信息对硬切无意义，沿用同一个起始行）。 */
function explode(line: string, size: number): string[] {
  if (line.length <= size) return [line]
  const out: string[] = []
  for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size))
  return out
}

/** 去掉首尾空行（中间的空行保留，段落结构对模型有用）。 */
function trimBlank(lines: readonly string[]): string {
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim() === '') start += 1
  while (end > start && (lines[end - 1] ?? '').trim() === '') end -= 1
  return lines.slice(start, end).join('\n')
}

/** 入口：先按换页符分页，再每页按标题分段。
 *
 * 只有一个"页"时页码记 0（没有换页信息就不假装有页码）；有换页符时从 1 起计。
 */
export function chunkText(raw: string, opts: ChunkOptions = {}): TextChunk[] {
  const cfg = resolveOptions(opts)
  const out: TextChunk[] = []
  const pages = String(raw ?? '').replace(/\r\n?/g, '\n').split('\f')
  const multiPage = pages.length > 1
  for (let page = 0; page < pages.length; page += 1) {
    walkPage(pages[page] ?? '', multiPage ? page + 1 : 0, cfg, out)
  }
  return out
}

/** 稳定短哈希（djb2）：块 id 与内容去重用；不追求抗碰撞。 */
export function stableHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** 文档标题：第一个 Markdown 标题，否则文件名（去扩展名）。 */
export function titleOf(relPath: string, text: string): string {
  const match = /^#{1,6}\s+(.+?)\s*$/m.exec(text)
  if (match !== null && (match[1] ?? '').trim() !== '') return (match[1] ?? '').trim().slice(0, 120)
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.[^.]+$/, '') || relPath
}

/** 集合名：路径第一段（`inbox/a.md` → `inbox`）。 */
export function collectionOf(relPath: string): string {
  const first = relPath.split('/')[0] ?? ''
  return first === '' || first === relPath ? 'docs' : first
}
