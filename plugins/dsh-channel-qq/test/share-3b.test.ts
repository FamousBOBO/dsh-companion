/** **P2.5-3B 前置**：contact 的分享入口（`ctx.provide` + `submitShare` 走统一闸门）。
 *
 * 五条测试对应任务书：
 *   1. `share.enabled=false`（生产）→ `share-disabled`、**零 sendTo、零 outbox 行**；
 *   2. `enabled=true`（仅测试）→ 建候选（`source:'share-intent'` / `evidenceSource:'p2-share'`）
 *      并让既有 worker 跑一拍；重复提交被既有 dedupe 吃掉；
 *   3. 免打扰命中 → 拒绝理由可解释（`quiet-hours`），且一条都不发；
 *   4. 内部抛错 → 对外 `{ok:false, code:'internal'}`，**不抛**；
 *   5. `publishServiceSafely` 三档回退（provide → set → 属性赋值）+ 全失败不抛。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { contactPlugin } from '../src/features/contact/index.js'
import { createSharePort, readShareEnabled } from '../src/features/contact/share-port.js'
import { publishServiceSafely, verifyPublished } from '../src/features/service-publish.js'
import {
  baseConfig, fakeSubHost, FakeOutboundQueue, FakePlatform, tempHome, type FakeSubHost,
} from './fakes/contact.js'


const OWNER = 1000000002

/** 挂一个真的 contact 子插件（假平台，不碰真 QQ），返回它的服务袋。 */
async function mountContact(options: { shareEnabled?: boolean; config?: Record<string, unknown> } = {}): Promise<{
  readonly rig: FakeSubHost
  readonly home: ReturnType<typeof tempHome>
  readonly platform: FakePlatform
  readonly close: () => Promise<void>
}> {
  const home = tempHome('qq-share-')
  if (options.shareEnabled === true) {
    // 只在**临时 home** 里打开开关（真 `home/` 一律不碰）。
    const dir = path.join(home.dir, 'home/companion')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'runtime.config.json'), JSON.stringify({ p2: { share: { enabled: true } } }), 'utf8')
  }
  const defaults = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const base = {
    ...defaults,
    // 候选只会在"联系功能开着"的时候真的被闸门评估；测试里显式打开它。
    contact: { ...defaults.contact, enabled: true },
    ...(options.config ?? {}),
  } as QQChannelConfig
  const rig = fakeSubHost('contact', base, home.dir)
  const platform = new FakePlatform()
  rig.with('platform', { api: platform.api, out: new FakeOutboundQueue() as never, platform, client: {} as never })
  // `apply` 返回卸载器（内含 worker.dispose）；不接住它，worker 的定时器会把进程吊住。
  const dispose = await contactPlugin.apply(rig.host)
  // worker 不 start 的话 `tick()` 空转，闸门根本不会被评估（`enabled=false` 同理）。
  //
  // **为什么这个 rig 不需要 `waitCandidatesSettled`（task-52 的逐个结论之一）**：
  // `start()` 里 `void worker.tick()` 掷出的首拍确实会和 `submitShare` 内部的 `worker.tick()`
  // 抢同一拍（`busy` 时后者被丢掉、排到收尾）。但这个文件**没有一条断言依赖"闸门已评估"**——
  // `submitShare` 的契约本来就只有"已入库"（`code: accepted/duplicate`），零外发靠
  // `platform.count() === 0` 与 `deliveries.length === 0` 证明，闸门结论则用**只读**的
  // `outboundBudget()` 单独问。所以这里加等待只会掩盖真实契约（详见 `logs/p2.5/rigs/REPORT.md`）。
  await contactPlugin.start?.(rig.host)
  return {
    rig,
    home,
    platform,
    close: async () => {
      // 先卸子插件（内含 worker.dispose），否则 worker 的定时器会把测试进程吊住。
      if (typeof dispose === 'function') await dispose()
      await new Promise((resolve) => setTimeout(resolve, 40))
      try { fs.rmSync(home.dir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
    },
  }
}

const shareOf = (rig: FakeSubHost) => {
  const port = rig.bag.contactShare
  assert.notEqual(port, undefined, 'contact 段必须 provide 出 contactShare')
  return port!
}

// ── 1. 生产开关（false）：零外发 ────────────────────────────────────────────

test('S1 share.enabled=false（生产）→ share-disabled，零 sendTo、零 outbox 行、零候选', async () => {
  const { rig, platform, close } = await mountContact({ shareEnabled: false })
  try {
    const result = await shareOf(rig).submitShareCandidate({ candidateId: 'shr_1', kind: 'note', title: '想给你看一段' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'share-disabled')
    assert.match(String(result.reason), /p2\.share\.enabled=false/)
    assert.equal(platform.count(), 0, '一条都不许发')
    const ledger = rig.bag.contact!.status()
    assert.deepEqual(ledger.candidates ?? [], [], '连候选都不该建（不外发就别占账本）')
  } finally {
    await close()
  }
})

// ── 2. 开关打开（仅测试）：走既有 propose + worker 闸门 ──────────────────────

test('S2 enabled=true（测试内）→ 候选进账本（share-intent / p2-share），重复提交被 dedupe 吃掉', async () => {
  const { rig, close } = await mountContact({ shareEnabled: true })
  try {
    const first = await shareOf(rig).submitShare({ candidateId: 'shr_2', kind: 'note', title: '今天读到一句话' })
    assert.equal(first.ok, true, `第一次提交应当被接受，实际 ${JSON.stringify(first)}`)
    const status = rig.bag.contact!.status()
    const candidate = (status.candidates ?? []).find((row) => row.source === 'share-intent')
    assert.notEqual(candidate, undefined, '候选必须进 contact 账本，且 source 用既有词表里的 share-intent')
    assert.equal(candidate!.reason, '今天读到一句话')
    // 同一条候选再提交一次：既有 dedupe 会吃掉（不是新开一条）。
    const again = await shareOf(rig).submitShare({ candidateId: 'shr_2', kind: 'note', title: '今天读到一句话' })
    assert.equal(again.ok, true)
    assert.equal(again.code, 'duplicate')
    const after = rig.bag.contact!.status()
    assert.equal((after.candidates ?? []).filter((row) => row.source === 'share-intent').length, 1, 'dedupe 之后仍然只有一条')
  } finally {
    await close()
  }
})

// ── 3. 免打扰命中：理由可解释、零外发 ───────────────────────────────────────

test('S3 免打扰命中 → 共享闸门拒绝且理由是 quiet-hours；这条候选一条都不发', async () => {
  const { rig, platform, close } = await mountContact({
    shareEnabled: true,
    // 免打扰覆盖"现在"所在的小时：闸门必须拦下，且理由要是 quiet-hours。
    config: { contact: { ...(baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig).contact, enabled: true, quietHours: quietAllDay() } },
  })
  try {
    const result = await shareOf(rig).submitShare({ candidateId: 'shr_3', kind: 'note', title: '夜里也想说一句' })
    // 候选本身可以进账本（她是真的想分享），但**发送必须被拦**。
    assert.equal(result.ok, true, '候选被接受与"现在不能发"是两件事')
    assert.equal(platform.count(), 0, '免打扰期间一条都不许发')
    const status = rig.bag.contact!.status()
    assert.equal(status.deliveries.length, 0, '连投递行都不该有')
    // 闸门本身（share 的 attempt 走的就是它）：免打扰命中时给 quiet-hours，不是笼统的"拒绝"。
    const budget = await rig.bag.contact!.outboundBudget({ room: `dm-${String(OWNER)}`, sender: 'share' })
    assert.equal(budget.allowed, false)
    assert.equal(budget.reason, 'quiet-hours')
  } finally {
    await close()
  }
})

// ── 4. 内部抛错：对外 internal，不抛 ───────────────────────────────────────

test('S4 内部抛错 → 对外 {ok:false, code:"internal"}，绝不把异常抛给调用方', async () => {
  const port = createSharePort({
    enabled: () => true,
    propose: async () => { throw new Error('ledger disk full') },
    attempt: async () => {},
    target: () => ({
      scope: { userId: OWNER, personaId: 'bot', worldId: '' },
      target: { channel: 'qq', room: `qq-dm-${String(OWNER)}`, isGroup: false, chatId: OWNER },
      authorization: { kind: 'standing', by: OWNER, at: 1, quote: null },
    }),
    now: () => 1,
    log: () => {},
  })
  const result = await port.submitShare({ candidateId: 'shr_4', title: '随便说一句' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'internal')
  assert.match(String(result.reason), /ledger disk full/)
  // 开关关闭时连 target 都不必算；没有目标时同样如实回答。
  const noTarget = createSharePort({
    enabled: () => true, propose: async () => { throw new Error('不该被调到') }, attempt: async () => {},
    target: () => null, now: () => 1, log: () => {},
  })
  assert.equal((await noTarget.submitShare({ title: 'x' })).code, 'no-target')
})

// ── 5. 三档回退发布 ────────────────────────────────────────────────────────

test('S5 publishServiceSafely：provide → set → 属性赋值，三档各记一行；全失败不抛', () => {
  const logs: string[] = []
  const log = (line: string): void => { logs.push(line) }

  const withProvide = {
    name: 'value',
    provided: [] as string[],
    set: () => { throw new Error('不该走 set') },
    provide(this: { provided: string[] }, key: string) { this.provided.push(key) },
  }
  assert.equal(publishServiceSafely(withProvide, 'companionContactShare', { submitShare: () => {} }, log), 'provide')
  assert.deepEqual(withProvide.provided, ['companionContactShare'])
  assert.ok(logs.some((line) => line.includes('ctx.provide')))

  logs.length = 0
  const withSet: Record<string, unknown> = { }
  withSet.set = (key: string, value: unknown) => { withSet[key] = value }
  assert.equal(publishServiceSafely(withSet, 'companionContact', { submitShare: () => {} }, log), 'set')
  assert.notEqual(withSet.companionContact, undefined, 'set 档要真的落上去')
  assert.ok(logs.some((line) => line.includes('ctx.set')))

  logs.length = 0
  const plain: Record<string, unknown> = {}
  assert.equal(publishServiceSafely(plain, 'companionContactShare', { submitShare: () => {} }, log), 'assign')
  assert.notEqual(plain.companionContactShare, undefined)
  assert.ok(logs.some((line) => line.includes('属性赋值')))

  logs.length = 0
  const hostile = new Proxy({}, {
    get: () => { throw new Error('nope') },
    set: () => { throw new Error('nope') },
  })
  assert.equal(publishServiceSafely(hostile, 'companionContactShare', {}, log), 'failed')
  assert.ok(logs.some((line) => line.includes('三档都失败')), logs.join('\n'))
  // ctx 完全缺失也不许抛。
  assert.equal(publishServiceSafely(null, 'x', {}, log), 'failed')
})

// ── 附：开关读取本身 ───────────────────────────────────────────────────────

test('S6 readShareEnabled：只认 `p2.share.enabled===true`；读不到/坏 JSON 一律 false', () => {
  assert.equal(readShareEnabled('/nope.json', () => { throw new Error('ENOENT') }), false)
  assert.equal(readShareEnabled('/x.json', () => '{oops'), false)
  assert.equal(readShareEnabled('/x.json', () => JSON.stringify({ p2: { share: { enabled: false } } })), false)
  assert.equal(readShareEnabled('/x.json', () => JSON.stringify({ p2: { share: {} } })), false)
  assert.equal(readShareEnabled('/x.json', () => JSON.stringify({ p2: { share: { enabled: true } } })), true)
})

/** 覆盖全天的小时区间（测试用）：`QuietRange` 的形状是 `{from:'HH:mm', to:'HH:mm'}`。 */
function quietAllDay(): Array<{ from: string; to: string }> {
  return [{ from: '00:00', to: '23:59' }]
}

// ── 附二：分享候选有效期可配置（默认 6 小时，理由写在配置字段 help 里） ────────

test('S7 expiresAt 来自 contact.shareTtlMs（可配置），坏值回落默认且不低于 1 分钟', async () => {
  // ① 配置值真的被用上：把有效期设成 90 分钟，候选的 expiresAt - earliestAt 必须是 90 分钟。
  const custom = await mountContact({
    shareEnabled: true,
    config: { contact: { ...(baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig).contact, enabled: true, shareTtlMs: 90 * 60_000 } },
  })
  try {
    await shareOf(custom.rig).submitShare({ candidateId: 'shr_ttl', title: '有效期九十秒' })
    const row = custom.rig.bag.contact!.status().candidates[0]!
    assert.equal(row.expiresAt - row.earliestAt, 90 * 60_000, '有效期必须来自配置，不是写死的 6 小时')
  } finally {
    await custom.close()
  }
  // ② 纯函数层面：缺省/坏值/过小都回落（永不产生"立刻过期"或"永不过期"的候选）。
  const at = { scope: { userId: OWNER, personaId: 'bot', worldId: '' }, target: { channel: 'qq' as const, room: `dm-${String(OWNER)}`, isGroup: false, chatId: OWNER }, authorization: { kind: 'standing' as const, by: OWNER, at: 1, quote: null } }
  const ttlOf = async (ttlMs?: () => number): Promise<number> => {
    let captured = 0
    const port = createSharePort({
      enabled: () => true,
      propose: async (input) => { captured = input.expiresAt - input.earliestAt; return { outcome: 'accepted', candidateId: 'c', note: '' } },
      attempt: async () => {}, target: () => at, now: () => 1_000, log: () => {},
      ...(ttlMs === undefined ? {} : { ttlMs }),
    })
    await port.submitShare({ candidateId: 'x', title: 't' })
    return captured
  }
  assert.equal(await ttlOf(), 6 * 3_600_000, '缺省 6 小时')
  assert.equal(await ttlOf(() => Number.NaN), 6 * 3_600_000, '坏值回落缺省')
  assert.equal(await ttlOf(() => 1), 60_000, '过小的值抬到下限 1 分钟（不许"立刻过期"）')
})

// ── 附三：发布后回读（"发布了"≠"取得到"） ─────────────────────────────────

test('S8 verifyPublished：只有 ctx.get 真的取到才算命中（写得到读不到 = 未命中）', () => {
  const store = new Map<string, unknown>()
  const readable = {
    provide: (name: string, value: unknown) => { store.set(name, value) },
    get: (name: string) => store.get(name),
  }
  assert.equal(publishServiceSafely(readable, 'companionContactShare', { ok: 1 }, () => {}), 'provide')
  assert.equal(verifyPublished(readable, 'companionContactShare'), true, 'provide 之后应能回读')

  // set 写进去了，但 `get` 读不到（某些 cordis 版本就是这样）：档位=set，回读=未命中。
  const writeOnly = {
    saved: new Map<string, unknown>(),
    set(this: { saved: Map<string, unknown> }, name: string, value: unknown) { this.saved.set(name, value) },
    get: () => undefined,
  }
  assert.equal(publishServiceSafely(writeOnly, 'companionContact', { ok: 1 }, () => {}), 'set')
  assert.equal(verifyPublished(writeOnly, 'companionContact'), false, '写得到但 get 读不到 ⇒ 未命中')

  assert.equal(verifyPublished(null, 'x'), false)
  assert.equal(verifyPublished({}, 'x'), false, '没有 get 方法一律判未命中')
  assert.equal(verifyPublished({ get: () => { throw new Error('boom') } }, 'x'), false, 'get 抛错也算未命中')
})
