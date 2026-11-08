/** 群聊使用的**人格快照**契约（P0 §4.1）：把"她是谁"从私聊上下文里独立出来。
 *
 * 为什么需要它：自主接话走的是一次**纯补全**（没有会话、没有系统提示词、没有工具面），
 * 所以它既拿不到 `companion:persona` 那一段，也拿不到人格预设渲染出来的文本。结果就是
 * 同一个角色在被 @ 的回合里说话像一个人，在自主接话里像另一个（2026-11 的观察：自主
 * 接话的语气更"客服"）。这个端口补的就是这一块：**只读、只含群聊可见字段**。
 *
 * 三条硬规矩（评审就看这三条）：
 *   1. **不是私聊上下文**：快照只能从人格文件派生，不带记忆召回、不带会话历史、不带
 *      主人身份与隐私字段。`publicOnly: true` 是这条规矩在类型上的落点——调用方可以
 *      据此断言"我拿到的不是一份私聊转录"。
 *   2. **缺了就说缺了**：端口拿不到时用 {@link DEGRADED_PERSONA_LINES} 明说"人格快照
 *      不可用"，而不是假装已经读到完整人格（后者会让模型自由发挥，写出不属于这个角色的话）。
 *   3. **字段缺失不猜测**：归一化时任何形状不对的字段一律丢掉，宁可少一段也不拼一个
 *      看起来像真的编造值。
 */

/** 一份群聊可见的人格快照。字段来源与上限见 `companion-foundation/group-persona.mjs`。 */
export interface GroupPersonaSnapshot {
  /** 人格文件内容的短哈希：改一个字就变。用于热更新与"为什么这次不像角色"的排查。 */
  readonly version: string
  /** 人格 id（记忆作用域与预设 id）。 */
  readonly personaId: string
  /** 角色是谁（不含私聊内容）。 */
  readonly identity: string
  /** 稳定性格特征。 */
  readonly personality: string
  /** 用词、句长、口语程度、表达习惯。 */
  readonly speakingStyle: string
  /** 兴趣方向：只用于判断相关性，**不是**关键词触发器。 */
  readonly interests: readonly string[]
  /** 允许在群聊里使用的真实经历。 */
  readonly knownExperiences: readonly string[]
  /** 可公开的轻量情绪状态（缺省 = 不带这一行）。 */
  readonly emotionalState?: string
  /** 允许在群聊里表达的事实。 */
  readonly publicFacts: readonly string[]
  /** 群聊场景下的边界。 */
  readonly interactionBoundaries: readonly string[]
  /** 来源标签（例如 `config/persona.md`）。 */
  readonly source: string
}

/** 只读端口：**同步、绝不抛**；没有快照时返回 `null`（调用方据此降级）。 */
export interface GroupPersonaPort {
  get(): GroupPersonaSnapshot | null
}

/** 提示词里各段的字数上限：快照进的是"判断要不要说话"的短提示词，不是人设朗读会。 */
export const PERSONA_LIMITS = Object.freeze({
  identity: 200,
  personality: 300,
  speakingStyle: 300,
  item: 80,
  items: 8,
  emotional: 120,
  total: 1_600,
} as const)

/** 快照不可用时**必须**出现的那几行：明说不完整，并禁止编造。 */
export const DEGRADED_PERSONA_LINES: readonly string[] = [
  '【人格快照不可用】',
  '这次拿不到完整人格（人格文件缺失或服务未就绪）。就用中性的语气说一句短话：',
  '不要编造自己的名字、身份、经历、喜好或与谁的关系；不确定就不说。',
]

/** 一行的清洗：去空白、压成一行（提示词里一行一条，模型才不会读成两段）。 */
function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** 按上限截断（按码点，emoji 不算两个字）；超长不补省略号，直接截。 */
function clip(text: string, limit: number): string {
  const chars = [...text]
  return chars.length <= limit ? text : chars.slice(0, limit).join('')
}

/** 一串短条目：去空、去重（同一条重复没有必要让模型读两遍）、按上限截断。 */
function items(value: unknown, { item, items: max }: { item: number; items: number }): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const raw of value) {
    const text = clip(oneLine(raw), item)
    if (text === '' || out.includes(text)) continue
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

/**
 * 把端口给的东西**结构归一化**成快照（形状不对就返回 `null`）。
 *
 * 为什么在这里做而不是信任端口：这是跨插件边界（另一个进程级注册表里的对象），
 * 版本不一致、字段改名、某个字段是 `undefined` 都是会发生的。归一化只做两步——
 * 认字段、夹上限——**不补默认值**：缺 personality 就是缺，硬塞一句"你性格开朗"
 * 会变成一次可复现的编造。
 */
export function normalizePersonaSnapshot(raw: unknown): GroupPersonaSnapshot | null {
  if (raw === null || typeof raw !== 'object') return null
  const shape = raw as Record<string, unknown>
  const version = oneLine(shape['version'])
  const identity = clip(oneLine(shape['identity']), PERSONA_LIMITS.identity)
  const personality = clip(oneLine(shape['personality']), PERSONA_LIMITS.personality)
  const speakingStyle = clip(oneLine(shape['speakingStyle']), PERSONA_LIMITS.speakingStyle)
  // 一个字都没有的快照等于没有快照：拿它去组提示词只会多出几个空标题。
  if (version === '' && identity === '' && personality === '' && speakingStyle === '') return null
  const emotional = clip(oneLine(shape['emotionalState']), PERSONA_LIMITS.emotional)
  return {
    version: version === '' ? 'unversioned' : version,
    personaId: oneLine(shape['personaId']),
    identity,
    personality,
    speakingStyle,
    interests: items(shape['interests'], { item: PERSONA_LIMITS.item, items: PERSONA_LIMITS.items }),
    knownExperiences: items(shape['knownExperiences'], { item: PERSONA_LIMITS.item, items: PERSONA_LIMITS.items }),
    ...(emotional === '' ? {} : { emotionalState: emotional }),
    publicFacts: items(shape['publicFacts'], { item: PERSONA_LIMITS.item, items: PERSONA_LIMITS.items }),
    interactionBoundaries: items(shape['interactionBoundaries'], { item: PERSONA_LIMITS.item, items: PERSONA_LIMITS.items }),
    source: oneLine(shape['source']),
  }
}

/** 一条短条目的渲染（空数组给"（没有）"：模型读得懂"没有"，读不懂缺席）。 */
function renderItems(title: string, values: readonly string[]): string[] {
  if (values.length === 0) return []
  return [`${title}：`, ...values.map((value) => `- ${value}`)]
}

/**
 * 快照 → 提示词的几行（**纯函数**；空快照给明确降级段）。
 *
 * 顺序是刻意的：身份 → 性格 → 说话方式 → 兴趣 → 经历 → 情绪 → 公开事实 → 边界。
 * 前三条决定"像不像同一个人"，后几条只用于"这段话题接不接得上"，边界放最后
 * （模型对结尾更敏感，而这正是最该被记住的一条）。
 */
export function personaPromptLines(snapshot: GroupPersonaSnapshot | null): string[] {
  if (snapshot === null) return [...DEGRADED_PERSONA_LINES]
  const lines: string[] = ['【你是谁（群聊可见的人格快照）】']
  if (snapshot.identity !== '') lines.push(`身份：${snapshot.identity}`)
  if (snapshot.personality !== '') lines.push(`性格：${snapshot.personality}`)
  if (snapshot.speakingStyle !== '') lines.push(`说话方式：${snapshot.speakingStyle}`)
  lines.push(...renderItems('你更有话说的方向（不是关键词清单，也不是限制）', snapshot.interests))
  lines.push(...renderItems('你真实的经历（只能用这些，别编）', snapshot.knownExperiences))
  if (snapshot.emotionalState !== undefined && snapshot.emotionalState !== '') {
    lines.push(`最近的状态（可以自然流露，但别展开）：${snapshot.emotionalState}`)
  }
  lines.push(...renderItems('可以在群里公开的事实', snapshot.publicFacts))
  lines.push(...renderItems('群聊里的边界', snapshot.interactionBoundaries))
  lines.push(`（快照版本 ${snapshot.version}${snapshot.source === '' ? '' : `，来源 ${snapshot.source}`}）`)
  // 总长兜底：单条都已经夹过，这里再按整段夹一次，防止"八条各 80 字"把判断提示词淹掉。
  let used = 0
  const kept: string[] = []
  for (const line of lines) {
    const size = [...line].length + 1
    if (kept.length > 0 && used + size > PERSONA_LIMITS.total) break
    kept.push(line)
    used += size
  }
  return kept
}
