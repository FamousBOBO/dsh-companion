/** hash 路由：`#/overview`、`#/module/<key>`、`#/system/<key>`，可带 `?focus=<配置项>`。
 *
 * 只做解析与跳转，渲染在 `app.js`：路由是这个面板唯一的位置事实，页面模块
 * 之间互相跳转都用 `navigate()`，不许各自拼字符串。
 */

/** 生成 hash（query 值会做 URL 编码）。 */
export function hrefFor(kind, key, query = {}) {
  const base = kind === 'overview' ? '#/overview' : `#/${kind}/${key}`
  const pairs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (pairs.length === 0) return base
  return `${base}?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`
}

export function navigate(kind, key, query = {}) {
  location.hash = hrefFor(kind, key, query)
}

/**
 * 解析当前 hash。
 * @returns {{ kind: 'overview'|'module'|'system', key: string, query: Record<string,string> }}
 */
export function parseRoute(hash) {
  const raw = String(hash ?? location.hash ?? '').replace(/^#\/?/, '')
  const [pathPart, queryPart] = raw.split('?')
  const query = {}
  if (queryPart !== undefined && queryPart !== '') {
    for (const pair of queryPart.split('&')) {
      const [k, v] = pair.split('=')
      if (k !== undefined && k !== '') query[decodeURIComponent(k)] = decodeURIComponent(v ?? '')
    }
  }
  const parts = String(pathPart ?? '').split('/').filter((p) => p !== '')
  if (parts.length === 0 || parts[0] === 'overview') return { kind: 'overview', key: 'overview', query }
  if (parts[0] === 'module' && parts[1] !== undefined) return { kind: 'module', key: parts[1], query }
  if (parts[0] === 'system' && parts[1] !== undefined) return { kind: 'system', key: parts[1], query }
  return { kind: 'overview', key: 'overview', query }
}

/** 从 `/api/schema` 的页面清单里找路由对应的页面（找不到就回概览）。 */
export function resolvePage(schema, route) {
  const pages = Array.isArray(schema?.pages) ? schema.pages : []
  if (route.kind === 'overview') return pages.find((p) => p.kind === 'overview') ?? { key: 'overview', kind: 'overview', title: '概览', icon: 'grid', blurb: '' }
  const page = pages.find((p) => p.key === route.key && p.kind === route.kind)
  if (page !== undefined) return page
  return pages.find((p) => p.kind === 'overview') ?? { key: 'overview', kind: 'overview', title: '概览', icon: 'grid', blurb: '' }
}
