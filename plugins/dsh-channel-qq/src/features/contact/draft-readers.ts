/** 起草上下文的**六个分区取数**（P2.5-3D / Slice C0）：每个分区一个函数，每个都可能缺席。
 *
 * 从 `draft-context.ts` 拆出来只为一件事：**"缺什么"和"够不够起草"是两种判断**。
 * 取数这一侧的回答永远是"拿到了/没拿到 + 为什么 + 谁该补"（绝不抛、绝不编），
 * 而"能不能开口"在 `draft-context.sufficientContext` 里一条一条写清楚。
 *
 * 三条纪律（每个函数都遵守）：
 *   1. **自己 catch**：一个分区读失败只产出一条 `gap`，不能让整轮起草抛出去；
 *   2. **不编造**：没有拥有者接口的分区（未完成事项 / `mentionPolicy` / 证据 id 解析）
 *      返回空 + 一条 `*:unsupported` / `*:unresolved`，**不拿通用句子顶上**；
 *   3. **有界**：`history.collect` 是真实平台往返，用注入时钟封 3 秒；超时就当没拿到。
 */

import { withTimeout } from './send-guard.js'
import { zoneClock } from './local-time.js'
import type {
  DraftClock,
  DraftContextDeps,
  DraftContextGap,
  DraftEvidence,
  DraftHistoryPort,
  DraftLine,
  DraftMemoryEvidence,
  DraftOutbound,
  DraftPersona,
  DraftPresetRegistry,
  DraftSentLogHub,
} from './draft-context.js'
import type { ContactCandidate } from './types.js'

/** A｜人设快照（读不到 / 空串都算降级：**不静默返回一个假人设**）。 */
export async function personaOf(
  deps: DraftContextDeps,
  personaId: string,
  maxChars: number,
): Promise<{ persona: DraftPersona | null; gap: DraftContextGap | null }> {
  const ownerHint = 'adapters/dsh-host/services.ts 的 PresetRegistry（host.bridge.presetRegistry）'
  const registry: DraftPresetRegistry | undefined = deps.preset()
  if (registry === undefined) {
    return { persona: null, gap: { partition: 'persona', code: 'persona:missing', reason: '宿主没有人格预设注册表（bridge 未提供）', ownerHint } }
  }
  try {
    const doc = await registry.readDocument(personaId)
    const content = typeof doc?.content === 'string' ? doc.content.trim() : ''
    if (content === '') {
      return { persona: null, gap: { partition: 'persona', code: 'persona:empty', reason: `预设 ${personaId} 的文档是空的`, ownerHint } }
    }
    const truncated = [...content].length > maxChars
    return { persona: { personaId, document: cut(content, maxChars), truncated }, gap: null }
  } catch (error) {
    return { persona: null, gap: { partition: 'persona', code: 'persona:missing', reason: `readDocument 抛错：${describe(error)}`, ownerHint } }
  }
}

/**
 * B｜目标私聊最近对话。
 *
 * 生产上有两条"大概率空"（A2 §2.3）：`history.serverBackfill=false`（`sync` 空转）与
 * `chatlog.enabled=false`（原话簿没在写）。所以这里**先读缓存、空则强制回源一次**，
 * 回源有界（3 秒）——拿不到就是拿不到，不能让一次平台往返把 worker 的节拍拖住。
 *
 * `collect=false` 只给**发送前复核**用：那时要的是"缓存有没有变"，绝不能再打一次平台
 * （复核路径不允许有网络往返，否则一道闸就变成了新的延迟源）。
 */
export async function historyOf(
  deps: DraftContextDeps,
  candidate: ContactCandidate,
  lines: number,
  maxChars: number,
  lineChars: number,
  options: { readonly collect?: boolean } = {},
): Promise<{ history: readonly DraftLine[]; gap: DraftContextGap | null }> {
  const ownerHint = 'features/history（host.get("history")：search 读缓存，collect 回源）'
  const port = deps.get('history') as DraftHistoryPort | undefined
  if (port === undefined) {
    return { history: [], gap: { partition: 'history', code: 'history:missing', reason: '没有 history 服务（子插件未装载或装载顺序在后）', ownerHint } }
  }
  const room = candidate.target.room
  try {
    let raw = await port.search(room, {})
    if (raw.length === 0 && options.collect !== false) {
      const pull = port.collect(room, candidate.target.isGroup, candidate.target.chatId, Math.max(lines * 2, 12))
      const clock = deps.clock
      await (clock === undefined ? pull : withTimeout(clock, 3_000, async () => await pull)).catch(() => 0)
      raw = await port.search(room, {})
    }
    if (raw.length === 0) {
      return { history: [], gap: { partition: 'history', code: 'history:empty', reason: '缓存与回源都拿不到消息（serverBackfill 关 / 平台拉不到）', ownerHint } }
    }
    // `selfId` 在 `platform` 服务的**子对象 `client`** 上（`features/platform/index.ts:39/45`：
    // 服务形状是 `{client, platform, api, out}`）。Codex 预发布审查 R5-§C 指出这里曾经读错层，
    // 于是机器人自己的发言被标成 `other`；两处都读一遍并优先取 `client`。
    const platformService = deps.get('platform') as { selfId?: number | null; client?: { selfId?: number | null } } | undefined
    const selfId = platformService?.client?.selfId ?? platformService?.selfId ?? null
    const scopeUser = candidate.scope.userId
    const mapped = raw.slice(-Math.max(1, lines)).map((entry): DraftLine => ({
      ...(Number.isFinite(entry.id) ? { id: `qq:${String(entry.id)}` } : {}),
      who: selfId !== null && entry.userId === selfId ? 'self' : (scopeUser !== null && entry.userId === scopeUser ? 'user' : 'other'),
      text: cut(entry.text, lineChars),
      at: entry.time * 1000,
      speaker: entry.name === '' ? String(entry.userId) : entry.name,
    }))
    // 总量超了从**最旧**的一条开始丢：最近几轮才是"接着聊"的依据。
    const kept: DraftLine[] = []
    let used = 0
    for (const line of [...mapped].reverse()) {
      const size = [...line.text].length + 1
      if (used + size > maxChars && kept.length > 0) break
      kept.unshift(line)
      used += size
    }
    return { history: kept, gap: null }
  } catch (error) {
    return { history: [], gap: { partition: 'history', code: 'history:missing', reason: `读取抛错：${describe(error)}`, ownerHint } }
  }
}

/** C1｜长期记忆（查询串 = 候选理由；空串 = 没想起什么，**不是故障**）。 */
export async function memoryOf(
  deps: DraftContextDeps,
  candidate: ContactCandidate,
  maxChars: number,
): Promise<{ memory: string | null; gap: DraftContextGap | null }> {
  const ownerHint = 'features/memory 的 memoryEvidence（wireInjectionV3 → host.provide("memoryEvidence")）'
  const port = deps.get('memoryEvidence') as DraftMemoryEvidence | undefined
  if (port === undefined) {
    return { memory: null, gap: { partition: 'memory', code: 'memory:missing', reason: '没有 memoryEvidence（memory.v2 关闭或未装载）', ownerHint } }
  }
  const speakerId = candidate.scope.userId
  try {
    const block = (await port({
      text: candidate.reason,
      room: candidate.target.room,
      isGroup: candidate.target.isGroup,
      ...(speakerId === null ? {} : { speakerId }),
    })).trim()
    if (block === '') {
      return { memory: null, gap: { partition: 'memory', code: 'memory:empty', reason: '这次没检索到相关记忆（允许只基于对话判断）', ownerHint } }
    }
    return { memory: cut(block, maxChars), gap: null }
  } catch (error) {
    return { memory: null, gap: { partition: 'memory', code: 'memory:missing', reason: `检索抛错：${describe(error)}`, ownerHint } }
  }
}

/** C2｜未完成事项：**QQ 插件内没有这个接口**，所以恒缺（不算失败，只是能力没接）。 */
export function pendingOf(): { pending: readonly string[]; gap: DraftContextGap } {
  return {
    pending: [],
    gap: {
      partition: 'pending',
      code: 'pending:unsupported',
      reason: '承诺/目标在 companion-runtime（commitments/goals 表），QQ 插件拿不到',
      ownerHint: 'companion-runtime lib/goals.mjs 的 listCommitments + ServiceBag 只读缝',
    },
  }
}

/** C3｜`mentionPolicy`：只在 companion-memory 里，**主动消息路径没有它**。 */
export function mentionPolicyGap(): DraftContextGap {
  return {
    partition: 'mentionPolicy',
    code: 'mentionPolicy:unsupported',
    reason: 'mentionPolicy（含 avoid_unless_asked）在 companion-memory，本路径只读 QQ 插件自己的记忆',
    ownerHint: 'companion-memory lib/render.mjs + 一条只读缝（跨库只读，且不能绕过 avoid_unless_asked）',
  }
}

/**
 * D｜候选证据正文。
 *
 * **不解析 `evidenceIds`**：全仓没有解析器，id 形如 `chat:<sessionId>:<秒>`，属于 contact
 * 独有的悬空约定（A2 §2.5）。现实解法是"证据正文几乎总在最近几条对话里"，于是退化成
 * 最近一条对话，并把"无法解析"这件事记成 `evidence:unresolved`（会进提示词的缺口段）。
 */
export function evidenceOf(
  candidate: ContactCandidate,
  history: readonly DraftLine[],
  maxChars: number,
): { evidence: readonly DraftEvidence[]; gap: DraftContextGap | null } {
  if (candidate.evidenceIds.length === 0) return { evidence: [], gap: null }
  const last = history[history.length - 1]
  const evidence: DraftEvidence[] = last === undefined
    ? []
    : [{ source: 'history:last', text: cut(last.text, maxChars) }]
  return {
    evidence,
    gap: {
      partition: 'evidence',
      code: 'evidence:unresolved',
      reason: `evidenceIds 没有解析器（${candidate.evidenceIds.slice(0, 2).join('、')}）`,
      ownerHint: '尚无拥有者：建议 propose 时内联 evidenceText（A2 §2.5 的第 2 条路径）',
    },
  }
}

/** E｜最近主动外发 + 送达状态 + 是否有人接话（三段拼，不新建"回复关联"表）。 */
export async function outboundOf(
  deps: DraftContextDeps,
  candidate: ContactCandidate,
  rows: number,
  maxChars: number,
): Promise<{ outbound: readonly DraftOutbound[]; sentBlock: string | null; unansweredStreak: number; gap: DraftContextGap | null }> {
  const room = candidate.target.room
  // `unansweredStreak` 是"这个房间连续几条主动消息没被理"，它不记"哪一条被回了"（A2 §2.6）：
  // 所以 `replied` 只按它推，别假装知道单条消息的回复关系。
  const unansweredStreak = deps.counters?.().unansweredStreakByRoom[room] ?? 0
  const replied = unansweredStreak === 0
  const outbound = (deps.deliveries?.() ?? [])
    .filter((row) => row.target.room === room && row.state !== 'pending' && row.state !== 'running')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, rows))
    .map((row): DraftOutbound => ({ text: cut(row.text, 60), state: row.state, at: row.updatedAt, replied }))
  let sentBlock: string | null = null
  const hub = deps.get('sentLogHub') as DraftSentLogHub | undefined
  if (hub !== undefined) {
    try {
      const block = (await hub.for(room)).render().trim()
      sentBlock = block === '' ? null : cut(block, maxChars)
    } catch {
      sentBlock = null
    }
  }
  const gap = sentBlock === null && outbound.length === 0
    ? {
      partition: 'outbound' as const,
      code: 'outbound:missing',
      reason: '既没有 sentLogHub 也没有本房间的投递记录',
      ownerHint: 'features/sent-log.ts 的 createSentLogHub（host.provide("sentLogHub")）',
    }
    : null
  return { outbound, sentBlock, unansweredStreak, gap }
}

/** F｜起草时刻：**只认 `zoneClock(now, config.timezone)`**，与门控/日键同一份结果。 */
export function clockOf(deps: DraftContextDeps, now: number): { clock: DraftClock | null; gap: DraftContextGap | null } {
  const tz = deps.config().timezone
  const zoned = zoneClock(now, tz)
  if (zoned === null) {
    return {
      clock: null,
      gap: {
        partition: 'clock',
        code: 'clock:timezone-invalid',
        reason: `时区名不认识：${tz}`,
        ownerHint: 'contact.timezone（门控 `checkQuietHours` 会先拦，这里只做兜底断言）',
      },
    }
  }
  return {
    clock: {
      tz,
      tzLabel: tz === '' ? '宿主本地' : tz,
      dayKey: zoned.day,
      hhmm: `${pad(Math.floor(zoned.minutes / 60))}:${pad(zoned.minutes % 60)}`,
      minutes: zoned.minutes,
      period: periodOf(zoned.minutes),
    },
    gap: null,
  }
}

/** 时段：**从当地分钟数推**，不读宿主本地小时（A2 §2.7 的第三套口径就此收掉）。 */
export function periodOf(minutes: number): string {
  if (minutes < 300) return '深夜'
  if (minutes < 480) return '清晨'
  if (minutes < 660) return '上午'
  if (minutes < 780) return '中午'
  if (minutes < 1020) return '下午'
  if (minutes < 1140) return '傍晚'
  if (minutes < 1380) return '晚上'
  return '深夜'
}

/** 按**字符**截断（不是 UTF-16 码元：中文与 emoji 都不会被切一半）。 */
export function cut(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

export function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
