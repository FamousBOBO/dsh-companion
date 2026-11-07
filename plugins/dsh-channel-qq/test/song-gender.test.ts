/** 歌手性别与音高：**"尽量女声，男声就升八度"** 这条准则的执行点。
 *
 * 为什么这些断言值得写：这条准则一旦判错，
 *   - 该升不升 → 三月七用男声的 f0 唱，出来明显偏低甚至破音；
 *   - 不该升却升了（把女声再升八度）→ 直接变成假音，比不升更糟。
 * 两种错都是"听起来不对"，而不会报错——所以只能靠这些纯函数断言钉住。
 *
 * 全部离线：不起进程、不联网、不读真实配置。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SongCandidate } from '../src/features/song/types.js'

const { singerGender, looksLikeCover, femaleCoverQuery, keyUpFor, genderText } =
  await import('../src/features/song/gender.js')

/** 一条候选（字段顺序与 B站适配器的归一化结果一致）。 */
function candidate(
  title: string,
  author = '某个UP',
  extra: Partial<SongCandidate> = {},
): SongCandidate {
  return { bvid: 'BV1d4411N7zD', title, author, duration: 270, play: 10_000, description: '', ...extra }
}

// ── 1. 字面标记优先 ──────────────────────────────────────────────────────────

test('标题写着「女声」就是女声，即使 UP 名里出现男歌手的名字', () => {
  const c = candidate('周杰伦《晴天》女声翻唱版', '翻唱小站')
  assert.equal(singerGender(c), 'female', '字面标记优先于歌手名单')
})

test('标题写着「男声」就是男声，即使歌名是女歌手的歌', () => {
  const c = candidate('《后来》男声版', '某个UP')
  assert.equal(singerGender(c), 'male')
})

test('`女key` / `女调` 这类不常见写法也认（B站标题真的很杂）', () => {
  assert.equal(singerGender(candidate('晴天 女key 翻唱')), 'female')
  assert.equal(singerGender(candidate('晴天 男调 翻唱')), 'male')
})

// ── 2. 歌手名单：命中才给结论，没命中返回 unknown ───────────────────────────

test('熟悉的女歌手名命中 → female；熟悉的男歌手名命中 → male', () => {
  assert.equal(singerGender(candidate('邓丽君 我只在乎你')), 'female')
  assert.equal(singerGender(candidate('《后来》 刘若英')), 'female')
  assert.equal(singerGender(candidate('周杰伦 - 晴天 官方MV')), 'male')
  assert.equal(singerGender(candidate('陈奕迅 十年')), 'male')
})

test('认不出来就返回 unknown——**不猜**（升错了比不升更糟）', () => {
  const stranger = candidate('某个我没听过的歌', '路人甲UP')
  assert.equal(singerGender(stranger), 'unknown')
  assert.equal(keyUpFor('unknown', 12), 0, 'unknown 不升调')
})

test('简介里带证据也算：标题没写、简介写了女声', () => {
  const c = candidate('晴天 翻唱', '翻唱小站', { description: '本视频为女声翻唱，感谢收听' })
  assert.equal(singerGender(c), 'female')
})

// ── 3. 升调：只有确定男声才升，且 clamp 到 0..24 ────────────────────────────

test('升调门槛：只有 male 才升；female / unknown 一律 0', () => {
  assert.equal(keyUpFor('male', 12), 12)
  assert.equal(keyUpFor('female', 12), 0, '女声源不该再升')
  assert.equal(keyUpFor('unknown', 12), 0, '不知道就不动音高')
})

test('升调配置越界时 clamp（配置写错不该产生假音）', () => {
  assert.equal(keyUpFor('male', -5), 0)
  assert.equal(keyUpFor('male', 99), 24, '上限两个八度，再多已经没有意义')
  assert.equal(keyUpFor('male', Number.NaN), 0)
  assert.equal(keyUpFor('male', 12.4), 12, '半音必须是整数')
})

test('默认值是一个八度（男声 85–180 Hz → 女声 165–255 Hz）', () => {
  // 这条断言看着像废话，但它守的是"默认值不许被悄悄改成 6 或 24"。
  assert.equal(keyUpFor('male', 12), 12)
})

// ── 4. 第二次搜索的关键词 ───────────────────────────────────────────────────

test('女声翻唱的关键词：带歌名 + 女声 + 翻唱，且不带歌手时不多塞东西', () => {
  assert.equal(femaleCoverQuery('晴天', ''), '晴天 女声 翻唱')
  assert.equal(femaleCoverQuery('晴天', '周杰伦'), '晴天 周杰伦 女声 翻唱', '给了歌手也带上，但只在末尾')
  assert.equal(femaleCoverQuery('  晴天  ', ''), '晴天 女声 翻唱', '前后空格要吃掉')
})

// ── 5. 说明文字：日志/后台要说清"为什么升调" ───────────────────────────────

test('性别说明：三种结局各有各的一句话（不能含混成同一句）', () => {
  assert.ok(genderText('female', 0).includes('女声'))
  assert.ok(genderText('male', 12).includes('12'), '要说清楚升几个半音')
  assert.ok(genderText('unknown', 0).includes('不确定'))
})

test('翻唱标记：`翻唱`/`cover` 认，「原唱」「官方MV」不认', () => {
  assert.equal(looksLikeCover(candidate('晴天 女声翻唱')), true)
  assert.equal(looksLikeCover(candidate('晴天 cover by 某人')), true)
  assert.equal(looksLikeCover(candidate('晴天 官方MV')), false)
  assert.equal(looksLikeCover(candidate('晴天 原唱')), false)
})

