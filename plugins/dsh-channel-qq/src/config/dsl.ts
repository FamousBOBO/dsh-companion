/** schema DSL：类型与字段构造助手（自实现，无新依赖）。
 *
 * 一份定义（`sections/*`）同时产出：默认值、逐层合并规则（`resolve.ts`）、后台表单
 * 元数据、**热生效等级**与页面归属（`meta.ts` 读取）。字段定义拆到 `sections/`
 * 是 P5.6 的落点：每个模块一段，新增配置项的成本 = 改一处。
 */

/** 字段的取值形态。决定默认值的类型，也决定后台用哪种控件。 */
export type FieldKind =
  | 'boolean'
  | 'number'
  | 'string'        // 含 `null` 表示"用内置默认位置"的可选路径
  | 'enum'
  | 'json'          // 结构化值（对象或对象数组），后台按 JSON/专用编辑器编辑
  | 'list'          // 标量数组

/**
 * 三级热生效（内部文档 §6.1），判定依据是"这个值被谁读"：
 *   - `live`：读配置对象时每次现取（P0 的原地合并保证引用有效）；
 *   - `reload`：模块初始化时取值，但保存有对应的热重载处理（重连/重听/重读目录）；
 *   - `restart`：决定 socket/端口/工作区/会话组合，或消费者在注册时解析一次——
 *     **未显式标注的字段一律按本级处理（保守）**。
 */
export type HotLevel = 'live' | 'reload' | 'restart'

/** 结构化数组（对象数组）的行内字段：后台的行编辑器按它渲染。 */
export interface ItemFieldSpec {
  key: string
  label: string
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'list'
  choices?: Array<{ value: string; label: string }>
  placeholder?: string
  help?: string
}

export interface FieldSpec {
  kind: FieldKind
  /** 默认值；`NO_DEFAULT` 表示"默认配置里没有这个键"。 */
  default: unknown
  /** 后台显示的中文名。 */
  label: string
  /** 一句话说明（后台显示在控件下方）。 */
  help?: string
  /** 数字的取值范围与步长。 */
  min?: number
  max?: number
  step?: number
  /** `enum` 的可选项（value → 中文说明）。 */
  choices?: Array<{ value: string; label: string }>
  /** 列表类字段：**整值替换**而不是逐项合并（数组没有"逐字段合并"这回事）。 */
  wholesale?: boolean
  /** 敏感值：后台不回传明文，只回传"是否已设置"；日志与快照一律掩码。 */
  secret?: boolean
  /** 热生效等级（见 {@link HotLevel}）。 */
  hot?: HotLevel
  /** 折叠到「进阶」区（默认收起）。 */
  advanced?: boolean
  /** 单位（显示用，如 "ms" / "秒"）。 */
  unit?: string
  /** 输入框占位符。 */
  placeholder?: string
  /**
   * 依赖其他字段的显隐：`equals` 命中或 `notEquals` 不命中时**隐藏**。
   * `field` 是另一个字段的 dot-path。
   */
  hiddenIf?: { field: string; equals?: unknown; notEquals?: unknown }
  /**
   * 当前没有任何消费者（暂未接线）。后台照常可编辑并显示提示，
   * **不谎称生效**——"保存了却没生效"正是这次重构要消灭的体验。
   */
  dormant?: boolean
  /** 该字段落在哪一页（顶层字段用；段字段默认继承段级 page）。 */
  page?: string
  /** `list` 字段的项类型（决定编辑器和值解析：数字数组 vs 字符串数组）。 */
  itemsKind?: 'string' | 'number'
  /** `json`（对象数组）字段的专用行编辑器字段表；缺省则退回原始 JSON 编辑。 */
  itemFields?: readonly ItemFieldSpec[]
  /** 行编辑器新增行时用于生成行 id 的键名（如 `id`）。 */
  idKey?: string
}

/** 可选字段的占位符：默认配置里不放这个键。 */
export const NO_DEFAULT = Symbol('no-default')

export interface FieldGroup {
  id: string
  /** 后台的分栏标题。 */
  label: string
  help?: string
  /** 这一段整体落在哪一页（字段可用自身 `page` 覆盖）。 */
  page?: string
  fields: Record<string, FieldSpec>
}

export interface ConfigSchema {
  /** 顶层字段；`kind: 'json'` 且带 `group` 的表示"这是一个段"。 */
  root: Record<string, FieldSpec | SectionFieldSpec>
  groups: FieldGroup[]
}

/** 顶层字段的一种：它是一个"段"，指向 `groups` 里的一项。 */
export type SectionFieldSpec = FieldSpec & { group: string }

/** 元数据的两种写法：老式的一句话 help，或完整的 meta 对象。 */
type Meta = string | Partial<FieldSpec>

function metaOf(meta?: Meta): Partial<FieldSpec> {
  if (meta === undefined) return {}
  if (typeof meta === 'string') return { help: meta }
  return meta
}

// 取值一律收 `unknown`：`default` 的静态类型是 `unknown`（它可以是布尔、数字、
// 字符串、数组或 `NO_DEFAULT` 哨兵），helper 只负责把 `kind`/`label` 填好。
// 收窄具体类型会让 `NO_DEFAULT` 需要一次转型，而那个转型什么也没换来。

export const b = (label: string, value: unknown, meta?: Meta): FieldSpec =>
  ({ kind: 'boolean', default: value, label, ...metaOf(meta) })

export const n = (label: string, value: unknown, meta?: Meta): FieldSpec =>
  ({ kind: 'number', default: value, label, ...metaOf(meta) })

export const s = (label: string, value: unknown, meta?: Meta): FieldSpec =>
  ({ kind: 'string', default: value, label, ...metaOf(meta) })

export const e = (
  label: string, value: string, choices: Array<[string, string]>, meta?: Meta,
): FieldSpec => ({
  kind: 'enum', default: value, label,
  choices: choices.map(([v, l]) => ({ value: v, label: l })),
  ...metaOf(meta),
})

export const list = (label: string, value: unknown[], meta?: Meta): FieldSpec =>
  ({ kind: 'list', default: value, label, wholesale: true, ...metaOf(meta) })

/** 结构化值（对象或对象数组）：后台按 JSON 或专用行编辑器编辑。 */
export const json = (label: string, value: unknown, meta?: Meta): FieldSpec =>
  ({ kind: 'json', default: value, label, wholesale: true, ...metaOf(meta) })

/** 一个"段"（`groups` 里的一项）。 */
export const section = (label: string, groupId: string, meta?: Partial<FieldSpec>): SectionFieldSpec =>
  ({ kind: 'json', default: {}, label, group: groupId, ...(meta ?? {}) })
