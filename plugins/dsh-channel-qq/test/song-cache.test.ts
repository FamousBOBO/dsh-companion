/** 同歌缓存：**键的判据** + 命中/未命中在流水线上的行为（离线，全假端口）。
 *
 * 这个文件钉住的是操作员那句原话——「相同的歌曲缓存，直接复用」——在代码里的两条含义：
 *
 *   1. **键决定"什么算同一首歌"**：同一首歌同一种做法 → 同一个键；音高、分P、上限、
 *      起点、长度任一变 → 另一个键。键错了的后果不是"慢"，而是**发出另一段的语音条**
 *      （原调与升八度混用会走音），所以那几条断言比命中本身更重要。
 *   2. **命中时四步里有几步真的不跑**：`downloadAudio` / `chorus.locate` / `cover.render`
 *      各自一次都不许被调，但仍然要过闸门、仍然只发一次。用调用计数断言，不看日志。
 *
 * 适配器的落盘细节（`ffprobe` 核时长、淘汰、孤儿清理）在 `song-cache-adapter.test.ts`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { Clock } from '../src/ports/clock.js'
import type { SongConfig } from '../src/config/sections/song.js'
import type {
  BiliPort, ChorusPort, ChorusPick, CoverPort, CoverResult, SendGatePort, SongCandidate,
  SongCachePort, SongPlanRecord, SongRequest, VoicePort, VoiceSendResult,
} from '../src/features/song/types.js'

const { SongQueue, taskIdOf } = await import('../src/features/song/queue.js')
const { planCacheKey, clipCacheKey, PLAN_ALGO_TAG, COVER_ALGO_TAG } = await import('../src/features/song/cache-key.js')

const BVID = 'BV1d4411N7zD'
const CID = 317843818

/** 假时钟：`now()` 只读（队列记账只看它）。 */
function fakeClock(start = 1_700_000_000_000): Clock {
  return {
    now: () => start,
    date: () => new Date(start),
    setTimeout: () => ({ cancel: () => {} }),
    setInterval: () => ({ cancel: () => {} }),
  }
}

function request(overrides: Partial<SongRequest> = {}): SongRequest {
  return {
    id: taskIdOf('msg:42'),
    entry: 'dm',
    requesterId: 1429709395,
    room: 'dm-1429709395',
    chatId: 1429709395,
    dedupeKey: 'msg:42',
    song: '晴天',
    artist: '周杰伦',
    bvid: BVID,
    chorusAt: null,
    keyUp: 0,
    requestedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** 假缓存端口：记住 `features/` 让它做的事，不碰盘（落盘在适配器测试里验）。 */
interface FakeCache {
  readonly port: SongCachePort
  readonly plans: Map<string, SongPlanRecord>
  readonly clips: Map<string, string>
  readonly calls: { getPlan: number; putPlan: number; getClip: number; putClip: number; prune: number }
}

function fakeCache(): FakeCache {
  const plans = new Map<string, SongPlanRecord>()
  const clips = new Map<string, string>()
  const calls = { getPlan: 0, putPlan: 0, getClip: 0, putClip: 0, prune: 0 }
  const port: SongCachePort = {
    planKey: planCacheKey,
    clipKey: clipCacheKey,
    async getPlan(key) { calls.getPlan += 1; return plans.get(key) ?? null },
    async putPlan(key, value) { calls.putPlan += 1; plans.set(key, value) },
    async getClip(key, expectedSeconds) {
      calls.getClip += 1
      const file = clips.get(key)
      // 假端口不量时长：适配器的核对逻辑在 song-cache-adapter.test.ts 里单独验。
      return file === undefined ? null : { file, durationSeconds: expectedSeconds }
    },
    async putClip(key, sourceFile) { calls.putClip += 1; clips.set(key, sourceFile) },
    async prune() { calls.prune += 1 },
  }
  return { port, plans, clips, calls }
}

interface FakeOptions {
  readonly sendOutcome?: (attempt: number) => VoiceSendResult
}

interface Fakes {
  readonly bili: BiliPort
  readonly chorus: ChorusPort
  readonly cover: CoverPort
  readonly voice: VoicePort
  readonly gate: SendGatePort
  readonly calls: {
    videoInfo: number; download: number; chorus: number; render: number; send: number; gate: number
  }
  readonly renderedSeconds: number[]
}

function fakes(options: FakeOptions = {}): Fakes {
  const calls = { videoInfo: 0, download: 0, chorus: 0, render: 0, send: 0, gate: 0 }
  const renderedSeconds: number[] = []
  const bili: BiliPort = {
    async search(): Promise<readonly SongCandidate[]> { return [] },
    async videoInfo(bvid: string) {
      calls.videoInfo += 1
      return {
        bvid, title: '晴天', author: '周杰伦', duration: 317,
        pages: [{ cid: CID, part: '晴天', duration: 317 }],
      }
    },
    async downloadAudio(_bvid: string, _cid: number, dest: string) {
      calls.download += 1
      return { file: dest, bytes: 6_700_000 }
    },
  }
  const chorus: ChorusPort = {
    async locate(): Promise<ChorusPick | null> {
      calls.chorus += 1
      return {
        startSeconds: 84, endSeconds: 109, confidence: 0.87,
        method: 'repeat+energy', repeats: 2, vocalRatio: 0.7, phraseEnds: [],
      }
    },
  }
  const cover: CoverPort = {
    async render(input): Promise<CoverResult> {
      calls.render += 1
      renderedSeconds.push(input.seconds)
      return {
        voiceFile: path.join(input.outDir, 'voice.mp3'),
        durationSeconds: input.seconds,
        chorusStart: input.chorusStart,
        seconds: input.seconds,
        keyUp: input.keyUp,
        summary: {},
      }
    },
  }
  const voice: VoicePort = {
    async sendVoice(): Promise<VoiceSendResult> {
      calls.send += 1
      return options.sendOutcome?.(calls.send) ?? { ok: true, messageId: 900 + calls.send, unknown: false, detail: '' }
    },
  }
  const gate: SendGatePort = {
    async authorize() {
      calls.gate += 1
      return { verdict: 'allowed', reason: 'ok' }
    },
  }
  return { bili, chorus, cover, voice, gate, calls, renderedSeconds }
}

function configOf(overrides: Partial<SongConfig> = {}): () => SongConfig {
  const base: SongConfig = {
    enabled: true, autoPick: true, groupEnabled: true, dryRun: false, allowExternalSend: true,
    seconds: 59, minConfidence: 0.55, preferFemale: true, maleKeyUp: 12, prefixSeconds: 12,
    pythonPath: '', rvcRoot: '', makeCover: '', chorusPython: '',
    biliCredentialFile: '', workRoot: '', ffmpegPath: 'ffmpeg',
    downloadTimeoutMs: 60_000, chorusTimeoutMs: 30_000, coverTimeoutMs: 240_000,
    sendTimeoutMs: 30_000, maxQueue: 4, cacheEnabled: true, cacheMaxEntries: 50,
    dailyAutoCap: 1, dailyUserCap: 0, autoSongs: ['晴天 周杰伦'],
    ...overrides,
  }
  return () => base
}

/** 建一个跑在临时目录里的队列（账本写临时目录，跑完删）。`cache` 缺省 = 没注入。 */
function makeQueue(f: Fakes, extra: {
  readonly config?: Partial<SongConfig>
  readonly cache?: SongCachePort
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'song-cache-'))
  const logs: string[] = []
  const queue = new SongQueue({
    bili: f.bili,
    chorus: f.chorus,
    cover: f.cover,
    voice: f.voice,
    gate: f.gate,
    clock: fakeClock(),
    config: configOf(extra.config),
    log: (line: string) => logs.push(line),
    workRoot: path.join(dir, 'work'),
    ledgerFile: path.join(dir, 'ledger.json'),
    ...(extra.cache === undefined ? {} : { cache: extra.cache }),
  })
  return { queue, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 等某条任务进终态（串行链跑完）。超时返回 null（让断言给出可读失败，而不是挂住）。 */
async function settle(
  queue: { status(limit?: number): readonly { id: string; stage: string }[] },
  id: string | null,
  timeoutMs = 3_000,
): Promise<{ id: string; stage: string; detail: string | null; chorusStart: number | null;
  seconds: number | null } | null> {
  if (id === null) return null
  const terminal = ['sent', 'dry-run', 'failed', 'unknown-send', 'cancelled']
  const started = Date.now()
  for (;;) {
    const row = queue.status(50).find((task) => task.id === id)
    if (row !== undefined && terminal.includes(row.stage)) {
      return row as unknown as { id: string; stage: string; detail: string | null;
        chorusStart: number | null; seconds: number | null }
    }
    if (Date.now() - started > timeoutMs) return null
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// ── 1. 键的判据 ─────────────────────────────────────────────────────────────

test('键：同一首歌同一套参数 → 同一个键（两次调用逐字相同）', () => {
  assert.equal(planCacheKey(BVID, CID, 12, 59), planCacheKey(BVID, CID, 12, 59))
  assert.equal(clipCacheKey(BVID, CID, 12, 84, 49.5), clipCacheKey(BVID, CID, 12, 84, 49.5))
  assert.equal(planCacheKey(BVID, CID, 12, 59.0004), planCacheKey(BVID, CID, 12, 59),
    '毫秒之后的抖动不该造出两个键（秒数按三位小数归一）')
})

test('键：音高/分P/上限/起点/长度 任一不同 → 不同键', () => {
  const plan = planCacheKey(BVID, CID, 12, 59)
  assert.notEqual(plan, planCacheKey(BVID, CID, 0, 59), 'keyUp 不同必须另算：原调与升八度不是同一条音频')
  assert.notEqual(plan, planCacheKey(BVID, CID + 1, 12, 59), 'cid 不同必须另算：多P 视频的副歌在别的分P')
  assert.notEqual(plan, planCacheKey(BVID, CID, 12, 45), '上限不同必须另算：上限决定收在哪句')

  const clip = clipCacheKey(BVID, CID, 12, 84, 49.5)
  assert.notEqual(clip, clipCacheKey(BVID, CID, 12, 84.5, 49.5), '起点不同必须另算')
  assert.notEqual(clip, clipCacheKey(BVID, CID, 12, 84, 45), '长度不同必须另算（缩短档位天然是另一个键）')
  assert.notEqual(clip, clipCacheKey(BVID, CID, 0, 84, 49.5))
  assert.notEqual(clip, clipCacheKey(BVID, CID + 1, 12, 84, 49.5))
})

test('键：带算法版本标签，且是合法的文件名（可直接当缓存文件名）', () => {
  const plan = planCacheKey(BVID, CID, 12, 59)
  const clip = clipCacheKey(BVID, CID, 12, 84, 49.5)
  assert.ok(plan.endsWith(PLAN_ALGO_TAG), `方案键要带 ${PLAN_ALGO_TAG}，实际「${plan}」`)
  assert.ok(clip.endsWith(COVER_ALGO_TAG), `成品键要带 ${COVER_ALGO_TAG}，实际「${clip}」`)
  for (const key of [plan, clip]) {
    // `~` 是转义标记（`~XXXX`），它与字母数字点连字符一样是合法文件名字符。
    assert.match(key, /^[A-Za-z0-9._~-]+$/, `键必须是安全文件名，实际「${key}」`)
  }
  // BV 号里出现奇怪字符时也不能让键跑出目录（`/` `\` `..` 都不该原样留下）。
  const weird = planCacheKey('../x/y', CID, 12, 59)
  assert.match(weird, /^[A-Za-z0-9._~-]+$/)
  assert.ok(weird.includes('~002E~002E'), `可疑字符要被转义，实际「${weird}」`)
  assert.ok(weird.includes('~002F'), `斜杠不能原样留下，实际「${weird}」`)
})

// ── 2. 命中：四步里三步都不跑 ───────────────────────────────────────────────

test('命中：不调下载/定位/翻唱，但仍然过闸门 + 只发一次', async () => {
  const f = fakes()
  const cache = fakeCache()
  // 上一次的成果：方案（起点 84 / 长度 59）+ 成品。
  cache.plans.set(planCacheKey(BVID, CID, 0, 59), { chorusStart: 84, seconds: 59, confidence: 0.87 })
  cache.clips.set(clipCacheKey(BVID, CID, 0, 84, 59), path.join(tmpdir(), 'cached-voice.mp3'))
  const { queue, logs, cleanup } = makeQueue(f, { cache: cache.port })
  try {
    await queue.load()
    const result = await queue.enqueue(request({ dedupeKey: 'msg:hit', id: taskIdOf('msg:hit') }))
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null, '任务必须走到终态')
    assert.equal(row.stage, 'sent')
    assert.equal(f.calls.download, 0, '命中缓存就不该再下载音轨')
    assert.equal(f.calls.chorus, 0, '命中缓存就不该再跑副歌定位')
    assert.equal(f.calls.render, 0, '命中缓存就不该再跑分离 + RVC')
    assert.equal(f.calls.gate, 1, '缓存不能绕过发送闸门')
    assert.equal(f.calls.send, 1, '缓存命中也要真的发一次')
    assert.equal(f.calls.videoInfo, 1, '分P 要从视频信息里挑，这一步省不掉（键里有 cid）')
    assert.equal(row.chorusStart, 84)
    assert.equal(row.seconds, 59)
    assert.ok(logs.some((line) => line.includes('命中缓存') && line.includes('跳过下载与翻唱')),
      `"为什么这次很快"必须能从日志读出来：\n${logs.join('\n')}`)
    assert.equal(cache.calls.putPlan, 0, '命中时不必重写方案')
    assert.equal(cache.calls.putClip, 0, '命中时不必重写成品')
  } finally { cleanup() }
})

test('命中：效果就是把整条 python 链路省掉（同样的两个请求，第二次一次 python 也不跑）', async () => {
  const f = fakes()
  const cache = fakeCache()
  const { queue, cleanup } = makeQueue(f, { cache: cache.port })
  try {
    await queue.load()
    const first = await queue.enqueue(request({ dedupeKey: 'msg:1', id: taskIdOf('msg:1') }))
    const firstRow = await settle(queue, first.taskId)
    assert.equal(firstRow?.stage, 'sent')
    assert.equal(f.calls.render, 1)
    // 第二次：同一个 bvid / keyUp / 上限（用户再点一次同一首歌）。
    const second = await queue.enqueue(request({ dedupeKey: 'msg:2', id: taskIdOf('msg:2') }))
    const secondRow = await settle(queue, second.taskId)
    assert.equal(secondRow?.stage, 'sent')
    assert.equal(f.calls.download, 1, '下载只发生过一次（第二次跳过了）')
    assert.equal(f.calls.chorus, 1, '副歌定位只发生过一次')
    assert.equal(f.calls.render, 1, '分离 + RVC 只发生过一次')
    assert.equal(f.calls.send, 2, '两次都发了语音条')
    assert.equal(cache.calls.putPlan, 1, '第一次落一次方案')
    assert.equal(cache.calls.putClip, 1, '第一次落一次成品')
  } finally { cleanup() }
})

// ── 3. 未命中：照常四步，成功后落两层 ───────────────────────────────────────

test('未命中：照常下载+定位+翻唱，成功后 putPlan/putClip 各一次', async () => {
  const f = fakes()
  const cache = fakeCache()
  const { queue, logs, cleanup } = makeQueue(f, { cache: cache.port })
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.equal(row?.stage, 'sent')
    assert.equal(f.calls.download, 1)
    assert.equal(f.calls.chorus, 1)
    assert.equal(f.calls.render, 1)
    assert.equal(cache.calls.putPlan, 1, '做完之后要记住"这首歌切的是哪一段"')
    assert.equal(cache.calls.putClip, 1, '做完之后要把成品收进缓存')
    assert.ok(logs.some((line) => line.includes('缓存未命中，照常做')),
      `未命中要说清楚为什么这次不快：\n${logs.join('\n')}`)
  } finally { cleanup() }
})

test('未命中：方案缓存的置信度低于当前门槛 → 当作没有缓存（门槛不是摆设）', async () => {
  const f = fakes()
  const cache = fakeCache()
  cache.plans.set(planCacheKey(BVID, CID, 0, 59), { chorusStart: 84, seconds: 59, confidence: 0.4 })
  const { queue, logs, cleanup } = makeQueue(f, { cache: cache.port })
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.equal(row?.stage, 'sent')
    assert.equal(f.calls.chorus, 1, '置信度 0.4 < 门槛 0.55：必须重做一次定位')
    assert.equal(f.calls.render, 1)
    assert.ok(logs.some((line) => line.includes('低于当前门槛')), `要说清为什么不用旧方案：\n${logs.join('\n')}`)
  } finally { cleanup() }
})

// ── 4. 关掉或没注入：行为与现在逐字一致 ─────────────────────────────────────

test('cacheEnabled=false：照常四步，一次缓存读写都不做', async () => {
  const f = fakes()
  const cache = fakeCache()
  const { queue, logs, cleanup } = makeQueue(f, { cache: cache.port, config: { cacheEnabled: false } })
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.equal(row?.stage, 'sent')
    assert.equal(f.calls.download, 1)
    assert.equal(f.calls.chorus, 1)
    assert.equal(f.calls.render, 1)
    assert.equal(cache.calls.getPlan + cache.calls.getClip, 0, '关掉之后一次都不许查缓存')
    assert.equal(cache.calls.putPlan + cache.calls.putClip, 0, '关掉之后一次都不许写缓存')
    assert.equal(logs.some((line) => line.includes('缓存')), false, `关掉之后日志里不该提缓存：\n${logs.join('\n')}`)
  } finally { cleanup() }
})

test('没注入 cache：行为与加缓存之前逐字一致（四步各一次）', async () => {
  const f = fakes()
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.equal(row?.stage, 'sent')
    assert.equal(f.calls.videoInfo, 1)
    assert.equal(f.calls.download, 1)
    assert.equal(f.calls.chorus, 1)
    assert.equal(f.calls.render, 1)
    assert.equal(f.calls.send, 1)
  } finally { cleanup() }
})

// ── 5. 缩短重试也要进缓存 ──────────────────────────────────────────────────

test('网关嫌长：每一档缩短都落一条成品缓存（键里的 seconds 各不相同）', async () => {
  const f = fakes({
    sendOutcome: (n) => n <= 4
      ? { ok: false, messageId: null, unknown: false, detail: '发送失败：语音太长（record 超过上限）' }
      : { ok: true, messageId: 999, unknown: false, detail: '' },
  })
  const cache = fakeCache()
  const { queue, cleanup } = makeQueue(f, { cache: cache.port })
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.equal(row?.stage, 'sent', `第 5 次发送应当成功，实际 ${String(row?.stage)}`)
    assert.deepEqual(f.renderedSeconds, [59, 45, 30, 20, 15], '阶梯一档一档走，副歌起点不变')
    assert.equal(cache.calls.putClip, 5, '原本那条 + 四次缩短各落一次')
    const expected = clipCacheKey(BVID, CID, 0, 84, 15)
    assert.ok(cache.clips.has(expected), `15 s 那条要落在自己的键下（${expected}）`)
    assert.notEqual(clipCacheKey(BVID, CID, 0, 84, 15), clipCacheKey(BVID, CID, 0, 84, 59))
  } finally { cleanup() }
})

test('命中 + 网关嫌长：按需补下载音轨再重做（缓存不能让缩短重试做不成）', async () => {
  const f = fakes({
    sendOutcome: (n) => n === 1
      ? { ok: false, messageId: null, unknown: false, detail: '发送失败：语音太长' }
      : { ok: true, messageId: 905, unknown: false, detail: '' },
  })
  const cache = fakeCache()
  cache.plans.set(planCacheKey(BVID, CID, 0, 59), { chorusStart: 84, seconds: 59, confidence: 0.87 })
  cache.clips.set(clipCacheKey(BVID, CID, 0, 84, 59), path.join(tmpdir(), 'cached-voice.mp3'))
  const { queue, cleanup } = makeQueue(f, { cache: cache.port })
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.equal(row?.stage, 'sent')
    assert.equal(f.calls.chorus, 0, '方案命中：定位仍然不跑')
    assert.equal(f.calls.download, 1, '只有缩短要重做时才补下载音轨')
    assert.equal(f.calls.render, 1, '重做一次，起点仍是 84')
    assert.deepEqual(f.renderedSeconds, [45])
    assert.equal(cache.calls.putClip, 1, '重做出来的那条也进缓存')
    assert.ok(cache.clips.has(clipCacheKey(BVID, CID, 0, 84, 45)), '45 s 的是另一个键')
  } finally { cleanup() }
})
