/** 从群聊消息里**保守地**抽候选记忆（P1 §5.3）。
 *
 * 这一层的目标不是"多记"，而是"记错代价最小"。三条判据都来自计划与真实教训：
 *
 *   1. **只抽成员主动表达的第一人称事实**（"我喜欢…""我在…上班""我养了只猫"）。
 *      这是 `explicit` 档唯一有把握的一类；靠猜的写进库里，下一次召回就会用确定口吻
 *      说出来，而用户没有任何机会纠正它。
 *   2. **必须有来源消息号**：没有来源的记忆不可追溯，也无法在被人质疑时撤回
 *      （存储侧同样拒写无来源的记录，这里是同一口径的前置检查）。
 *   3. **猜的一律不写**：`guess` 这一档留给未来的多轮总结，当前实现**不产出**它——
 *      宁可库里少，也不要库里脏。
 *
 * 纯函数：不读时钟、不读写盘、不联网（R8）。
 */

/**
 * 抽记忆只需要这几个字段（**不** import `app/inbound/presence-judge.js`：`core/` 不许回头
 * 依赖 `app/`，那是分层 R8 的方向性要求，也是"core 可重放"的前提）。
 */
export interface ExtractInput {
  readonly messageId: number | null
  readonly userId: number
  readonly text: string
  /** 正文（不含发送者抬头）；缺省时用 `text`。 */
  readonly body?: string
  readonly self: boolean
}

/** 一条候选记忆（写入方还要补 groupId 与时间）。 */
export interface CandidateFact {
  /** 群维还是成员维；当前实现只产出成员维。 */
  readonly scope: 'group' | 'member'
  readonly memberId: number
  readonly content: string
  readonly kind: 'explicit'
  /** 来源消息号（至少一条，且都是真实消息号）。 */
  readonly sourceMessageIds: readonly number[]
}

/** 第一人称主语。 */
const FIRST_PERSON = /(?:^|[，,。！!？?、\s])(?:我|俺|咱)/u

/**
 * 会被当成"事实"的谓语（必须**主动表达**，且是可持续的属性/偏好）。
 *
 * 刻意不收"我觉得/我想/我猜"：那是当下的判断，不是关于这个人的事实；
 * 也不收"我要/我去/我马上"：那是计划，会过期（存储侧没有 TTL 的成员事实，
 * 写进去就成了永久画像）。
 */
const PREDICATES: readonly RegExp[] = [
  /我(?:很|特别|超|最|比较|不太|不)?(?:喜欢|爱|讨厌|怕|习惯|迷|粉)/u,
  /我(?:在|是)(?:做|干|搞|读|学|住)(?:.{0,20})/u,
  /我在.{1,12}(?:上班|工作|读书|上学|住)/u,
  /我(?:养|种)了?.{1,12}/u,
  /我(?:会|能|擅长|懂)(?:.{1,16})/u,
  /我(?:家|老家|公司|学校)(?:在|是).{1,16}/u,
  /我(?:有|没有)(?:.{1,12})/u,
]

/** 提问/假设/否定表达：不是陈述事实（"你会做饭吗" 不该被记成"他会做饭"）。 */
const NOT_ASSERTIVE = /[？?]|吗|呢|如果|假如|要是|是不是|会不会|有没有/u

/** 明显不该进记忆的内容（地址、链接、CQ 码、@、长串数字）。 */
const UNSAFE = /https?:\/\/|\[CQ:|@|\d{5,}/iu

/** 一条陈述最长记多少字（再长就不是"事实"，是一段话）。 */
const MAX_FACT_CHARS = 60

/** 句子切分（不追求语言学的正确，只要能切开条目）。 */
function sentencesOf(text: string): string[] {
  return text
    .split(/[。！!？?\n；;]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** 归一化后比较是否重复（去空白与标点）。 */
function normalizeFact(text: string): string {
  return text.replace(/[\s，,。.！!？?、：:；;"'“”「」]/gu, '').toLowerCase()
}

/**
 * 抽候选记忆。
 *
 * @param entries 这一批背景（时间正序）；**她自己发的会被跳过**
 * @returns 去重后的候选（顺序按出现顺序，便于日志对照）
 */
export function extractCandidateFacts(entries: readonly ExtractInput[]): CandidateFact[] {
  const out: CandidateFact[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.self) continue
    if (typeof entry.messageId !== 'number' || !Number.isSafeInteger(entry.messageId) || entry.messageId <= 0) {
      // 没有真实消息号的合成事件不能当来源（存储侧会拒写，这里先挡掉省一次调用）。
      continue
    }
    if (!Number.isSafeInteger(entry.userId) || entry.userId <= 0) continue
    const body = entry.body ?? entry.text
    for (const sentence of sentencesOf(body)) {
      if (sentence.length < 4 || [...sentence].length > MAX_FACT_CHARS) continue
      if (NOT_ASSERTIVE.test(sentence)) continue
      if (UNSAFE.test(sentence)) continue
      if (!FIRST_PERSON.test(sentence)) continue
      if (!PREDICATES.some((pattern) => pattern.test(sentence))) continue
      const key = normalizeFact(sentence)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      out.push({
        scope: 'member',
        memberId: entry.userId,
        content: sentence.replace(/\s+/g, ' ').trim(),
        kind: 'explicit',
        sourceMessageIds: [entry.messageId],
      })
    }
  }
  return out
}
