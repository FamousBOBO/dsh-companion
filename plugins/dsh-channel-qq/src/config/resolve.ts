/** 配置解析：默认值、逐层合并、以及"哪些字段整体替换"。
 *
 * 拆出来是因为 `config.ts` 已经装着 30 个 interface（那份文件是**类型的视图**，
 * 也是别处 `import type { QQChannelConfig }` 的入口）；把合并逻辑塞在同一边会
 * 让两边都读不动。合并规则本身来自 `schema.ts`。
 */

import type { QQChannelConfig } from '../config.js'
import { NO_DEFAULT, SCHEMA, groupOf, type FieldSpec } from './schema.js'

/**
 * 默认配置：**由 schema 生成**（P2.7）。
 *
 * 以前这里是手写的一份字面量，与 `resolveConfig` 里那一长串手工合并并列存在——
 * 加一个字段要改三处（interface / DEFAULT_CONFIG / resolveConfig 的那一行），
 * 漏一处不会报错，只会"这个配置项不生效"。现在三者都从 `config/schema.ts` 来。
 */
export const DEFAULT_CONFIG: QQChannelConfig = buildDefaults()

/**
 * 把一份配置当成普通记录来看。
 *
 * schema 驱动的合并要在键上迭代，而 `QQChannelConfig` 没有索引签名——需要一次
 * 收窄。这里**不是**"赌它的形状"：`record` 与 `value` 指的是同一个对象，键集由
 * schema 与那个 interface 的编译期断言保证；只是类型系统看不见这层保证。
 * 写成 `as Record<string, unknown>`（而不是 `as unknown as`）还有一个好处：
 * `check-layers` 的 R7 能继续拦真正的"形状猜测"。
 */
function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>
}

/** 一层里的一段：不是普通对象（`null` / 数组 / 字符串）时返回 undefined，交给 mergeFields 跳过。 */
function asLayer(value: unknown): object | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** 由 schema 生成一段的默认值（跳过"可选无默认"的字段）。 */
function defaultsOf(fields: Record<string, FieldSpec>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(fields)) {
    if (spec.default === NO_DEFAULT) continue
    out[key] = spec.default
  }
  return out
}

function buildDefaults(): QQChannelConfig {
  const root: Partial<QQChannelConfig> = {}
  const record = asRecord(root)
  for (const [key, spec] of Object.entries(SCHEMA.root)) {
    if ('group' in spec) {
      const group = groupOf(SCHEMA, spec.group)
      record[key] = group === undefined ? {} : defaultsOf(group.fields)
      continue
    }
    if (spec.default === NO_DEFAULT) continue
    record[key] = spec.default
  }
  return root as QQChannelConfig
}

/**
 * 逐字段合并一层。
 *
 * 与 `Object.assign` 的两处差别都是有意的：
 *   - **`undefined` 不覆盖**。`Object.assign({}, base, {talkValue: undefined})`
 *     会把值抹成 undefined，于是一个"配置项被显式写成空"的脏文件能让整段失效；
 *   - **非对象一律跳过**。原来 `admin: "nope"` 会被当成字符索引铺开
 *     （`{"0":"n","1":"o",…}`），那是 bug 不是行为。
 */
/**
 * 按 schema 把"存进去的值"归一成运行时该有的类型。
 *
 * 为什么必须有：后台/手改的 JSON 里数字常常是字符串（`"1000000004"`），而消费方
 * 全是 `chatId === primaryGroup` 这类**严格比较**——类型不对不会报错，只会静默失效
 * （2026-10-19 排查：主群号存成字符串，于是偷表情包、主群专用回复、按群覆盖全恒假）。
 *
 * 只在"能无损转换"时动手：数字串 → 数字、`"true"/"false"` → 布尔、数字数组里的
 * 数字串 → 数字。其余原样返回——绝不把一个错值改造成另一种错值。
 */
function coerceValue(spec: FieldSpec, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (spec.kind === 'number') {
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : value
    }
    return value
  }
  if (spec.kind === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    return value
  }
  if (spec.kind === 'list' && spec.itemsKind === 'number' && Array.isArray(value)) {
    return value.map((item: unknown) => {
      if (typeof item === 'number') return item
      if (typeof item === 'string' && item.trim() !== '') {
        const parsed = Number(item)
        return Number.isFinite(parsed) ? parsed : item
      }
      return item
    })
  }
  return value
}

function mergeFields<T extends object>(
  base: T,
  ...layers: Array<Partial<T> | null | undefined>
): T {
  const out = { ...base } as Record<string, unknown>
  for (const layer of layers) {
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) continue
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) out[key] = value
    }
  }
  return out as T
}

/**
 * Deep-merge the config layers over the defaults, in precedence order:
 *   DEFAULT_CONFIG  ←  patch (the cordis row's user layer)  ←  override (the
 *   admin panel's persisted file).
 *
 * Sub-objects are merged field-by-field rather than replaced, so a patch that
 * only sets one knob never wipes the rest of that section. 数组是**整值替换**：
 * 数组没有"逐字段合并"这回事，把两层拼起来只会得到一个谁也没要过的列表。
 *
 * 合并规则本身来自 `SCHEMA`：哪一项是段、哪一项整体替换，都在那里写着。
 */
export function resolveConfig(
  patch?: Partial<QQChannelConfig>,
  override?: Partial<QQChannelConfig>,
): QQChannelConfig {
  const raw = Object.assign({}, DEFAULT_CONFIG, patch ?? {}, override ?? {})
  const record = asRecord(raw)

  for (const [key, spec] of Object.entries(SCHEMA.root)) {
    if ('group' in spec) {
      const base = asRecord(DEFAULT_CONFIG)[key]
      const patchLayer = asLayer(asRecord(patch ?? {})[key])
      const overrideLayer = asLayer(asRecord(override ?? {})[key])
      const merged = mergeFields(base as object, patchLayer, overrideLayer) as Record<string, unknown>
      const group = groupOf(SCHEMA, spec.group)
      if (group !== undefined) {
        for (const [field, fieldSpec] of Object.entries(group.fields)) {
          if (field in merged) merged[field] = coerceValue(fieldSpec, merged[field])
        }
      }
      record[key] = merged
      continue
    }
    const fromOverride = asRecord(override ?? {})[key]
    const fromPatch = asRecord(patch ?? {})[key]
    if (spec.wholesale === true) {
      // 数组：整值替换；类型不对就当作没给（旧实现对 cruises 就是这么做的）。
      record[key] = Array.isArray(fromOverride) ? fromOverride
        : Array.isArray(fromPatch) ? fromPatch
          : spec.default
      continue
    }
    const value = fromOverride ?? fromPatch
    if (value !== undefined) { record[key] = coerceValue(spec, value); continue }
    if (spec.default === NO_DEFAULT) delete record[key]
    else record[key] = spec.default
  }
  return raw
}

