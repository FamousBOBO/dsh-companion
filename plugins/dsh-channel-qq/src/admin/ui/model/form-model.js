/** 纯函数：`/api/schema` + 配置值 → 表单模型 / 变更清单。
 *
 * 这一层**不碰 DOM、不碰 fetch**，所以 `node:test` 可以直接测（refactor-plan/10 §9
 * 的"可测试性"要求）：布局探针证明渲染对不对，这里证明"模型算得对不对"——
 * 校验、隐显、diff、序列化这几件事出错时页面看起来都是"能渲染但行为怪"，
 * 只有单测抓得住。
 *
 * 字段元数据形状 = 服务端 `/api/schema` 的 `fields[]` 元素：
 *   { path, section, page, kind, label, help, min, max, step, unit, placeholder,
 *     choices, secret, advanced, hot, dormant, hiddenIf, itemsKind, itemFields,
 *     idKey, hasDefault, default }
 */

/** 三级热生效的中文标签（与 refactor-plan/10 §3 的徽章文案一致）。 */
export const HOT_LABELS = {
  live: '立即生效',
  reload: '保存后自动重载',
  restart: '需重启插件',
}

export function hotLabel(hot) {
  return HOT_LABELS[hot] ?? HOT_LABELS.restart
}

export function hotClass(hot) {
  return hot === 'live' ? 'live' : hot === 'reload' ? 'reload' : 'restart'
}

export function getPath(obj, path) {
  let cur = obj
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

export function setPath(obj, path, value) {
  const parts = String(path).split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
  return obj
}

/** JSON 深拷贝（配置值是纯 JSON）。 */
export function cloneJson(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 按 path 取字段元数据。`schema.fields` 是 `/api/schema` 的平铺列表。 */
export function fieldByPath(schema, path) {
  if (schema === null || schema === undefined || !Array.isArray(schema.fields)) return undefined
  return schema.fields.find((f) => f.path === path)
}

/**
 * 页面模型：某一页要渲染哪些字段。
 * 返回 `{ rootFields, groups }`——
 *   - rootFields：段外顶层字段（该页的"账号与总开关"卡）；
 *   - groups：schema 顺序的段（含 label/help 与属于该页的字段）。
 */
export function fieldsOfPage(schema, pageKey) {
  const fields = Array.isArray(schema?.fields) ? schema.fields : []
  const rootFields = fields.filter((f) => f.section === null && f.page === pageKey)
  const groups = []
  for (const sec of schema?.sections ?? []) {
    if (sec.page !== pageKey) continue
    const own = fields.filter((f) => f.section === sec.id && f.page === pageKey)
    if (own.length === 0) continue
    groups.push({ id: sec.id, label: sec.label, help: sec.help ?? '', fields: own })
  }
  return { rootFields, groups }
}

/** 全部字段（⌘K 面板与"字段数"统计用）。 */
export function allFields(schema) {
  return Array.isArray(schema?.fields) ? schema.fields : []
}

/** hiddenIf 求值：`equals` 命中或 `notEquals` 不命中 → 隐藏。 */
export function isHidden(field, values) {
  const cond = field?.hiddenIf
  if (cond === undefined || cond === null) return false
  const current = getPath(values, cond.field)
  if ('equals' in cond) return deepEqual(current, cond.equals)
  if ('notEquals' in cond) return !deepEqual(current, cond.notEquals)
  return false
}

/** 该字段是否有「还原默认值」可做。 */
export function hasDefault(field) {
  return field?.hasDefault === true
}

/** 默认值的展示形态（用于"还原默认值"）。 */
export function defaultValueOf(field) {
  return field?.default
}

/** 当前值 → 输入框文字。 */
export function serializeValue(field, value) {
  if (value === null || value === undefined) return ''
  if (field?.kind === 'list') return Array.isArray(value) ? value.join(', ') : String(value)
  if (field?.kind === 'json') {
    try { return JSON.stringify(value, null, 1) } catch { return '' }
  }
  return String(value)
}

/** 数字/字符串标量输入 → 值。空串对可空字符串 = `''`（保持旧行为）。 */
export function parseScalar(field, text) {
  const raw = String(text ?? '')
  if (field?.kind === 'number') {
    const trimmed = raw.trim()
    if (trimmed === '') return null
    const num = Number(trimmed)
    return Number.isFinite(num) ? num : null
  }
  return raw
}

/** 逗号/空白分隔的列表输入 → 数组（按 itemsKind 解析数字）。 */
export function parseListText(text, itemsKind) {
  const parts = String(text ?? '').split(/[,，\s]+/).map((x) => x.trim()).filter((x) => x !== '')
  if (itemsKind === 'number') return parts.map(Number).filter((n) => Number.isFinite(n))
  return parts
}

/** JSON 文本 → 值（失败返回 `{ error }`）。 */
export function parseJsonText(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { value: [] }
  try {
    return { value: JSON.parse(raw) }
  } catch (error) {
    return { error: `JSON 格式错误：${error.message}` }
  }
}

/**
 * 单字段的本地预检（服务端 `meta.validateValue` 的客户端镜像——服务端永远权威，
 * 这里只是让用户在保存前就看到问题）。
 * @returns 错误文案或 null
 */
export function localValidate(field, value) {
  if (field === null || field === undefined) return null
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : '应为开关值'
    case 'number':
      if (value === null) return field.hasDefault === true || field.allowNull === true ? null : '不能为空'
      if (typeof value !== 'number' || !Number.isFinite(value)) return '应为数字'
      if (field.min !== undefined && value < field.min) return `不能小于 ${field.min}`
      if (field.max !== undefined && value > field.max) return `不能大于 ${field.max}`
      return null
    case 'enum': {
      const ok = (field.choices ?? []).some((c) => c.value === value)
      return ok ? null : `只能是：${(field.choices ?? []).map((c) => c.value).join(' / ')}`
    }
    case 'string':
      return value === null || typeof value === 'string' ? null : '应为字符串'
    case 'list': {
      if (!Array.isArray(value)) return '应为数组'
      const bad = value.find((v) => typeof v !== 'string' && typeof v !== 'number')
      return bad === undefined ? null : '数组项必须是字符串或数字'
    }
    case 'json':
      return value === null || typeof value === 'object' ? null : '应为数组或对象'
    default:
      return null
  }
}

/**
 * 变更清单：把 patch 摊平成"每个叶子一处改动"。
 *
 * 规则：
 *   - `undefined` 的叶子跳过；
 *   - 值与现状（`config`）深相等时不计（"没改"不是变更）；
 *   - 敏感字段不携带明文：`old` 显示"（已设置）/"（未设置）"，`new` 显示"（新值）"。
 *
 * @returns Array<{ path, label, old, new, hot, secret, rawOld, rawNew }>
 */
export function buildChanges(schema, config, patch, secretSet = {}) {
  const out = []
  const walk = (node, prefix) => {
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      const field = fieldByPath(schema, path)
      // json 对象字段（如 turn.maxSteps）整值比较：它的内部键不在 schema 里，
      // 递归下去只会拿到错标签与"需重启"的错热等级。
      const nestedObject = value !== null && typeof value === 'object' && !Array.isArray(value)
      if (nestedObject && field?.kind !== 'json') {
        walk(value, path)
        continue
      }
      if (value === undefined) continue
      const oldRaw = getPath(config, path)
      if (deepEqual(oldRaw, value)) continue
      const secret = field?.secret === true
      out.push({
        path,
        label: field?.label ?? path,
        secret,
        hot: field?.hot ?? 'restart',
        old: secret ? (secretSet[path] === true ? '（已设置）' : '（未设置）') : displayValue(oldRaw),
        new: secret ? '（新值）' : displayValue(value),
        rawOld: oldRaw,
        rawNew: value,
      })
    }
  }
  walk(patch, '')
  return out
}

/** 值 → 一行短展示（数组/对象折叠成 JSON 短串）。 */
export function displayValue(value) {
  if (value === null || value === undefined) return '（空）'
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (typeof value === 'string') return value === '' ? '（空）' : value
  if (Array.isArray(value)) {
    try {
      const s = JSON.stringify(value)
      return s.length > 90 ? `${s.slice(0, 90)}…` : s
    } catch { return '（数组）' }
  }
  if (typeof value === 'object') {
    try {
      const s = JSON.stringify(value)
      return s.length > 90 ? `${s.slice(0, 90)}…` : s
    } catch { return '（对象）' }
  }
  return String(value)
}

/** 变更统计：总数与其中需重启的条数（保存条的一句摘要）。 */
export function summarizeChanges(changes) {
  const restart = changes.filter((c) => (c.hot ?? 'restart') === 'restart').length
  const reload = changes.filter((c) => c.hot === 'reload').length
  return { total: changes.length, restart, reload }
}

/** 在行编辑器里为新增行生成 id（如 `rss_m1k2`）。 */
export function newRowId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

/** 行编辑器：读出某行的字段值（缺省时给类型安全的初值）。 */
export function itemValue(item, itemField) {
  const v = item?.[itemField.key]
  if (v !== undefined && v !== null) return v
  if (itemField.kind === 'boolean') return false
  if (itemField.kind === 'number') return null
  if (itemField.kind === 'list') return []
  if (itemField.kind === 'enum') return itemField.choices?.[0]?.value ?? ''
  return ''
}

/** 行编辑器：写入某行的字段值（返回新行；原行是 JSON 纯值）。 */
export function setItemValue(item, key, value) {
  const next = { ...(item ?? {}) }
  if (value === null || value === undefined || value === '') delete next[key]
  else next[key] = value
  return next
}
