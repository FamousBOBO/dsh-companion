/** 配置元数据读取：字段清单、热生效等级、敏感项、重启级路径、值校验。
 *
 * `schema.ts` 是**声明**（FieldSpec 上的可选元数据）；这里是**读取语义**——包括
 * 那条保守默认：**未标注 `hot` 的字段一律按 `restart` 处理**（内部文档 §6.1）。
 *
 * 为什么集中在这里：后台徽章、保存管线（restartRequired）、快照与日志掩码、
 * 表单渲染的字段投影、覆盖性检查——五处消费同一份 schema。如果各消费方各自
 * 解释元数据，"这个字段到底热不热"就会在不同地方给出不同答案。
 */

import type { ConfigSchema, FieldSpec, HotLevel } from './schema.js'
import { SCHEMA } from './schema.js'
import { NO_DEFAULT } from './dsl.js'

/** 字段的一行投影（后台 schema 视图 / 覆盖性检查共用）。 */
export interface FieldRef {
  /** dot-path，如 `tts.voice` / `selfId`。 */
  path: string
  /** 所属段 id；顶层字段为 null。 */
  section: string | null
  /** 该字段落在哪一页（字段级 `page` 优先，其次段级 `page`）。 */
  page: string | null
  spec: FieldSpec
}

/** 热生效等级；未显式标注 = `restart`（保守，spec §6.1）。 */
export function hotOf(spec: FieldSpec): HotLevel {
  return spec.hot ?? 'restart'
}

/** 全部字段，按 schema 声明顺序（与 `DEFAULT_CONFIG` 的键顺序一致）。 */
export function fieldRefs(schema: ConfigSchema = SCHEMA): FieldRef[] {
  const out: FieldRef[] = []
  for (const [key, spec] of Object.entries(schema.root)) {
    if ('group' in spec) {
      const group = schema.groups.find((g) => g.id === spec.group)
      if (group === undefined) continue
      for (const [fieldKey, fieldSpec] of Object.entries(group.fields)) {
        out.push({
          path: `${key}.${fieldKey}`,
          section: group.id,
          page: fieldSpec.page ?? group.page ?? null,
          spec: fieldSpec,
        })
      }
      continue
    }
    out.push({ path: key, section: null, page: spec.page ?? null, spec })
  }
  return out
}

/**
 * 按点路径找字段。
 *
 * 先精确命中；未命中时向上一层找，但只有**最近的祖先字段是 `json`（对象值）**
 * 才接受——那种字段的内部键（如 `turn.maxSteps.dm`）不在 schema 里，可它们确实
 * 由那个字段覆盖。最近的祖先不是 json 字段（或根本不存在）时判为未知路径。
 */
export function fieldRefForPath(path: string, refs: FieldRef[] = fieldRefs()): FieldRef | undefined {
  const byPath = new Map(refs.map((ref) => [ref.path, ref]))
  const direct = byPath.get(path)
  if (direct !== undefined) return direct
  const parts = path.split('.')
  for (let end = parts.length - 1; end > 0; end -= 1) {
    const hit = byPath.get(parts.slice(0, end).join('.'))
    if (hit !== undefined) return hit.spec.kind === 'json' ? hit : undefined
  }
  return undefined
}

/** 单个 dot-path 的热生效等级（未知路径按 restart）；json 对象字段的内部键归并到字段本身。 */
export function hotOfPath(path: string, schema: ConfigSchema = SCHEMA): HotLevel {
  const hit = fieldRefForPath(path, fieldRefs(schema))
  return hit === undefined ? 'restart' : hotOf(hit.spec)
}

/** 保存时"需要重启插件"的 dot-path 集合（保存管线判据，取代手写 RESTART_PATHS）。 */
export function restartPaths(schema: ConfigSchema = SCHEMA): string[] {
  return fieldRefs(schema).filter((f) => hotOf(f.spec) === 'restart').map((f) => f.path)
}

/** 敏感字段（快照/日志掩码）：只回传"是否已设置"，不回传值。 */
export function secretPaths(schema: ConfigSchema = SCHEMA): string[] {
  return fieldRefs(schema).filter((f) => f.spec.secret === true).map((f) => f.path)
}

/**
 * 单字段的值校验（服务端保存管线与前端本地预检共用同一份规则）。
 * 返回 `null` = 通过；否则是给操作者看的中文原因。
 */
export function validateValue(spec: FieldSpec, value: unknown): string | null {
  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : '应为开关值（true/false）'
    case 'number': {
      // `NO_DEFAULT` 的可选数字（如 primaryTalkValue）允许 null = "取消覆盖"。
      // `null` 表示"未设置"：既包括 NO_DEFAULT 的可选字段，也包括默认值本来就是
      // null 的字段（如 primaryGroup）。
      if (value === null) return spec.default === NO_DEFAULT || spec.default === null ? null : '不能为空'
      if (typeof value !== 'number' || !Number.isFinite(value)) return '应为数字'
      if (spec.min !== undefined && value < spec.min) return `不能小于 ${spec.min}`
      if (spec.max !== undefined && value > spec.max) return `不能大于 ${spec.max}`
      return null
    }
    case 'enum': {
      const ok = (spec.choices ?? []).some((c) => c.value === value)
      return ok ? null : `只能是：${(spec.choices ?? []).map((c) => c.value).join(' / ')}`
    }
    case 'string':
      return value === null || typeof value === 'string' ? null : '应为字符串（可空）'
    case 'list': {
      if (!Array.isArray(value)) return '应为数组'
      const bad = value.find((v) => typeof v !== 'string' && typeof v !== 'number')
      return bad === undefined ? null : `数组项必须是字符串或数字（收到 ${typeof bad}）`
    }
    case 'json':
      if (value === null || typeof value !== 'object') return '应为数组或对象'
      return null
    default:
      return null
  }
}

// ── `/api/schema` 的视图 ───────────────────────────────────────────────────

/** 字段元数据里可以出网的部分（不含 `wholesale` 这类内部实现细节）。 */
export interface SchemaFieldView {
  path: string
  section: string | null
  page: string | null
  kind: FieldSpec['kind']
  label: string
  help?: string
  min?: number
  max?: number
  step?: number
  unit?: string
  placeholder?: string
  choices?: Array<{ value: string; label: string }>
  secret?: boolean
  advanced?: boolean
  hot: HotLevel
  dormant?: boolean
  hiddenIf?: FieldSpec['hiddenIf']
  itemsKind?: 'string' | 'number'
  itemFields?: FieldSpec['itemFields']
  idKey?: string
  /** 有默认值 → 前端出「还原默认」；`default` 随之下发。 */
  hasDefault: boolean
  /** `NO_DEFAULT` 的可选数字允许 null（清空 = 取消覆盖）。 */
  allowNull?: boolean
  default?: unknown
}

export interface SchemaSectionView {
  id: string
  label: string
  help?: string
  page: string | null
}

function serializeField(ref: FieldRef): SchemaFieldView {
  const spec = ref.spec
  const hasDefault = spec.default !== NO_DEFAULT
  const view: SchemaFieldView = {
    path: ref.path,
    section: ref.section,
    page: ref.page,
    kind: spec.kind,
    label: spec.label,
    hot: hotOf(spec),
    hasDefault,
  }
  if (hasDefault) view.default = spec.default
  else if (spec.kind === 'number') view.allowNull = true
  if (spec.help !== undefined) view.help = spec.help
  if (spec.min !== undefined) view.min = spec.min
  if (spec.max !== undefined) view.max = spec.max
  if (spec.step !== undefined) view.step = spec.step
  if (spec.unit !== undefined) view.unit = spec.unit
  if (spec.placeholder !== undefined) view.placeholder = spec.placeholder
  if (spec.choices !== undefined) view.choices = spec.choices
  if (spec.secret !== undefined) view.secret = spec.secret
  if (spec.advanced !== undefined) view.advanced = spec.advanced
  if (spec.dormant !== undefined) view.dormant = spec.dormant
  if (spec.hiddenIf !== undefined) view.hiddenIf = spec.hiddenIf
  if (spec.itemsKind !== undefined) view.itemsKind = spec.itemsKind
  if (spec.itemFields !== undefined) view.itemFields = spec.itemFields
  if (spec.idKey !== undefined) view.idKey = spec.idKey
  return view
}

/** 管理后台表单的字段/段投影（`GET /api/schema` 的主体）。 */
export function schemaView(schema: ConfigSchema = SCHEMA): { sections: SchemaSectionView[]; fields: SchemaFieldView[] } {
  const sections = schema.groups.map((group) => ({
    id: group.id, label: group.label, help: group.help, page: group.page ?? null,
  }))
  return { sections, fields: fieldRefs(schema).map(serializeField) }
}
