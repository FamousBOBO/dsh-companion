/** 来源目录扫描：只收配置里列出的目录，跳过隐藏目录与常见垃圾目录。
 *
 * 路径一律用 `/` 分隔并相对工作区——文档表里的 `path` 是用户能看懂、也是
 * `qq_kb` 引用里要显示的那个路径，不能跟着平台变（Windows 上是 `\`）。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { isImageFile, isSupportedFile } from './parse.js'

/** 扫描时直接跳过的目录名（不跟随符号链接，避免环）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'tmp', 'temp', '__pycache__', '.venv', 'venv'])

export interface SourceFile {
  /** 工作区相对路径（`inbox/a.md`）。 */
  readonly rel: string
  readonly abs: string
}

export interface WalkOptions {
  readonly workspace: string
  /** 配置里的目录（逗号分隔的原始值）。 */
  readonly dirs: string
  readonly maxFiles?: number
  /**
   * 是否配置了 Docling。没配时**跳过图片**：OCR 都没有，索引一张图没有意义，
   * 而 `downloads/` 里的图往往成百上千。PDF/Office 仍会登记为"解析失败"，
   * 这样后台能看到"该配 Docling 了"而不是静默漏掉。
   */
  readonly binary?: boolean
  readonly log?: (line: string) => void
}

/** 解析 `dirs` 配置：去空、去绝对路径、去 `..`，统一成相对目录。 */
export function parseDirs(raw: string): string[] {
  const out: string[] = []
  for (const item of String(raw ?? '').split(',')) {
    const clean = normalizeDir(item)
    if (clean === '' || out.includes(clean)) continue
    out.push(clean)
  }
  return out
}

function normalizeDir(raw: string): string {
  const text = raw.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (text === '' || text.startsWith('/') || /^[a-z]:/i.test(text)) return ''
  if (text.split('/').some((part) => part === '..' || part === '')) return ''
  return text
}

/** 列出一个目录（递归）里的可索引文件。 */
export async function listSources(opts: WalkOptions): Promise<SourceFile[]> {
  const maxFiles = Math.max(1, opts.maxFiles ?? 5000)
  const skipImages = opts.binary !== true
  const seen = new Set<string>()
  const out: SourceFile[] = []
  for (const dir of parseDirs(opts.dirs)) {
    await walk(path.join(opts.workspace, dir), dir, out, seen, maxFiles, skipImages, opts.log)
    if (out.length >= maxFiles) break
  }
  return out
}

async function walk(
  absDir: string,
  relDir: string,
  out: SourceFile[],
  seen: Set<string>,
  maxFiles: number,
  skipImages: boolean,
  log?: (line: string) => void,
): Promise<void> {
  if (out.length >= maxFiles) return
  let entries
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return // 目录不存在是常态（比如没建 kb/raw），不刷日志
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (out.length >= maxFiles) {
      log?.(`kb: 扫描文件数达到上限 ${maxFiles}，其余文件本轮跳过`)
      return
    }
    if (entry.name.startsWith('.')) continue
    const rel = `${relDir}/${entry.name}`
    const abs = path.join(absDir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(abs, rel, out, seen, maxFiles, skipImages, log)
      continue
    }
    if (!entry.isFile() || !isSupportedFile(entry.name) || seen.has(rel)) continue
    if (skipImages && isImageFile(entry.name)) continue
    seen.add(rel)
    out.push({ rel, abs })
  }
}

/** 这个文档路径是不是落在某个扫描目录里（删除检测用）。 */
export function withinDirs(rel: string, dirs: readonly string[]): boolean {
  if (rel.split('/').some((part) => part === '..')) return false
  return dirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`))
}
