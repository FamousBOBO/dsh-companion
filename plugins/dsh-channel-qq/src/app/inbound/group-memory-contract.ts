/** 群聊记忆的**消费端契约**（P1 §5.1 / §5.2）：群体记忆、成员记忆、短期话题状态。
 *
 * 三层分工（这是 P1 的核心结构，改动前先读）：
 *
 *   A. Group Memory   按 `groupId` 隔离：群内长期话题、共同经历、已经形成的梗与约定。
 *   B. Member Memory  按 `groupId + memberId` 隔离：成员主动表达过的兴趣、说话习惯、和她的互动。
 *   C. Topic State    按群维护的**短期工作记忆**：话题是什么、谁起的头、谁在参与、什么时候该过期。
 *
 * 三条硬规矩：
 *   1. **作用域缺失就丢弃**：任何一条证据没有 `groupId`（成员记忆还要有 `memberId`）就直接扔掉，
 *      不猜、不"补一个当前的群号"——那正是串群事故的起点（§7.1）。
 *   2. **推测不是事实**（`kind: 'guess'`）：它可以进提示词，但必须**单独成段**并明写"不许当事实说"。
 *      把推测混进事实顺序里，模型会用确定口吻说出来，而这正是"一次玩笑被写成确定画像"。
 *   3. **预算优先**：召回结果总量有上限（§5.4 建议 600–800 中文字符）。超了从推测开始丢，
 *      再丢成员记忆，最后才动群体记忆——顺序反了就会变成"只记得陌生人"。
 *
 * 为什么契约放在 `app/`（消费端）而不是 `adapters/`：`app/` 不许 import `adapters/`（分层 R8），
 * 端口类型由**消费者**声明，适配器只负责实现它——与 `presence-flow.ts` 里 `CompletePort` 同一个道理。
 */

/** 一条记忆证据的类别：他自己的明确表达 / 你观察到的 / 只是推测。 */
export type MemoryKind = 'explicit' | 'observed' | 'guess'

/** 一条记忆证据。 */
export interface GroupMemoryEvidence {
  /** 群体记忆还是成员记忆（同一条文本在不同维度下可信度不同，渲染也要分开）。 */
  readonly scope: 'group' | 'member'
  readonly groupId: number
  /** 成员记忆才有。 */
  readonly memberId?: number
  readonly content: string
  readonly kind: MemoryKind
  /** 置信度（0–1）；`guess` 一般低。 */
  readonly confidence: number
  /** 来源消息号（可追溯；空数组的证据在归一化阶段就被丢弃）。 */
  readonly sourceMessageIds: readonly number[]
  /** 写入时刻（毫秒）。 */
  readonly createdAt: number
}

/** 短期话题状态（会过期，不进长期记忆）。 */
export interface TopicSnapshot {
  readonly topic: string
  /** 谁起的头（昵称或 QQ 号，空串 = 不知道）。 */
  readonly startedBy: string
  /** 正在参与的成员 QQ 号。 */
  readonly participants: readonly number[]
  /** 最近一次有效推进的时刻（毫秒）。 */
  readonly lastAdvanceAtMs: number
}

/** 一次召回的完整结果（缺哪个就是哪个没有，不是错误）。 */
export interface GroupMemoryRecall {
  readonly group: readonly GroupMemoryEvidence[]
  readonly member: readonly GroupMemoryEvidence[]
  readonly topic: TopicSnapshot | null
  /** 被丢掉的原因（进日志/诊断；不含正文）。 */
  readonly dropped: readonly string[]
}

/** 空结果：记忆服务不可用、或这个群还没积累到任何证据时的**正常**返回值。 */
export const EMPTY_RECALL: GroupMemoryRecall = Object.freeze({ group: [], member: [], topic: null, dropped: [] })

/** 按码点截断（emoji 不算两个字）。 */
export function clipChars(text: string, limit: number): string {
  const chars = [...text]
  return chars.length <= limit ? text : chars.slice(0, limit).join('')
}

/**
 * id 归一化：**数字串也认**，别的一律 0（= 不可用）。
 *
 * 为什么要有这一条：存储侧（foundation 的 group-memory）把 `group_id`/`member_id` 存成 TEXT
 * ——SQLite 里 QQ 号用 19 位整数有溢出风险，用文本是**对的**。跨插件边界时形状不可信
 * （2026-11-08 实测：消费端按 number 判，会把每一条都当"没有群号"丢掉，表现为"记忆一直为空"）。
 * 所以这里既接受 number 也接受纯数字串，认不出来一律当没有——绝不猜。
 */
export function idOf(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d{1,20}$/.test(value.trim())) {
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
  }
  return 0
}

/** 一条证据能不能用：缺作用域 / 缺来源 / 空正文 / 超长里任一条成立就丢。 */
function usable(raw: GroupMemoryEvidence): string | null {
  if (idOf(raw.groupId) === 0) return 'no-group'
  if (raw.scope === 'member' && idOf(raw.memberId) === 0) return 'no-member'
  // 没有来源消息的证据不可追溯：宁可不用（§5.3「写入时保留来源消息 ID」的另一半）。
  if (!Array.isArray(raw.sourceMessageIds) || raw.sourceMessageIds.length === 0) return 'no-source'
  if (typeof raw.content !== 'string' || raw.content.trim() === '') return 'empty-content'
  return null
}

/** 置信度夹到 [0,1]；非数字给 0（它只影响排序，不影响可见性）。 */
function confidenceOf(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/**
 * 归一化一次召回结果（**结构类型**：端口可能来自另一个插件行，形状不可信）。
 *
 * 这里的取舍都是"宁可少知道一点"：
 *   - 作用域不对 → 丢；
 *   - 没来源 → 丢；
 *   - 正文超长 → 截断（记忆正文是长句的机会大，直接丢会损失很多有效信息）；
 *   - `guess` 的置信度上限压到 0.4：它永远排在后面，不会挤掉明确事实。
 */
export function normalizeRecall(
  raw: unknown,
  { groupId, memberIds = [], budgetChars = 800 }: { groupId: number; memberIds?: readonly number[]; budgetChars?: number },
): GroupMemoryRecall {
  if (raw === null || typeof raw !== 'object') return EMPTY_RECALL
  const shape = raw as { group?: unknown; member?: unknown; topic?: unknown }
  const dropped: string[] = []
  const keep = (list: unknown, scope: 'group' | 'member'): GroupMemoryEvidence[] => {
    if (!Array.isArray(list)) return []
    const out: GroupMemoryEvidence[] = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') {
        dropped.push('not-object')
        continue
      }
      const evidence = item as GroupMemoryEvidence
      const problem = usable(evidence)
      if (problem !== null) {
        dropped.push(problem)
        continue
      }
      // 逐条再核对一次作用域：**别处**群的证据一律不信（不是"这个群优先"，是直接丢）。
      const evidenceGroup = idOf(evidence.groupId)
      if (evidenceGroup !== idOf(groupId)) {
        dropped.push('cross-group')
        continue
      }
      const evidenceMember = idOf(evidence.memberId)
      if (scope === 'member' && !memberIds.includes(evidenceMember)) {
        dropped.push('other-member')
        continue
      }
      const kind: MemoryKind = evidence.kind === 'explicit' || evidence.kind === 'observed' ? evidence.kind : 'guess'
      out.push({
        scope,
        groupId: idOf(groupId),
        ...(scope === 'member' ? { memberId: evidenceMember } : {}),
        content: clipChars(String(evidence.content ?? '').replace(/\s+/g, ' ').trim(), 120),
        kind,
        confidence: kind === 'guess' ? Math.min(0.4, confidenceOf(Number(evidence.confidence))) : confidenceOf(Number(evidence.confidence)),
        // 来源消息号同样可能是字符串（存储侧 TEXT）；认不出来的丢掉，而不是塞一个 0。
        sourceMessageIds: (Array.isArray(evidence.sourceMessageIds) ? evidence.sourceMessageIds : [])
          .map((id) => idOf(id))
          .filter((id) => id > 0),
        createdAt: Number.isFinite(Number(evidence.createdAt)) ? Number(evidence.createdAt) : 0,
      })
    }
    // 明确事实在前、推测在后；同档按置信度降序（稳定排序，同分保持写入顺序）。
    return out.sort((a, b) => {
      const rank = (kind: MemoryKind): number => (kind === 'guess' ? 2 : (kind === 'observed' ? 1 : 0))
      const byKind = rank(a.kind) - rank(b.kind)
      return byKind !== 0 ? byKind : b.confidence - a.confidence
    })
  }
  const topic = topicOf(shape.topic, groupId, dropped)
  const group = keep(shape.group, 'group')
  const member = keep(shape.member, 'member')
  return budget({ group, member, topic, dropped: [...dropped] }, budgetChars)
}

/** 话题状态：缺群的、空的、过期的都不算。 */
function topicOf(raw: unknown, groupId: number, dropped: string[]): TopicSnapshot | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const shape = raw as Record<string, unknown>
  if (shape['groupId'] !== undefined && shape['groupId'] !== groupId) {
    dropped.push('topic-cross-group')
    return null
  }
  const topic = typeof shape['topic'] === 'string' ? shape['topic'].replace(/\s+/g, ' ').trim() : ''
  if (topic === '') return null
  return {
    topic: clipChars(topic, 60),
    startedBy: typeof shape['startedBy'] === 'string' ? clipChars(shape['startedBy'].trim(), 40) : '',
    participants: Array.isArray(shape['participants'])
      ? shape['participants'].filter((id): id is number => Number.isSafeInteger(id)).slice(0, 20)
      : [],
    lastAdvanceAtMs: Number.isFinite(shape['lastAdvanceAtMs']) ? Number(shape['lastAdvanceAtMs']) : 0,
  }
}

/**
 * 按预算裁剪：**先丢推测，再丢成员记忆，最后才动群体记忆**。
 *
 * 顺序反了会退化成"只记得陌生人"：群体记忆是"这个群里发生过什么"，是判断"接不接得上"的主依据，
 * 而成员记忆是补充。逐条整句丢，绝不切半句（半句记忆比没有更容易被误用）。
 */
function budget(recall: GroupMemoryRecall, budgetChars: number): GroupMemoryRecall {
  const limit = Number.isFinite(budgetChars) && budgetChars > 0 ? Math.trunc(budgetChars) : 800
  const cost = (item: GroupMemoryEvidence): number => [...item.content].length + 1
  const total = (): number => [...recall.group, ...recall.member].reduce((sum, item) => sum + cost(item), 0)
  if (total() <= limit) return recall
  const group = [...recall.group]
  const member = [...recall.member]
  const dropped = [...recall.dropped]
  const totalOf = (): number => [...group, ...member].reduce((sum, item) => sum + cost(item), 0)
  // ① 推测
  for (let i = group.length - 1; i >= 0 && totalOf() > limit; i -= 1) {
    if (group[i]?.kind === 'guess') {
      group.splice(i, 1)
      dropped.push('budget-drop-guess')
    }
  }
  for (let i = member.length - 1; i >= 0 && totalOf() > limit; i -= 1) {
    if (member[i]?.kind === 'guess') {
      member.splice(i, 1)
      dropped.push('budget-drop-guess')
    }
  }
  // ② 成员记忆（最不相关的那几条）
  while (member.length > 0 && totalOf() > limit) {
    member.pop()
    dropped.push('budget-drop-member')
  }
  // ③ 群体记忆（最后才动）
  while (group.length > 0 && totalOf() > limit) {
    group.pop()
    dropped.push('budget-drop-group')
  }
  return { group, member, topic: recall.topic, dropped }
}

/** 一条证据的渲染文本（`kind` 决定口吻；渲染层不许自己改这个判断）。 */
export function evidenceLine(evidence: GroupMemoryEvidence): string {
  const kind = evidence.kind === 'explicit'
    ? '他明确说过'
    : (evidence.kind === 'observed' ? '你观察到的' : '只是你的推测，别当事实说')
  return `- [${kind}] ${evidence.content}`
}
