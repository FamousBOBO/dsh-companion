/**
 * 特征测试（golden）：把重构前的输出逐字节钉住。
 *
 * 这是 P3（拆 `bridge.ts`）与 P4（拆 `tools.ts`）唯一的安全网。规则很简单：
 * 这些快照在 P1–P5 期间**必须逐字节不变**；变了就必须逐条说明理由，否则就是回归。
 *
 * 为了让它确定，测前做三件事：
 *   1. `TZ` 固定成 `Asia/Shanghai`（线上就是这个时区；否则 `getHours()` 一类的
 *      输出会随运行机器漂移）；
 *   2. `DSH_HOME` 指向临时空目录（否则"我最近发过的消息"会读进开发机上的真文件）；
 *   3. 冻结时钟（`node:test` 的 `mock.timers`）——时段前缀、消息时间、批处理窗口
 *      全都依赖"现在几点"，不冻结就没有可比性。
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.TZ = 'Asia/Shanghai'
const HOME = mkdtempSync(path.join(tmpdir(), 'golden-dsh-'))
process.env.DSH_HOME = HOME

// 必须在设好 TZ/DSH_HOME 之后再导入被测模块。
const { InboundPipeline } = await import('../src/app/inbound/pipeline.js')
const { NoticeHandler } = await import('../src/app/inbound/notices.js')
const { TurnLauncher } = await import('../src/app/conversation/turns.js')
const { PacketComposer } = await import('../src/app/inbound/packet-composer.js')
const { createAgentGateway } = await import('../src/adapters/dsh-host/agents.js')
const { GatewayHealth } = await import('../src/app/conversation/gateway-health.js')
const { ConversationRegistry } = await import('../src/app/conversation/registry.js')
const { PromptComposer } = await import('../src/app/conversation/prompt-composer.js')
const { createPersonaPack } = await import('../src/adapters/persona/fs-pack.js')
const { SentLog } = await import('../src/sent-log.js')
const { systemClock, systemRandom } = await import('../src/ports/clock.js')
const { resolveConfig } = await import('../src/config.js')
const { registerQQTools } = await import('../src/features/qq-tools/register.js')
const { parseInbound } = await import('../src/core/message/parse.js')
const { parseWhen } = await import('../src/features/reminders/parse-when.js')
const { formatLocalStamp: localStamp, localDayKey, timeContext } = await import('../src/core/schedule/stamp.js')
const { extractUrls } = await import('../src/adapters/providers/links/parse.js')
const { isInnerMonologueLeak } = await import('../src/core/guards/monologue.js')
const { golden, renderDeliveries } = await import('./golden.js')
const { FakeHost, fakeClient, fakeOut, fakePlatform, toolRecorder, textOf, imageCountOf } = await import('./fakes/host.js')

/**
 * 固定的"现在"：2026-10-16 15:04:05 +08:00。
 * 下午三点——`timeContext()` 应落在"下午"档，正好覆盖时段前缀这一行。
 */
const NOW = Date.parse('2026-10-16T15:04:05+08:00')
/** 固定的事件时间（秒），对应 14:31:00 本地。 */
const EVENT_TIME = Math.floor(Date.parse('2026-10-16T14:31:00+08:00') / 1000)

const SELF = 1000000001
const GROUP = 1000000003
const MASTER = 1000000002
const OTHER = 1000000009

/** 在冻结时钟下跑一段逻辑。 */
async function frozen<T>(fn: () => Promise<T> | T): Promise<T> {
  mock.timers.enable({ apis: ['Date'], now: NOW })
  try {
    return await fn()
  } finally {
    mock.timers.reset()
  }
}

interface Harness {
  bridge: InstanceType<typeof InboundPipeline>
  turns: InstanceType<typeof TurnLauncher>
  host: InstanceType<typeof FakeHost>
  client: ReturnType<typeof fakeClient>
  out: ReturnType<typeof fakeOut>
  logs: string[]
}

function harness(overrides: Record<string, unknown> = {}, hostOptions: ConstructorParameters<typeof FakeHost>[0] = {}): Harness {
  const logs: string[] = []
  const host = new FakeHost({ workspacePath: path.join(HOME, 'workspace'), ...hostOptions })
  const config = resolveConfig({
    selfId: SELF,
    admins: [MASTER],
    primaryGroup: GROUP,
    workspacePath: path.join(HOME, 'workspace'),
    requireMention: true,
    // 视觉默认会去下载图片；黄金测试不碰网络。
    imageRecognition: { enabled: false, serverOcr: false, maxPerMessage: 2 },
    ...overrides,
  })
  const client = fakeClient()
  const out = fakeOut()
  const log = (line: string): void => { logs.push(line); host.logs.push(line) }
  // P3.2 起 bridge 不认识 `Context` 了：假宿主喂给**真的**网关实现，
  // 于是"会话怎么开出来的"这条路径在测试里跑的也是生产代码。
  const gateway = createAgentGateway(host.context(), log)
  const health = new GatewayHealth()
  // 会话登记表也由组合根持有（后台的"重建会话"走它），所以测试里同样显式造。
  // 组包器与真实发布物用的是同一份人格包：黄金快照钉住的正是人格包的内容。
  const composer = new PromptComposer(createPersonaPack())
  const registry = new ConversationRegistry({
    gateway, health, clock: systemClock, random: systemRandom, log,
    config: () => config, nudge: () => composer.gatewayNudge(),
  })
  const sentLogs = new Map<string, Promise<{ render(): string }>>()
  const turns = new TurnLauncher({
    registry, prompts: composer, clock: systemClock, log, config: () => config,
    openSentLog: (room: string) => {
      const hit = sentLogs.get(room)
      if (hit !== undefined) return hit
      const created = (async () => {
        const sent = new SentLog(HOME, room, log)
        await sent.load()
        return sent
      })()
      sentLogs.set(room, created)
      return created
    },
  })
  const notices = new NoticeHandler({
    registry, turns, prompts: composer, platform: () => client as never,
    clock: systemClock, config: () => config, log,
  })
  const bridge = new InboundPipeline({
    config: () => config,
    registry,
    turns,
    prompts: composer,
    platform: () => client as never,
    gateway,
    blobs: {
      // 黄金测试不碰真文件系统：收件箱只回一个标记路径。
      writeInbox: async (input) => `/tmp/golden-inbox/${input.name}`,
      readLocal: async () => null,
    },
    // 退避原来是模块级变量，测试之间会互相影响；现在每个 harness 一个。
    http: { request: async () => { throw new Error('golden tests do not touch the network') } },
    clock: systemClock,
    random: systemRandom,
    health,
    log,
    transcribe: async () => null,
    knowledge: () => null,
    packets: new PacketComposer({
      prompts: composer, clock: systemClock, config: () => config, log,
      knowledge: () => null,
      sentBlockFor: (room: string) => turns.sentBlockFor(room),
    }),
  })
  return { bridge, turns, host, client, out, logs }
}

const text = (t: string): unknown => ({ type: 'text', data: { text: t } })
const atBot = { type: 'at', data: { qq: String(SELF) } }
const atOther = { type: 'at', data: { qq: String(OTHER) } }
const image = { type: 'image', data: { url: 'https://example.invalid/a.jpg' } }

function groupEvent(segments: unknown[], extra: Record<string, unknown> = {}): never {
  return {
    post_type: 'message', message_type: 'group', self_id: SELF,
    group_id: GROUP, user_id: OTHER, message_id: 9001, time: EVENT_TIME,
    message: segments, sender: { nickname: '群友甲', role: 'member' },
    ...extra,
  } as never
}

function privateEvent(segments: unknown[], extra: Record<string, unknown> = {}): never {
  return {
    post_type: 'message', message_type: 'private', self_id: SELF,
    user_id: MASTER, message_id: 9100, time: EVENT_TIME,
    message: segments, sender: { nickname: '主人' },
    ...extra,
  } as never
}

/** 把这次跑出来的所有投递渲染成快照文本。 */
function snapshotOf(host: InstanceType<typeof FakeHost>): string {
  const rows: Array<{ key: string; how: string; text: string; images: number }> = []
  for (const [key, list] of [...host.delivered].sort(([a], [b]) => a.localeCompare(b))) {
    for (const entry of list) {
      rows.push({ key, how: entry.how, text: textOf(entry.message), images: imageCountOf(entry.message) })
    }
  }
  return renderDeliveries(rows)
}

/**
 * 有界等待某个条件成立（异步投递要跨几跳微/宏任务）。
 *
 * 为什么需要：定时器回调里的 `compose → ensure → submit` 不是一次 `setImmediate` 就能跑完的，
 * 而"取快照太早"的后果是**空的快照**——那正好是最难分辨的一类假绿。
 *
 * **只用 `setImmediate` 推进、不碰 `setTimeout`/`Date`**：这条用例把这两个都 mock 掉了，
 * 用它们做等待会自己把自己卡死（`Date.now()` 冻结 ⇒ 超时判定永不到期）。
 */
async function waitFor(predicate: () => boolean, maxTurns = 200): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
}

test.after(() => { rmSync(HOME, { recursive: true, force: true }) })

// ────────────────────────────────────────────────────────────── 组包（bridge）

test('golden: 群聊被 @ —— 完整入站包', async () => {
  await frozen(async () => {
    const { bridge, host } = harness()
    await bridge.handle(groupEvent([atBot, text('铃铃这个怎么修')]))
    golden('packets/group-called', snapshotOf(host))
  })
})

test('golden: 群聊命中唤醒关键词 —— 完整入站包', async () => {
  await frozen(async () => {
    const { bridge, host } = harness({ keywordTriggers: ['铃铃'] })
    await bridge.handle(groupEvent([text('铃铃帮我看一眼')]))
    golden('packets/group-keyword', snapshotOf(host))
  })
})

test('golden: 群聊 @ 别人 + 群主身份 + 头衔 + 图片 + 回复引用', async () => {
  await frozen(async () => {
    const { bridge, host } = harness()
    await bridge.handle(groupEvent(
      [{ type: 'reply', data: { id: '8800' } }, atOther, image, text('看这张图')],
      { sender: { nickname: '主人', role: 'owner', title: '传奇' }, user_id: MASTER },
    ))
    // 这条消息**没有叫我**（@ 的是别人，`requireMention: true`）⇒ 一个字都不该投递。
    // 以前这条用例只留一个空快照，读的人分不出"故意不投"和"快照丢了"；现在显式断言。
    assert.equal(host.messagesFor(`group-${GROUP}`).length, 0, '没被叫到的群消息不许投递')
    golden('packets/group-rich', snapshotOf(host))
  })
})

/**
 * 富媒体 + 引用 + 群主身份**且叫了我**的入站包（与上面那条互补）。
 *
 * 为什么单独一条：上面那条测的是"@ 别人不算叫到"，所以它永远产不出包；要钉住
 * "图片 / 引用 / 头衔 / 群主身份怎么进包"，必须让这条消息真的被叫到。
 */
test('golden: 群聊被叫到 + 图片 + 引用 + 群主头衔 —— 完整富媒体入站包', async () => {
  await frozen(async () => {
    const { bridge, host } = harness()
    await bridge.handle(groupEvent(
      [{ type: 'reply', data: { id: '8800' } }, atBot, image, text('看这张图')],
      { sender: { nickname: '主人', role: 'owner', title: '传奇' }, user_id: MASTER },
    ))
    assert.equal(host.messagesFor(`group-${GROUP}`).length, 1, '被叫到就应当产出一包')
    golden('packets/group-rich-called', snapshotOf(host))
  })
})

test('golden: 私聊 —— 一条文本', async () => {
  await frozen(async () => {
    const { bridge, host } = harness()
    await bridge.handle(privateEvent([text('在么，帮我看下这个报错')]))
    golden('packets/dm-text', snapshotOf(host))
  })
})

test('golden: inject 模式 —— 群聊消息直接进上下文', async () => {
  await frozen(async () => {
    const { bridge, host } = harness({
      injectMode: { enabled: true, wakeIdle: true },
      requireMention: false,
    })
    await bridge.handle(groupEvent([text('今天中午吃啥')]))
    golden('packets/inject-idle', snapshotOf(host))
    // 与批处理路径的区别正在这里：不是 followup，而是 steer（空闲时唤醒）。
    assert.equal(host.lastHowFor(`group-${GROUP}`), 'steer')
  })
})

test('golden: 批处理窗口到期 —— 攒批后的群聊包', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW })
  mock.method(Math, 'random', () => 0) // 让 talk chance 必然通过
  try {
    const { bridge, host } = harness({ requireMention: false })
    await bridge.handle(groupEvent([text('第一条')]))
    await bridge.handle(groupEvent([text('第二条')], { message_id: 9002 }))
    assert.equal(host.messagesFor(`group-${GROUP}`).length, 0, '窗口内不该已经投递')
    mock.timers.tick(20_000)
    // 定时器回调之后还要经过 `compose → registry.ensure → turns.submit` 几跳异步。
    // 以前只 `await setImmediate` 一次，快照经常在投递**之前**就取了 —— 于是产出恒为空，
    // 而空快照又让这条用例一直"绿"。现在等到真的投递为止（有界，5s 上限）。
    await waitFor(() => host.messagesFor(`group-${GROUP}`).length > 0)
    assert.equal(host.messagesFor(`group-${GROUP}`).length, 1, '窗口到期必须恰好投递一包')
    const rendered = snapshotOf(host)
    assert.ok(rendered.includes('第一条') && rendered.includes('第二条'), `攒批包必须含两条原文：\n${rendered}`)
    golden('packets/group-batched', rendered)
  } finally {
    mock.restoreAll()
    mock.timers.reset()
  }
})

test('golden: 主动性包（私聊 / 巡逻 / 梦 / 自省）', async () => {
  await frozen(async () => {
    const { turns, host } = harness()
    const key = `group-${GROUP}`
    await turns.dmProactive('【主动找主人】测试用提示词。')
    await turns.patrolTick(key, '【主动巡逻】测试用提示词。')
    await turns.dreamTick(key, '【做梦时间】测试用提示词。')
    await turns.evolveTick(key, '【自省进化】测试用提示词。')
    golden('packets/proactive', snapshotOf(host))
  })
})

test('golden: 房间指令（群 / 私聊）', () => {
  // 指令行现在也来自人格包（`assets/persona/default/room/*.txt`），
  // 所以这份快照同时钉住了"文案搬家没搬走字节"。
  const composer = new PromptComposer(createPersonaPack())
  golden('pure/room-directive', [
    '── group',
    composer.roomDirective(true, GROUP),
    '',
    '── dm',
    composer.roomDirective(false, MASTER),
  ].join('\n'))
})

// ────────────────────────────────────────────────────────────── 工具面

test('golden: 工具名与参数 schema（P4 迁移后必须逐条一致）', () => {
  const { ctx, definitions } = toolRecorder()
  const config = resolveConfig({ selfId: SELF, admins: [MASTER], primaryGroup: GROUP })
  registerQQTools(
    ctx,
    config,
    fakeClient() as never,
    fakeOut() as never,
    () => {},
  )
  const rendered = definitions.map((d) => JSON.stringify({
    name: d.name,
    description: d.description,
    parameters: d.parameters,
  }, null, 2)).join('\n')
  golden('tools/qq-tools', rendered)
  assert.ok(definitions.length > 0, '应当注册到工具')
})

/**
 * 另外八组工具（它们的注册函数不在 `registerQQTools` 里）。
 *
 * P4.2 要求"每迁一组发布一次"，所以每一组都要有自己的快照：先照现状钉住，
 * 再把文件搬进 `features/`，然后要求逐字节不变。没有这份快照，"搬文件"就只能
 * 靠肉眼比对 29 个工具的 schema——那正是 P4 最容易出错的地方。
 */
test('golden: 其余八组工具的 schema（搬迁后必须逐条一致）', async () => {
  const { FloodGuard } = await import('../src/features/flood/guard.js')
  const { registerFloodTools } = await import('../src/features/flood/tools.js')
  const { registerImageGenTools } = await import('../src/features/imagegen/tools.js')
  const { LearnStore } = await import('../src/features/learn/store.js')
  const { registerLearnTools } = await import('../src/features/learn/tools.js')
  const { registerMemeTools } = await import('../src/features/meme/tools.js')
  const { QuoteStore } = await import('../src/features/quotes/store.js')
  const { registerQuoteTools } = await import('../src/features/quotes/tools.js')
  const { ReminderStore } = await import('../src/features/reminders/store.js')
  const { registerReminderTools } = await import('../src/features/reminders/tools.js')
  const { registerRssTools } = await import('../src/features/rss/tools.js')
  const { registerTtsTools } = await import('../src/features/voice/tts.js')

  const config = resolveConfig({ selfId: SELF, admins: [MASTER], primaryGroup: GROUP })
  const storeOpts = { workspacePath: null, dshHome: HOME, log: (): void => {} }
  const groups: Array<[string, (ctx: never, ...rest: never[]) => () => void, unknown[]]> = [
    ['flood', registerFloodTools, [config, fakeClient(), fakeOut(), () => {}, new FloodGuard(config, () => {})]],
    ['imagegen', registerImageGenTools, [config, fakePlatform(), fakeOut(), () => {}]],
    ['learn', registerLearnTools, [config, fakeClient(), fakeOut(), () => {}, new LearnStore(config.learn, storeOpts)]],
    ['meme', registerMemeTools, [config, fakeClient(), fakeOut(), () => {}]],
    ['quotes', registerQuoteTools, [config, fakeClient(), fakeOut(), () => {}, new QuoteStore(config.quotes, storeOpts)]],
    ['reminders', registerReminderTools, [config, fakeClient(), fakeOut(), () => {}, new ReminderStore(config.reminders, storeOpts)]],
    ['rss', registerRssTools, [config, fakePlatform(), fakeOut(), () => {}]],
    ['tts', registerTtsTools, [config, fakeClient(), fakeOut(), () => {}]],
  ]

  const rendered: string[] = []
  let total = 0
  for (const [name, register, args] of groups) {
    const { ctx, definitions } = toolRecorder()
    register(ctx as never, ...(args as never[]))
    rendered.push(`── ${name} (${definitions.length})`)
    for (const d of definitions) {
      rendered.push(JSON.stringify({ name: d.name, description: d.description, parameters: d.parameters }, null, 2))
    }
    total += definitions.length
  }
  golden('tools/other-tools', rendered.join('\n'))
  assert.equal(total, 29, '八组一共 29 个工具——数量变了就说明有工具没注册上')
})

// ────────────────────────────────────────────────────────────── 配置与纯函数

test('golden: resolveConfig（默认层 + patch + override）', () => {
  const merged = resolveConfig(
    { selfId: SELF, primaryGroup: GROUP, workspacePath: '/path/to/workspace' },
    { groupEnabled: false, admin: { enabled: true, port: 8791, password: '', host: '127.0.0.1' } },
  )
  golden('config/resolved', JSON.stringify(merged, null, 2))
})

test('golden: 时间与随机无关的纯函数', () => {
  const at = new Date('2026-10-16T15:04:05+08:00')
  const midnight = new Date('2026-10-16T00:04:05+08:00')
  const lines = [
    `localDayKey(15:04)   = ${localDayKey(at)}`,
    `localDayKey(00:04)   = ${localDayKey(midnight)}`,
    `localStamp(15:04:05) = ${localStamp(at)}`,
    ...['00:30', '06:30', '09:30', '12:30', '15:30', '18:30', '21:30', '23:30']
      .map((hhmm) => {
        const ctx = timeContext(new Date(`2026-10-16T${hhmm}:00+08:00`))
        return `timeContext(${hhmm}) = ${ctx.period} :: ${ctx.flavor}`
      }),
  ]
  golden('pure/time', lines.join('\n'))
})

test('golden: 链接抽取与内心戏闸门', () => {
  const texts = [
    '看这个 https://www.bilibili.com/video/BV1GJ411x7h7 挺有意思',
    '短链 b23.tv/abc123',
    '裸 BV 号 BV1GJ411x7h7',
    '两个 https://a.example/x 和 https://b.example/y',
    '尾巴带标点 https://example.com/a。',
    '没有链接的一句话',
    '内网地址 http://127.0.0.1:8790/api/health',
  ]
  const leaks = [
    '本轮不发', '保持沉默', '我先闭嘴。', '战况分析：这轮先闭嘴',
    '（后台盘算）这轮先不接话，等他说完',
    '今天天气不错', '行，那我去看看', '好，我这就改',
    '（笑）行吧', '真的会谢',
  ]
  golden('pure/urls-and-leak', [
    '── extractUrls',
    ...texts.map((t) => `${JSON.stringify(t)} → ${JSON.stringify(extractUrls(t, 3))}`),
    '',
    '── isInnerMonologueLeak',
    ...leaks.map((t) => `${JSON.stringify(t)} → ${isInnerMonologueLeak(t)}`),
  ].join('\n'))
})

test('golden: 入站解析（parseInbound）', () => {
  const samples: Array<[string, unknown[]]> = [
    ['纯文字', [text('你好')]],
    ['@机器人', [atBot, text('在吗')]],
    ['@别人', [atOther, text('看他')]],
    ['图片无文字', [image]],
    ['图片带文字', [image, text('这张')]],
    ['表情', [{ type: 'face', data: { id: '5' } }, text('哈哈')]],
    ['语音', [{ type: 'record', data: { file: 'x.silk' } }, text('听下')]],
    ['文件', [{ type: 'file', data: { file: 'a.md', name: 'a.md' } }]],
    ['引用', [{ type: 'reply', data: { id: '8800' } }, text('回你')]],
  ]
  const rendered = samples.map(([label, message]) => {
    const parsed = parseInbound({
      post_type: 'message', message_type: 'group', self_id: SELF,
      group_id: GROUP, user_id: OTHER, time: EVENT_TIME,
      message, sender: { nickname: '群友甲', role: 'member' },
    } as never)
    return `── ${label}\n${JSON.stringify(parsed, null, 2)}`
  })
  golden('pure/parse-inbound', rendered.join('\n'))
})

test('golden: 提醒时间解析（parseWhen）', () => {
  const at = new Date('2026-10-16T15:04:05+08:00')
  const inputs = [
    '明天9点', '今晚8点半', '下午3点', '5分钟后', '两小时后', '每天早上7点',
    '下周一上午10点', '10月20日中午12点', '周日晚上8点', '30分钟后提醒我',
    '随便写点什么', '', '25点', '明天25点',
  ]
  const rendered = inputs.map((input) => {
    const result = parseWhen(input, at)
    return `${JSON.stringify(input)} → ${JSON.stringify(result)}`
  })
  golden('pure/parse-when', rendered.join('\n'))
})
