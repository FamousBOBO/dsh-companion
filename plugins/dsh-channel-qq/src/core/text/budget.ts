/** 一包上下文按字符预算裁剪。
 *
 * 为什么要有预算：攒批包一旦成为会话历史就会**被每个后续请求重放**，所以一个
 * 超长的包不是"这一次贵一点"，而是此后每一次都贵。宁可在这里丢掉最老的行，
 * 也不要把它发出去变成永久的负担。
 *
 * 保留的是**最新的**若干行（正在回答的那几句），并如实报告丢了几行——
 * 调用方要把它写进日志，否则"模型怎么没看见前面说的"会变成一个悬案。
 */

export interface CompactResult {
  readonly text: string
  /** 丢掉的**行数**（不是字符数）。 */
  readonly dropped: number
}

/**
 * 按 `budget` 字符裁剪 `context`。
 *
 * `budget <= 0` 表示不限制；整段没超也不动它。至少保留一行——把整包丢空的
 * 结果比超预算更糟。
 */
export function compactContext(context: string, budget: number): CompactResult {
  if (budget <= 0 || context.length <= budget) return { text: context, dropped: 0 }
  const lines = context.split('\n')
  const kept: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (kept.length > 0 && size + line.length + 1 > budget) break
    kept.push(line)
    size += line.length + 1
  }
  kept.reverse()
  return { text: kept.join('\n'), dropped: lines.length - kept.length }
}
