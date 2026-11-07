/** 点歌的**纯函数**：选哪条视频、日键怎么算、账本怎么合并。
 *
 * 这三件事都用"给定输入就给定输出"的方式测，因为它们是最容易被悄悄改坏的地方：
 *   - 选源错了 = 发出去的是**别人歌**的翻唱（撤不回）；
 *   - 日键错了 = 自主选歌一天发两首，或者一条都不发；
 *   - 账本合并错了 = 去重失效（同一条消息两条语音条）或日额度算错。
 *
 * 全部离线：不联网、不起进程、不读真实文件（临时账本写 `mkdtemp`）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { SongCandidate, SongStage } from '../src/features/song/types.js'
import type { SongLedgerData, SongLedgerRow } from '../src/features/song/ledger.js'

const { lookupSong, scoreCandidate, skipReason, normalizeTitle, quotedSongName, describeCandidate } =
  await import('../src/features/song/select.js')
const { songDayKey, rotationIndex } = await import('../src/features/song/day.js')
const { emptyLedger, loadLedger, mergeLedger, autoUsedToday, countsAsSent, dedupeHit, isTerminal } =
  await import('../src/features/song/ledger.js')

/** 一条候选（字段顺序与真实适配器的归一化结果一致）。 */
function candidate(
  bvid: string,
  title: string,
  author: string,
  extra: Partial<SongCandidate> = {},
): SongCandidate {
  return { bvid, title, author, duration: 240, play: 10_000, description: '', ...extra }
}

// ── 1. 选源：跳过规则与"够不够确定" ──────────────────────────────────────────

test('选源：伴奏/教程/混剪/二次AI 一律跳过，且理由逐条说清', () => {
  const cases: Array<[string, string]> = [
    ['【伴奏】晴天', '伴奏'],
    ['晴天（纯伴奏版）', '伴奏'],
    ['周杰伦晴天消音版', '消音'],
    ['教你唱晴天', '教程'],
    ['周杰伦经典歌曲串烧合集', '混剪'],
    ['【鬼畜】晴天', '鬼畜'],
    ['AI孙燕姿翻唱《晴天》', '二次 AI'],
    ['晴天名场面片段', '片段'],
    ['晴天 reaction', '解说'],
  ]
  for (const [title, keyword] of cases) {
    const reason = skipReason(candidate('BV1aaaaaaaaa', title, '某人'), '晴天')
    assert.ok(reason !== null, `「${title}」应当被跳过`)
    assert.ok(reason.includes(keyword), `「${title}」的跳过理由应含「${keyword}」，实际是「${reason}」`)
  }
  // 正常原唱不该被跳。
  assert.equal(skipReason(candidate('BV1bbbbbbbbb', '周杰伦 - 晴天 官方MV', 'zyl'), '晴天'), null)
})

test('选源：太短/太长的都不当原唱（片段与演唱会合集）', () => {
  const short = skipReason(candidate('BV1ccccccccc', '晴天', 'x', { duration: 30 }), '晴天')
  const long = skipReason(candidate('BV1ddddddddd', '晴天', 'x', { duration: 2_000 }), '晴天')
  assert.ok(short !== null && short.includes('太短'), `30 秒应判太短，实际「${String(short)}」`)
  assert.ok(long !== null && long.includes('太长'), `33 分钟应判太长，实际「${String(long)}」`)
})

test('选源：歌名+歌手都命中才够确定（书名号最强、UP 名次之）', () => {
  const quoted = scoreCandidate(candidate('BV1eeeeeeeee', '《晴天》 - 周杰伦 无损', 'zyl2012'), '晴天', '周杰伦')
  const titleOnly = scoreCandidate(candidate('BV1fffffffff', '晴天 4K修复', 'zyl2012'), '晴天', '周杰伦')
  const unknown = scoreCandidate(candidate('BV1ggggggggg', '别的歌', '路人'), '晴天', '周杰伦')
  assert.ok(quoted > titleOnly, `书名号命中(${quoted}) 应高于仅标题命中(${titleOnly})`)
  assert.ok(titleOnly > unknown, `标题命中(${titleOnly}) 应高于毫不相关(${unknown})`)
  assert.ok(quoted >= 80, `歌名+歌手都命中应过 80 分门槛，实际 ${quoted}`)
})

test('选源：分不出时返回候选清单而不是猜（同名不同歌）', () => {
  // 两条都是《晴天》但歌手不同、分数接近：这是真实存在的"同名歌"。
  const found = [
    candidate('BV1hhhhhhhhh', '《晴天》 周杰伦', 'UP-A', { play: 500_000 }),
    candidate('BV1iiiiiiiii', '《晴天》 五月天', 'UP-B', { play: 480_000 }),
  ]
  const lookup = lookupSong(found, '晴天', '')
  assert.equal(lookup.chosen, null, '不指定歌手时两条分数接近，必须让用户选')
  assert.equal(lookup.candidates.length, 2, '候选清单要给出两条')
})

test('选源：指定歌手之后就能定下来（不再让用户选）', () => {
  const found = [
    candidate('BV1jjjjjjjjj', '《晴天》 周杰伦', 'UP-A', { play: 500_000 }),
    candidate('BV1kkkkkkkkk', '《晴天》 五月天', 'UP-B', { play: 480_000 }),
  ]
  const lookup = lookupSong(found, '晴天', '周杰伦')
  assert.ok(lookup.chosen !== null, '指定歌手后应当能定下来')
  assert.equal(lookup.chosen.bvid, 'BV1jjjjjjjjj')
})

test('选源：搜到的都不像这首歌 → chosen=null 且给出原因', () => {
  const lookup = lookupSong([candidate('BV1lllllllll', '完全无关的视频', '路人')], '晴天', '周杰伦')
  assert.equal(lookup.chosen, null)
  assert.equal(lookup.candidates.length, 1, '不像但没被跳过：仍列给用户看')
  assert.deepEqual(lookup.skipped, [])
})

test('选源：全部被跳过 → 候选为空（工具面据此说"都不适合当原唱"）', () => {
  const lookup = lookupSong([
    candidate('BV1mmmmmmmmm', '【伴奏】晴天', 'UP'),
    candidate('BV1nnnnnnnnn', '晴天教程', 'UP'),
  ], '晴天', '周杰伦')
  assert.equal(lookup.chosen, null)
  assert.equal(lookup.candidates.length, 0)
  assert.equal(lookup.skipped.length, 2)
})

test('标题归一化与书名号：括号里的内容不参与比对；`《》` 里的才是歌名', () => {
  assert.equal(normalizeTitle('【4K修复】周杰伦 - 晴天（官方MV）'), '周杰伦 晴天')
  assert.equal(quotedSongName('【4K】《晴天》周杰伦'), '晴天')
  assert.equal(quotedSongName('没有书名号的标题'), null)
  assert.ok(describeCandidate(candidate('BV1ooooooooo', '晴天', 'zyl', { duration: 270 })).includes('4:30'))
})

// ── 2. 日键：`Asia/Shanghai` 的自然日 ───────────────────────────────────────

test('日键：跨 UTC 午夜但仍在上海同一天时，日键不变', () => {
  // 2026-11-07 23:30 +08:00 = 15:30 UTC；2026-11-08 07:30 +08:00 = 2026-11-07 23:30 UTC。
  const lateNight = Date.parse('2026-11-07T15:30:00Z') // 上海 23:30，仍是 11-07
  const nextMorning = Date.parse('2026-11-07T23:30:00Z') // 上海 11-08 07:30
  assert.equal(songDayKey(lateNight), '2026-11-07')
  assert.equal(songDayKey(nextMorning), '2026-11-08')
})

test('日键：非法输入返回 null（调用方据此 fail-closed）', () => {
  assert.equal(songDayKey(Number.NaN), null)
  assert.equal(songDayKey(0, 'Not/AZone'), null)
})

test('日键：轮换下标同一天稳定、不同天会变', () => {
  const size = 5
  assert.equal(rotationIndex('2026-11-07', size), rotationIndex('2026-11-07', size))
  const spread = new Set(['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']
    .map((day) => rotationIndex(day, size)))
  assert.ok(spread.size >= 2, '五个相邻日期不该全落到同一首')
  for (const value of spread.values()) assert.ok(value >= 0 && value < size)
  assert.equal(rotationIndex('2026-11-07', 0), 0, '空池子返回 0 而不是崩')
})

// ── 3. 账本：合并、去重、日额度 ──────────────────────────────────────────────

test('账本：坏文件/不存在都按空账本开始（不抛）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'song-ledger-'))
  try {
    const logs: string[] = []
    assert.deepEqual(await loadLedger(path.join(dir, 'missing.json'), (l) => logs.push(l)), emptyLedger())
    const bad = path.join(dir, 'bad.json')
    writeFileSync(bad, '{ 这不是 JSON', 'utf8')
    assert.deepEqual(await loadLedger(bad, (l) => logs.push(l)), emptyLedger())
    assert.ok(logs.some((line) => line.includes('不是合法 JSON')), '坏账本要在日志里说一句')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function row(
  id: string,
  stage: SongLedgerRow['stage'],
  updatedAt: number,
  extra: Partial<SongLedgerRow> = {},
): SongLedgerRow {
  return {
    id, entry: 'dm', room: 'dm-1', song: '晴天', artist: '', stage,
    bvid: 'BV1aaaaaaaaa', chorusStart: null, seconds: null, detail: null,
    keyUp: null,
    createdAt: updatedAt, updatedAt, messageId: null, ...extra,
  }
}

test('账本：upsert 按 id 覆盖整行，14 天前的记录被裁掉', () => {
  const now = 1_000_000_000
  const old = row('s-old', 'sent', now - 15 * 24 * 3_600_000)
  const fresh = row('s-new', 'queued', now)
  const merged = mergeLedger(
    { version: 1, tasks: [old, fresh], autoDay: '', autoCount: 0 },
    { upsert: [{ ...fresh, stage: 'sent' }] },
    now,
  )
  assert.equal(merged.tasks.length, 1, '15 天前的记录要按保留期裁掉')
  assert.equal(merged.tasks[0]?.id, 's-new')
  assert.equal(merged.tasks[0]?.stage, 'sent', 'upsert 覆盖之后是新阶段')
})

test('账本：sent 与 unknown-send 都算"发过"（去重与额度都读它）', () => {
  assert.equal(countsAsSent(row('a', 'sent', 1)), true)
  assert.equal(countsAsSent(row('b', 'unknown-send', 1)), true, '回执未知也要算发过——否则下一轮会再发一条')
  assert.equal(countsAsSent(row('c', 'failed', 1)), false)
  assert.equal(countsAsSent(row('d', 'dry-run', 1)), false)
})

test('账本：终态判定覆盖所有终态，中间阶段不算终态', () => {
  const terminal: SongStage[] = ['sent', 'failed', 'unknown-send', 'cancelled', 'dry-run']
  for (const stage of terminal) assert.equal(isTerminal(stage), true, `${stage} 应是终态`)
  const middle: SongStage[] = ['queued', 'downloading', 'chorus', 'covering', 'sending']
  for (const stage of middle) assert.equal(isTerminal(stage), false, `${stage} 不该是终态`)
})

test('账本：去重按 id 命中；日额度跨日归零', () => {
  const ledger: SongLedgerData = {
    version: 1, tasks: [row('s-1', 'sent', 1)], autoDay: '2026-11-06', autoCount: 1,
  }
  assert.equal(dedupeHit(ledger, 's-1')?.stage, 'sent')
  assert.equal(dedupeHit(ledger, 's-2'), null)
  assert.equal(autoUsedToday(ledger, '2026-11-06'), 1)
  assert.equal(autoUsedToday(ledger, '2026-11-07'), 0, '日键不一致 = 跨日归零')
})

test('账本：脏记录逐条丢弃，好记录照常读出（一行坏数据不该让整本不可读）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'song-ledger-'))
  try {
    const file = path.join(dir, 'ledger.json')
    writeFileSync(file, JSON.stringify({
      version: 1, autoDay: '2026-11-07', autoCount: 1,
      tasks: [row('s-ok', 'sent', 5), { id: 's-bad', stage: '胡说' }, null, 42],
    }), 'utf8')
    const ledger = await loadLedger(file, () => {})
    assert.equal(ledger.tasks.length, 1)
    assert.equal(ledger.tasks[0]?.id, 's-ok')
    assert.equal(ledger.autoDay, '2026-11-07')
    assert.equal(ledger.autoCount, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
