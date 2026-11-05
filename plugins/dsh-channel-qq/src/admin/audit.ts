/** 审计日志：所有**写操作**一条一行，落到 `channel-qq/audit.jsonl`。
 *
 * 为什么必须存在（内部文档 §8）：后台是机器人控制台，历史上"谁改了
 * `AGENTS.md`、谁开了群聊、谁重建了会话"没有任何留痕——出问题时只能靠翻
 * `channel-qq.log` 的混合文本。审计回答的是四个问题：**谁（来源 IP）、何时、
 * 哪条接口、改了什么、结果如何**。
 *
 * 写入用 `appendFile`（追加是日志的**正确语义**——原子替换整份文件等于每写一行
 * 就重写全部历史；check-layers 的 R4 明确不拦 `appendFile`）。审计本身失败
 * **绝不能**把请求带崩：捕获、记一行、继续。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export interface AuditEntry {
  /** ISO 时间戳。 */
  ts: string
  /** 来源 IP（`req.socket.remoteAddress`）。 */
  ip: string
  /** HTTP 方法。 */
  method: string
  /** 请求路径（不含 query）。 */
  path: string
  /** 动作名：`config.save` / `file.write` / `session.rebuild` …（可过滤）。 */
  action: string
  /** 变更摘要（人读的一句话；不含任何明文秘密）。 */
  summary: string
  result: 'ok' | 'error'
}

/** 读回来的行可能是手改过的——只认形状对的那些。 */
function parseLine(line: string): AuditEntry | null {
  try {
    const raw: unknown = JSON.parse(line)
    if (typeof raw !== 'object' || raw === null) return null
    const entry = raw as Record<string, unknown>
    if (typeof entry.ts !== 'string' || typeof entry.action !== 'string') return null
    return {
      ts: entry.ts,
      ip: typeof entry.ip === 'string' ? entry.ip : '',
      method: typeof entry.method === 'string' ? entry.method : '',
      path: typeof entry.path === 'string' ? entry.path : '',
      action: entry.action,
      summary: typeof entry.summary === 'string' ? entry.summary : '',
      result: entry.result === 'error' ? 'error' : 'ok',
    }
  } catch {
    return null
  }
}

export class AuditLog {
  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void,
  ) {}

  /** 追加一条。永不抛错——审计失败不该影响被审计的操作本身。 */
  async append(entry: Omit<AuditEntry, 'ts'> & { ts?: string }): Promise<void> {
    const line = JSON.stringify({
      ts: entry.ts ?? new Date().toISOString(),
      ip: entry.ip,
      method: entry.method,
      path: entry.path,
      action: entry.action,
      summary: entry.summary,
      result: entry.result,
    }) + '\n'
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.appendFile(this.file, line, 'utf8')
    } catch (error) {
      this.log(`audit: write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 最后 `limit` 条（新→旧）。文件不存在时返回空数组。 */
  async tail(limit: number): Promise<AuditEntry[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const lines = raw.split('\n').filter((line) => line.trim() !== '')
      const out: AuditEntry[] = []
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
        const entry = parseLine(lines[i]!)
        if (entry !== null) out.push(entry)
      }
      return out
    } catch {
      return []
    }
  }
}
