/** AGENTS.md 的"指令受管区"（P6b）：把包尾的行为约定搬进指令层。
 *
 * 为什么落在工作区 AGENTS.md 的受管区，而不是宿主 `ctx.systemPrompt.section()`：
 * 宿主确实有提示片段接缝（见 `内部文档宿主核实记录.md` V4），但它的两种
 * 落点都够不着本任务的改动面——按 Agent 注册要改 `adapters/dsh-host/agents.ts`
 * 的 `watchTurns`（别人的文件），在插件根上下文注册则是全局的、会把 QQ 行为约定
 * 漏给同进程里所有非 QQ 会话。AGENTS.md 是 05 §3.4 给的另一个落点，且这份文件
 * 本来就由本项目维护（`deploy/workspace-backup.sh` 的备份清单里有它）。
 *
 * 这里只有**纯字符串运算**：找标记、替换、剥离，全部可在无文件系统的环境里测。
 * 真正读写文件的是 `features/inbound`（指令区）与 `features/tools-v2`（工具区）。
 * 标记之间的内容在每次同步时整体重写——"受管"的含义就是别在手改区里攒东西。
 *
 * 有两对标记，各写各的、互不覆盖：指令层（`REGION_BEGIN/END`，context.v2 写）与
 * 工具面（`TOOLS_REGION_BEGIN/END`，tools.v2 写）。函数都收可选的标记对，
 * 缺省是指令层那一对——既有调用方的语义因此一个字节都没动。
 */

/** 受管区起止标记（与运维脚本、后台说明共用同一对字面量）。 */
export const REGION_BEGIN = '<!-- channel-qq:begin -->'
export const REGION_END = '<!-- channel-qq:end -->'

/** 工具面受管区的起止标记（tools.v2 的工具清单；与指令区各自独立维护）。 */
export const TOOLS_REGION_BEGIN = '<!-- channel-qq:tools:begin -->'
export const TOOLS_REGION_END = '<!-- channel-qq:tools:end -->'

/** 一对起止标记；缺省（不传）= 指令层那一对。 */
export type RegionMarkers = readonly [string, string]
const DEFAULT_MARKERS: RegionMarkers = [REGION_BEGIN, REGION_END]

/** 区内的维护说明（给翻 AGENTS.md 的人看；模型侧是一行 HTML 注释，无害）。 */
const REGION_NOTE = '<!-- 本区由 channel-qq 自动维护（同步时覆盖区内手工修改） -->'

/** 受管区的完整块（含起止标记与结尾换行）。 */
export function regionBlock(body: string, markers: RegionMarkers = DEFAULT_MARKERS): string {
  return `${[markers[0], REGION_NOTE, body, markers[1]].join('\n')}\n`
}

/** 标记行只认"整行就是它"（允许两侧空白），避免正文里的字样被误判。 */
function markerAt(lines: readonly string[], marker: string): number {
  return lines.findIndex((line) => line.trim() === marker)
}

export type UpsertStatus = 'replaced' | 'appended' | 'unchanged' | 'malformed'

/** 写入/替换受管区；标记不成对（只有头或只有尾）时拒绝改动。 */
export function upsertManagedRegion(text: string, block: string, markers: RegionMarkers = DEFAULT_MARKERS): { text: string; status: UpsertStatus } {
  const lines = text.split('\n')
  const beginAt = markerAt(lines, markers[0])
  const endAt = markerAt(lines, markers[1])
  if (beginAt === -1 && endAt === -1) {
    // 整份归一成"内容 + 空行 + 受管区"，这样反复同步的结果稳定。
    const base = text.replace(/\n+$/, '')
    const next = `${base === '' ? '' : `${base}\n\n`}${block}`
    return { text: next, status: 'appended' }
  }
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) return { text, status: 'malformed' }
  const out = [...lines.slice(0, beginAt), ...block.replace(/\n$/, '').split('\n'), ...lines.slice(endAt + 1)]
  const next = out.join('\n')
  return { text: next, status: next === text ? 'unchanged' : 'replaced' }
}

export type StripStatus = 'removed' | 'absent' | 'malformed'

/** 移除受管区（连同我们插入的那个空行分隔）；没有受管区时一个字不动。 */
export function stripManagedRegion(text: string, markers: RegionMarkers = DEFAULT_MARKERS): { text: string; status: StripStatus } {
  const lines = text.split('\n')
  const beginAt = markerAt(lines, markers[0])
  const endAt = markerAt(lines, markers[1])
  if (beginAt === -1 && endAt === -1) return { text, status: 'absent' }
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) return { text, status: 'malformed' }
  const before = lines.slice(0, beginAt)
  // 同步时插在区前的空行一并收走（upsert 的逆操作，区外内容逐字节保留）。
  if (before.length > 0 && before[before.length - 1] === '') before.pop()
  const base = [...before, ...lines.slice(endAt + 1)].join('\n').replace(/\n+$/, '')
  return { text: base === '' ? '' : `${base}\n`, status: 'removed' }
}
