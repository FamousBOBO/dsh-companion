/** 后台「技能」页的数据面：列表、新建/编辑、删除、导入、待审转正。
 *
 * 写操作只落在技能仓库（`dshHome` 下），**不碰工作区**；所有名字先过
 * `isValidSkillName` 与 `safeJoin`，避免 `../../` 这类路径逃逸。
 */

import type { AdminResource } from '../../admin/types.js'
import type { SkillsConfig } from '../../config/sections/skills.js'
import { systemHttp } from '../../adapters/http/client.js'
import type { SkillPolicy, SkillVisibility } from '../../core/skills/model.js'
import {
  promoteStaged, readSkillBody, removeSkill, safeJoin, scanSkills, stageSkill, writeSkill,
  type SkillEntry,
} from './store.js'
import type { SkillStats } from './stats.js'

/** 后台一条技能（不含正文，正文按需 `read`）。 */
function summarize(entry: SkillEntry): Record<string, unknown> {
  return {
    name: entry.name,
    staged: entry.staged,
    kind: entry.kind,
    path: entry.path,
    description: entry.description,
    whenToUse: entry.whenToUse,
    policy: entry.policy,
    scripts: entry.scripts,
    bytes: entry.bytes,
    mtime: entry.mtime,
    error: entry.error,
    source: entry.policy?.source ?? '',
  }
}

const VISIBILITIES: ReadonlySet<string> = new Set(['all', 'none', 'dm', 'groups', 'rooms'])

/** 从请求体读一份策略（缺省沿用 `base`）。 */
export function policyFromBody(body: Record<string, unknown>, base: SkillPolicy): SkillPolicy {
  const raw = String(body.visibility ?? base.visibility).trim().toLowerCase()
  const visibility: SkillVisibility = VISIBILITIES.has(raw) ? (raw as SkillVisibility) : base.visibility
  const roomsRaw = body.rooms
  const rooms = Array.isArray(roomsRaw)
    ? roomsRaw.map((item) => String(item).trim().toLowerCase())
    : String(roomsRaw ?? base.rooms.join(',')).split(',')
  return {
    visibility,
    rooms: rooms.filter((room) => /^(group|dm)-\d+$/.test(room)),
    adminsOnly: body.adminsOnly === undefined ? base.adminsOnly : body.adminsOnly === true,
    enabled: body.enabled === undefined ? base.enabled : body.enabled === true,
    allowScripts: body.allowScripts === undefined ? base.allowScripts : body.allowScripts === true,
    source: String(body.source ?? base.source),
  }
}

/** GitHub 的 blob 链接 → raw 链接（其余 URL 原样）。 */
export function rawUrlOf(url: string): string {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(url)
  if (match === null) return url
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`
}

/** 资源依赖。 */
export interface SkillResourceDeps {
  readonly root: string
  readonly config: () => SkillsConfig
  readonly log: (line: string) => void
  /** 使用计数（可选：后台仍能工作，只是不显示次数）。 */
  readonly stats?: SkillStats
}

/** GitHub 目录链接。 */
const GITHUB_TREE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/

/** 多文件导入：先落待审区。 */
function importFiles(deps: SkillResourceDeps, files: Array<{ path?: unknown; content?: unknown }>): Promise<SkillEntry> {
  if (!deps.config().allowImport) throw new Error('导入已在配置里关闭')
  const normalized = files
    .map((file) => ({ path: String(file.path ?? ''), content: String(file.content ?? '') }))
    .filter((file) => file.path !== '')
  return stageSkill(deps.root, normalized)
}

/** 新建或覆盖一个技能。 */
async function saveSkill(
  deps: SkillResourceDeps,
  body: Record<string, unknown>,
  find: (name: string, staged: boolean) => Promise<SkillEntry | undefined>,
): Promise<SkillEntry> {
  const name = String(body.name ?? '').trim()
  if (name === '') throw new Error('缺少技能名')
  const existing = await find(name, false)
  const basePolicy: SkillPolicy = existing?.policy ?? {
    visibility: 'all', rooms: [], adminsOnly: false, enabled: true, allowScripts: false, source: '',
  }
  const entry = await writeSkill(deps.root, {
    name,
    description: String(body.description ?? existing?.description ?? '').trim(),
    whenToUse: String(body.whenToUse ?? existing?.whenToUse ?? '').trim(),
    body: String(body.body ?? existing?.body ?? '').trim(),
    metadata: existing?.metadata ?? {},
    policy: policyFromBody(body, basePolicy),
  })
  deps.log(`skills: saved ${name}`)
  return entry
}

/** GitHub 目录导入：递归列文件并逐个下载（只支持公开仓库，最多 200 个文件）。 */
async function importGithubDir(deps: SkillResourceDeps, owner: string, repo: string, ref: string, dir: string): Promise<SkillEntry> {
  const files: Array<{ path: string; content: string }> = []
  let total = 0
  const walk = async (relative: string): Promise<void> => {
    const api = `https://api.github.com/repos/${owner}/${repo}/contents/${relative}?ref=${ref}`
    const response = await systemHttp.request(api, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-channel-qq/skills' },
      timeoutMs: 20_000,
      limit: 1024 * 1024,
    })
    if (!response.ok) throw new Error(`GitHub 目录读取失败 HTTP ${response.status}`)
    const entries = JSON.parse(response.text()) as Array<{ type?: string; name?: string; path?: string; size?: number; download_url?: string }>
    for (const entry of entries) {
      if (entry.type === 'dir') { await walk(entry.path ?? relative); continue }
      if (entry.type !== 'file' || typeof entry.download_url !== 'string' || entry.download_url === '') continue
      if (files.length >= 200) throw new Error('目录里文件过多（上限 200）')
      const file = await systemHttp.request(entry.download_url, { timeoutMs: 20_000, limit: deps.config().maxImportBytes })
      if (!file.ok) throw new Error(`下载 ${entry.path} 失败 HTTP ${file.status}`)
      const content = file.text()
      total += Buffer.byteLength(content, 'utf8')
      if (total > deps.config().maxImportBytes) throw new Error('导入包超过大小上限')
      // 去掉仓库里技能目录之上的前缀，staging 里从 SKILL.md 开始。
      const prefix = dir === '' ? '' : `${dir}/`
      const path = (entry.path ?? '').startsWith(prefix) ? (entry.path ?? '').slice(prefix.length) : (entry.name ?? '')
      files.push({ path, content })
    }
  }
  await walk(dir)
  const entry = await stageSkill(deps.root, files)
  deps.log(`skills: staged ${entry.name} from github ${owner}/${repo}/${dir}`)
  return entry
}

/** 从 URL 拉一份 SKILL.md（或 GitHub 目录）到待审区。 */
async function importUrl(deps: SkillResourceDeps, url: string): Promise<SkillEntry> {
  if (!deps.config().allowImport) throw new Error('导入已在配置里关闭')
  if (!/^https?:\/\//.test(url)) throw new Error('只支持 http(s) 链接')
  const tree = GITHUB_TREE.exec(url)
  if (tree !== null) {
    return await importGithubDir(deps, tree[1] ?? '', tree[2] ?? '', tree[3] ?? '', tree[4] ?? '')
  }
  const response = await systemHttp.request(rawUrlOf(url), {
    headers: { accept: 'text/plain, text/markdown, */*', 'user-agent': 'dsh-channel-qq/skills' },
    timeoutMs: 20_000,
    limit: deps.config().maxImportBytes,
  })
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
  // 只取单文件：GitHub 目录/压缩包请解开后在「多文件导入」里粘贴。
  const entry = await stageSkill(deps.root, [{ path: 'SKILL.md', content: response.text() }])
  deps.log(`skills: staged from url ${url}`)
  return entry
}

/** 资源动作（后台按钮走 `/api/action/<name>`）。 */
function actionsOf(
  deps: SkillResourceDeps,
  find: (name: string, staged: boolean) => Promise<SkillEntry | undefined>,
): Record<string, (body: unknown) => Promise<unknown>> {
const actions: Record<string, (body: unknown) => Promise<unknown>> = {
  read: async (body) => {
    const record = body as Record<string, unknown>
    const name = String(record.name ?? '')
    const entry = await find(name, record.staged === true)
    if (entry === undefined) throw new Error(`没有技能 ${name}`)
    return { ...summarize(entry), body: entry.body }
  },
  promote: async (body) => {
    const name = String((body as Record<string, unknown>).name ?? '')
    safeJoin(deps.root, name)
    await promoteStaged(deps.root, name)
    deps.log(`skills: promoted ${name}`)
    return { name, staged: false }
  },
  discard: async (body) => {
    const name = String((body as Record<string, unknown>).name ?? '')
    await removeSkill(deps.root, name, true)
    return { name }
  },
  importUrl: async (body) => summarize(await importUrl(deps, String((body as Record<string, unknown>).url ?? '').trim())),
  toggle: async (body) => {
    const record = body as Record<string, unknown>
    const name = String(record.name ?? '')
    const entry = await find(name, false)
    if (entry === undefined || entry.policy === null) throw new Error(`没有可切换的技能 ${name}`)
    const saved = await writeSkill(deps.root, {
      name,
      description: entry.description,
      whenToUse: entry.whenToUse,
      body: entry.body,
      metadata: entry.metadata,
      policy: { ...entry.policy, enabled: record.enabled !== false },
    })
    return summarize(saved)
  },
  body: async (body) => {
    const record = body as Record<string, unknown>
    const name = String(record.name ?? '')
    const base = record.staged === true ? `${deps.root}/.staging` : deps.root
    return { name, content: await readSkillBody(base, name, 'bundle') ?? '' }
  },
}
  return actions
}

/** 资源实现。 */
export function skillsResource(deps: SkillResourceDeps): AdminResource {
  const scan = async (): Promise<SkillEntry[]> => await scanSkills(deps.root, { staged: true })
  const find = async (name: string, staged: boolean): Promise<SkillEntry | undefined> =>
    (await scan()).find((entry) => entry.name === name && entry.staged === staged)

  return {
    label: '技能',
    list: async () => {
      const uses = deps.stats === undefined ? {} : await deps.stats.all()
      return {
        root: deps.root,
        allowScripts: deps.config().allowScripts,
        allowImport: deps.config().allowImport,
        skills: (await scan()).map((entry) => ({ ...summarize(entry), uses: uses[entry.name] ?? null })),
      }
    },
    create: async (body) => {
      const record = body as Record<string, unknown>
      if (Array.isArray(record.files)) {
        if (record.staged === false) throw new Error('导入一律先进待审区')
        return summarize(await importFiles(deps, record.files as Array<{ path?: unknown; content?: unknown }>))
      }
      return summarize(await saveSkill(deps, record, find))
    },
    remove: async (id) => {
      const name = id.trim()
      await removeSkill(deps.root, name, false)
      await removeSkill(deps.root, name, true)
      deps.log(`skills: removed ${name}`)
      return { name }
    },
    actions: actionsOf(deps, find),
  }
}
