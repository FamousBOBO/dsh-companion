/** `MEMORY.md` 的迁移（P6e·e3，决策 D4 §7）：冻结 → 切分入库 → 等主人审核。
 *
 * 三步都在这里，**但一步都不删东西**：
 *   1. 冻结：原件复制到 `<dshHome>/channel-qq/backups/MEMORY.md.<日期>`，并在工作区
 *      留一份 `MEMORY.md.frozen`（"只移不删"，回退时改回名字即可）；
 *   2. 切分：`core/memory/migrate.ts` 的纯函数切成条目；
 *   3. 入库：每条落 `status='candidate'` 的记录（`source.kind='migration'` 带原行号），
 *      在后台「记忆审核」里逐条通过/驳回。**审核前它们不影响对话**（候选不参与检索）。
 *
 * 迁移是**手动触发**的（后台动作），不挂夜间任务：它只该跑一次，而"每天跑一遍"
 * 会在主人还没审完时不断堆候选。
 */

import { existsSync, promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { splitMemoryMarkdown } from '../../core/memory/migrate.js'
import { localDayKey } from '../../core/schedule/stamp.js'
import { findNearDuplicate } from './nightly-io.js'
import type { MemoryStore } from './store.js'

/** 迁移结果（后台动作的返回值，直接给运维看）。 */
export interface MigrationResult {
  readonly ok: boolean
  readonly reason?: string
  /** 切出多少条候选。 */
  readonly total: number
  /** 新入库多少条。 */
  readonly added: number
  /** 命中已有记录（内容重复）多少条。 */
  readonly duplicated: number
  /** 冻结备份的路径（原件在哪）。 */
  readonly backup: string | null
  /** 工作区那份 `.frozen` 的路径。 */
  readonly frozen: string | null
}

export interface MigrationDeps {
  readonly workspace: string | null
  readonly dshHome: string
  readonly store: MemoryStore
  readonly log: (line: string) => void
  readonly now: Date
  readonly roll: () => number
}

/** 跑一次迁移。文件不存在/工作区没配 → 具名失败，不改任何东西。 */
export async function migrateMemoryFile(deps: MigrationDeps): Promise<MigrationResult> {
  const empty = { total: 0, added: 0, duplicated: 0, backup: null, frozen: null }
  const workspace = deps.workspace
  if (workspace === null || workspace === '') return { ok: false, reason: 'no-workspace', ...empty }
  const source = path.join(workspace, 'MEMORY.md')
  const text = await fs.readFile(source, 'utf-8').catch(() => null)
  if (text === null) return { ok: false, reason: 'MEMORY.md 不存在（可能已迁移过，或被改名为 .frozen）', ...empty }

  const day = localDayKey(deps.now)
  const backup = await freeze(deps, workspace, text, day)
  const items = splitMemoryMarkdown(text)
  const now = deps.now.getTime()
  let added = 0
  let duplicated = 0
  for (const item of items) {
    if (findNearDuplicate(deps.store, item.content) !== null) {
      duplicated += 1
      continue
    }
    await deps.store.remember({
      kind: 'fact',
      subject: { type: 'self' },
      content: item.content,
      source: { kind: 'migration', file: 'MEMORY.md', line: item.line },
      tags: item.heading === '' ? ['迁移'] : ['迁移', item.heading],
      importance: 5,
      status: 'candidate',
      context: item.heading === '' ? '' : `原文件小节：${item.heading}`,
    }, now, deps.roll)
    added += 1
  }
  deps.log(`memory.migrate: MEMORY.md 切出 ${items.length} 条 → 新候选 ${added}，重复 ${duplicated}（备份 ${backup.backup}）`)
  return { ok: true, total: items.length, added, duplicated, backup: backup.backup, frozen: backup.frozen }
}

/** 冻结：备份目录一份 + 工作区一份 `.frozen`（都不覆盖已存在的）。 */
async function freeze(deps: MigrationDeps, workspace: string, text: string, day: string): Promise<{ backup: string; frozen: string }> {
  const backupDir = path.join(deps.dshHome, 'channel-qq', 'backups')
  await fs.mkdir(backupDir, { recursive: true })
  const backup = path.join(backupDir, `MEMORY.md.${day}`)
  // 同一天重复跑不覆盖第一份（第一次的才是"原件"）；用存在性判断而不是 `wx` 标志，
  // 是为了让写仍走 atomicWriteFile（R4：这份文件是不可再生的数据）。
  if (!existsSync(backup)) await atomicWriteFile(backup, text)
  const frozen = path.join(workspace, 'MEMORY.md.frozen')
  await atomicWriteFile(frozen, text)
  return { backup, frozen }
}
