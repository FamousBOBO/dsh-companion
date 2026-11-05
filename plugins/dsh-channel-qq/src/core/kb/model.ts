/** 知识库的领域模型（纯类型与纯函数，零 IO）。
 *
 * 与记忆的区别：知识库保存的是**用户给的原文**，块带出处（文件、标题路径、行号），
 * 不参与记忆的衰减/反思/审核；检索时按需取，回答要带引用。
 */

/** 文档状态。`error` 保留在表里，后台能看到原因。 */
export type KbDocStatus = 'active' | 'deleted' | 'error'

/** 一份被摄取的文档。 */
export interface KbDocument {
  readonly id: string
  /** 内容哈希（sha256），用于增量：同路径同哈希 = 没变。 */
  readonly hash: string
  /** 相对工作区的路径（`inbox/a.pdf`）。 */
  readonly path: string
  readonly title: string
  /** 集合名（默认是来源目录的第一段）。 */
  readonly collection: string
  readonly mime: string
  readonly bytes: number
  readonly mtime: number
  readonly addedAt: number
  readonly updatedAt: number
  readonly status: KbDocStatus
  /** `text` / `markdown` / `html` / `docling`。 */
  readonly parser: string
  /** 解析出的页数（Docling 才有）。 */
  readonly pages?: number
  /** 失败原因（status=error 时）。 */
  readonly error?: string
}

/** 文档切出来的一块。 */
export interface KbChunk {
  readonly id: string
  readonly docId: string
  readonly seq: number
  readonly text: string
  /** 标题路径（`安装 > 依赖`）；没有标题时为空串。 */
  readonly heading: string
  /** 块首行在文档里的行号（1 起）。 */
  readonly line: number
  /** 页码（Docling 输出）；未知为 0。 */
  readonly page: number
  /** 块内容哈希，用于去重。 */
  readonly hash: string
  /** 软删除：文档被删/被替换时旧块归档，不再参与检索。 */
  readonly archived: boolean
}

/** 集合（一份文档的归属；默认取来源目录名）。 */
export interface KbCollection {
  readonly name: string
  readonly docCount: number
  readonly chunkCount: number
}

/** 检索命中。 */
export interface KbHit {
  readonly chunk: KbChunk
  readonly document: KbDocument
  readonly score: number
}

/** 引用前缀：`[知识库·标题·heading·第N段]`。 */
export function citationOf(hit: KbHit): string {
  const parts = ['知识库', hit.document.title]
  if (hit.chunk.heading !== '') parts.push(hit.chunk.heading)
  if (hit.chunk.page > 0) parts.push(`第 ${hit.chunk.page} 页`)
  parts.push(`第 ${hit.chunk.seq + 1} 段`)
  return `[${parts.join('·')}]`
}

/** 渲染一块证据（给模型看的一行）。 */
export function renderHit(hit: KbHit): string {
  const where = hit.chunk.heading === '' ? '' : `（${hit.chunk.heading}）`
  return `${citationOf(hit)}${where}\n${hit.chunk.text}`
}

/** 房间可见性：集合在 scopes 里有白名单时只对这些房间可见；没有则所有房间可见。 */
export function collectionVisibleIn(
  collection: string,
  room: string | null,
  scopes: Readonly<Record<string, readonly string[]>>,
): boolean {
  const allowed = scopes[collection]
  if (allowed === undefined || allowed.length === 0) return true
  // 系统回合（room=null）只看得见没有范围限制的集合。
  return room !== null && allowed.includes(room)
}
