/** 技能仓库：扫描、读取、写入、删除、导入暂存。
 *
 * 目录布局（`<root>` 默认 `<dshHome>/channel-qq/skills`）：
 *
 *   <root>/<name>/SKILL.md        主目录包（推荐；可带 scripts/ references/ assets/）
 *   <root>/<name>.md              扁平技能（agentskills 允许的另一种形态）
 *   <root>/.staging/<name>/…      导入待审区：**不会**被 provider 扫到，
 *                                 管理员在后台点「启用」才移进主目录
 *
 * 为什么放在 `dshHome` 而不是工作区：工作区是 `workspace-write`，模型手里的
 * `write` 工具能改那里。技能正文是**会进系统提示的指令**，让模型能自己写技能
 * 等于给注入开了一条持久化后门。`dshHome` 在沙箱外，模型写不到。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import {
  parseSkillFile, type SkillDoc, type SkillPolicy,
} from '../../core/skills/model.js'
import { serializeSkillFile, type SkillFileInput } from '../../core/skills/serialize.js'

/** 一个技能在磁盘上的形态。 */
export type SkillKind = 'bundle' | 'flat'

/** 管理面/诊断用的条目：坏文件也在列表里（`error` 说明原因）。 */
export interface SkillEntry {
  readonly name: string
  readonly kind: SkillKind
  /** 相对 root 的路径。 */
  readonly path: string
  readonly description: string
  readonly whenToUse: string
  readonly policy: SkillPolicy | null
  readonly metadata: Readonly<Record<string, string>>
  readonly body: string
  readonly error: string
  /** 文件大小（SKILL.md）。 */
  readonly bytes: number
  readonly mtime: number
  /** scripts/ 下的文件相对路径；空数组表示没有。 */
  readonly scripts: readonly string[]
  /** 是否在待审区。 */
  readonly staged: boolean
}

/** 导入/写入的大小上限：技能是提示词，不是数据仓库。 */
export const MAX_SKILL_FILE_BYTES = 256 * 1024
/** 一个技能包（含 scripts/references）的总字节上限。 */
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024

/** 名字规则（与 agentskills 一致）；写盘前必须先过这一关，避免路径逃逸。 */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64
}

/** 根目录的默认值（调用方传 `config.skills.dir` 或 null）。 */
export function skillsRoot(dshHome: string, configured: string | null): string {
  return configured !== null && configured.trim() !== ''
    ? path.resolve(configured.trim())
    : path.join(dshHome, 'channel-qq', 'skills')
}

/** 只允许写 root 之内：把名字拼成路径后再校验一次前缀。 */
export function safeJoin(root: string, name: string): string {
  if (!isValidSkillName(name)) throw new Error(`非法的技能名：${name}（只允许小写字母、数字与连字符）`)
  const target = path.resolve(root, name)
  const normalizedRoot = path.resolve(root)
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`技能路径越界：${name}`)
  }
  return target
}

/** 递归列目录下所有文件（相对路径）；失败返回空数组（目录不存在是正常状态）。 */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const full = path.join(dir, name)
    const rel = prefix === '' ? name : `${prefix}/${name}`
    let stat
    try {
      stat = await fs.stat(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) out.push(...await listFiles(full, rel))
    else out.push(rel)
  }
  return out
}

/** 读一个技能目录/扁平文件，规范化成 SkillEntry。 */
async function readEntry(root: string, name: string, kind: SkillKind, staged: boolean): Promise<SkillEntry> {
  const rel = kind === 'bundle' ? `${name}/SKILL.md` : `${name}.md`
  const full = path.join(root, rel)
  const base: Omit<SkillEntry, 'description' | 'whenToUse' | 'policy' | 'metadata' | 'body' | 'error' | 'bytes' | 'mtime' | 'scripts'> = {
    name, kind, path: rel, staged,
  }
  let text: string
  let stat
  try {
    stat = await fs.stat(full)
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      return { ...base, description: '', whenToUse: '', policy: null, metadata: {}, body: '', bytes: stat.size, mtime: stat.mtimeMs, scripts: [], error: `SKILL.md 超过 ${MAX_SKILL_FILE_BYTES} 字节` }
    }
    text = await fs.readFile(full, 'utf8')
  } catch (error) {
    return { ...base, description: '', whenToUse: '', policy: null, metadata: {}, body: '', bytes: 0, mtime: 0, scripts: [], error: `读取失败：${(error as Error).message}` }
  }
  const scripts = kind === 'bundle' ? await listFiles(path.join(root, name, 'scripts')) : []
  const parsed = parseSkillFile(text, kind === 'bundle' ? name : undefined)
  if (!parsed.ok) {
    return { ...base, description: '', whenToUse: '', policy: null, metadata: {}, body: '', bytes: stat.size, mtime: stat.mtimeMs, scripts, error: `${parsed.error.field}：${parsed.error.message}` }
  }
  const skill = parsed.skill
  return {
    ...base,
    description: skill.description,
    whenToUse: skill.whenToUse,
    policy: skill.policy,
    metadata: skill.metadata,
    body: skill.body,
    bytes: stat.size,
    mtime: stat.mtimeMs,
    scripts,
    error: skill.name !== name && kind === 'flat' ? `name 与文件名不一致（文件 ${name}，里面是 ${skill.name}）` : '',
  }
}

/** 扫描一个根：主目录 + 可选待审区。坏文件保留在结果里（`error` 非空）。 */
export async function scanSkills(root: string, options: { readonly staged?: boolean } = {}): Promise<SkillEntry[]> {
  const out: SkillEntry[] = []
  const readDirSafely = async (dir: string): Promise<string[]> => {
    try { return await fs.readdir(dir) } catch { return [] }
  }
  for (const name of await readDirSafely(root)) {
    if (name.startsWith('.')) continue
    const full = path.join(root, name)
    let stat
    try { stat = await fs.stat(full) } catch { continue }
    if (stat.isDirectory()) {
      const entry = await readEntry(root, name, 'bundle', false)
      out.push(entry)
    } else if (name.endsWith('.md')) {
      const base = name.slice(0, -3)
      if (!isValidSkillName(base)) continue
      out.push(await readEntry(root, base, 'flat', false))
    }
  }
  if (options.staged === true) {
    const stagingRoot = path.join(root, '.staging')
    for (const name of await readDirSafely(stagingRoot)) {
      if (name.startsWith('.')) continue
      const full = path.join(stagingRoot, name)
      let stat
      try { stat = await fs.stat(full) } catch { continue }
      if (stat.isDirectory()) {
        out.push(await readEntry(stagingRoot, name, 'bundle', true))
      } else if (name.endsWith('.md')) {
        const base = name.slice(0, -3)
        if (!isValidSkillName(base)) continue
        out.push(await readEntry(stagingRoot, base, 'flat', true))
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || Number(a.staged) - Number(b.staged))
}

/** 读一份技能正文（provider 的 `get` 走它）。 */
export async function readSkillBody(root: string, name: string, kind: SkillKind): Promise<string | null> {
  const rel = kind === 'bundle' ? `${name}/SKILL.md` : `${name}.md`
  try {
    const text = await fs.readFile(path.join(root, rel), 'utf8')
    const parsed = parseSkillFile(text, kind === 'bundle' ? name : undefined)
    return parsed.ok ? parsed.skill.body : null
  } catch {
    return null
  }
}

/** 写入/覆盖一份技能（目录包形态；扁平技能写入时也升级成目录包）。 */
export async function writeSkill(root: string, input: SkillFileInput): Promise<SkillEntry> {
  const dir = safeJoin(root, input.name)
  await fs.mkdir(dir, { recursive: true })
  const text = serializeSkillFile(input)
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_FILE_BYTES) throw new Error('SKILL.md 太大')
  await atomicWriteFile(path.join(dir, 'SKILL.md'), text)
  // 同名的扁平文件会让 provider 看到两个同名候选；写目录包时清掉它。
  await fs.rm(path.join(root, `${input.name}.md`), { force: true }).catch(() => {})
  return await readEntry(root, input.name, 'bundle', false)
}

/** 删除一份技能（目录包或扁平文件）。 */
export async function removeSkill(root: string, name: string, staged = false): Promise<void> {
  const base = staged ? path.join(root, '.staging') : root
  const target = safeJoin(base, name)
  await fs.rm(target, { recursive: true, force: true })
  await fs.rm(path.join(base, `${name}.md`), { force: true }).catch(() => {})
}

/** 导入：先落到待审区，返回解析结果（坏文件也给出来，管理员能看到原因）。 */
export async function stageSkill(
  root: string,
  files: ReadonlyArray<{ readonly path: string; readonly content: string | Buffer }>,
): Promise<SkillEntry> {
  const main = files.find((file) => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'))
  if (main === undefined) throw new Error('导入包里没有 SKILL.md')
  const text = typeof main.content === 'string' ? main.content : main.content.toString('utf8')
  const parsed = parseSkillFile(text)
  if (!parsed.ok) throw new Error(`SKILL.md 不合法（${parsed.error.field}）：${parsed.error.message}`)
  const name = parsed.skill.name
  if (!isValidSkillName(name)) throw new Error(`技能名不合法：${name}`)
  const stagingRoot = path.join(root, '.staging')
  const dir = safeJoin(stagingRoot, name)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  const prefix = main.path === 'SKILL.md' ? '' : main.path.slice(0, -'SKILL.md'.length)
  let total = 0
  for (const file of files) {
    const rel = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path
    if (rel === '' || rel.includes('..') || path.isAbsolute(rel)) continue
    const bytes = typeof file.content === 'string' ? Buffer.byteLength(file.content, 'utf8') : file.content.length
    total += bytes
    if (total > MAX_BUNDLE_BYTES) throw new Error(`导入包超过 ${MAX_BUNDLE_BYTES} 字节`)
    const target = path.join(dir, rel)
    if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) continue
    await fs.mkdir(path.dirname(target), { recursive: true })
    await atomicWriteFile(target, file.content)
  }
  // 待审技能默认不启用：管理员确认后才移进主目录（`promoteStaged`）。
  return await readEntry(stagingRoot, name, 'bundle', true)
}

/** 把待审技能转正（覆盖同名主目录技能）。 */
export async function promoteStaged(root: string, name: string): Promise<void> {
  const stagingRoot = path.join(root, '.staging')
  const source = safeJoin(stagingRoot, name)
  const target = safeJoin(root, name)
  await fs.rm(target, { recursive: true, force: true })
  await fs.rename(source, target)
  await fs.rm(path.join(stagingRoot, `${name}.md`), { force: true }).catch(() => {})
}

/** 解析结果转成写入入参（后台编辑用）。 */
export function inputOf(skill: SkillDoc, patch: Partial<SkillFileInput> = {}): SkillFileInput {
  return {
    name: patch.name ?? skill.name,
    description: patch.description ?? skill.description,
    whenToUse: patch.whenToUse ?? skill.whenToUse,
    body: patch.body ?? skill.body,
    metadata: patch.metadata ?? skill.metadata,
    policy: patch.policy ?? skill.policy,
  }
}
