/** 把旁听批次渲染成本地 Jev 判断用的**状态文本**（`State:` 段）。
 *
 * 为什么不复用 `group-social-prompt.ts` 的整段提示词：那个文件拼的是给**生成式模型**看的
 * 提示词——有格式说明、人格、记忆、要做的事。本地 Jev 只看"群里发生了什么"，
 * 多给的每一行都要过一遍打分器的上下文，而它一次只有 2048 token 的窗口。
 *
 * 实测的形状（每条消息一行，抬头 + 正文）：
 *
 *     [消息 710] [成员 小王 / QQ 10001] [时间 20:41] 数据库迁移脚本跑到一半报 deadlock 了
 *     [消息 711] [成员 老陈 / QQ 10002] [时间 20:42] 你看下锁的粒度，可能是行锁升级
 *     现在是 2026-11-19 20:45。
 *
 * 三条取舍：
 *   1. **一条一行而不是"抬头换行正文"**：换行会多一个 token，而且把同一条消息拆成两行后
 *      "谁在说"与"说了什么"的相邻关系变弱（模型更容易把上一行的抬头配到下一行的正文）；
 *   2. **她的那条收成 `成员 你（自己）`**：不标出来的话，她刚说的话会被当成群友的新要求；
 *   3. **末尾给一行现在几点**：没有它，"最新一条已经把事说完了"这个门判不准。
 *
 * 这里**不读时钟**（分层检查 R8）：`nowLabel` 由调用方格式化好传进来。
 */

import { entryBodyOf, type JudgeEntry } from './presence-judge.js'

/** 每条消息最多占多少码点（超了截断并加省略号）。 */
const MAX_BODY_CHARS = 160

/** 渠道标识：决定抬头的写法（`QQ 10001` vs `uid 4`）。 */
export type JudgeOrigin = 'qq' | 'vc'

/** 渲染一条消息的抬头（身份只从平台事件来，绝不用正文里的自称）。 */
function headOf(entry: JudgeEntry, origin: JudgeOrigin): string {
  const tag = origin === 'vc' ? 'uid' : 'QQ'
  const who = entry.self
    ? '你（自己）'
    : (entry.name.trim() === '' ? `${tag} ${String(entry.userId)}` : `${entry.name.trim()} / ${tag} ${String(entry.userId)}`)
  const id = typeof entry.messageId === 'number' && Number.isSafeInteger(entry.messageId)
    ? `消息 ${String(entry.messageId)}`
    : '消息 -'
  return `[${id}] [成员 ${who}] [时间 ${clockOf(entry.atMs)}]`
}

/** `HH:MM`（`atMs` 由调用方给，本文件不读时钟）。 */
function clockOf(atMs: number): string {
  if (!Number.isFinite(atMs) || atMs <= 0) return '--:--'
  const date = new Date(atMs)
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

/** 正文压成一行、截到上限（**不切半句**：超了就截到最后一个标点，没有标点就硬截）。 */
function bodyOf(entry: JudgeEntry): string {
  const body = entryBodyOf(entry).replace(/\s+/g, ' ').trim()
  if (body === '') return '（无正文）'
  const chars = [...body]
  if (chars.length <= MAX_BODY_CHARS) return body
  const head = chars.slice(0, MAX_BODY_CHARS).join('')
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('？'), head.lastIndexOf('！'), head.lastIndexOf('，'))
  return `${cut >= MAX_BODY_CHARS / 2 ? head.slice(0, cut + 1) : head}…`
}

/**
 * 渲染状态文本。
 *
 * @param entries 按时间正序的这批旁听（调用方已经按条数裁好）
 * @param nowLabel 现在几点，格式如 `2026-11-19 20:45`（由调用方用注入时钟格式化）
 */
export function renderJudgeState(
  entries: readonly JudgeEntry[],
  nowLabel: string,
  origin: JudgeOrigin = 'qq',
): string {
  const lines = entries.map((entry) => `${headOf(entry, origin)} ${bodyOf(entry)}`)
  lines.push(`现在是 ${nowLabel}。`)
  return lines.join('\n')
}
