/** 语音条该裁多长：在不超过上限的前提下，尽量收在**一句歌词的结束点**上。
 *
 * 为什么不能直接硬切在上限：59.000 s 那个切点绝大多数时候落在半个词、甚至一句话
 * 中间，听感上像"被掐断"。换气处本来就是句子之间的空白，切在那里像一次自然停顿——
 * 同一条语音条，收尾方式决定了它听起来是"一段副歌"还是"一段被截掉的音频"。
 *
 * 为什么这只是一条**纯函数**（而不是塞进流水线）：它要能被单测逐条钉住
 * （句尾在范围内取最后一个、太靠后的被排除、低于下限的被排除、乱序、空数组），
 * 而流水线里那一侧只该剩下"把配置和定位结果喂进来、把结论记进日志"。
 *
 * 它**不**校验最终产物的时长：裁剪长度与请求值一致这件事仍由 `cover.ts` 的
 * `verifyVoice` 保证（那条容差逻辑不参与收尾决策，两者故意分开）。
 */

/**
 * 句尾方案的时长下限（秒）。短于它就退回按上限硬切。
 *
 * 为什么是 20：副歌里一句歌词通常 3–6 s，20 s 是"三到四句"的量级——短于它，
 * 语音条只剩半句副歌，听不出这是哪首歌的什么段落，那还不如按上限硬切。
 * 它同时高于网关缩减阶梯的最后一档（15 s）：句尾带来的缩短是**听感**决定，
 * 不该把成品直接压到"只有网关拒收时才该到"的长度。
 */
export const MIN_PHRASE_CLIP_SECONDS = 20

/** 把秒数收到毫秒精度：`ffmpeg -t` 与日志都因此可复现（0.5 s 的帧不会漂成 46.499999）。 */
function toMillis(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 挑这次的语音条长度（秒）。
 *
 * @param chorusStart 副歌起点（秒，相对整条音轨）
 * @param phraseEnds 副歌之后的人声句尾（秒，绝对时间；允许乱序、允许有重复）
 * @param maxSeconds 上限（配置里的 `song.seconds`）；没有可用句尾时就按它硬切
 * @param minSeconds 下限；短于它的句尾一律不要
 *
 * 规则：在所有"落进 `[minSeconds, maxSeconds]`"的句尾里取**最长**的那个
 * （等价于排序后取最后一个）。取最长是因为上限之内越靠后越接近整段副歌；
 * 而**不**取"最接近上限的"数值近似——那会在没有句尾时悄悄给一个比句尾短的值。
 * 乱序不特殊处理：取最大值本身就对顺序不敏感，同一份输入永远得到同一个结论。
 *
 * 找不到可用句尾（空数组、全都越界、`chorusStart` 不是有限数）时返回
 * `maxSeconds`，由调用方在日志里说明"按上限硬切"——静默退回上限等于让人
 * 以为句尾生效了，而"为什么这条是 59.0 s"必须能从日志里读出来。
 */
export function clipLengthFor(
  chorusStart: number,
  phraseEnds: readonly number[],
  maxSeconds: number,
  minSeconds: number,
): number {
  const upper = Number.isFinite(maxSeconds) ? Math.max(0, maxSeconds) : 0
  const lower = Number.isFinite(minSeconds) ? Math.max(0, minSeconds) : 0
  let longest = 0
  for (const end of phraseEnds) {
    if (!Number.isFinite(end)) continue
    const length = end - chorusStart
    if (!Number.isFinite(length) || length < lower || length > upper) continue
    if (length > longest) longest = length
  }
  return longest > 0 ? toMillis(longest) : toMillis(upper)
}
