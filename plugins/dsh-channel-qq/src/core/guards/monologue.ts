/** 群聊内心戏外泄闸门：这些形状是内部盘算/舞台指示，永远不该当群消息发出去。
 *
 * 一次真实事故：她决定"本轮先不说话"，然后把**这个决定本身**当成消息发进了群。
 * 判据是形状而不是意图——内部盘算的文字有可辨认的形态（"本轮不发…"、"保持沉默"、
 * 括号里全是舞台指示），所以这里用规则拦，不指望模型自觉。
 *
 * 纯函数：给同样的文本永远给同样的结论，可以逐条列表测。这是它从 `tools.ts`
 * （一个 1300 行的注册函数）搬进 `core/guards/` 的原因。
 */

/** 群聊内心戏外泄闸门：这些形状是内部盘算/舞台指示，永远不该当群消息发出去。 */
export function isInnerMonologueLeak(text: string): boolean {
  const t = text.trim()
  if (t.length < 4) return false
  if (/^(本轮|这轮)[^，。]{0,6}(不发|沉默|不发言|闭嘴)/.test(t)) return true
  if (/(不发|沉默|闭嘴|不说话)[。.!！]?$/.test(t) && t.length <= 30) return true
  if (/^(保持沉默|先闭嘴|本轮巡逻|巡逻结论|战况)/.test(t)) return true
  // 舞台指示占比过高：括号内字符数超过全文一半，是独白不是聊天
  const inner = (t.match(/[（(][^（）()]*[）)]/g) ?? []).join('')
  if (t.length > 20 && inner.length >= t.length * 0.5) return true
  // 内部盘算关键词 + 舞台括号 同现
  if (/[（(]/.test(t) && /(战况分析|守则照旧|后台|盘算|内心|这轮先闭嘴|饭点不追)/.test(t)) return true
  return false
}
