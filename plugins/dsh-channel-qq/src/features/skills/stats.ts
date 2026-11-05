/** 技能使用计数：加载了几次、被 `/名字` 触发了几次、最后一次是什么时候。
 *
 * 为什么单独一个文件而不是写进 SKILL.md：`SKILL.md` 是**指令**，会被整体加载
 * 进提示词；把计数写进去等于每次使用都改一次正文，既污染内容又会让目录签名
 * 抖动（每用一次就重扫一遍）。计数是运维数据，放在 `<dshHome>/channel-qq/`。
 *
 * 写盘串行化（`chain`）：并发调用（一次回合里加载 + 触发）不会互相覆盖。
 */

import { promises as fs } from 'node:fs'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'

/** 一次使用的种类。 */
export type SkillUseKind = 'load' | 'trigger'

/** 单个技能的计数。 */
export interface SkillUseStat {
  loads: number
  triggers: number
  lastAt: number
}

/** 计数仓库。 */
export class SkillStats {
  private data: Record<string, SkillUseStat> = {}
  private loaded = false
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void,
  ) {}

  private async ensure(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as Record<string, SkillUseStat>
      }
    } catch {
      // 没有计数文件是正常状态（一次都没用过）。
    }
  }

  /** 记一次使用（后台串行写盘；失败只记日志，不影响对话）。 */
  record(name: string, kind: SkillUseKind): Promise<void> {
    this.chain = this.chain.then(async () => {
      await this.ensure()
      const current = this.data[name] ?? { loads: 0, triggers: 0, lastAt: 0 }
      this.data[name] = {
        loads: current.loads + (kind === 'load' ? 1 : 0),
        triggers: current.triggers + (kind === 'trigger' ? 1 : 0),
        lastAt: Date.now(),
      }
      await atomicWriteFile(this.file, JSON.stringify(this.data, null, 2))
    }).catch((error: Error) => {
      this.log(`skills: 写使用计数失败：${error.message}`)
    })
    return this.chain
  }

  /** 当前的计数快照（等队列清空后返回）。 */
  async all(): Promise<Readonly<Record<string, SkillUseStat>>> {
    await this.chain
    await this.ensure()
    return this.data
  }
}
