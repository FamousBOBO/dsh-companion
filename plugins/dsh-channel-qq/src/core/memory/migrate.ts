/** `MEMORY.md` 的切分（P6e·e3，决策 D4 §7.2）：按标题与列表项切成一条条候选。
 *
 * 为什么值得单独一份纯函数：那份文件是**手工长出来的**（230KB、格式不完全一致），
 * 切分规则必须能被测试钉住——切错了会把半句话当一条记忆，而迁移只跑一次，
 * 事后很难发现。
 *
 * 规则（宁缺毋滥）：
 *   - `##`/`###` 标题只用来给条目记"来自哪一节"，**自己不成为条目**；
 *   - 列表项（`-` `*` `+` `1.`）各成一条；
 *   - 小节下的整段正文（不是列表）也成一条；
 *   - 太短（< `minChars`）、纯标记、代码围栏里的内容一律不要。
 */

/** 一条候选。 */
export interface MigrationItem {
  /** 规范化后的一句话（去 markdown 标记、压缩空白、截断）。 */
  readonly content: string
  /** 原文件里的行号（1 起；出处要能对回原文）。 */
  readonly line: number
  /** 最近的二级/三级标题文字（没有就是空串）。 */
  readonly heading: string
}

export interface SplitOptions {
  /** 短于这个长度的行不成条目（默认 6 个字符）。 */
  readonly minChars?: number
  /** 单条上限（与 `MAX_CONTENT_CHARS` 对齐，默认 200）。 */
  readonly maxChars?: number
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/
const HEADING = /^#{2,3}\s+(.*)$/
const FENCE = /^\s*```/

/** 去掉 markdown 标记，只留给人读的正文。 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [文字](链接) → 文字
    .replace(/`([^`]*)`/g, '$1')               // `code` → code
    .replace(/\*\*([^*]*)\*\*/g, '$1')         // **粗体** → 粗体
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 值不值得当一条记忆：太短的、纯符号的、只剩标题标记的都不要。 */
function meaningful(content: string, minChars: number): boolean {
  if (content.length < minChars) return false
  // 去掉标点后还有没有实义字符（"——"、"***" 这类不该成条）
  return /[\p{L}\p{N}]/u.test(content)
}

/**
 * 切分一份 `MEMORY.md`。
 *
 * 行号是**原始行号**（不因空行/标题的过滤而漂移）——迁移出来的记录要能对回原文，
 * 否则主人审核时无法判断"这条是从哪摘出来的"。
 */
export function splitMemoryMarkdown(text: string, opts: SplitOptions = {}): MigrationItem[] {
  const minChars = opts.minChars ?? 6
  const maxChars = opts.maxChars ?? 200
  const items: MigrationItem[] = []
  let heading = ''
  let inFence = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    if (FENCE.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const headingMatch = HEADING.exec(raw)
    if (headingMatch !== null) {
      heading = stripMarkdown(headingMatch[1] ?? '')
      continue
    }
    if (/^#\s/.test(raw)) continue // 一级标题（文档名）不成条目
    const itemMatch = LIST_ITEM.exec(raw)
    const body = stripMarkdown(itemMatch === null ? raw : (itemMatch[1] ?? ''))
    if (body === '' || !meaningful(body, minChars)) continue
    const content = body.length <= maxChars ? body : `${body.slice(0, maxChars - 1)}…`
    items.push({ content, line: i + 1, heading })
  }
  return items
}
