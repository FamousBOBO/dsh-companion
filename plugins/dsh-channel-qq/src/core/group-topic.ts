/** 话题的**轻量识别**（P3 §7.1 的 `topic_change` 事件来源）。
 *
 * 这里刻意不做语义理解：话题识别靠模型是"又贵又慢"的一条路，而它要服务的只是
 * 一个提示词里的短句（"现在群里在聊：拍月亮"）。所以只做两件便宜事：
 *
 *   1. **显式话题**：消息里出现「说起来」「顺便问一下」「你们觉得…怎么样」「关于…」
 *      这类把话题挑明的句式 → 取该句的主干当话题；
 *   2. **连续同题**：最近几条消息在高频词上重合 → 拿重合的词当话题。
 *
 * 三条纪律：
 *   - **不发散**：只产出 ≤24 字的短语，识别不出来就 `null`（宁缺勿错，因为错话题会让她
 *     对着一件没发生的事接话）；
 *   - **不跨群**：纯函数，输入只有这个群的消息；
 *   - **纯**：不读时钟、不读盘（R8），时间由调用方传。
 */

/** 一条用于识别话题的消息。 */
export interface TopicInput {
  readonly text: string
  readonly atMs: number
  readonly self: boolean
}

/** 识别结果：话题名 + 置信度（低置信度的话题不写进时间线）。 */
export interface TopicGuess {
  readonly topic: string
  /** 0–1：低于 0.5 不记事件（"好像有个话题"不值得进提示词）。 */
  readonly confidence: number
}

/** 把话题挑明的句式（取最后一个出现的那句，越靠后越新）。 */
const EXPLICIT_PATTERNS: readonly RegExp[] = [
  /说起来[，,、\s]*(.{2,24})/u,
  /顺便(?:问|说)(?:一下|一句)?[，,、\s]*(.{2,24})/u,
  /(?:有人|你们|大家)(?:觉得|知道|用过|玩过)(.{2,24}?)(?:吗|么|嘛|呢)/u,
  /关于(.{2,24}?)(?:[，,。！!？?]|$)/u,
  /(?:今天|刚才|最近)在?(?:聊|说)(.{2,24}?)(?:[，,。！!？?]|$)/u,
]

/** 指示代词/量词开头：剥掉它们，剩下的才是话题（"那个赤道仪" → "赤道仪"）。 */
const LEADING_DEICTIC = /^(?:一下|一句|这个|那个|这件|那件|这事|那事|这个事|那个事)[，,、\s]*/u

/** 剥完开头仍然不像话题（提问词/虚词起头）就整条不要。 */
const NON_TOPIC = /^(?:什么|怎么|为什么|是不是|有没有|能不能|可不可以|一下|的|了|吗)/u

/** 高频词里要扔掉的（语气词、代词、常见动词）。 */
const STOPWORDS = new Set([
  '就是', '然后', '所以', '但是', '因为', '可以', '这个', '那个', '什么', '怎么', '我们',
  '你们', '他们', '自己', '一个', '现在', '时候', '真的', '感觉', '觉得', '应该', '还是',
  '没有', '不是', '这样', '那样', '知道', '看看', '一下', '一点', '有点', '已经', '如果',
])

/** 取一段文本里的候选词：中文按 2–4 字滑窗，英文/数字按词。 */
function terms(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  const out: string[] = []
  for (const chunk of cleaned.match(/[A-Za-z][A-Za-z0-9+#._-]{1,20}/g) ?? []) out.push(chunk.toLowerCase())
  for (const run of cleaned.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (let size = 2; size <= 4; size += 1) {
      for (let i = 0; i + size <= run.length; i += 1) out.push(run.slice(i, i + size))
    }
  }
  return out.filter((term) => term.length >= 2 && !STOPWORDS.has(term))
}

/**
 * 修剪成一句能进提示词的话题：去引号、去指示代词开头、去标点尾巴、≤24 字。
 *
 * 为什么要剥"那个/这个"：群聊里大多数显式话题都是以指示代词起的（"顺便问一下，那个赤道仪
 * 好用吗"），整条拒掉会漏掉一大半真话题，而留着"那个"又指不到东西。所以**剥**而不是**拒**。
 */
function tidy(raw: string): string {
  const trimmed = raw
    // 开头的标点/括号一并剥掉：正则捕获段经常从逗号起头（"关于，为什么啊"），
    // 带着逗号进提示词既难看也会让后面的"提问词起头"判断失效。
    .replace(/^[\s"'“”「」『』（()）,，、。：:；;]+/u, '')
    .replace(LEADING_DEICTIC, '')
    .replace(/[\s"'“”「」『』）)，,。.！!？?：:；;、]+$/u, '')
    .trim()
  const chars = [...trimmed]
  return chars.length <= 24 ? trimmed : chars.slice(0, 24).join('')
}

/**
 * 从最近几条消息里识别当前话题（**绝不猜**：识别不出来返回 `null`）。
 *
 * @param entries 这个群最近的消息（时间正序；`self` 标记她自己的发言）
 */
export function refineTopic(entries: readonly TopicInput[]): TopicGuess | null {
  const others = entries.filter((entry) => !entry.self && entry.text.trim() !== '')
  if (others.length === 0) return null
  // ① 显式话题：从最新的往前找。
  for (let i = others.length - 1; i >= 0; i -= 1) {
    const text = others[i]?.text ?? ''
    for (const pattern of EXPLICIT_PATTERNS) {
      const match = pattern.exec(text)
      const captured = match?.[1]
      if (captured === undefined) continue
      const topic = tidy(captured)
      if (topic === '' || NON_TOPIC.test(topic)) continue
      return { topic, confidence: 0.8 }
    }
  }
  // ② 连续同题：最近 4 条里出现 ≥2 次的词，取最长（最长的最具体）。
  const recent = others.slice(-4)
  const counts = new Map<string, number>()
  for (const entry of recent) {
    for (const term of terms(entry.text)) counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  const repeated = [...counts.entries()].filter(([term, count]) => count >= 2 && term.length >= 2)
  if (repeated.length === 0) return null
  repeated.sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
  const winner = repeated[0]
  if (winner === undefined) return null
  const topic = tidy(winner[0])
  if (topic === '' || NON_TOPIC.test(topic)) return null
  // 只出现两次、且只有两字：可能只是巧合，置信度压低（调用方按阈值决定要不要记）。
  const confidence = winner[1] >= 3 ? 0.65 : 0.45
  return confidence >= 0.5 ? { topic, confidence } : null
}
