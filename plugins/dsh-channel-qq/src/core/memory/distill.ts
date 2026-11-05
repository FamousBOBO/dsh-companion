/** 写入侧的事实蒸馏与即时抽取判据（P0，调研 [20261024_memory-system-research.md] §6）。
 *
 * `core/` 硬规矩（R8）：不读时钟、不掷随机、不碰 IO——全部是纯函数。
 *
 * 为什么要有这一步：60 题基准上 recall@8 = 0.14 的根因是"库里存的是日记原文句子，
 * 不是抽取后的一句话事实"。召回要的不是更多文字，而是**更短的证据**——所以蒸馏
 * 放在写入侧做一次，检索侧每次注入都省。机制参照：
 *   - feiyu-memory：每轮 ~260 token 的极短门槛判断，"值不值得留给下一个我"；
 *   - dsh-engram：写入四态处置（accept/merge/defer/drop），宁缺毋滥。
 */

import { oneLine } from './model.js'

/** 蒸馏后事实的目标长度：比 MAX_CONTENT_CHARS(200) 更狠——短事实才进得进 600 字预算。 */
export const FACT_MAX_CHARS = 80

/** 该丢掉的口语前缀：它们是"说话的壳"，不是事实本身。 */
const SHELL_PREFIXES = [
  '我觉得', '我以为', '我感觉', '好像', '可能', '大概', '其实', '就是说',
  '然后', '还有', '另外', '对了', '话说', '反正', '就是说啊', '嗯',
] as const

/**
 * 把一句抽取产物蒸馏成"一句话事实"：
 * 去口语前缀 → 压空白 → 掐掉句尾语气 → 截到 `FACT_MAX_CHARS`。
 *
 * 不会把内容变得更"对"——只把壳去掉。判断对错是抽取器（模型）的事，
 * 蒸馏只保证**存进库里的每一条都足够短**，让 600 字预算装得下更多条。
 */
export function distillFact(raw: string): string {
  let text = oneLine(raw)
  let changed = true
  while (changed) {
    changed = false
    for (const prefix of SHELL_PREFIXES) {
      if (text.length - prefix.length >= 6 && text.startsWith(prefix)) {
        text = text.slice(prefix.length).trimStart()
        changed = true
      }
    }
  }
  // 句尾的语气收束：呢/吧/哦/啦/呀/嘛 + 标点，与重复的句号；句首剥壳后的残留标点。
  text = text.replace(/[呢吧哦啦呀嘛]+[。！!？?…]*$/, '').replace(/^[，、。．！!？?…\s]+/, '').replace(/[。．]+$/, '')
  if (text.length <= FACT_MAX_CHARS) return text.trim()
  return `${text.slice(0, Math.max(FACT_MAX_CHARS - 1, 6))}…`
}

/**
 * 这一轮消息值不值得**立刻**抽一条事实（feiyu 的门槛判据，规则版、零模型调用）。
 *
 * 四类触发（每类都要消息有点长度才成立，免得"哦""好"也命中）：
 *   1. **被纠正**："不对/不是/错了/应该/其实"——纠正里藏着需要更新的旧事实；
 *   2. **要求记住**："记住/记一下/别忘/帮我记"——明说的事不需要犹豫；
 *   3. **用户自述**："我是/我在/我喜欢/我讨厌/我最近"——自我画像的原料；
 *   4. **情绪上头**：连续叹号/问号或情绪词——强情绪事件的记忆本来就深。
 *
 * 反面清单优先：纯表情、纯链接、触发词本身（"怎么记笔记"在问方法，不是要求记住）。
 */
export function shouldCaptureInstant(text: string): boolean {
  const t = text.trim()
  if (t.length < 6 || t.length > 500) return false
  // 纯链接 / 纯表情 / 命令，不抽。
  if (/^(https?:\/\/|www\.)/i.test(t)) return false
  if (/^[/!.#]/.test(t)) return false
  if (!/[\u4e00-\u9fff]/.test(t)) return false
  const hit = (words: readonly string[]): boolean => words.some((w) => t.includes(w))
  if (hit(['不对', '不是这样', '你说错了', '错了', '应该是', '其实不是'])) return true
  if (hit(['记住', '记一下', '帮我记', '别忘了', '记着'])) return true
  if (hit(['我是', '我在', '我喜欢', '我讨厌', '我最近', '我家', '我生日', '我讨厌被'])) return true
  if (/[！!]{2,}|[？?]{2,}/.test(t)) return true
  if (hit(['气死', '笑死', '吐了', '破防', '太难受', '太开心', '哭了', '吓死'])) return true
  return false
}

/** 即时抽取的默认每日上限（feiyu 用"极短调用 + 带外队列"，我们再加总额闸）。 */
export const CAPTURE_DAILY_CAP = 12

/** 即时抽取单条的最小间隔（毫秒）：同一房间连刷不给连抽。 */
export const CAPTURE_MIN_GAP_MS = 90_000
