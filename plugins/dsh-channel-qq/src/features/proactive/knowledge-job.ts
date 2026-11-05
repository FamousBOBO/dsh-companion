/** 内建 job：知识抽取（P6f 的 `knowledge.extract`）——旧 `Scheduler.extractKnowledge`
 * 的执行内容**原样搬出**（门、文案、判据一字不改），只是改由事件书的 job 通道触发。
 *
 * 为什么搬进 job 而不是留在旧 `Scheduler` 里：事件书的默认书用 `kind: 'job'` 表达
 * 这件事（数据说了"04:00–08:59 做一次"），执行器只认注册表里的名字。留一份在旧路径
 * 里、再写一份在 job 里，就是两份会各自漂移的实现——这正是 P6 要消灭的东西。
 */

import { localDayKey } from '../../core/schedule/stamp.js'
import type { JobHandler } from './jobs.js'

export interface KnowledgeJobDeps {
  /** 工作区根；null = 没配置（跳过，且说明原因）。 */
  readonly workspace: () => string | null
  /** 从一段文本抽取知识条目；返回条数。 */
  readonly extract: (source: string, text: string) => Promise<number>
  /**
   * `memory.v2` 开着吗？
   *
   * 开着时**跳过本条**：日记抽取改由 `memory.diary-extract`（e3 的夜间任务）负责，
   * 它抽同一份日记、同时写新库与老库。两条都跑等于一天抽两遍、花两次模型调用。
   */
  readonly memoryV2On?: () => boolean
}

/** 日记太短就不抽（旧实现的 50 字门槛：几行字的日记抽不出东西）。 */
const MIN_DIARY_CHARS = 50

/** 造一个 `knowledge.extract` 处理器。 */
export function knowledgeExtractJob(deps: KnowledgeJobDeps): JobHandler {
  return async (ctx) => {
    if (deps.memoryV2On?.() === true) return { skipped: 'memory-v2-on' }
    const workspace = deps.workspace()
    if (workspace === null || workspace === '') return { skipped: 'no-workspace' }
    const today = localDayKey(ctx.now)
    const diaryPath = `${workspace}/memory/${today}.md`
    const diary = await readText(diaryPath)
    if (diary.trim().length < MIN_DIARY_CHARS) return { skipped: 'diary-too-short' }
    const count = await deps.extract(`日记 ${today}`, diary)
    return { note: `extracted ${count} entries from ${today} diary` }
  }
}

/** 本地的"今天"由 `localDayKey` 给（与日志/会话日期键同一口径：本地日，不是 UTC 日）。 */

async function readText(file: string): Promise<string> {
  const fsMod = await import('node:fs/promises')
  return await fsMod.readFile(file, 'utf-8').catch(() => '')
}
