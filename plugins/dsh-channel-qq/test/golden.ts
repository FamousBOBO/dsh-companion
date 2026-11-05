/** 特征测试（golden）的比对工具。
 *
 * 做法：把"实际输出"与仓库里的一份文本快照逐字节比对；不一致就失败，并把
 * 第一处差异指出来。要更新快照时用 `UPDATE_GOLDEN=1`，它会**覆盖**快照文件——
 * 于是 diff 会出现在 git 里，成为"这次到底改了什么行为"的评审材料。
 *
 * 为什么不用断言里内联的字符串：这些快照很长（组包提示词上千字），内联在测试
 * 里既读不动也看不清 diff。独立文件 + git diff 是最省事也最经得起评审的形式。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import assert from 'node:assert/strict'

/** 快照根目录（相对仓库根；`npm test` 的 cwd 就是仓库根）。 */
const ROOT = path.join(process.cwd(), 'test', 'golden')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

/** 记下本次运行里哪些快照是新建的，收尾时提示。 */
export const created: string[] = []

/**
 * 比对一份快照。
 *
 * @param name 快照名（同时是文件名，可带 `/` 分组）
 * @param actual 实际输出
 */
export function golden(name: string, actual: string): void {
  const file = path.join(ROOT, `${name}.txt`)
  if (UPDATE || !existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, actual, 'utf8')
    if (!UPDATE) created.push(name)
    return
  }
  const expected = readFileSync(file, 'utf8')
  if (expected === actual) return
  assert.equal(
    actual,
    expected,
    `快照 ${name} 变了。若这是有意的行为变更，跑 UPDATE_GOLDEN=1 npm test 更新它，`
    + `并在提交说明里逐条讲清楚改了什么、为什么。`,
  )
}

/** 把一次投递的多条记录拼成一份可读快照文本。 */
export function renderDeliveries(
  entries: ReadonlyArray<{ key: string; how: string; text: string; images: number }>,
): string {
  return entries
    .map((e) => [
      `── ${e.key} [${e.how}] images=${e.images}`,
      e.text,
    ].join('\n'))
    .join('\n\n')
}
