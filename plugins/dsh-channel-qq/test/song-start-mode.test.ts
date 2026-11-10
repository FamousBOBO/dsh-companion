/** 起头模式（`from` / `chorusSeconds` / 默认）与 3 分钟上限：**判据**都在这一个文件里。
 *
 * 为什么单独一个文件：这次改动的核心不是"多了一个参数"，而是**优先级**——
 * 用户报的秒数 > `from` > 默认副歌。优先级错了的后果不是报错，而是**发出去一段
 * 用户没要的音频**（"从头开始"变成"从副歌开始"，或者反过来），那种错只有听完才知道。
 *
 * 三层各钉一条：
 *   1. 纯函数（`args.ts::startModeOf` / `startTextOf`）：优先级与回执措辞；
 *   2. 工具面（`qq_song_cover` 的 parameters 与入队形状）：模型看到的枚举、入队时的 `startMode`；
 *   3. 默认值（`SONG_DEFAULTS`）：上限 180 秒、翻唱超时 8 分钟，以及后台字段的上下限。
 *
 * 全程离线：队列是假件，不联网、不起进程。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Clock } from '../src/ports/clock.js'
import type { SongConfig } from '../src/config/sections/song.js'
import type { BiliPort, SongCandidate, SongRequest, SongTaskStatus } from '../src/features/song/types.js'
import type { SongService } from '../src/features/song/queue.js'

const { startModeOf, startTextOf, secondsArg } = await import('../src/features/song/args.js')
const { SONG_DEFAULTS, SONG_GROUPS } = await import('../src/config/sections/song.js')
const { songTools } = await import('../src/features/song/tools.js')

const USER = 1000000002
const MASTER = 1000000001

function fakeClock(): Clock {
  const at = Date.parse('2026-11-10T04:00:00Z')
  return {
    now: () => at,
    date: () => new Date(at),
    setTimeout: () => ({ cancel: () => {} }),
    setInterval: () => ({ cancel: () => {} }),
  }
}

function configOf(overrides: Partial<SongConfig> = {}): () => SongConfig {
  const base: SongConfig = {
    enabled: true, autoPick: false, groupEnabled: true, dryRun: false, allowExternalSend: true,
    seconds: 180, minConfidence: 0.55, preferFemale: false, maleKeyUp: 12, prefixSeconds: 12,
    pythonPath: '', rvcRoot: '', makeCover: '', chorusPython: '',
    biliCredentialFile: '', workRoot: '', ffmpegPath: 'ffmpeg',
    downloadTimeoutMs: 60_000, chorusTimeoutMs: 30_000, coverTimeoutMs: 480_000,
    sendTimeoutMs: 30_000, maxQueue: 8, cacheEnabled: true, cacheMaxEntries: 50,
    dailyAutoCap: 1, dailyUserCap: 2, autoSongs: [],
    ...overrides,
  }
  return () => base
}

/** 假队列面：只记"入队时收到了什么"。 */
function fakeService() {
  const enqueued: SongRequest[] = []
  const service: SongService = {
    async enqueue(req) { enqueued.push(req); return { accepted: true, taskId: req.id, note: '收到' } },
    status: (): SongTaskStatus[] => [],
    async cancel() { return false },
    async autoQuotaLeft() { return 0 },
    async autoUsedToday() { return 0 },
    async noteAutoSent() {},
    async load() {},
    async autoPickOnce() { return false },
  }
  return { service, enqueued }
}

/** 工具面所需的最小依赖（B站只回一条高置信度的《晴天》）。 */
function toolDeps(queue: SongService, overrides: Partial<SongConfig> = {}) {
  const clock = fakeClock()
  const bili: BiliPort = {
    async search(): Promise<readonly SongCandidate[]> {
      return [{ bvid: 'BV1d4411N7zD', title: '《晴天》 周杰伦', author: 'zyl', duration: 317, play: 1, description: '' }]
    },
    async videoInfo(bvid: string) {
      return { bvid, title: '《晴天》 周杰伦', author: 'zyl', duration: 317, pages: [{ cid: 1, part: '晴天', duration: 317 }] }
    },
    async downloadAudio(_bvid: string, _cid: number, dest: string) { return { file: dest, bytes: 1 } },
  }
  return {
    queue, bili, config: configOf(overrides), clock,
    log: (_line: string) => {}, ownerId: MASTER,
  }
}

function coverSpec(deps: ReturnType<typeof toolDeps>) {
  const spec = songTools(deps).find((item) => item.name === 'qq_song_cover')
  assert.ok(spec !== undefined, '工具面里没有 qq_song_cover')
  return spec
}

// ── 1. 优先级：chorusSeconds > from > 默认 ──────────────────────────────────

test("from 的默认值：不传（或传了认不得的值）一律 chorus——没要求就从副歌开始", () => {
  assert.equal(startModeOf(undefined, null), 'chorus')
  assert.equal(startModeOf(null, null), 'chorus')
  assert.equal(startModeOf('', null), 'chorus')
  assert.equal(startModeOf('chorus', null), 'chorus')
  // 拼错/别的写法不猜：退回默认值，而不是"不是 chorus 就当我没说"之外的第三种行为。
  assert.equal(startModeOf('beginning', null), 'chorus')
  assert.equal(startModeOf(42, null), 'chorus')
})

test("from='start' 就是从头；但用户报的秒数（chorusSeconds）优先于它", () => {
  assert.equal(startModeOf('start', null), 'start')
  // 给了秒数：他从那一秒开始唱，与 from 无关——秒数是最具体的意图。
  assert.equal(startModeOf('start', 120), 'chorus')
  assert.equal(startModeOf('chorus', 120), 'chorus')
  // `chorusSeconds: 0` 也算"给了"（0 是合法起点，不是"没给"）。
  assert.equal(startModeOf('start', 0), 'chorus')
})

test('回执措辞：三种起点各说一句话（用户给的秒数必须念出来）', () => {
  assert.equal(startTextOf('chorus', null), '从副歌开始')
  assert.equal(startTextOf('start', null), '从头开始')
  assert.equal(startTextOf('chorus', 120), '从你给的 120 秒开始')
  // 秒数的解析规则：空串与负数都当没给，0 是合法值。
  assert.equal(secondsArg(''), null)
  assert.equal(secondsArg(-1), null)
  assert.equal(secondsArg('abc'), null)
  assert.equal(secondsArg(0), 0)
  assert.equal(secondsArg('47.5'), 47.5)
})

// ── 2. 工具面：参数契约与入队形状 ───────────────────────────────────────────

test('qq_song_cover 的 parameters 里有 `from`：只认 chorus/start，说明写清"没说就用 chorus"', () => {
  const { service } = fakeService()
  const spec = coverSpec(toolDeps(service))
  const params = spec.parameters as {
    properties?: Record<string, { type?: string; enum?: readonly string[]; description?: string }>
  }
  const from = params.properties?.['from']
  assert.ok(from !== undefined, 'parameters 里必须有 from')
  assert.equal(from.type, 'string')
  assert.deepEqual([...(from.enum ?? [])], ['chorus', 'start'])
  const description = from.description ?? ''
  assert.ok(description.includes('默认'), `要说清默认值：${description}`)
  assert.ok(description.includes('副歌'), `要说清 chorus 是什么意思：${description}`)
  assert.ok(description.includes('从头'), `要说清 start 是什么意思：${description}`)
  // 工具描述里也要有"用户说从头 → start；说高潮 → chorus；没说 → chorus"这条判据。
  const toolDescription = spec.description ?? ''
  for (const hint of ['从头', '高潮', 'chorusSeconds']) {
    assert.ok(toolDescription.includes(hint), `工具描述要提到「${hint}」：${toolDescription}`)
  }
})

test("工具面：from='start' 入队时 startMode=start 且不给副歌时间", async () => {
  const { service, enqueued } = fakeService()
  const spec = coverSpec(toolDeps(service))
  const result = await spec.run(
    { song: '晴天', artist: '周杰伦', messageId: 'm-1', requesterId: USER, from: 'start' },
    { agentId: 'qq-dm-7654321' },
  ) as { accepted: boolean; note: string }

  assert.equal(result.accepted, true)
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0]?.startMode, 'start')
  assert.equal(enqueued[0]?.chorusAt, null, '从头开始没有"第几秒"')
  assert.match(result.note, /最多 180 秒/, `回执要报上限：${result.note}`)
  assert.match(result.note, /从头开始/, `回执要说清这次从头开始：${result.note}`)
  assert.match(result.note, /收在一句歌词结束处/, `回执要说清收尾方式：${result.note}`)
})

test('工具面：没说 from（默认副歌）与给了 chorusSeconds 的两种入队形状', async () => {
  const { service, enqueued } = fakeService()
  const deps = toolDeps(service)
  const spec = coverSpec(deps)

  await spec.run({ song: '晴天', artist: '周杰伦', messageId: 'm-2', requesterId: USER }, { agentId: 'qq-dm-7654321' })
  assert.equal(enqueued[0]?.startMode, 'chorus', '没要求 = 副歌')
  assert.equal(enqueued[0]?.chorusAt, null)

  const result = await spec.run(
    // 模型同时塞了两个参数：秒数优先（工具面必须自己收敛，不能把矛盾留给流水线）。
    { song: '晴天', artist: '周杰伦', messageId: 'm-3', requesterId: USER, from: 'start', chorusSeconds: 120 },
    { agentId: 'qq-dm-7654321' },
  ) as { note: string }
  assert.equal(enqueued[1]?.startMode, 'chorus', 'chorusSeconds 优先于 from')
  assert.equal(enqueued[1]?.chorusAt, 120)
  assert.match(result.note, /从你给的 120 秒开始/, `回执要念出用户给的秒数：${result.note}`)
})

// ── 3. 默认值与后台字段：3 分钟 ─────────────────────────────────────────────

test('默认值：上限 180 秒、翻唱超时 8 分钟（3 分钟语音条的余量）', () => {
  assert.equal(SONG_DEFAULTS.seconds, 180, '操作员要的"最长 3 分钟"')
  assert.equal(SONG_DEFAULTS.coverTimeoutMs, 480_000, '180 秒片段的分离 + 推理要留足时间')
})

test('后台字段：长度上限的范围是 10–180，help 说清"最后一个句尾"与两种起点', () => {
  const group = SONG_GROUPS.find((item) => item.id === 'song')
  assert.ok(group !== undefined)
  const seconds = group.fields['seconds']
  assert.ok(seconds !== undefined, '点歌段里没有 seconds 字段')
  assert.equal(seconds.min, 10)
  assert.equal(seconds.max, 180)
  const help = seconds.help ?? ''
  assert.ok(help.includes('3 分钟'), `help 要说清上限是 3 分钟：${help}`)
  assert.ok(help.includes('句尾'), `help 要说清实际长度取最后一个句尾：${help}`)
  assert.ok(help.includes('从头开始'), `help 要提到"从头开始"这种起头：${help}`)
})
