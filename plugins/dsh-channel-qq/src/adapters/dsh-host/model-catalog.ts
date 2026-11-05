/** 内置模型目录：懒加载一次（assets/model-context.json，由脚本生成）。
 *
 * 数据来自 models.dev；只用于后台表单预填，不参与运行时决策。
 */

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findPackageRoot } from '../persona/fs-pack.js'

/** 一条模型能力。 */
export interface CatalogEntry {
  id: string
  name: string
  context: number
  output?: number
  /** 官方能力表声明支持图片输入（models.dev 的 modalities）。 */
  image?: boolean
  pdf?: boolean
  provider: string
}

let catalogCache: readonly CatalogEntry[] | null = null
export function modelCatalog(): readonly CatalogEntry[] {
  if (catalogCache !== null) return catalogCache
  try {
    const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url))) ?? '.'
    const parsed: unknown = JSON.parse(readFileSync(path.join(root, 'assets', 'model-context.json'), 'utf8'))
    const models = (parsed as { models?: unknown })?.models
    catalogCache = Array.isArray(models) ? models as CatalogEntry[] : []
  } catch {
    catalogCache = []
  }
  return catalogCache
}

/** 模型目录里按 id 找上下文长度：先精确，再取最长的前缀匹配。 */
export function catalogContextOf(id: string): CatalogEntry | undefined {
  const wanted = String(id).trim().toLowerCase()
  if (wanted === '') return undefined
  let best: CatalogEntry | undefined
  for (const entry of modelCatalog()) {
    if (entry.id === wanted) return entry
    if (wanted.startsWith(entry.id) && (best === undefined || entry.id.length > best.id.length)) best = entry
  }
  return best
}

