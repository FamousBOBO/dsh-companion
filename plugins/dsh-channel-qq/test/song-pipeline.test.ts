/** 点歌的**串行队列 + 流水线**：README 里那些"必须真的成立"的行为都在这里钉住。
 *
 * 这个文件用**假端口**（B站 / 副歌 / 翻唱 / 发送 / 门控）跑完整条真实流水线代码，
 * 所以它断言的是 `runTask` 与 `SongQueue` 的行为，不是某个适配器的内部实现
 * （适配器的细节在 `song-bili` / `song-cover` / `song-voice` 各自的测试里）。
 *
 * 逐条对应验收清单：
 *   1. 正常一首歌：四步走完、发一次、账本记 `sent`、任务目录被清掉；
 *   2. 同一件事（同一入站消息）再来一次：**一条也不多发**（去重命中）；
 *   3. 回执未知：记 `unknown-send`，**绝不重发**（这条是"只收到一条语音条"的核心）；
 *   4. 网关嫌长：**保持同一个副歌起点**缩短重做，然后只发一条；
 *   5. 副歌定位不可靠 / 置信度不够：不发语音条，失败停在 `chorus`；
 *   6. 闸门（演练 / 拒绝）：音做好了但不发；
 *   7. 下载 / 翻唱失败：停在对应阶段并说清原因；
 *   8. 队列上限：满了一个都不排；
 *   9/10. 日额度与终态通知；
 *   11. 总开关关掉、用户取消。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { Clock } from '../src/ports/clock.js'
import type { SongConfig } from '../src/config/sections/song.js'
import type {
  BiliPort, ChorusPort, ChorusPick, CoverPort, CoverResult, SendGatePort,
  SongCandidate, SongRequest, VoicePort, VoiceSendResult,
} from '../src/features/song/types.js'
import type { SongFinished } from '../src/features/song/queue.js'

const { SongQueue, taskIdOf } = await import('../src/features/song/queue.js')
const { looksLikeLengthRejection } = await import('../src/features/song/pipeline.js')
const { finishText } = await import('../src/features/song/index.js')

/** 假时钟：`now()` 只读；队列的记账只看它，不需要推进。 */
function fakeClock(start = 1_700_000_000_000): Clock & { advance(ms: number): void } {
  let now = start
  return {
    now: () => now,
    date: () => new Date(now),
    setTimeout: () => ({ cancel: () => {} }),
    setInterval: () => ({ cancel: () => {} }),
    advance: (ms: number) => { now += ms },
  }
}

/** 一次点歌请求（默认值是主人在私聊里点了《晴天》）。 */
function request(overrides: Partial<SongRequest> = {}): SongRequest {
  return {
    id: taskIdOf('msg:42'),
    entry: 'dm',
    room: 'dm-1429709395',
    chatId: 1429709395,
    dedupeKey: 'msg:42',
    song: '晴天',
    artist: '周杰伦',
    bvid: 'BV1d4411N7zD',
    chorusAt: null,
    keyUp: 0,
    requestedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** 假世界的开关。 */
interface FakeOptions {
  readonly downloadFails?: boolean
  readonly chorusReliable?: boolean
  readonly chorusLowConfidence?: boolean
  readonly renderFails?: boolean
  /** 第 n 次发送的结果（默认成功，messageId = 900 + n）。 */
  readonly sendOutcome?: (attempt: number) => VoiceSendResult
  readonly verdict?: { verdict: 'allowed' | 'dry-run' | 'denied'; reason: string }
}

/** 假世界：`calls` 记每个端口被调几次——"只发一次"这类断言靠它，不靠日志。 */
interface Fakes {
  readonly bili: BiliPort
  readonly chorus: ChorusPort
  readonly cover: CoverPort
  readonly voice: VoicePort
  readonly gate: SendGatePort
  readonly clock: ReturnType<typeof fakeClock>
  readonly calls: { search: number; videoInfo: number; download: number; chorus: number; render: number; send: number; gate: number }
  readonly renderedSeconds: number[]
}

function fakes(options: FakeOptions = {}): Fakes {
  const calls = { search: 0, videoInfo: 0, download: 0, chorus: 0, render: 0, send: 0, gate: 0 }
  const renderedSeconds: number[] = []

  const bili: BiliPort = {
    async search(): Promise<readonly SongCandidate[]> { calls.search += 1; return [] },
    async videoInfo(bvid: string) {
      calls.videoInfo += 1
      return {
        bvid, title: '晴天', author: '周杰伦', duration: 317,
        pages: [{ cid: 317843818, part: '晴天', duration: 317 }],
      }
    },
    async downloadAudio(_bvid: string, _cid: number, dest: string) {
      calls.download += 1
      if (options.downloadFails === true) throw new Error('B站音轨下载失败：HTTP 403')
      return { file: dest, bytes: 6_700_000 }
    },
  }

  const chorus: ChorusPort = {
    async locate(): Promise<ChorusPick | null> {
      calls.chorus += 1
      if (options.chorusReliable === false) return null
      if (options.chorusLowConfidence === true) {
        return { startSeconds: 40, endSeconds: 60, confidence: 0.4, method: 'x', repeats: 1, vocalRatio: 0.3 }
      }
      return { startSeconds: 84, endSeconds: 109, confidence: 0.87, method: 'repeat+energy', repeats: 2, vocalRatio: 0.7 }
    },
  }

  const cover: CoverPort = {
    async render(input): Promise<CoverResult> {
      calls.render += 1
      renderedSeconds.push(input.seconds)
      if (options.renderFails === true) throw new Error('翻唱没做成：分离器退出码 1')
      // 产物不必真存在：发送是假的，没人去读这个文件。
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
      return options.verdict ?? { verdict: 'allowed', reason: 'ok' }
    },
  }

  return { bili, chorus, cover, voice, gate, clock: fakeClock(), calls, renderedSeconds }
}

/** 一份可调的配置（默认是"开着、允许外发、25 秒、每日 1 首"）。 */
function configOf(overrides: Partial<SongConfig> = {}): () => SongConfig {
  const base: SongConfig = {
    enabled: true, autoPick: true, dryRun: false, allowExternalSend: true,
    seconds: 25, minConfidence: 0.55, preferFemale: true, maleKeyUp: 12, prefixSeconds: 12,
    pythonPath: '', rvcRoot: '', makeCover: '', chorusPython: '',
    biliCredentialFile: '', workRoot: '', ffmpegPath: 'ffmpeg',
    downloadTimeoutMs: 60_000, chorusTimeoutMs: 30_000, coverTimeoutMs: 240_000,
    sendTimeoutMs: 30_000, maxQueue: 2, dailyAutoCap: 1, autoSongs: ['晴天 周杰伦'],
    ...overrides,
  }
  return () => base
}

/** 建一个跑在临时目录里的队列（账本也写临时目录，跑完删）。 */
function makeQueue(f: Fakes, extra: {
  readonly config?: Partial<SongConfig>
  readonly onFinish?: (event: SongFinished) => Promise<void> | void
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'song-queue-'))
  const logs: string[] = []
  const workRoot = path.join(dir, 'work')
  const queue = new SongQueue({
    bili: f.bili,
    chorus: f.chorus,
    cover: f.cover,
    voice: f.voice,
    gate: f.gate,
    clock: f.clock,
    config: configOf(extra.config),
    log: (line: string) => logs.push(line),
    workRoot,
    ledgerFile: path.join(dir, 'ledger.json'),
    ...(extra.onFinish === undefined ? {} : { onFinish: extra.onFinish }),
  })
  return { queue, logs, workRoot, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 等一个条件成立（轮询）。终态"写账本"与"通知"是两步，断言通知时要给它一点时间。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 等某条任务进终态（串行链跑完）。超时返回 null（让断言给出可读失败，而不是挂住）。 */
async function settle(
  queue: { status(limit?: number): readonly { id: string; stage: string }[] },
  id: string | null,
  timeoutMs = 3_000,
): Promise<{ id: string; stage: string; detail: string | null; messageId: number | null;
  chorusStart: number | null; seconds: number | null } | null> {
  if (id === null) return null
  const terminal = ['sent', 'dry-run', 'failed', 'unknown-send', 'cancelled']
  const started = Date.now()
  for (;;) {
    const row = queue.status(50).find((task) => task.id === id)
    if (row !== undefined && terminal.includes(row.stage)) {
      return row as unknown as { id: string; stage: string; detail: string | null; messageId: number | null;
        chorusStart: number | null; seconds: number | null }
    }
    if (Date.now() - started > timeoutMs) return null
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// ── 1. 正常一首歌 ────────────────────────────────────────────────────────────

test('正常一首歌：四步走完、发一次、账本记 sent、任务目录被清掉', async () => {
  const f = fakes()
  const { queue, cleanup, workRoot } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    assert.equal(result.accepted, true, '正常入队应当受理')
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null, '任务必须走到终态（否则串行队列卡住了）')
    assert.equal(row.stage, 'sent', `应当发出去，实际 ${row.stage}（${String(row.detail)}）`)
    assert.equal(f.calls.send, 1, '只许发一次语音条')
    assert.equal(f.calls.download, 1)
    assert.equal(f.calls.render, 1)
    assert.equal(row.messageId, 901, '回执消息 id 要记进账本')
    assert.equal(row.chorusStart, 84, '副歌起点要记进账本')
    assert.equal(existsSync(path.join(workRoot, result.taskId ?? '')), false, '任务目录必须在结束后被删掉')
  } finally { cleanup() }
})

// ── 2. 去重 ──────────────────────────────────────────────────────────────────

test('去重：同一条入站消息再来一次，一条也不多发', async () => {
  const f = fakes()
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const first = await queue.enqueue(request())
    await settle(queue, first.taskId)
    const second = await queue.enqueue(request())
    assert.equal(second.accepted, false, '同一条消息的第二次点歌不该再受理')
    assert.ok(second.note.includes('已经处理过'), `要说清是重复，实际「${second.note}」`)
    assert.equal(f.calls.send, 1, '重复触发绝不能产生第二条语音条')
  } finally { cleanup() }
})

test('去重：正在做的那条再来一次说"正在做"，不重复入队', async () => {
  const f = fakes()
  const gate = { release: null as (() => void) | null }
  f.cover.render = async (input) => {
    await new Promise<void>((resolve) => { gate.release = resolve })
    return { voiceFile: path.join(input.outDir, 'voice.mp3'), durationSeconds: input.seconds,
      chorusStart: input.chorusStart, seconds: input.seconds, keyUp: input.keyUp, summary: {} }
  }
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const first = await queue.enqueue(request())
    await new Promise((resolve) => setTimeout(resolve, 150))
    const second = await queue.enqueue(request())
    assert.equal(second.accepted, false)
    assert.ok(second.note.includes('正在'), `要说清"正在做"，实际「${second.note}」`)
    gate.release?.()
    await settle(queue, first.taskId)
  } finally { cleanup() }
})

// ── 3. 回执未知 ─────────────────────────────────────────────────────────────

test('回执未知：记 unknown-send，**绝不重发**', async () => {
  const f = fakes({ sendOutcome: () => ({ ok: false, messageId: null, unknown: true, detail: '回执未知：超过 30000ms 没收到发送结果' }) })
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(row.stage, 'unknown-send')
    assert.equal(f.calls.send, 1, '回执未知之后不许再 push 一次')
    assert.ok(String(row.detail).includes('回执未知'))
    const again = await queue.enqueue(request())
    assert.equal(again.accepted, false, '回执未知的那条也占住去重键')
    assert.equal(f.calls.send, 1)
  } finally { cleanup() }
})

// ── 4. 网关嫌长 → 缩短重做，起点不变 ───────────────────────────────────────

test('网关嫌长：按更短的秒数重做，副歌起点**不变**，最终还是只发一条', async () => {
  const f = fakes({
    sendOutcome: (n) => n === 1
      ? { ok: false, messageId: null, unknown: false, detail: '发送失败：语音太长（record 超过上限）' }
      : { ok: true, messageId: 902, unknown: false, detail: '' },
  })
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(row.stage, 'sent')
    assert.equal(f.calls.send, 2, '一次失败 + 一次成功')
    assert.equal(f.calls.render, 2, '缩短需要重做一次翻唱')
    assert.deepEqual(f.renderedSeconds, [25, 15], '第二次用的秒数必须更短')
    assert.equal(row.chorusStart, 84, '缩短之后副歌起点必须还是 84（同一段开头）')
    assert.equal(row.seconds, 15)
  } finally { cleanup() }
})

test('缩短判据：不像长度问题就**不重做**（"没连上 NapCat"不该白跑两分钟）', () => {
  assert.equal(looksLikeLengthRejection('发送失败：语音太长', 25), true)
  assert.equal(looksLikeLengthRejection('发送失败：连接已关闭', 25), false)
  assert.equal(looksLikeLengthRejection('发送失败：语音太长', 10), false, '已经最短了就不再缩')
})

// ── 5. 副歌定位 ─────────────────────────────────────────────────────────────

test('副歌定位不可靠：不发语音条，失败停在 chorus 并说清原因', async () => {
  const f = fakes({ chorusReliable: false })
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(row.stage, 'failed')
    assert.equal(f.calls.send, 0, '定位不可靠就不该发语音条')
    assert.ok(String(row.detail).includes('副歌'), `失败原因要说"副歌"，实际「${String(row.detail)}」`)
  } finally { cleanup() }
})

test('副歌定位：置信度低于门槛也按不可靠处理（不猜）', async () => {
  const f = fakes({ chorusLowConfidence: true })
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(row.stage, 'failed')
    assert.ok(String(row.detail).includes('置信度'), `要说清是置信度不够，实际「${String(row.detail)}」`)
    assert.equal(f.calls.send, 0)
  } finally { cleanup() }
})

test('用户给了副歌时间：跳过自动定位，直接用那个点', async () => {
  const f = fakes()
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request({ chorusAt: 120 }))
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(row.stage, 'sent')
    assert.equal(f.calls.chorus, 0, '给了时间就不该再跑定位脚本')
    assert.equal(row.chorusStart, 120)
  } finally { cleanup() }
})

// ── 6. 闸门 ─────────────────────────────────────────────────────────────────

test('演练模式：音做好但不发，记 dry-run', async () => {
  const f = fakes({ verdict: { verdict: 'dry-run', reason: 'dry-run' } })
  const { queue, cleanup } = makeQueue(f, { config: { dryRun: true } })
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(row.stage, 'dry-run')
    assert.equal(f.calls.send, 0, '演练模式一条也不许真发')
    assert.equal(f.calls.render, 1, '演练模式仍然真跑（否则验证不了链路）')
  } finally { cleanup() }
})

test('外发被拒：记 failed 并带上闸门的原因', async () => {
  const f = fakes({ verdict: { verdict: 'denied', reason: 'quiet-hours' } })
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request({ entry: 'auto' }))
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(row.stage, 'failed')
    assert.equal(f.calls.send, 0)
    assert.ok(String(row.detail).includes('quiet-hours'), `原因要透出来，实际「${String(row.detail)}」`)
  } finally { cleanup() }
})

// ── 7. 各阶段失败 ───────────────────────────────────────────────────────────

test('下载失败：停在 downloading，不发、不翻唱', async () => {
  const f = fakes({ downloadFails: true })
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(row.stage, 'failed')
    assert.equal(f.calls.render, 0)
    assert.equal(f.calls.send, 0)
    assert.ok(String(row.detail).includes('403'), `要说清是下载失败，实际「${String(row.detail)}」`)
  } finally { cleanup() }
})

test('翻唱失败：停在 covering，不发', async () => {
  const f = fakes({ renderFails: true })
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(row.stage, 'failed')
    assert.equal(f.calls.send, 0)
    assert.ok(String(row.detail).includes('退出码'), `要说清是翻唱那一步，实际「${String(row.detail)}」`)
  } finally { cleanup() }
})

test('没有 BV 号：停在 downloading，说清楚', async () => {
  const f = fakes()
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request({ bvid: null }))
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(row.stage, 'failed')
    assert.ok(String(row.detail).includes('BV'), `要说清缺 BV，实际「${String(row.detail)}」`)
  } finally { cleanup() }
})

// ── 8. 队列上限 ─────────────────────────────────────────────────────────────

test('队列上限：满了就拒，并且说清前面还有几首', async () => {
  const f = fakes()
  const waiting: Array<() => void> = []
  f.cover.render = async (input) => {
    await new Promise<void>((resolve) => { waiting.push(resolve) })
    return { voiceFile: path.join(input.outDir, 'voice.mp3'), durationSeconds: input.seconds,
      chorusStart: input.chorusStart, seconds: input.seconds, keyUp: input.keyUp, summary: {} }
  }
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const a = await queue.enqueue(request({ dedupeKey: 'msg:a', id: taskIdOf('msg:a') }))
    const b = await queue.enqueue(request({ dedupeKey: 'msg:b', id: taskIdOf('msg:b') }))
    assert.equal(a.accepted, true)
    assert.equal(b.accepted, true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const c = await queue.enqueue(request({ dedupeKey: 'msg:c', id: taskIdOf('msg:c') }))
    assert.equal(c.accepted, false, '两条在排队时第三条要被拒')
    assert.ok(c.note.includes('排队'), `要说清"排队"，实际「${c.note}」`)
    for (const release of waiting) release()
    await settle(queue, a.taskId)
    await settle(queue, b.taskId)
  } finally { cleanup() }
})

// ── 9. 日额度 ───────────────────────────────────────────────────────────────

test('日额度：自主入口记一次之后当天就不能再发', async () => {
  const f = fakes()
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const day = '2026-11-07'
    assert.equal(await queue.autoQuotaLeft(day), 1, '默认每日上限 1')
    await queue.noteAutoSent(day)
    assert.equal(await queue.autoQuotaLeft(day), 0, '记一次之后当天额度用完')
    assert.equal(await queue.autoQuotaLeft('2026-11-08'), 1, '第二天重新有额度')
  } finally { cleanup() }
})

// ── 10. 终态通知 ────────────────────────────────────────────────────────────

test('终态通知：私聊入口的失败要说清卡在哪一步；成功不说话', () => {
  assert.equal(finishText('sent', null), null, '成功时不额外说话（语音条本身就是回答）')
  assert.equal(finishText('dry-run', null), null, '演练也不在私聊里吵')
  const failed = finishText('failed', '没找准副歌（重复段落与人声都不够明显），不猜')
  assert.ok(String(failed).includes('没找准副歌'), `失败说明要带原因，实际「${String(failed)}」`)
  const unknown = finishText('unknown-send', '回执未知')
  assert.ok(String(unknown).includes('不会自动重发'), `回执未知要说明不会自动重发，实际「${String(unknown)}」`)
})

test('终态通知：队列会把终态交给 onFinish（含 bvid/副歌/秒数）', async () => {
  const f = fakes()
  const events: SongFinished[] = []
  const { queue, cleanup } = makeQueue(f, { onFinish: (event) => { events.push(event) } })
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    await settle(queue, result.taskId)
    // 终态先写账本、后通知（顺序是刻意的：记账是合同、通知是附加），所以这里要等通知落地。
    await waitFor(() => events.length > 0)
    assert.equal(events.length, 1, `每个终态只通知一次，实际 ${String(events.length)}`)
    const event = events[0]
    assert.ok(event !== undefined)
    assert.equal(event.stage, 'sent')
    assert.equal(event.bvid, 'BV1d4411N7zD')
    assert.equal(event.chorusStart, 84)
    assert.equal(event.seconds, 25)
  } finally { cleanup() }
})

// ── 11. 关掉的功能与取消 ────────────────────────────────────────────────────

test('总开关关着：一律不受理（一条也不排）', async () => {
  const f = fakes()
  const { queue, cleanup } = makeQueue(f, { config: { enabled: false } })
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    assert.equal(result.accepted, false)
    assert.ok(result.note.includes('没有启用'), `要说清"没启用"，实际「${result.note}」`)
    assert.equal(f.calls.videoInfo, 0)
  } finally { cleanup() }
})

test('取消排队中的任务：记 cancelled，一条也不发', async () => {
  const f = fakes()
  const waiting: Array<() => void> = []
  f.cover.render = async (input) => {
    await new Promise<void>((resolve) => { waiting.push(resolve) })
    return { voiceFile: path.join(input.outDir, 'voice.mp3'), durationSeconds: input.seconds,
      chorusStart: input.chorusStart, seconds: input.seconds, keyUp: input.keyUp, summary: {} }
  }
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request({ dedupeKey: 'msg:x', id: taskIdOf('msg:x') }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(await queue.cancel(result.taskId ?? '', '用户改主意了'), true)
    for (const release of waiting) release()
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(f.calls.send, 0, '取消之后绝不能再发')
  } finally { cleanup() }
})

// ── 12. B站限流的说法 ──────────────────────────────────────────────────────

test('限流/抖动：错误里补一句"过几分钟再点"，而不是让人去查网络', async () => {
  const { downloadHint } = await import('../src/features/song/pipeline.js')
  for (const code of ['HTTP 429', 'HTTP 502', 'HTTP 503', 'HTTP 504']) {
    const text = downloadHint(`B站音轨下载失败：${code}（30280 码率）`)
    assert.ok(text.includes('过几分钟再点'), `${code} 应当补一句可执行的下一步，实际「${text}」`)
  }
  // 403/404 是权限或文件没了：原样透传，不猜。
  const forbidden = downloadHint('B站音轨下载失败：HTTP 403（30280 码率）')
  assert.equal(/过几分钟/.test(forbidden), false)
  assert.ok(forbidden.includes('403'))
})

test('限流说法：下载阶段失败时账本里的 detail 带上那句提示', async () => {
  const f = fakes()
  f.bili.downloadAudio = async () => { throw new Error('B站音轨下载失败：HTTP 503（30280 码率）') }
  const { queue, cleanup } = makeQueue(f)
  try {
    await queue.load()
    const result = await queue.enqueue(request())
    const row = await settle(queue, result.taskId)
    assert.ok(row !== null)
    assert.equal(row.stage, 'failed')
    assert.ok(String(row.detail).includes('过几分钟再点'), `实际「${String(row.detail)}」`)
  } finally { cleanup() }
})
