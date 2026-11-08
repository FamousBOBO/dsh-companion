/** 群聊**表情包**的使用策略（P4 §8.2）：什么时候一张图比一句话自然，以及什么时候别发。
 *
 * 这一层只有一个职责：**决定要不要去问图库**。真正的检索、授权、冷却、投递都在
 * `companion-expression`（它的 `delivery.enabled` 默认 false，路径参数一律拒绝，
 * 素材只能由它自己 stage）。这里绝不拼路径、不拼 URL——那正是那套服务的设计底线。
 *
 * 四条判据（每一条都来自"发图会翻车"的具体情形）：
 *
 *   1. **一条消息最多一张，且有独立额度**（默认 10 分钟一张、每小时 1 张）。文字与图片的
 *      扰民程度不同：文字说多了是啰嗦，图发多了是刷屏。
 *   2. **只在情绪/附和类动作上考虑**（`react` 最好，`join` 其次）。`reply` 是在回答一个
 *      具体问题，配图经常答非所问；`observe`/`silent` 根本不发东西。
 *   3. **正文里有"需要解释"的信号就不发**：带问号、带数字与单位、在安抚或解释（"建议""可以
 *      先""注意"）——这些场合一张表情包会把意思弄糊。
 *   4. **她自己刚发过图就不再发**：连续两张图在任何群里都像机器人。
 *
 * 纯函数：不读时钟、不联网（R8）；时间与额度状态由调用方传。
 */

/** 触发一次图库检索的查询词（≤32 字，图库只做关键词匹配）。 */
export function stickerQueryOf(input: {
  action: 'reply' | 'join' | 'react'
  text: string
  topic: string | null
}): string {
  // 话题优先：群里在聊"拍月亮"时，"月亮"比她那句话本身更能找到合适的图。
  const topic = (input.topic ?? '').trim()
  if (topic !== '') return clip(topic, 32)
  return clip(input.text.replace(/\s+/g, ' ').trim(), 32)
}

/** 一次是否发图的判断输入。 */
export interface StickerCheck {
  readonly action: 'reply' | 'join' | 'react'
  readonly text: string
  readonly hasTopic: boolean
  readonly nowMs: number
  /** 她上次发图（或本群上次发图）的时刻；0 = 没发过。 */
  readonly lastStickerAtMs: number
  /** 最近一小时内已发几张。 */
  readonly sentThisHour: number
  readonly minIntervalMs: number
  readonly maxPerHour: number
}

/** 判断结果：发 / 不发，以及**可进日志的理由**。 */
export type StickerVerdict =
  | { readonly ok: true; readonly query: string }
  | { readonly ok: false; readonly reason: string }

/** 需要"把话说明白"的信号：这些场合不该用图代替话。 */
const NEEDS_WORDS = /[？?]|建议|可以先|注意|小心|记得|因为|所以|步骤|设置|改成|报错|失败|多少钱|怎么/iu

/** 明显是"轻量反应"的正文（附和、吐槽、惊讶、笑）。 */
const LIGHT_REACTION = /^(?:哈+|嘿+|诶+|哎+|唉|哇+|天|真的假的|离谱|绝了|笑死|同感|太.{0,3}了吧|我也|确实|可不是)/u

/** 按码点截断。 */
function clip(text: string, limit: number): string {
  const chars = [...text]
  return chars.length <= limit ? text : chars.slice(0, limit).join('')
}

/**
 * 要不要去问图库（**只决定"问不问"，不决定"发不发"**——发不发由图库自己的策略与授权决定）。
 *
 * 分档都是"不发"，理由写进日志：发图这条路径没有二次确认，所以每一次"别发"的理由都必须
 * 能在日志里一眼看出来。
 */
export function checkSticker(input: StickerCheck): StickerVerdict {
  if (input.action === 'reply') return { ok: false, reason: 'action-reply' }
  if (input.sentThisHour >= positive(input.maxPerHour, 1)) return { ok: false, reason: 'hour-quota' }
  const gap = input.nowMs - input.lastStickerAtMs
  if (input.lastStickerAtMs > 0 && gap < positive(input.minIntervalMs, 600_000)) {
    return { ok: false, reason: 'cooldown' }
  }
  // 先看有没有正文：只有空白等于"这一轮她其实没说话"，图不能替沉默。
  const text = input.text.trim()
  if (text === '') return { ok: false, reason: 'text-empty' }
  // 长句先判：一句话说到 30 字以上，她一定在解释事情，配图只会把意思弄糊。
  // （顺序有意如此：长句里通常也带"因为/所以"，先判"需要说清楚"会让日志里看不到真正的原因。）
  const length = [...text].length
  if (length > 30 && !LIGHT_REACTION.test(text)) return { ok: false, reason: 'too-long-for-sticker' }
  if (NEEDS_WORDS.test(text)) return { ok: false, reason: 'needs-words' }
  // 没有话题、正文也不是轻量反应：图库里多半找不到贴题的图，白花一次检索。
  if (!input.hasTopic && !LIGHT_REACTION.test(text)) return { ok: false, reason: 'no-query' }
  return { ok: true, query: stickerQueryOf({ action: input.action, text, topic: null }) }
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}
