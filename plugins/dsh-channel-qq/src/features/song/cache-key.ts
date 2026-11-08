/** 同歌缓存的两把键，以及两个**算法版本标签**。纯函数，没有 IO。
 *
 * 为什么键要单独成一个文件而不是写在适配器里：键决定"什么算同一首歌"，
 * 那是一条**业务判据**——它必须能被逐条钉住（同参同键、任一参不同即不同键），
 * 而适配器只该负责"拿这个字符串去落盘"。放在这里，测试不必碰盘就能验它。
 *
 * 键里的每一段都有理由，少一段就会串味：
 *   - `bvid`：哪条视频（同一首歌的不同投稿，副歌位置不同）；
 *   - `cid`：**哪个分P**（多P 视频里第一 P 常常是预告，副歌完全在别处）；
 *   - `keyUp`：人声升几个半音（0 与 12 是两个不同的成品，混用会发出走音的语音条）；
 *   - `maxSeconds`（方案层）：语音条长度**上限**。上限变了，"该收在哪句"的答案就会变；
 *   - `chorusStart` + `seconds`（成品层）：具体是那一段，秒数变了就是另一个裁切；
 *   - `PLAN_ALGO_TAG` / `COVER_ALGO_TAG`：算法版本（见下）。
 *
 * 键本身就是**文件名**（适配器直接用 `<dir>/<键>.json`、`<dir>/<键>.mp3`），
 * 所以只允许 `[A-Za-z0-9.-_]`；`bvid` 理论上可能出现别的字符，`segment()` 把它们
 * 逐个转成 `~XXXX`（与 `paths.ts` 的编码同一套思路：可逆、不会与分隔符撞车）。
 */

/**
 * 副歌**定位**算法的版本：`tools/song/find_chorus.py` 的判据、阈值、输出含义。
 *
 * 改了那个脚本的判据（换能量/相似度算法、改重复段落与人声的权重、改句尾的识别方式），
 * 就把它 +1。否则旧缓存里的 `chorusStart` 会被当成"这次也会定位到这里"继续用——
 * 而脚本已经变了，那个起点可能根本不成立。
 *
 * 为什么与 `COVER_ALGO_TAG` 分开：脚本变了只该让**方案**过期。成品音频是上一次
 * 真实的产物，把它一并判死等于白发一条语音条的机会（而重做一次要 100 秒）。
 */
export const PLAN_ALGO_TAG = 'plan-v1'

/**
 * **翻唱**算法的版本：`make_cover.py` 的模型/分离器/混音参数，以及 `cover.ts` 的裁剪逻辑。
 *
 * 改了就 +1，三处都算：`D:\Bot\rvc\make_cover.py` 里的模型权重、分离器（MelBand
 * Roformer karaoke）、混音/响度参数；`adapters/song/cover.ts` 里的 `PREROLL_SECONDS` /
 * `TAIL_SECONDS` / 裁切偏移与 `ffmpeg` 参数。否则旧缓存会被当成有效——那意味着
 * 操作员以为"换了模型"，实际听到的还是上一版的声音。
 */
export const COVER_ALGO_TAG = 'cover-v1'

/**
 * 把一段任意文本变成文件名里安全的一段（`~XXXX` 是可逆编码，不会与 `_` 分隔符撞车）。
 *
 * `BV` 号正常是 `BV` + 字母数字，走不到这里；但键是从配置/上游一路传下来的
 * **字符串**，一个斜杠就会让文件落到别的目录去，一个 `.` 开头的段还能拼出 `..`
 * ——这条防线比事后 `path.basename` 便宜。连 `.` 也转义：段里只剩数字才需要点号，
 * 而那些数字由 `num()` 负责，不经过这里。
 */
function segment(text: string): string {
  return text.replace(/[^A-Za-z0-9-]/g, (ch) => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
}

/** 秒数固定三位小数：与 `cover.ts` 的 `fixed()` 同一口径，同一段永远得到同一个键。 */
function num(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : 'x'
}

/**
 * 方案层的键：`plan_<bvid>_<cid>_k<keyUp>_m<maxSeconds>_<PLAN_ALGO_TAG>`。
 *
 * `maxSeconds` 进键的理由与它进配置的理由相同：它是**上限**，而上限决定
 * "最长不超过它的那个句尾"是哪一句（`clipLengthFor`）。上限改了却命中旧方案，
 * 就会用一条按旧上限裁出来的长度——比不命中更难解释。
 */
export function planCacheKey(bvid: string, cid: number, keyUp: number, maxSeconds: number): string {
  return ['plan', segment(bvid), String(cid), `k${String(keyUp)}`, `m${num(maxSeconds)}`, PLAN_ALGO_TAG].join('_')
}

/**
 * 成品层的键：`clip_<bvid>_<cid>_k<keyUp>_c<chorusStart>_s<seconds>_<COVER_ALGO_TAG>`。
 *
 * `seconds` 在键里，所以网关嫌长缩到 45/30/20/15 之后的那一条**天然是另一个键**：
 * 下次同一首歌被网关同样拒收时，缩短这一步也不必重跑。
 */
export function clipCacheKey(
  bvid: string,
  cid: number,
  keyUp: number,
  chorusStart: number,
  seconds: number,
): string {
  return [
    'clip', segment(bvid), String(cid), `k${String(keyUp)}`,
    `c${num(chorusStart)}`, `s${num(seconds)}`, COVER_ALGO_TAG,
  ].join('_')
}
