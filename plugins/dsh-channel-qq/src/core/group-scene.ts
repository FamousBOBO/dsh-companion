/** 群聊的**社交场景**（P2 §6.1 的输入侧）：把"这批消息里谁在跟谁说话"变成一组可复核的字段，让
 * "要不要说话"由**事实**决定而不是凭正文猜气氛。与 `group-topic.ts` 同一立场：**判不出就说判不出**
 * ——误判代价很具体：在两人的私聊里插嘴，或把反问当成"没人回答的问题"自问自答。五条纪律：
 *   1. **只信平台段**：`replyToMessageId` / `atUserIds` 是平台给的结构化事实；正文里的"@某某"
 *      "回复某某"谁都能打出来，当线索用等于允许发言者伪造"她在跟谁说话"（注入防护）。
 *   2. **两个人不等于定向**："恰好只有两个发言人"绝不单独构成 directed——两个人也可能公开聊。
 *   3. **反问不是提问**：`难道…` / `不是…吗` 带问号但不是在问，否则 answerState 永远 open。
 *   4. **冲突默认 none**：据此沉默或站队的代价远大于漏判，只在证据齐了才给 active。
 *   5. **纯**：不读时钟、不读盘、不联网、不 import `app/`、`adapters/`（R8）；时间由调用方传入。
 */

import { overlaps } from './group-feedback.js'

/** 一条用于判断场景的消息。 */
export interface SceneInput {
  readonly messageId: number | null
  readonly userId: number
  /** 正文（不含发送者抬头）。 */
  readonly text: string
  readonly atMs: number
  readonly self: boolean
  /** 这条消息引用/回复了哪一条（来自平台 reply 段；没有就是 null）。 */
  readonly replyToMessageId?: number | null
  /** 这条消息真实 @ 了谁（来自平台 at 段；**不要**从正文里的 "@某某" 字样推断）。 */
  readonly atUserIds?: readonly number[]
}

/** 场景判定结果（字段判据见对应函数上方注释）。 */
export interface SocialScene {
  readonly replyEdges: ReadonlyArray<{ fromMessageId: number; toMessageId: number }>
  readonly activeParticipants: readonly number[]
  readonly directedTo: number | undefined
  readonly discussionKind: 'public' | 'directed' | 'uncertain'
  readonly answerState: 'answered' | 'open' | 'uncertain'
  readonly conflictState: 'active' | 'none' | 'uncertain'
  readonly recentSelfTexts: readonly string[]
  readonly repeatedSelf: boolean
  readonly askedMe: boolean
  readonly questionsAskedBy: readonly number[]
}

/** 她最近说过的一句（带时间）。 */
export interface SelfUtterance {
  readonly text: string
  readonly atMs: number
}

/** 她最新一句：正文与时间都可能缺（这批里没她、recentSelf 也空时）。 */
interface LatestSelf {
  readonly text: string | undefined
  readonly atMs: number | undefined
}

/** 能解析出双方身份的引用边（冲突判定用：回查不到发送者的不算）。 */
interface ResolvedEdge {
  readonly fromUser: number
  readonly toUser: number
  readonly atMs: number
  readonly text: string
}

type DiscussionKind = SocialScene['discussionKind']
type AnswerState = SocialScene['answerState']
type ConflictState = SocialScene['conflictState']
/** 场景判据只看最近几条（再往前属于记忆）；参与者上限 10；directedTo 只看最近 3 条。 */
const RECENT_MESSAGES = 6
const PARTICIPANT_LIMIT = 10
const DIRECT_WINDOW = 3
/** 复读窗口 40 分钟（要求 30–60 分钟区间内的一个值）；冲突窗口 5 分钟 + 双向回击/强否定门槛。 */
export const REPEAT_WINDOW_MS = 40 * 60_000
const CONFLICT_WINDOW_MS = 5 * 60_000
const CONFLICT_MIN_MUTUAL = 3
const CONFLICT_MIN_NEGATIVE = 2
/** 她最近说过的句子最多带几句进场景 / 问句提问者最多记几个 / 定向覆盖阈值 ≥60%。 */
const SELF_TEXT_LIMIT = 6
const QUESTION_LIMIT = 5
const DIRECTED_COVERAGE = 0.6
/** 疑问标记（只用要求里的判据，不扩词表：扩了会把陈述句判成问句）。 */
const QUESTION_MARK = /怎么|为什么|哪|谁|多少|是不是|能不能|有没有|吗|呢|？|\?/u
/** 反问句式：出现即**不是**在提问。 */
const RHETORICAL = /难道|岂不|岂能|怎么可能|谁说|谁不知道/u
/** "不是…吗"句式：中间不许隔太远，否则会把两个独立分句黏成一条。 */
const RHETORICAL_NOT_MA = /不是[^。！!？?\n]{0,12}[吗么]/u
/** 强否定词（只有这些算冲突证据，普通的不同意不算）。 */
const STRONG_NEGATIVE = /滚|闭嘴|别说了|烦|无语|有完没完|什么意思/u

/**
 * 判断一批消息构成的社交场景。
 *
 * @param input.entries 这个群最近的消息（时间正序；非法条目静默丢弃，绝不抛）
 * @param input.selfId 她自己的 QQ 号
 * @param input.nowMs 现在几点（只作"她自己最新一句没有可用时间"时的兜底，判定本身不读时钟）
 * @param input.recentSelf 她最近说过的话（带时间），用于 repeatedSelf
 */
export function buildSocialScene(input: {
  entries: readonly SceneInput[]
  selfId: number
  nowMs: number
  recentSelf?: ReadonlyArray<{ text: string; atMs: number }>
}): SocialScene {
  const entries = sanitize(input?.entries)
  const selfId = isId(input?.selfId) ? input.selfId : -1
  const nowMs = Number.isFinite(input?.nowMs) ? input.nowMs : 0
  const senders = sendersOf(entries)
  const recent = entries.slice(-RECENT_MESSAGES)
  const selfHistory = (input?.recentSelf ?? []).filter((item) => Number.isFinite(item?.atMs) && typeof item?.text === 'string')
  const selfEntries = entries.filter((entry) => entry.self)
  const latestSelf = lastNonEmptySelf(selfEntries, selfHistory)
  return {
    // 只来自 replyToMessageId：正文里"在回谁"的推断一律不做（见文件头第 1 条）。
    replyEdges: replyEdgesOf(entries),
    activeParticipants: participantsOf(entries),
    // 只有真实 @ 或真实引用才给；多个候选取最近的那个，都没有就是 undefined。
    directedTo: directedToOf(entries, senders, selfId),
    discussionKind: discussionKindOf(recent, senders, selfId),
    answerState: answerStateOf(entries, senders),
    conflictState: conflictOf(entries, senders),
    recentSelfTexts: recentSelfTextsOf(selfHistory, selfEntries),
    // 阈值需真实样本校准：overlaps 的 0.6 与 40 分钟窗都是先验值，没在真实群聊上回归过。
    repeatedSelf: repeatedSelfOf({ selfHistory, currentText: latestSelf.text, currentAtMs: latestSelf.atMs ?? nowMs, nowMs }),
    askedMe: askedMeOf(recent, senders, selfId),
    questionsAskedBy: questionsAskedByOf(entries),
  }
}

/** 合法 id：正整数安全整数（0 / 负数 / NaN / 小数都不算，NapCat 的号从 1 起）。 */
function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** 静默剔除非法条目并补齐可选字段（坏输入不能让它抛）：这条路径跑在每条群消息上，一条坏数据
 * 炸掉事件循环的代价远大于少看一条。 */
function sanitize(entries: readonly SceneInput[] | undefined): SceneInput[] {
  const out: SceneInput[] = []
  if (!Array.isArray(entries)) return out
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (!isId(entry.userId) || !Number.isFinite(entry.atMs)) continue
    out.push({
      messageId: isId(entry.messageId) ? entry.messageId : null,
      userId: entry.userId,
      text: typeof entry.text === 'string' ? entry.text : '',
      atMs: entry.atMs,
      self: entry.self === true,
      replyToMessageId: isId(entry.replyToMessageId) ? entry.replyToMessageId : null,
      atUserIds: Array.isArray(entry.atUserIds) ? entry.atUserIds.filter(isId) : [],
    })
  }
  return out
}

/** 消息号 → 发送者（只收有号的消息：没有号的引用回查不到，也不能猜）。 */
function sendersOf(entries: readonly SceneInput[]): Map<number, number> {
  const senders = new Map<number, number>()
  for (const entry of entries) if (entry.messageId !== null) senders.set(entry.messageId, entry.userId)
  return senders
}

/** 引用边：只来自平台 reply 段；自引不算（那不是对话），缺号不算（无从校验）。 */
function replyEdgesOf(entries: readonly SceneInput[]): Array<{ fromMessageId: number; toMessageId: number }> {
  const edges: Array<{ fromMessageId: number; toMessageId: number }> = []
  for (const entry of entries) {
    const to = entry.replyToMessageId
    if (entry.messageId === null || to === null || to === undefined || entry.messageId === to) continue
    edges.push({ fromMessageId: entry.messageId, toMessageId: to })
  }
  return edges
}

/** 参与者：最近发言的 userId，去重、按首次发言保序、最多 10 个（超了丢最早的）。 */
function participantsOf(entries: readonly SceneInput[]): number[] {
  const seen = new Set<number>()
  const picked: number[] = []
  for (const entry of entries) {
    if (seen.has(entry.userId)) continue
    seen.add(entry.userId)
    picked.push(entry.userId)
  }
  return picked.slice(-PARTICIPANT_LIMIT)
}

/** 有人在"对谁说"。候选只来自最近 3 条的**真实** @ 与**真实**引用；指向她自己的一律不算
 * （那是 askedMe 的事，混进来会让"她在跟自己说话"通过校验）。都没有 → undefined，
 * 绝不拿最活跃的参与者顶替。 */
function directedToOf(
  entries: readonly SceneInput[],
  senders: ReadonlyMap<number, number>,
  selfId: number,
): number | undefined {
  const window = entries.slice(-DIRECT_WINDOW)
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const entry = window[i]
    if (entry === undefined) continue
    const atTargets = entry.atUserIds ?? []
    for (let k = atTargets.length - 1; k >= 0; k -= 1) {
      const target = atTargets[k]
      if (target !== undefined && target !== selfId && target !== entry.userId) return target
    }
    const repliedTo = entry.replyToMessageId
    if (repliedTo === null || repliedTo === undefined) continue
    const fromReply = senders.get(repliedTo)
    if (fromReply !== undefined && fromReply !== selfId && fromReply !== entry.userId) return fromReply
  }
  return undefined
}

/** 公开 / 定向 / 判不准。"只有两个人在说话"**不是**定向证据：定向必须同时满足"有真实 @ 或真实
 * 引用"与"最近 6 条里 ≥60% 的发言落在这些被定向的人身上"。没有线索且参与者 ≥3 → public；
 * 线索矛盾或覆盖不足 → uncertain（宁缺勿错）。 */
function discussionKindOf(
  recent: readonly SceneInput[],
  senders: ReadonlyMap<number, number>,
  selfId: number,
): DiscussionKind {
  if (recent.length === 0) return 'uncertain'
  const focus = focusOf(recent, senders, selfId)
  if (focus.size > 0) {
    const involved = recent.filter((entry) => focus.has(entry.userId)).length
    return involved / recent.length >= DIRECTED_COVERAGE ? 'directed' : 'uncertain'
  }
  return new Set(recent.map((entry) => entry.userId)).size >= 3 ? 'public' : 'uncertain'
}

/** 定向证据涉及的人（不含她自己）。为什么排除她自己的定向消息：她每句话都可能有引用，
 * 把她算进焦点会让几乎每批消息都覆盖到 100%，directed 就失去区分力。 */
function focusOf(recent: readonly SceneInput[], senders: ReadonlyMap<number, number>, selfId: number): Set<number> {
  const focus = new Set<number>()
  for (const entry of recent) {
    if (entry.userId === selfId) continue
    for (const target of entry.atUserIds ?? []) {
      if (target === selfId || target === entry.userId) continue
      focus.add(entry.userId)
      focus.add(target)
    }
    const repliedTo = entry.replyToMessageId
    if (repliedTo === null || repliedTo === undefined) continue
    const target = senders.get(repliedTo)
    if (target === undefined || target === selfId || target === entry.userId) continue
    focus.add(entry.userId)
    focus.add(target)
  }
  return focus
}

/** 是不是真的在提问：有疑问标记，且不是反问。反问带问号但不期待回答，算成问句会让
 * answerState 停在 open，进而让"要不要接话"依据一条不存在的问题。 */
export function isQuestion(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') return false
  if (!QUESTION_MARK.test(trimmed)) return false
  return !(RHETORICAL.test(trimmed) || RHETORICAL_NOT_MA.test(trimmed))
}

/** 最近一条问句有没有被回答。只认"对**提问者**的直接回应"：引用那条问句、引用提问者的任意一条、
 * 真实 @ 提问者；回应的人不能是提问者自己（自问自答不是回答）。之后别人说了话但都不指向提问者 →
 * open；之后没人说话、或压根没有问句 → uncertain（没有证据就不声称已答）。 */
function answerStateOf(entries: readonly SceneInput[], senders: ReadonlyMap<number, number>): AnswerState {
  let questionIndex = -1
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry !== undefined && isQuestion(entry.text)) {
      questionIndex = i
      break
    }
  }
  const question = questionIndex >= 0 ? entries[questionIndex] : undefined
  if (question === undefined) return 'uncertain'
  let othersSpoke = false
  for (let i = questionIndex + 1; i < entries.length; i += 1) {
    const reply = entries[i]
    if (reply === undefined || reply.userId === question.userId) continue
    othersSpoke = true
    if (isDirectResponse(reply, question, senders)) return 'answered'
  }
  return othersSpoke ? 'open' : 'uncertain'
}

/** 一条发言是不是对这条问句（或**提问者**）的直接回应。 */
function isDirectResponse(reply: SceneInput, question: SceneInput, senders: ReadonlyMap<number, number>): boolean {
  const repliedTo = reply.replyToMessageId
  if (repliedTo !== null && repliedTo !== undefined) {
    if (question.messageId !== null && repliedTo === question.messageId) return true
    if (senders.get(repliedTo) === question.userId) return true
  }
  return (reply.atUserIds ?? []).includes(question.userId)
}

/** 冲突状态。默认 none：只有同一对成员在 5 分钟窗口内 ≥3 次**双向**引用回击、且其中 ≥2 条含
 * 强否定词，才给 active；有互相回击但强度不够 → uncertain（承认"看起来像"但不据此行动）；
 * 看不到互相回击 → none。整段逻辑就是"宁可判不出，也不要误判"。 */
function conflictOf(entries: readonly SceneInput[], senders: ReadonlyMap<number, number>): ConflictState {
  const edges = resolvedEdges(entries, senders)
  if (edges.length < 2) return 'none'
  const byPair = new Map<string, ResolvedEdge[]>()
  for (const edge of edges) {
    const key = pairKey(edge.fromUser, edge.toUser)
    const list = byPair.get(key)
    if (list === undefined) byPair.set(key, [edge])
    else list.push(edge)
  }
  let mutualSeen = false
  for (const list of byPair.values()) {
    if (new Set(list.map((edge) => edge.fromUser)).size < 2) continue
    mutualSeen = true
    if (hasActiveBurst(list)) return 'active'
  }
  return mutualSeen ? 'uncertain' : 'none'
}

/** 能解析出双方身份的引用边（回查不到发送者就不算——不猜）。 */
function resolvedEdges(entries: readonly SceneInput[], senders: ReadonlyMap<number, number>): ResolvedEdge[] {
  const edges: ResolvedEdge[] = []
  for (const entry of entries) {
    const to = entry.replyToMessageId
    if (entry.messageId === null || to === null || to === undefined) continue
    const toUser = senders.get(to)
    if (toUser === undefined || toUser === entry.userId) continue
    edges.push({ fromUser: entry.userId, toUser, atMs: entry.atMs, text: entry.text })
  }
  return edges
}

/** 同一对成员（与方向无关）的键。 */
function pairKey(a: number, b: number): string {
  return a < b ? String(a) + ':' + String(b) : String(b) + ':' + String(a)
}

/** 同一对成员的某段 5 分钟窗口里是否达到"双向 ≥3 次 + 强否定 ≥2 条"（窗口从每条边起算）。 */
function hasActiveBurst(list: readonly ResolvedEdge[]): boolean {
  const sorted = [...list].sort((a, b) => a.atMs - b.atMs)
  for (let i = 0; i < sorted.length; i += 1) {
    const start = sorted[i]
    if (start === undefined) continue
    const window = sorted.filter((edge) => edge.atMs >= start.atMs && edge.atMs - start.atMs <= CONFLICT_WINDOW_MS)
    if (window.length < CONFLICT_MIN_MUTUAL) break
    if (new Set(window.map((edge) => edge.fromUser)).size < 2) continue
    if (window.filter((edge) => STRONG_NEGATIVE.test(edge.text)).length >= CONFLICT_MIN_NEGATIVE) return true
  }
  return false
}

/** 她最近说过的句子（≤6 条）：优先 recentSelf（权威来源），没有就退回这批消息里她自己发的。 */
function recentSelfTextsOf(selfHistory: readonly SelfUtterance[], selfEntries: readonly SceneInput[]): string[] {
  const history = selfHistory.filter((item) => item.text.trim() !== '').slice(-SELF_TEXT_LIMIT)
  if (history.length > 0) return history.map((item) => item.text)
  return selfEntries.filter((entry) => entry.text.trim() !== '').slice(-SELF_TEXT_LIMIT).map((e) => e.text)
}

/** 她最新一句（正文 + 时间）：优先这批消息里的，其次 recentSelf 的最后一条。 */
function lastNonEmptySelf(selfEntries: readonly SceneInput[], selfHistory: readonly SelfUtterance[]): LatestSelf {
  for (let i = selfEntries.length - 1; i >= 0; i -= 1) {
    const entry = selfEntries[i]
    if (entry !== undefined && entry.text.trim() !== '') return { text: entry.text, atMs: entry.atMs }
  }
  const last = selfHistory[selfHistory.length - 1]
  return { text: last?.text, atMs: last?.atMs }
}

/** 她是不是在复读自己：recentSelf 里**早于当前这句**、且相距 ≤ REPEAT_WINDOW_MS 的那条与本句
 * overlaps() 高度重合。**阈值需真实样本校准**（0.6 与 40 分钟窗都是先验值，上线后要用真实数据
 * 回看误报）。注意这条只回答"看起来像"，**真正的拦截**在 `group-social-guard.ts`（阈值 0.9）。 */
function repeatedSelfOf(input: { selfHistory: readonly SelfUtterance[]; currentText: string | undefined
  currentAtMs: number; nowMs: number }): boolean {
  const current = (input.currentText ?? '').trim()
  if (current === '') return false
  const currentAt = Number.isFinite(input.currentAtMs) ? input.currentAtMs : input.nowMs
  for (const item of input.selfHistory) {
    if (item.text.trim() === '') continue
    if (!(item.atMs < currentAt)) continue
    if (currentAt - item.atMs > REPEAT_WINDOW_MS) continue
    if (overlaps(item.text, current) || overlaps(current, item.text)) return true
  }
  return false
}

/** 最近几条里有没有人**真实**在找她：平台 at 段含她，或引用的那条是她发的。正文里出现"@她"字样
 * 不算（见文件头第 1 条）；她自己发的消息也不算（自己 @ 自己不是找她）。 */
function askedMeOf(recent: readonly SceneInput[], senders: ReadonlyMap<number, number>, selfId: number): boolean {
  if (selfId < 0) return false
  for (const entry of recent) {
    if (entry.userId === selfId) continue
    if ((entry.atUserIds ?? []).includes(selfId)) return true
    const repliedTo = entry.replyToMessageId
    if (repliedTo !== null && repliedTo !== undefined && senders.get(repliedTo) === selfId) return true
  }
  return false
}

/** 问句的提问者：按首次提问保序、去重、最多 5 个（超了丢最早的）。 */
function questionsAskedByOf(entries: readonly SceneInput[]): number[] {
  const seen = new Set<number>()
  const picked: number[] = []
  for (const entry of entries) {
    if (!isQuestion(entry.text) || seen.has(entry.userId)) continue
    seen.add(entry.userId)
    picked.push(entry.userId)
  }
  return picked.slice(-QUESTION_LIMIT)
}
