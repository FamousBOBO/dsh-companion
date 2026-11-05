/** 人物侧写（B2）：从结构化记忆里挑出"关于这个人最该记住的几行"。
 *
 * 纯函数：给定记录与 subject id，输出 ≤5 行（每行 ≤80 字）。不做 IO、不看时钟。
 * 排序先看重要度，再看新近；被取代/归档的记录不参与。
 */

import type { MemoryRecord } from './model.js'

export interface ProfileLine {
  readonly text: string
  readonly kind: string
}

/** 只留这个人、且仍在生效的记录。 */
function matches(record: MemoryRecord, subjectId: number): boolean {
  if (record.subject.type !== 'user') return false
  if (String(record.subject.id ?? '') !== String(subjectId)) return false
  return record.status === 'active' && record.supersededBy === undefined
}

/** 一条记录的边写边排优先级：重要度优先，同分看新近。 */
export function buildProfile(records: readonly MemoryRecord[], subjectId: number, limit = 5): ProfileLine[] {
  const picked: MemoryRecord[] = []
  const seen = new Set<string>()
  for (const record of records) {
    if (!matches(record, subjectId)) continue
    const text = record.content.replace(/\s+/g, ' ').trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    picked.push(record)
  }
  picked.sort((a, b) => b.importance - a.importance || b.validFrom - a.validFrom)
  return picked.slice(0, Math.max(1, limit)).map((record) => ({
    text: record.content.replace(/\s+/g, ' ').trim().slice(0, 80),
    kind: record.kind,
  }))
}

/** 渲染成一段可注入的侧写（≤ 240 字）；没有内容返回空串。 */
export function renderProfile(name: string, lines: readonly ProfileLine[]): string {
  if (lines.length === 0) return ''
  const body = lines.map((line) => line.text).join('；')
  const text = `【关于${name}】${body}`
  return text.slice(0, 240)
}
