/** "挑一条女声翻唱"（`select.ts::pickFemaleCover`）：**判据与"点歌选原唱"刻意不同**。
 *
 * 为什么值得单独一个文件：这段判据一旦错了，两种结果都是"发出去的歌不对"——
 *   - 太严（用 80 分门槛）→ 永远挑不出女声翻唱，准则变成摆设，男声歌一律升八度；
 *   - 太松（只要标题带"女声"）→ 可能选到别的歌、日语填词版、甚至伴奏版。
 *
 * 全部离线：纯函数、零 IO。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SongCandidate } from '../src/features/song/types.js'

const { pickFemaleCover } = await import('../src/features/song/select.js')

/** 一条候选（与 B站适配器的归一化结果同形；`author` 与 `extra` 分开便于读）。 */
function candidate(
  bvid: string,
  title: string,
  author: string,
  extra: Partial<SongCandidate> = {},
): SongCandidate {
  return { bvid, title, author, duration: 240, play: 10_000, description: '', ...extra }
}

test('门槛不是 80 分：关键词里没有歌手，那 35 分拿不到也能用', () => {
  // 实机搜「晴天 周杰伦 女声 翻唱」时这条就是 67 分左右。
  const found = [candidate('BV1nY4w6kEQS', '周杰伦《晴天》女声完整版', '柯唯Chole')]
  const picked = pickFemaleCover(found, '晴天')
  assert.ok(picked !== null, '歌名命中 + 确定是女声 = 可用，不该被 80 分门槛挡住')
  assert.equal(picked.bvid, 'BV1nY4w6kEQS')
})

test('多条女声版是常态：取分最高那条，不退回"让你再选一次"', () => {
  const found = [
    candidate('BV1aaa000001', '晴天 女声翻唱', 'UP-A', { play: 1_000 }),
    candidate('BV1bbb000002', '《晴天》女版 无损', 'UP-B', { play: 900_000 }),
    candidate('BV1ccc000003', '晴天 女声', 'UP-C', { play: 10_000 }),
  ]
  const picked = pickFemaleCover(found, '晴天')
  assert.ok(picked !== null, '多条女声版不该让用户再选：它们都是这首歌')
  assert.equal(picked.bvid, 'BV1bbb000002', '《》+ 无损 + 高播放应当胜出')
})

test('日语/英文/粤语填词翻唱一律跳过（旋律同、词不同 → 外语副歌）', () => {
  const found = [candidate('BV1jp0000001', '温柔治愈女声日语版《晴天》【日文翻唱】', '小柔Channel')]
  assert.equal(pickFemaleCover(found, '晴天'), null)
})

test('男声翻唱 / 别的歌 / 伴奏版都不认', () => {
  const found = [
    candidate('BV1male000001', '晴天 男声版', 'UP'),
    candidate('BV1song000002', '《起风了》女声翻唱', 'UP'),
    candidate('BV1inst000003', '晴天 女声伴奏版', 'UP'),
  ]
  assert.equal(pickFemaleCover(found, '晴天'), null)
})

test('歌名空 / 候选空：返回 null 而不是乱挑一条', () => {
  assert.equal(pickFemaleCover([], '晴天'), null)
  assert.equal(pickFemaleCover([candidate('BV1x00000001', '晴天 女声翻唱', 'UP')], '   '), null)
})
