/** 点歌工具入参的**解析规则**：把模型给的 JSON 收成有类型的值，认不出就当没给。
 *
 * 为什么单独一个文件：这三条规则都是"判据"，要能被单测逐条钉住（认不出、负数、空串、
 * 优先级），而 `tools.ts` 已经贴着 400 行的硬上限、且它该回答的是"选哪条视频、怎么入队"。
 * 收在这里之后，"用户的话怎么变成参数"只有一处可看。
 *
 * 一条贯穿的约定：**绝不猜**。解析不出来就返回"没给"（`null` / 空串 / 默认值），
 * 让上层走它自己的默认路径——把 `"abc"` 猜成 0 秒或把 `"start"` 猜成别的写法，
 * 都会变成一条用户没要过的语音条。
 */

import type { SongStartMode } from './types.js'

/** 从工具参数里收一个秒数（只认秒；认不出、负数都当没给）。 */
export function secondsArg(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(String(value))
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

/** 文本参数（去空白；空串当没给）。 */
export function textArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 这次从哪开始唱。三档优先级（高 → 低）：
 *
 *   1. `chorusSeconds`（用户自己知道副歌在第几秒）：给了它就等于 `chorus` + 那个时间点。
 *      这是**最具体的意图**，比"从头还是副歌"这种模式选择更准，所以它优先。
 *   2. `from`（模型按用户原话填的）：只认 `'start'`，其余（含拼错、没给）一律 `chorus`。
 *   3. 默认 `chorus`：操作员原话"没要求就从副歌开始"。
 */
export function startModeOf(from: unknown, chorusAt: number | null): SongStartMode {
  if (chorusAt !== null) return 'chorus'
  return from === 'start' ? 'start' : 'chorus'
}

/**
 * 回执里"从哪开始"那一句（工具面念给用户听）。
 *
 * 放在这个文件里的理由与 `startModeOf` 相同：它是同一条判据的另一面。用户给了秒数时
 * 必须说出来——"从副歌开始"与"从你给的 120 秒开始"是两件事，回执说错等于承认自己没听懂。
 */
export function startTextOf(startMode: SongStartMode, chorusAt: number | null): string {
  if (chorusAt !== null) return `从你给的 ${String(chorusAt)} 秒开始`
  return startMode === 'start' ? '从头开始' : '从副歌开始'
}
