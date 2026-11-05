/** Safe read/write access to the agent workspace, for the admin panel.
 *
 * The panel lets an operator edit the persona and instruction files
 * (`AGENTS.md`, `MEMORY.md`, diaries, knowledge) from a browser, which means
 * this module is the only thing standing between an HTTP request and the
 * filesystem. Every rule below exists because of a concrete failure mode:
 *
 *   - **Path escape.** `path` arrives as an arbitrary string. It is resolved
 *     against the workspace root and then re-checked to still be inside it, so
 *     `../../etc/shadow`, an absolute path, and a symlink-ish `..` chain all
 *     fail the same way instead of silently reading something else.
 *   - **Accidental destruction.** A write first copies the previous version to
 *     `<dshHome>/channel-qq/backups/`, so a bad paste is recoverable without
 *     shell access. The backup path is returned to the caller and shown in the
 *     UI.
 *   - **Binary/huge files.** `memory/` and `downloads/` accumulate images and
 *     archives; reading one as UTF-8 would produce megabytes of replacement
 *     characters. A NUL byte in the first 8 KB means "binary" and the read is
 *     refused, and reads are capped.
 *   - **Noise.** `.git`, `node_modules` and dotfiles are hidden from listings.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from './adapters/fs-store/atomic.js'

/** Reads above this are refused outright rather than truncated silently. */
const MAX_READ_BYTES = 512 * 1024
/** Writes above this are refused; the HTTP body cap is 2 MB. */
const MAX_WRITE_BYTES = 1024 * 1024
/** Directory names never shown or descended into. */
const HIDDEN_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__'])
/** Only the first slice is scanned when deciding whether a file is binary. */
const SNIFF_BYTES = 8192

export interface FileEntry {
  name: string
  /** Workspace-relative path, `/`-separated. */
  path: string
  dir: boolean
  size: number
  mtime: number
}

export interface FileListing {
  path: string
  parent: string | null
  entries: FileEntry[]
}

export interface FileContent {
  path: string
  content: string
  bytes: number
  mtime: number
  truncated: boolean
}

export class WorkspaceFiles {
  constructor(
    /** Resolved on every call so `workspacePath` stays hot-editable. */
    private readonly root: () => string | null,
    /** Where previous versions are kept. */
    private readonly backupDir: string,
    private readonly log: (line: string) => void,
  ) {}

  /**
   * Resolve a workspace-relative path, or throw.
   *
   * The `startsWith` check is the real guard: `path.resolve` collapses `..`
   * before we look, so anything that escaped the root no longer has the root
   * as a prefix. Absolute inputs are rejected before that because
   * `path.resolve` would otherwise treat them as a replacement for the root.
   */
  private resolveOrThrow(relative: string): string {
    const root = this.root()
    if (root === null || root === '') throw new Error('未配置工作区，文件管理不可用')
    const trimmed = (relative ?? '').trim()
    if (path.isAbsolute(trimmed)) throw new Error('只允许工作区内的相对路径')
    const base = path.resolve(root)
    const target = path.resolve(base, trimmed)
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error('路径越出了工作区，拒绝访问')
    }
    return target
  }

  /** Workspace-relative, `/`-separated form of an absolute path. */
  private toRelative(absolute: string): string {
    const root = path.resolve(this.root() ?? '')
    const rel = path.relative(root, absolute)
    return rel.split(path.sep).join('/')
  }

  private visible(name: string): boolean {
    return !name.startsWith('.') && !HIDDEN_DIRS.has(name)
  }

  /** One directory's entries: directories first, then files, each by name. */
  async list(relative: string): Promise<FileListing> {
    const dir = this.resolveOrThrow(relative)
    const stat = await fs.stat(dir).catch(() => null)
    if (stat === null) throw new Error(`目录不存在：${relative === '' ? '（工作区根）' : relative}`)
    if (!stat.isDirectory()) throw new Error('这不是一个目录')
    const names = await fs.readdir(dir)
    const entries: FileEntry[] = []
    for (const name of names) {
      if (!this.visible(name)) continue
      const full = path.join(dir, name)
      const info = await fs.lstat(full).catch(() => null)
      if (info === null) continue
      const isDir = info.isDirectory()
      if (!isDir && !info.isFile()) continue // sockets/fifos have nothing to edit
      entries.push({
        name,
        path: this.toRelative(full),
        dir: isDir,
        size: isDir ? 0 : info.size,
        mtime: info.mtimeMs,
      })
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    const rel = this.toRelative(dir)
    const parent = rel === '' ? null : (path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel))
    return { path: rel, parent, entries }
  }

  /** One text file's contents. */
  async read(relative: string): Promise<FileContent> {
    const file = this.resolveOrThrow(relative)
    if (relative.trim() === '') throw new Error('没有指定文件')
    const info = await fs.stat(file).catch(() => null)
    if (info === null) throw new Error(`文件不存在：${relative}`)
    if (info.isDirectory()) throw new Error('这是一个目录，不能当文件读')
    if (info.size > MAX_READ_BYTES) {
      throw new Error(`文件太大（${Math.round(info.size / 1024)}KB > ${MAX_READ_BYTES / 1024}KB），请用别的方式编辑`)
    }
    const raw = await fs.readFile(file)
    const head = raw.subarray(0, SNIFF_BYTES)
    if (head.includes(0)) throw new Error('这看起来是二进制文件，不支持在线编辑')
    return {
      path: this.toRelative(file),
      content: raw.toString('utf8'),
      bytes: raw.length,
      mtime: info.mtimeMs,
      truncated: false,
    }
  }

  /** Copy the current version aside before it is replaced. Returns the backup path. */
  private async backup(file: string): Promise<string | null> {
    const exists = await fs.stat(file).catch(() => null)
    if (exists === null || !exists.isFile()) return null
    await fs.mkdir(this.backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const flat = this.toRelative(file).replace(/[\\/]/g, '__')
    const target = path.join(this.backupDir, `${stamp}__${flat}`)
    await fs.copyFile(file, target)
    return target
  }

  /** Overwrite (or create) a text file, keeping one backup of the old content. */
  async write(relative: string, content: string): Promise<{ path: string; bytes: number; backup: string | null }> {
    const file = this.resolveOrThrow(relative)
    if (relative.trim() === '') throw new Error('没有指定文件')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_WRITE_BYTES) throw new Error(`内容太大（${Math.round(bytes / 1024)}KB > ${MAX_WRITE_BYTES / 1024}KB）`)
    const existing = await fs.stat(file).catch(() => null)
    if (existing !== null && existing.isDirectory()) throw new Error('这是一个目录，不能写入')
    const backup = await this.backup(file)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await atomicWriteFile(file, content)
    this.log(`admin: wrote ${this.toRelative(file)} (${bytes} bytes)${backup === null ? '' : `, backup ${path.basename(backup)}`}`)
    return { path: this.toRelative(file), bytes, backup }
  }

  /** Create an empty file (or a file with initial content). Never overwrites. */
  async create(relative: string, content = ''): Promise<{ path: string; bytes: number }> {
    const file = this.resolveOrThrow(relative)
    if (relative.trim() === '') throw new Error('没有指定文件名')
    const existing = await fs.stat(file).catch(() => null)
    if (existing !== null) throw new Error(`已经存在：${relative}`)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_WRITE_BYTES) throw new Error('内容太大')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await atomicWriteFile(file, content)
    this.log(`admin: created ${this.toRelative(file)}`)
    return { path: this.toRelative(file), bytes }
  }

  /** Delete a file, keeping a backup. Directories are refused on purpose. */
  async remove(relative: string): Promise<{ path: string; backup: string | null }> {
    const file = this.resolveOrThrow(relative)
    if (relative.trim() === '') throw new Error('不能删除工作区根目录')
    const info = await fs.stat(file).catch(() => null)
    if (info === null) throw new Error(`不存在：${relative}`)
    if (info.isDirectory()) throw new Error('这里只删文件；目录请手动处理，避免误删整棵子树')
    const backup = await this.backup(file)
    await fs.unlink(file)
    this.log(`admin: deleted ${this.toRelative(file)}${backup === null ? '' : `, backup ${path.basename(backup)}`}`)
    return { path: this.toRelative(file), backup }
  }
}