/** **P2.5-4B 安全边界**（三条 QQ 审计 P1）：access 持久批准 / reminders 轮询器 / 出站授权与文件。
 *
 * 判据一律落在"能不能通过 / 发出去几条 / 抛出什么理由"，不看内部字段——
 * 这三条都是"某处少了判断"，用内部字段断言固定不住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { AccessService } from '../src/features/access/service.js'
import { AccessStore } from '../src/features/access/store.js'
import { ReminderRunner } from '../src/features/reminders/runner.js'
import { reminderDeliverable } from '../src/features/reminders/index.js'
import { decideOutbound, type OutboundBoundaryConfig } from '../src/core/outbound-boundary.js'
import { createToolGateHooks } from '../src/features/qq-tools/gate.js'
import { assertInsideFileBoundary, configureFileBoundary, napcatFileArg } from '../src/local-file.js'
import { baseConfig, tempHome } from './fakes/contact.js'
import type { Reminder } from '../src/features/reminders/store.js'

const OWNER = 10001
const STRANGER = 20002
const GROUP = 1000000003
const OTHER_GROUP = 1000000004

// ── 通用小工具 ──────────────────────────────────────────────────────────────

function accessOf(options: {
  mode: 'open' | 'pairing' | 'allowlist'
  groupPolicy?: 'member' | 'pairing' | 'allowlist'
  allowUsers?: number[]
  allowGroups?: number[]
  store: AccessStore
  admins?: number[]
}): AccessService {
  const access = {
    mode: options.mode,
    groupPolicy: options.groupPolicy ?? 'member',
    allowUsers: options.allowUsers ?? [],
    allowGroups: options.allowGroups ?? [],
    replyCooldownMin: 30,
    replyPendingInGroups: false,
    notifyOwner: false,
  }
  const root = baseConfig({ admins: options.admins ?? [OWNER], access }) as unknown as QQChannelConfig
  return new AccessService({
    api: () => null,
    out: () => null,
    persona: () => null,
    config: () => root.access,
    rootConfig: () => root,
    admins: () => root.admins,
    store: options.store,
    now: () => Date.UTC(2026, 10, 1, 12, 0, 0),
    log: () => {},
  })
}

/**
 * 收尾：**等到没有在途的原子写**再删目录。
 *
 * 以前是固定 `setTimeout(40)`——机器忙的时候一次 `fsync + rename` 就能超过 40ms，
 * 于是测试结束后还有一次写落不下来（`rename access.json.dsh-tmp-* → access.json` ENOENT，
 * 表现为"测试结束后仍有异步活动"）。
 *
 * 注意 `AccessService` 里 `void this.request(...)` 是**故意**的 fire-and-forget（不能因为
 * 通知主人就把入站卡住），所以测试这边唯一能做的"等到写完"就是观察临时文件：
 * 先让出一拍让写**开始**，再要求连续 4 拍（≈100ms）看不到 `.dsh-tmp-*` 才算安静。
 */
async function cleanupDir(dir: string): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  let quiet = 0
  for (let attempt = 0; attempt < 160; attempt += 1) {
    let pending: string[] = []
    try {
      pending = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.includes('.dsh-tmp')) : []
    } catch {
      break
    }
    quiet = pending.length === 0 ? quiet + 1 : 0
    if (quiet >= 4) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

async function freshStore(dir: string, seed?: { users?: number[]; groups?: number[] }): Promise<AccessStore> {
  const file = path.join(dir, 'access.json')
  const store = new AccessStore(file, () => {})
  await store.load()
  for (const id of seed?.users ?? []) await store.approve('user', id)
  for (const id of seed?.groups ?? []) await store.approve('group', id)
  return store
}

const dmEvent = (userId: number): Parameters<AccessService['allow']>[0] => ({
  post_type: 'message', message_type: 'private', user_id: userId, self_id: 10000, message_id: 1,
  raw_message: '你好', message: [{ type: 'text', data: { text: '你好' } }], time: 1,
} as unknown as Parameters<AccessService['allow']>[0])

const groupEvent = (groupId: number): Parameters<AccessService['allow']>[0] => ({
  post_type: 'message', message_type: 'group', group_id: groupId, user_id: STRANGER, self_id: 10000,
  message_id: 2, raw_message: '@机器人 在吗', message: [{ type: 'text', data: { text: '在吗' } }], time: 1,
} as unknown as Parameters<AccessService['allow']>[0])

// ── P1-04：持久"已批准"旁路 ────────────────────────────────────────────────

test('A1 持久批准在 allowlist 模式下**不再**放行（重启后也一样）', async () => {
  const home = tempHome('qq-4b-access-')
  try {
    // 第一次运行：pairing 下批准了一个陌生人（这就是"曾经批准过"）。
    const first = await freshStore(home.dir, { users: [STRANGER] })
    const pairing = accessOf({ mode: 'pairing', store: first })
    assert.equal(pairing.allow(dmEvent(STRANGER)), true, 'pairing 下批过的人应当继续能说话')

    // 重启：重建 store（同一份文件），模式切成 allowlist —— 批准记录还在，但不该再放行。
    const restarted = new AccessStore(path.join(home.dir, 'access.json'), () => {})
    await restarted.load()
    assert.deepEqual(restarted.users(), [STRANGER], '前提：批准确实还在盘上')
    const allowlist = accessOf({ mode: 'allowlist', store: restarted })
    assert.equal(allowlist.allow(dmEvent(STRANGER)), false, 'allowlist 只认 admins + allowUsers')
    // 名单里的人照常放行。
    const listed = accessOf({ mode: 'allowlist', allowUsers: [STRANGER], store: restarted })
    assert.equal(listed.allow(dmEvent(STRANGER)), true)
  } finally {
    await cleanupDir(home.dir)
  }
})

test('A2 拒绝访问**同时撤销**已持久化的批准（pairing 也立刻失效）', async () => {
  const home = tempHome('qq-4b-reject-')
  try {
    const store = await freshStore(home.dir, { users: [STRANGER] })
    const service = accessOf({ mode: 'pairing', store })
    assert.equal(service.allow(dmEvent(STRANGER)), true)
    await service.reject('user', STRANGER)
    assert.deepEqual(store.users(), [], '拒绝之后盘上不许还有这条批准')
    assert.equal(service.allow(dmEvent(STRANGER)), false, '拒绝必须立刻生效（否则等于没拒绝）')
    // 重启之后依旧不生效（没有可复用的批准）。
    const restarted = new AccessStore(path.join(home.dir, 'access.json'), () => {})
    await restarted.load()
    assert.equal(accessOf({ mode: 'pairing', store: restarted }).allow(dmEvent(STRANGER)), false)
  } finally {
    await cleanupDir(home.dir)
  }
})

test('A3 群批准同理：allowlist 群策略只认 allowGroups；pairing 下批准仍有效', async () => {
  const home = tempHome('qq-4b-group-')
  try {
    const store = await freshStore(home.dir, { groups: [GROUP] })
    assert.equal(accessOf({ mode: 'allowlist', groupPolicy: 'pairing', store }).allow(groupEvent(GROUP)), true,
      'pairing 群策略下批过的群仍可用')
    assert.equal(accessOf({ mode: 'allowlist', groupPolicy: 'allowlist', store }).allow(groupEvent(GROUP)), false,
      'allowlist 群策略只认 allowGroups，不认持久批准')
    assert.equal(accessOf({ mode: 'allowlist', groupPolicy: 'allowlist', allowGroups: [GROUP], store }).allow(groupEvent(GROUP)), true)
  } finally {
    await cleanupDir(home.dir)
  }
})

test('A4 红线：主人永远进得来（allowlist + 空名单 + 没有任何批准）', async () => {
  const home = tempHome('qq-4b-owner-')
  try {
    const store = await freshStore(home.dir)
    const service = accessOf({ mode: 'allowlist', groupPolicy: 'allowlist', store })
    assert.equal(service.allow(dmEvent(OWNER)), true, 'admins 不受任何模式/名单影响')
    assert.equal(service.allow(dmEvent(STRANGER)), false)
    // 群：主群即使不在 allowGroups 里，按群策略 member 也放行（主人手动加的群）。
    assert.equal(accessOf({ mode: 'allowlist', groupPolicy: 'member', store }).allow(groupEvent(GROUP)), true)
  } finally {
    await cleanupDir(home.dir)
  }
})

// ── P1-02：reminders runner 不再无条件启动 ─────────────────────────────────

const reminderAt = (over: Partial<Reminder> = {}): Reminder => ({
  id: 'r-1', text: '该睡了', at: 0, room: 'dm', target: OWNER, createdBy: OWNER,
  repeat: 'none', firedAt: null, createdAt: 0, ...over,
} as Reminder)

function reminderConfig(over: { enabled: boolean; allowedRooms?: number[] | null }): QQChannelConfig {
  return {
    ...(baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig),
    groupEnabled: true,
    rooms: [],
    reminders: { enabled: over.enabled, file: null, allowedRooms: over.allowedRooms ?? null },
  } as QQChannelConfig
}

test('R1 enabled=false → 投递前判定一律拒绝（轮询器起来了也不投）', () => {
  const config = reminderConfig({ enabled: false })
  assert.equal(reminderDeliverable(config, reminderAt()), false)
  // runner 层的二次判定：不允许就**不投**。
  const sent: Reminder[] = []
  const store = {
    due: () => [reminderAt()],
    markFired: async () => {},
    markUnknown: async () => {},
    // mutator 必须存在：生产里没有兜底，缺了就该炸
    expireStale: async () => ({ ok: true as const, changed: false, value: [] }),
    capBacklog: async () => ({ ok: true as const, changed: false, value: [] }),
  }
  const runner = new ReminderRunner(
    store as never,
    async (r) => { sent.push(r); return 'sent' as const },
    () => {},
    (r) => reminderDeliverable(config, r),
  )
  void runner
  assert.deepEqual(sent, [], '还没跑 tick')
})

test('R2 enabled=true → 投递一次并 markFired；房间白名单/按群关闭都会挡住', () => {
  const on = reminderConfig({ enabled: true })
  assert.equal(reminderDeliverable(on, reminderAt()), true, '默认（私聊 + 无白名单）应当可投')
  assert.equal(reminderDeliverable(reminderConfig({ enabled: true, allowedRooms: [GROUP] }), reminderAt()), false,
    'allowedRooms 不含目标 → 不投')
  assert.equal(reminderDeliverable(reminderConfig({ enabled: true, allowedRooms: [OWNER] }), reminderAt()), true)
  // 群被按群策略关掉：提醒也绕不过去。
  assert.equal(reminderDeliverable(on, reminderAt({ room: 'group', target: GROUP })), true, 'groupEnabled=true 时可投')
  const closed = { ...on, groupEnabled: false } as QQChannelConfig
  assert.equal(reminderDeliverable(closed, reminderAt({ room: 'group', target: GROUP })), false, '全局关群 → 不投')
  const perRoom = { ...on, rooms: [{ id: GROUP, enabled: false }] } as QQChannelConfig
  assert.equal(reminderDeliverable(perRoom, reminderAt({ room: 'group', target: GROUP })), false, '按群关掉 → 不投')
})

test('R3 轮询器：允许就发一次并记 fired；同一条不会被第二轮再投', async () => {
  const sent: string[] = []
  const fired = new Set<string>()
  const due = [reminderAt({ id: 'r-a' })]
  const store = {
    due: () => due.filter((r) => !fired.has(r.id)),
    markFired: async (id: string) => { fired.add(id) },
    // mutator 必须存在：生产里没有兜底，缺了就该炸
    expireStale: async () => ({ ok: true as const, changed: false, value: [] }),
    capBacklog: async () => ({ ok: true as const, changed: false, value: [] }),
  }
  const runner = new ReminderRunner(store as never, async (r) => { sent.push(r.id); return 'sent' as const }, () => {}, () => true)
  // 直接驱动 tick（`start()` 起的是真定时器，这里只测"投一次 + 记账"的语义）。
  await (runner as unknown as { tick: () => Promise<void> }).tick()
  await (runner as unknown as { tick: () => Promise<void> }).tick()
  assert.deepEqual(sent, ['r-a'], '同一批 due 第二次 tick 不该重复投递')
})

test('R4 不允许时不投也**不消耗**：配置改回来后还能响', async () => {
  const sent: string[] = []
  const fired = new Set<string>()
  let allowed = false
  const store = {
    due: () => [reminderAt({ id: 'r-b' })].filter((r) => !fired.has(r.id)),
    markFired: async (id: string) => { fired.add(id) },
    markUnknown: async (id: string) => { fired.add(id) },
    // mutator 必须存在：生产里没有兜底，缺了就该炸
    expireStale: async () => ({ ok: true as const, changed: false, value: [] }),
    capBacklog: async () => ({ ok: true as const, changed: false, value: [] }),
  }
  const runner = new ReminderRunner(store as never, async (r) => { sent.push(r.id); return 'sent' as const }, () => {}, () => allowed)
  await (runner as unknown as { tick: () => Promise<void> }).tick()
  assert.deepEqual(sent, [], '开关关着：一条都不投')
  assert.equal(fired.size, 0, '也不许 markFired（否则开关打开后这条永远不响）')
  allowed = true
  await (runner as unknown as { tick: () => Promise<void> }).tick()
  assert.deepEqual(sent, ['r-b'])
})

// ── P1-05：出站边界（纯函数） ────────────────────────────────────────────────

const boundaryConfig = (over: Partial<OutboundBoundaryConfig> = {}): OutboundBoundaryConfig => ({
  groupEnabled: true,
  requireMention: true,
  talkValue: 0.6,
  primaryGroup: GROUP,
  rooms: [],
  admins: [OWNER],
  ...over,
})

const DM_OWNER = { isGroup: false, chatId: OWNER }
const DM_STRANGER = { isGroup: false, chatId: STRANGER }
const IN_GROUP = { isGroup: true, chatId: GROUP }

test('B1 groupEnabled=false → 群目标发送与一切群写都被拒（理由可解释）', () => {
  const config = boundaryConfig({ groupEnabled: false })
  for (const [tool, args] of [
    ['qq_send_text', { isGroup: true, target: GROUP, text: '早' }],
    ['qq_group_ban', { groupId: GROUP, userId: STRANGER }],
    ['qq_set_group_card', { groupId: GROUP, userId: STRANGER, card: 'x' }],
    ['qq_upload_group_file', { groupId: GROUP, file: '/tmp/a.txt' }],
  ] as const) {
    const verdict = decideOutbound({ tool, args: args as Record<string, unknown>, origin: DM_OWNER, config })
    assert.equal(verdict.kind, 'deny', `${tool} 在关群时不该放行`)
    assert.equal(verdict.kind === 'deny' ? verdict.code : '', 'group-disabled')
    assert.match(verdict.kind === 'deny' ? verdict.reason : '', /关闭状态|后台/)
  }
  // 私聊自己那条消息不受影响。
  assert.equal(decideOutbound({ tool: 'qq_send_text', args: { target: OWNER, text: '在' }, origin: DM_OWNER, config }).kind, 'allow')
})

test('B2 私聊回合里由非主人发起 → 不准动群（拿不到群的操纵权）', () => {
  const config = boundaryConfig()
  const verdict = decideOutbound({ tool: 'qq_send_text', args: { isGroup: true, target: GROUP, text: '帮我发个' }, origin: DM_STRANGER, config })
  assert.equal(verdict.kind, 'deny')
  assert.equal(verdict.kind === 'deny' ? verdict.code : '', 'dm-group-op')
  assert.match(verdict.kind === 'deny' ? verdict.reason : '', /不是主人|私聊/)
  // 同一个调用，主人自己说 → 放行（不能把主人锁在门外）。
  assert.equal(decideOutbound({ tool: 'qq_send_text', args: { isGroup: true, target: GROUP, text: '发个' }, origin: DM_OWNER, config }).kind, 'allow')
  // 群写同理。
  assert.equal(decideOutbound({ tool: 'qq_group_ban', args: { groupId: GROUP, userId: STRANGER }, origin: DM_STRANGER, config }).kind, 'deny')
  assert.equal(decideOutbound({ tool: 'qq_group_ban', args: { groupId: GROUP, userId: STRANGER }, origin: DM_OWNER, config }).kind, 'allow')
})

test('B3 群回合只能动自己那个群；跨群一律拒', () => {
  const config = boundaryConfig({ primaryGroup: null })
  assert.equal(decideOutbound({ tool: 'qq_send_text', args: { isGroup: true, target: GROUP, text: '在' }, origin: IN_GROUP, config }).kind, 'allow')
  const cross = decideOutbound({ tool: 'qq_send_text', args: { isGroup: true, target: OTHER_GROUP, text: '在' }, origin: IN_GROUP, config })
  assert.equal(cross.kind, 'deny')
  assert.equal(cross.kind === 'deny' ? cross.code : '', 'cross-group')
})

test('B4 私聊里发文件：收件人必须是主人', () => {
  const config = boundaryConfig()
  const stranger = decideOutbound({ tool: 'qq_send_private_file', args: { userId: STRANGER, file: 'C:/x/a.txt' }, origin: DM_STRANGER, config })
  assert.equal(stranger.kind, 'deny')
  assert.equal(stranger.kind === 'deny' ? stranger.code : '', 'dm-cross-file')
  assert.equal(decideOutbound({ tool: 'qq_send_private_file', args: { userId: OWNER, file: 'C:/x/a.txt' }, origin: DM_OWNER, config }).kind, 'allow')
  // **终审 B8 改判**：来源解析不出来（origin=null）时**不再默认放行**——
  // 看不出谁在动，就更不该替陌生人发文件。真正的系统回合要带得出会话 id。
  const systemRound = decideOutbound({ tool: 'qq_send_private_file', args: { userId: STRANGER, file: 'C:/x/a.txt' }, origin: null, config })
  assert.equal(systemRound.kind, 'deny')
  assert.equal(systemRound.kind === 'deny' ? systemRound.code : '', 'origin-unknown')
})

test('B5 只读工具与私聊自己的消息不受影响（边界不是"全拦"）', () => {
  const config = boundaryConfig({ groupEnabled: false })
  assert.equal(decideOutbound({ tool: 'qq_get_group_list', args: {}, origin: DM_STRANGER, config }).kind, 'allow')
  assert.equal(decideOutbound({ tool: 'qq_list_group_files', args: { groupId: GROUP }, origin: DM_STRANGER, config }).kind, 'allow')
  assert.equal(decideOutbound({ tool: 'qq_send_text', args: { target: STRANGER, text: 'hi' }, origin: DM_STRANGER, config }).kind, 'allow')
})

// ── P1-05：闸门接线（永不依赖 policy.v2） ────────────────────────────────────

function gateOf(config: QQChannelConfig) {
  const logs: string[] = []
  const hooks = createToolGateHooks({
    trustOf: () => undefined,
    guardText: (key) => key,
    workspacePath: () => null,
    sendGuard: null,
    boundary: () => config,
    // 两个开关都关着（本 profile 的现状）：边界仍然必须生效。
    switches: { policyOn: () => false, toolsOn: () => false, admins: () => config.admins },
    log: (line) => { logs.push(line) },
  })
  return { hooks, logs }
}

test('B6 闸门：policy.v2/tools.v2 都关着时边界照样拦（且理由带 code）', () => {
  const config = { ...(baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig), groupEnabled: false }
  const { hooks, logs } = gateOf(config)
  const denied = hooks.decide({ name: 'qq_send_text', args: { isGroup: true, target: GROUP, text: '早' }, agentId: `qq-dm-${String(STRANGER)}` })
  assert.equal(denied.kind, 'deny')
  assert.match(denied.kind === 'deny' ? denied.reason : '', /group-disabled/)
  assert.ok(logs.some((line) => line.includes('boundary: denied')), logs.join('\n'))
  // 主人自己（admins）发群消息、群是开着的 → 放行。
  const opened = { ...config, groupEnabled: true }
  const { hooks: ok } = gateOf(opened)
  assert.equal(ok.decide({ name: 'qq_send_text', args: { isGroup: true, target: GROUP, text: '早' }, agentId: `qq-dm-${String(OWNER)}` }).kind, 'pass')
})

// ── P1-05：本地文件边界（真实路径） ──────────────────────────────────────────

test('B7 文件边界：工作区内放行；`..`、符号链接、绝对路径逃逸都被拒', async () => {
  const home = tempHome('qq-4b-files-')
  const workspace = path.join(home.dir, 'ws')
  const outside = path.join(home.dir, 'outside')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  const inside = path.join(workspace, 'ok.txt')
  const secret = path.join(outside, 'secret.txt')
  fs.writeFileSync(inside, 'hello')
  fs.writeFileSync(secret, 'SECRET')
  configureFileBoundary({ roots: [workspace] })
  try {
    await assert.doesNotReject(() => assertInsideFileBoundary(inside), '工作区内的文件应当放行')
    await assert.rejects(() => assertInsideFileBoundary(secret), /不在允许的目录里/)
    // `..` 逃逸：解析之后落在外面 → 拒。
    await assert.rejects(() => assertInsideFileBoundary(path.join(workspace, '..', 'outside', 'secret.txt')), /不在允许的目录里/)
    // 符号链接指到外面 → 拒（这是"看路径字符串"挡不住的那一类）。
    const link = path.join(workspace, 'link.txt')
    try {
      fs.symlinkSync(secret, link)
      await assert.rejects(() => assertInsideFileBoundary(link), /不在允许的目录里/, '符号链接必须按真实路径判')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      // Windows 上没权限建符号链接时跳过这一条（其余断言仍然有效）。
    }
    // 发送器本身也吃这道边界（不是只在测试里调一下）。
    await assert.rejects(() => napcatFileArg(secret), /不在允许的目录里/)
    assert.match(await napcatFileArg(inside), /^base64:\/\//, '工作区内的小文件照常内联')
  } finally {
    configureFileBoundary(null)
    await cleanupDir(home.dir)
  }
})
