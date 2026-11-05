/** 纯函数：资源表的"行模型"（从任意返回体里取行集、取行 id、按关键词过滤）。
 *
 * 与 `form-model.js` 同一层（无 DOM、无 fetch），`node:test` 直接测；
 * 组件 `components/table.js` 只负责把行模型渲染成 DOM。
 */

/** 从任意返回体里取出行集（第一个数组；没有数组则整体当一行）。 */
export function rowsOf(data) {
  if (Array.isArray(data)) return data
  if (data !== null && typeof data === 'object') {
    for (const value of Object.values(data)) if (Array.isArray(value)) return value
    return [data]
  }
  return []
}

/** 行的稳定标识：按常见键序取第一个标量；兜底用 JSON 前缀。 */
export function rowId(row) {
  if (row === null || typeof row !== 'object') return String(row ?? '')
  for (const key of ['id', 'md5', 'file', 'url', 'text', 'name', 'room', 'key']) {
    const value = row[key]
    if (value !== undefined && value !== null && typeof value !== 'object') return String(value)
  }
  try { return JSON.stringify(row).slice(0, 80) } catch { return '' }
}

/** 按关键词过滤（对整行的 JSON 做子串匹配，大小写不敏感）。 */
export function filterRows(rows, keyword) {
  const kw = String(keyword ?? '').trim().toLowerCase()
  if (kw === '') return rows
  return rows.filter((row) => {
    try { return JSON.stringify(row).toLowerCase().includes(kw) } catch { return false }
  })
}

/** 分页切片：返回 `{ slice, remaining }`（`limit` 为已显示条数）。 */
export function pageRows(rows, limit) {
  const slice = rows.slice(0, Math.max(0, limit))
  return { slice, remaining: Math.max(0, rows.length - slice.length) }
}
