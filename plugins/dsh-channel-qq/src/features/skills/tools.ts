/** `qq_skill`：按当前房间可见范围列出/加载技能。
 *
 * 为什么需要这个工具：宿主的 `skill` 工具只认识**全局可见**的技能（它们的描述进
 * 每个房间的提示词）。范围受限的技能不能进那份目录——否则描述本身就泄露了。
 * 模型想用这类技能时，先 `qq_skill list` 看这个房间有什么，再 `qq_skill load`。
 *
 * 可见性在**调用这一刻**现算（`viewerOf` + `skillVisibleTo`），所以后台改范围
 * 或改群，下一句消息就生效。
 */

import { skillVisibleTo } from '../../core/skills/model.js'
import { viewerOf } from './viewer.js'
import type { SkillEntry } from './store.js'
import type { ToolSpec, ToolRunContext } from '../../adapters/dsh-host/tools.js'

/** 工具依赖：给一份"现在磁盘上有什么"+ 现取的配置。 */
export interface SkillToolDeps {
  readonly entries: () => Promise<readonly SkillEntry[]>
  /** 单个技能正文里要不要附带 scripts 说明（全局开关 && 技能自己的开关）。 */
  readonly scriptsAllowed: (entry: SkillEntry) => boolean
  readonly resourceDir: string
  /** 现取管理员名单（可见范围里的「仅管理员」要用）。 */
  readonly admins: () => readonly number[]
  /** 加载成功后的计数回调（后台「技能」页看使用次数）。 */
  readonly onLoad?: (name: string) => void
  readonly log: (line: string) => void
}

/** 可见性的一句话说明。 */
export function describePolicy(entry: SkillEntry): string {
  const policy = entry.policy
  if (policy === null) return '策略未解析'
  const scope = policy.visibility === 'all' ? '所有房间'
    : policy.visibility === 'none' ? '未启用'
      : policy.visibility === 'dm' ? '仅私聊'
        : policy.rooms.length === 0 ? '未指定房间' : policy.rooms.join(', ')
  return `${scope}${policy.adminsOnly ? '（仅管理员）' : ''}`
}

/** 把一份技能渲染成模型读得懂的加载结果。 */
export function renderLoad(entry: SkillEntry, deps: SkillToolDeps): string {
  const header = [
    `# 技能：${entry.name}`,
    entry.description,
    entry.whenToUse === '' ? '' : `适用时机：${entry.whenToUse}`,
    `可见范围：${describePolicy(entry)}`,
  ].filter((line) => line !== '')
  const scripts = entry.scripts.length > 0
    ? deps.scriptsAllowed(entry)
      ? `\n脚本目录：${deps.resourceDir}/${entry.name}/scripts/（可直接用 bash 执行）`
      : '\n注意：这个技能带 scripts/，但当前部署不允许执行技能脚本；只按正文说明做。'
    : ''
  return `${header.join('\n')}${scripts}\n\n${entry.body}`
}

/** 取当前视角下可见且可用的技能（坏文件、未通过校验的不给模型）。 */
export function visibleEntries(
  entries: readonly SkillEntry[],
  viewer: Parameters<typeof skillVisibleTo>[1],
): SkillEntry[] {
  return entries.filter((entry) => entry.staged !== true
    && entry.error === ''
    && entry.policy !== null
    && skillVisibleTo(entry.policy, viewer))
}

/** `qq_skill` 的 spec。 */
export function skillTools(deps: SkillToolDeps): ToolSpec[] {
  return [{
    name: 'qq_skill',
    description: '查看并加载当前房间可用的技能（skill）。action=list 列出名字与用途；action=load 按名字取完整说明。'
      + '用户说「/技能名」或任务明显匹配某个技能时，先 list 再 load，然后照说明做。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'load'], description: 'list=列目录；load=加载一个技能' },
        name: { type: 'string', description: 'action=load 时的技能名' },
      },
      required: ['action'],
    },
    run: async (args, context?: ToolRunContext) => {
      // 会话 id 由宿主 `exec.agent.id` 透传（见 adapters/dsh-host/tools.ts）。
      const sessionId = context?.agentId
      const viewer = sessionId === undefined
        ? { room: null, userId: null, isAdmin: false, admins: deps.admins() }
        : viewerOf(sessionId, deps.admins())
      const entries = visibleEntries(await deps.entries(), viewer)
      if (String(args.action) === 'list') {
        return {
          count: entries.length,
          skills: entries.slice(0, 50).map((entry) => ({
            name: entry.name,
            description: entry.description,
            whenToUse: entry.whenToUse,
            visibility: describePolicy(entry),
            scripts: entry.scripts.length > 0 && deps.scriptsAllowed(entry),
          })),
          note: entries.length === 0 ? '当前房间没有可用技能。' : '要加载就调用 qq_skill load。',
        }
      }
      const name = String(args.name ?? '').trim()
      if (name === '') throw new Error('action=load 需要 name')
      const entry = entries.find((item) => item.name === name)
      if (entry === undefined) {
        throw new Error(`当前房间没有可用的技能 "${name}"（先用 action=list 看有哪些）`)
      }
      deps.log(`skills: load ${name}`)
      deps.onLoad?.(name)
      return { name: entry.name, content: renderLoad(entry, deps) }
    },
  }]
}
