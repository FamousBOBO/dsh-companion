/** P9-G4 §2.3 / §3 的**管线级**测试：身份在采集现场冻结，且真的走到判断输入里。
 *
 * 单元测试（`participant.test.ts` / `group-ecology.test.ts`）钉的是"判定对不对"。
 * 这里钉的是**接得对不对**，也就是验收清单「参与者身份」那六条里的四条：
 *
 *   1. 身份元数据由**代码层**注入（不是提示词让模型自己判）；
 *   2. 已登记 Bot 可以被稳定识别（同一个号每次都判成 `known_bot`）；
 *   3. 未登记成员**不会**被自动推断成 Bot（`unknown` 就是 `unknown`）；
 *   4. 不同群的注册表**不串**（A 群登记的号在 B 群是 `unknown`）。
 *
 * 还额外钉一条最容易写错的：**注册表坏掉不影响收消息**——身份查询整条路径失败时，
 * 旁听照记、流水线照跑，只是所有人变成"身份未确认"。
 *
 * 假 deps 的写法照 `pipeline-presence.test.ts`：一个真 `InboundPipeline`，其余全是记录器。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { InboundPipeline } = await import('../src/app/inbound/pipeline.js')
const { AmbientStore } = await import('../src/app/inbound/ambient-store.js')
const { normalizeRegistryFile } = await import('../src/core/participant.js')

const SELF = 2_668_517_323
const GROUP = 145_326_153
const OTHER_GROUP = 987_654_321
const BOT_A = 10_001
const HUMAN_B = 10_002
const STRANGER = 10_003
const NOW = Date.parse('2026-11-09T21:00:00+08:00')

/** 一份最小注册表：A 群里 BOT_A 是 bot、HUMAN_B 是 human。 */
function registry() {
  const parsed = normalizeRegistryFile({
    schemaVersion: 1,
    groups: [{
      groupId: GROUP,
      version: 'test-v1',
      members: [
        { userId: BOT_A, kind: 'bot', alias: 'Bot-A' },
        { userId: HUMAN_B, kind: 'human', alias: '小王' },
      ],
    }],
  })
  assert.equal(parsed.ok, true)
  return parsed.ok ? parsed.file : null
}

function groupEvent(userId: number, text: string, messageId: number, groupId = GROUP) {
  return {
    time: Math.floor(NOW / 1000),
    self_id: SELF,
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: userId,
    message_id: messageId,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: userId, nickname: '甲' },
  } as never
}

interface HarnessOptions {
  /** 返回注册表的取值函数；缺省 = 没装注册表。 */
  readonly participants?: () => unknown
}

function harness(opts: HarnessOptions = {}) {
  const logs: string[] = []
  const conv = {
    key: 'group-145326153',
    sessionId: 'qq-group-145326153',
    isGroup: true,
    chatId: GROUP,
    session: null,
    tracker: { busy: () => false, running: () => false },
    queue: [] as string[],
    pendingImages: [] as unknown[],
    batchTimer: null,
    seenMessageIds: null,
    calledLine: false,
    lastEvent: null,
  }
  const config = {
    groupEnabled: true,
    requireMention: true,
    debug: false,
    injectMode: { enabled: false, wakeIdle: true },
    imageRecognition: { enabled: false, serverOcr: false, maxPerMessage: 2 },
    batching: { windowMs: 1000, maxMessages: 20, maxChars: 4000 },
    contextBudget: { compactChars: 0 },
    primaryGroup: null,
    talkValue: 1,
    keywordTriggers: [],
    keywordReactions: [],
    admins: [],
    selfId: SELF,
    planner: { enabled: false },
    presence: {
      enabled: true,
      groups: [GROUP, OTHER_GROUP],
      ambientMaxEntries: 40,
      ambientTtlMs: 600_000,
      ambientMaxChars: 6_000,
      judgeMaxEntries: 15,
      judgeMaxChars: 1_200,
    },
  }
  const store = new AmbientStore({ log: (line: string) => logs.push(line) })
  const clock = {
    now: () => NOW,
    date: () => new Date(NOW),
    setTimeout: () => ({ cancel: () => {} }),
    setInterval: () => ({ cancel: () => {} }),
  }
  const deps = {
    config: () => config,
    registry: { getOrCreate: () => conv, ensure: async () => {} },
    turns: { submit: () => {} },
    prompts: { imageNote: () => '[图片]' },
    platform: () => ({ api: {} }),
    gateway: {},
    blobs: {},
    http: { request: async () => ({ ok: false, bytes: new Uint8Array() }) },
    clock,
    random: { next: () => 0.99 },
    health: { deadline: () => 0 },
    log: (line: string) => logs.push(line),
    transcribe: async () => null,
    knowledge: { recall: () => null },
    packets: { compose: async () => ({ text: 'packet', imageRefs: [] }), composeDm: async () => 'dm', composeInject: () => 'inject', knowledgeOf: () => null },
    ambient: store,
    presence: { observe: () => {} },
    ...(opts.participants === undefined ? {} : { participants: opts.participants }),
  }
  const pipeline = new InboundPipeline(deps as never)
  return { pipeline, store, logs }
}

/** 这个群此刻的旁听（与流水线看到的是同一份）。 */
function ambientOf(store: InstanceType<typeof AmbientStore>, groupId = GROUP) {
  return store.ring(groupId, { maxEntries: 40, ttlMs: 600_000, maxChars: 6_000 }).peekAfter(0, NOW)
}

// ── 采集现场冻结 ──────────────────────────────────────────────────────

test('采集：已登记的 bot 在**采集现场**就被标成 known_bot（判断时不必再查）', async () => {
  const h = harness({ participants: registry })
  await h.pipeline.handle(groupEvent(BOT_A, '这个方案可行', 11))

  const entries = ambientOf(h.store)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.senderKind, 'known_bot', '身份要随消息一起冻结进缓冲')
})

test('采集：已确认的人标成 known_human，未登记的标成 unknown', async () => {
  const h = harness({ participants: registry })
  await h.pipeline.handle(groupEvent(HUMAN_B, '我试试', 11))
  await h.pipeline.handle(groupEvent(STRANGER, '路过', 12))

  const [first, second] = ambientOf(h.store)
  assert.equal(first?.senderKind, 'known_human')
  assert.equal(second?.senderKind, 'unknown', '未登记就是未登记，不许推断成 bot')
})

test('采集：她自己的号标成 self（来自配置，是可信平台身份）', async () => {
  const h = harness({ participants: registry })
  await h.pipeline.handle(groupEvent(SELF, '我说一句', 11))
  assert.equal(ambientOf(h.store)[0]?.senderKind, 'self')
})

// ── 未装注册表：不带字段，而不是硬塞 unknown ─────────────────────────────

test('没装注册表：旁听照记，但不带 senderKind（"没查"与"查了没登记"要能区分）', async () => {
  const h = harness()
  await h.pipeline.handle(groupEvent(BOT_A, '这个方案可行', 11))

  const entries = ambientOf(h.store)
  assert.equal(entries.length, 1, '没注册表也要记旁听（这是旧行为）')
  assert.equal(entries[0]?.senderKind, undefined, '没查过就不该留一个"未知"的假事实')
})

// ── 跨群隔离 ──────────────────────────────────────────────────────────

test('跨群隔离：A 群登记的 bot 在 B 群是 unknown（同一个号在别的群是另一个人）', async () => {
  const h = harness({ participants: registry })
  await h.pipeline.handle(groupEvent(BOT_A, '这个方案可行', 11, OTHER_GROUP))

  const entries = ambientOf(h.store, OTHER_GROUP)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.senderKind, 'unknown', '注册表按群查，不许跨群复用')
})

// ── 失败方向：注册表坏了不影响收消息 ──────────────────────────────────

test('注册表取值函数抛错：旁听照记、身份缺省（身份查询永远不许炸掉消息链路）', async () => {
  const h = harness({ participants: () => { throw new Error('注册表读取炸了') } })
  await h.pipeline.handle(groupEvent(BOT_A, '这个方案可行', 11))

  const entries = ambientOf(h.store)
  assert.equal(entries.length, 1, '身份算不出来只是少一段上下文，不能让消息丢')
  assert.equal(entries[0]?.senderKind, undefined)
})

test('注册表返回 null：同上（文件不存在 / 解析失败都收敛到这一条）', async () => {
  const h = harness({ participants: () => null })
  await h.pipeline.handle(groupEvent(BOT_A, '这个方案可行', 11))
  assert.equal(ambientOf(h.store)[0]?.senderKind, undefined)
})

// ── 稳定识别 ──────────────────────────────────────────────────────────

test('已登记 bot 稳定识别：同一个号连续三条，每次都判成 known_bot', async () => {
  const h = harness({ participants: registry })
  for (const [index, text] of ['一', '二', '三'].entries()) {
    await h.pipeline.handle(groupEvent(BOT_A, text, 20 + index))
  }
  const kinds = ambientOf(h.store).map((entry) => entry.senderKind)
  assert.deepEqual(kinds, ['known_bot', 'known_bot', 'known_bot'])
})
