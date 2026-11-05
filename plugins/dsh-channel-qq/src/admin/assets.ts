/** 静态资源：把生成器内联的 UI 包（`adminUiFiles()`）按路径取出来。
 *
 * 为什么走查表而不是文件系统：`src/admin/ui/**` 是**源**，运行时只有生成物
 * `src/admin-html.ts` 里那份内联拷贝（deploy 到服务器时前端文件不单独存在）。
 * 查表还顺手消灭了路径穿越——请求路径不在表里就是 404，不存在"解析到表外"。
 */

import { adminUiFiles } from '../admin-html.js'

/** 极小的类型表（UI 包只有这几种扩展名）。 */
export function contentTypeOf(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8'
  if (file.endsWith('.css')) return 'text/css; charset=utf-8'
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (file.endsWith('.json')) return 'application/json; charset=utf-8'
  if (file.endsWith('.svg')) return 'image/svg+xml'
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

export interface BundleHit {
  key: string
  text: string
}

/**
 * 请求路径 → 内联包里的文件。
 *
 * `/` 与 `/index.html` 是入口页；`/ui/...` 是其余模块。生成物里的键是
 * UI 目录内的相对路径（`app.js`、`styles/app.css`…），这里对两种拼写
 * （带/不带目录前缀）都认，避免生成器键格式变更时静默 404。
 */
export function bundleLookup(pathname: string): BundleHit | null {
  let rel: string
  if (pathname === '/' || pathname === '/index.html') rel = 'index.html'
  else if (pathname.startsWith('/ui/')) {
    try { rel = decodeURIComponent(pathname.slice(4)) } catch { return null }
  } else return null
  if (rel === '' || rel.includes('..') || rel.includes('\\')) return null
  const files = adminUiFiles()
  const keys = Object.keys(files)
  const key = keys.find((k) => k === rel) ?? keys.find((k) => k.endsWith('/' + rel))
  if (key === undefined) return null
  return { key, text: files[key] ?? '' }
}
