/** 歌手性别：决定"找女声翻唱"还是"男声原曲升八度"。
 *
 * 为什么需要这一层：**音色模型是女声**。拿男声原唱直接换声，RVC 的 f0 落在男声区间，
 * 转换出来会明显偏低甚至破音；而"先找女声翻唱、找不到再升八度"是这条链路唯一稳的顺序。
 *
 * 为什么用**猜**而不是查接口：B站没有"歌手性别"字段，任何云音乐接口都要额外登录与
 * 一个外部依赖。所以这里只用两类**看得见的证据**，且都写在明处：
 *
 *   1. **标题/简介里的字面标记**（`女声` / `女版` / `女key` / `男声` …）——最硬；
 *   2. **一份常见歌手名单**（只收几十年里耳熟能详的，不做全量）。名单命中才给结论，
 *      没命中一律 `unknown`。
 *
 * `unknown` 的处理刻意保守：**不升调**（升错了比不升更糟——把女声再升八度就是假音），
 * 但仍然允许"搜一次女声翻唱"（那是"尽量找女声"的便宜做法，找不到就算了）。
 *
 * 这个文件是纯函数（零 IO、零时钟）：同样的标题永远给同样的结论，才能在测试里钉住。
 */

import type { SongCandidate } from './types.js'

/** 一条候选的性别判断结果。`unknown` = 证据不足（不猜）。 */
export type SingerGender = 'female' | 'male' | 'unknown'

/** 标题/简介里的字面标记：这些词出现就是明确说了性别。 */
const FEMALE_MARKERS: readonly RegExp[] = [/女声|女版|女生版|女key|女调|女歌手|女子|女嗓|女毒/i]
const MALE_MARKERS: readonly RegExp[] = [/男声|男版|男生版|男key|男调|男歌手|男嗓/i]
/** "翻唱"本身不决定性别，但它说明**这条不是原唱**——性别要另外看歌手。 */
const COVER_MARKERS: readonly RegExp[] = [/翻唱|cover|翻自|改编/i]

/**
 * 常见女歌手。**这份名单是"够用"而不是"全"**：命中就少搜一次，没命中只是多搜一次，
 * 不会给出错误结论（`unknown` 时不做任何破坏性的处理）。
 */
const FEMALE_SINGERS: readonly string[] = [
  '邓丽君', '王菲', '张惠妹', '孙燕姿', '梁静茹', '蔡依林', '刘若英', '莫文蔚', '田馥甄', 'SHE',
  '杨丞琳', '张韶涵', '王心凌', '徐佳莹', '陈粒', '程响', '任然', '单依纯', '黄霄云', '张碧晨',
  '邓紫棋', '张靓颖', '李宇春', '周笔畅', '那英', '韩红', '谭维维', '郁可唯', '金莎', '郭静',
  '戴佩妮', '许茹芸', '辛晓琪', '林忆莲', '陈慧娴', '梅艳芳', '陈淑桦', '李玟', '萧亚轩',
  '杨千嬅', '容祖儿', '郑秀文', '卓文萱', '江美琪', '潘越云', '齐豫', '叶倩文', '彭羚',
  '孟庭苇', '周蕙', '锦绣二重唱', 'Twins', '范玮琪', '黄龄', '萨顶顶', '谭晶', '陈瑞', '云朵',
]

/** 常见男歌手（同上：只求"够用"）。 */
const MALE_SINGERS: readonly string[] = [
  '周杰伦', '林俊杰', '陈奕迅', '张学友', '刘德华', '郭富城', '黎明', '张国荣', '谭咏麟',
  '李克勤', '古巨基', '许志安', '苏永康', '郑伊健', '谢霆锋', '陈小春', '张信哲', '张宇',
  '邰正宵', '齐秦', '熊天平', '动力火车', '五月天', '阿信', '伍佰', '罗大佑', '李宗盛',
  '周华健', '陶喆', '王力宏', '林志炫', '毛宁', '满文军', '孙楠', '汪峰', '许巍', '朴树',
  '郑智化', '黄家驹', 'Beyond', '李荣浩', '薛之谦', '华晨宇', '张杰', '毛不易', '许嵩',
  '汪苏泷', '陈楚生', '庾澄庆', '费玉清', '赵传', '任贤齐', '黄品源', '周传雄', '光良',
  '品冠', '张震岳', '萧敬腾', '林宥嘉', '方大同', '曹格', '信乐团', '黑豹乐队', '唐朝乐队',
]

/** 一条候选里"像性别标记"的那部分文本（标题 + 简介 + UP 名，都归一化）。 */
function markersOf(candidate: SongCandidate): string {
  return `${candidate.title} ${candidate.description} ${candidate.author}`.toLowerCase()
}

/** 名单命中？名字里带空格/符号的直接按原样比对也会中（名单都是中文名）。 */
function hitsList(haystack: string, names: readonly string[]): boolean {
  for (const name of names) {
    if (haystack.includes(name.toLowerCase())) return true
  }
  return false
}

/**
 * 这条候选大概是男声、女声，还是不知道。
 *
 * 顺序刻意是"字面标记 → 歌手名单"：标题写着「女声翻唱」时，即使 UP 名里出现了某位
 * 男歌手的名字（"某某某的歌"），那也是女声翻唱。**字面标记优先**。
 */
export function singerGender(candidate: SongCandidate): SingerGender {
  const text = markersOf(candidate)
  if (FEMALE_MARKERS.some((pattern) => pattern.test(text))) return 'female'
  if (MALE_MARKERS.some((pattern) => pattern.test(text))) return 'male'
  if (hitsList(text, FEMALE_SINGERS)) return 'female'
  if (hitsList(text, MALE_SINGERS)) return 'male'
  return 'unknown'
}

/** 这条候选是不是"翻唱"（不是原唱）。只用于给候选行补一句说明。 */
export function looksLikeCover(candidate: SongCandidate): boolean {
  const text = markersOf(candidate)
  return COVER_MARKERS.some((pattern) => pattern.test(text))
}

/**
 * 第二次搜索用的关键词：`歌名 女声 翻唱`。
 *
 * 为什么这三个词：B站上女声翻唱视频的标题几乎都带其中一个或全部；多带"女声"是为了
 * 让上游**把女声版排到前面**，而不是靠我们再排一遍（我们只能看到前 8 条）。
 */
export function femaleCoverQuery(song: string, artist: string): string {
  const name = song.trim()
  if (artist.trim() === '') return `${name} 女声 翻唱`
  return `${name} ${artist.trim()} 女声 翻唱`
}

/**
 * 最终用哪个音高。
 *
 * 只有**确定是男声**才升（默认一个八度）。升八度是**同音级移调**，所以伴奏的和声关系
 * 不变——这正是"男声歌也能用女声模型唱"的标准做法；升错了（把女声再升八度）才会变成假音。
 */
export function keyUpFor(gender: SingerGender, maleKeyUp: number): number {
  if (gender !== 'male') return 0
  if (!Number.isFinite(maleKeyUp)) return 0
  return Math.max(0, Math.min(24, Math.round(maleKeyUp)))
}

/** 给用户/日志的一句话说明（"这条是女声翻唱" / "男声原曲，升一个八度"）。 */
export function genderText(gender: SingerGender, keyUp: number): string {
  if (gender === 'female') return '女声源，不升调'
  if (gender === 'male') {
    return keyUp > 0 ? `男声源，升 ${String(keyUp)} 个半音再换声` : '男声源，未升调（按配置）'
  }
  return '性别不确定，按原调换声（保守：升错比不升更糟）'
}
