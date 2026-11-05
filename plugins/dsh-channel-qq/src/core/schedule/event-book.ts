/** 事件书（P6f）：主动行为的**数据**面——结构定义、严格校验、内置默认书。
 *
 * 规格来自 05 §9.1/§9.2：事件是数据（JSON，可在后台编辑），代码只做判定与执行。
 * 本文件是纯函数（`core/` 的 R8：不读时钟、不碰 IO）——"现在几点"由调用方传入，
 * 校验只吐具名问题（`events[2]（dream）: trigger.from 必须是 HH:MM`），绝不抛穿。
 *
 * 内置默认书必须**复现今天的四种主动行为**（巡逻 / 早报 / 梦境 / 自进化与知识
 * 抽取），外加 dm-visit（今天的主动私聊）与 §9.1 例子里的 heartbeat（默认关，
 * 用来验证脚本通路）。`template` 写的是人格包里**实际存在**的键名。
 */

import { parseHhMm, type QuietRange, type Trigger } from './due.js'

export type EventKind = 'prompt' | 'job' | 'script'

/** `requires` 的两种可用判据（§9.2 要求"至少实现"的两个）。 */
export type Requirement = 'room-has-session' | 'turn-idle'

export const REQUIREMENTS: readonly Requirement[] = ['room-has-session', 'turn-idle']

/** 早报素材的可选名（都在 `features/proactive/materials.ts` 里有实现）。 */
export type MaterialName = 'date' | 'weather' | 'schedule' | 'yesterday-activity'

export const MATERIAL_NAMES: readonly MaterialName[] = ['date', 'weather', 'schedule', 'yesterday-activity']

export interface EventScript {
  readonly argv: readonly string[]
  readonly timeoutSec: number
}

/** 一条归一化之后的事件（缺省值都已填好）。 */
export interface BookEvent {
  readonly id: string
  readonly enabled: boolean
  readonly kind: EventKind
  readonly trigger: Trigger
  readonly quietHours: readonly QuietRange[]
  /** 只有 prompt 有：`primary-group` / `master-dm` / `group:<号>` / `dm:<号>`。 */
  readonly target: string | null
  /** 只有 prompt 有：人格包模板键名。 */
  readonly template: string | null
  readonly materials: readonly MaterialName[]
  readonly requires: readonly Requirement[]
  /** 只有 job 有：注册表里的处理器名（`registerJob`）。 */
  readonly job: string | null
  readonly script: EventScript | null
}

export interface EventBook {
  readonly version: 1
  readonly events: readonly BookEvent[]
}

export type BookParse = { readonly ok: true; readonly book: EventBook } | { readonly ok: false; readonly problems: readonly string[] }

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TARGET_RE = /^(primary-group|master-dm|group:\d+|dm:\d+)$/
const EVENT_KEYS = new Set(['id', 'enabled', 'kind', 'trigger', 'quietHours', 'target', 'template', 'materials', 'requires', 'job', 'script'])
const TRIGGER_KEYS = new Set(['type', 'everyMin', 'jitterMin', 'runOnBoot', 'from', 'to', 'once'])
const SCRIPT_KEYS = new Set(['argv', 'timeoutSec'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** "这个键写了吗"：显式的 `null` 与**空数组**都等价于不写（内置默认书用 `job: null`、
 * `materials: []` 表达"没有"，那是这本默认书自己的完整形状，不是冲突字段）。 */
function present(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value) && value.length === 0) return false
  return true
}

/** 未知字段一律报错而不是忽略：写错的键（`intervall`）必须当声报出来，"配了却没生效"是 B 系列的原病。 */
function checkKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, where: string, problems: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) problems.push(`${where}: 不认识的字段「${key}」`)
  }
}

function parseTrigger(raw: unknown, where: string, problems: string[]): Trigger | null {
  if (!isRecord(raw)) { problems.push(`${where}: trigger 必须是对象`); return null }
  checkKeys(raw, TRIGGER_KEYS, `${where}: trigger`, problems)
  if (raw.type === 'interval') {
    const everyMin = raw.everyMin
    if (typeof everyMin !== 'number' || !Number.isFinite(everyMin) || everyMin < 1 || everyMin > 10_080) {
      problems.push(`${where}: trigger.everyMin 必须是 1–10080 的数字（分钟）`)
      return null
    }
    const jitterMin = raw.jitterMin === undefined ? 0 : raw.jitterMin
    if (typeof jitterMin !== 'number' || !Number.isFinite(jitterMin) || jitterMin < 0 || jitterMin >= everyMin) {
      problems.push(`${where}: trigger.jitterMin 必须是 [0, everyMin) 内的数字`)
      return null
    }
    if (raw.runOnBoot !== undefined && typeof raw.runOnBoot !== 'boolean') {
      problems.push(`${where}: trigger.runOnBoot 必须是 true/false`)
      return null
    }
    return { type: 'interval', everyMin, jitterMin, runOnBoot: raw.runOnBoot === true }
  }
  if (raw.type === 'window') {
    const fromMin = typeof raw.from === 'string' ? parseHhMm(raw.from) : null
    const toMin = typeof raw.to === 'string' ? parseHhMm(raw.to) : null
    if (fromMin === null) { problems.push(`${where}: trigger.from 必须是 HH:MM`); return null }
    if (toMin === null) { problems.push(`${where}: trigger.to 必须是 HH:MM`); return null }
    if (fromMin > toMin) { problems.push(`${where}: trigger.from 不能晚于 trigger.to（窗口不支持跨午夜）`); return null }
    if (raw.once !== undefined && raw.once !== 'day') { problems.push(`${where}: trigger.once 只能是 "day"`); return null }
    return { type: 'window', from: raw.from as string, to: raw.to as string }
  }
  problems.push(`${where}: trigger.type 必须是 "interval" 或 "window"`)
  return null
}

function parseQuiet(raw: unknown, where: string, problems: string[]): QuietRange[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) { problems.push(`${where}: quietHours 必须是数组`); return [] }
  const out: QuietRange[] = []
  for (const [i, item] of raw.entries()) {
    const at = `${where}: quietHours[${i}]`
    if (!isRecord(item)) { problems.push(`${at} 必须是对象`); continue }
    checkKeys(item, new Set(['from', 'to']), at, problems)
    if (typeof item.from !== 'string' || parseHhMm(item.from) === null) { problems.push(`${at}.from 必须是 HH:MM`); continue }
    if (typeof item.to !== 'string' || parseHhMm(item.to) === null) { problems.push(`${at}.to 必须是 HH:MM`); continue }
    if (parseHhMm(item.from) === parseHhMm(item.to)) { problems.push(`${at}: from 与 to 不能相同`); continue }
    out.push({ from: item.from, to: item.to })
  }
  return out
}

function parseStringList<T extends string>(raw: unknown, allowed: readonly T[], where: string, problems: string[]): T[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) { problems.push(`${where} 必须是数组`); return [] }
  const out: T[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !(allowed as readonly string[]).includes(item)) {
      problems.push(`${where} 只认：${allowed.join(' / ')}（收到 ${JSON.stringify(item)}）`)
      continue
    }
    out.push(item as T)
  }
  return out
}

function parseScript(raw: unknown, where: string, problems: string[]): EventScript | null {
  if (!isRecord(raw)) { problems.push(`${where}: script 必须是对象`); return null }
  checkKeys(raw, SCRIPT_KEYS, `${where}: script`, problems)
  const argv = raw.argv
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((p) => typeof p !== 'string' || p === '' || /\s/.test(p))) {
    problems.push(`${where}: script.argv 必须是非空字符串数组，且每段不含空白`)
    return null
  }
  const timeoutSec = raw.timeoutSec === undefined ? 60 : raw.timeoutSec
  if (typeof timeoutSec !== 'number' || !Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 600) {
    problems.push(`${where}: script.timeoutSec 必须是 1–600 的数字（秒）`)
    return null
  }
  return { argv: argv as string[], timeoutSec }
}

/** 一条事件校验到一半时的公共部分（三个 kind 分支共用）。 */
interface EventBase {
  readonly id: string
  readonly enabled: boolean
  readonly label: string
  readonly trigger: Trigger | null
  readonly quietHours: readonly QuietRange[]
  readonly problems: string[]
}

function parsePromptEvent(raw: Record<string, unknown>, base: EventBase): BookEvent | null {
  const { label, problems } = base
  const target = raw.target
  if (typeof target !== 'string' || !TARGET_RE.test(target)) problems.push(`${label}: prompt 的 target 只能是 primary-group / master-dm / group:<号> / dm:<号>`)
  if (typeof raw.template !== 'string' || raw.template === '') problems.push(`${label}: prompt 必须有 template（人格包键名）`)
  if (present(raw.job) || present(raw.script)) problems.push(`${label}: prompt 事件不写 job / script`)
  const materials = parseStringList(raw.materials, MATERIAL_NAMES, `${label}: materials`, problems)
  const requires = parseStringList(raw.requires, REQUIREMENTS, `${label}: requires`, problems)
  if (base.trigger === null) return null
  return {
    id: base.id, enabled: base.enabled, kind: 'prompt', trigger: base.trigger, quietHours: base.quietHours,
    target: typeof target === 'string' && TARGET_RE.test(target) ? target : null,
    template: typeof raw.template === 'string' && raw.template !== '' ? raw.template : null,
    materials, requires, job: null, script: null,
  }
}

function parseJobEvent(raw: Record<string, unknown>, base: EventBase): BookEvent | null {
  const { label, problems } = base
  if (typeof raw.job !== 'string' || raw.job === '') problems.push(`${label}: job 事件必须有 job（处理器名）`)
  if (present(raw.target) || present(raw.template) || present(raw.materials) || present(raw.requires) || present(raw.script)) {
    problems.push(`${label}: job 事件不写 target / template / materials / requires / script`)
  }
  if (base.trigger === null) return null
  return {
    id: base.id, enabled: base.enabled, kind: 'job', trigger: base.trigger, quietHours: base.quietHours,
    target: null, template: null, materials: [], requires: [],
    job: typeof raw.job === 'string' && raw.job !== '' ? raw.job : null, script: null,
  }
}

function parseScriptEvent(raw: Record<string, unknown>, base: EventBase): BookEvent | null {
  const { label, problems } = base
  if (present(raw.target) || present(raw.template) || present(raw.materials) || present(raw.requires) || present(raw.job)) {
    problems.push(`${label}: script 事件不写 target / template / materials / requires / job`)
  }
  const script = parseScript(raw.script, label, problems)
  if (base.trigger === null) return null
  return {
    id: base.id, enabled: base.enabled, kind: 'script', trigger: base.trigger, quietHours: base.quietHours,
    target: null, template: null, materials: [], requires: [], job: null, script,
  }
}

/** 一条事件的校验；（合法时）返回归一化后的值。 */
function parseEvent(raw: unknown, index: number, seen: Set<string>, problems: string[]): BookEvent | null {
  const where = `events[${index}]`
  if (!isRecord(raw)) { problems.push(`${where}: 必须是对象`); return null }
  checkKeys(raw, EVENT_KEYS, where, problems)

  const id = raw.id
  let label = where
  if (typeof id !== 'string' || !ID_RE.test(id)) problems.push(`${where}: id 必须以字母/数字开头（≤64 字符，可用 . _ -）`)
  else if (seen.has(id)) problems.push(`${where}: id「${id}」与前面重复`)
  else seen.add(id)
  if (typeof id === 'string' && ID_RE.test(id)) label = `${where}（${id}）`

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') problems.push(`${label}: enabled 必须是 true/false`)
  const kind = raw.kind
  if (kind !== 'prompt' && kind !== 'job' && kind !== 'script') {
    problems.push(`${label}: kind 必须是 "prompt" / "job" / "script"`)
    return null
  }
  const base: EventBase = {
    id: id as string, enabled: raw.enabled !== false, label, problems,
    trigger: parseTrigger(raw.trigger, label, problems),
    quietHours: parseQuiet(raw.quietHours, label, problems),
  }
  if (kind === 'prompt') return parsePromptEvent(raw, base)
  if (kind === 'job') return parseJobEvent(raw, base)
  return parseScriptEvent(raw, base)
}

/** 解析并校验一份事件书；所有问题一次报全（后台保存时直接展示清单）。 */
export function parseEventBook(raw: unknown): BookParse {
  const problems: string[] = []
  if (!isRecord(raw)) return { ok: false, problems: ['事件书必须是 JSON 对象'] }
  checkKeys(raw, new Set(['version', 'events']), '事件书', problems)
  if (raw.version !== 1) problems.push('version 必须是 1')
  if (!Array.isArray(raw.events)) {
    problems.push('events 必须是数组')
    return { ok: false, problems }
  }
  const events: BookEvent[] = []
  const seen = new Set<string>()
  raw.events.forEach((item, index) => {
    const parsed = parseEvent(item, index, seen, problems)
    if (parsed !== null) events.push(parsed)
  })
  return problems.length === 0 ? { ok: true, book: { version: 1, events } } : { ok: false, problems }
}

/**
 * 内置默认书：复现今天的全部主动行为。
 *
 * 与旧 `Scheduler` 的时刻表逐条对应（见 events.ts 的搬迁注记）：
 * 巡逻 9±1 分钟（01:00–07:30 静默，只在大群有会话时跑）、早报 06:00–11:59、
 * 梦 04:00–04:59、自省每 6 小时、主动私聊 22±1.5 分钟（01:00–08:00 静默）、
 * 知识抽取 04:00–08:59；另加默认关的 heartbeat 脚本例。
 */
export function defaultEventBook(): EventBook {
  return { version: 1, events: [...PROMPT_EVENTS, ...JOB_EVENTS, ...NIGHTLY_EVENTS, HEARTBEAT_EVENT] }
}

/** 复现今天的四种主动行为 + 主动私聊（时刻表见本函数上方注记）。 */
const PROMPT_EVENTS: readonly BookEvent[] = [

  {
    id: 'patrol', enabled: true, kind: 'prompt',
    trigger: { type: 'interval', everyMin: 9, jitterMin: 1, runOnBoot: false },
    quietHours: [{ from: '01:00', to: '07:30' }],
    target: 'primary-group', template: 'proactive/patrol',
    materials: [], requires: ['room-has-session', 'turn-idle'], job: null, script: null,
  },
  {
    id: 'morning-report', enabled: true, kind: 'prompt',
    trigger: { type: 'window', from: '06:00', to: '11:59' },
    quietHours: [],
    target: 'master-dm', template: 'events/morning-report',
    // 顺序与旧实现的素材拼接顺序逐字对齐（日期 → 课表 → 天气 → 昨天活跃）。
    materials: ['date', 'schedule', 'weather', 'yesterday-activity'],
    requires: ['turn-idle'], job: null, script: null,
  },
  {
    id: 'dream', enabled: true, kind: 'prompt',
    trigger: { type: 'window', from: '04:00', to: '04:59' },
    quietHours: [],
    target: 'primary-group', template: 'proactive/dream',
    materials: [], requires: ['turn-idle'], job: null, script: null,
  },
  {
    id: 'evolve', enabled: true, kind: 'prompt',
    trigger: { type: 'interval', everyMin: 360, jitterMin: 0, runOnBoot: false },
    quietHours: [],
    // 事件书用 v2 版文案（D4 §7.6）：学到的写成记忆记录，**不再追加 MEMORY.md**
    // ——那份大文件已经冻结，核心摘要有 DIGEST 管。旧 Scheduler 仍用 `proactive/evolve`。
    target: 'primary-group', template: 'events/evolve-record',
    materials: [], requires: ['turn-idle'], job: null, script: null,
  },
  {
    id: 'dm-visit', enabled: true, kind: 'prompt',
    trigger: { type: 'interval', everyMin: 22, jitterMin: 1.5, runOnBoot: false },
    quietHours: [{ from: '01:00', to: '08:00' }],
    target: 'master-dm', template: 'events/dm-visit',
    materials: [], requires: ['turn-idle'], job: null, script: null,
  },
]

/** 旧知识抽取（写老库的 `entries.json`）；`memory.v2` 开时它让位给 e3 的 `memory.diary-extract`。 */
const JOB_EVENTS: readonly BookEvent[] = [
  {
    id: 'knowledge-extract', enabled: true, kind: 'job',
    trigger: { type: 'window', from: '04:00', to: '08:59' },
    quietHours: [],
    target: null, template: null, materials: [], requires: [],
    job: 'knowledge.extract', script: null,
  },
]

/** 默认关的脚本例：用来验证脚本通路（不指向任何真实脚本）。 */
const HEARTBEAT_EVENT: BookEvent = {
  id: 'heartbeat', enabled: false, kind: 'script',
  trigger: { type: 'interval', everyMin: 30, jitterMin: 0, runOnBoot: false },
  quietHours: [],
  target: null, template: null, materials: [], requires: [], job: null,
  script: { argv: ['node', 'scripts/heartbeat.mjs'], timeoutSec: 60 },
}

/** 夜间巩固的十条 job 事件（时间表来自 09 §6.2 + P1 巩固；`job` 名在 `features/memory/nightly.ts` 注册）。 */
const NIGHTLY_EVENTS: readonly BookEvent[] = [
  // 先建块索引：后面的抽取/反思都从"原文块"里找依据。
  ['memory.chunks', '03:50'],
  ['memory.diary-extract', '04:20'],
  ['memory.session-split', '04:40'],
  // P1 巩固在会话分解之后、反思之前：先合并重复，反思看到的就不是满库重复。
  ['memory.consolidate', '04:55'],
  ['memory.reflect', '05:10'],
  ['memory.links', '05:30'],
  ['memory.contradictions', '05:50'],
  ['memory.forget', '06:05'],
  ['memory.digest', '06:20'],
  ['memory.reindex', '06:30'],
].map(([job, from]) => ({
  id: job ?? '',
  enabled: true,
  kind: 'job' as const,
  trigger: { type: 'window' as const, from: from ?? '00:00', to: windowEnd(from ?? '00:00') },
  quietHours: [],
  target: null, template: null, materials: [], requires: [],
  job: job ?? null, script: null,
}))

/** `HH:MM` + 39 分钟（窗口给到"那一小时的 59 分"），跨小时就接到下一小时。 */
function windowEnd(from: string): string {
  const at = parseHhMm(from)
  if (at === null) return from
  const end = Math.min(23 * 60 + 59, at + 39)
  const h = Math.floor(end / 60)
  const m = end % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
