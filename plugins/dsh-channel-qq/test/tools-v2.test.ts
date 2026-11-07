/** P6d `tools.v2` 的行为测试：关着不动 / 打开换面 / 委派等价 / 档位拒绝 / 切换日说明。
 *
 * 七条不能少的性质：
 *   1. 开关关着：注册的还是今天这 59 个（qq-tools 组），采集口没被武装；
 *   2. 开关打开：宿主上正好 17 个合并工具（与 MAPPING 同序），描述人格中立；
 *   3. 全量收编：90 个旧名每个都有归宿，与合并表双向一致；
 *   4. 对照：每个分支的字段/必填与旧 spec 的 schema 逐条一致（翻译分支例外明写）；
 *   5. 委派：合并工具跑的就是旧实现（发送过闸门、风控写回配置、高危群管报错）；
 *   6. 校验报错点名到动作、字段与 provider；音乐的翻译按旧 shape 生成参数；
 *   7. 两套闸门规则各自只看自己的开关；切换日说明每个已挂回会话只投一次（落账）。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const HOME = mkdtempSync(path.join(tmpdir(), 'tools-v2-'))
process.env.DSH_HOME = HOME
process.env.DSH_SESSIONS_ROOT = path.join(HOME, 'sessions')

after(() => { rmSync(HOME, { recursive: true, force: true }) })

const { registerQQTools, createToolGateHooks } = await import('../src/features/qq-tools/register.js')
const { registerSpecs, setToolSpecSink } = await import('../src/adapters/dsh-host/tools.js')
const { createQQApi } = await import('../src/adapters/onebot/qq-api.js')
const { resolveConfig } = await import('../src/config.js')
const { createPersonaPack } = await import('../src/adapters/persona/fs-pack.js')
const { createHost } = await import('../src/features/plugin-kit.js')
const { ConversationRegistry } = await import('../src/app/conversation/registry.js')
const { GatewayHealth } = await import('../src/app/conversation/gateway-health.js')
const { systemClock, systemRandom } = await import('../src/ports/clock.js')
const {
  MAPPING, LEGACY_TOOL_NAMES, MERGED_TOOL_NAMES, tierDenyFor, tierOfSession,
  writeToolsRegion, syncToolsRegion, announceToolsV2Switch, toolsSurfaceStatePath,
  TOOLS_SURFACE_VERSION,
} = await import('../src/features/tools-v2/index.js')
const { writeInstructionRegion } = await import('../src/features/inbound/index.js')
const { fakeClient, fakeOut, fakePlatform, toolRecorder } = await import('./fakes/host.js')
const { golden } = await import('./golden.js')

const SELF = 1705
const GROUP = 107
const MASTER = 280
const OTHER = 999

type Resolved = ReturnType<typeof resolveConfig>

function basePatch(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { selfId: SELF, admins: [MASTER], primaryGroup: GROUP, ...extra }
}
function plainConfig(): Resolved { return resolveConfig(basePatch()) }
function v2Config(extra: Record<string, unknown> = {}): Resolved {
  return resolveConfig(basePatch({ tools: { v2: true }, ...extra }))
}

/** 其余九组工具（golden 的八组 + links）：按真实签名、用假件注册。 */
/** 同一文件只允许一个活跃 Store：本进程内复用（测试里会多次注册）。 */
let sharedReminderStore: unknown = null

async function registerOtherGroups(ctx: never, config: Resolved, log: (line: string) => void): Promise<void> {
  const storeOpts = { workspacePath: null, dshHome: HOME, log: (): void => {} }
  const { FloodGuard } = await import('../src/features/flood/guard.js')
  const { registerFloodTools } = await import('../src/features/flood/tools.js')
  const { registerImageGenTools } = await import('../src/features/imagegen/tools.js')
  const { LearnStore } = await import('../src/features/learn/store.js')
  const { registerLearnTools } = await import('../src/features/learn/tools.js')
  const { registerLinkTools } = await import('../src/features/links/tools.js')
  const { registerMemeTools } = await import('../src/features/meme/tools.js')
  const { QuoteStore } = await import('../src/features/quotes/store.js')
  const { registerQuoteTools } = await import('../src/features/quotes/tools.js')
  const { ReminderStore } = await import('../src/features/reminders/store.js')
  const { registerReminderTools } = await import('../src/features/reminders/tools.js')
  const { registerRssTools } = await import('../src/features/rss/tools.js')
  const { registerTtsTools } = await import('../src/features/voice/tts.js')
  const groups: Array<[string, (ctx: never, ...rest: never[]) => () => void, unknown[]]> = [
    ['flood', registerFloodTools, [config, fakeClient(), fakeOut(), log, new FloodGuard(config, () => {})]],
    ['imagegen', registerImageGenTools, [config, fakePlatform(), fakeOut(), log]],
    ['learn', registerLearnTools, [config, fakeClient(), fakeOut(), log, new LearnStore(config.learn, storeOpts)]],
    ['links', registerLinkTools, [config, fakeClient(), fakeOut(), log]],
    ['meme', registerMemeTools, [config, fakeClient(), fakeOut(), log]],
    ['quotes', registerQuoteTools, [config, fakeClient(), fakeOut(), log, new QuoteStore(config.quotes, storeOpts)]],
    ['reminders', registerReminderTools, [config, fakeClient(), fakeOut(), log,
      // **OWNER_CONFLICT（A 类第 11 次）**：`registerOtherGroups` 会被调用多次，每次都 `new ReminderStore`
      // 就撞上"同一文件只允许一个活跃 Store"。这里**复用同一个实例**（生产里热重载也必须先 close）。
      (sharedReminderStore ??= new ReminderStore(config.reminders, storeOpts))]],
    ['rss', registerRssTools, [config, fakePlatform(), fakeOut(), log]],
    ['tts', registerTtsTools, [config, fakeClient(), fakeOut(), log]],
  ]
  for (const [, register, args] of groups) register(ctx, ...(args as never[]))
}

/** 把全部 90 个旧 spec 从真实注册函数里录一份（v2 关着的路径；先确保采集口没被武装）。 */
async function recordAllLegacy(): Promise<Map<string, Record<string, unknown>>> {
  setToolSpecSink(null)
  const defs = new Map<string, Record<string, unknown>>()
  const collect = (list: Array<Record<string, unknown>>): void => {
    for (const def of list) defs.set(String(def.name), def)
  }
  const config = plainConfig()
  {
    const { ctx, definitions } = toolRecorder()
    registerQQTools(ctx, config, fakeClient() as never, fakeOut() as never, () => {})
    collect(definitions)
  }
  const { ctx, definitions } = toolRecorder()
  await registerOtherGroups(ctx as never, config, () => {})
  collect(definitions)
  return defs
}

interface SurfaceHarness {
  definitions: Array<Record<string, unknown>>
  client: ReturnType<typeof fakeClient>
  logs: string[]
  dispose: () => void
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

/** v2 打开的完整注册环境：59 个被收编 + 九组被采集口收编 + 17 个上宿主。 */
async function surfaceHarness(): Promise<SurfaceHarness> {
  const { ctx, definitions } = toolRecorder()
  const client = fakeClient({
    get_group_list: [{ group_id: GROUP }],
    get_group_info: { group_name: '主群' },
    get_friend_list: [{ user_id: MASTER, nickname: '主人' }],
  })
  const logs: string[] = []
  const log = (line: string): void => { logs.push(line) }
  const config = v2Config()
  const dispose = registerQQTools(ctx, config, createQQApi(client as never), fakeOut() as never, log)
  await registerOtherGroups(ctx as never, config, log)
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const def = definitions.find((d) => d.name === name)
    assert.ok(def, `${name} 不在注册面上`)
    return await (def!.execute as (a: unknown) => Promise<unknown>)(args)
  }
  return { definitions, client, logs, dispose, call }
}

/** 一个够用的假 SubHost（persona 包里是真的：文案渲染走发布物）。 */
function makeFakeHost(config: Resolved, log: (line: string) => void): ReturnType<typeof createHost> {
  const env = {
    config,
    dshHome: HOME,
    log,
    resources: {},
    bridge: {
      toolHost: () => ({ tools: { register: () => () => {} } }),
      agentGateway: () => ({}),
      tagContext: () => ({}),
      presetRegistry: () => undefined,
      agentRegistry: () => undefined,
      logHostError: () => {},
      reloadSections: async () => [],
    },
    scope: async () => () => {},
  } as never
  return createHost(env, { persona: { pack: createPersonaPack(), composer: {} as never } }, 'tools-v2-test')
}

// ── 关着：与今天完全一样 ────────────────────────────────────────────────────

test('tools.v2 关着：注册的还是今天这 59 个，采集口没被武装', () => {
  setToolSpecSink(null)
  const { ctx, definitions } = toolRecorder()
  registerQQTools(ctx, plainConfig(), fakeClient() as never, fakeOut() as never, () => {})
  assert.equal(definitions.length, 59)
  assert.equal(definitions[0]?.name, 'qq_send_text')
  // 采集口没被武装的判据：旧名照样能注册到宿主（被收编时这里会是 0 条）。
  const probe = toolRecorder()
  registerSpecs(probe.ctx, [{ name: 'qq_send_text', description: 'x', parameters: {}, run: () => 1 }], () => {})
  assert.equal(probe.definitions.length, 1)
})

// ── 打开：17 个合并工具 ─────────────────────────────────────────────────────

test('tools.v2 打开：宿主上正好 17 个合并工具，描述人格中立', async () => {
  const t = await surfaceHarness()
  try {
    assert.deepEqual(t.definitions.map((d) => d.name), MAPPING.map((face) => face.name))
    assert.equal(t.definitions.length, 17)
    for (const def of t.definitions) {
      const description = String(def.description)
      assert.ok(description.includes('动作（'), `${String(def.name)} 的描述应带动作清单`)
      // 人格中立：描述里不许出现具体人设的称呼/自称（「主人」是本插件的域内称呼，
      // 指配置里的 admins[0]，不是人格设定，所以不在禁列）。
      // leak-scan-allow: persona-三月七  (regression guard: asserts the old name is gone)
      for (const banned of ['学弟', '诺诺', '三月七', '咱']) {
        assert.equal(description.includes(banned), false, `${String(def.name)} 的描述含人格称呼「${banned}」`)
      }
      assert.deepEqual((def.parameters as { required?: unknown }).required, ['action'])
    }
    assert.ok(t.logs.some((line) => line.includes('注册 17 个合并工具')))
  } finally { t.dispose() }
})

// ── 收编完整性与对照 ────────────────────────────────────────────────────────

test('全量收编：90 个旧名每个都有归宿（与合并表双向一致）', async () => {
  const defs = await recordAllLegacy()
  assert.equal(defs.size, 90, '今天的注册面就是 90 个旧工具')
  for (const name of LEGACY_TOOL_NAMES) assert.ok(defs.has(name), `合并表引用了不存在的旧工具 ${name}`)
  for (const name of defs.keys()) assert.ok(LEGACY_TOOL_NAMES.has(name), `旧工具 ${name} 在合并表里没有归宿`)
  assert.equal(MERGED_TOOL_NAMES.size, 17)
})

test('对照：每个分支的字段与旧 spec 逐条一致（翻译分支例外明写）', async () => {
  const defs = await recordAllLegacy()
  for (const face of MAPPING) {
    for (const branch of face.branches) {
      const def = defs.get(branch.legacy)
      assert.ok(def, `${branch.legacy} 不在注册面上`)
      const parameters = (def!.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] }
      const oldFields = Object.keys(parameters.properties ?? {})
      const newFields = [...branch.required, ...(branch.optional ?? [])]
      const exception = translateException(branch.legacy, branch.action)
      const wantedFields = exception === null ? oldFields : exception.fields
      const wantedRequired = exception === null ? (parameters.required ?? []) : exception.required
      assert.deepEqual(
        newFields.slice().sort(), wantedFields.slice().sort(),
        `${face.name}.${branch.action}（${branch.legacy}）字段与旧 spec 不一致`,
      )
      assert.deepEqual(
        branch.required.slice().sort(), wantedRequired.slice().sort(),
        `${face.name}.${branch.action}（${branch.legacy}）必填与旧 spec 不一致`,
      )
    }
  }
})

/** 需要参数翻译的分支：新字段与旧 schema 的对应**刻意**不同。
 *  - 两个登录工具：旧 shape 是 {action, key}（required 只有 action）；新面把
 *    start/poll 拆成两个动作，poll 的 key 提成必填（更严，报错可读）；
 *  - 歌单：子动作从 action 改名为 op（action 是判别字段，直接沿用会撞名）。
 */
function translateException(legacy: string, action: string): { fields: string[]; required: string[] } | null {
  if (legacy === 'qq_netease_login' || legacy === 'qq_kugou_login') {
    return action === 'login_start' ? { fields: [], required: [] } : { fields: ['key'], required: ['key'] }
  }
  if (legacy === 'qq_music_playlist') return { fields: ['op', 'songId', 'name', 'artists'], required: ['op'] }
  return null
}

// ── 委派与校验 ──────────────────────────────────────────────────────────────

test('委派：合并工具跑的就是旧实现（发送过闸门 / 风控写回 / 高危群管报错）', async () => {
  const t = await surfaceHarness()
  try {
    await t.call('qq_message', { action: 'send', isGroup: true, target: GROUP, text: '好呀' })
    assert.ok(t.client.calls.some((c) => c.action === 'send_group_msg' && c.params.group_id === GROUP))
    await assert.rejects(
      () => t.call('qq_message', { action: 'send', isGroup: true, target: 555, text: '在吗' }),
      /不是我加入的群/,
      '发送前的目标校验原样生效',
    )
    const exempted = await t.call('qq_flood', { action: 'exempt', userId: 42 }) as { exempt: number[] }
    assert.ok(exempted.exempt.includes(42), '风控豁免写回了配置里那份数组')
    await assert.rejects(
      () => t.call('qq_group_admin', { action: 'kick', groupId: GROUP, userId: OTHER }),
      /groupAdmin\.dangerous=false/,
      '高危群管的总闸门原文带出来',
    )
    assert.deepEqual(await t.call('qq_memory', { action: 'extract', source: 's', text: 't' }), { note: '提取器未启用' })
  } finally { t.dispose() }
})

test('校验：动作 / 字段 / provider 报错都点名', async () => {
  const t = await surfaceHarness()
  try {
    await assert.rejects(() => t.call('qq_message', {}), /需要 action 参数。可选动作：send/)
    await assert.rejects(() => t.call('qq_message', { action: 'nope' }), /没有 action=nope。可选动作：/)
    await assert.rejects(
      () => t.call('qq_message', { action: 'send', isGroup: true, target: GROUP }),
      /action=send 需要字段：isGroup、target、text（还差：text）/,
    )
    await assert.rejects(
      () => t.call('qq_message', { action: 'send', isGroup: true, target: GROUP, text: 'x', messageId: 1 }),
      /action=send 不认识字段：messageId/,
    )
    await assert.rejects(
      () => t.call('qq_music', { action: 'search', provider: 'deezer', keyword: 'x' }),
      /provider 只能是 netease 或 kugou/,
    )
    await assert.rejects(
      () => t.call('qq_music', { action: 'lyrics', provider: 'kugou', songId: '1' }),
      /action=lyrics 没有 provider=kugou 的版本；它只有：netease/,
    )
  } finally { t.dispose() }
})

test('音乐翻译：登录与歌单按旧 shape 生成参数', () => {
  const music = MAPPING.find((face) => face.name === 'qq_music')!
  const branch = (action: string, provider: string) =>
    music.branches.find((b) => b.action === action && (b.provider === provider || b.provider === 'any'))!
  assert.deepEqual(
    branch('login_poll', 'kugou').translate!({ action: 'login_poll', provider: 'kugou', key: 'k' }),
    { action: 'poll', key: 'k' },
  )
  assert.deepEqual(branch('login_start', 'netease').translate!({ action: 'login_start' }), { action: 'start' })
  assert.deepEqual(
    branch('playlist', 'netease').translate!({ action: 'playlist', op: 'add', songId: 's1', name: 'n' }),
    { action: 'add', songId: 's1', name: 'n', artists: undefined },
  )
})

// ── 档位与两套开关 ──────────────────────────────────────────────────────────

test('档位：群档拒其余六类、主人私聊全开、系统档只放三组', () => {
  const groupSession = `qq-group-${GROUP}`
  const masterDm = `qq-dm-${MASTER}`
  assert.equal(tierOfSession(groupSession, [MASTER]), 'group')
  assert.equal(tierOfSession(masterDm, [MASTER]), 'master-dm')
  assert.equal(tierOfSession(`qq-dm-${OTHER}`, [MASTER]), 'group', '非主人的私聊按群档（保守）')
  assert.equal(tierOfSession('qq-system-events', [MASTER]), 'system')
  assert.equal(tierOfSession('other-agent', [MASTER]), null)
  for (const name of ['qq_group_file', 'qq_file', 'qq_rss', 'qq_learn', 'qq_flood', 'qq_affection']) {
    assert.ok(tierDenyFor({ name, agentId: groupSession }, [MASTER]) !== null, `${name} 应被群档拒`)
  }
  for (const name of MERGED_TOOL_NAMES) {
    assert.equal(tierDenyFor({ name, agentId: masterDm }, [MASTER]), null, `主人私聊应全开：${name}`)
  }
  assert.equal(tierDenyFor({ name: 'qq_group_admin', agentId: groupSession }, [MASTER]), null, '组管理动作留给策略判')
  assert.ok(tierDenyFor({ name: 'qq_rss', agentId: 'qq-system-x' }, [MASTER]) !== null, '系统档只放三组')
  assert.equal(tierDenyFor({ name: 'qq_message', agentId: 'qq-system-x' }, [MASTER]), null)
  assert.equal(tierDenyFor({ name: 'qq_rss', agentId: 'other-agent' }, [MASTER]), null, '非 QQ 会话不归档位管')
  assert.equal(tierDenyFor({ name: 'write', agentId: groupSession }, [MASTER]), null, '宿主工具不归档位管')
})

test('档位：按**本回合信任**判系统档（P6f 的事件书回合发进群会话）', () => {
  const groupSession = `qq-group-${GROUP}`
  // 事件书的回合落在群会话上，id 前缀判不出"系统在做事"——只有信任账本知道。
  assert.equal(tierOfSession(groupSession, [MASTER], 'system'), 'system')
  assert.ok(tierDenyFor({ name: 'qq_rss', agentId: groupSession }, [MASTER], 'system') !== null)
  assert.equal(tierDenyFor({ name: 'qq_message', agentId: groupSession }, [MASTER], 'system'), null)
  assert.equal(tierDenyFor({ name: 'qq_memory', agentId: groupSession }, [MASTER], 'system'), null)
  // 群友/主人发起的回合不受影响：信任档不抬高任何人
  for (const trust of ['member', 'admin', 'master', null] as const) {
    assert.ok(tierDenyFor({ name: 'qq_rss', agentId: groupSession }, [MASTER], trust) !== null, `trust=${trust} 仍按群档拒`)
    assert.equal(tierOfSession(groupSession, [MASTER], trust), 'group')
  }
  // 非 QQ 会话仍然不归档位管（这条边界不因新增的信任判据而破）
  assert.equal(tierOfSession('other-agent', [MASTER], 'system'), null)
  // system 档比会话形状更严：主人私聊里跑的事件书回合也收敛到系统档（发消息够用）
  assert.equal(tierOfSession(`qq-dm-${MASTER}`, [MASTER], 'system'), 'system')
  assert.ok(tierDenyFor({ name: 'qq_rss', agentId: `qq-dm-${MASTER}` }, [MASTER], 'system') !== null)
  assert.equal(tierDenyFor({ name: 'qq_message', agentId: `qq-dm-${MASTER}` }, [MASTER], 'system'), null)
})

test('闸门：两套规则各自只看自己的开关；不传 switches 时语义一字不变', () => {
  const base = {
    trustOf: () => undefined,
    guardText: (key: string) => `【拒绝:${key}】`,
    workspacePath: () => null,
    sendGuard: null,
    log: () => {},
  }
  const toolsOnly = createToolGateHooks({
    ...base,
    switches: { toolsOn: () => true, policyOn: () => false, admins: () => [MASTER] },
  })
  const denied = toolsOnly.decide({ name: 'qq_rss', args: { action: 'add' }, agentId: `qq-group-${GROUP}` })
  assert.ok(denied.kind === 'deny' && denied.reason.includes('policy.tool-tier.group'))
  assert.equal(toolsOnly.decide({ name: 'qq_message', args: { action: 'send' }, agentId: `qq-group-${GROUP}` }).kind, 'pass')
  assert.equal(
    toolsOnly.decide({ name: 'qq_group_kick', args: {}, agentId: `qq-group-${GROUP}` }).kind, 'pass',
    'policy 关着时放行表不判（旧名不在档位集里）',
  )
  const policyOnly = createToolGateHooks({
    ...base,
    switches: { toolsOn: () => false, policyOn: () => true, admins: () => [MASTER] },
  })
  assert.equal(
    policyOnly.decide({ name: 'qq_rss', args: { action: 'add' }, agentId: `qq-group-${GROUP}` }).kind, 'pass',
    'tools 关着时档位不判',
  )
  const both = createToolGateHooks({
    ...base,
    switches: { toolsOn: () => true, policyOn: () => true, admins: () => [MASTER] },
  })
  const kick = both.decide({ name: 'qq_group_admin', args: { action: 'kick' }, agentId: `qq-group-${GROUP}` })
  assert.ok(kick.kind === 'deny' && kick.reason.includes('policy.group-admin.master-only'))
  const defaults = createToolGateHooks(base)
  assert.equal(
    defaults.decide({ name: 'qq_rss', args: { action: 'add' }, agentId: `qq-group-${GROUP}` }).kind, 'pass',
    '缺省 = 既有调用方的旧行为',
  )
})

// ── 切换日说明与 AGENTS.md 工具区 ───────────────────────────────────────────

test('切换日说明：每个已挂回会话投一次 inject；投过就落账；开关关着不碰', async () => {
  const project = path.join(HOME, 'sessions', '--ws--')
  mkdirSync(path.join(project, `qq-group-${GROUP}`), { recursive: true })
  mkdirSync(path.join(project, `qq-dm-${MASTER}`), { recursive: true })
  const deliveries: Array<{ id: string; mode: string; text: string }> = []
  const gateway = {
    async open(spec: { sessionId: string }) {
      return {
        id: spec.sessionId,
        isRunning: () => false,
        deliver: (content: ReadonlyArray<{ type: string; text?: string }>, mode: string): boolean => {
          deliveries.push({ id: spec.sessionId, mode, text: String(content[0]?.text ?? '') })
          return true
        },
        dispose: async () => false,
      }
    },
    defaultRoute: () => ({ provider: 'p', model: 'm' }),
    async reattachAll() { return { attached: 0, total: 0 } },
    async saveImage() { return null },
  }
  const registry = new ConversationRegistry({
    gateway: gateway as never,
    health: new GatewayHealth(),
    clock: systemClock,
    random: systemRandom,
    log: () => {},
    config: () => v2Config(),
    nudge: () => '（重试）',
  })
  const logs: string[] = []
  const on = makeFakeHost(v2Config(), (line) => { logs.push(line) })
  await announceToolsV2Switch(on, registry)
  assert.equal(deliveries.length, 2, '两个已挂回会话各投一条')
  assert.ok(deliveries.every((d) => d.mode === 'inject'), '只进上下文、不唤醒')
  assert.ok(deliveries.some((d) => d.text.includes('qq_message')), '说明里带旧名→新名对照')
  assert.ok(logs.some((line) => line.includes('2/2')))
  assert.ok(readFileSync(toolsSurfaceStatePath(HOME), 'utf8').includes(TOOLS_SURFACE_VERSION), '落账文件记下已宣告')
  await announceToolsV2Switch(on, registry)
  assert.equal(deliveries.length, 2, '第二次启动不再投（那是噪音）')
  const off = makeFakeHost(plainConfig(), () => {})
  await announceToolsV2Switch(off, registry)
  assert.equal(deliveries.length, 2, '开关关着：什么都不做')
})

test('AGENTS.md 工具区：写入 / 幂等 / 与指令区共存 / 关闭时移除 / 不成对拒改', async () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'tools-v2-ws-'))
  try {
    const file = path.join(ws, 'AGENTS.md')
    writeFileSync(file, '# 工作区说明\n\n长期约定。\n', 'utf8')
    assert.equal(await writeToolsRegion(ws, '工具清单正文'), 'updated')
    let text = readFileSync(file, 'utf8')
    assert.ok(text.includes('<!-- channel-qq:tools:begin -->'))
    assert.ok(text.endsWith('工具清单正文\n<!-- channel-qq:tools:end -->\n'))
    assert.equal(await writeToolsRegion(ws, '工具清单正文'), 'unchanged')
    assert.equal(await writeInstructionRegion(ws, '行为约定'), 'updated')
    text = readFileSync(file, 'utf8')
    assert.ok(text.includes('行为约定') && text.includes('工具清单正文'), '两个受管区并存、互不覆盖')
    assert.equal(await writeToolsRegion(ws, null), 'removed')
    text = readFileSync(file, 'utf8')
    assert.ok(text.includes('行为约定'), '删工具区不碰指令区')
    assert.equal(text.includes('工具清单正文'), false)
    assert.equal(await writeToolsRegion(ws, null), 'unchanged')
    writeFileSync(file, '<!-- channel-qq:tools:begin -->\n半截\n', 'utf8')
    assert.equal(await writeToolsRegion(ws, 'X'), 'malformed')
    assert.equal(readFileSync(file, 'utf8'), '<!-- channel-qq:tools:begin -->\n半截\n', '不成对时一个字节都不动')
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('syncToolsRegion：开关开 → 渲染工具清单与旧名对照；关 → 移除', async () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'tools-v2-sync-'))
  try {
    const on = makeFakeHost(v2Config({ workspacePath: ws }), () => {})
    assert.equal(await syncToolsRegion(on), 'created')
    const text = readFileSync(path.join(ws, 'AGENTS.md'), 'utf8')
    assert.ok(text.includes('qq_message'))
    assert.ok(text.includes('qq_send_text'), '旧名对照进了工具区')
    assert.equal(await syncToolsRegion(on), 'unchanged')
    const noWs = makeFakeHost(plainConfig(), () => {})
    assert.equal(await syncToolsRegion(noWs), '未配置工作区，跳过')
    const off = makeFakeHost(resolveConfig(basePatch({ workspacePath: ws })), () => {})
    assert.equal(await syncToolsRegion(off), 'removed')
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

// ── 快照 ────────────────────────────────────────────────────────────────────

test('golden: tools.v2 打开的注册面（17 个合并工具的 schema）', async () => {
  const t = await surfaceHarness()
  try {
    const rendered = t.definitions.map((def) => JSON.stringify({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    }, null, 2)).join('\n')
    golden('tools/qq-tools-v2', rendered)
    assert.equal(t.definitions.length, 17)
  } finally { t.dispose() }
})

const { rewriteLegacyToolNames } = await import('../src/features/tools-v2/mapping.js')

test('旧名改写：一次扫描，绝不二次替换自己产生的文本', () => {
  // 旧实现按长度倒序逐条 replace：`qq_remind_at` 先变成 `qq_remind（action=add_at）`，
  // 紧接着处理 `qq_remind` 时又把里面那个吃掉，得到 `（action=add）（action=add_at）`。
  assert.equal(rewriteLegacyToolNames('用 qq_remind_at 定'), '用 qq_remind（action=add_at） 定')
  assert.equal(rewriteLegacyToolNames('qq_remind 本身'), 'qq_remind（action=add） 本身')
})
