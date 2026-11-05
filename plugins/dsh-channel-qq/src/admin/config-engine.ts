/** 配置保存引擎：校验、diff、版本历史（可回滚）、敏感掩码。
 *
 * `admin.ts` 只管 HTTP 与生命周期；"一次写入怎么算合法、记什么、回滚怎么反着走"
 * 全在这里。校验规则来自 schema 元数据（`config/meta.ts`），所以新增一个配置项
 * 不需要动这个文件。
 *
 * 历史文件：`channel-qq/admin-config-history.json`（最近 20 条，含逐项 diff）。
 * 版本号是**全局单调**的：每次成功写入/重置/回滚 +1，前端用它做并发保护
 *（`baseVersion` 不匹配 → 409，避免两个标签页互相覆盖）。
 */

import { promises as fs } from 'node:fs'
import { atomicWriteFile } from '../adapters/fs-store/atomic.js'
import { fieldRefForPath, fieldRefs, hotOf, validateValue, type FieldRef } from '../config/meta.js'
import { NO_DEFAULT } from '../config/dsl.js'

export type Json = Record<string, unknown>

const HISTORY_LIMIT = 20

// ── 基础工具（纯函数）──────────────────────────────────────────────────────

/** JSON 深拷贝（配置值是纯 JSON；失败时退化为空对象）。 */
export function cloneJson(value: unknown): Json {
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value ?? {}))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Json : {}
  } catch {
    return {}
  }
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Json)[part]
  }
  return cur
}

export function setPath(obj: Json, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: Json = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!
    const next = cur[part]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[part] = {}
    cur = cur[part] as Json
  }
  cur[parts[parts.length - 1]!] = value
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** 遍历 patch 的**叶子**（数组与标量都是叶子；`undefined` 跳过）。 */
export function walkLeaves(node: unknown, visit: (path: string, value: unknown) => void, prefix = ''): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    if (prefix !== '') visit(prefix, node)
    return
  }
  for (const [key, value] of Object.entries(node as Json)) {
    if (value === undefined) continue
    walkLeaves(value, visit, prefix === '' ? key : `${prefix}.${key}`)
  }
}

// ── 校验 ───────────────────────────────────────────────────────────────────

export interface PatchIssue {
  path: string
  error: string
}

/** 校验 patch 的每个叶子：路径必须存在于 schema，值必须通过字段规则。 */
export function validatePatch(patch: unknown, refs: FieldRef[] = fieldRefs()): PatchIssue[] {
  const issues: PatchIssue[] = []
  const checked = new Set<string>()
  walkLeaves(patch, (path) => {
    // json 对象字段（如 turn.maxSteps）的内部键不在 schema 里：整值归并到字段本身校验一次。
    const ref = fieldRefForPath(path, refs)
    if (ref === undefined) {
      issues.push({ path, error: '未知配置项（schema 里没有这一项）' })
      return
    }
    if (checked.has(ref.path)) return
    checked.add(ref.path)
    const error = validateValue(ref.spec, getPath(patch, ref.path))
    if (error !== null) issues.push({ path: ref.path, error })
  })
  return issues
}

// ── 掩码 ───────────────────────────────────────────────────────────────────

/** 快照视图：敏感字段值置空，另附"是否已设置"标记。 */
export function maskConfigForView(live: unknown, refs: FieldRef[] = fieldRefs()): { config: Json; secretSet: Json } {
  const config = cloneJson(live)
  const secretSet: Json = {}
  for (const ref of refs) {
    if (ref.spec.secret !== true) continue
    const value = getPath(config, ref.path)
    const set = value !== undefined && value !== null && value !== ''
    secretSet[ref.path] = set
    if (set) setPath(config, ref.path, '')
  }
  return { config, secretSet }
}

/** 当前配置里所有非空敏感值（日志/审计文本掩码用）。 */
export function secretValuesOf(live: unknown, refs: FieldRef[] = fieldRefs()): string[] {
  const out: string[] = []
  for (const ref of refs) {
    if (ref.spec.secret !== true) continue
    const value = getPath(live, ref.path)
    if (typeof value === 'string' && value.length >= 4) out.push(value)
  }
  return out
}

export function maskSecretText(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) out = out.split(secret).join('••••')
  return out
}

// ── 变更清单 ───────────────────────────────────────────────────────────────

export interface ChangeEntry {
  path: string
  label: string
  hot: string
  secret: boolean
  /** 展示值（敏感字段是"（已设置）/（未设置）"这类文字，不含明文）。 */
  old: string
  new: string
  /** 原始值（回滚用；响应里会被 admin.ts 剔掉）。 */
  rawOld: unknown
  rawNew: unknown
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '（空）'
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (typeof value === 'string') return value === '' ? '（空）' : value
  try {
    const text = JSON.stringify(value)
    return text !== undefined && text.length > 90 ? `${text.slice(0, 90)}…` : (text ?? '（空）')
  } catch {
    return '（对象）'
  }
}

/** 与现状求 diff：值没变的叶子不计入；json 对象字段的内部键归并成字段本身一条。 */
export function computeChanges(
  live: unknown,
  patch: unknown,
  refs: FieldRef[] = fieldRefs(),
  secretSet: Json = {},
): ChangeEntry[] {
  const out: ChangeEntry[] = []
  const seen = new Set<string>()
  walkLeaves(patch, (path) => {
    const ref = fieldRefForPath(path, refs)
    if (ref === undefined) return // 校验阶段已报错
    if (seen.has(ref.path)) return
    seen.add(ref.path)
    const rawNew = getPath(patch, ref.path)
    const rawOld = getPath(live, ref.path)
    if (deepEqual(rawOld, rawNew)) return
    const secret = ref.spec.secret === true
    out.push({
      path: ref.path,
      label: ref.spec.label,
      hot: hotOf(ref.spec),
      secret,
      old: secret ? (secretSet[ref.path] === true ? '（已设置）' : '（未设置）') : display(rawOld),
      new: secret ? '（新值）' : display(rawNew),
      rawOld,
      rawNew,
    })
  })
  return out
}

/** 把一次变更反着走一遍（回滚 patch）。旧值不存在（可选键）时写 null（= 清空）。 */
export function inversePatch(changes: ChangeEntry[]): Json {
  const patch: Json = {}
  for (const change of changes) {
    setPath(patch, change.path, change.rawOld === undefined ? null : change.rawOld)
  }
  return patch
}

/** 需要重启才生效的路径（schema 标注驱动，取代旧 RESTART_PATHS 白名单）。 */
export function restartPathsIn(changes: ChangeEntry[]): string[] {
  return changes.filter((change) => change.hot === 'restart').map((change) => change.path)
}

// ── 版本历史 ───────────────────────────────────────────────────────────────

export interface HistoryEntry {
  version: number
  at: string
  /** save | reset | rollback | internal */
  source: string
  changes: ChangeEntry[]
}

export class ConfigHistory {
  private version = 1
  private entries: HistoryEntry[] = []

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void,
  ) {}

  /** 读盘；文件缺失或损坏时从 1 开始（永不抛错）。 */
  async load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.file, 'utf-8'))
      if (typeof raw !== 'object' || raw === null) return
      const record = raw as Record<string, unknown>
      const version = Number(record.version)
      if (Number.isInteger(version) && version >= 1) this.version = version
      if (Array.isArray(record.entries)) {
        this.entries = record.entries.filter((entry: unknown): entry is HistoryEntry => {
          if (typeof entry !== 'object' || entry === null) return false
          const candidate = entry as Record<string, unknown>
          return typeof candidate.version === 'number' && Array.isArray(candidate.changes)
        })
      }
    } catch {
      // 首次运行或文件损坏：从零开始是安全的（历史只是展示与回滚源）。
    }
  }

  get current(): number {
    return this.version
  }

  list(): HistoryEntry[] {
    return [...this.entries]
  }

  find(version: number): HistoryEntry | undefined {
    return this.entries.find((entry) => entry.version === version)
  }

  /** 记录一次成功写入，版本 +1（先落盘再返回，保证重启后版本不回退）。 */
  async record(source: string, changes: ChangeEntry[]): Promise<HistoryEntry> {
    this.version += 1
    const entry: HistoryEntry = { version: this.version, at: new Date().toISOString(), source, changes }
    this.entries.unshift(entry)
    if (this.entries.length > HISTORY_LIMIT) this.entries.length = HISTORY_LIMIT
    await this.persist()
    return entry
  }

  private async persist(): Promise<void> {
    try {
      await atomicWriteFile(this.file, JSON.stringify({ version: this.version, entries: this.entries }, null, 1))
    } catch (error) {
      this.log(`config history: persist failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 校验结果的人话摘要（错误响应/日志共用）。 */
export function describeIssues(issues: PatchIssue[]): string {
  return issues.map((issue) => `${issue.path}：${issue.error}`).join('；')
}

export { NO_DEFAULT }
