/** 技能子插件：仓库管理面 + 宿主目录 + `/name` 触发 + `qq_skill` 工具。
 *
 * 四件事的分工：
 *   - **仓库**（`store.ts`）：磁盘上的 SKILL.md，后台增删改查；
 *   - **宿主目录**（provider）：只交**全局可见**的技能，模型用宿主的 `skill` 工具加载；
 *   - **触发**（`agent/pre-step`）：用户第一行 `/名字` → 按当前房间判范围后注入；
 *   - **工具**（`qq_skill`）：范围受限技能的显式入口，list/load 都按房间过滤。
 *
 * 可见范围**不缓存**：每次触发/调用都从磁盘重读 + 现算，改后台立刻生效。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { registerSpecs } from '../../adapters/dsh-host/tools.js'
import { readSkillBody, scanSkills, skillsRoot, stageSkill, type SkillEntry } from './store.js'
import { serializeSkillFile } from '../../core/skills/serialize.js'
import { skillsResource } from './resource.js'
import { SkillStats } from './stats.js'
import { skillTools, visibleEntries } from './tools.js'
import { viewerOf } from './viewer.js'
import type { SubPlugin } from '../plugin-kit.js'
import type { SkillsConfig } from '../../config/sections/skills.js'
import type { HostSkillProviderSpec, SkillTriggerHandler } from '../../ports/skills.js'

/** 触发/加载时给正文补一段资源说明（路径只在允许脚本时给出）。 */
function withResources(entry: SkillEntry, root: string, scriptsAllowed: boolean): string {
  if (entry.scripts.length === 0) return entry.body
  if (!scriptsAllowed) return `${entry.body}\n\n（这个技能带 scripts/，当前部署不允许执行技能脚本。）`
  return `${entry.body}\n\n脚本目录：${root}/${entry.name}/scripts/`
}

/** 宿主目录的 provider：只收全局可见的技能（范围受限的走 qq_skill）。 */
function buildProvider(
  entries: () => Promise<readonly SkillEntry[]>,
  root: string,
  scriptsAllowed: (entry: SkillEntry) => boolean,
  stats: SkillStats,
): HostSkillProviderSpec {
  return {
    name: 'channel-qq-skills',
    list: async () => (await entries())
      .filter((entry) => entry.error === '' && entry.policy !== null
        && entry.policy.enabled && entry.policy.visibility === 'all' && !entry.policy.adminsOnly)
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        whenToUse: entry.whenToUse,
        body: withResources(entry, root, scriptsAllowed(entry)),
      })),
    get: async (name) => {
      const entry = (await entries()).find((item) => item.name === name)
      if (entry === undefined || entry.error !== '') return null
      const body = await readSkillBody(root, name, 'bundle')
      if (body === null) return null
      void stats.record(name, 'load')
      return withResources(entry, root, scriptsAllowed(entry))
    },
    // 宿主对目录做缓存；这份签名变化时适配器会让缓存失效（后台写完/手工改文件都能生效）。
    signature: async () => (await entries())
      .map((entry) => `${entry.name}:${entry.mtime}:${entry.bytes}:${entry.error}`)
      .join('|'),
  }
}

/** `/名字` 触发：按**当前房间**判范围，与 qq_skill 用同一个 viewer。 */
function buildTrigger(
  entries: () => Promise<readonly SkillEntry[]>,
  root: string,
  scriptsAllowed: (entry: SkillEntry) => boolean,
  admins: () => readonly number[],
  stats: SkillStats,
): SkillTriggerHandler {
  return async ({ sessionId, text }) => {
    // 全文找 `/(名字)`（组包会在用户文字前拼房间指令，不能只认开头）。
    const match = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$|[，。！？,.!?])/.exec(text)
    if (match === null) return null
    const name = match[2] ?? ''
    const viewer = viewerOf(sessionId, admins())
    const entry = visibleEntries(await entries(), viewer).find((item) => item.name === name)
    if (entry === undefined) return null
    void stats.record(name, 'trigger')
    return { name, content: withResources(entry, root, scriptsAllowed(entry)) }
  }
}

export const skillsPlugin: SubPlugin = {
  name: 'skills',
  watches: ['skills'],
  async apply(host) {
    const config = host.config.skills as SkillsConfig
    const root = skillsRoot(host.dshHome, config.dir)
    await fs.mkdir(root, { recursive: true }).catch(() => {})
    const scriptsAllowed = (entry: SkillEntry): boolean =>
      config.allowScripts && entry.policy !== null && entry.policy.allowScripts
    const entries = async (): Promise<readonly SkillEntry[]> => await scanSkills(root)
    const stats = new SkillStats(path.join(host.dshHome, 'channel-qq', 'skills-stats.json'), host.log)
    host.registerResource('skills', skillsResource({
      root,
      config: () => host.config.skills as SkillsConfig,
      log: host.log,
      stats,
    }))
    if (!config.enabled) {
      host.log(`skills: 已关闭（仓库 ${root} 仍可在后台管理）`)
      return
    }
    // 记忆候选 → 技能草稿：只写待审区，管理员在「技能」页确认后才进主目录。
    host.provide('skillDrafts', {
      create: async (input) => {
        if (!config.allowImport) throw new Error('技能导入已在配置里关闭（skills.allowImport）')
        const text = serializeSkillFile({
          name: input.name,
          description: input.description,
          whenToUse: input.whenToUse ?? '',
          body: input.body,
          metadata: input.source === undefined ? {} : { source: input.source },
          policy: {
            visibility: 'all', rooms: [], adminsOnly: false, enabled: true,
            allowScripts: false, source: input.source ?? 'draft',
          },
        })
        const entry = await stageSkill(root, [{ path: 'SKILL.md', content: text }])
        host.log(`skills: 草稿已入待审区 ${entry.name}`)
        return { name: entry.name, note: `已写入技能待审区（${entry.name}）——到「技能」页确认后点「启用」。` }
      },
    })
    const skillHost = host.bridge.skillsHost?.()
    const stop = skillHost?.install(
      buildProvider(entries, root, scriptsAllowed, stats),
      buildTrigger(entries, root, scriptsAllowed, () => host.config.admins, stats),
      host.log,
    )
    const stopTools = registerSpecs(host.bridge.toolHost(), skillTools({
      entries,
      scriptsAllowed,
      resourceDir: root,
      admins: () => host.config.admins,
      onLoad: (name) => { void stats.record(name, 'load') },
      log: host.log,
    }), host.log, 'skills')
    host.log(`skills: 已挂载（仓库 ${root}，${(await entries()).length} 个技能）`)
    return () => {
      stopTools()
      stop?.()
    }
  },
}
