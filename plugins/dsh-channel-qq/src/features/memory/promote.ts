/** 记忆候选 → 技能草稿（"事实 → 方法"的显式版本，P2 自我学习闭环的一环）。
 *
 * 只接受**候选态**记录：已确认的记忆是"事实"，不该被误当成"做法"。草稿写进技能
 * 待审区，管理员确认后才启用——沿用 D4 的"候选 → 审核"，不做无人审核的自我改写。
 */

import type { SubHost } from '../plugin-kit.js'
import type { MemoryStore } from './store.js'

export async function promoteToSkill(
  host: SubHost,
  store: MemoryStore | null,
  body: unknown,
): Promise<{ ok: boolean; note: string }> {
  if (store === null) throw new Error('memory.v2 关着，没有候选可晋升')
  const input = (body !== null && typeof body === 'object' ? body : {}) as { id?: unknown; name?: unknown }
  const record = store.get(String(input.id ?? '').trim())
  if (record === undefined) throw new Error('没有这条记忆')
  if (record.status !== 'candidate') throw new Error('只有候选态记忆能晋升为技能草稿（已确认的记忆是事实，不是做法）')
  const drafts = host.get('skillDrafts')
  if (drafts === undefined) throw new Error('技能系统未启用（skills.enabled=false）')
  const name = slugOf(String(input.name ?? record.keywords[0] ?? ''))
    || `memory-${record.id.replace(/[^a-z0-9]/gi, '').slice(-8) || 'note'}`
  return await drafts.create({
    name,
    description: record.content.slice(0, 120),
    whenToUse: record.context.slice(0, 200),
    body: [
      `# ${record.content.slice(0, 60)}`,
      '',
      record.content,
      '',
      '## 来源',
      '',
      `- 记忆 id：${record.id}`,
      `- 记录时间：${new Date(record.recordedAt).toISOString().slice(0, 10)}`,
      `- 原始出处：${record.source.kind}`,
      '',
    ].join('\n'),
    source: `memory:${record.id}`,
  }).then((got) => ({ ok: true, note: got.note }))
}

/** 技能名：小写字母/数字/连字符（与 agentskills 的名字规则一致）。 */
function slugOf(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}
