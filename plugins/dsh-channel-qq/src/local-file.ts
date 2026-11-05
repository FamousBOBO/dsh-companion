/**
 * Hand a local file to NapCat.
 *
 * Why this module exists
 * ----------------------
 * A OneBot message segment (`data.file`) and the `file` parameter of
 * `upload_private_file` / `upload_group_file` all accept three forms: an
 * http(s) URL, a **local path**, or `base64://<payload>`.
 *
 * The local-path form only works when NapCat can read that path *itself*. In this
 * deployment NapCat runs in a container that does not mount the plugin's
 * directories and `enableLocalFile2Url` is off, so handing it a path — or a
 * `file://` URL, which it also does not resolve — is answered with
 * `QQ API failed: 识别URL失败`, and every file send silently fails.
 *
 * Every local file therefore goes through `napcatFileArg()`:
 *
 *   - under a root NapCat can read  -> `file://<abs>`    (no copy, no size limit)
 *   - anywhere else                 -> `base64://<b64>`  (always works, size-capped)
 *
 * The visible roots come from `CHANNEL_QQ_NAPCAT_ROOTS` (colon- or comma-separated
 * host paths). Unset means "NapCat cannot read anything on this host", which is
 * the safe default: uploads still work, just inline.
 *
 * `localPathOf()` also accepts a `file://` URL from the caller. The model
 * sometimes writes `file:///opt/...` when asked for a path; feeding that straight
 * to `fs.access` produced `ENOENT ... access 'file:///opt/...'`.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/**
 * Above this, inlining is refused instead of attempted.
 *
 * base64 inflates by 4/3 and the payload travels as one WebSocket frame, so a
 * multi-megabyte file is both slow and likely to be rejected. 8 MiB of input is
 * ~11 MiB on the wire — comfortably inside what a local NapCat accepts while
 * still refusing the case that would otherwise blow up.
 */
export const DEFAULT_MAX_INLINE_BYTES = 8 * 1024 * 1024

/**
 * 小于它的文件**一律内联**，不管配置的"可读根"怎么说。
 *
 * 为什么：`CHANNEL_QQ_NAPCAT_ROOTS` 只是运维的**声明**，容器里的用户/权限未必
 * 允许读那个目录。线上踩过：`~/.dsh/channel-qq` 写进了根列表，但 `/root`
 * 是 700，NapCat 直读路径直接 `EACCES`——表情包（几 KB）全部发送失败。
 * 几百 KB 的 base64 代价可以忽略，却能把整类"配置说能读、实际读不到"的失败挡掉。
 */
const ALWAYS_INLINE_BYTES = 256 * 1024

/** Host paths NapCat is configured to read (see the module doc). */
export function napcatVisibleRoots(): string[] {
  const raw = process.env.CHANNEL_QQ_NAPCAT_ROOTS ?? ''
  return raw
    // 逗号/分号/换行是主分隔符；冒号也支持（POSIX 习惯），但 **Windows 盘符**
    // 的 `C:` 不能拆——`split(':')` 会把 `C:\data\x` 切成两段（2026-10-21 测试踩到）。
    .split(/[,;\n]+/)
    .flatMap((part) => part.split(/:(?![\\/])/))
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => path.resolve(s))
}

/**
 * Normalise whatever the caller passed into a local absolute filesystem path.
 *
 * Accepts a bare path or a `file://` URL (percent-decoded). Anything with
 * another scheme (`http:`, `base64:`) is returned unchanged so callers can pass
 * a ready-made URL straight through.
 */
export function localPathOf(input: string): string {
  const raw = input.trim()
  if (raw === '') throw new Error('文件路径不能为空')
  if (/^[a-zA-Z][\w+.-]*:/.test(raw) && !/^file:/i.test(raw)) return raw
  if (/^file:/i.test(raw)) {
    let rest = raw.replace(/^file:\/\//i, '').replace(/^file:/i, '')
    // `file:///opt/x` -> `/opt/x`; `file://host/share` keeps `host/share` (unused here)
    if (!rest.startsWith('/') && /^[a-zA-Z]:/.test(rest)) rest = rest // win32 `file:///C:/x` already handled
    else if (!rest.startsWith('/')) rest = `/${rest.replace(/^\/+/, '')}`
    try { rest = decodeURIComponent(rest) } catch { /* keep the raw form */ }
    return path.resolve(rest)
  }
  return path.resolve(raw)
}

/** True when `abs` is inside one of `roots` (both already absolute). */
function underAnyRoot(abs: string, roots: string[]): boolean {
  for (const root of roots) {
    if (abs === root) return true
    if (abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true
  }
  return false
}

/**
 * **文件边界**（P1-05）：本地文件只许从这些根里出去。
 *
 * 为什么放在这一层：所有"把本地文件变成 OneBot 能用的东西"的调用都走
 * `napcatFileArg()`（8 处：私聊文件、群文件、语音、表情包、生图、点歌、链接封面）。
 * 在工作区边界只有 `policy.v2` 才管的时候（本 profile 没开），模型可以让
 * `qq_send_private_file(file="/home/user/.ssh/id_rsa")` 把任意可读文件 base64 发出去。
 * 这一层是**不依赖任何开关**的硬边界。
 *
 * 判据用**真实路径**（`realpath`）：`..` 逃逸、符号链接指到外面、绝对路径指到外面
 * 三种都挡得住。根也先 `realpath`——否则 `C:\WORK` 与 `c:\work` 这种大小写/链接差异
 * 会让"明明在里面"被判成外面（或者反过来）。
 */
export interface FileBoundary {
  /** 允许出站的根（绝对路径）。 */
  readonly roots: readonly string[]
}

let boundary: FileBoundary | null = null

/** 装配侧配置边界（插件 apply 时按"工作区 + 插件数据目录"设置）；`null` = 关掉校验。 */
export function configureFileBoundary(next: FileBoundary | null): void {
  boundary = next
}

export function fileBoundaryOf(): FileBoundary | null {
  return boundary
}

/** `abs` 是否落在 `root` 里（两边都已是真实路径；大小写不敏感比较）。 */
function insideReal(abs: string, root: string): boolean {
  const rel = path.relative(root, abs)
  if (rel === '') return true
  if (rel.startsWith('..')) return false
  if (path.isAbsolute(rel)) return false
  return true
}

/**
 * 真实路径必须在边界内，否则抛错（可解释、可恢复）。
 *
 * @throws 路径在边界外，或边界根本没配置（这时只放行显式配置过的场景，见调用方）。
 */
export async function assertInsideFileBoundary(abs: string): Promise<void> {
  const current = boundary
  if (current === null || current.roots.length === 0) return
  const real = await fs.realpath(abs).catch(() => abs)
  for (const root of current.roots) {
    const realRoot = await fs.realpath(root).catch(() => path.resolve(root))
    if (insideReal(real, realRoot)) return
  }
  throw new Error(
    `文件 ${abs} 不在允许的目录里（只能发工作区内的文件）。`
    + `这是硬边界：不因为任何开关而放宽。要发这个文件，先把它复制进工作区，或让主人在自己的回合里发。`,
  )
}

/** 本地文件发送的统一出口。见文件头注释。 */
export async function napcatFileArg(
  input: string,
  opts: { maxInlineBytes?: number } = {},
): Promise<string> {
  const max = opts.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES
  const abs = localPathOf(input)

  // Already a usable URL (http/base64) — pass it through untouched.
  if (/^[a-zA-Z][\w+.-]*:/.test(abs) && !/^[a-zA-Z]:[\\/]/.test(abs)) return abs

  // P1-05：硬边界——本地路径必须落在允许的根里（真实路径，挡 .. / 符号链接 / 绝对路径逃逸）。
  await assertInsideFileBoundary(abs)

  const stat = await fs.stat(abs) // throws ENOENT/EISDIR with the real path in it
  if (!stat.isFile()) throw new Error(`不是文件（是目录？）：${abs}`)

  // 小文件先内联（见 ALWAYS_INLINE_BYTES）：表情包/短语音都走这里，不依赖容器权限。
  if (stat.size <= ALWAYS_INLINE_BYTES) {
    return `base64://${(await fs.readFile(abs)).toString('base64')}`
  }

  if (underAnyRoot(abs, napcatVisibleRoots())) {
    // NapCat reads it directly; no copy and no size limit.
    return `file://${abs.split(path.sep).join('/')}`
  }

  if (stat.size > max) {
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)
    throw new Error(
      `文件 ${abs} 有 ${mb(stat.size)}MiB，超过内联上限 ${mb(max)}MiB，而 NapCat 又读不到这个路径。`
      + `两种解法：把该目录挂进 NapCat 容器（并设 CHANNEL_QQ_NAPCAT_ROOTS），或换个小文件。`,
    )
  }

  const bytes = await fs.readFile(abs)
  return `base64://${bytes.toString('base64')}`
}