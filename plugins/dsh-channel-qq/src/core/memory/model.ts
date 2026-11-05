/** 记忆记录：数据模型与不变量（09-记忆系统设计 §4）。
 *
 * 这是**可重放层**（R8）：不读时钟、不掷随机数，两个都从外面传进来。理由不只是
 * 测试方便——记忆的每一个时间字段（`validFrom` / `recordedAt` / `lastHitAt`）都要
 * 能被重放与审计："这条记忆是什么时候进来的、什么时候失效的"是它可信度的全部。
 *
 * 三件事在这里定死：
 *   1. **双时间轴**（Zep）：`validFrom/validTo` 是"这件事在世界上成立的时间"，
 *      `recordedAt` 是"我们什么时候知道的"。两者分开，才能回答"上周二我们是怎么
 *      想的"（用 recordedAt 回看）与"现在还算不算数"（用 validTo 过滤）。
 *   2. **矛盾不删除**：新记录 `supersedes` 旧的，旧的转 `superseded` 并写
 *      `validTo`。历史可回查，但检索默认只看 active。
 *   3. **越用越难忘**（MemoryBank）：`strength` 是遗忘曲线里的 S，每次被召回 +1
 *      （上限 20）。importance ≥ 8 的建档时直接给 3。
 */

/** 记忆的种类。刻意少而稳：种类一多，模型建档时就会开始犹豫。 */
export type MemoryKind = 'fact' | 'preference' | 'event' | 'person' | 'skill' | 'procedure' | 'trait'

/** 这条记忆关于谁。`self` 是"她自己"（学到的方法、自己定的规矩）。 */
export type MemorySubjectType = 'user' | 'group' | 'self' | 'world'

export interface MemorySubject {
  readonly type: MemorySubjectType
  /** QQ 号 / 群号 / 任意标识；`self` 与 `world` 通常没有。 */
  readonly id?: number | string
}

/** 出处。**每条记忆都必须能回答"从哪来"**，否则不进 L2。 */
export interface MemorySource {
  readonly kind: 'chat' | 'diary' | 'dream' | 'manual' | 'extract' | 'reflect' | 'migration'
  readonly room?: string
  readonly sessionId?: string
  readonly messageId?: number
  /** 迁移来源（例如 MEMORY.md 的行号）。 */
  readonly file?: string
  readonly line?: number
}

export type MemoryStatus = 'candidate' | 'active' | 'superseded' | 'archived'

export interface MemoryRecord {
  readonly id: string
  readonly kind: MemoryKind
  readonly subject: MemorySubject
  /** 一句话，中文，≤ 200 字。检索时注入给模型的就是这一句。 */
  readonly content: string
  readonly keywords: readonly string[]
  readonly tags: readonly string[]
  /** 帮助检索期理解"这句话在说什么"的上下文说明。 */
  readonly context: string
  /** 关联记录的 id（A-MEM 的 links）。 */
  readonly links: readonly string[]
  readonly source: MemorySource
  /** 1..10。建档时由模型打分；拿不到时给 5。 */
  readonly importance: number
  /** 0..1。来自 member 回合的写入 ≤ 0.5。 */
  readonly confidence: number
  readonly status: MemoryStatus
  readonly validFrom: number
  readonly validTo: number | null
  readonly recordedAt: number
  readonly supersedes: readonly string[]
  readonly supersededBy?: string
  /** 遗忘曲线里的 S。 */
  readonly strength: number
  readonly hits: number
  readonly lastHitAt?: number
  readonly scope: 'global' | 'room'
  readonly room?: string
  /** 需要复核的时间（证据类记忆用）。 */
  readonly reviewAt?: number
}

/** 建档时喂进来的东西；其余字段由 `makeRecord` 按规则补。 */
export interface NewRecordInput {
  readonly kind: MemoryKind
  readonly subject: MemorySubject
  readonly content: string
  readonly source: MemorySource
  readonly importance?: number
  readonly confidence?: number
  readonly keywords?: readonly string[]
  readonly tags?: readonly string[]
  readonly context?: string
  readonly links?: readonly string[]
  readonly scope?: 'global' | 'room'
  readonly room?: string
  readonly validFrom?: number
  readonly status?: MemoryStatus
  readonly reviewAt?: number
}

/** 内容长度的硬上限。超了说明这不是"一句话"，该在写入前拆。 */
export const MAX_CONTENT_CHARS = 200

/** 强度上限：20 意味着半衰期足够长，不再继续加。 */
export const MAX_STRENGTH = 20

/** 重要性 ≥ 这个数时，建档直接给 strength=3（MemoryBank 的做法）。 */
const IMPORTANT_THRESHOLD = 8

/** 把任意输入裁成一句话（去掉换行、压缩空白、截断）。 */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_CONTENT_CHARS ? flat : `${flat.slice(0, MAX_CONTENT_CHARS - 1)}…`
}

/**
 * 生成 id：`m_<base36 时间>_<4 位随机>`。
 *
 * 时间在前是为了"按 id 排序≈按时间排序"（排查时肉眼就够了）；随机后缀由调用方
 * 注入（R8：core 不许自己掷随机）。
 */
export function newMemoryId(now: number, roll: () => number): string {
  const stamp = Math.max(0, Math.floor(now)).toString(36)
  const suffix = Math.floor(roll() * 36 ** 4).toString(36).padStart(4, '0')
  return `m_${stamp}_${suffix}`
}

/** 建档：补默认值、统一规范化。**只在这里定 status/strength/时间字段的初值。** */
export function makeRecord(input: NewRecordInput, now: number, roll: () => number): MemoryRecord {
  const content = oneLine(input.content)
  if (content === '') throw new Error('记忆内容不能为空')
  const importance = clampInt(input.importance ?? 5, 1, 10)
  const confidence = clamp01(input.confidence ?? 1)
  return {
    id: newMemoryId(now, roll),
    kind: input.kind,
    subject: input.subject,
    content,
    keywords: [...new Set(input.keywords ?? [])].slice(0, 12),
    tags: [...new Set(input.tags ?? [])].slice(0, 8),
    context: (input.context ?? '').trim(),
    links: [...new Set(input.links ?? [])].slice(0, 16),
    source: input.source,
    importance,
    confidence,
    status: input.status ?? 'active',
    validFrom: input.validFrom ?? now,
    validTo: null,
    recordedAt: now,
    supersedes: [],
    strength: importance >= IMPORTANT_THRESHOLD ? 3 : 1,
    hits: 0,
    scope: input.scope ?? 'global',
    ...(input.room === undefined ? {} : { room: input.room }),
    ...(input.reviewAt === undefined ? {} : { reviewAt: input.reviewAt }),
  }
}

function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, Math.round(value)))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 这条记录现在还算不算数（双时间轴的时间过滤）。 */
export function isValidAt(record: MemoryRecord, now: number): boolean {
  if (record.validFrom > now) return false
  return record.validTo === null || record.validTo > now
}

/**
 * 原文块的标签。块是"原始层"（600 字原文），只给**深召回工具**用：
 * 自动注入与主动召回的预算只有 600 字，塞一块就装不下别的证据（实测 recall 反而 0）。
 */
export const CHUNK_TAG = 'chunk'

/** 这条记录是不是原文块。 */
export function isChunkRecord(record: MemoryRecord): boolean {
  return record.tags.includes(CHUNK_TAG)
}

/** 参与检索的最小条件：状态与时间都对。scope/房间由检索器另判。 */
export function isRetrievable(record: MemoryRecord, now: number): boolean {
  return record.status === 'active' && isValidAt(record, now)
}

/**
 * "钉住"：永不归档的记录（09 §6.3）。
 *
 * 判据刻意保守——归档是"她忘了一件事"，而她不该忘记学弟的偏好、被明确要求记住的
 * 事、人物关系，以及自己反复确认过的性格。宁可多留。
 */
export function isPinned(record: MemoryRecord): boolean {
  if (record.kind === 'preference' && record.subject.type === 'user') return true
  if (record.kind === 'person') return true
  if (record.kind === 'trait' && record.importance >= 8) return true
  if ((record.tags as readonly string[]).includes('pin')) return true
  return record.strength >= MAX_STRENGTH
}

/**
 * "常驻层"准入判据（P2 三层注入的第一层，调研 §3 Marquez807 的教训）。
 *
 * Marquez807/dsh-experience-memory 的实测：常驻层准入极严（只有自己声明了
 * "任何场合都要守"的规矩）才能 6/6 命中，宽松准入的对照组 0/18。所以这里的
 * 判据是三条**同时**成立：
 *   - 显式标记 `core`（写入侧/审核页点名，不是打分猜的）；
 *   - importance ≥ 8（重要到值得每回合都在场）；
 *   - confidence ≥ 0.8（被验证过若干次，或主人手工确认过）。
 * 外加 affection 联动的特例（P3）：高好感用户的重要偏好也算——那是她真的在乎的人。
 * 数量上限由调用方控制（默认 2 条），判据本身只管"配不配"。
 */
export function isCoreRecord(record: MemoryRecord, opts: { minImportance?: number; minConfidence?: number } = {}): boolean {
  if (record.status !== 'active') return false
  if (isChunkRecord(record)) return false
  const minImportance = opts.minImportance ?? 8
  const minConfidence = opts.minConfidence ?? 0.8
  if (record.tags.includes('core')) return record.importance >= minImportance && record.confidence >= minConfidence
  return false
}

/**
 * 遗忘曲线：`R = e^(−t/S)`，t 是"距上次召回的天数"。
 *
 * `S` 取 `strength`：被召回一次 +1，所以常用的记忆衰减得慢。importance 高的
 * 建档时 S 就从 3 起，等于"一开始就不容易忘"。
 */
export function retention(record: MemoryRecord, now: number): number {
  const last = record.lastHitAt ?? record.recordedAt
  const days = Math.max(0, (now - last) / 86_400_000)
  return Math.exp(-days / Math.max(1, record.strength))
}

/** 归档判定：R < 0.05 且没被钉住。 */
export function shouldArchive(record: MemoryRecord, now: number): boolean {
  if (isPinned(record)) return false
  return retention(record, now) < 0.05
}

/** 召回一次：hits+1、lastHitAt=now、strength+1（上限 MAX_STRENGTH）、置信 +GAIN。
 *
 * 置信增益（P1"命中强化"）：engram 的做法是命中 +0.05——一条记忆被反复验证，
 * 就该越来越可信；上限 1，来自 member 回合的低置信写入（≤0.5）要被验证若干次
 * 才能爬回 1，而不是永远低人一等。
 */
export const HIT_CONFIDENCE_GAIN = 0.05

export function withHit(record: MemoryRecord, now: number): MemoryRecord {
  return {
    ...record,
    hits: record.hits + 1,
    lastHitAt: now,
    strength: Math.min(MAX_STRENGTH, record.strength + 1),
    confidence: Math.min(1, record.confidence + HIT_CONFIDENCE_GAIN),
  }
}

/**
 * 用新记录取代旧记录（矛盾处理规则 1）。
 *
 * **不删除旧的**：置 `superseded` 并写 `validTo`。历史可回查是这套设计的核心要求
 * ——"她以前以为是什么"这个问题必须有答案。
 */
export function supersede(old: MemoryRecord, by: string, validFrom: number): MemoryRecord {
  return {
    ...old,
    status: 'superseded',
    supersededBy: by,
    validTo: Math.max(old.validFrom, Math.min(validFrom, validFrom)),
  }
}

/** 两条记录是否"同主体同类"（矛盾判定的作用域）。 */
export function sameTopic(a: MemoryRecord, b: MemoryRecord): boolean {
  if (a.kind !== b.kind) return false
  if (a.subject.type !== b.subject.type) return false
  return String(a.subject.id ?? '') === String(b.subject.id ?? '')
}
