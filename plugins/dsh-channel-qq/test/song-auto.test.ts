/** 自主选歌：**每一条"不做"的理由都必须说得出**，因为它是最容易被误解成"坏了"的功能。
 *
 * 这个文件用假宿主（只有 `auto.ts` 真正用到的那几项）与假队列跑 `autoPickOnce`，
 * 断言六道前置条件各自返回 false 且日志里点明原因，以及真正受理时入队的形状
 * （`entry: 'auto'`、房间是主人私聊、去重键含日期）。
 *
 * 另外钉住"按日期轮换"：同一天永远是同一首（可复现），跨天才换。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QQChannelConfig } from '../src/config.js'
import type { SongConfig } from '../src/config/sections/song.js'
import type { Clock } from '../src/ports/clock.js'
import type { BiliPort, SongCandidate, SongRequest } from '../src/features/song/types.js'
import type { SongService } from '../src/features/song/queue.js'

const { autoPickOnce, registerSongResource, runtimes, splitPoolEntry } =
  await import('../src/features/song/auto.js')
const { rotationIndex } = await import('../src/features/song/day.js')

/** 一份可调的配置（默认：开着、自主选歌开着、曲目一首、每天 1 首）。 */
function configOf(overrides: Partial<SongConfig> = {}): SongConfig {
  return {
    enabled: true, autoPick: true, groupEnabled: false, dryRun: false, allowExternalSend: true,
    seconds: 25, minConfidence: 0.55, preferFemale: true, maleKeyUp: 12, prefixSeconds: 12,
    pythonPath: '', rvcRoot: '', makeCover: '', chorusPython: '',
    biliCredentialFile: '', workRoot: '', ffmpegPath: 'ffmpeg',
    downloadTimeoutMs: 60_000, chorusTimeoutMs: 30_000, coverTimeoutMs: 240_000,
    sendTimeoutMs: 30_000, maxQueue: 8, cacheEnabled: true, cacheMaxEntries: 50, dailyAutoCap: 1, dailyUserCap: 2,
    autoSongs: ['晴天 周杰伦'],
    ...overrides,
  }
}

/** 假时钟（固定在上海时间 12:00，日键稳定）。 */
function fakeClock(atMs = Date.parse('2026-11-07T04:00:00Z')): Clock {
  return {
    now: () => atMs,
    date: () => new Date(atMs),
    setTimeout: () => ({ cancel: () => {} }),
    setInterval: () => ({ cancel: () => {} }),
  }
}

/** 一条候选（和 B站适配器的归一化结果同形）。 */
function candidate(bvid: string, title: string, author: string): SongCandidate {
  return { bvid, title, author, duration: 270, play: 100_000, description: '' }
}

/** 假 B站：搜索返回固定候选。 */
function fakeBili(found: readonly SongCandidate[] = [candidate('BV1d4411N7zD', '《晴天》 周杰伦', 'zyl2012')]): BiliPort {
  return {
    async search() { return found },
    async videoInfo(bvid: string) {
      return { bvid, title: '晴天', author: '周杰伦', duration: 270, pages: [{ cid: 1, part: '晴天', duration: 270 }] }
    },
    async downloadAudio() { return { file: '', bytes: 0 } },
  }
}

/** 假队列：只记 `enqueue` 与 `autoQuotaLeft`。 */
function fakeQueue(options: { quota?: number; accept?: boolean; note?: string; used?: number } = {}) {
  const enqueued: SongRequest[] = []
  const quotaCalls: string[] = []
  const service: SongService = {
    async autoQuotaLeft(day) { quotaCalls.push(day); return options.quota ?? 1 },
    async enqueue(request) {
      enqueued.push(request)
      return options.accept === false
        ? { accepted: false, taskId: null, note: options.note ?? '队列已满' }
        : { accepted: true, taskId: request.id, note: '收到啦' }
    },
    status() { return [] },
    async cancel() { return false },
    async noteAutoSent() {},
    async autoUsedToday() { return options.used ?? 0 },
    async load() {},
    async autoPickOnce() { return false },
  }
  return { service, enqueued, quotaCalls }
}

/** 假宿主：只有 `auto.ts` 真正读到的那几项（`admins` 来自全局配置，不在 `song` 段里）。 */
function fakeHost(
  song: SongConfig,
  options: {
    admins?: readonly number[]
    runtime?: boolean
    bili?: BiliPort
    queue?: ReturnType<typeof fakeQueue>
  } = {},
) {
  const logs: string[] = []
  const queue = options.queue ?? fakeQueue()
  // `auto.ts` 读的是 `host.config.song`（点歌段）与 `host.config.admins`（全局），两者都在这里给。
  const config: QQChannelConfig = {
    ...(song as unknown as QQChannelConfig),
    song,
    admins: [...(options.admins ?? [1429709395])],
  }
  const host = {
    config,
    dshHome: '/tmp/dsh-home',
    log: (line: string) => logs.push(line),
    get: () => undefined,
    need: () => undefined,
    provide: () => {},
    registerResource: () => {},
    resources: {},
    reloadSections: async () => [],
    bridge: {},
    cleanup: () => {},
  }
  if (options.runtime !== false) {
    runtimes.set(host as never, { queue: queue.service as never, bili: options.bili ?? fakeBili() })
  }
  return { host, logs, queue }
}

// ── 1. 六道前置条件：每一条都要说得出理由 ───────────────────────────────────

test('总开关关着：一次也不做', async () => {
  const { host } = fakeHost(configOf({ enabled: false }))
  assert.equal(await autoPickOnce(host as never, fakeClock()), false)
})

test('自主选歌关着：不做（而且不需要理由日志，开关本身是明确的）', async () => {
  const { host } = fakeHost(configOf({ autoPick: false }))
  assert.equal(await autoPickOnce(host as never, fakeClock()), false)
})

test('曲目为空 / 没有主人：两种"没填"各有各的一句话', async () => {
  const empty = fakeHost(configOf({ autoSongs: [] }))
  assert.equal(await autoPickOnce(empty.host as never, fakeClock()), false)
  assert.ok(empty.logs.some((line) => line.includes('曲目为空')), `要有"曲目为空"，实际 ${JSON.stringify(empty.logs)}`)

  const noAdmin = fakeHost(configOf({ autoSongs: ['晴天 周杰伦'] }), { admins: [] })
  assert.equal(await autoPickOnce(noAdmin.host as never, fakeClock()), false)
  assert.ok(noAdmin.logs.some((line) => line.includes('没有配主人')), `要有"没有配主人"，实际 ${JSON.stringify(noAdmin.logs)}`)
})

test('外部环境没配全（没有运行时）：说"未配置"，不猜也不发', async () => {
  const { host, logs, queue } = fakeHost(configOf(), { runtime: false })
  assert.equal(await autoPickOnce(host as never, fakeClock()), false)
  assert.ok(logs.some((line) => line.includes('外部环境未配置')), `要说清"未配置"，实际 ${JSON.stringify(logs)}`)
  assert.equal(queue.enqueued.length, 0)
})

test('日额度用完：当天一首都不发（"每天最多一首"的执行点）', async () => {
  const { host, logs, queue } = fakeHost(configOf(), { queue: fakeQueue({ quota: 0 }) })
  assert.equal(await autoPickOnce(host as never, fakeClock()), false)
  assert.ok(logs.some((line) => line.includes('额度已用完')), `要说清"额度已用完"，实际 ${JSON.stringify(logs)}`)
  assert.equal(queue.enqueued.length, 0)
})

// ── 2. 受理：入队形状必须对 ─────────────────────────────────────────────────

test('受理：auto 入口、主人私聊、含日期的去重键、不指定副歌时间', async () => {
  const queue = fakeQueue({ quota: 1 })
  const { host, logs } = fakeHost(configOf({ autoSongs: ['晴天 周杰伦'] }), { queue })
  const said: string[] = []
  const ok = await autoPickOnce(host as never, fakeClock(), (line) => said.push(line))
  assert.equal(ok, true, '条件都满足时应当受理')
  const request = queue.enqueued[0]
  assert.ok(request !== undefined)
  assert.equal(request.entry, 'auto', '自主入口必须标 auto（闸门按它多判一道）')
  assert.equal(request.room, 'dm-1429709395', '房间必须是主人的私聊')
  assert.equal(request.chatId, 1429709395)
  assert.equal(request.song, '晴天')
  assert.equal(request.artist, '周杰伦')
  assert.equal(request.bvid, 'BV1d4411N7zD')
  assert.equal(request.chorusAt, null, '自主选歌不指定副歌时间（要靠脚本自己找）')
  assert.ok(request.dedupeKey.startsWith('auto:'), `去重键要带 auto 前缀，实际「${request.dedupeKey}」`)
  assert.ok(request.dedupeKey.includes('2026-11-07'), '去重键要含当天日期（否则跨天会被当成重复）')
  assert.ok(said.some((line) => line.includes('自主选歌「晴天 / 周杰伦」')), `日志要说清挑了哪首，实际 ${JSON.stringify(said)}`)
  assert.equal(logs.length, 0, '注入了 log 时不该再写到 host.log（否则同一句话两遍）')
})

test('分不出唯一原唱：跳过这一轮，绝不猜（与私聊入口同一套判据）', async () => {
  const ambiguous = [
    candidate('BV1NU4y137PZ', '《起风了》 林俊杰', '音乐私藏馆'),
    candidate('BV1ft4y1G7so', '《起风了》 买辣椒也用券', '麻雀'),
  ]
  const queue = fakeQueue({ quota: 1 })
  const { host, logs } = fakeHost(configOf({ autoSongs: ['起风了'] }), { bili: fakeBili(ambiguous), queue })
  const ok = await autoPickOnce(host as never, fakeClock(), (line) => logs.push(line))
  assert.equal(ok, false)
  assert.ok(logs.some((line) => line.includes('分不出唯一原唱')), `要说清为什么跳过，实际 ${JSON.stringify(logs)}`)
  assert.equal(queue.enqueued.length, 0, '分不出来就不许入队')
})

test('队列拒绝了（例如满了）：返回 false，并把队列的原话透出来', async () => {
  const queue = fakeQueue({ quota: 1, accept: false, note: '前面还有 8 首在做' })
  const { host, logs } = fakeHost(configOf(), { queue })
  const ok = await autoPickOnce(host as never, fakeClock(), (line) => logs.push(line))
  assert.equal(ok, false)
  assert.ok(logs.some((line) => line.includes('前面还有 8 首在做')), `要带上队列的说法，实际 ${JSON.stringify(logs)}`)
})

test('B站异常（网络/风控）：不抛，收成一句日志 + false', async () => {
  const queue = fakeQueue({ quota: 1 })
  const bili: BiliPort = {
    async search() { throw new Error('B站搜索失败：HTTP 412（风控拦截）') },
    async videoInfo() { throw new Error('不该走到这里') },
    async downloadAudio() { throw new Error('不该走到这里') },
  }
  const { host, logs } = fakeHost(configOf(), { bili, queue })
  const ok = await autoPickOnce(host as never, fakeClock(), (line) => logs.push(line))
  assert.equal(ok, false, '搜不到不该把整拍打挂')
  assert.ok(logs.some((line) => line.includes('412')), `要把上游原因说出来，实际 ${JSON.stringify(logs)}`)
})

// ── 2b. 不限额（\`dailyAutoCap=0\`）：同一天能发第二首 ───────────────────────

test('不限额：去重键按序号分开（否则第二首会被当成"已经发过"丢掉）', async () => {
  const { autoDedupeKey } = await import('../src/features/song/auto.js')
  assert.equal(autoDedupeKey('2026-11-07', 'dm-1', 0), 'auto:2026-11-07:dm-1', '第一首与旧键完全一致')
  assert.equal(autoDedupeKey('2026-11-07', 'dm-1', 1), 'auto:2026-11-07:dm-1:2')
  assert.equal(autoDedupeKey('2026-11-07', 'dm-1', 2), 'auto:2026-11-07:dm-1:3')
})

test('不限额：当天已发过一首时，第二首的任务 id 与去重键都不再与第一首相同', async () => {
  const queue = fakeQueue({ quota: 9999, used: 1 })
  const { host, logs } = fakeHost(configOf(), { queue })
  const said: string[] = []
  const ok = await autoPickOnce(host as never, fakeClock(), (line) => said.push(line))
  assert.equal(ok, true, '不限额时第二首仍应受理')
  const request = queue.enqueued[0]
  assert.ok(request !== undefined)
  assert.ok(request.dedupeKey.endsWith(':2'), '去重键要带序号，实际 ' + request.dedupeKey)
  assert.ok(request.id.endsWith('-2'), '任务 id 也要带序号，实际 ' + request.id)
  assert.equal(logs.length, 0)
  assert.ok(said.some((line) => line.includes('自主选歌入队')))
})

// ── 3. 轮换：同一天同一首，跨天才换 ────────────────────────────────────────

test('轮换叠加当天已发数：不限额时按顺序走一圈，不再整天循环同一首', async () => {
  const { poolEntryAt } = await import('../src/features/song/auto.js')
  const pool = ['A', 'B', 'C', 'D']
  const day = '2026-11-08'
  // 每天第一首仍由日期决定（可复现）
  const first = poolEntryAt(pool, day, 0)
  assert.equal(poolEntryAt(pool, day, 0), first)
  // 之后按顺序走，且一轮之内不重复
  const walk = [0, 1, 2, 3].map((used) => poolEntryAt(pool, day, used))
  assert.equal(new Set(walk).size, 4, '四首之内不该重复，实际 ' + JSON.stringify(walk))
  assert.equal(walk[0], first)
  // 走满一圈回到起点
  assert.equal(poolEntryAt(pool, day, 4), first)
  // 空池子 / 脏 used 不该崩
  assert.equal(poolEntryAt([], day, 0), '')
  assert.equal(poolEntryAt(pool, day, Number.NaN), first)
})

test('轮换：同一首曲目池同一天永远给同一首（可复现，不会重试时换歌）', () => {
  const size = 4
  const sameDay = ['2026-11-07', '2026-11-07', '2026-11-07'].map((day) => rotationIndex(day, size))
  assert.deepEqual(sameDay, [sameDay[0], sameDay[0], sameDay[0]])
  const days = ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'].map((day) => rotationIndex(day, size))
  assert.ok(new Set(days).size > 1, '四天不该全落在同一首')
})

test('曲目池的 `歌名 歌手` 拆法：第一个空格前是歌名，其余全是歌手', () => {
  assert.deepEqual(splitPoolEntry('晴天 周杰伦'), ['晴天', '周杰伦'])
  assert.deepEqual(splitPoolEntry(' 起风了 '), ['起风了', ''])
  assert.deepEqual(splitPoolEntry('The Sound of Silence Simon Garfunkel'), ['The', 'Sound of Silence Simon Garfunkel'])
  assert.deepEqual(splitPoolEntry(''), ['', ''])
})

// ── 4. 后台资源：只读，且如实标出"没发" ────────────────────────────────────

test('后台「音乐」页：出厂默认三个外发开关都在"关"那一侧', async () => {
  const registered: Array<{ key: string; label: string; list: () => Promise<unknown> }> = []
  const host = {
    registerResource: (key: string, resource: { label: string; list: () => Promise<unknown> }) => {
      registered.push({ key, label: resource.label, list: resource.list })
    },
  }
  const queue = fakeQueue()
  registerSongResource(
    host as never,
    queue.service as never,
    () => configOf({
      enabled: false, autoPick: false, dryRun: true, allowExternalSend: false,
      autoSongs: ['晴天 周杰伦'],
    }),
    '/tmp/dsh-home',
  )
  assert.equal(registered.length, 1)
  assert.equal(registered[0]?.key, 'song')
  assert.equal(registered[0]?.label, '点歌翻唱')
  const listed = await registered[0]?.list() as Record<string, unknown>
  assert.equal(listed.enabled, false)
  assert.equal(listed.autoPick, false)
  assert.equal(listed.dryRun, true, '演练模式默认开：链路跑通但不真发')
  assert.equal(listed.allowExternalSend, false)
  assert.equal(listed.seconds, 25)
  assert.deepEqual(listed.autoSongs, ['晴天 周杰伦'])
  assert.ok(String(listed.workRoot).includes('channel-qq'), '工作目录要落在插件自己的数据目录里')
})
