/** 技能文件（SKILL.md）的纯解析与校验：frontmatter、正文、可见范围。
 *
 * 为什么自己写而不用 YAML 库：SKILL.md 的 frontmatter 只有一个极小的子集
 * （标量 + 一层 `metadata` 映射），而 D8 不许新增运行时依赖。这里**只认这个子集**，
 * 认不出来就报错——比"半个 YAML 解析器"安全：导入一份畸形技能时，管理员会看到
 * 具体哪一行坏了，而不是一个看不懂的栈。
 *
 * 本文件是 `core/`：零 IO、零时钟、零宿主依赖（R8），可以逐字节快照。
 */

/** 技能的可见范围。**每次调用现算**，不缓存。 */
export type SkillVisibility = 'all' | 'none' | 'dm' | 'groups' | 'rooms'

/** 我们写在 `metadata` 里的键前缀（agentskills 规定 metadata 是字符串映射）。 */
export const META_PREFIX = 'channel-qq.'

/** 从 `metadata` 读出来的、归本插件管的策略。 */
export interface SkillPolicy {
  readonly visibility: SkillVisibility
  /** `groups` / `rooms` 模式下允许的房间键（`group-123` / `dm-456`）。 */
  readonly rooms: readonly string[]
  /** 只有管理员发起的回合才能加载/触发。 */
  readonly adminsOnly: boolean
  /** 关闭后既不出现在目录里，也不能被触发。 */
  readonly enabled: boolean
  /** 这个技能带 `scripts/`，且导入/保存时已确认可执行。 */
  readonly allowScripts: boolean
  /** 来源说明（导入时记录，便于审计）。 */
  readonly source: string
}

/** 解析出来的一份技能。 */
export interface SkillDoc {
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly body: string
  readonly metadata: Readonly<Record<string, string>>
  readonly policy: SkillPolicy
}

/** 校验失败：`line` 指向原始文件里的行号（1 起），`field` 是出错的键。 */
export interface SkillParseError {
  readonly field: string
  readonly message: string
}

export type SkillParseResult =
  | { readonly ok: true; readonly skill: SkillDoc }
  | { readonly ok: false; readonly error: SkillParseError }

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 名字上限与 agentskills 对齐。 */
const NAME_MAX = 64
/** 描述上限与 agentskills 对齐。 */
const DESCRIPTION_MAX = 1024
/** 正文上限：技能是"按需加载的指令"，超过这个量级应该拆 references。 */
export const BODY_MAX_BYTES = 64 * 1024

const VISIBILITIES: ReadonlySet<string> = new Set(['all', 'none', 'dm', 'groups', 'rooms'])

/** 把 `key: value` 的值去掉引号。 */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1)
      return first === '"' ? inner.replace(/\\"/g, '"') : inner.replace(/''/g, "'")
    }
  }
  // 行尾注释只在**无引号**时剥掉；URL 里的 `#` 很常见，所以只在 ` #` 前有空格时算注释。
  return trimmed.replace(/\s+#.*$/, '')
}

/**
 * 极小的 YAML 子集解析：只支持
 *
 * - 顶层 `key: value`
 * - 顶层 `key:` 后跟 2 空格缩进的 `sub: value`（只一层，用于 `metadata`）
 *
 * 返回 `null` 表示行格式不认识（调用方给出带行号的错误）。
 */
export function parseYamlSubset(head: string): { data: Record<string, unknown>; error?: { line: number; message: string } } {
  const data: Record<string, unknown> = {}
  let nestedKey: string | null = null
  const lines = head.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ''
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    const colon = line.indexOf(':')
    if (colon <= 0) return { data, error: { line: index + 1, message: `无法解析这一行：${line.slice(0, 60)}` } }
    const key = line.slice(0, colon).trim()
    const rest = line.slice(colon + 1)
    if (indent === 0) {
      nestedKey = rest.trim() === '' ? key : null
      if (rest.trim() !== '') data[key] = unquote(rest)
      else data[key] = {}
      continue
    }
    if (indent !== 2 || nestedKey === null) {
      return { data, error: { line: index + 1, message: '只支持两层：顶层的 metadata 映射' } }
    }
    const target = data[nestedKey]
    if (target === null || typeof target !== 'object' || Array.isArray(target)) {
      return { data, error: { line: index + 1, message: `${nestedKey} 不是一个映射` } }
    }
    ;(target as Record<string, unknown>)[key] = unquote(rest)
  }
  return { data }
}

/** 拆分 frontmatter 与正文；没有合法 frontmatter 返回 null。 */
export function splitFrontmatter(text: string): { head: string; body: string } | null {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return null
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) return null
  const head = normalized.slice(4, end)
  // `\n---` 之后要么是文件结尾，要么是换行。
  const after = normalized.slice(end + 4)
  const body = after.startsWith('\n') ? after.slice(1) : after
  return { head, body }
}

/** 把 frontmatter 里的字符串值取出来（非字符串返回空串）。 */
function str(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** 把 `true/false/yes/no/on/off/1/0` 解析成布尔；认不出来返回 undefined。 */
function bool(value: string): boolean | undefined {
  const v = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(v)) return true
  if (['false', 'no', 'off', '0'].includes(v)) return false
  return undefined
}

/** 从 `metadata` 里读策略；缺省值 = 全局可见、启用、只允许模型/用户按范围触发。 */
export function policyOf(metadata: Readonly<Record<string, string>>): SkillPolicy {
  const rawVisibility = (metadata[`${META_PREFIX}visibility`] ?? 'all').trim().toLowerCase()
  const visibility: SkillVisibility = VISIBILITIES.has(rawVisibility)
    ? (rawVisibility as SkillVisibility)
    : 'all'
  const rooms = (metadata[`${META_PREFIX}rooms`] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^(group|dm)-\d+$/.test(entry))
  const adminsOnly = bool(metadata[`${META_PREFIX}admins-only`] ?? '') === true
  const enabled = bool(metadata[`${META_PREFIX}enabled`] ?? '') !== false
  const allowScripts = bool(metadata[`${META_PREFIX}scripts`] ?? '') === true
  const source = metadata[`${META_PREFIX}source`] ?? ''
  return { visibility, rooms, adminsOnly, enabled, allowScripts, source }
}

/** 解析并校验一份 SKILL.md。 */
export function parseSkillFile(text: string, expectedName?: string): SkillParseResult {
  const split = splitFrontmatter(text)
  if (split === null) return { ok: false, error: { field: 'frontmatter', message: '文件必须以 `---` 开头，并在第一段之后用 `---` 闭合' } }
  const parsed = parseYamlSubset(split.head)
  if (parsed.error !== undefined) {
    return { ok: false, error: { field: 'frontmatter', message: `第 ${parsed.error.line} 行：${parsed.error.message}` } }
  }
  const data = parsed.data
  const name = str(data, 'name')
  if (name === '') return { ok: false, error: { field: 'name', message: '缺少 name' } }
  if (name.length > NAME_MAX) return { ok: false, error: { field: 'name', message: `name 超过 ${NAME_MAX} 个字符` } }
  if (!NAME_RE.test(name)) return { ok: false, error: { field: 'name', message: 'name 只能是小写字母、数字与连字符，且不能以连字符开头/结尾或出现连续连字符' } }
  if (expectedName !== undefined && name !== expectedName) {
    return { ok: false, error: { field: 'name', message: `name 必须与目录名一致（目录 ${expectedName}，文件里是 ${name}）` } }
  }
  const description = str(data, 'description')
  if (description === '') return { ok: false, error: { field: 'description', message: '缺少 description' } }
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, error: { field: 'description', message: `description 超过 ${DESCRIPTION_MAX} 个字符` } }
  }
  const body = split.body.trim()
  if (Buffer.byteLength(body, 'utf8') > BODY_MAX_BYTES) {
    return { ok: false, error: { field: 'body', message: `正文超过 ${BODY_MAX_BYTES} 字节，请拆到 references/` } }
  }
  const rawMeta = data.metadata
  const metadata: Record<string, string> = {}
  if (rawMeta !== undefined && rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
    for (const [key, value] of Object.entries(rawMeta as Record<string, unknown>)) {
      if (typeof value === 'string') metadata[key] = value
    }
  }
  const whenToUse = str(data, 'whenToUse') || str(data, 'when-to-use')
  return {
    ok: true,
    skill: { name, description, whenToUse, body, metadata, policy: policyOf(metadata) },
  }
}

/** 一次调用面对的"视角"：哪个房间、谁发起的、管理员是谁。 */
export interface SkillViewer {
  /** 房间键（`group-123` / `dm-456`）；系统回合为 null。 */
  readonly room: string | null
  /** 发起这次回合的 QQ 号；不知道（群回合只记得信任档）时为 null。 */
  readonly userId: number | null
  /** 本回合的发起人是不是管理员（普通成员 / 群友为 false）。 */
  readonly isAdmin: boolean
  /** 管理员列表（现取）。 */
  readonly admins: readonly number[]
}

/**
 * 这个技能对这次调用可见吗？**纯函数、每次现算**——"动态跟随可见范围"就落在
 * 这里：改后台、改 frontmatter、改组，下一回合立即生效，没有缓存。
 *
 * 系统回合（`room === null`）只看得见 `visibility: all` 的技能：定时巡逻、早报
 * 这类回合没有"谁在看"的概念，放开范围等于把私聊技能泄露到群里。
 */
export function skillVisibleTo(policy: SkillPolicy, viewer: SkillViewer): boolean {
  if (!policy.enabled) return false
  if (policy.adminsOnly && !viewer.isAdmin) return false
  if (policy.visibility === 'none') return false
  if (policy.visibility === 'all') return true
  if (viewer.room === null) return false
  if (policy.visibility === 'dm') return viewer.room.startsWith('dm-')
  // `groups` 只认群房间：即便有人把 `dm-123` 误写进 rooms，私聊也不会命中。
  if (policy.visibility === 'groups' && !viewer.room.startsWith('group-')) return false
  return policy.rooms.includes(viewer.room)
}

/** 一个技能可被**模型自动**看到的条件：全局可见（`all`）且不是管理员专属。 */
export function globallyCatalogued(policy: SkillPolicy): boolean {
  return policy.enabled && policy.visibility === 'all' && !policy.adminsOnly
}
