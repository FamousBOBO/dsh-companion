/** 群聊点歌 + 每人每日额度：两件新行为都靠"房间"与"点歌人"两个事实，所以放一个文件里钉死。
 *
 * 逐条对应验收清单：
 *   1. `qq-group-<号>` 能解析成 `group-<号>`；群聊开关关着时群里被拒、私聊不受影响；
 *   2. 语音条按房间选 `sendGroupMessage` / `sendPrivateMessage`，各只发一次；
 *      房间键看不懂时**不崩**、按私聊发；
 *   3. 每人每日额度：第 3 首被拒、`unknown-send` 也算、跨日归零、`0` = 不限额、
 *      主人/管理员豁免、`auto` 行不计入、同一人的两条并发请求第二条被拒；
 *   4. 工具面：`requesterId` 的参数、私聊缺省取房间号、群里缺了要说清、状态里带它。
 *
 * 全程离线：假 B站 / 副歌 / 翻唱 / 发送 / 门控 + 临时账本目录，不联网、不起进程。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { Clock } from '../src/ports/clock.js'
import type { SongConfig } from '../src/config/sections/song.js'
import type { OutboundQueue } from '../src/outbound.js'
import type { OneBotMessage } from '../src/types.js'
import type { QQApi, SendResult } from '../src/ports/platform.js'
import type {
  BiliPort, ChorusPort, ChorusPick, CoverPort, CoverResult, SendGatePort,
  SongCandidate, SongRequest, SongTaskStatus, VoicePort, VoiceSendResult,
} from '../src/features/song/types.js'
import type { SongService } from '../src/features/song/queue.js'

const { roomOfContext, refuseReason, songTools } = await import('../src/features/song/tools.js')
const { SongQueue, taskIdOf } = await import('../src/features/song/queue.js')
const { createVoicePort } = await import('../src/adapters/song/voice.js')
const { songDayKey } = await import('../src/features/song/day.js')

const MASTER = 1429709395
const ADMIN = 10002
const USER = 20003

// ── 1. 房间解析与群聊开关 ───────────────────────────────────────────────────

test('房间解析：qq-group-123 → group-123，qq-dm-456 → dm-456，拆不出来才是 null', () => {
  assert.equal(roomOfContext('qq-group-123'), 'group-123')
  assert.equal(roomOfContext('qq-dm-456'), 'dm-456')
  assert.equal(roomOfContext('qq-不是房间'), null)
  assert.equal(roomOfContext('qq-'), null)
  assert.equal(roomOfContext('session-1'), null, '非 qq- 前缀不是我们的房间键')
  assert.equal(roomOfContext(undefined), null, '没有会话上下文时说"这里不能点"而不是崩')
})

test('群聊开关：groupEnabled=false 时群里被拒并说清哪个开关，私聊照旧', () => {
  const closed = { enabled: true, groupEnabled: false }
  const groupRefusal = refuseReason(closed, 'qq-group-123')
  assert.ok(groupRefusal !== null, '群聊关着就必须拒')
  assert.ok(groupRefusal.includes('群聊点歌没打开'), `要说清"没打开"，实际「${groupRefusal}」`)
  assert.ok(groupRefusal.includes('群聊里允许点歌'), `要指到具体的开关，实际「${groupRefusal}」`)
  assert.equal(refuseReason(closed, 'qq-dm-456'), null, '私聊不该受群聊开关影响')
  assert.equal(refuseReason({ enabled: true, groupEnabled: true }, 'qq-group-123'), null, '开关打开就放行')
  const off = refuseReason({ enabled: false, groupEnabled: true }, 'qq-dm-456')
  assert.ok(String(off).includes('没有启用'), `总开关关着时理由照旧，实际「${String(off)}」`)
  assert.ok(String(refuseReason({ enabled: false, groupEnabled: false }, 'qq-group-123')).includes('没有启用'),
    '总开关关着时先报总开关（群聊开关是第二层）')
})

// ── 2. 语音条按房间选发送接口 ───────────────────────────────────────────────

/** 假出站链：记录每次 `push`（"恰好一次"的唯一事实来源）。 */
function fakeOut() {
  const pushes: Array<() => Promise<unknown>> = []
  const out = {
    async push<T>(task: () => Promise<T>): Promise<T> {
      pushes.push(task)
      return await task()
    },
  }
  return { out: out as unknown as OutboundQueue, pushes }
}

/** 假 QQApi：私聊与群发各记一笔，其余方法用 Proxy 兜底（这里不该被调用到）。 */
function fakeApi(send: () => Promise<SendResult>) {
  const privateSent: number[] = []
  const groupSent: number[] = []
  const api = new Proxy({} as QQApi, {
    get(_target, prop): unknown {
      if (prop === 'sendPrivateMessage') {
        return async (userId: number): Promise<SendResult> => {
          privateSent.push(userId)
          return await send()
        }
      }
      if (prop === 'sendGroupMessage') {
        return async (groupId: number): Promise<SendResult> => {
          groupSent.push(groupId)
          return await send()
        }
      }
      throw new Error(`测试里的假 QQApi 不该调用 ${String(prop)}`)
    },
  })
  return { api, privateSent, groupSent }
}

/** 临时目录里的一份小语音条（`napcatFileArg` 会把它内联成 `base64://`）。 */
function scratch(): { dir: string; voice: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'song-group-voice-'))
  const voice = path.join(dir, 'voice.mp3')
  writeFileSync(voice, Buffer.alloc(64 * 1024, 3))
  return { dir, voice, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('语音条：群房间发到群里、私聊房间发到私聊，各恰好一次', async () => {
  const s = scratch()
  try {
    const { out, pushes } = fakeOut()
    const { api, privateSent, groupSent } = fakeApi(async () => ({ message_id: 7 }))
    const port = createVoicePort({ api, out, log: () => {}, timeoutMs: 50 })

    // 群号与 `chatId` 故意给得不一样：房间键是"发到哪"的唯一事实。
    const groupResult = await port.sendVoice('group-123456', 555, s.voice)
    assert.deepEqual(groupResult, { ok: true, messageId: 7, unknown: false, detail: '' })
    assert.deepEqual(groupSent, [123456], '群房间必须走 sendGroupMessage，群号取自房间键')
    assert.deepEqual(privateSent, [], '群房间不该发私聊')

    const dmResult = await port.sendVoice('dm-777', 777, s.voice)
    assert.equal(dmResult.ok, true)
    assert.deepEqual(privateSent, [777], '私聊房间必须走 sendPrivateMessage')
    assert.deepEqual(groupSent, [123456], '私聊那条不该多一次群发')
    assert.equal(pushes.length, 2, '两条语音条各只入队一次')
  } finally { s.cleanup() }
})

test('语音条：房间键看不懂时不崩，按私聊发调用方给的那个号', async () => {
  const s = scratch()
  try {
    const { out, pushes } = fakeOut()
    const { api, privateSent, groupSent } = fakeApi(async () => ({ message_id: 8 }))
    const port = createVoicePort({ api, out, log: () => {}, timeoutMs: 50 })

    const result = await port.sendVoice('天知道这是什么房间', 4242, s.voice)

    assert.equal(result.ok, true, '房间键不认识不该让语音条发不出去')
    assert.deepEqual(privateSent, [4242])
    assert.deepEqual(groupSent, [])
    assert.equal(pushes.length, 1)
  } finally { s.cleanup() }
})

// ── 3. 每人每日额度 ─────────────────────────────────────────────────────────

/** 假时钟：固定在上海时间 12:00，日键稳定。 */
function fakeClock(atMs = Date.parse('2026-11-08T04:00:00Z')): Clock {
  return {
    now: () => atMs,
    date: () => new Date(atMs),
    setTimeout: () => ({ cancel: () => {} }),
    setInterval: () => ({ cancel: () => {} }),
  }
}

/** 一份可调的配置（默认开着、允许外发、每人每天 2 首）。 */
function configOf(overrides: Partial<SongConfig> = {}): () => SongConfig {
  const base: SongConfig = {
    enabled: true, autoPick: false, groupEnabled: true, dryRun: false, allowExternalSend: true,
    seconds: 25, minConfidence: 0.55, preferFemale: false, maleKeyUp: 12, prefixSeconds: 12,
    pythonPath: '', rvcRoot: '', makeCover: '', chorusPython: '',
    biliCredentialFile: '', workRoot: '', ffmpegPath: 'ffmpeg',
    downloadTimeoutMs: 60_000, chorusTimeoutMs: 30_000, coverTimeoutMs: 240_000,
    sendTimeoutMs: 30_000, maxQueue: 8, cacheEnabled: true, cacheMaxEntries: 50, dailyAutoCap: 1, dailyUserCap: 2, autoSongs: [],
    ...overrides,
  }
  return () => base
}

/** 一条点歌请求（默认是群友 `USER` 在群里点的《晴天》）。 */
function request(clock: Clock, overrides: Partial<SongRequest> = {}): SongRequest {
  const dedupeKey = overrides.dedupeKey ?? `msg:${String(Math.random())}`
  return {
    id: taskIdOf(dedupeKey),
    entry: 'group',
    requesterId: USER,
    room: 'group-123456',
    chatId: 123456,
    dedupeKey,
    song: '晴天',
    artist: '周杰伦',
    bvid: 'BV1d4411N7zD',
    chorusAt: 0,
    startMode: 'chorus',
    keyUp: 0,
    requestedAt: clock.now(),
    ...overrides,
  }
}

/** 假世界：发送结果可调，其余端口都秒回成功。 */
function fakes(sendOutcome?: () => VoiceSendResult) {
  const bili: BiliPort = {
    async search(): Promise<readonly SongCandidate[]> { return [] },
    async videoInfo(bvid: string) {
      return { bvid, title: '晴天', author: '周杰伦', duration: 317, pages: [{ cid: 1, part: '晴天', duration: 317 }] }
    },
    async downloadAudio(_bvid: string, _cid: number, dest: string) { return { file: dest, bytes: 1 } },
  }
  const chorus: ChorusPort = {
    async locate(): Promise<ChorusPick | null> {
      return { startSeconds: 84, endSeconds: 109, confidence: 0.9, method: 'x', repeats: 2, vocalRatio: 0.7, phraseEnds: [] }
    },
    // 这些用例的请求都带 `chorusAt`（0），走的是"用户给了时间"那条路，用不到手动起点。
    async locateFrom(_audioFile, startSeconds): Promise<ChorusPick | null> {
      return {
        startSeconds, endSeconds: startSeconds + 25, confidence: 1.0,
        method: 'manual-start', repeats: 0, vocalRatio: 0.7, phraseEnds: [],
      }
    },
  }
  const cover: CoverPort = {
    async render(input): Promise<CoverResult> {
      return {
        voiceFile: path.join(input.outDir, 'voice.mp3'), durationSeconds: input.seconds,
        chorusStart: input.chorusStart, seconds: input.seconds, keyUp: input.keyUp, summary: {},
      }
    },
  }
  const voice: VoicePort = {
    async sendVoice(): Promise<VoiceSendResult> {
      return sendOutcome?.() ?? { ok: true, messageId: 901, unknown: false, detail: '' }
    },
  }
  const gate: SendGatePort = { async authorize() { return { verdict: 'allowed', reason: 'ok' } } }
  const clock = fakeClock()
  return { bili, chorus, cover, voice, gate, clock }
}

/** 建一个跑在临时目录里的队列（账本写临时目录，跑完删）。 */
function makeQueue(world: ReturnType<typeof fakes>, extra: {
  readonly config?: Partial<SongConfig>
  readonly ownerIds?: () => readonly number[]
  readonly ledger?: unknown
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'song-quota-'))
  const logs: string[] = []
  const ledgerFile = path.join(dir, 'ledger.json')
  if (extra.ledger !== undefined) writeFileSync(ledgerFile, JSON.stringify(extra.ledger), 'utf8')
  const queue = new SongQueue({
    bili: world.bili, chorus: world.chorus, cover: world.cover, voice: world.voice, gate: world.gate,
    clock: world.clock, config: configOf(extra.config), log: (line: string) => logs.push(line),
    workRoot: path.join(dir, 'work'), ledgerFile,
    ...(extra.ownerIds === undefined ? {} : { ownerIds: extra.ownerIds }),
  })
  return { queue, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 等某条任务进终态（串行链跑完）；超时抛，免得断言挂住。 */
async function settle(
  queue: { status(limit?: number): SongTaskStatus[] },
  id: string | null,
): Promise<SongTaskStatus> {
  if (id === null) throw new Error('没有 taskId')
  const terminal = ['sent', 'dry-run', 'failed', 'unknown-send', 'cancelled']
  const started = Date.now()
  for (;;) {
    const row = queue.status(50).find((task) => task.id === id)
    if (row !== undefined && terminal.includes(row.stage)) return row
    if (Date.now() - started > 3_000) throw new Error(`任务 ${id} 没走到终态`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('每人每日额度：同一人第 3 首被拒，理由能直接念给用户', async () => {
  const world = fakes()
  const { queue, cleanup } = makeQueue(world)
  try {
    await queue.load()
    const first = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:1' }))
    const second = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:2' }))
    assert.equal(first.accepted, true)
    assert.equal(second.accepted, true)
    await settle(queue, first.taskId)
    await settle(queue, second.taskId)

    const third = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:3' }))

    assert.equal(third.accepted, false, '每人每天 2 首，第 3 首必须当场拒')
    assert.equal(third.taskId, null)
    assert.match(third.note, /今天已经点过 2 首了/, `要能直接念：${third.note}`)
    assert.match(third.note, /每人每天 2 首/, '要说清上限是多少')
  } finally { cleanup() }
})

test('每人每日额度：unknown-send 也算占掉一格（回执未知的那条可能已经到了）', async () => {
  let sent = 0
  const world = fakes(() => {
    sent += 1
    return sent === 1
      ? { ok: false, messageId: null, unknown: true, detail: '回执未知：超过 30000ms 没收到发送结果' }
      : { ok: true, messageId: 900 + sent, unknown: false, detail: '' }
  })
  const { queue, cleanup } = makeQueue(world)
  try {
    await queue.load()
    const first = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:1' }))
    assert.equal((await settle(queue, first.taskId)).stage, 'unknown-send')
    const second = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:2' }))
    assert.equal((await settle(queue, second.taskId)).stage, 'sent')

    const third = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:3' }))
    assert.equal(third.accepted, false, 'unknown-send 也要占额度，否则同一个人能靠超时无限点')
  } finally { cleanup() }
})

test('每人每日额度：跨日归零（按 Asia/Shanghai 的自然日）', async () => {
  const world = fakes()
  const now = world.clock.now()
  const yesterday = now - 24 * 3_600_000
  assert.notEqual(songDayKey(yesterday), songDayKey(now), '前提：昨天与今天是两个日键')
  const oldRow = {
    id: 's-old', entry: 'group', room: 'group-123456', requesterId: USER, song: '晴天', artist: '',
    stage: 'sent', bvid: 'BV1d4411N7zD', chorusStart: 0, seconds: 25, keyUp: 0, detail: null,
    createdAt: yesterday, updatedAt: yesterday, messageId: 1,
  }
  const { queue, cleanup } = makeQueue(world, {
    config: { dailyUserCap: 1 },
    ledger: { version: 1, tasks: [oldRow], autoDay: '', autoCount: 0 },
  })
  try {
    await queue.load()
    const todays = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:today' }))
    assert.equal(todays.accepted, true, '昨天那首不该占今天的额度')
    await settle(queue, todays.taskId)
    const again = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:today-2' }))
    assert.equal(again.accepted, false, '今天的那一首占额度')
  } finally { cleanup() }
})

test('每人每日额度：0 = 不限额', async () => {
  const world = fakes()
  const { queue, cleanup } = makeQueue(world, { config: { dailyUserCap: 0 } })
  try {
    await queue.load()
    for (const key of ['msg:1', 'msg:2', 'msg:3', 'msg:4']) {
      const result = await queue.enqueue(request(world.clock, { dedupeKey: key }))
      assert.equal(result.accepted, true, `不限额时 ${key} 该受理（${result.note}）`)
      await settle(queue, result.taskId)
    }
  } finally { cleanup() }
})

test('每人每日额度：主人与管理员豁免，普通群友照限', async () => {
  const world = fakes()
  const { queue, cleanup } = makeQueue(world, {
    config: { dailyUserCap: 1 },
    ownerIds: () => [MASTER, ADMIN],
  })
  try {
    await queue.load()
    for (const who of [MASTER, ADMIN]) {
      for (const key of [`msg:${String(who)}:1`, `msg:${String(who)}:2`]) {
        const result = await queue.enqueue(request(world.clock, { dedupeKey: key, requesterId: who }))
        assert.equal(result.accepted, true, `${String(who)} 该豁免（${result.note}）`)
        await settle(queue, result.taskId)
      }
    }
    const userFirst = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:user:1' }))
    assert.equal(userFirst.accepted, true)
    await settle(queue, userFirst.taskId)
    const userSecond = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:user:2' }))
    assert.equal(userSecond.accepted, false, '不在 admins 里的人照限')
  } finally { cleanup() }
})

test('每人每日额度：不数 auto 的行（自主选歌走它自己的日上限）', async () => {
  const world = fakes()
  const { queue, cleanup } = makeQueue(world, { config: { dailyUserCap: 1 } })
  try {
    await queue.load()
    // 同样的 requesterId，但入口是 auto：它是机器人自己点给自己听的，不该占这个人的额度。
    const auto = await queue.enqueue(request(world.clock, { entry: 'auto', dedupeKey: 'auto:2026-11-08:group-123456' }))
    assert.equal(auto.accepted, true)
    await settle(queue, auto.taskId)

    const userFirst = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:user:1' }))
    assert.equal(userFirst.accepted, true, 'auto 那条不该吃掉人的额度')
    await settle(queue, userFirst.taskId)
    const userSecond = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:user:2' }))
    assert.equal(userSecond.accepted, false)
  } finally { cleanup() }
})

test('每人每日额度：同一人两条未到终态的请求，第二条当场被拒', async () => {
  const world = fakes()
  const release: Array<() => void> = []
  world.cover.render = async (input) => {
    await new Promise<void>((resolve) => { release.push(resolve) })
    return {
      voiceFile: path.join(input.outDir, 'voice.mp3'), durationSeconds: input.seconds,
      chorusStart: input.chorusStart, seconds: input.seconds, keyUp: input.keyUp, summary: {},
    }
  }
  const { queue, cleanup } = makeQueue(world, { config: { dailyUserCap: 1 } })
  try {
    await queue.load()
    const first = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:a' }))
    assert.equal(first.accepted, true)
    // 不等第一条跑完：它此刻是"排队中/在做"，第二条必须被同一条额度判据拦住。
    const second = await queue.enqueue(request(world.clock, { dedupeKey: 'msg:b' }))
    assert.equal(second.accepted, false, '两条并发不该都通过')
    assert.match(second.note, /今天已经点过 1 首了/)
    // 第一条此刻还卡在翻唱里（前面的下载/定位都是 await），放开它让串行链收尾。
    while (release.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    for (const resolve of release) resolve()
    await settle(queue, first.taskId)
  } finally { cleanup() }
})

// ── 4. 工具面：requesterId 从哪来、缺了怎么办 ───────────────────────────────

/** 假队列面：只记"入队时收到了什么"，并把状态表原样交回去。 */
function fakeService() {
  const enqueued: SongRequest[] = []
  const rows: SongTaskStatus[] = []
  const service: SongService = {
    async enqueue(req) { enqueued.push(req); return { accepted: true, taskId: req.id, note: '收到' } },
    status: (limit = 10) => rows.slice(0, limit),
    async cancel() { return false },
    async autoQuotaLeft() { return 0 },
    async autoUsedToday() { return 0 },
    async noteAutoSent() {},
    async load() {},
    async autoPickOnce() { return false },
  }
  return { service, enqueued, rows }
}

/** 工具面所需的最小依赖（B站只回一条高置信度的《晴天》）。 */
function toolDeps(queue: SongService) {
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
    queue, bili, config: configOf({ dailyUserCap: 2 }), clock,
    log: (_line: string) => {}, ownerId: MASTER,
  }
}

/** 取一个工具的 spec（按名字），测试里只用 `run`。 */
function specOf(deps: ReturnType<typeof toolDeps>, name: string) {
  const spec = songTools(deps).find((item) => item.name === name)
  assert.ok(spec !== undefined, `工具面里没有 ${name}`)
  return spec
}

test('qq_song_cover：群里必须用 requesterId，且入队时记下 entry=group 与房间号', async () => {
  const { service, enqueued } = fakeService()
  const deps = toolDeps(service)
  const spec = specOf(deps, 'qq_song_cover')

  const result = await spec.run(
    { song: '晴天', artist: '周杰伦', messageId: 'm-1', requesterId: USER },
    { agentId: 'qq-group-123456' },
  ) as { accepted: boolean }

  assert.equal(result.accepted, true)
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0]?.entry, 'group')
  assert.equal(enqueued[0]?.room, 'group-123456')
  assert.equal(enqueued[0]?.chatId, 123456, '群聊的 chatId 是群号（语音条发到群里）')
  assert.equal(enqueued[0]?.requesterId, USER, '额度要按点歌人算')
})

test('qq_song_cover：私聊一律用房间键里那个号，忽略模型报的号（强事实优先）', async () => {
  const { service, enqueued } = fakeService()
  const deps = toolDeps(service)
  const spec = specOf(deps, 'qq_song_cover')

  // 模型把号报成"主人"也没用：私聊房间键才是事实。这正是"骗主人不受限"那条路。
  const result = await spec.run(
    { song: '晴天', artist: '周杰伦', messageId: 'm-2', requesterId: 1429709395 },
    { agentId: 'qq-dm-7654321' },
  ) as { accepted: boolean }

  assert.equal(result.accepted, true)
  assert.equal(enqueued[0]?.entry, 'dm')
  assert.equal(enqueued[0]?.requesterId, 7654321, '私聊必须用房间键里的号，而不是入参')
})

test('qq_song_cover：群里没给 requesterId 就拒，并说清缺什么（不能默默变成不限额）', async () => {
  const { service, enqueued } = fakeService()
  const deps = toolDeps(service)
  const spec = specOf(deps, 'qq_song_cover')

  const result = await spec.run(
    { song: '晴天', artist: '周杰伦', messageId: 'm-3' },
    { agentId: 'qq-group-123456' },
  ) as { accepted: boolean; note: string }

  assert.equal(result.accepted, false)
  assert.match(result.note, /requesterId/, `要说清缺的是哪个参数：${result.note}`)
  assert.equal(enqueued.length, 0, '没点歌人就不该入队')
})

test('qq_song_status：每条带 requesterId（诊断"这是谁点的"）', async () => {
  const { service, rows } = fakeService()
  const clock = fakeClock()
  rows.push({
    id: 's-1', entry: 'group', room: 'group-123456', requesterId: USER, song: '晴天', artist: '周杰伦',
    stage: 'sent', bvid: 'BV1d4411N7zD', chorusStart: 84, seconds: 25, keyUp: 0, detail: null,
    createdAt: clock.now(), updatedAt: clock.now(), messageId: 901,
  })
  const spec = specOf(toolDeps(service), 'qq_song_status')

  const result = await spec.run({}) as { tasks: Array<{ requesterId: number | null; entry: string }> }

  assert.equal(result.tasks[0]?.requesterId, USER)
  assert.equal(result.tasks[0]?.entry, 'group')
})
