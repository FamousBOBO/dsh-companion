/** 人物档工具面：`qq_person_note` 记线索 / 查档案 / 列档案。
 *
 * 默认关：`people.enabled` 为 false 时不注册工具（golden 工具快照不含它）。
 * room 解析：显式参数优先；否则从当前会话 id 推当前窗口；推不出就用全局档案。
 * 显式 room 必须是 `group-<号>` / `dm-<号>`——它直接进文件路径。
 */

import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQChannelConfig } from '../../config.js'
import { appendPersonNote, isRoom, listPeople, readPerson, today, type PersonFile } from './store.js'

interface PeopleToolContext {
  agentId?: string
}

/** 从会话 id 推房间键（`qq-group-123` → `group-123`），推不出返回空串。 */
function roomFromAgentId(agentId: string | undefined): string {
  if (agentId === undefined) return ''
  const room = agentId.startsWith('qq-') ? agentId.slice('qq-'.length) : agentId
  return isRoom(room) ? room : ''
}

function listPayload(people: PersonFile[]): Record<string, unknown> {
  return {
    count: people.length,
    people: people.slice(0, 20).map((p) => ({
      qq: p.qq,
      nick: p.nick,
      notes: p.notes.length,
      latest: p.notes.at(-1)?.note ?? '',
    })),
  }
}

export function registerPeopleTools(ctx: ToolHost, config: QQChannelConfig, log: (line: string) => void): () => void {
  if (config.people.enabled !== true) return () => {}
  return registerSpecs(ctx, [personNote(config, log)], log, 'people')
}

function personNote(config: QQChannelConfig, log: (line: string) => void): ToolSpec {
  const dir = config.people.dir ?? `${config.workspacePath ?? ''}/people`
  return {
    name: 'qq_person_note',
    description: '人物档（手动笔记）：记认人的线索（谁爱用什么说法、谁的话带着刺、忌讳什么），或翻某个人的档案。action=get 查一个，set 追加一条，list 看谁记得最多。只记怎么看这个人，不记事实性证据；与自动侧写互补。',
    parameters: params({
      action: { type: 'string', enum: ['get', 'set', 'list'], description: 'get / set / list' },
      target: { type: 'number', description: '对方的 QQ 号（get 与 set 必填）' },
      nick: { type: 'string', description: '昵称或群名片，set 时一并更新' },
      note: { type: 'string', description: '一句话，具体些：爱用反问、忌讳被叫全名' },
      moment: { type: 'string', description: '可选：产生这条印象的具体瞬间（当场那句话/那件事），写上才像日记不像档案' },
      room: { type: 'string', description: '哪间房的档案，如 group-1000000004 / dm-1000000007；不填按当前窗口' },
    }, ['action']),
    run: async (args, ctx) => {
      const action = String(args.action)
      const explicit = String(args.room ?? '').trim()
      if (explicit !== '' && !isRoom(explicit)) {
        return { ok: false, error: `room 只认 group-<号> / dm-<号>，收到：${explicit}` }
      }
      const room = explicit !== '' ? explicit : roomFromAgentId(((ctx ?? {}) as PeopleToolContext).agentId)
      const scoped = room === '' ? undefined : room
      if (action === 'list') {
        return listPayload(await listPeople(dir, scoped))
      }
      const target = Number(args.target)
      if (!Number.isFinite(target) || target <= 0) return { ok: false, error: '要一个有效的 QQ 号' }
      if (action === 'get') {
        const file = await readPerson(dir, target, scoped)
        if (file === null) return { ok: true, found: false, qq: target, room }
        return { ok: true, found: true, qq: target, room, nick: file.nick, notes: file.notes }
      }
      if (action !== 'set') return { ok: false, error: `action 只认 get/set/list，收到：${action}` }
      const note = String(args.note ?? '').trim()
      if (note === '') return { ok: false, error: 'note 不能空' }
      const nick = String(args.nick ?? '').trim()
      const moment = args.moment === undefined ? undefined : String(args.moment)
      const written = await appendPersonNote(dir, target, nick, note, today(), scoped, moment)
      if (written) log(`person note: ${target} +1`)
      return { ok: true, written, qq: target, day: today() }
    },
  }
}
