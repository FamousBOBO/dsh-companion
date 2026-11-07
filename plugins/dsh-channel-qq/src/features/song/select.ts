/** 选视频：B站搜索结果里挑一条"能当原唱用"的，挑不出来就明确说"同名，你选"。
 *
 * 这个文件里全是**纯函数**（零 IO、零时钟）：给定一批候选和一次点歌请求，答案只取决于
 * 输入。理由是这一层最容易出错也最容易被改（"这个 UP 的视频被跳过了，为什么？"），
 * 做成纯函数才能在测试里把每条规则钉住；而它一旦要读时钟，那些断言就得跟着时间飘。
 *
 * 三条规则，每条都来自实机观察：
 *
 *   1. **先剔"不能当原唱"的**（伴奏 / 教程 / 混剪 / 二次 AI 翻唱 / 鬼畜 / 片段）。
 *      实机搜「晴天」的第一页里就有 `【伴奏】`、`KTV版`、`纯音乐版`；不剔掉，做出来的
 *      语音条会是"三月七唱的伴奏"。**剔掉不等于失败**——理由要留下来给人看。
 *   2. **再按 歌名 + 歌手 打分**。标题里的歌名权重最高（`《晴天》` 这种书名号命中几乎
 *      不会错），歌手出现在标题或 UP 名里是第二个证据。**两条都中的才是"确定"**。
 *   3. **分不出来就承认分不出来**。前几名分差很小、歌名却不同（不同歌同名，或同名歌
 *      被翻唱成好几个版本）时，答案是"给用户 3–5 个候选让他选"，而不是猜一个。
 *      猜错一次发出去的是**别人的歌**做的翻唱，撤不回。
 *
 * `play`（播放量）只用来打破僵局（同分时取高的），不当主要证据：一首冷门好歌的播放量
 * 可能只有几千，而一个蹭热度的混剪有几百万。
 */

import type { SongCandidate, SongLookup } from './types.js'
import { singerGender } from './gender.js'

/** 一条标题里出现这些词就说明它**不是原唱**。顺序无关，命中一条就够。 */
const SKIP_RULES: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /伴奏|去人声|无人声|纯伴奏|和声去掉/, reason: '伴奏（没有原唱人声）' },
  { pattern: /消音|静音版/, reason: '消音版（没有人声）' },
  { pattern: /教程|教学|怎么唱|唱歌技巧|学唱|教你唱|如何唱/, reason: '教程（不是歌）' },
  { pattern: /混剪|剪辑|合集|串烧|合辑|remix|MAD/i, reason: '混剪/合集（不是一首完整的歌）' },
  { pattern: /鬼畜|调音|音MAD/i, reason: '鬼畜/调音（人声已被改动）' },
  { pattern: /AI翻唱|AI知唱|AI演唱|ai cover|AI孙燕姿|AI三月七/i, reason: '二次 AI 翻唱（再用 RVC 换一次会糊）' },
  { pattern: /片段|cut版|切片|高能片段|名场面/, reason: '片段（不是完整的歌）' },
  { pattern: /reaction|解析|评测|听后感/i, reason: '解说/评测（不是歌）' },
]

/** 标题里出现这些词的**不要跳**，但可以算"可能是整首"的轻微加分（常见于高质量源）。 */
const FAVOR: readonly RegExp[] = [/完整版/, /无损/, /官方/, /MV/i, /4K|2160|1080/, /原唱/]

/** 至少这么长才算"一首歌"（低于 45 秒多半是片段）。 */
const MIN_SONG_SECONDS = 45
/** 超过 25 分钟的不是歌（整场演唱会、合集）。 */
const MAX_SONG_SECONDS = 1_500
/** 定的"确定"门槛：歌名 + 歌手都命中。 */
const CONFIRM_SCORE = 80
/** 前两名分差小于它就算"分不出来"（不同歌名时）。 */
const AMBIGUITY_MARGIN = 18
/** 给用户看的最多几条候选。 */
const MAX_CANDIDATES = 5

/** 书名号/方括号/圆括号包起来的部分：`《晴天》`、`【4K】`、`（官方MV）`。 */
const BRACKETED = /《[^》]*》|【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g

/** 把标题里"不像歌名的部分"去掉，留下可比对的正文。 */
export function normalizeTitle(raw: string): string {
  return raw
    .replace(BRACKETED, ' ')
    .replace(/[|｜/／\\·・\-–—_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 从标题里取出书名号里的歌名（有就优先用它比对，那是最强的证据）。 */
export function quotedSongName(raw: string): string | null {
  const match = /《([^》]{1,40})》/.exec(raw)
  if (match === null) return null
  const name = normalizeTitle(match[1] ?? '')
  return name === '' ? null : name
}

/** 这条候选被跳过的理由；能当原唱时返回 null。 */
export function skipReason(candidate: SongCandidate, songName: string): string | null {
  const title = candidate.title
  for (const rule of SKIP_RULES) {
    if (rule.pattern.test(title)) return rule.reason
  }
  if (candidate.duration > 0 && candidate.duration < MIN_SONG_SECONDS) {
    return `太短（${String(Math.round(candidate.duration))} 秒，不是一首完整的歌）`
  }
  if (candidate.duration > MAX_SONG_SECONDS) {
    return `太长（${String(Math.round(candidate.duration / 60))} 分钟，更像是合集/演唱会）`
  }
  if (songName !== '' && !normalizeTitle(title).includes(normalizeTitle(songName))) {
    // 标题里连歌名都没有：可能是 UP 用别名，也可能是完全另一首歌。留着但不给分。
    return null
  }
  return null
}

/**
 * 从"女声翻唱"的搜索结果里挑一条**能用的**。挑不出来就 `null`。
 *
 * 与 `lookupSong` 的判据刻意不同，理由写在这里：
 *   1. **门槛不是 80 分**。第二次搜索的关键词里没有歌手（`歌名 女声 翻唱`），
 *      所以 `scoreCandidate` 里"歌手命中"那 35 分拿不到，实机分数落在 55–68。
 *      拿 80 分当门槛等于"永远挑不出来"——那这条准则就成了摆设。
 *      这里改成**歌名必须命中**（书名号或归一化标题里含歌名），这已经排除了别的歌。
 *   2. **不按"分差太小就问你"**。多条女性翻唱同一首歌是**常态**（实机搜《晴天》
 *      一次就有 4 条女声版）。它们都是这首歌，挑分数最高的那条就行；
 *      这里不存在"猜错成别人的歌"的风险。
 *   3. **不同歌词的版本一律跳过**（日语 / 英文 / 粤语填词翻唱）：旋律一样、词不一样，
 *      做成语音条听到的是外语副歌。这条只在"找翻唱"时启用——用户直接点的原唱可能是
 *      粤语歌，那时"粤语"不是异类。
 */
export function pickFemaleCover(
  candidates: readonly SongCandidate[],
  song: string,
): SongCandidate | null {
  const songKey = normalizeTitle(song)
  if (songKey === '') return null
  let best: { candidate: SongCandidate; score: number } | null = null
  for (const candidate of candidates) {
    if (skipReason(candidate, song) !== null) continue
    if (isForeignLyrics(candidate)) continue
    if (!titleMentions(candidate, songKey)) continue
    if (singerGender(candidate) !== 'female') continue
    const score = scoreCandidate(candidate, song, '')
    if (best === null || score > best.score) best = { candidate, score }
  }
  return best?.candidate ?? null
}

/** 标题是否提到这首歌（书名号里含歌名，或归一化标题里含歌名）。 */
function titleMentions(candidate: SongCandidate, songKey: string): boolean {
  const quoted = quotedSongName(candidate.title)
  if (quoted !== null && quoted.includes(songKey)) return true
  return normalizeTitle(candidate.title).includes(songKey)
}

/** 换过语言的填词翻唱（旋律同、词不同，做成语音条就是外语副歌）。 */
function isForeignLyrics(candidate: SongCandidate): boolean {
  return /日语|日文|日版|英文版|英语版|韩语|韩文|韩版|粤语版|俄语|法语|德语/i.test(candidate.title)
}
export function scoreCandidate(candidate: SongCandidate, song: string, artist: string): number {
  const title = candidate.title
  const normalizedTitle = normalizeTitle(title)
  const quoted = quotedSongName(title)
  const songKey = normalizeTitle(song)
  let score = 0

  if (songKey !== '') {
    if (quoted !== null && quoted.includes(songKey)) score += 55
    else if (normalizedTitle.includes(songKey)) score += 42
    else if (songKey.length >= 2 && candidate.description !== '' && normalizeTitle(candidate.description).includes(songKey)) score += 12
  }
  if (artist.trim() !== '') {
    const artistKey = normalizeTitle(artist)
    if (artistKey !== '') {
      if (normalizedTitle.includes(artistKey)) score += 35
      else if (normalizeTitle(candidate.author).includes(artistKey)) score += 28
      else if (candidate.description !== '' && normalizeTitle(candidate.description).includes(artistKey)) score += 10
    }
  } else {
    // 用户没给歌手：标题里带"原唱"或"官方"的留一点微弱优势，别把分数全押在播放量上。
    score += 4
  }
  for (const pattern of FAVOR) {
    if (pattern.test(title)) { score += 3; break }
  }
  // 播放量只破僵局：取对数，避免百万播放的混剪压过一切证据。
  if (candidate.play > 0) score += Math.min(8, Math.log10(candidate.play) * 1.6)
  return score
}

/** 排序后的候选（分数降序，同分取播放量高者）。 */
export function rankCandidates(
  candidates: readonly SongCandidate[],
  song: string,
  artist: string,
): readonly { readonly candidate: SongCandidate; readonly score: number }[] {
  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, song, artist) }))
    .sort((a, b) => (b.score - a.score) || (b.candidate.play - a.candidate.play))
}

/**
 * 这条候选是不是"用户说的那位歌手"的（给了歌手才判）。
 *
 * 为什么单独一个函数：`lookupSong` 要用它区分"同一首歌的不同版本"与"同名不同歌"——
 * 前者的标题千奇百怪（无损 / 4K修复 / 无损音质 / 故事的小黄花），后者才是要问用户的。
 */
export function artistMatched(candidate: SongCandidate, artist: string): boolean {
  const artistKey = normalizeTitle(artist)
  if (artistKey === '') return false
  return normalizeTitle(candidate.title).includes(artistKey)
    || normalizeTitle(candidate.author).includes(artistKey)
}

/**
 * 一次选定的结论。
 *
 * 三种结局写成一个函数而不是三个分支散在工具里：私聊点歌与自主选歌必须**用同一套判据**
 * （否则"机器人自己挑的时候敢猜，用户点的时候就问"，说不清哪个是对的）。
 *
 * "分不出来"的判据是**歌名 + 歌手是否都命中**，不是"前两名分差小"：
 * 实机搜「晴天 周杰伦」返回 5 条都是同一首歌（无损 / 4K修复 / UP 自己剪的 MV），
 * 标题各不相同但**都是周杰伦的《晴天》**。按分差判就会把一件确定的事变成一次多余的提问；
 * 而真正的"同名不同歌"（《晴天》周杰伦 vs 《晴天》五月天）在"指定歌手"之后也能定下来。
 * 所以：**歌名命中 + 歌手命中 = 确定**；缺歌手时才退回"分差 + 标题不同就问你"。
 */
export function lookupSong(
  candidates: readonly SongCandidate[],
  song: string,
  artist: string,
): SongLookup {
  const skipped: { bvid: string; reason: string }[] = []
  const usable: SongCandidate[] = []
  for (const candidate of candidates) {
    const reason = skipReason(candidate, song)
    if (reason !== null) { skipped.push({ bvid: candidate.bvid, reason }); continue }
    usable.push(candidate)
  }
  const ranked = rankCandidates(usable, song, artist)
  const head = ranked[0]
  if (head === undefined) return { chosen: null, candidates: [], skipped }

  const rest = ranked.slice(1, MAX_CANDIDATES).map((row) => row.candidate)
  // 给了歌手且头名对得上：这就是用户点的那首歌，不再因为"有别的版本"让用户挑。
  if (head.score >= CONFIRM_SCORE && artist.trim() !== '' && artistMatched(head.candidate, artist)) {
    return { chosen: head.candidate, candidates: rest, skipped }
  }

  const runnerUp = ranked[1]
  const ambiguous = runnerUp !== undefined
    && head.score - runnerUp.score < AMBIGUITY_MARGIN
    && normalizeTitle(head.candidate.title) !== normalizeTitle(runnerUp.candidate.title)

  // 分数不够高也算"分不出来"：那是"搜到的都不像这首歌"，同样只能让用户决定。
  if (head.score < CONFIRM_SCORE || ambiguous) {
    return { chosen: null, candidates: ranked.slice(0, MAX_CANDIDATES).map((row) => row.candidate), skipped }
  }
  return { chosen: head.candidate, candidates: rest, skipped }
}

/** `4:30` → 270；`163:39` 也认（B站超过一小时是"163:39"即 163 分钟，不是 1:63）。 */
export function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '未知时长'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${String(minutes)}:${String(rest).padStart(2, '0')}`
}

/** 给用户看的候选行（一句话，含 BV 号便于回头指定）。 */
export function describeCandidate(candidate: SongCandidate): string {
  return `${candidate.title} — ${candidate.author}（${durationText(candidate.duration)}，${candidate.bvid}）`
}
